const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 剧团共享道具：导演登记道具总件数（库存），为排练时段预约目标件数（0 = 撤销）。
 *
 * 库存占用规则：
 *   - 仅“有效（active）”时段的预约占用库存；已取消 / 待调整时段的预约保留记录但不占用；
 *     取消或换版转待调整时释放占用，待调整时段恢复有效（PATCH / batch-adjust）时重新校验。
 *   - 按带时区时段归一化后的 UTC 半开区间 [start, end) 计算：端点相接可复用。
 *   - 同一道具任一时刻全部有效时段的预约总量不得超过 props.total_count；
 *     单条 / 批量预约、单条 / 批量调期、待调整恢复有效、下调库存均按“最终状态”整体校验，
 *     任一时刻不足则整批不生效（409 PROP_CAPACITY_CONFLICT），并返回道具、冲突时段与缺口。
 *
 * 可见性：演员只可查看自己当前参与的有效时段的道具清单，不能读取其他预约。
 *
 * 依赖方向：本模块不引用 schedules.js（避免循环依赖）；schedules.js 在顶部引入本模块的
 * assertPropsAfterScheduleChange，于单条/批量调期事务内做库存校验。
 */

const router = express.Router();
router.use(authRequired);

function parseNonNegInt(value, field) {
  // 仅接受 JSON 数字（true/"3" 等隐式转换一律拒绝）
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest(`${field} 必须是非负整数（0 表示撤销/为零）`);
  }
  return value;
}

function getPropOrThrow(propId) {
  const p = db.prepare('SELECT * FROM props WHERE id = ?').get(propId);
  if (!p) throw badRequest(`道具 #${propId} 不存在`);
  return p;
}

/** 时段必须存在（跨排练也可，用于批量接口给出 404）；返回行 */
function getScheduleRowOrThrow(scheduleId) {
  const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
  if (!s) throw notFound(`排练时段 #${scheduleId} 不存在`);
  return s;
}

function scheduleBrief(s) {
  const scene = db.prepare('SELECT code, title FROM scenes WHERE id = ?').get(s.scene_id);
  const rehearsal = db.prepare('SELECT id, name FROM rehearsals WHERE id = ?').get(s.rehearsal_id);
  return {
    id: s.id,
    rehearsalId: s.rehearsal_id,
    rehearsalName: rehearsal?.name ?? null,
    sceneId: s.scene_id,
    sceneTitle: scene ? `${scene.code} ${scene.title}` : null,
    startAt: s.start_at,
    endAt: s.end_at,
    status: s.status,
  };
}

/**
 * 某演员当前是否为某时段的参与者（动态口径与 schedules.js 一致：
 * 排练当前固定版本中本场有台词且已派角，或在该时段被设为生效临时替角）。
 * 本模块自包含实现，避免与 schedules.js 循环依赖。
 */
function isScheduleParticipant(scheduleId, actorId) {
  const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
  if (!s || s.status !== 'active') return false;
  const r = db.prepare('SELECT version_id FROM rehearsals WHERE id = ?').get(s.rehearsal_id);
  if (!r) return false;
  // 常驻派角，或该时段生效替角（且角色在当前版本本场仍有台词）
  return !!(
    db
      .prepare(
        `SELECT 1
           FROM version_lines vl
           JOIN rehearsal_cast c ON c.role_id = vl.role_id AND c.rehearsal_id = ?
          WHERE vl.version_id = ? AND vl.scene_id = ? AND c.actor_id = ?
          LIMIT 1`
      )
      .get(s.rehearsal_id, r.version_id, s.scene_id, actorId) ||
    db
      .prepare(
        `SELECT 1
           FROM schedule_substitutes ss
           JOIN version_lines vl ON vl.role_id = ss.role_id
          WHERE ss.schedule_id = ? AND ss.status = 'active' AND ss.substitute_actor_id = ?
            AND vl.version_id = ? AND vl.scene_id = ?
          LIMIT 1`
      )
      .get(scheduleId, actorId, r.version_id, s.scene_id)
  );
}

// ---- 库存容量校验（半开区间扫描线；端点相接可复用） ----

/**
 * 返回某道具当前占用库存的全部有效预约（JOIN active 时段），含时段与排练信息。
 */
function activeReservationsForProp(propId) {
  return db
    .prepare(
      `SELECT pr.id AS reservation_id, pr.quantity,
              s.id AS schedule_id, s.rehearsal_id, s.scene_id, s.start_at, s.end_at, s.status,
              r.name AS rehearsal_name
         FROM prop_reservations pr
         JOIN rehearsal_schedules s ON s.id = pr.schedule_id
         JOIN rehearsals r ON r.id = s.rehearsal_id
        WHERE pr.prop_id = ? AND s.status = 'active' AND pr.quantity > 0`
    )
    .all(propId);
}

/**
 * 扫描线：对单个道具，给定最终占用行集合，找出最严重的缺口时刻。
 * rows: [{ schedule_id, rehearsal_id, scene_id, start_at, end_at, quantity }]（全部视为有效占用）
 * 规则：事件按 (time, type) 排序，结束事件（-q）先于开始事件（+q）处理——
 *   同一时刻结束释放先于开始占用，端点相接不算叠加。
 * 返回 { at, peak, rows }：peak=最大同时占用，rows=该时刻仍在占用的行；无占用时 at=null/peak=0。
 */
function peakOverlap(rows) {
  const events = [];
  for (const row of rows) {
    events.push({ t: Date.parse(row.start_at), type: 'start', row });
    events.push({ t: Date.parse(row.end_at), type: 'end', row });
  }
  // 同一时刻结束（-q）先于开始（+q）：端点相接不算叠加
  events.sort((a, b) => (a.t - b.t) || (a.type === b.type ? 0 : a.type === 'end' ? -1 : 1));
  const active = new Map(); // reservation row key -> row（同一时段一行一道具，key 用 schedule_id）
  let best = { at: null, peak: 0, rows: [] };
  for (const e of events) {
    if (e.type === 'end') {
      active.delete(e.row.schedule_id);
      continue;
    }
    active.set(e.row.schedule_id, e.row);
    let total = 0;
    for (const v of active.values()) total += v.quantity;
    // 仅在严格更大时更新：并列取最早的峰值时刻
    if (total > best.peak) {
      best = { at: e.t, peak: total, rows: [...active.values()] };
    }
  }
  return best;
}

/**
 * 按数据库中的“最终状态”校验全部道具库存容量（调用方须先把预约/调期在事务内落库）。
 *   - overrides: Map<propId, totalCount> 可临时覆盖库存（下调库存校验时用）。
 * 任一道具峰值占用超过库存 -> 抛 409 PROP_CAPACITY_CONFLICT（details.shortages），整批不生效。
 */
function assertPropCapacity({ overrides = null, message = '共享道具库存不足，本次操作未生效' } = {}) {
  const props = db.prepare('SELECT * FROM props ORDER BY id').all();
  const shortages = [];
  for (const prop of props) {
    const total = overrides?.has(prop.id) ? overrides.get(prop.id) : prop.total_count;
    const rows = activeReservationsForProp(prop.id);
    const peak = peakOverlap(rows);
    if (peak.at != null && peak.peak > total) {
      shortages.push({
        propId: prop.id,
        propName: prop.name,
        totalCount: total,
        peakAt: new Date(peak.at).toISOString(),
        shortage: peak.peak - total,
        peakReserved: peak.peak,
        schedules: peak.rows.map((row) => ({
          id: row.schedule_id,
          rehearsalId: row.rehearsal_id,
          rehearsalName: row.rehearsal_name,
          sceneId: row.scene_id,
          sceneTitle: (() => {
            const scene = db.prepare('SELECT code, title FROM scenes WHERE id = ?').get(row.scene_id);
            return scene ? `${scene.code} ${scene.title}` : null;
          })(),
          startAt: row.start_at,
          endAt: row.end_at,
          quantity: row.quantity,
        })),
      });
    }
  }
  if (shortages.length) throw conflict('PROP_CAPACITY_CONFLICT', message, { shortages });
}

/**
 * 单个有效时段内各道具的“最低余量”：
 * 对每个该时段预约了的道具，扫描线计算该时段 [start,end) 内（含其他时段叠加）的最大占用，
 * minRemaining = 库存 - 该时段区间内的峰值占用；区间内无任何占用的道具不出现。
 */
function slotPropView(s) {
  const reservations = db
    .prepare(
      `SELECT pr.*, p.name AS prop_name, p.total_count
         FROM prop_reservations pr
         JOIN props p ON p.id = pr.prop_id
        WHERE pr.schedule_id = ?
        ORDER BY p.id`
    )
    .all(s.id);
  const slotStart = Date.parse(s.start_at);
  const slotEnd = Date.parse(s.end_at);
  const items = reservations.map((r) => {
    // 有效时段才参与叠加；待调整/已取消时段的预约不占用，余量按 0 占用展示
    const activeRows = s.status === 'active' ? activeReservationsForProp(r.prop_id) : [];
    const events = [];
    for (const row of activeRows) {
      if (Date.parse(row.end_at) <= slotStart || Date.parse(row.start_at) >= slotEnd) continue;
      events.push({ t: Date.parse(row.start_at), type: 'start', row });
      events.push({ t: Date.parse(row.end_at), type: 'end', row });
    }
    events.sort((a, b) => (a.t - b.t) || (a.type === 'end' ? -1 : 1));
    let cur = 0;
    let peak = 0;
    for (const e of events) {
      if (e.type === 'end') cur -= e.row.quantity;
      else {
        cur += e.row.quantity;
        if (cur > peak) peak = cur;
      }
    }
    return {
      propId: r.prop_id,
      propName: r.prop_name,
      totalCount: r.total_count,
      quantity: r.quantity,
      occupying: s.status === 'active',
      peakReservedInSlot: peak,
      minRemaining: s.status === 'active' ? r.total_count - peak : null,
      updatedAt: r.updated_at ?? r.created_at,
    };
  });
  const mins = items.map((x) => x.minRemaining).filter((v) => typeof v === 'number');
  return {
    schedule: scheduleBrief(s),
    status: s.status,
    props: items,
    minRemaining: mins.length ? Math.min(...mins) : null,
  };
}

/** 演员视图：只要清单（道具 + 本时段目标件数），不含库存/余量/其他时段信息 */
function slotPropViewForActor(s) {
  const rows = db
    .prepare(
      `SELECT p.id AS prop_id, p.name AS prop_name, pr.quantity
         FROM prop_reservations pr
         JOIN props p ON p.id = pr.prop_id
        WHERE pr.schedule_id = ? AND pr.quantity > 0
        ORDER BY p.id`
    )
    .all(s.id);
  return {
    scheduleId: s.id,
    status: s.status,
    props: rows.map((r) => ({ propId: r.prop_id, propName: r.prop_name, quantity: r.quantity })),
  };
}

// ---- 导演：道具登记册（列表 / 登记 / 调整总量） ----

function serializeProp(p) {
  const peakRow = peakOverlap(activeReservationsForProp(p.id));
  const reservationCount = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM prop_reservations pr
         JOIN rehearsal_schedules s ON s.id = pr.schedule_id
        WHERE pr.prop_id = ? AND s.status = 'active' AND pr.quantity > 0`
    )
    .get(p.id).n;
  return {
    id: p.id,
    name: p.name,
    totalCount: p.total_count,
    activeReservationCount: reservationCount,
    peakReserved: peakRow.peak,
    availableNow: p.total_count - peakRow.peak,
    createdAt: p.created_at,
  };
}

router.get(
  '/props',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看共享道具登记册');
    const props = db.prepare('SELECT * FROM props ORDER BY id').all();
    res.json({ props: props.map(serializeProp) });
  })
);

router.post(
  '/props',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可登记共享道具');
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw badRequest('道具名称 name 必填');
    const totalCount = parseNonNegInt(req.body?.totalCount, 'totalCount（总件数）');
    const dup = db.prepare('SELECT id FROM props WHERE name = ?').get(name);
    if (dup) throw badRequest(`道具「${name}」已登记，请勿重复登记（可调整其总件数）`);
    const id = db
      .prepare('INSERT INTO props (name, total_count, created_by) VALUES (?, ?, ?)')
      .run(name, totalCount, req.user.id).lastInsertRowid;
    res.status(201).json({ ok: true, prop: serializeProp(db.prepare('SELECT * FROM props WHERE id = ?').get(id)) });
  })
);

// ---- 导演：调整道具总量（可选改名）；下调时按全部有效预约校验，不足整次不生效 ----
router.patch(
  '/props/:propId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可调整共享道具');
    const propId = Number(req.params.propId);
    if (!Number.isInteger(propId)) throw badRequest('道具 id 必须为整数');
    const prop = db.prepare('SELECT * FROM props WHERE id = ?').get(propId);
    if (!prop) throw notFound('道具不存在');

    const fields = [];
    const params = [];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw badRequest('道具名称不能为空');
      const dup = db.prepare('SELECT id FROM props WHERE name = ? AND id <> ?').get(name, prop.id);
      if (dup) throw badRequest(`已存在同名道具「${name}」`);
      fields.push('name = ?');
      params.push(name);
    }
    let nextTotal = prop.total_count;
    if (req.body?.totalCount !== undefined) {
      nextTotal = parseNonNegInt(req.body.totalCount, 'totalCount（总件数）');
      fields.push('total_count = ?');
      params.push(nextTotal);
    }
    if (!fields.length) throw badRequest('至少提供一个待更新字段：name 或 totalCount');

    // 下调库存（或任何调整）：仅有效预约占用；任一时刻不足整次不生效，库存保持原值
    assertPropCapacity({
      overrides: new Map([[prop.id, nextTotal]]),
      message: '下调后道具库存不足以覆盖现有有效预约，本次调整未生效',
    });
    params.push(prop.id);
    db.prepare(`UPDATE props SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true, prop: serializeProp(db.prepare('SELECT * FROM props WHERE id = ?').get(prop.id)) });
  })
);

// ---- 导演：为单个时段填写道具及目标件数（PATCH 语义；0 撤销；未列出的道具不变） ----
router.put(
  '/rehearsals/:id/schedules/:scheduleId/props',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可预约共享道具');
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    if (!Number.isInteger(scheduleId)) throw badRequest('scheduleId 必须为整数');
    const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
    if (!r) throw notFound('排练不存在');
    const s = getScheduleRowOrThrow(scheduleId);
    if (s.rehearsal_id !== rehearsalId) throw notFound('该时段不属于此排练');
    if (s.status === 'cancelled') throw badRequest('时段已取消，不能再修改其道具预约（记录保留可查）');

    const items = req.body?.items ?? req.body;
    if (!Array.isArray(items)) throw badRequest('请求体须为 items 数组（每项含 propId 与非负整数 quantity）');

    // 入参逐条校验：同批重复 (时段, 道具)、未知道具、无效件数一律 400 明确拒绝
    const seen = new Set();
    const parsed = [];
    items.forEach((item, idx) => {
      const where = `第 ${idx + 1} 条`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest(`${where}：条目必须是对象`);
      const propId = Number(item.propId);
      if (!Number.isInteger(propId)) throw badRequest(`${where}：propId 必填且为整数`);
      if (seen.has(propId)) throw badRequest(`${where}：批次中时段 ${scheduleId} 与道具 #${propId} 的组合重复`);
      seen.add(propId);
      getPropOrThrow(propId);
      const quantity = parseNonNegInt(item.quantity, `${where}：quantity（目标件数）`);
      parsed.push({ propId, quantity });
    });

    transaction(() => {
      applyReservations(s.id, parsed, req.user.id);
      // 待调整时段不占用库存，无需容量校验；有效时段按最终状态整体校验
      const row = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(s.id);
      if (row.status === 'active') {
        assertPropCapacity({ message: '道具预约后库存不足，本次操作未生效' });
      }
    });
    res.json({ ok: true, ...slotPropView(db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(s.id)) });
  })
);

// ---- 导演：一次修改多个时段的道具预约（可跨排练；按整批最终状态校验） ----
router.post(
  '/schedules/props/batch',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可预约共享道具');
    const items = req.body?.items ?? req.body;
    if (!Array.isArray(items)) throw badRequest('请求体须为 items 数组（每项含 scheduleId、propId 与非负整数 quantity）');
    if (items.length < 2) {
      throw badRequest('批量预约一次至少提交两条（时段 × 道具）；单条请使用 PUT /rehearsals/:id/schedules/:scheduleId/props');
    }

    const seen = new Set();
    const parsed = [];
    items.forEach((item, idx) => {
      const where = `第 ${idx + 1} 条`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest(`${where}：条目必须是对象`);
      const scheduleId = Number(item.scheduleId);
      const propId = Number(item.propId);
      if (!Number.isInteger(scheduleId)) throw badRequest(`${where}：scheduleId 必填且为整数`);
      if (!Number.isInteger(propId)) throw badRequest(`${where}：propId 必填且为整数`);
      const key = `${scheduleId}:${propId}`;
      if (seen.has(key)) {
        throw badRequest(`${where}：批次中时段 ${scheduleId} 与道具 #${propId} 的组合重复`);
      }
      seen.add(key);
      const s = getScheduleRowOrThrow(scheduleId); // 未知道时段 -> 404
      if (s.status === 'cancelled') {
        throw badRequest(`${where}：时段 #${scheduleId} 已取消，不能再修改其道具预约`);
      }
      getPropOrThrow(propId); // 未知道具 -> 400
      const quantity = parseNonNegInt(item.quantity, `${where}：quantity（目标件数）`);
      parsed.push({ scheduleId, propId, quantity });
    });

    // 按时段分组落库（同一时段的多个道具各自 upsert/删除）
    const bySchedule = new Map();
    for (const x of parsed) {
      if (!bySchedule.has(x.scheduleId)) bySchedule.set(x.scheduleId, []);
      bySchedule.get(x.scheduleId).push({ propId: x.propId, quantity: x.quantity });
    }
    transaction(() => {
      for (const [scheduleId, list] of bySchedule) {
        applyReservations(scheduleId, list, req.user.id);
      }
      // 整批最终状态：任一有效时刻占用超过库存 -> 整批不生效（上面的写入随事务回滚）
      assertPropCapacity({ message: '批量预约后道具库存不足，本次整批操作未生效' });
    });

    const results = [...bySchedule.keys()]
      .sort((a, b) => a - b)
      .map((scheduleId) =>
        slotPropView(db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId))
      );
    res.json({ ok: true, schedules: results });
  })
);

/**
 * 将一组 { propId, quantity } 写入某时段（必须已在事务内）：
 * quantity > 0 -> upsert；quantity = 0 -> 删除该行（撤销）。
 */
function applyReservations(scheduleId, list, userId) {
  const upsert = db.prepare(
    `INSERT INTO prop_reservations (schedule_id, prop_id, quantity, updated_by, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (schedule_id, prop_id)
     DO UPDATE SET quantity = excluded.quantity, updated_by = excluded.updated_by, updated_at = datetime('now')`
  );
  const del = db.prepare('DELETE FROM prop_reservations WHERE schedule_id = ? AND prop_id = ?');
  for (const { propId, quantity } of list) {
    if (quantity > 0) upsert.run(scheduleId, propId, quantity, userId);
    else del.run(scheduleId, propId);
  }
}

// ---- 查看某时段的预约与时段内最低余量 ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/props',
  wrap((req, res) => {
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
    if (!r) throw notFound('排练不存在');
    const s = getScheduleRowOrThrow(scheduleId);
    if (s.rehearsal_id !== rehearsalId) throw notFound('该时段不属于此排练');

    if (req.user.role === 'director') {
      return res.json(slotPropView(s));
    }
    // 演员：仅限自己当前参与的有效时段，且只返回道具清单（不见库存余量与其他预约）
    if (req.user.role !== 'actor') throw forbidden();
    if (s.status !== 'active' || !isScheduleParticipant(s.id, req.user.id)) {
      throw forbidden('你只能查看自己当前参与的有效时段道具清单');
    }
    res.json(slotPropViewForActor(s));
  })
);

// ---- 调度集成（供 schedules.js 在事务内调用） ----

/**
 * 调期/批量调期/待调整恢复有效后校验道具库存（须在源操作事务内调用，抛错即整体回滚）。
 * 预约随时段移动：预约行本身不动，只是其 JOIN 的时段时间已更新，这里按最终状态重算。
 */
function assertPropsAfterScheduleChange() {
  assertPropCapacity({ message: '调期后共享道具库存不足（既有预约随时段移动），本次日程操作整体不生效' });
}

module.exports = {
  router,
  assertPropCapacity,
  assertPropsAfterScheduleChange,
  slotPropView,
  slotPropViewForActor,
  isScheduleParticipant,
  peakOverlap,
};

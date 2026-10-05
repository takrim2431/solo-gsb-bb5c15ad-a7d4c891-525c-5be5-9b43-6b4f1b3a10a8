const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');
const { participantDetails, parseTzDateTime, slotRef } = require('./schedules');

/**
 * 演员不可用时段：演员登记、修改、撤销自己的不可用时间。
 *
 * 核心规则：
 *   - 输入带时区的起止时间与原因（ISO 8601 必须带时区），服务端归一化为 UTC 存储；
 *     结束必须晚于开始；端点相接不算重叠（半开区间 [start, end)）。
 *   - 演员提交/修改时，若与本人当前参与的“有效”排练日程重叠，整次拒绝并指出冲突日程
 *     （409 UNAVAILABILITY_CONFLICT）；已取消与待调整日程不参与。
 *   - 导演排期/调期、派角/改派、显式换版时的不可用检查在 schedules.js 中完成
 *     （assertNoUnavailabilityConflicts），本模块只负责演员侧的管理与自查。
 *   - 开启过的到场登记名单与签到不因不可用时段变化而改写（本模块不触碰登记数据）。
 *   - 演员只能查看/管理本人的记录；导演在排期冲突响应中看到必要的不可用信息。
 *
 * 依赖方向：unavailability.js -> schedules.js（participantDetails/parseTzDateTime/slotRef），
 * schedules.js 不引用本模块（直接查 actor_unavailability 表），避免循环依赖。
 */

const router = express.Router();
router.use(authRequired);

function actorOnly(req) {
  if (req.user.role !== 'actor') throw forbidden('仅演员可管理本人的不可用时段');
}

function serialize(u) {
  return {
    id: u.id,
    actorId: u.actor_id,
    startAt: u.start_at,
    endAt: u.end_at,
    reason: u.reason,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

function parseReason(value) {
  const s = String(value ?? '').trim();
  if (!s) throw badRequest('reason 必填：请说明不可用原因');
  return s;
}

function parseTimes(body, existing) {
  const startAt = body?.startAt != null ? parseTzDateTime(body.startAt, 'startAt') : existing?.start_at;
  const endAt = body?.endAt != null ? parseTzDateTime(body.endAt, 'endAt') : existing?.end_at;
  if (!startAt || !endAt) throw badRequest('startAt/endAt 必填');
  if (Date.parse(endAt) <= Date.parse(startAt)) throw badRequest('结束时间必须晚于开始时间');
  return { startAt, endAt };
}

/** 演员本人当前参与的有效日程（已取消、待调整不参与） */
function actorActiveSchedules(actorId) {
  const rows = db
    .prepare(
      `SELECT s.*, r.version_id, r.name AS rehearsal_name
         FROM rehearsal_schedules s
         JOIN rehearsals r ON r.id = s.rehearsal_id
        WHERE s.status = 'active'
        ORDER BY s.start_at, s.id`
    )
    .all();
  return rows.filter((s) =>
    participantDetails(s.rehearsal_id, s.version_id, s.scene_id, { scheduleId: s.id }).participants.some(
      (p) => p.actorId === actorId
    )
  );
}

/** 提交/修改时：与本人当前参与的有效日程重叠 -> 409 并指出冲突日程 */
function assertNoOwnScheduleOverlap(actorId, startAt, endAt, unavailabilityId, reason) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  const conflicts = [];
  for (const s of actorActiveSchedules(actorId)) {
    if (!(startMs < Date.parse(s.end_at) && Date.parse(s.start_at) < endMs)) continue;
    const actor = db.prepare('SELECT display_name FROM users WHERE id = ?').get(actorId);
    conflicts.push({
      actorId,
      actorName: actor?.display_name ?? `#${actorId}`,
      schedule: slotRef(s),
      unavailability: { id: unavailabilityId ?? null, startAt, endAt, reason },
    });
  }
  if (conflicts.length) {
    throw conflict('UNAVAILABILITY_CONFLICT', '不可用时段与本人当前参与的有效排练日程重叠，本次操作未生效', { conflicts });
  }
}

// ---- 演员：查看本人不可用记录 ----
router.get(
  '/me/unavailability',
  wrap((req, res) => {
    actorOnly(req);
    const rows = db
      .prepare('SELECT * FROM actor_unavailability WHERE actor_id = ? ORDER BY start_at, id')
      .all(req.user.id);
    res.json({ unavailability: rows.map(serialize) });
  })
);

// ---- 演员：登记不可用时段 ----
router.post(
  '/me/unavailability',
  wrap((req, res) => {
    actorOnly(req);
    const { startAt, endAt } = parseTimes(req.body, null);
    const reason = parseReason(req.body?.reason);
    const id = transaction(() => {
      assertNoOwnScheduleOverlap(req.user.id, startAt, endAt, null, reason);
      return db
        .prepare('INSERT INTO actor_unavailability (actor_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)')
        .run(req.user.id, startAt, endAt, reason).lastInsertRowid;
    });
    res.status(201).json({ unavailability: serialize(db.prepare('SELECT * FROM actor_unavailability WHERE id = ?').get(id)) });
  })
);

// ---- 演员：修改本人不可用时段 ----
router.patch(
  '/me/unavailability/:id',
  wrap((req, res) => {
    actorOnly(req);
    const u = db
      .prepare('SELECT * FROM actor_unavailability WHERE id = ? AND actor_id = ?')
      .get(req.params.id, req.user.id);
    if (!u) throw notFound('不可用时段不存在');
    if (['startAt', 'endAt', 'reason'].every((k) => req.body?.[k] == null)) {
      throw badRequest('没有需要修改的字段（startAt/endAt/reason）');
    }
    const { startAt, endAt } = parseTimes(req.body, u);
    const reason = req.body?.reason != null ? parseReason(req.body.reason) : u.reason;
    transaction(() => {
      assertNoOwnScheduleOverlap(req.user.id, startAt, endAt, u.id, reason);
      db.prepare(
        "UPDATE actor_unavailability SET start_at = ?, end_at = ?, reason = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(startAt, endAt, reason, u.id);
    });
    res.json({ unavailability: serialize(db.prepare('SELECT * FROM actor_unavailability WHERE id = ?').get(u.id)) });
  })
);

// ---- 演员：撤销本人不可用时段 ----
router.delete(
  '/me/unavailability/:id',
  wrap((req, res) => {
    actorOnly(req);
    const u = db
      .prepare('SELECT * FROM actor_unavailability WHERE id = ? AND actor_id = ?')
      .get(req.params.id, req.user.id);
    if (!u) throw notFound('不可用时段不存在');
    db.prepare('DELETE FROM actor_unavailability WHERE id = ?').run(u.id);
    res.json({ ok: true });
  })
);

module.exports = { router };

const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');
const {
  participantDetails,
  activeSubstitutesForSchedule,
  activeSubstitutesBrief,
  buildCandidate,
  assertNoScheduleConflicts,
  assertNoUnavailabilityConflicts,
  syncScheduleNotifications,
} = require('./schedules');
/**
 * 单时段临时替角：导演在“签到开启前”，为某个有效时段中“本场有台词且已派角”的角色
 * 指定一名不同于原演员的替补演员与原因，或撤回替补。
 *
 * 边界（仅作用于这一个时段）：
 *   - 改变该时段的最终参与者、时段通知接收人、替补演员可见的该场台词；
 *   - 不改变常驻派角（rehearsal_cast）与逐场确认（confirmations），临时台词权限不扩展到其他场次；
 *   - 同一时段同一角色至多一个生效替补（部分唯一索引 + 软失效留痕）。
 *
 * 设置/撤回均按“最终参与者”检查与其他有效时段、本人不可用时段的重叠
 * （半开区间 [start,end)，端点相接允许；已取消与待调整时段不参与），冲突整体不生效。
 *
 * 自动失效：改派/撤派、换版（角色失去台词）、调期改场次（角色失去台词）、
 * 取消或转待调整都会让相关替角失效并留痕；恢复有效须重新设置与校验。
 *
 * 依赖方向：substitutes.js -> schedules.js（参与者/冲突/通知）；
 * schedules.js 在路由事务内用懒 require 调用本模块的失效函数，避免循环依赖。
 */

const router = express.Router();
router.use(authRequired);

const INVALID_REASONS = {
  replaced: '已被新的替补替换',
  withdrawn: '导演撤回替补',
  cast_reassigned: '常驻派角已改派，替补失效',
  cast_unassigned: '常驻派角已撤派，替补失效',
  role_lines_removed: '调整后该角色在此场次已无台词，替补失效',
  schedule_cancelled: '时段已取消，替补失效',
  schedule_needs_adjustment: '换版后该时段转待调整，替补失效',
};

function getRehearsalOrThrow(id) {
  const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id);
  if (!r) throw notFound('排练不存在');
  return r;
}

function getScheduleOrThrow(scheduleId, rehearsalId) {
  const s = db
    .prepare('SELECT * FROM rehearsal_schedules WHERE id = ? AND rehearsal_id = ?')
    .get(scheduleId, rehearsalId);
  if (!s) throw notFound('日程安排不存在');
  return s;
}

function getActiveSubOrThrow(scheduleId, roleId) {
  return db
    .prepare(
      `SELECT * FROM schedule_role_substitutes
        WHERE schedule_id = ? AND role_id = ? AND status = 'active'`
    )
    .get(scheduleId, roleId);
}

function markSubstituteInvalid(id, reason) {
  db.prepare(
    `UPDATE schedule_role_substitutes
       SET status = 'invalidated', invalidated_reason = ?, invalidated_at = datetime('now')
     WHERE id = ? AND status = 'active'`
  ).run(reason, id);
}

/** 时段已开启过到场登记（名单冻结，不允许再设置/撤回替角） */
function assertAttendanceNotOpen(scheduleId) {
  const att = db.prepare('SELECT id FROM attendance_sessions WHERE schedule_id = ?').get(scheduleId);
  if (att) {
    throw conflict(
      'ATTENDANCE_FROZEN',
      '该时段已开启到场登记，参与名单已冻结，不能再设置或撤回临时替角'
    );
  }
}

/**
 * 改派/撤派后（在派角事务内、冲突检测前调用）：
 *   - 原派角演员变化 -> 该排练所有有效时段内该角色的生效替角失效（cast_reassigned）；
 *   - 撤派 -> 失效（cast_unassigned）。返回失效条数。
 */
function invalidateSubstitutesAfterCastChange(rehearsalId, roleId, currentActorId, wasRemoved) {
  const reason = wasRemoved ? 'cast_unassigned' : 'cast_reassigned';
  const rows = db
    .prepare(
      `SELECT sub.id FROM schedule_role_substitutes sub
         JOIN rehearsal_schedules s ON s.id = sub.schedule_id
        WHERE sub.rehearsal_id = ? AND sub.role_id = ? AND sub.status = 'active'
          AND s.status = 'active'`
    )
    .all(rehearsalId, roleId);
  for (const row of rows) markSubstituteInvalid(row.id, reason);
  return rows.length;
}

/**
 * 单条/批量调期（含待调整恢复）落库后（冲突检测前调用）：
 * 改到的目标场次在当前固定版本中该角色已无台词 -> 替角失效（role_lines_removed）。
 */
function invalidateSubstitutesAfterAdjustment(rehearsalId, scheduleId, newSceneId) {
  const rehearsal = db.prepare('SELECT version_id FROM rehearsals WHERE id = ?').get(rehearsalId);
  const subs = activeSubstitutesForSchedule(scheduleId);
  let n = 0;
  for (const sub of subs) {
    const hasLines = db
      .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND scene_id = ? AND role_id = ? LIMIT 1')
      .get(rehearsal.version_id, newSceneId, sub.role_id);
    if (!hasLines) {
      markSubstituteInvalid(sub.id, 'role_lines_removed');
      n += 1;
    }
  }
  return n;
}

/** 取消时段（或外部需要时）：该时段全部生效替角按指定原因失效 */
function invalidateSubstitutesForSchedule(scheduleId, reason) {
  const subs = activeSubstitutesForSchedule(scheduleId);
  for (const sub of subs) markSubstituteInvalid(sub.id, reason);
  return subs.length;
}

/**
 * 换版（在版本已更新、日程状态已落库的换版事务内调用）：
 *   - 转待调整时段的替角 -> schedule_needs_adjustment；
 *   - 仍有效时段中，角色在新版本该场次失去台词的替角 -> role_lines_removed。
 * plan 为 schedules.planSchedulesForVersionSwitch 在“新版本”下算出的计划。
 */
function invalidateSubstitutesAfterVersionSwitch(plan, newVersionId) {
  const invalidated = [];
  for (const s of plan.needsAdjustment) {
    for (const sub of activeSubstitutesForSchedule(s.id)) {
      markSubstituteInvalid(sub.id, 'schedule_needs_adjustment');
      invalidated.push({ scheduleId: s.id, roleId: sub.role_id, reason: 'schedule_needs_adjustment' });
    }
  }
  for (const s of plan.stillActive) {
    const survivors = new Set((plan.survivorsBySchedule.get(s.id) ?? []).map((x) => x.id));
    for (const sub of activeSubstitutesForSchedule(s.id)) {
      if (survivors.has(sub.id)) continue;
      markSubstituteInvalid(sub.id, 'role_lines_removed');
      invalidated.push({ scheduleId: s.id, roleId: sub.role_id, reason: 'role_lines_removed' });
    }
  }
  return invalidated;
}

/** 序列化一条替角（含失效痕迹） */
function serializeSubstitute(x) {
  const role = db.prepare('SELECT code, name FROM roles WHERE id = ?').get(x.role_id);
  const actor = db.prepare('SELECT display_name FROM users WHERE id = ?').get(x.actor_id);
  const original = db.prepare('SELECT display_name FROM users WHERE id = ?').get(x.original_actor_id);
  return {
    id: x.id,
    scheduleId: x.schedule_id,
    rehearsalId: x.rehearsal_id,
    roleId: x.role_id,
    roleCode: role?.code ?? null,
    roleName: role?.name ?? null,
    originalActorId: x.original_actor_id,
    originalActorName: original?.display_name ?? null,
    actorId: x.actor_id,
    actorName: actor?.display_name ?? null,
    reason: x.reason,
    status: x.status,
    invalidatedReason: x.invalidated_reason ?? null,
    invalidatedLabel: x.invalidated_reason ? INVALID_REASONS[x.invalidated_reason] ?? x.invalidated_reason : null,
    createdAt: x.created_at,
    invalidatedAt: x.invalidated_at ?? null,
  };
}

/** 构造设置/撤回后整排练的冲突检测候选（按最终名单：含当前生效替角） */
function rehearsalCandidatesAfterSubstituteChange(rehearsal) {
  const rows = db
    .prepare("SELECT * FROM rehearsal_schedules WHERE rehearsal_id = ? AND status = 'active'")
    .all(rehearsal.id);
  return rows.map((s) =>
    buildCandidate({
      scheduleId: s.id,
      rehearsal,
      sceneId: s.scene_id,
      startAt: s.start_at,
      endAt: s.end_at,
    })
  );
}

// ---- 导演：设置临时替角（同角色同时段只保留一个；重复设置替换旧替补） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/substitutes',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可设置临时替角');
    const r = getRehearsalOrThrow(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    if (!Number.isInteger(scheduleId)) throw badRequest('scheduleId 必须为整数');
    const s = getScheduleOrThrow(scheduleId, r.id);
    // 无效时段明确拒绝
    if (s.status === 'cancelled') throw badRequest('该时段已取消，不能设置临时替角，请重新创建时段');
    if (s.status === 'needs_adjustment') {
      throw badRequest('该时段待调整，恢复有效后才能设置临时替角');
    }
    assertAttendanceNotOpen(s.id);

    const roleId = Number(req.body?.roleId);
    if (!Number.isInteger(roleId)) throw badRequest('roleId 必填且为整数');
    const actorId = Number(req.body?.actorId);
    if (!Number.isInteger(actorId)) throw badRequest('actorId 必填且为整数');
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw badRequest('reason 必填：请说明替角原因（如临时身体不适）');

    // 角色必须属于该剧
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND play_id = ?').get(roleId, r.play_id);
    if (!role) throw badRequest(`角色 #${roleId} 不存在或不属于该剧`);
    // 必须是该场有台词且已派角的角色
    const hasLines = db
      .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND scene_id = ? AND role_id = ? LIMIT 1')
      .get(r.version_id, s.scene_id, roleId);
    if (!hasLines) throw badRequest('该角色在当前固定版本的此场次没有台词，不能设为替角');
    const cast = db
      .prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
      .get(r.id, roleId);
    if (!cast) throw badRequest('该角色尚未派角，请先完成常驻派角再设置临时替角');
    // 替补必须是演员身份，且不同于原（常驻）演员
    const actor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(actorId);
    if (!actor) throw badRequest(`替补演员 #${actorId} 不存在或不是演员`);
    if (actorId === cast.actor_id) throw badRequest('替补演员必须不同于该角色的原演员');

    const existing = getActiveSubOrThrow(s.id, roleId);

    const result = transaction(() => {
      let action = 'created';
      if (existing) {
        if (existing.actor_id === actorId) {
          // 幂等：同一替补仅更新原因 -> 不改变参与者，不重发通知
          db.prepare('UPDATE schedule_role_substitutes SET reason = ? WHERE id = ?').run(reason, existing.id);
          return { action: 'reason_updated', id: existing.id };
        }
        markSubstituteInvalid(existing.id, 'replaced');
        action = 'replaced';
      }
      const id = db
        .prepare(
          `INSERT INTO schedule_role_substitutes
             (schedule_id, rehearsal_id, role_id, original_actor_id, actor_id, reason, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(s.id, r.id, roleId, cast.actor_id, actorId, reason, req.user.id).lastInsertRowid;

      // 按最终参与者检查与其他有效时段、本人不可用时段的重叠（端点相接允许）
      const candidates = rehearsalCandidatesAfterSubstituteChange(r);
      assertNoScheduleConflicts(candidates, '设置替角后最终参与者与其他未取消时段重叠，本次设置未生效');
      assertNoUnavailabilityConflicts(
        candidates,
        '设置替角后最终参与者与其登记的不可用时段相撞，本次设置未生效'
      );
      // 通知接收人或其角色变化 -> 生成新批次（无实质变化不重发），旧批次留作历史
      const notifications = syncScheduleNotifications(r.id, 'substitute', req.user.id);
      return { action, id, notifications };
    });

    const row = db.prepare('SELECT * FROM schedule_role_substitutes WHERE id = ?').get(result.id);
    const { participants } = participantDetails(r.id, r.version_id, s.scene_id, { scheduleId: s.id });
    res.status(result.action === 'created' ? 201 : 200).json({
      ok: true,
      action: result.action, // created / replaced / reason_updated
      substitute: serializeSubstitute(row),
      substitutes: activeSubstitutesBrief(s.id),
      participants,
      notifications: result.notifications ?? [],
    });
  })
);

// ---- 导演：撤回某角色的临时替角（撤回后原演员回到该时段；同样做冲突检查） ----
router.delete(
  '/rehearsals/:id/schedules/:scheduleId/substitutes/:roleId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可撤回临时替角');
    const r = getRehearsalOrThrow(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(scheduleId) || !Number.isInteger(roleId)) throw badRequest('scheduleId/roleId 必须为整数');
    const s = getScheduleOrThrow(scheduleId, r.id);
    if (s.status === 'cancelled') throw badRequest('该时段已取消');
    if (s.status === 'needs_adjustment') throw badRequest('该时段待调整');
    assertAttendanceNotOpen(s.id);
    const existing = getActiveSubOrThrow(s.id, roleId);
    if (!existing) throw badRequest('该角色在此时段没有生效中的临时替角，无需撤回');

    const result = transaction(() => {
      markSubstituteInvalid(existing.id, 'withdrawn');
      // 撤回也按最终参与者（原演员回归）检查重叠；冲突则整体不生效
      const candidates = rehearsalCandidatesAfterSubstituteChange(r);
      assertNoScheduleConflicts(candidates, '撤回替角后最终参与者与其他未取消时段重叠，本次撤回未生效');
      assertNoUnavailabilityConflicts(
        candidates,
        '撤回替角后最终参与者与其登记的不可用时段相撞，本次撤回未生效'
      );
      const notifications = syncScheduleNotifications(r.id, 'substitute', req.user.id);
      return { notifications };
    });

    const { participants } = participantDetails(r.id, r.version_id, s.scene_id, { scheduleId: s.id });
    res.json({
      ok: true,
      action: 'withdrawn',
      roleId,
      substitutes: activeSubstitutesBrief(s.id),
      participants,
      notifications: result.notifications,
    });
  })
);

// ---- 导演：查看某时段的替角状态（生效中 + 最近失效痕迹） ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/substitutes',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看临时替角');
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(Number(req.params.scheduleId), r.id);
    const active = db
      .prepare(
        `SELECT * FROM schedule_role_substitutes WHERE schedule_id = ? AND status = 'active' ORDER BY role_id`
      )
      .all(s.id);
    const history = db
      .prepare(
        `SELECT * FROM schedule_role_substitutes
          WHERE schedule_id = ? AND status = 'invalidated' ORDER BY id DESC LIMIT 20`
      )
      .all(s.id);
    const { participants } = participantDetails(r.id, r.version_id, s.scene_id, { scheduleId: s.id });
    res.json({
      schedule: { id: s.id, status: s.status },
      substitutes: active.map(serializeSubstitute),
      participants,
      history: history.map(serializeSubstitute),
    });
  })
);

// ---- 演员：某时段该场次中“本人可念”的台词（常驻派角角色 + 在该时段担任替角的角色） ----
// 临时台词权限仅对这一个时段有效，不扩展到其他场次/排练。
router.get(
  '/rehearsals/:id/schedules/:scheduleId/lines',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(Number(req.params.scheduleId), r.id);
    if (s.status !== 'active') throw badRequest('仅有效时段可查看该场台词');

    if (req.user.role === 'director') {
      const lines = db
        .prepare(
          `SELECT vl.line_id, vl.role_id, ro.code AS role_code, ro.name AS role_name, vl.seq, vl.text
             FROM version_lines vl
             JOIN roles ro ON ro.id = vl.role_id
            WHERE vl.version_id = ? AND vl.scene_id = ?
            ORDER BY vl.seq, vl.line_id`
        )
        .all(r.version_id, s.scene_id);
      return res.json({
        scheduleId: s.id,
        sceneId: s.scene_id,
        versionId: r.version_id,
        lines: lines.map((l) => ({
          lineId: l.line_id,
          roleId: l.role_id,
          roleCode: l.role_code,
          roleName: l.role_name,
          seq: l.seq,
          text: l.text,
        })),
      });
    }
    if (req.user.role !== 'actor') throw forbidden();

    // 本人在该时段的最终角色（该时段参与者口径：常驻角色被替角顶替后，原演员不再持有该角色）
    const { participants } = participantDetails(r.id, r.version_id, s.scene_id, { scheduleId: s.id });
    const me = participants.find((p) => p.actorId === req.user.id);
    if (!me) throw forbidden('你未参与此时段，不能查看该场台词');
    const myRoleIds = me.roles.map((x) => x.roleId);
    const subRoleIds = new Set(me.roles.filter((x) => x.viaSubstitute).map((x) => x.roleId));
    const visibleRoleIds = new Set(myRoleIds);

    const lines = db
      .prepare(
        `SELECT vl.line_id, vl.role_id, ro.code AS role_code, ro.name AS role_name, vl.seq, vl.text
           FROM version_lines vl
           JOIN roles ro ON ro.id = vl.role_id
          WHERE vl.version_id = ? AND vl.scene_id = ?
          ORDER BY vl.seq, vl.line_id`
      )
      .all(r.version_id, s.scene_id)
      .filter((l) => visibleRoleIds.has(l.role_id))
      .map((l) => ({
        lineId: l.line_id,
        roleId: l.role_id,
        roleCode: l.role_code,
        roleName: l.role_name,
        seq: l.seq,
        text: l.text,
        viaSubstitute: subRoleIds.has(l.role_id),
      }));

    res.json({
      scheduleId: s.id,
      sceneId: s.scene_id,
      versionId: r.version_id,
      myRoles: me.roles,
      lines,
    });
  })
);

module.exports = {
  router,
  invalidateSubstitutesAfterCastChange,
  invalidateSubstitutesAfterAdjustment,
  invalidateSubstitutesForSchedule,
  invalidateSubstitutesAfterVersionSwitch,
};

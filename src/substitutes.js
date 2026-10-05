const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');
const {
  findScheduleConflicts,
  findUnavailabilityConflicts,
  syncScheduleNotifications,
  participantDetails,
  invalidateSubstitutes,
  substitutesForSchedule,
  buildCandidate,
} = require('./schedules');

/**
 * 单时段临时替角（排练页，导演操作）：
 *   - 导演在某“有效（active）”时段“签到开启前”，选择该场有台词且已派角的角色、
 *     不同于原演员的替补演员与原因，设置/替换该角色在该时段的替角；也可撤回。
 *   - 同一角色同一时段只保留一个生效替角（替换/撤回以失效行留历史）。
 *   - 替角只改变本时段的最终参与者、通知接收人与替角可见的本场台词；
 *     不改常驻派角 rehearsal_cast 与逐场确认 confirmations；临时台词权限不扩展至其他场次/时段。
 *   - 设置和撤回均按“最终参与者”检查与其他有效时段、本人不可用时段的重叠
 *     （409 SCHEDULE_CONFLICT / UNAVAILABILITY_CONFLICT，端点相接允许，冲突整体不生效）。
 *   - 调期/批量调期/换版/改派后：替角角色失去台词或原派角变化 -> 替角失效并按最终名单重新校验；
 *     时段取消或待调整时不占用演员，恢复有效后须由导演重新设置。
 *   - 仅当替角使通知接收人或其角色变化时才重发通知（syncScheduleNotifications 的指纹比对）；
 *     旧批次保留为历史；已开启签到的时段名单冻结，不回写也不再允许设/撤替角。
 *
 * 依赖方向：substitutes.js -> schedules.js（冲突检测/通知/参与者/失效工具），schedules.js 不引用本模块。
 */

const router = express.Router();
router.use(authRequired);

function getScheduleOr400(scheduleId, rehearsalId) {
  const s = db
    .prepare('SELECT * FROM rehearsal_schedules WHERE id = ? AND rehearsal_id = ?')
    .get(scheduleId, rehearsalId);
  if (!s) throw badRequest('无效时段：该日程安排不存在或不属于此排练');
  return s;
}

/** 已开启签到（含已关闭/已作废）的时段冻结名单，替角设置/撤回一律拒绝 */
function assertAttendanceNotOpened(scheduleId) {
  const att = db.prepare('SELECT id FROM attendance_sessions WHERE schedule_id = ?').get(scheduleId);
  if (att) {
    throw conflict(
      'ATTENDANCE_FROZEN',
      '该时段已开启到场登记，名单已冻结，不能再设置或撤回临时替角'
    );
  }
}

// ---- 导演：设置/替换某角色在某时段的临时替角 ----
router.put(
  '/rehearsals/:id/schedules/:scheduleId/substitutes/:roleId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可设置临时替角');
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(roleId)) throw badRequest('roleId 必须为整数');
    const s = getScheduleOr400(scheduleId, rehearsalId);
    if (s.status !== 'active') throw badRequest('仅有效时段可以设置临时替角（已取消/待调整时段请先调整恢复有效）');
    assertAttendanceNotOpened(scheduleId);

    const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
    // 角色须属于该剧、当前固定版本该场有台词
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND play_id = ?').get(roleId, r.play_id);
    if (!role) throw badRequest('无效角色：角色不存在或不属于该剧');
    const hasLines = db
      .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND scene_id = ? AND role_id = ? LIMIT 1')
      .get(r.version_id, s.scene_id, roleId);
    if (!hasLines) throw badRequest('该角色在此时段场次的当前固定版本中没有台词，不能设置替角');
    // 必须已派角（替角替的是常驻派角演员）
    const castRow = db
      .prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
      .get(rehearsalId, roleId);
    if (!castRow) throw badRequest('该角色尚未派角，请先完成常驻派角后再设置临时替角');

    const substituteActorId = Number(req.body?.substituteActorId);
    if (!Number.isInteger(substituteActorId)) throw badRequest('substituteActorId 必填且为整数');
    const subActor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(substituteActorId);
    if (!subActor) throw badRequest('替补演员不存在或不是演员身份');
    if (substituteActorId === castRow.actor_id) {
      throw badRequest('替补演员必须不同于该角色的原演员');
    }
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw badRequest('reason 必填：请说明临时替角原因');

    const result = transaction(() => {
      const existing = db
        .prepare("SELECT * FROM schedule_substitutes WHERE schedule_id = ? AND role_id = ? AND status = 'active'")
        .get(scheduleId, roleId);
      let action;
      if (existing && existing.substitute_actor_id === substituteActorId) {
        // 同一替角：仅更新原因；不触发冲突重算与通知（接收人/角色无变化）
        db.prepare("UPDATE schedule_substitutes SET reason = ? WHERE id = ?").run(reason, existing.id);
        action = 'reason_updated';
      } else {
        if (existing) invalidateSubstitutes({ scheduleId, roleId }, 'withdrawn');
        const id = db
          .prepare(
            `INSERT INTO schedule_substitutes
               (schedule_id, rehearsal_id, role_id, original_actor_id, substitute_actor_id, reason, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(scheduleId, rehearsalId, roleId, castRow.actor_id, substituteActorId, reason, req.user.id)
          .lastInsertRowid;
        action = existing ? 'replaced' : 'set';
        // 按最终参与者（替角后）检查与其他有效时段的重叠及替补本人不可用时段：冲突整体不生效
        const cand = buildCandidate({ scheduleId, rehearsal: r, sceneId: s.scene_id, startAt: s.start_at, endAt: s.end_at });
        const conflicts = findScheduleConflicts([cand]);
        if (conflicts.length) {
          throw conflict(
            'SCHEDULE_CONFLICT',
            '设置临时替角后最终参与者与其他有效时段重叠，本次设置未生效',
            { conflicts }
          );
        }
        const unavail = findUnavailabilityConflicts([cand]);
        if (unavail.length) {
          throw conflict(
            'UNAVAILABILITY_CONFLICT',
            '替补演员在该时段已登记不可用，本次临时替角未生效',
            { conflicts: unavail }
          );
        }
        // 仅当接收人或其角色变化时生成新批次（指纹比对）；旧批次保留为历史
        syncScheduleNotifications(rehearsalId, 'substitute', req.user.id);
        return { action, substituteId: id };
      }
      return { action, substituteId: existing.id };
    });

    const fresh = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
    const { participants } = participantDetails(rehearsalId, r.version_id, s.scene_id, { scheduleId });
    res.status(200).json({
      ok: true,
      action: result.action,
      substitute: substitutesForSchedule(scheduleId).find((x) => x.id === result.substituteId),
      participants,
      schedule: serializeScheduleBrief(fresh, r),
    });
  })
);

// ---- 导演：撤回某角色在某时段的临时替角 ----
router.delete(
  '/rehearsals/:id/schedules/:scheduleId/substitutes/:roleId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可撤回临时替角');
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(roleId)) throw badRequest('roleId 必须为整数');
    const s = getScheduleOr400(scheduleId, rehearsalId);
    if (s.status !== 'active') throw badRequest('仅有效时段可以撤回临时替角');
    assertAttendanceNotOpened(scheduleId);

    const existing = db
      .prepare("SELECT * FROM schedule_substitutes WHERE schedule_id = ? AND role_id = ? AND status = 'active'")
      .get(scheduleId, roleId);
    if (!existing) throw badRequest('该角色在此时段没有生效中的临时替角');

    transaction(() => {
      invalidateSubstitutes({ scheduleId, roleId }, 'withdrawn');
      // 撤回后按最终参与者（原演员回来）重查冲突：原演员其他有效时段/本人不可用 -> 整体不生效
      const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
      const cand = buildCandidate({ scheduleId, rehearsal: r, sceneId: s.scene_id, startAt: s.start_at, endAt: s.end_at });
      const conflicts = findScheduleConflicts([cand]);
      if (conflicts.length) {
        throw conflict(
          'SCHEDULE_CONFLICT',
          '撤回临时替角后原演员与其他有效时段重叠，本次撤回未生效',
          { conflicts }
        );
      }
      const unavail = findUnavailabilityConflicts([cand]);
      if (unavail.length) {
        throw conflict(
          'UNAVAILABILITY_CONFLICT',
          '撤回临时替角后原演员在该时段已登记不可用，本次撤回未生效',
          { conflicts: unavail }
        );
      }
      syncScheduleNotifications(rehearsalId, 'substitute', req.user.id);
    });

    const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
    const fresh = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
    const { participants } = participantDetails(rehearsalId, r.version_id, s.scene_id, { scheduleId });
    res.json({
      ok: true,
      action: 'withdrawn',
      roleId,
      participants,
      schedule: serializeScheduleBrief(fresh, r),
    });
  })
);

// ---- 导演：查看某时段替角（生效 + 失效历史） ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/substitutes',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看临时替角');
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    getScheduleOr400(scheduleId, rehearsalId);
    const all = substitutesForSchedule(scheduleId);
    res.json({
      scheduleId,
      active: all.filter((x) => x.status === 'active'),
      history: all.filter((x) => x.status !== 'active'),
    });
  })
);

// ---- 演员：查看自己作为“最终参与者”在某有效时段可见的本场台词（含临时替角角色） ----
// 临时台词权限仅限本时段本场次：不返回其他场次，也不授予常驻排练稿/逐场确认权限。
router.get(
  '/rehearsals/:id/schedules/:scheduleId/temp-lines',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员可查看本人时段台词');
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const s = getScheduleOr400(scheduleId, rehearsalId);
    if (s.status !== 'active') throw badRequest('该时段不是有效时段');
    const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
    const { participants } = participantDetails(rehearsalId, r.version_id, s.scene_id, { scheduleId });
    const me = participants.find((p) => p.actorId === req.user.id);
    if (!me) throw forbidden('你不是该时段的参与者（含临时替角），不能查看本场台词');

    const roleIds = me.roles.map((x) => x.roleId);
    const ph = roleIds.map(() => '?').join(',');
    const lines = db
      .prepare(
        `SELECT vl.line_id, vl.role_id, vl.seq, vl.text,
                ro.code AS role_code, ro.name AS role_name,
                sc.code AS scene_code, sc.title AS scene_title
           FROM version_lines vl
           JOIN roles ro ON ro.id = vl.role_id
           JOIN scenes sc ON sc.id = vl.scene_id
          WHERE vl.version_id = ? AND vl.scene_id = ? AND vl.role_id IN (${ph})
          ORDER BY vl.seq, vl.id`
      )
      .all(r.version_id, s.scene_id, ...roleIds);
    res.json({
      scheduleId,
      rehearsalId,
      sceneId: s.scene_id,
      sceneCode: lines[0]?.scene_code ?? null,
      sceneTitle: lines[0]?.scene_title ?? null,
      versionId: r.version_id,
      startAt: s.start_at,
      endAt: s.end_at,
      // 仅本场；temporary=true 的角色是临时替角可见，权限不外延
      myRoles: me.roles,
      lines: lines.map((l) => ({
        lineId: l.line_id,
        roleId: l.role_id,
        roleCode: l.role_code,
        roleName: l.role_name,
        temporary: me.roles.find((x) => x.roleId === l.role_id)?.temporary ?? false,
        seq: l.seq,
        text: l.text,
      })),
    });
  })
);

/** 响应中携带的时段简要信息（完整视图仍走 GET /schedules） */
function serializeScheduleBrief(s, rehearsal) {
  const scene = db.prepare('SELECT code, title FROM scenes WHERE id = ?').get(s.scene_id);
  return {
    id: s.id,
    rehearsalId: s.rehearsal_id,
    sceneId: s.scene_id,
    sceneCode: scene?.code ?? null,
    sceneTitle: scene?.title ?? null,
    startAt: s.start_at,
    endAt: s.end_at,
    status: s.status,
  };
}

module.exports = { router };

const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');
const { participantDetails } = require('./schedules');

/**
 * 到场登记：导演为“有效”日程时段开启的一次性到场签到。
 *
 * 核心规则：
 *   - 开启：仅导演、仅 status=active 的时段；每个时段至多一次登记（含已关闭/已作废）。
 *     开启即冻结：场次、UTC 起止、排练当时固定版本、当时“本场有台词且已派角”的演员名单；
 *     有台词未派角的角色记为缺口（不计应到）。
 *   - 签到：仅名单内演员本人在开放期签到；重试返回首次签到结果（幂等）；
 *     后来加入（开启后才派角）的演员不在名单，不能签到。
 *   - 关闭：仅导演、仅开放中的登记；关闭后未签到者记缺席，后续签到与再次关闭均拒绝。
 *   - 不回写：改派/换版/调整日程不回写名单与签到（名单是开启时的快照）。
 *   - 日程取消联动（在 schedules.js 取消端点内落库）：
 *       开放中取消 -> 登记作废(voided)，停止签到，已签到痕迹保留但不计出勤；
 *       关闭后取消 -> 仅标注 schedule_cancelled，原统计保留。
 *   - 可见性：导演看名单/缺口/统计；演员只看本人记录。
 *
 * 依赖方向：attendance.js -> schedules.js（participantDetails），schedules.js 不引用本模块，
 * 取消日程时对 attendance_sessions 的联动用直接 SQL 完成，避免循环依赖。
 */

const router = express.Router();
router.use(authRequired);

const SESSION_STATUS_LABEL = { open: '开放中', closed: '已关闭', voided: '已作废' };

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

function getSessionBySchedule(scheduleId) {
  return db.prepare('SELECT * FROM attendance_sessions WHERE schedule_id = ?').get(scheduleId);
}

function getSessionOrThrow(scheduleId) {
  const s = getSessionBySchedule(scheduleId);
  if (!s) throw notFound('该时段尚未开启到场登记');
  return s;
}

/** 名单成员的展示状态：checked_in / pending(开放未签) / absent(关闭未签) / unmarked(作废未签) */
function rosterState(session, checkedInAt) {
  if (checkedInAt) return 'checked_in';
  if (session.status === 'closed') return 'absent';
  if (session.status === 'open') return 'pending';
  return 'unmarked';
}

/**
 * 状态统计。作废的登记不计出勤（counted=false，缺席恒为 0），
 * 已签到痕迹仍保留在名单中可查。
 */
function sessionStats(session, roster) {
  const expected = roster.length;
  const checkedIn = roster.filter((r) => r.checked_in_at).length;
  const counted = session.status !== 'voided';
  return {
    expected,
    checkedIn,
    pending: session.status === 'open' ? expected - checkedIn : 0,
    absent: counted && session.status === 'closed' ? expected - checkedIn : 0,
    counted,
  };
}

function sceneBrief(sceneId) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  return { sceneCode: scene?.code ?? null, sceneTitle: scene?.title ?? null };
}

function baseSessionView(session) {
  const version = db.prepare('SELECT version_no FROM versions WHERE id = ?').get(session.version_id);
  return {
    id: session.id,
    scheduleId: session.schedule_id,
    rehearsalId: session.rehearsal_id,
    sceneId: session.scene_id,
    ...sceneBrief(session.scene_id),
    versionId: session.version_id,
    versionNo: version?.version_no ?? null,
    startAt: session.start_at,
    endAt: session.end_at,
    status: session.status,
    statusLabel: SESSION_STATUS_LABEL[session.status],
    scheduleCancelled: !!session.schedule_cancelled,
    openedAt: session.opened_at,
    closedAt: session.closed_at,
  };
}

/** 导演视图：完整名单、缺口与状态统计 */
function serializeSessionForDirector(session) {
  const rosterRows = db
    .prepare(
      `SELECT ar.*, u.display_name, u.username
         FROM attendance_roster ar
         JOIN users u ON u.id = ar.actor_id
        WHERE ar.session_id = ? ORDER BY ar.id`
    )
    .all(session.id);
  const roster = rosterRows.map((r) => ({
    actorId: r.actor_id,
    actorName: r.display_name,
    actorUsername: r.username,
    roles: JSON.parse(r.roles_json),
    state: rosterState(session, r.checked_in_at),
    checkedInAt: r.checked_in_at,
  }));
  const gaps = db
    .prepare(
      `SELECT g.role_id, ro.code, ro.name
         FROM attendance_gaps g
         JOIN roles ro ON ro.id = g.role_id
        WHERE g.session_id = ? ORDER BY ro.id`
    )
    .all(session.id)
    .map((g) => ({ roleId: g.role_id, roleCode: g.code, roleName: g.name }));
  return {
    ...baseSessionView(session),
    roster,
    gaps,
    stats: sessionStats(session, rosterRows),
  };
}

/** 演员视图：只看本人记录（调用方需先确认其在名单上） */
function serializeSessionForActor(session, actorId) {
  const mine = db
    .prepare('SELECT * FROM attendance_roster WHERE session_id = ? AND actor_id = ?')
    .get(session.id, actorId);
  return {
    ...baseSessionView(session),
    my: mine
      ? {
          roles: JSON.parse(mine.roles_json),
          state: rosterState(session, mine.checked_in_at),
          checkedInAt: mine.checked_in_at,
        }
      : null,
  };
}

// ---- 导演：开启登记（每个时段至多一次；仅有效时段可开启） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/attendance',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可开启到场登记');
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    if (s.status === 'cancelled') throw badRequest('该时段已取消，不能开启到场登记');
    if (s.status === 'needs_adjustment') throw badRequest('该时段待调整，恢复有效后才能开启到场登记');
    if (getSessionBySchedule(s.id)) {
      throw conflict('ATTENDANCE_EXISTS', '该时段已开启过到场登记，每个时段至多一次');
    }

    const sessionId = transaction(() => {
      // 冻结：场次、UTC 时段、当时固定版本、当时“有台词且已派角”的演员名单与缺口
      const { participants, pendingCast } = participantDetails(r.id, r.version_id, s.scene_id);
      const id = db
        .prepare(
          `INSERT INTO attendance_sessions
             (schedule_id, rehearsal_id, scene_id, version_id, start_at, end_at, opened_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(s.id, r.id, s.scene_id, r.version_id, s.start_at, s.end_at, req.user.id).lastInsertRowid;
      const insRoster = db.prepare(
        'INSERT INTO attendance_roster (session_id, actor_id, roles_json) VALUES (?, ?, ?)'
      );
      for (const p of participants) insRoster.run(id, p.actorId, JSON.stringify(p.roles));
      const insGap = db.prepare('INSERT INTO attendance_gaps (session_id, role_id) VALUES (?, ?)');
      for (const g of pendingCast) insGap.run(id, g.roleId);
      return id;
    });

    const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(sessionId);
    res.status(201).json({ session: serializeSessionForDirector(session) });
  })
);

// ---- 导演：关闭登记（未签到者记缺席；再次关闭拒绝） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/attendance/close',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可关闭到场登记');
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const session = getSessionOrThrow(s.id);
    if (session.status === 'closed') throw badRequest('登记已关闭，不能重复关闭');
    if (session.status === 'voided') throw badRequest('登记已作废（日程在开放期被取消），不能关闭');
    db.prepare(
      "UPDATE attendance_sessions SET status = 'closed', closed_by = ?, closed_at = datetime('now') WHERE id = ?"
    ).run(req.user.id, session.id);
    res.json({ session: serializeSessionForDirector(getSessionOrThrow(s.id)) });
  })
);

// ---- 演员：本人签到（开放期、名单内；重试返回首次结果） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/attendance/check-in',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员本人可签到');
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const session = getSessionOrThrow(s.id);
    // 名单是开启时的冻结快照：后来加入者不在名单，不能签到
    const mine = db
      .prepare('SELECT * FROM attendance_roster WHERE session_id = ? AND actor_id = ?')
      .get(session.id, req.user.id);
    if (!mine) throw forbidden('你不在本次登记名单中，不能签到');
    if (session.status === 'closed') {
      throw conflict('ATTENDANCE_NOT_OPEN', '登记已关闭，未签到者已记缺席，不能再签到');
    }
    if (session.status === 'voided') {
      throw conflict('ATTENDANCE_NOT_OPEN', '登记已作废（日程在开放期被取消），停止签到');
    }
    // 幂等：重试返回首次签到结果
    if (mine.checked_in_at) {
      return res.json({
        checkIn: { sessionId: session.id, actorId: req.user.id, checkedInAt: mine.checked_in_at, alreadyCheckedIn: true },
      });
    }
    const checkedInAt = new Date().toISOString();
    db.prepare('UPDATE attendance_roster SET checked_in_at = ? WHERE id = ?').run(checkedInAt, mine.id);
    res.status(201).json({
      checkIn: { sessionId: session.id, actorId: req.user.id, checkedInAt, alreadyCheckedIn: false },
    });
  })
);

// ---- 查看：导演看名单/缺口/统计；演员只看本人记录 ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/attendance',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const session = getSessionOrThrow(s.id);
    if (req.user.role === 'director') {
      return res.json({ session: serializeSessionForDirector(session) });
    }
    const onRoster = db
      .prepare('SELECT 1 FROM attendance_roster WHERE session_id = ? AND actor_id = ?')
      .get(session.id, req.user.id);
    if (!onRoster) throw forbidden('你不在本次登记名单中');
    res.json({ session: serializeSessionForActor(session, req.user.id) });
  })
);

module.exports = { router };

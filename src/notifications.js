const express = require('express');
const { db } = require('./db');
const { notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 时段通知（知悉确认）：导演调整排练安排后，演员需确认知悉当前时段。
 *
 * 核心规则：
 *   - 批次的生成/取代/失效全部在 schedules.js 的 syncScheduleNotifications 中、
 *     随原操作（排期/调期/取消/派角/撤派/换版）事务提交；冲突回滚时不留批次。
 *     本模块只负责查询与演员确认，不生成批次。
 *   - 每个时段至多一个“当前批次”（current）；旧批次保留（superseded 已被取代 /
 *     inactive 时段已取消或待调整）但不计当前待确认。
 *   - 演员仅能查看本人为接收人的批次，且只能确认当前有效批次；
 *     确认幂等——重试返回首次确认时间；过期批次确认返回 409 NOTIFICATION_EXPIRED。
 *   - 导演查看各时段当前批次的已确认/待确认名单及历史批次。
 *   - 通知不改写已开启的到场登记名单与台词逐场确认（本模块不触碰那两张表）。
 *
 * 依赖方向：notifications.js 不引用其他业务模块（全部直接查表），
 * schedules.js 也不引用本模块，避免循环依赖。
 */

const router = express.Router();
router.use(authRequired);

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

function getNotificationOrThrow(id) {
  const n = db.prepare('SELECT * FROM schedule_notifications WHERE id = ?').get(id);
  if (!n) throw notFound('通知批次不存在');
  return n;
}

function sceneBrief(sceneId) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  return { sceneCode: scene?.code ?? null, sceneTitle: scene?.title ?? null };
}

function baseBatchView(n) {
  const version = db.prepare('SELECT version_no FROM versions WHERE id = ?').get(n.version_id);
  return {
    id: n.id,
    scheduleId: n.schedule_id,
    rehearsalId: n.rehearsal_id,
    seq: n.seq,
    sceneId: n.scene_id,
    ...sceneBrief(n.scene_id),
    versionId: n.version_id,
    versionNo: version?.version_no ?? null,
    startAt: n.start_at,
    endAt: n.end_at,
    status: n.status,
    reason: n.reason,
    createdAt: n.created_at,
  };
}

/** 导演视图：冻结快照 + 接收人确认状态 + 统计（仅当前批次计待确认） */
function serializeBatchForDirector(n) {
  const recipients = db
    .prepare(
      `SELECT r.*, u.display_name, u.username
         FROM schedule_notification_recipients r
         JOIN users u ON u.id = r.actor_id
        WHERE r.notification_id = ? ORDER BY r.id`
    )
    .all(n.id)
    .map((r) => ({
      actorId: r.actor_id,
      actorName: r.display_name,
      actorUsername: r.username,
      roles: JSON.parse(r.roles_json),
      state: r.confirmed_at ? 'confirmed' : 'pending',
      confirmedAt: r.confirmed_at,
    }));
  const confirmed = recipients.filter((x) => x.state === 'confirmed').length;
  return {
    ...baseBatchView(n),
    recipients,
    stats: {
      expected: recipients.length,
      confirmed,
      pending: n.status === 'current' ? recipients.length - confirmed : 0,
    },
  };
}

/** 演员视图：仅本人为接收人的批次；myState 对非当前批次直接取批次状态 */
function serializeBatchForActor(row) {
  return {
    ...baseBatchView(row),
    rehearsalName: row.rehearsal_name,
    myRoles: JSON.parse(row.roles_json),
    myState: row.status === 'current' ? (row.confirmed_at ? 'confirmed' : 'pending') : row.status,
    confirmedAt: row.confirmed_at,
  };
}

// ---- 导演：某时段的通知批次（当前批次的已确认/待确认名单 + 历史批次） ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/notifications',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看时段通知批次');
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const batches = db
      .prepare('SELECT * FROM schedule_notifications WHERE schedule_id = ? ORDER BY seq DESC')
      .all(s.id);
    const current = batches.find((b) => b.status === 'current') ?? null;
    res.json({
      schedule: { id: s.id, status: s.status },
      current: current ? serializeBatchForDirector(current) : null,
      history: batches.filter((b) => b.status !== 'current').map(serializeBatchForDirector),
    });
  })
);

// ---- 演员：本人批次列表（当前待确认 + 历史，新的在前） ----
router.get(
  '/me/schedule-notifications',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员可查看本人时段通知');
    const rows = db
      .prepare(
        `SELECT n.*, rec.roles_json, rec.confirmed_at, r.name AS rehearsal_name
           FROM schedule_notification_recipients rec
           JOIN schedule_notifications n ON n.id = rec.notification_id
           JOIN rehearsals r ON r.id = n.rehearsal_id
          WHERE rec.actor_id = ?
          ORDER BY n.id DESC`
      )
      .all(req.user.id);
    res.json({ notifications: rows.map(serializeBatchForActor) });
  })
);

// ---- 演员：确认当前有效批次（幂等；过期批次拒绝） ----
router.post(
  '/schedule-notifications/:id/confirm',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员本人可确认时段通知');
    const n = getNotificationOrThrow(req.params.id);
    // 接收名单是生成时的冻结快照：后来加入者不在名单，不能确认该批次
    const mine = db
      .prepare('SELECT * FROM schedule_notification_recipients WHERE notification_id = ? AND actor_id = ?')
      .get(n.id, req.user.id);
    if (!mine) throw forbidden('你不在该批次的接收名单中');
    if (n.status !== 'current') {
      throw conflict(
        'NOTIFICATION_EXPIRED',
        '该批次已过期（已有新批次或时段已取消/待调整），请确认最新通知'
      );
    }
    // 幂等：重试返回首次确认时间
    if (mine.confirmed_at) {
      return res.json({
        confirmation: {
          notificationId: n.id,
          scheduleId: n.schedule_id,
          actorId: req.user.id,
          confirmedAt: mine.confirmed_at,
          alreadyConfirmed: true,
        },
      });
    }
    const confirmedAt = new Date().toISOString();
    db.prepare('UPDATE schedule_notification_recipients SET confirmed_at = ? WHERE id = ?').run(
      confirmedAt,
      mine.id
    );
    res.status(201).json({
      confirmation: {
        notificationId: n.id,
        scheduleId: n.schedule_id,
        actorId: req.user.id,
        confirmedAt,
        alreadyConfirmed: false,
      },
    });
  })
);

module.exports = { router };

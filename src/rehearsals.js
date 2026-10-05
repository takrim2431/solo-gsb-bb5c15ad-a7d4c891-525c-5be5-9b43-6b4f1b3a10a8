const express = require('express');
const crypto = require('crypto');
const { db, transaction, roleSceneHash } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired, publicUser } = require('./auth');
const { getPlayOrThrow, getVersionOfPlayOrThrow, formatVersion } = require('./plays');
const {
  assertRehearsalSchedulesAfterCastChange,
  applySchedulesAfterVersionSwitch,
  planSchedulesForVersionSwitch,
  findScheduleConflicts,
  findUnavailabilityConflicts,
  syncScheduleNotifications,
  participantDetails,
  invalidateSubstitutes,
} = require('./schedules');

const router = express.Router();
router.use(authRequired);

function getRehearsalOrThrow(id) {
  const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id);
  if (!r) throw notFound('排练不存在');
  return r;
}

/** 当前用户在该排练中被派的角色（演员） */
function assignedRoleIds(rehearsalId, actorId) {
  return db
    .prepare('SELECT role_id FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ?')
    .all(rehearsalId, actorId)
    .map((r) => r.role_id);
}

/** 排练当前派角列表（导演详情与批量派角响应共用） */
function rehearsalCastList(rehearsalId) {
  return db
    .prepare(
      `SELECT c.*, ro.name AS role_name, ro.code AS role_code,
              u.display_name AS actor_name, u.username AS actor_username
         FROM rehearsal_cast c
         JOIN roles ro ON ro.id = c.role_id
         JOIN users u ON u.id = c.actor_id
          WHERE c.rehearsal_id = ? ORDER BY ro.id`
    )
    .all(rehearsalId)
    .map((c) => ({
      roleId: c.role_id,
      roleCode: c.role_code,
      roleName: c.role_name,
      actorId: c.actor_id,
      actorName: c.actor_name,
      actorUsername: c.actor_username,
      assignedAt: c.assigned_at,
    }));
}

// ---- 排练管理（导演） ----
router.post(
  '/plays/:id/rehearsals',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const play = getPlayOrThrow(req.params.id);
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(versionId)) throw badRequest('创建排练时必须固定指定一个版本 versionId');
    const version = getVersionOfPlayOrThrow(versionId, play.id);
    const name = String(req.body?.name || '').trim() || `排练 @v${version.version_no}`;
    const info = transaction(() => {
      return db
        .prepare('INSERT INTO rehearsals (play_id, version_id, name, created_by) VALUES (?, ?, ?, ?)')
        .run(play.id, versionId, name, req.user.id);
    });
    res.status(201).json({
      id: info.lastInsertRowid,
      playId: play.id,
      versionId,
      name,
    });
  })
);

router.get(
  '/rehearsals',
  wrap((req, res) => {
    let rows;
    if (req.user.role === 'director') {
      rows = db.prepare('SELECT * FROM rehearsals ORDER BY id').all();
    } else {
      // 演员可见：被派角，或在该排练某有效时段被设为临时替角
      rows = db
        .prepare(
          `SELECT DISTINCT r.* FROM rehearsals r
             LEFT JOIN rehearsal_cast c ON c.rehearsal_id = r.id
             LEFT JOIN (
               SELECT ss.rehearsal_id, ss.substitute_actor_id
                 FROM schedule_substitutes ss
                 JOIN rehearsal_schedules s2 ON s2.id = ss.schedule_id
                WHERE ss.status = 'active' AND s2.status = 'active'
             ) sub ON sub.rehearsal_id = r.id AND sub.substitute_actor_id = ?
            WHERE c.actor_id = ? OR sub.substitute_actor_id = ?
            ORDER BY r.id`
        )
        .all(req.user.id, req.user.id, req.user.id);
    }
    res.json({ rehearsals: rows.map(serializeRehearsal) });
  })
);

function serializeRehearsal(r) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(r.version_id);
  const play = db.prepare('SELECT id, title FROM plays WHERE id = ?').get(r.play_id);
  return {
    id: r.id,
    playId: r.play_id,
    playTitle: play?.title ?? null,
    name: r.name,
    versionId: r.version_id,
    versionNo: version?.version_no ?? null,
    createdAt: r.created_at,
  };
}

/**
 * 排练详情。
 * 导演可见：派角、待确认（逐角色逐场次）、换版历史。
 * 演员仅在被派角时可见，且只看自己的部分。
 */
router.get(
  '/rehearsals/:id',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    const isDirector = req.user.role === 'director';
    const myRoles = isDirector ? [] : assignedRoleIds(r.id, req.user.id);
    const isSubstitute = isDirector
      ? false
      : !!db
          .prepare(
            `SELECT 1 FROM schedule_substitutes ss
               JOIN rehearsal_schedules s ON s.id = ss.schedule_id
              WHERE ss.rehearsal_id = ? AND ss.substitute_actor_id = ?
                AND ss.status = 'active' AND s.status = 'active' LIMIT 1`
          )
          .get(r.id, req.user.id);
    if (!isDirector && myRoles.length === 0 && !isSubstitute) throw forbidden();

    const cast = rehearsalCastList(r.id);

    let visibleCast = cast;
    if (!isDirector) {
      visibleCast = cast.filter((c) => c.actorId === req.user.id);
    }

    const payload = {
      rehearsal: serializeRehearsal(r),
      cast: visibleCast,
      pending: rehearsalPending(r, isDirector ? null : req.user.id),
      versionLog: db
        .prepare(
          `SELECT vl.*, v1.version_no AS from_no, v2.version_no AS to_no
             FROM rehearsal_version_log vl
             JOIN versions v1 ON v1.id = vl.from_version_id
             JOIN versions v2 ON v2.id = vl.to_version_id
            WHERE vl.rehearsal_id = ? ORDER BY vl.id`
        )
        .all(r.id)
        .map((l) => ({
          fromVersionId: l.from_version_id,
          toVersionId: l.to_version_id,
          fromNo: l.from_no,
          toNo: l.to_no,
          byActorId: l.actor_id,
          at: l.created_at,
        })),
    };

    if (isDirector) {
      // 导演页：展示该剧最近一次发布尝试的冲突详情
      const lastAttempt = db
        .prepare('SELECT * FROM publish_attempts WHERE play_id = ? ORDER BY id DESC LIMIT 1')
        .get(r.play_id);
      if (lastAttempt) {
        payload.lastPublishAttempt = {
          id: lastAttempt.id,
          hadConflict: !!lastAttempt.had_conflict,
          newVersionId: lastAttempt.new_version_id,
          note: lastAttempt.note,
          createdAt: lastAttempt.created_at,
          conflicts: db
            .prepare('SELECT * FROM publish_conflicts WHERE attempt_id = ? ORDER BY id')
            .all(lastAttempt.id)
            .map((c) => ({
              revisionId: c.revision_id,
              lineId: c.line_id,
              kind: c.kind,
              reason: c.reason,
              baseText: c.base_text,
              currentText: c.current_text,
            })),
        };
      }
    }
    res.json(payload);
  })
);

/**
 * 计算排练中“待确认”的演员 × 角色 × 场次。
 * 规则：
 *   - 只统计当前已派角、且该版本该角色在场次中有台词的条目
 *   - 当前演员无确认记录 => 尚未确认
 *   - 有其他演员的确认记录 => 角色已改派，原演员确认不计入
 *   - 当前演员的 content_hash 与现版本不一致 => 换版后台词文本已变化
 * 换版后仅文本变化的角色×场次需重新确认。
 */
function rehearsalPending(rehearsal, actorIdFilter) {
  const versionId = rehearsal.version_id;
  const cast = db
    .prepare(
      actorIdFilter
        ? `SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ?`
        : `SELECT * FROM rehearsal_cast WHERE rehearsal_id = ?`
    )
    .all(...(actorIdFilter ? [rehearsal.id, actorIdFilter] : [rehearsal.id]));

  const pending = [];
  for (const c of cast) {
    const scenes = db
      .prepare(
        `SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ? ORDER BY scene_id`
      )
      .all(versionId, c.role_id);
    for (const { scene_id } of scenes) {
      const mine = db
        .prepare(
          'SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ? AND scene_id = ? AND actor_id = ?'
        )
        .get(rehearsal.id, c.role_id, scene_id, c.actor_id);
      const others = db
        .prepare(
          'SELECT COUNT(*) AS n FROM confirmations WHERE rehearsal_id = ? AND role_id = ? AND scene_id = ? AND actor_id <> ?'
        )
        .get(rehearsal.id, c.role_id, scene_id, c.actor_id).n;
      const hash = roleSceneHash(versionId, c.role_id, scene_id);
      const done = mine && mine.content_hash === hash;
      if (!done) {
        const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(scene_id);
        const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(c.role_id);
        const actor = db.prepare('SELECT * FROM users WHERE id = ?').get(c.actor_id);
        let reason;
        if (!mine && others > 0) reason = '角色已改派，原演员确认不计入';
        else if (mine) reason = '换版后台词文本已变化，需重新确认';
        else reason = '尚未确认';
        pending.push({
          actorId: c.actor_id,
          actorName: actor?.display_name ?? `#${c.actor_id}`,
          roleId: c.role_id,
          roleName: role?.name ?? `#${c.role_id}`,
          sceneId: scene_id,
          sceneTitle: scene ? `${scene.code} ${scene.title}` : `#${scene_id}`,
          reason,
        });
      }
    }
  }
  return pending;
}

/**
 * 换版事务内共用逻辑（显式换版与凭预演提交完全一致）：
 *   - 仅保留“角色×场次”文本指纹在新旧版本间一致的确认；
 *     文本变化（含角色在该场次不再有台词）的确认删除，相关角色需重新确认；
 *   - 更新排练固定版本并写换版日志；
 *   - 日程：新版本中无台词场次的既有安排标为“待调整”（不计入冲突）；
 *     其余有效时段按新版本重算参与者，与其他未取消时段重叠则抛 409，
 *     整个事务回滚——版本与确认均不改变；
 *   - 时段通知：仍有效的时段按新版本生成新批次（版本变化即实质变化）；
 *     待调整时段的当前批次不再待确认。与同事务提交，换版失败不留批次。
 * 返回被标为待调整的时段 id 列表。
 */
function applyVersionSwitch(r, targetVersionId, actorId) {
  const old = r.version_id;
  const cast = db.prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ?').all(r.id);
  for (const c of cast) {
    const newScenes = new Set(
      db
        .prepare('SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ?')
        .all(targetVersionId, c.role_id)
        .map((x) => x.scene_id)
    );
    const confirmations = db
      .prepare('SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ?')
      .all(r.id, c.role_id);
    for (const conf of confirmations) {
      if (!newScenes.has(conf.scene_id)) {
        db.prepare('DELETE FROM confirmations WHERE id = ?').run(conf.id);
        continue;
      }
      const oldHash = roleSceneHash(old, c.role_id, conf.scene_id);
      const newHash = roleSceneHash(targetVersionId, c.role_id, conf.scene_id);
      // 仅保留与旧版内容一致、且新旧内容未变的确认（文本变化角色须重确）
      if (conf.content_hash !== oldHash || oldHash !== newHash) {
        db.prepare('DELETE FROM confirmations WHERE id = ?').run(conf.id);
      }
    }
  }
  db.prepare('UPDATE rehearsals SET version_id = ? WHERE id = ?').run(targetVersionId, r.id);
  db.prepare(
    'INSERT INTO rehearsal_version_log (rehearsal_id, from_version_id, to_version_id, actor_id) VALUES (?, ?, ?, ?)'
  ).run(r.id, old, targetVersionId, actorId);
  const switchResult = applySchedulesAfterVersionSwitch(r.id, targetVersionId);
  // 替角失效后最终参与者可能变化（原演员回来），按最终名单再同步一次通知批次
  syncScheduleNotifications(r.id, 'version_switch', actorId);
  return {
    needsAdjustmentSchedules: switchResult.needsAdjustmentIds,
    substitutesInvalidated: switchResult.substitutesInvalidated.invalidated,
  };
}

// ---- 显式换版 ----
router.post(
  '/rehearsals/:id/switch-version',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const targetVersionId = Number(req.body?.versionId);
    if (!Number.isInteger(targetVersionId)) throw badRequest('必须显式指定目标版本 versionId');
    getVersionOfPlayOrThrow(targetVersionId, r.play_id);
    if (targetVersionId === r.version_id) throw badRequest('排练当前已固定在该版本');

    let switchInfo = { needsAdjustmentSchedules: [], substitutesInvalidated: [] };
    transaction(() => {
      switchInfo = applyVersionSwitch(r, targetVersionId, req.user.id);
    });

    res.json({
      ok: true,
      rehearsal: serializeRehearsal(getRehearsalOrThrow(r.id)),
      pending: rehearsalPending(getRehearsalOrThrow(r.id), null),
      needsAdjustmentSchedules: switchInfo.needsAdjustmentSchedules,
      substitutesInvalidated: switchInfo.substitutesInvalidated,
    });
  })
);

/**
 * 换版影响预演（纯只读计算，不写库：不改写版本、确认、日程、签到快照或通知）：
 *   - 确认：逐条判定保留还是重做（与正式换版同一套文本指纹规则）；
 *   - 有效日程：继续有效还是转为待调整；
 *   - 参与演员与通知接收人：逐时段列出前后名单与增减；
 *   - 冲突：与其他有效日程、参与演员不可用时段（端点相接不算；已取消与待调整日程不参与）。
 */
function computeSwitchPreview(r, targetVersionId) {
  const old = r.version_id;
  const versionBrief = (id) => {
    const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
    return { id: v.id, versionNo: v.version_no };
  };
  const sceneTitleOf = (sceneId) => {
    const s = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
    return s ? `${s.code} ${s.title}` : `#${sceneId}`;
  };
  const roleNameOf = (roleId) =>
    db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId)?.name ?? `#${roleId}`;
  const actorNameOf = (actorId) =>
    db.prepare('SELECT display_name FROM users WHERE id = ?').get(actorId)?.display_name ?? `#${actorId}`;

  // —— 确认：保留还是重做 ——
  const kept = [];
  const redone = [];
  const cast = db.prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? ORDER BY role_id').all(r.id);
  for (const c of cast) {
    const newScenes = new Set(
      db
        .prepare('SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ?')
        .all(targetVersionId, c.role_id)
        .map((x) => x.scene_id)
    );
    const confirmations = db
      .prepare('SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ? ORDER BY scene_id, actor_id')
      .all(r.id, c.role_id);
    for (const conf of confirmations) {
      const item = {
        actorId: conf.actor_id,
        actorName: actorNameOf(conf.actor_id),
        roleId: c.role_id,
        roleName: roleNameOf(c.role_id),
        sceneId: conf.scene_id,
        sceneTitle: sceneTitleOf(conf.scene_id),
        confirmedAt: conf.confirmed_at,
      };
      if (!newScenes.has(conf.scene_id)) {
        redone.push({ ...item, reason: '新版本中该角色在此场次已无台词，确认将作废并重做' });
        continue;
      }
      const oldHash = roleSceneHash(old, c.role_id, conf.scene_id);
      const newHash = roleSceneHash(targetVersionId, c.role_id, conf.scene_id);
      if (conf.content_hash !== oldHash || oldHash !== newHash) {
        redone.push({ ...item, reason: '换版后台词文本已变化，确认将作废并重做' });
      } else {
        kept.push(item);
      }
    }
  }

  // —— 有效日程：继续有效 / 转待调整；参与演员与通知接收人变化（含临时替角失效后的最终名单）——
  // 预演为只读：按新版本模拟替角存活（角色在新版本该场次仍有台词且原派角未变），不落库。
  const previewSubState = (scheduleRow, sceneId) => {
    const subs = db
      .prepare("SELECT * FROM schedule_substitutes WHERE schedule_id = ? AND status = 'active'")
      .all(scheduleRow.id);
    const invalidated = [];
    const survivingRoleIds = new Set();
    for (const sub of subs) {
      const hasLines = db
        .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND role_id = ? AND scene_id = ? LIMIT 1')
        .get(targetVersionId, sub.role_id, sceneId);
      let reason = null;
      if (!hasLines) reason = 'role_no_lines';
      else {
        const castRow = db
          .prepare('SELECT actor_id FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
          .get(r.id, sub.role_id);
        if (!castRow) reason = 'cast_unassigned';
        else if (castRow.actor_id !== sub.original_actor_id) reason = 'cast_changed';
      }
      if (reason) {
        invalidated.push({
          id: sub.id,
          roleId: sub.role_id,
          roleName: roleNameOf(sub.role_id),
          substituteActorId: sub.substitute_actor_id,
          substituteActorName: actorNameOf(sub.substitute_actor_id),
          reason,
        });
      } else {
        survivingRoleIds.add(sub.role_id);
      }
    }
    return { invalidated, survivingRoleIds };
  };
  const plan = planSchedulesForVersionSwitch(r.id, targetVersionId);
  const actorBrief = (p) => ({ actorId: p.actorId, actorName: p.actorName, roles: p.roles });
  /**
   * 预演专用：给定“存活替角角色集合”，模拟换版后的最终参与者（不落库）。
   * 口径与 participantDetails(...{scheduleId}) 一致：存活替角顶替，其余按常驻派角；未派角角色不计。
   */
  const previewAfterParticipants = (scheduleId, sceneId, survivingRoleIds) => {
    const roleIds = db
      .prepare('SELECT DISTINCT role_id FROM version_lines WHERE version_id = ? AND scene_id = ? ORDER BY role_id')
      .all(targetVersionId, sceneId)
      .map((x) => x.role_id);
    const castRows = db.prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ?').all(r.id);
    const castMap = new Map(castRows.map((c) => [c.role_id, c]));
    const subRows = db
      .prepare("SELECT * FROM schedule_substitutes WHERE schedule_id = ? AND status = 'active'")
      .all(scheduleId);
    const subMap = new Map(subRows.map((s) => [s.role_id, s]));
    const parts = new Map();
    for (const roleId of roleIds) {
      const c = castMap.get(roleId);
      const sub = survivingRoleIds.has(roleId) ? subMap.get(roleId) : null;
      const actorId = sub ? sub.substitute_actor_id : c?.actor_id;
      if (!actorId) continue;
      if (!parts.has(actorId)) {
        parts.set(actorId, { actorId, actorName: actorNameOf(actorId), roles: [] });
      }
      const role = db.prepare('SELECT code, name FROM roles WHERE id = ?').get(roleId);
      parts.get(actorId).roles.push({
        roleId,
        roleCode: role?.code ?? null,
        roleName: role?.name ?? null,
        temporary: !!sub,
        originalActorId: sub ? c.actor_id : null,
        originalActorName: sub ? actorNameOf(c.actor_id) : null,
      });
    }
    return [...parts.values()];
  };
  const currentNotificationOf = (scheduleId) =>
    db.prepare("SELECT * FROM schedule_notifications WHERE schedule_id = ? AND status = 'current'").get(scheduleId);
  const schedules = [];
  for (const s of plan.stillActive) {
    const before = participantDetails(r.id, old, s.scene_id, { scheduleId: s.id }).participants;
    const { invalidated: subInvalidated, survivingRoleIds } = previewSubState(s, s.scene_id);
    const after = previewAfterParticipants(s.id, s.scene_id, survivingRoleIds);
    const beforeIds = new Set(before.map((p) => p.actorId));
    const afterIds = new Set(after.map((p) => p.actorId));
    const current = currentNotificationOf(s.id);
    const recipientIds = current
      ? db.prepare('SELECT actor_id FROM schedule_notification_recipients WHERE notification_id = ?').all(current.id).map((x) => x.actor_id)
      : [];
    schedules.push({
      id: s.id,
      sceneId: s.scene_id,
      sceneTitle: sceneTitleOf(s.scene_id),
      startAt: s.start_at,
      endAt: s.end_at,
      status: 'active',
      afterStatus: 'active',
      participantsBefore: before.map(actorBrief),
      participantsAfter: after.map(actorBrief),
      participantsAdded: after.filter((p) => !beforeIds.has(p.actorId)).map(actorBrief),
      participantsRemoved: before.filter((p) => !afterIds.has(p.actorId)).map(actorBrief),
      substitutesInvalidated: subInvalidated,
      notification: {
        currentSeq: current?.seq ?? null,
        willGenerateBatch: true, // 固定版本变化即实质变化 -> 必生成新批次
        recipientsAdded: after.filter((p) => !recipientIds.includes(p.actorId)).map(actorBrief),
        recipientsRemoved: recipientIds
          .filter((id) => !afterIds.has(id))
          .map((id) => ({ actorId: id, actorName: actorNameOf(id) })),
      },
    });
  }
  for (const s of plan.needsAdjustment) {
    const before = participantDetails(r.id, old, s.scene_id, { scheduleId: s.id }).participants;
    const current = currentNotificationOf(s.id);
    // 整场失去台词：该时段全部生效替角随之失效（恢复有效须重新设置并重新校验）
    const subRows = db
      .prepare("SELECT * FROM schedule_substitutes WHERE schedule_id = ? AND status = 'active'")
      .all(s.id);
    const subInvalidated = subRows.map((sub) => ({
      id: sub.id,
      roleId: sub.role_id,
      roleName: roleNameOf(sub.role_id),
      substituteActorId: sub.substitute_actor_id,
      substituteActorName: actorNameOf(sub.substitute_actor_id),
      reason: 'schedule_pending_adjustment',
    }));
    schedules.push({
      id: s.id,
      sceneId: s.scene_id,
      sceneTitle: sceneTitleOf(s.scene_id),
      startAt: s.start_at,
      endAt: s.end_at,
      status: 'active',
      afterStatus: 'needs_adjustment',
      participantsBefore: before.map(actorBrief),
      participantsAfter: [],
      participantsAdded: [],
      participantsRemoved: before.map(actorBrief),
      substitutesInvalidated: subInvalidated,
      notification: {
        currentSeq: current?.seq ?? null,
        willGenerateBatch: false,
        willBecomeInactive: true, // 转待调整后当前批次失效、不再待确认
        recipientsAdded: [],
        recipientsRemoved: [],
      },
    });
  }

  // —— 冲突：用“替角失效后的最终参与者”重建候选，再与其他有效日程、不可用时段比对 ——
  // （端点相接不算；已取消与待调整不参与；转待调整的时段不进入候选）
  const previewCandidates = [];
  for (const item of schedules.filter((x) => x.afterStatus === 'active')) {
    const sRow = plan.stillActive.find((x) => x.id === item.id);
    previewCandidates.push({
      scheduleId: item.id,
      rehearsalId: r.id,
      rehearsalName: r.name,
      sceneId: item.sceneId,
      startAt: item.startAt,
      endAt: item.endAt,
      startMs: Date.parse(item.startAt),
      endMs: Date.parse(item.endAt),
      actorIds: item.participantsAfter.map((p) => p.actorId),
    });
    void sRow;
  }
  const scheduleConflicts = findScheduleConflicts(previewCandidates);
  const unavailabilityConflicts = findUnavailabilityConflicts(previewCandidates);

  return {
    fromVersion: versionBrief(old),
    toVersion: versionBrief(targetVersionId),
    confirmations: { kept, redone },
    schedules,
    needsAdjustmentSchedules: plan.needsAdjustment.map((s) => s.id),
    substitutesInvalidated: schedules.flatMap((x) =>
      x.substitutesInvalidated.map((item) => ({ scheduleId: x.id, ...item }))
    ),
    conflicts: { schedule: scheduleConflicts, unavailability: unavailabilityConflicts },
    canCommit: scheduleConflicts.length === 0 && unavailabilityConflicts.length === 0,
  };
}

/**
 * 换版预演状态指纹：排练版本、派角、确认、相关日程（全部日程——冲突检测跨排练）
 * 或参与演员的不可用记录任一变化，预演即过期，须重新预演。
 */
function switchPreviewFingerprint(rehearsalId, targetVersionId) {
  const r = db.prepare('SELECT version_id FROM rehearsals WHERE id = ?').get(rehearsalId);
  const cast = db
    .prepare('SELECT role_id, actor_id FROM rehearsal_cast WHERE rehearsal_id = ? ORDER BY role_id')
    .all(rehearsalId);
  const confirmations = db
    .prepare('SELECT id, role_id, actor_id, scene_id, content_hash FROM confirmations WHERE rehearsal_id = ? ORDER BY id')
    .all(rehearsalId);
  const schedules = db
    .prepare('SELECT id, rehearsal_id, scene_id, start_at, end_at, status FROM rehearsal_schedules ORDER BY id')
    .all();
  // 临时替角变化（设置/撤回/失效）同样使预演过期
  const substitutes = db
    .prepare(
      `SELECT id, schedule_id, role_id, original_actor_id, substitute_actor_id, status, invalidated_reason
         FROM schedule_substitutes WHERE rehearsal_id = ? ORDER BY id`
    )
    .all(rehearsalId);
  const actorIds = [
    ...new Set([
      ...cast.map((c) => c.actor_id),
      ...substitutes.map((s) => s.substitute_actor_id),
      ...substitutes.map((s) => s.original_actor_id),
    ]),
  ];
  const unavailability = actorIds.length
    ? db
        .prepare(
          `SELECT id, actor_id, start_at, end_at, reason FROM actor_unavailability
            WHERE actor_id IN (${actorIds.map(() => '?').join(',')}) ORDER BY id`
        )
        .all(...actorIds)
    : [];
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        rehearsalId,
        targetVersionId,
        versionId: r.version_id,
        cast,
        confirmations,
        schedules,
        substitutes,
        unavailability,
      })
    )
    .digest('hex');
}

/** 预演/提交共用的入参校验：导演、目标版本有效且不同于当前固定版本 */
function parseSwitchTarget(req) {
  if (req.user.role !== 'director') throw forbidden();
  const r = getRehearsalOrThrow(req.params.id);
  const targetVersionId = Number(req.body?.versionId);
  if (!Number.isInteger(targetVersionId)) throw badRequest('必须显式指定目标版本 versionId');
  getVersionOfPlayOrThrow(targetVersionId, r.play_id);
  if (targetVersionId === r.version_id) throw badRequest('排练当前已固定在该版本');
  return { r, targetVersionId };
}

// ---- 换版预演（只读：列出确认/日程/参与者与通知接收人变化及冲突，不改写任何数据） ----
router.post(
  '/rehearsals/:id/switch-version/preview',
  wrap((req, res) => {
    const { r, targetVersionId } = parseSwitchTarget(req);
    const preview = computeSwitchPreview(r, targetVersionId);
    res.json({
      ok: true,
      rehearsal: serializeRehearsal(r),
      previewToken: switchPreviewFingerprint(r.id, targetVersionId),
      ...preview,
    });
  })
);

// ---- 凭预演提交换版（预演过期拒绝；存在冲突整次不生效；成功与预演结果一致） ----
router.post(
  '/rehearsals/:id/switch-version/commit',
  wrap((req, res) => {
    const { r, targetVersionId } = parseSwitchTarget(req);
    const previewToken = String(req.body?.previewToken || '');
    if (!previewToken) throw badRequest('必须携带预演令牌 previewToken（请先调用换版预演接口）');

    // 过期校验：预演后排练版本、派角、确认、相关日程或参与演员的不可用记录发生变化 -> 拒绝并提示重新预演
    if (previewToken !== switchPreviewFingerprint(r.id, targetVersionId)) {
      throw conflict(
        'PREVIEW_STALE',
        '预演后排练版本、派角、确认、相关日程或参与演员的不可用记录已发生变化，本次换版未生效，请重新预演'
      );
    }
    // 指纹一致即以当前状态重算预演结果（与预演时相同），并复查冲突：存在冲突整次不生效
    const preview = computeSwitchPreview(r, targetVersionId);
    if (preview.conflicts.schedule.length) {
      throw conflict('SCHEDULE_CONFLICT', '换版后参与演员与其他未取消时段重叠，本次换版未生效', {
        conflicts: preview.conflicts.schedule,
      });
    }
    if (preview.conflicts.unavailability.length) {
      throw conflict('UNAVAILABILITY_CONFLICT', '换版后参与演员与其登记的不可用时段相撞，本次换版未生效', {
        conflicts: preview.conflicts.unavailability,
      });
    }

    let switchInfo = { needsAdjustmentSchedules: [], substitutesInvalidated: [] };
    transaction(() => {
      switchInfo = applyVersionSwitch(r, targetVersionId, req.user.id);
    });

    res.json({
      ok: true,
      rehearsal: serializeRehearsal(getRehearsalOrThrow(r.id)),
      pending: rehearsalPending(getRehearsalOrThrow(r.id), null),
      needsAdjustmentSchedules: switchInfo.needsAdjustmentSchedules,
      substitutesInvalidated: switchInfo.substitutesInvalidated,
      // 与预演一致的结果：确认保留/重做、日程去向、参与演员与通知接收人变化
      preview,
    });
  })
);

// ---- 派角 / 改派 ----
router.post(
  '/rehearsals/:id/cast',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const roleId = Number(req.body?.roleId);
    const actorId = Number(req.body?.actorId);
    if (!Number.isInteger(roleId) || !Number.isInteger(actorId)) throw badRequest('roleId/actorId 必填');
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND play_id = ?').get(roleId, r.play_id);
    if (!role) throw badRequest('角色不存在或不属于该剧');
    const actor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(actorId);
    if (!actor) throw badRequest('演员不存在');

    const result = transaction(() => {
      const existing = db
        .prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
        .get(r.id, roleId);
      let outcome;
      if (existing) {
        if (existing.actor_id === actorId) return { unchanged: true };
        // 改派：保留原演员的历史确认（待确认计算时不再计入），新演员需逐场重新确认
        db.prepare('UPDATE rehearsal_cast SET actor_id = ?, assigned_at = datetime(\'now\') WHERE id = ?').run(
          actorId,
          existing.id
        );
        outcome = { reassigned: true, fromActorId: existing.actor_id };
      } else {
        db.prepare('INSERT INTO rehearsal_cast (rehearsal_id, role_id, actor_id) VALUES (?, ?, ?)').run(
          r.id,
          roleId,
          actorId
        );
        outcome = { created: true };
      }
      // 原派角变化 -> 该角色在本排练各时段的生效替角全部失效（临时替角不改变常驻派角；失效后按最终名单重校验）
      if (outcome.reassigned) {
        outcome.substitutesInvalidated = invalidateSubstitutes({ rehearsalId: r.id, roleId }, 'cast_changed');
      }
      // 派角/改派后：该排练有效时段的参与演员若与其他未取消时段重叠，
      // 抛 409 整次回滚（派角不生效），响应携带冲突演员与时段。
      assertRehearsalSchedulesAfterCastChange(r.id);
      // 派角/改派改变参与演员 -> 同事务生成新通知批次（无实质变化不重复生成）
      syncScheduleNotifications(r.id, 'cast', req.user.id);
      return outcome;
    });
    res.status(result.created ? 201 : 200).json({ ok: true, ...result });
  })
);

router.delete(
  '/rehearsals/:id/cast/:roleId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    transaction(() => {
      // 取消派角：历史确认保留在库中作为痕迹，但已无派角对应，不会再计入待确认
      db.prepare('DELETE FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?').run(
        r.id,
        req.params.roleId
      );
      // 该角色已无常驻派角 -> 其各时段生效替角失效（撤回替角按最终名单重校验冲突/占用）
      invalidateSubstitutes(
        { rehearsalId: r.id, roleId: Number(req.params.roleId) },
        'cast_unassigned'
      );
      // 撤派改变参与演员 -> 同事务生成新通知批次（无实质变化不重复生成）
      syncScheduleNotifications(r.id, 'cast', req.user.id);
    });
    res.json({ ok: true });
  })
);

// ---- 批量派角调整（导演）：一次提交同一排练至少两条派角/撤派，按整批最终派角统一判定 ----
// 入参：{ items: [{ roleId, actorId }] }（actorId 留空表示撤派；兼容裸数组）。
//   - 重复角色、跨剧角色、无效演员、不足两条 -> 400 明确拒绝（先于任何写操作）；
//   - 整批最终派角下重算所有有效时段参与者：与其他有效日程重叠 409 SCHEDULE_CONFLICT、
//     撞本人不可用时段 409 UNAVAILABILITY_CONFLICT（均沿用 details.conflicts，整批不生效；
//     端点相接允许，已取消与待调整时段不参与）；
//   - 成功后只更新变更的派角：原演员历史确认保留但不计入，新演员按逐场确认规则重确，
//     未变派角的确认继续有效；相关时段通知按最终名单仅生成必要新批次；签到快照不变。
router.post(
  '/rehearsals/:id/cast/batch',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);

    // —— 批次级入参校验（先于任何写操作）——
    const items = req.body?.items ?? req.body; // 兼容 {items:[...]} 与裸数组
    if (!Array.isArray(items)) {
      throw badRequest('请求体须为 items 数组（每项含 roleId 与目标 actorId；actorId 留空表示撤派）');
    }
    if (items.length < 2) {
      throw badRequest('批量派角一次至少提交两条派角调整；单条派角请使用 POST /cast，撤派请使用 DELETE /cast/:roleId');
    }

    // —— 逐条解析与校验：重复角色、跨剧角色、无效演员全部 400 明确拒绝 ——
    const seen = new Set();
    const parsed = [];
    items.forEach((item, idx) => {
      const where = `第 ${idx + 1} 条`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw badRequest(`${where}：条目必须是对象`);
      }
      const roleId = Number(item.roleId);
      if (!Number.isInteger(roleId)) throw badRequest(`${where}：roleId 必填且为整数`);
      if (seen.has(roleId)) throw badRequest(`${where}：批次中存在重复角色 #${roleId}`);
      seen.add(roleId);
      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
      if (!role) throw badRequest(`${where}：角色 #${roleId} 不存在`);
      if (role.play_id !== r.play_id) {
        throw badRequest(`${where}：角色「${role.name}」不属于该剧，批量派角仅限本剧角色`);
      }
      // actorId 留空（null/undefined/空串）表示撤派；否则必须指向有效演员
      const rawActor = item.actorId;
      let actorId = null;
      if (rawActor !== null && rawActor !== undefined && rawActor !== '') {
        actorId = Number(rawActor);
        if (!Number.isInteger(actorId)) throw badRequest(`${where}：actorId 必须为整数，或留空表示撤派`);
        const actor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(actorId);
        if (!actor) throw badRequest(`${where}：演员 #${actorId} 不存在或不是演员`);
      }
      parsed.push({ roleId, actorId });
    });

    const result = transaction(() => {
      const results = [];
      const invalidatedSubstitutes = [];
      for (const x of parsed) {
        const existing = db
          .prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
          .get(r.id, x.roleId);
        if (x.actorId == null) {
          // 撤派：历史确认保留在库中作为痕迹，但已无派角对应，不会再计入待确认
          if (existing) {
            db.prepare('DELETE FROM rehearsal_cast WHERE id = ?').run(existing.id);
            results.push({ roleId: x.roleId, action: 'unassigned', fromActorId: existing.actor_id });
            // 该角色已无常驻派角 -> 相关时段替角失效
            invalidatedSubstitutes.push(
              ...invalidateSubstitutes({ rehearsalId: r.id, roleId: x.roleId }, 'cast_unassigned')
            );
          } else {
            results.push({ roleId: x.roleId, action: 'unchanged' }); // 本就未派角，保持不变
          }
        } else if (existing) {
          if (existing.actor_id === x.actorId) {
            results.push({ roleId: x.roleId, action: 'unchanged', actorId: x.actorId });
          } else {
            // 改派：保留原演员的历史确认（待确认计算时不再计入），新演员需逐场重新确认
            db.prepare("UPDATE rehearsal_cast SET actor_id = ?, assigned_at = datetime('now') WHERE id = ?").run(
              x.actorId,
              existing.id
            );
            results.push({ roleId: x.roleId, action: 'reassigned', fromActorId: existing.actor_id, actorId: x.actorId });
            // 原派角变化 -> 该角色在本排练各时段的生效替角失效
            invalidatedSubstitutes.push(
              ...invalidateSubstitutes({ rehearsalId: r.id, roleId: x.roleId }, 'cast_changed')
            );
          }
        } else {
          db.prepare('INSERT INTO rehearsal_cast (rehearsal_id, role_id, actor_id) VALUES (?, ?, ?)').run(
            r.id,
            x.roleId,
            x.actorId
          );
          results.push({ roleId: x.roleId, action: 'assigned', actorId: x.actorId });
        }
      }
      // 按整批最终派角重算所有有效时段参与者（含替角失效后的最终名单）：
      // 与其他有效日程重叠 / 撞本人不可用 -> 抛 409 整批回滚
      assertRehearsalSchedulesAfterCastChange(r.id, {
        schedule: '批量派角后参与演员与其他未取消时段重叠，本次整批派角未生效',
        unavailability: '批量派角后参与演员与其登记的不可用时段相撞，本次整批派角未生效',
      });
      // 相关时段通知按最终名单仅生成必要新批次（无实质变化不生成）；与同事务提交，失败不留批次
      const created = syncScheduleNotifications(r.id, 'batch_cast', req.user.id);
      return { results, created, invalidatedSubstitutes };
    });

    // —— 整批结果：逐条动作 + 当前派角 + 待确认 + 通知摘要 ——
    const actorNameOf = (id) =>
      id == null ? null : db.prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name ?? `#${id}`;
    const roleNameOf = (id) => db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name ?? `#${id}`;
    const results = result.results.map((x) => ({
      roleId: x.roleId,
      roleName: roleNameOf(x.roleId),
      action: x.action, // assigned / reassigned / unassigned / unchanged
      actorId: x.actorId ?? null,
      actorName: actorNameOf(x.actorId),
      fromActorId: x.fromActorId ?? null,
      fromActorName: actorNameOf(x.fromActorId),
    }));
    res.json({
      ok: true,
      results,
      changed: results.filter((x) => x.action !== 'unchanged').length,
      unchanged: results.filter((x) => x.action === 'unchanged').map((x) => x.roleId),
      cast: rehearsalCastList(r.id),
      pending: rehearsalPending(getRehearsalOrThrow(r.id), null),
      notifications: result.created, // [{ scheduleId, notificationId, seq }] 仅含实质变化的时段
      substitutesInvalidated: result.invalidatedSubstitutes,
    });
  })
);

// ---- 演员：排练稿（只看自己所派角色的台词） ----
router.get(
  '/rehearsals/:id/script',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    if (req.user.role !== 'actor') throw forbidden('演员视图仅供演员使用');
    const roleIds = assignedRoleIds(r.id, req.user.id);
    if (roleIds.length === 0) throw forbidden('你没有被分配到该排练的任何角色');

    const placeholders = roleIds.map(() => '?').join(',');
    const lines = db
      .prepare(
        `SELECT vl.*, s.code AS scene_code, s.title AS scene_title, s.seq AS scene_seq,
                ro.code AS role_code, ro.name AS role_name
           FROM version_lines vl
           JOIN scenes s ON s.id = vl.scene_id
           JOIN roles ro ON ro.id = vl.role_id
          WHERE vl.version_id = ? AND vl.role_id IN (${placeholders})
          ORDER BY s.seq, s.id, vl.seq, vl.id`
      )
      .all(r.version_id, ...roleIds);

    // 同时返回每个角色×场次的确认状态
    const status = [];
    for (const roleId of new Set(roleIds)) {
      const scenes = db
        .prepare(
          'SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ? ORDER BY scene_id'
        )
        .all(r.version_id, roleId);
      for (const { scene_id } of scenes) {
        const conf = db
          .prepare(
            'SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ? AND scene_id = ? AND actor_id = ?'
          )
          .get(r.id, roleId, scene_id, req.user.id);
        status.push({
          roleId,
          sceneId: scene_id,
          confirmed: !!(conf && conf.content_hash === roleSceneHash(r.version_id, roleId, scene_id)),
          confirmedAt: conf?.confirmed_at ?? null,
        });
      }
    }

    res.json({
      rehearsal: serializeRehearsal(r),
      lines: lines.map((l) => ({
        lineId: l.line_id,
        sceneId: l.scene_id,
        sceneCode: l.scene_code,
        sceneTitle: l.scene_title,
        sceneSeq: l.scene_seq,
        roleId: l.role_id,
        roleCode: l.role_code,
        roleName: l.role_name,
        seq: l.seq,
        text: l.text,
      })),
      confirmations: status,
    });
  })
);

// ---- 演员：逐场确认 ----
router.post(
  '/rehearsals/:id/confirm',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    if (req.user.role !== 'actor') throw forbidden('只有演员可以确认台词');
    const roleId = Number(req.body?.roleId);
    const sceneId = Number(req.body?.sceneId);
    if (!Number.isInteger(roleId) || !Number.isInteger(sceneId)) throw badRequest('roleId/sceneId 必填');

    // 越权：角色必须是当前演员在该排练中获分配的
    const castRow = db
      .prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
      .get(r.id, roleId);
    if (!castRow || castRow.actor_id !== req.user.id) {
      throw forbidden('你未被分配该角色，不能代为确认');
    }
    // 场次必须属于该剧且该角色在该版本该场次有台词
    const scene = db
      .prepare(
        `SELECT s.* FROM scenes s
           JOIN version_lines vl ON vl.scene_id = s.id AND vl.version_id = ?
          WHERE s.id = ? AND vl.role_id = ? LIMIT 1`
      )
      .get(r.version_id, sceneId, roleId);
    if (!scene) throw badRequest('该版本下此角色在此场次没有台词，无需确认');

    const hash = roleSceneHash(r.version_id, roleId, sceneId);
    transaction(() => {
      db.prepare(
        `INSERT INTO confirmations (rehearsal_id, role_id, actor_id, scene_id, content_hash)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (rehearsal_id, role_id, scene_id, actor_id)
         DO UPDATE SET content_hash = excluded.content_hash,
                       confirmed_at = datetime('now')`
      ).run(r.id, roleId, req.user.id, sceneId, hash);
    });
    res.json({ ok: true, roleId, sceneId, confirmedAt: new Date().toISOString() });
  })
);

module.exports = { router, rehearsalPending };

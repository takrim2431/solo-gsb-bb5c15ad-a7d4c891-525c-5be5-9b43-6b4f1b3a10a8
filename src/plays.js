const express = require('express');
const { db } = require('./db');
const { badRequest, notFound, forbidden, wrap } = require('./errors');
const { authRequired, requireDirector } = require('./auth');

const router = express.Router();
router.use(authRequired);

function getPlayOrThrow(playId) {
  const play = db.prepare('SELECT * FROM plays WHERE id = ?').get(playId);
  if (!play) throw notFound('剧本不存在');
  return play;
}

function latestVersionId(playId) {
  const row = db
    .prepare('SELECT id FROM versions WHERE play_id = ? ORDER BY version_no DESC LIMIT 1')
    .get(playId);
  return row ? row.id : null;
}

/** 版本必须存在且属于该剧；否则明确拒绝 */
function getVersionOfPlayOrThrow(versionId, playId) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!v || v.play_id !== Number(playId)) {
    throw badRequest(`版本 ${versionId} 对该剧本无效`, { versionId });
  }
  return v;
}

function getLineOrThrow(lineId) {
  const line = db.prepare('SELECT * FROM lines WHERE id = ? AND is_deleted = 0').get(lineId);
  if (!line) throw notFound('台词不存在');
  return line;
}

function formatVersion(v) {
  return {
    id: v.id,
    playId: v.play_id,
    versionNo: v.version_no,
    note: v.note,
    baseVersionId: v.base_version_id,
    createdAt: v.created_at,
  };
}

// ---- 剧本（导演） ----
router.post(
  '/plays',
  requireDirector,
  wrap((req, res) => {
    const title = String(req.body?.title || '').trim();
    if (!title) throw badRequest('剧名不能为空');
    const info = db
      .prepare('INSERT INTO plays (title, description, created_by) VALUES (?, ?, ?)')
      .run(title, String(req.body.description || ''), req.user.id);
    res.status(201).json({ id: info.lastInsertRowid, title });
  })
);

router.get(
  '/plays',
  wrap((req, res) => {
    // 导演可见全部；演员只可见自己参与排练的剧本
    if (req.user.role === 'director') {
      const rows = db.prepare('SELECT * FROM plays ORDER BY id').all();
      return res.json({ plays: rows.map(serializePlay) });
    }
    const rows = db
      .prepare(
        `SELECT DISTINCT p.* FROM plays p
           JOIN rehearsals r ON r.play_id = p.id
           JOIN rehearsal_cast c ON c.rehearsal_id = r.id
          WHERE c.actor_id = ? ORDER BY p.id`
      )
      .all(req.user.id);
    res.json({ plays: rows.map(serializePlay) });
  })
);

function serializePlay(p) {
  const vId = latestVersionId(p.id);
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    createdAt: p.created_at,
    latestVersionId: vId,
  };
}

router.get(
  '/plays/:id',
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    let visibleRoleIds = null; // null = 全部可见（导演）
    if (req.user.role === 'actor') {
      const assigned = db
        .prepare(
          `SELECT DISTINCT c.role_id FROM rehearsal_cast c
             JOIN rehearsals r ON r.id = c.rehearsal_id
            WHERE r.play_id = ? AND c.actor_id = ?`
        )
        .all(play.id, req.user.id);
      if (assigned.length === 0) throw forbidden();
      visibleRoleIds = new Set(assigned.map((x) => x.role_id));
    }
    const scenes = db.prepare('SELECT * FROM scenes WHERE play_id = ? ORDER BY seq, id').all(play.id);
    const allRoles = db.prepare('SELECT * FROM roles WHERE play_id = ? ORDER BY id').all(play.id);
    const roles = visibleRoleIds ? allRoles.filter((r) => visibleRoleIds.has(r.id)) : allRoles;
    let lines = db
      .prepare('SELECT * FROM lines WHERE play_id = ? AND is_deleted = 0 ORDER BY scene_id, seq, id')
      .all(play.id);
    if (visibleRoleIds) lines = lines.filter((l) => visibleRoleIds.has(l.role_id));
    res.json({
      play: serializePlay(play),
      scenes: scenes.map((s) => ({ id: s.id, code: s.code, title: s.title, seq: s.seq })),
      roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
      lines: lines.map((l) => ({
        id: l.id,
        sceneId: l.scene_id,
        roleId: l.role_id,
        seq: l.seq,
        text: l.current_text,
      })),
    });
  })
);

// ---- 场次 / 角色（导演；首版发布后仍可新增，给后续 add 修订使用） ----
router.post(
  '/plays/:id/scenes',
  requireDirector,
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    const code = String(req.body?.code || '').trim();
    const title = String(req.body?.title || '').trim();
    if (!code || !title) throw badRequest('场次编号与名称不能为空');
    const seq = Number.isFinite(req.body.seq) ? Math.trunc(req.body.seq) : null;
    const nextSeq =
      seq ??
      (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM scenes WHERE play_id = ?').get(play.id).n);
    try {
      const info = db
        .prepare('INSERT INTO scenes (play_id, code, title, seq) VALUES (?, ?, ?, ?)')
        .run(play.id, code, title, nextSeq);
      res.status(201).json({ id: info.lastInsertRowid, code, title, seq: nextSeq });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw badRequest(`场次 ${code} 已存在`);
      throw e;
    }
  })
);

router.post(
  '/plays/:id/roles',
  requireDirector,
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    const code = String(req.body?.code || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!code || !name) throw badRequest('角色编号与名称不能为空');
    try {
      const info = db
        .prepare('INSERT INTO roles (play_id, code, name) VALUES (?, ?, ?)')
        .run(play.id, code, name);
      res.status(201).json({ id: info.lastInsertRowid, code, name });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw badRequest(`角色 ${code} 已存在`);
      throw e;
    }
  })
);

// ---- 草稿台词：仅首版发布之前可直接增改 ----
function ensureDraftStage(playId) {
  if (latestVersionId(playId)) {
    const e = new Error('剧本已发布首版；现行文本的改动必须通过“修订”提交');
    e.status = 409;
    e.code = 'PUBLISHED_VERSION_EXISTS';
    throw e;
  }
}

router.post(
  '/plays/:id/lines',
  requireDirector,
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    ensureDraftStage(play.id);
    const { sceneId, roleId } = req.body || {};
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw badRequest('台词内容不能为空');
    const scene = db.prepare('SELECT * FROM scenes WHERE id = ? AND play_id = ?').get(sceneId, play.id);
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND play_id = ?').get(roleId, play.id);
    if (!scene) throw badRequest('场次不存在或不属于该剧本');
    if (!role) throw badRequest('角色不存在或不属于该剧本');
    const seq = Number.isFinite(req.body.seq)
      ? Math.trunc(req.body.seq)
      : db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM lines WHERE scene_id = ? AND is_deleted = 0')
          .get(sceneId).n;
    const info = db
      .prepare('INSERT INTO lines (play_id, scene_id, role_id, seq, current_text) VALUES (?, ?, ?, ?, ?)')
      .run(play.id, sceneId, roleId, seq, text);
    res.status(201).json({ id: info.lastInsertRowid, sceneId, roleId, seq, text });
  })
);

router.patch(
  '/lines/:lineId',
  requireDirector,
  wrap((req, res) => {
    const line = getLineOrThrow(req.params.lineId);
    ensureDraftStage(line.play_id);
    const text = req.body?.text !== undefined ? String(req.body.text).trim() : line.current_text;
    if (!text) throw badRequest('台词内容不能为空');
    const seq = Number.isFinite(req.body.seq) ? Math.trunc(req.body.seq) : line.seq;
    db.prepare('UPDATE lines SET current_text = ?, seq = ? WHERE id = ?').run(text, seq, line.id);
    res.json({ id: line.id, seq, text });
  })
);

router.delete(
  '/lines/:lineId',
  requireDirector,
  wrap((req, res) => {
    const line = getLineOrThrow(req.params.lineId);
    ensureDraftStage(line.play_id);
    db.prepare('DELETE FROM lines WHERE id = ?').run(line.id); // 尚无版本快照引用
    res.json({ ok: true });
  })
);

// ---- 首版发布 ----
router.post(
  '/plays/:id/publish-initial',
  requireDirector,
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    if (latestVersionId(play.id)) throw badRequest('首版已存在，请改用修订发布');
    const lines = db
      .prepare('SELECT * FROM lines WHERE play_id = ? AND is_deleted = 0')
      .all(play.id);
    if (lines.length === 0) throw badRequest('还没有任何台词，无法发布首版');

    const note = String(req.body?.note || '首版');
    const result = require('./db').transaction(() => {
      const v = db
        .prepare('INSERT INTO versions (play_id, version_no, note, base_version_id, created_by) VALUES (?, 1, ?, NULL, ?)')
        .run(play.id, note, req.user.id);
      const versionId = v.lastInsertRowid;
      const ins = db.prepare(
        'INSERT INTO version_lines (version_id, line_id, scene_id, role_id, seq, text) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const l of lines) ins.run(versionId, l.id, l.scene_id, l.role_id, l.seq, l.current_text);
      return versionId;
    });
    res.status(201).json({ version: formatVersion(db.prepare('SELECT * FROM versions WHERE id = ?').get(result)) });
  })
);

// ---- 版本 ----
router.get(
  '/plays/:id/versions',
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    if (req.user.role === 'actor') {
      const assigned = db
        .prepare(
          `SELECT 1 FROM rehearsal_cast c JOIN rehearsals r ON r.id = c.rehearsal_id
            WHERE r.play_id = ? AND c.actor_id = ? LIMIT 1`
        )
        .get(play.id, req.user.id);
      if (!assigned) throw forbidden();
    }
    const versions = db
      .prepare('SELECT * FROM versions WHERE play_id = ? ORDER BY version_no')
      .all(play.id);
    res.json({ versions: versions.map(formatVersion) });
  })
);

router.get(
  '/versions/:versionId',
  wrap((req, res) => {
    const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.params.versionId);
    if (!v) throw notFound('版本不存在');
    let visibleRoleIds = null;
    if (req.user.role === 'actor') {
      const assigned = db
        .prepare(
          `SELECT DISTINCT c.role_id FROM rehearsal_cast c
             JOIN rehearsals r ON r.id = c.rehearsal_id
            WHERE r.play_id = ? AND c.actor_id = ?`
        )
        .all(v.play_id, req.user.id);
      if (assigned.length === 0) throw forbidden();
      visibleRoleIds = new Set(assigned.map((x) => x.role_id));
    }
    let lines = db
      .prepare(
        `SELECT vl.*, s.code AS scene_code, s.title AS scene_title, s.seq AS scene_seq,
                r.code AS role_code, r.name AS role_name
           FROM version_lines vl
           JOIN scenes s ON s.id = vl.scene_id
           JOIN roles r ON r.id = vl.role_id
          WHERE vl.version_id = ? ORDER BY s.seq, s.id, vl.seq, vl.id`
      )
      .all(v.id);
    if (visibleRoleIds) lines = lines.filter((l) => visibleRoleIds.has(l.role_id));
    res.json({
      version: formatVersion(v),
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
    });
  })
);

module.exports = { router, getPlayOrThrow, latestVersionId, getVersionOfPlayOrThrow, formatVersion };

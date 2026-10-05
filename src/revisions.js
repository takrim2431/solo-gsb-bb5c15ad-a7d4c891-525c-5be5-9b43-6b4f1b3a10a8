const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired, requireDirector, publicUser } = require('./auth');
const { getPlayOrThrow, latestVersionId, getVersionOfPlayOrThrow, formatVersion } = require('./plays');

const router = express.Router();
router.use(authRequired);
// 修订与发布都是导演操作；注意不能用 router.use 直接挂 requireDirector，
// 否则未匹配本 router 的请求（如演员访问 /rehearsals/...）穿过时也会被误拦截。
const DIRECTOR_PREFIXES = [/^\/plays\/\d+\/revisions/, /^\/plays\/\d+\/publish/, /^\/revisions\//, /^\/revision-items\//];
router.use((req, res, next) => {
  if (DIRECTOR_PREFIXES.some((re) => re.test(req.path))) return requireDirector(req, res, next);
  next();
});

function getRevisionOrThrow(id) {
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ?').get(id);
  if (!rev) throw notFound('修订不存在');
  return rev;
}

function serializeItem(item) {
  return {
    id: item.id,
    revisionId: item.revision_id,
    action: item.action,
    lineId: item.line_id,
    sceneId: item.scene_id,
    roleId: item.role_id,
    seq: item.seq,
    oldText: item.old_text,
    newText: item.new_text,
  };
}

function serializeRevision(rev) {
  const base = db.prepare('SELECT * FROM versions WHERE id = ?').get(rev.base_version_id);
  const items = db.prepare('SELECT * FROM revision_items WHERE revision_id = ? ORDER BY id').all(rev.id);
  const author = rev.created_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(rev.created_by) : null;
  return {
    id: rev.id,
    playId: rev.play_id,
    title: rev.title,
    status: rev.status,
    baseVersion: base ? formatVersion(base) : null,
    mergedVersionId: rev.merged_version_id,
    mergedAt: rev.merged_at,
    createdAt: rev.created_at,
    createdBy: author ? publicUser(author) : null,
    items: items.map(serializeItem),
  };
}

/** 提交时即校验：原文必须与基准版本逐字一致，否则不允许提交 */
function assertItemAgainstBase(rev, body) {
  const action = body.action;
  if (!['modify', 'add', 'delete'].includes(action)) throw badRequest('action 必须是 modify/add/delete');

  if (action === 'add') {
    const scene = db
      .prepare('SELECT * FROM scenes WHERE id = ? AND play_id = ?')
      .get(body.sceneId, rev.play_id);
    const role = db
      .prepare('SELECT * FROM roles WHERE id = ? AND play_id = ?')
      .get(body.roleId, rev.play_id);
    if (!scene) throw badRequest('add 必须指定本剧中有效的 sceneId');
    if (!role) throw badRequest('add 必须指定本剧中有效的 roleId');
    const text = String(body.newText ?? '').trim();
    if (!text) throw badRequest('add 的 newText 不能为空');
    return {
      action,
      line_id: null,
      scene_id: scene.id,
      role_id: role.id,
      seq: body.seq == null ? null : Math.trunc(body.seq),
      old_text: '',
      new_text: text,
    };
  }

  // modify / delete：必须标明被改台词的原文
  const line = db.prepare('SELECT * FROM lines WHERE id = ? AND play_id = ?').get(body.lineId, rev.play_id);
  if (!line) throw badRequest('lineId 不存在或不属于该剧');
  const baseRow = db
    .prepare('SELECT text FROM version_lines WHERE version_id = ? AND line_id = ?')
    .get(rev.base_version_id, line.id);
  if (!baseRow) {
    throw badRequest(`台词 ${line.id} 不存在于基准版本中（可能在该版本里尚未新增或已删除）`);
  }
  const oldText = String(body.oldText ?? '');
  if (oldText !== baseRow.text) {
    throw conflict(
      'OLD_TEXT_MISMATCH',
      `提交的原文与基准版本 v${
        db.prepare('SELECT version_no FROM versions WHERE id = ?').get(rev.base_version_id).version_no
      } 不一致，修订必须以已发布原文为基准`,
      { lineId: line.id, submitted: oldText, baseText: baseRow.text }
    );
  }

  if (action === 'modify') {
    const newText = String(body.newText ?? '').trim();
    if (!newText) throw badRequest('modify 的 newText 不能为空');
    if (newText === baseRow.text) throw badRequest('新文与原文相同，没有实际改动');
    return {
      action,
      line_id: line.id,
      scene_id: null,
      role_id: null,
      seq: null,
      old_text: oldText,
      new_text: newText,
    };
  }
  // delete：以基准原文为据
  return {
    action,
    line_id: line.id,
    scene_id: null,
    role_id: null,
    seq: null,
    old_text: oldText,
    new_text: '',
  };
}

// ---- 修订 CRUD ----
router.post(
  '/plays/:id/revisions',
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    const baseVersionId = req.body?.baseVersionId != null
      ? Number(req.body.baseVersionId)
      : latestVersionId(play.id);
    if (!baseVersionId) throw badRequest('剧本尚未发布任何版本，无法以版本为基准提交修订');
    getVersionOfPlayOrThrow(baseVersionId, play.id);
    const title = String(req.body?.title || '').trim() || '未命名修订';

    const revId = transaction(() => {
      const info = db
        .prepare('INSERT INTO revisions (play_id, base_version_id, title, created_by) VALUES (?, ?, ?, ?)')
        .run(play.id, baseVersionId, title, req.user.id);
      return info.lastInsertRowid;
    });
    const rev = getRevisionOrThrow(revId);

    // 可随创建一次性带上条目
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    for (const it of items) {
      const row = assertItemAgainstBase(rev, it);
      insertItem(rev.id, row);
    }
    res.status(201).json(serializeRevision(getRevisionOrThrow(revId)));
  })
);

function insertItem(revisionId, row) {
  try {
    db.prepare(
      `INSERT INTO revision_items (revision_id, action, line_id, scene_id, role_id, seq, old_text, new_text)
       VALUES (@revision_id, @action, @line_id, @scene_id, @role_id, @seq, @old_text, @new_text)`
    ).run({ revision_id: revisionId, ...row });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw badRequest('同一修订中不能重复修改同一条台词');
    }
    throw e;
  }
}

router.get(
  '/plays/:id/revisions',
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    const status = req.query.status;
    let rows;
    if (status) {
      rows = db.prepare('SELECT * FROM revisions WHERE play_id = ? AND status = ? ORDER BY id DESC').all(play.id, status);
    } else {
      rows = db.prepare('SELECT * FROM revisions WHERE play_id = ? ORDER BY id DESC').all(play.id);
    }
    res.json({ revisions: rows.map(serializeRevision) });
  })
);

router.get(
  '/revisions/:revId',
  wrap((req, res) => {
    const rev = getRevisionOrThrow(req.params.revId);
    res.json(serializeRevision(rev));
  })
);

router.post(
  '/revisions/:revId/items',
  wrap((req, res) => {
    const rev = getRevisionOrThrow(req.params.revId);
    if (rev.status !== 'open') throw badRequest('只有进行中的修订才能添加条目');
    const row = assertItemAgainstBase(rev, req.body || {});
    insertItem(rev.id, row);
    res.status(201).json(serializeRevision(getRevisionOrThrow(rev.id)));
  })
);

router.delete(
  '/revision-items/:itemId',
  wrap((req, res) => {
    const item = db.prepare('SELECT * FROM revision_items WHERE id = ?').get(req.params.itemId);
    if (!item) throw notFound('修订条目不存在');
    const rev = getRevisionOrThrow(item.revision_id);
    if (rev.status !== 'open') throw badRequest('只有进行中的修订才能删除条目');
    db.prepare('DELETE FROM revision_items WHERE id = ?').run(item.id);
    res.json({ ok: true });
  })
);

router.post(
  '/revisions/:revId/abandon',
  wrap((req, res) => {
    const rev = getRevisionOrThrow(req.params.revId);
    if (rev.status !== 'open') throw badRequest('只有进行中的修订才能作废');
    db.prepare("UPDATE revisions SET status = 'abandoned' WHERE id = ?").run(rev.id);
    res.json(serializeRevision(getRevisionOrThrow(rev.id)));
  })
);

// ================= 发布：逐条核对现行文本 =================
router.post(
  '/plays/:id/publish',
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    const revIds = Array.isArray(req.body?.revisionIds)
      ? req.body.revisionIds.map(Number).filter(Number.isInteger)
      : [];
    if (revIds.length === 0) throw badRequest('请至少选择一个修订');

    const revisions = revIds.map((id) => {
      const rev = getRevisionOrThrow(id);
      if (rev.play_id !== play.id) throw badRequest(`修订 ${id} 不属于该剧`);
      if (rev.status !== 'open') throw badRequest(`修订 ${id} 已不是进行中状态（${rev.status}）`);
      return rev;
    });

    const note = String(req.body?.note || '').trim();
    const latestId = latestVersionId(play.id);

    const outcome = transaction(() => {
      // 以最新已发布版本为底（所有修订基准必须是已发布版本；允许基于旧版提交）
      const conflicts = [];
      // publishedText：最新已发布版本快照，事务内不变，用于逐条核对“原文 vs 现行文本”
      const publishedText = new Map(); // lineId -> text
      // 模拟合并：lineId -> 将生效文本（合入本批次通过的改动后）
      const mergedText = new Map(); // lineId -> text
      const deletedLines = new Set();
      // 本批次已触碰过的行：{ revisionId, action, new_text }，用于互斥检查
      const batchTouched = new Map();

      const snapshotRows = db
        .prepare('SELECT * FROM version_lines WHERE version_id = ? ORDER BY id')
        .all(latestId);
      for (const row of snapshotRows) {
        publishedText.set(row.line_id, row.text);
        mergedText.set(row.line_id, row.text);
      }

      const registerConflict = (rev, item, kind, reason, baseText, currentText) => {
        conflicts.push({
          revisionId: rev.id,
          revisionItemId: item.id,
          lineId: item.line_id,
          kind,
          reason,
          baseText,
          currentText,
        });
      };

      for (const rev of revisions) {
        const items = db.prepare('SELECT * FROM revision_items WHERE revision_id = ? ORDER BY id').all(rev.id);
        for (const item of items) {
          if (item.action === 'add') {
            // 新增不与既有条目冲突，直接排队
            continue;
          }
          // 第一步：核对“修订声称的原文”与“现行（最新已发布）文本”
          if (!publishedText.has(item.line_id)) {
            // 现行快照里没有 = 已在此前的发布中删除
            registerConflict(rev, item, 'line_deleted', '该台词已在现行版本中被删除', item.old_text, '');
            continue;
          }
          const currentText = publishedText.get(item.line_id);
          if (currentText !== item.old_text) {
            registerConflict(
              rev,
              item,
              'text_changed',
              '原文已变化（其他修订或新版已改动该台词），本条修订需要重新基于现行文本提交',
              item.old_text,
              currentText
            );
            continue;
          }

          // 第二步：与本批次其他修订的互斥检查（所有条目以同一份现行文本为基准，与顺序无关）
          const prev = batchTouched.get(item.line_id);
          if (prev) {
            const sameIntent =
              prev.action === item.action &&
              (item.action === 'delete' || prev.new_text === item.new_text);
            if (sameIntent) {
              // 完全相同的改动，幂等合入，不算冲突
              continue;
            }
            registerConflict(
              rev,
              item,
              'batch_cross_edit',
              `本批次中修订 ${prev.revisionId} 也改动了该台词且内容不同，需导演决定保留哪一版`,
              item.old_text,
              prev.action === 'delete' ? '（另一修订将删除该台词）' : prev.new_text
            );
            continue;
          }

          // 应用到模拟合并结果
          if (item.action === 'delete') {
            mergedText.delete(item.line_id);
            deletedLines.add(item.line_id);
          } else {
            mergedText.set(item.line_id, item.new_text);
          }
          batchTouched.set(item.line_id, { revisionId: rev.id, action: item.action, new_text: item.new_text });
        }
      }

      // add 条目之间、以及与既有行之间都允许合并（顺序靠 seq/id 稳定排列）
      const addedItems = [];
      for (const rev of revisions) {
        const adds = db
          .prepare("SELECT * FROM revision_items WHERE revision_id = ? AND action = 'add'")
          .all(rev.id);
        addedItems.push(...adds.map((a) => ({ ...a, revisionId: rev.id })));
      }

      // 无论是否冲突，都记录本次发布尝试；冲突时不生成版本、不改任何业务数据
      const attempt = db
        .prepare(
          `INSERT INTO publish_attempts (play_id, new_version_id, had_conflict, note, revision_ids, created_by)
           VALUES (?, NULL, ?, ?, ?, ?)`
        )
        .run(play.id, conflicts.length > 0 ? 1 : 0, note, JSON.stringify(revIds), req.user.id);
      if (conflicts.length > 0) {
        const ins = db.prepare(
          `INSERT INTO publish_conflicts
             (attempt_id, revision_id, revision_item_id, line_id, kind, reason, base_text, current_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const c of conflicts) {
          ins.run(attempt.lastInsertRowid, c.revisionId, c.revisionItemId, c.lineId, c.kind, c.reason, c.baseText, c.currentText);
        }
        return { conflict: true, attemptId: attempt.lastInsertRowid, conflicts };
      }

      // 无冲突：生成新版本（不可改写的快照）
      const nextNo = db
        .prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM versions WHERE play_id = ?')
        .get(play.id).n;
      const vInfo = db
        .prepare(
          'INSERT INTO versions (play_id, version_no, note, base_version_id, created_by) VALUES (?, ?, ?, ?, ?)'
        )
        .run(play.id, nextNo, note || `v${nextNo}`, latestId, req.user.id);
      const newVersionId = vInfo.lastInsertRowid;

      const insVL = db.prepare(
        'INSERT INTO version_lines (version_id, line_id, scene_id, role_id, seq, text) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const row of snapshotRows) {
        if (!mergedText.has(row.line_id)) continue; // 被删除
        insVL.run(newVersionId, row.line_id, row.scene_id, row.role_id, row.seq, mergedText.get(row.line_id));
      }
      // 新增行：写入 lines 身份表，再进入快照
      const insLine = db.prepare(
        'INSERT INTO lines (play_id, scene_id, role_id, seq, current_text) VALUES (?, ?, ?, ?, ?)'
      );
      // 每个场景内给出稳定顺序
      const seqCursor = new Map();
      for (const a of addedItems) {
        let seq = a.seq;
        if (seq == null) {
          if (!seqCursor.has(a.scene_id)) {
            seqCursor.set(
              a.scene_id,
              db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM lines WHERE scene_id = ?').get(a.scene_id).m
            );
          }
          const next = seqCursor.get(a.scene_id) + 1;
          seqCursor.set(a.scene_id, next);
          seq = next;
        }
        const lineInfo = insLine.run(play.id, a.scene_id, a.role_id, seq, a.new_text);
        insVL.run(newVersionId, lineInfo.lastInsertRowid, a.scene_id, a.role_id, seq, a.new_text);
      }

      // 更新现行文本（供下一次发布核对）
      const upd = db.prepare('UPDATE lines SET current_text = ?, is_deleted = 0 WHERE id = ?');
      for (const [lineId, text] of mergedText) upd.run(text, lineId);
      const markDel = db.prepare('UPDATE lines SET is_deleted = 1 WHERE id = ?');
      for (const lineId of deletedLines) markDel.run(lineId);

      // 标记合入的修订
      const mark = db.prepare(
        "UPDATE revisions SET status = 'merged', merged_version_id = ?, merged_at = datetime('now') WHERE id = ?"
      );
      for (const rev of revisions) mark.run(newVersionId, rev.id);

      db.prepare('UPDATE publish_attempts SET new_version_id = ? WHERE id = ?').run(
        newVersionId,
        attempt.lastInsertRowid
      );
      return {
        conflict: false,
        attemptId: attempt.lastInsertRowid,
        newVersionId,
        mergedRevisionIds: revIds,
      };
    });

    if (outcome.conflict) {
      return res.status(409).json({
        error: 'PUBLISH_CONFLICT',
        message: '存在冲突条目，本次发布不生效；互不冲突的修订可调整后再次发布',
        attemptId: outcome.attemptId,
        conflicts: outcome.conflicts,
      });
    }
    res.status(201).json({
      ok: true,
      attemptId: outcome.attemptId,
      newVersion: formatVersion(db.prepare('SELECT * FROM versions WHERE id = ?').get(outcome.newVersionId)),
      mergedRevisionIds: outcome.mergedRevisionIds,
    });
  })
);

// 发布尝试与冲突详情
router.get(
  '/plays/:id/publish-attempts',
  wrap((req, res) => {
    const play = getPlayOrThrow(req.params.id);
    const attempts = db
      .prepare('SELECT * FROM publish_attempts WHERE play_id = ? ORDER BY id DESC')
      .all(play.id);
    const result = attempts.map((a) => ({
      id: a.id,
      newVersionId: a.new_version_id,
      hadConflict: !!a.had_conflict,
      note: a.note,
      revisionIds: JSON.parse(a.revision_ids),
      createdAt: a.created_at,
      conflicts: db
        .prepare('SELECT * FROM publish_conflicts WHERE attempt_id = ? ORDER BY id')
        .all(a.id)
        .map((c) => ({
          id: c.id,
          revisionId: c.revision_id,
          revisionItemId: c.revision_item_id,
          lineId: c.line_id,
          kind: c.kind,
          reason: c.reason,
          baseText: c.base_text,
          currentText: c.current_text,
        })),
    }));
    res.json({ attempts: result });
  })
);

module.exports = { router };

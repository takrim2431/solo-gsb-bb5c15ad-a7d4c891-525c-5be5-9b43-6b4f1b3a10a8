const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

/**
 * 轻量结构迁移：PRAGMA user_version 单调递增。
 * v1 -> v2：confirmations 唯一键加入 actor_id（改派保留历史确认）。
 */
function migrate() {
  const from = db.pragma('user_version', { simple: true });
  if (from < 2) {
    // 旧唯一索引覆盖 3 列（rehearsal_id, role_id, scene_id）；新版为 4 列（含 actor_id）
    const indexes = db.prepare("PRAGMA index_list('confirmations')").all();
    let legacy = false;
    for (const ix of indexes) {
      if (ix.unique !== 1) continue;
      const info = db.prepare(`PRAGMA index_info('${ix.name}')`).all();
      if (info.length === 3) legacy = true;
    }
    if (legacy) {
      // 迁移期临时关闭外键：结构搬运，避免依赖其他表已就绪
      db.pragma('foreign_keys = OFF');
      db.exec('BEGIN');
      db.exec('ALTER TABLE confirmations RENAME TO confirmations_old');
      db.exec(
        `CREATE TABLE confirmations (
          id            INTEGER PRIMARY KEY,
          rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
          role_id       INTEGER NOT NULL REFERENCES roles(id),
          actor_id      INTEGER NOT NULL REFERENCES users(id),
          scene_id      INTEGER NOT NULL REFERENCES scenes(id),
          content_hash  TEXT NOT NULL,
          confirmed_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (rehearsal_id, role_id, scene_id, actor_id)
        )`
      );
      db.exec(
        `INSERT INTO confirmations
           (id, rehearsal_id, role_id, actor_id, scene_id, content_hash, confirmed_at)
         SELECT id, rehearsal_id, role_id, actor_id, scene_id, content_hash, confirmed_at
           FROM confirmations_old`
      );
      db.exec('DROP TABLE confirmations_old');
      db.exec('COMMIT');
      db.pragma('foreign_keys = ON');
    }
    db.pragma('user_version = 2');
  }
}
migrate();

/**
 * 在事务中执行 fn；fn 抛错则整体回滚。
 * better-sqlite3 的事务是同步的，直接包装即可。
 */
function transaction(fn) {
  return db.transaction(fn)();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 某版本中“角色 × 场次”台词文本的指纹：用于换版后判定是否必须重新确认 */
function roleSceneHash(versionId, roleId, sceneId) {
  const rows = db
    .prepare(
      `SELECT seq, text FROM version_lines
        WHERE version_id = ? AND role_id = ? AND scene_id = ?
        ORDER BY seq, id`
    )
    .all(versionId, roleId, sceneId);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

module.exports = { db, transaction, hashPassword, verifyPassword, roleSceneHash, DB_PATH };

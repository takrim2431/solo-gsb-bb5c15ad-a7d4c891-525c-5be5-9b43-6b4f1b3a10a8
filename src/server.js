const path = require('path');
const express = require('express');
const { DB_PATH } = require('./db');
const { seed } = require('./seed');
const { ApiError } = require('./errors');
const { router: authRouter, authRequired } = require('./auth');
const { router: playsRouter } = require('./plays');
const { router: revisionsRouter } = require('./revisions');
const { router: rehearsalsRouter, rehearsalPending } = require('./rehearsals');
const { router: schedulesRouter } = require('./schedules');
const { router: attendanceRouter } = require('./attendance');
const { router: unavailabilityRouter } = require('./unavailability');
const { router: notificationsRouter } = require('./notifications');
const { router: propsRouter } = require('./props');
const { db } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json());

// 极简 cookie 解析（只取 session，避免引入额外依赖）
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) req.cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', authRouter);
app.use('/api', playsRouter);
app.use('/api', revisionsRouter);
app.use('/api', rehearsalsRouter);
app.use('/api', schedulesRouter);
app.use('/api', attendanceRouter);
app.use('/api', unavailabilityRouter);
app.use('/api', notificationsRouter);
app.use('/api', propsRouter);

// 演员名册（仅导演）
app.get(
  '/api/actors',
  authRequired,
  (req, res, next) => {
    try {
      if (req.user.role !== 'director') {
        return res.status(403).json({ error: 'FORBIDDEN', message: '仅导演可查看演员名册' });
      }
      const actors = db
        .prepare("SELECT id, username, display_name FROM users WHERE role = 'actor' ORDER BY id")
        .all();
      res.json({
        actors: actors.map((a) => ({ id: a.id, username: a.username, displayName: a.display_name })),
      });
    } catch (e) {
      next(e);
    }
  }
);

// 导演首页统计：所有排练待确认与最近冲突
app.get(
  '/api/dashboard',
  authRequired,
  (req, res, next) => {
    try {
      if (req.user.role !== 'director') {
        return res.status(403).json({ error: 'FORBIDDEN', message: '仅导演可访问' });
      }
      const rehearsals = db.prepare('SELECT * FROM rehearsals ORDER BY id').all();
      const data = rehearsals.map((r) => ({
        rehearsal: {
          id: r.id,
          name: r.name,
          versionId: r.version_id,
        },
        pending: rehearsalPending(r, null),
      }));

      const conflicts = db
        .prepare(
          `SELECT pa.*, p.title AS play_title FROM publish_attempts pa
             JOIN plays p ON p.id = pa.play_id
            WHERE pa.had_conflict = 1 ORDER BY pa.id DESC LIMIT 20`
        )
        .all();
      res.json({
        rehearsals: data,
        recentConflicts: conflicts.map((c) => ({
          id: c.id,
          playId: c.play_id,
          playTitle: c.play_title,
          note: c.note,
          createdAt: c.created_at,
          details: db
            .prepare('SELECT * FROM publish_conflicts WHERE attempt_id = ? ORDER BY id')
            .all(c.id)
            .map((x) => ({
              revisionId: x.revision_id,
              lineId: x.line_id,
              kind: x.kind,
              reason: x.reason,
              baseText: x.base_text,
              currentText: x.current_text,
            })),
        })),
      });
    } catch (e) {
      next(e);
    }
  }
);

app.use(express.static(path.join(__dirname, '..', 'public')));

// 兜底：未匹配的 /api 返回 JSON 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `接口 ${req.method} ${req.originalUrl} 不存在` });
});

// 全局错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'BAD_JSON', message: '请求体不是合法 JSON' });
  }
  const status = err.status || 500;
  if (status >= 400 && process.env.DEBUG_ERR) console.error(err.stack);
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.code || 'INTERNAL_ERROR',
    message: err.message || '服务器内部错误',
    details: err.details,
  });
});

const seeded = seed();
const server = app.listen(PORT, HOST, () => {
  console.log(`排练台词应用已启动: http://${HOST}:${PORT}`);
  console.log(`数据库: ${DB_PATH}${seeded ? '（已初始化演示数据）' : ''}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));

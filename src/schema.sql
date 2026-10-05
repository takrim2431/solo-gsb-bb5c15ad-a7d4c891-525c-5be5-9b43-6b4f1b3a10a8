-- 剧团排练台词应用 数据库结构
-- 约定：
--   * versions / version_lines 为只增不改的发布快照（由触发器强制）
--   * lines.current_text 始终等于“最新已发布版本”中的文本；首版发布前是导演草稿
--   * 发布后的文本变动一律走 revisions / revision_items
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('director', 'actor')),
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS scenes (
  id      INTEGER PRIMARY KEY,
  play_id INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  code    TEXT NOT NULL,
  title   TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  UNIQUE (play_id, code)
);

CREATE TABLE IF NOT EXISTS roles (
  id      INTEGER PRIMARY KEY,
  play_id INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  code    TEXT NOT NULL,
  name    TEXT NOT NULL,
  UNIQUE (play_id, code)
);

-- 现行台词（身份稳定，跨版本用同一 id）
CREATE TABLE IF NOT EXISTS lines (
  id           INTEGER PRIMARY KEY,
  play_id      INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  scene_id     INTEGER NOT NULL REFERENCES scenes(id),
  role_id      INTEGER NOT NULL REFERENCES roles(id),
  seq          INTEGER NOT NULL,
  current_text TEXT NOT NULL,
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lines_play ON lines(play_id);

-- 已发布版本（不可改写）
CREATE TABLE IF NOT EXISTS versions (
  id              INTEGER PRIMARY KEY,
  play_id         INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  version_no      INTEGER NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  base_version_id INTEGER REFERENCES versions(id),
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (play_id, version_no)
);

-- 版本快照：每个版本包含的全部台词（删除的台词不出现在快照中）
CREATE TABLE IF NOT EXISTS version_lines (
  id        INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  line_id   INTEGER NOT NULL,
  scene_id  INTEGER NOT NULL,
  role_id   INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  text      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vl_version ON version_lines(version_id);
CREATE INDEX IF NOT EXISTS idx_vl_line ON version_lines(line_id);

-- 触发器：发布版本及其快照严禁 UPDATE / DELETE
CREATE TRIGGER IF NOT EXISTS trg_versions_no_update
BEFORE UPDATE ON versions
BEGIN
  SELECT RAISE(ABORT, '已发布版本不可改写');
END;
CREATE TRIGGER IF NOT EXISTS trg_versions_no_delete
BEFORE DELETE ON versions
BEGIN
  SELECT RAISE(ABORT, '已发布版本不可删除');
END;
CREATE TRIGGER IF NOT EXISTS trg_version_lines_no_update
BEFORE UPDATE ON version_lines
BEGIN
  SELECT RAISE(ABORT, '已发布版本快照不可改写');
END;
CREATE TRIGGER IF NOT EXISTS trg_version_lines_no_delete
BEFORE DELETE ON version_lines
BEGIN
  SELECT RAISE(ABORT, '已发布版本快照不可删除');
END;

CREATE TABLE IF NOT EXISTS revisions (
  id                 INTEGER PRIMARY KEY,
  play_id            INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  base_version_id    INTEGER NOT NULL REFERENCES versions(id),
  title              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'merged', 'abandoned')),
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  merged_version_id  INTEGER REFERENCES versions(id),
  merged_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisions_play ON revisions(play_id);

CREATE TABLE IF NOT EXISTS revision_items (
  id          INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('modify', 'add', 'delete')),
  line_id     INTEGER REFERENCES lines(id),            -- modify/delete 指向既有台词；add 为空
  scene_id    INTEGER REFERENCES scenes(id),           -- add 时必填
  role_id     INTEGER REFERENCES roles(id),            -- add 时必填
  seq         INTEGER,                                  -- add 可选顺序
  old_text    TEXT NOT NULL DEFAULT '',                -- modify/delete 的原文
  new_text    TEXT NOT NULL DEFAULT ''                 -- modify/add 的新文
);
-- 同一修订内一条既有台词只能出现一次（add 的行 line_id 为 NULL，不受约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_items_line
  ON revision_items(revision_id, line_id) WHERE line_id IS NOT NULL;

-- 每次发布尝试（无论成功或因冲突未生效）都留痕
CREATE TABLE IF NOT EXISTS publish_attempts (
  id             INTEGER PRIMARY KEY,
  play_id        INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  new_version_id INTEGER REFERENCES versions(id),      -- 冲突时为空 = 本次发布未生效
  had_conflict   INTEGER NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  revision_ids   TEXT NOT NULL,                        -- JSON 数组
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publish_conflicts (
  id               INTEGER PRIMARY KEY,
  attempt_id       INTEGER NOT NULL REFERENCES publish_attempts(id) ON DELETE CASCADE,
  revision_id      INTEGER NOT NULL,
  revision_item_id INTEGER NOT NULL,
  line_id          INTEGER,
  kind             TEXT NOT NULL,  -- text_changed / line_deleted / batch_cross_edit
  reason           TEXT NOT NULL,
  base_text        TEXT NOT NULL DEFAULT '',
  current_text     TEXT NOT NULL DEFAULT ''
);

-- 排练：创建时固定引用一个版本
CREATE TABLE IF NOT EXISTS rehearsals (
  id         INTEGER PRIMARY KEY,
  play_id    INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

-- 派角：每个角色在一个排练中至多派给一名演员；改派=更新本行（确认会随之作废）
CREATE TABLE IF NOT EXISTS rehearsal_cast (
  id            INTEGER PRIMARY KEY,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  assigned_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rehearsal_id, role_id)
);

CREATE TABLE IF NOT EXISTS rehearsal_version_log (
  id              INTEGER PRIMARY KEY,
  rehearsal_id    INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  from_version_id INTEGER NOT NULL,
  to_version_id   INTEGER NOT NULL,
  actor_id        INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 排练日程：导演为某场次安排的带时区起止时段（可同场次多段）
--   * status: active=有效；needs_adjustment=换版后该场次在新版本中已无台词，待调整；cancelled=已取消
--   * 起止时间以 ISO 8601 提交（必须带时区），服务端归一化为 UTC 存储
--   * 重叠判定为半开区间 [start, end)：端点相接不算重叠
--   * 参与者 = 排练当前固定版本中本场有台词且已派角的演员（动态计算，不落库）
CREATE TABLE IF NOT EXISTS rehearsal_schedules (
  id            INTEGER PRIMARY KEY,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  scene_id      INTEGER NOT NULL REFERENCES scenes(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'needs_adjustment', 'cancelled')),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_rehearsal ON rehearsal_schedules(rehearsal_id);

-- 演员不可用时段：演员登记/修改/撤销自己的不可用时间（带时区提交，服务端归一化为 UTC 存储）
--   * 结束必须晚于开始；重叠判定为半开区间 [start, end)：端点相接不算重叠
--   * 演员提交/修改时与本人当前参与的有效日程重叠 -> 整次拒绝并指出冲突日程
--   * 导演排期/调期、派角/改派、显式换版时，参与演员撞上不可用时段 -> 整次不生效
--   * 已取消与待调整日程不参与；开启过的到场登记名单与签到不因此改写
CREATE TABLE IF NOT EXISTS actor_unavailability (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at   TEXT NOT NULL,
  end_at     TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_unavailability_actor ON actor_unavailability(actor_id);

-- 到场登记：导演为“有效”日程时段开启的一次性签到。
--   * 每个日程时段至多一次登记（schedule_id 唯一；已有登记——含已关闭/已作废——不得再开）
--   * 开启时冻结：场次、UTC 起止时段、排练当时固定版本；此后改派/换版/调整日程均不回写
--   * status: open=开放签到；closed=导演已关闭（未签到者记缺席）；voided=开放期间日程被取消
--     （作废：停止签到，已签到痕迹保留但不计出勤）
--   * schedule_cancelled=1：登记关闭后日程又被取消，仅标注，原统计保留
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id                 INTEGER PRIMARY KEY,
  schedule_id        INTEGER NOT NULL UNIQUE REFERENCES rehearsal_schedules(id) ON DELETE CASCADE,
  rehearsal_id       INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  scene_id           INTEGER NOT NULL REFERENCES scenes(id),
  version_id         INTEGER NOT NULL REFERENCES versions(id),
  start_at           TEXT NOT NULL,
  end_at             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'closed', 'voided')),
  opened_by          INTEGER REFERENCES users(id),
  opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
  closed_by          INTEGER REFERENCES users(id),
  closed_at          TEXT,
  schedule_cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attendance_rehearsal ON attendance_sessions(rehearsal_id);

-- 登记名单（开启时冻结）：当时“本场次有台词且已派角”的演员；未派角角色不计应到。
-- checked_in_at 为空 = 未签到；登记关闭后仍未签即缺席。后来加入者不在名单，不能签到。
CREATE TABLE IF NOT EXISTS attendance_roster (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  roles_json    TEXT NOT NULL DEFAULT '[]',
  checked_in_at TEXT,
  UNIQUE (session_id, actor_id)
);

-- 缺口（开启时冻结）：当时本场次有台词但未派角的角色，仅展示，不计应到。
CREATE TABLE IF NOT EXISTS attendance_gaps (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  role_id    INTEGER NOT NULL REFERENCES roles(id),
  UNIQUE (session_id, role_id)
);

-- 演员按“所派角色 × 场次”确认；content_hash 对应确认时排练固定版本的台词文本。
-- 唯一键含 actor_id：角色改派后保留原演员的历史确认（不计入），新演员需重新确认。
CREATE TABLE IF NOT EXISTS confirmations (
  id            INTEGER PRIMARY KEY,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  scene_id      INTEGER NOT NULL REFERENCES scenes(id),
  content_hash  TEXT NOT NULL,
  confirmed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rehearsal_id, role_id, scene_id, actor_id)
);

-- 时段通知批次：导演调整排练安排后，演员需确认知悉当前时段。
--   * 有效时段创建、起止/场次变化，以及派角/撤派/显式换版使该时段参与演员、角色或
--     固定版本变化时，按最终结果生成新批次；无实质变化（fingerprint 相同）不重复生成。
--   * 批次冻结：UTC 起止时段、场次、固定版本与当时参与演员（接收人表）。
--   * status: current=当前有效批次（计当前待确认）；superseded=已被新批次取代（保留不计）；
--     inactive=时段已取消或待调整（不再待确认，恢复有效时生成新批次）。
--   * 批次随原操作事务提交：排期/不可用冲突导致原操作失败时不留批次。
CREATE TABLE IF NOT EXISTS schedule_notifications (
  id            INTEGER PRIMARY KEY,
  schedule_id   INTEGER NOT NULL REFERENCES rehearsal_schedules(id) ON DELETE CASCADE,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,                -- 该时段内第几批（从 1 递增）
  scene_id      INTEGER NOT NULL REFERENCES scenes(id),
  version_id    INTEGER NOT NULL REFERENCES versions(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,                   -- 实质内容指纹（时段/场次/版本/参与演员及角色）
  status        TEXT NOT NULL DEFAULT 'current'
                  CHECK (status IN ('current', 'superseded', 'inactive')),
  reason        TEXT NOT NULL DEFAULT '',        -- create / adjust / batch_adjust / cast / batch_cast / version_switch
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_notifications_schedule ON schedule_notifications(schedule_id);
CREATE INDEX IF NOT EXISTS idx_notifications_rehearsal ON schedule_notifications(rehearsal_id);

-- 批次接收人（生成时冻结的当时参与演员及其角色）；confirmed_at 为空 = 待确认。
-- 确认幂等：重试返回首次确认时间；过期（非 current）批次的确认被拒绝。
CREATE TABLE IF NOT EXISTS schedule_notification_recipients (
  id              INTEGER PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES schedule_notifications(id) ON DELETE CASCADE,
  actor_id        INTEGER NOT NULL REFERENCES users(id),
  roles_json      TEXT NOT NULL DEFAULT '[]',
  confirmed_at    TEXT,
  UNIQUE (notification_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_actor ON schedule_notification_recipients(actor_id);

-- 剧团共享道具：导演登记各道具的非负整数总件数（库存），按排练时段预约。
--   * 仅“有效（active）”时段的预约占用库存；已取消（cancelled）与待调整（needs_adjustment）
--     时段的预约随记录保留但不占用——取消/换版转待调整时释放，待调整恢复有效时重新校验。
--   * 占用按带时区时段归一化后的半开区间 [start, end) 计算：端点相接可复用。
--   * 同一道具任一时刻全部有效时段的预约总量不得超过 props.total_count。
CREATE TABLE IF NOT EXISTS props (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 时段道具预约：一个时段对一个道具至多一行（0 件不保留行，即“撤销”）。
-- 占用与否由 rehearsal_schedules.status 动态决定（active 才计入），本表不复制状态。
-- 单条与批量调期（PATCH / batch-adjust）时，预约随时段的场次与起止时间一起移动；
-- 取消时段后预约行保留为历史痕迹（不再占用，且不可再改）。
CREATE TABLE IF NOT EXISTS prop_reservations (
  id          INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES rehearsal_schedules(id) ON DELETE CASCADE,
  prop_id     INTEGER NOT NULL REFERENCES props(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL CHECK (quantity >= 0),
  updated_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (schedule_id, prop_id)
);
CREATE INDEX IF NOT EXISTS idx_prop_reservations_prop ON prop_reservations(prop_id);
CREATE INDEX IF NOT EXISTS idx_prop_reservations_schedule ON prop_reservations(schedule_id);

const { db, transaction, hashPassword } = require('./db');
const { syncScheduleNotifications } = require('./schedules');

/**
 * 首次启动初始化演示数据：
 *   导演 director / director123
 *   演员   lin / actor123（林晚）
 *   演员   chen / actor123（陈默）
 *   演员   zhou / actor123（周海，暂未派角）
 */
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;

  transaction(() => {
    const insUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)'
    );
    const director = insUser.run('director', hashPassword('director123'), 'director', '导演').lastInsertRowid;
    const lin = insUser.run('lin', hashPassword('actor123'), 'actor', '林晚').lastInsertRowid;
    const chen = insUser.run('chen', hashPassword('actor123'), 'actor', '陈默').lastInsertRowid;
    insUser.run('zhou', hashPassword('actor123'), 'actor', '周海');

    // 剧本《夜航灯塔》
    const play = db
      .prepare('INSERT INTO plays (title, description, created_by) VALUES (?, ?, ?)')
      .run('夜航灯塔', '海上灯塔守夜人与迷途船员的一夜', director).lastInsertRowid;

    const s1 = db.prepare('INSERT INTO scenes (play_id, code, title, seq) VALUES (?, ?, ?, 1)').run(play, 'I', '风暴前夜').lastInsertRowid;
    const s2 = db.prepare('INSERT INTO scenes (play_id, code, title, seq) VALUES (?, ?, ?, 2)').run(play, 'II', '灯塔之下').lastInsertRowid;

    const rLin = db.prepare('INSERT INTO roles (play_id, code, name) VALUES (?, ?, ?)').run(play, 'KEEPER', '守塔人').lastInsertRowid;
    const rChen = db.prepare('INSERT INTO roles (play_id, code, name) VALUES (?, ?, ?)').run(play, 'SAILOR', '船员').lastInsertRowid;

    const draft = [
      [s1, rLin, 1, '今晚的浪比昨天高，灯油还够烧到天亮。'],
      [s1, rChen, 2, '我们的船舵失灵了，只能跟着潮水走。'],
      [s1, rLin, 3, '看见那束光没有？朝它开，不会错。'],
      [s2, rChen, 4, '灯塔……原来真的有人守在这里。'],
      [s2, rLin, 5, '三十年了，每一夜都得有人守着。'],
      [s2, rChen, 6, '如果有一夜灯灭了呢？'],
      [s2, rLin, 7, '那就有人再也找不到岸。'],
    ];
    const insLine = db.prepare(
      'INSERT INTO lines (play_id, scene_id, role_id, seq, current_text) VALUES (?, ?, ?, ?, ?)'
    );
    const lineIds = draft.map(([scene, role, seq, text]) =>
      insLine.run(play, scene, role, seq, text).lastInsertRowid
    );

    // 发布 v1
    const v1 = db
      .prepare('INSERT INTO versions (play_id, version_no, note, base_version_id, created_by) VALUES (?, 1, ?, NULL, ?)')
      .run(play, '首版', director).lastInsertRowid;
    const insVL = db.prepare(
      'INSERT INTO version_lines (version_id, line_id, scene_id, role_id, seq, text) VALUES (?, ?, ?, ?, ?, ?)'
    );
    draft.forEach(([scene, role, seq, text], i) => insVL.run(v1, lineIds[i], scene, role, seq, text));

    // 排练固定引用 v1，派角：守塔人=林晚，船员=陈默
    const rehearsal = db
      .prepare('INSERT INTO rehearsals (play_id, version_id, name, created_by) VALUES (?, ?, ?, ?)')
      .run(play, v1, '首演排练（固定 v1）', director).lastInsertRowid;
    db.prepare('INSERT INTO rehearsal_cast (rehearsal_id, role_id, actor_id) VALUES (?, ?, ?)').run(rehearsal, rLin, lin);
    db.prepare('INSERT INTO rehearsal_cast (rehearsal_id, role_id, actor_id) VALUES (?, ?, ?)').run(rehearsal, rChen, chen);

    // 示例日程：场次 I 的对词时段（带时区提交，服务端归一化为 UTC 存储）
    const seedSchedule = db
      .prepare(
        'INSERT INTO rehearsal_schedules (rehearsal_id, scene_id, start_at, end_at, created_by) VALUES (?, ?, ?, ?, ?)'
      )
      .run(rehearsal, s1, '2026-10-10T06:00:00.000Z', '2026-10-10T07:30:00.000Z', director)
      .lastInsertRowid;

    // 示例日程自带一条时段通知批次（林晚、陈默待知悉确认）
    syncScheduleNotifications(rehearsal, 'create', director);

    // 剧团共享道具：登记总件数，并为示例时段预约（0 件即撤销，故此处直接登记正数）
    const insProp = db.prepare('INSERT INTO props (name, total_count, created_by) VALUES (?, ?, ?)');
    const propLamp = insProp.run('煤油灯', 2, director).lastInsertRowid;
    const propSword = insProp.run('道具佩剑', 1, director).lastInsertRowid;
    insProp.run('旧航海图', 1, director);
    const insRes = db.prepare(
      'INSERT INTO prop_reservations (schedule_id, prop_id, quantity, updated_by) VALUES (?, ?, ?, ?)'
    );
    insRes.run(seedSchedule, propLamp, 1, director);
    insRes.run(seedSchedule, propSword, 1, director);
  });

  return true;
}

module.exports = { seed };

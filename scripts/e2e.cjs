/**
 * 端到端业务流程测试（对已运行的服务器执行）。
 * 用法: BASE=http://127.0.0.1:3210 node scripts/e2e.cjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

async function req(method, path, token, body, expectStatus = 200) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  const acceptable = expectStatus === 200 ? [200, 201] : [expectStatus];
  if (!acceptable.includes(res.status)) {
    throw new Error(`${method} ${path} 期望 ${expectStatus} 得到 ${res.status}: ${text}`);
  }
  return json;
}
const J = (p, t, b, s) => req('POST', p, t, b, s);
const G = (p, t, s = 200) => req('GET', p, t, undefined, s);
const D = (p, t, s = 200) => req('DELETE', p, t, undefined, s);

async function login(u, p) {
  const r = await J('/api/login', null, { username: u, password: p }, 200);
  return r.token;
}

async function main() {
  console.log('— 认证与越权 —');
  await J('/api/login', null, { username: 'director', password: 'wrong' }, 401);
  const director = await login('director', 'director123');
  const lin = await login('lin', 'actor123');
  const chen = await login('chen', 'actor123');
  await G('/api/me', null, 401);
  // 演员不能建剧本/看演员名册
  await J('/api/plays', lin, { title: 'x' }, 403);
  await G('/api/actors', lin, 403);
  check('错误密码 401 / 未登录 401 / 演员越权导演接口 403', true);

  console.log('— 种子数据 —');
  const { plays } = await G('/api/plays', director);
  check('种子剧本存在', plays.length >= 1);
  const playId = plays[0].id;
  const detail = await G(`/api/plays/${playId}`, director);
  check('首版已发布', detail.play.latestVersionId === 1);
  check('种子台词 7 条', detail.lines.length === 7, String(detail.lines.length));
  // 已发布后直接改行台词被拒
  await req('PATCH', `/api/lines/${detail.lines[0].id}`, director, { text: 'x' }, 409);
  check('发布后禁止直接改现行文本（409）', true);

  console.log('— 无效版本 / 越权访问剧本 —');
  await G('/api/versions/99999', director, 404);
  // 周海未派角应 403；陈默在种子排练中被派了船员，可以访问
  const zhou = await login('zhou', 'actor123');
  await G(`/api/plays/${playId}`, zhou, 403);
  check('未派角演员访问剧本 403；已派角演员可访问', true);
  const chenPlay = await G(`/api/plays/${playId}`, chen, 200);
  check('已派角演员可看剧本', !!chenPlay.play);
  check('演员剧本详情只含所派角色台词', chenPlay.lines.every((l) => {
    const r = detail.roles.find((x) => x.id === l.roleId);
    return r.code === 'SAILOR';
  }) && chenPlay.lines.length >= 2, String(chenPlay.lines.length));
  const chenV1 = await G('/api/versions/1', chen, 200);
  check('演员版本视图只含所派角色台词', chenV1.lines.every((l) => l.roleCode === 'SAILOR') && chenV1.lines.length === 3, String(chenV1.lines.length));

  console.log('— 修订提交：必须标明原文且与基准一致 —');
  const line1 = detail.lines[0]; // 守塔人 s1
  const line2 = detail.lines[1]; // 船员 s1
  // 原文错误 -> 409 OLD_TEXT_MISMATCH
  const badRev = await J(`/api/plays/${playId}/revisions`, director, {
    title: '错误原文', baseVersionId: 1, items: [],
  }, 201);
  await J(`/api/revisions/${badRev.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: '瞎写的原文', newText: '新的文本',
  }, 409);
  check('原文与基准不一致时拒绝提交', true);

  // 修订 A：改 line1
  const revA = await J(`/api/plays/${playId}/revisions`, director, { title: '修订A-浪高', baseVersionId: 1 }, 201);
  await J(`/api/revisions/${revA.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚的浪比昨天高得多，灯油还够烧到后半夜。',
  });
  // 修订 B：改 line2（与 A 互不冲突）
  const revB = await J(`/api/plays/${playId}/revisions`, director, { title: '修订B-船舵' }, 201);
  await J(`/api/revisions/${revB.id}/items`, director, {
    action: 'modify', lineId: line2.id, oldText: line2.text, newText: '船舵彻底失灵了，我们只能跟着潮水漂。',
  });
  // 修订 C：也改 line1，同样基于 v1 原文（与 A 冲突，内容不同）
  const revC = await J(`/api/plays/${playId}/revisions`, director, { title: '修订C-同句不同改' }, 201);
  await J(`/api/revisions/${revC.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚风浪不小，但灯油足够撑到天明。',
  });
  // 修订 D：和 A 完全相同的改动（幂等，不算冲突）
  const revD = await J(`/api/plays/${playId}/revisions`, director, { title: '修订D-同改相同' }, 201);
  await J(`/api/revisions/${revD.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚的浪比昨天高得多，灯油还够烧到后半夜。',
  });

  console.log('— 发布 A+B+C：有冲突，整体不生效 —');
  const conflictPub = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revA.id, revB.id, revC.id], note: '尝试1',
  }, 409);
  check('冲突时返回 409', conflictPub.error === 'PUBLISH_CONFLICT');
  check('冲突条目数为 1（C 撞 A）', conflictPub.conflicts.length === 1, JSON.stringify(conflictPub.conflicts));
  check('冲突指明 line1 与修订', conflictPub.conflicts[0].lineId === line1.id && conflictPub.conflicts[0].revisionId === revC.id);
  const stillV1 = await G(`/api/plays/${playId}`, director);
  check('冲突后未生成新版本', stillV1.play.latestVersionId === 1);
  check('冲突后修订仍是 open', (await G(`/api/revisions/${revA.id}`, director)).status === 'open');

  console.log('— 发布 A+D+B：相同改动幂等，互不冲突，合成 v2 —');
  const pub2 = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revA.id, revD.id, revB.id], note: 'v2 合入',
  }, 201);
  check('生成 v2', pub2.newVersion.versionNo === 2);
  check('三个修订都标记 merged', (await G(`/api/revisions/${revD.id}`, director)).status === 'merged');
  const v2 = await G('/api/versions/2', director);
  const v2line1 = v2.lines.find((l) => l.lineId === line1.id);
  const v2line2 = v2.lines.find((l) => l.lineId === line2.id);
  check('v2 含 A 的新文', v2line1.text.includes('后半夜'));
  check('v2 含 B 的新文', v2line2.text.includes('彻底失灵'));
  // v1 快照未变（不可改写）
  const v1 = await G('/api/versions/1', director);
  check('v1 快照保持原文', v1.lines.find((l) => l.lineId === line1.id).text === line1.text);

  console.log('— 修订 C 基于旧原文：发布时核对现行文本，报 text_changed —');
  const pub3 = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revC.id],
  }, 409);
  check('C 报 text_changed 冲突', pub3.conflicts[0].kind === 'text_changed');
  check('冲突含原文与现行文本', pub3.conflicts[0].baseText === line1.text && pub3.conflicts[0].currentText.includes('后半夜'));

  console.log('— 删除修订与发布 —');
  const revDel = await J(`/api/plays/${playId}/revisions`, director, { title: '删一句' }, 201);
  await J(`/api/revisions/${revDel.id}/items`, director, {
    action: 'delete', lineId: line2.id, oldText: '船舵彻底失灵了，我们只能跟着潮水漂。',
  });
  const pub4 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revDel.id] }, 201);
  check('删除后生成 v3', pub4.newVersion.versionNo === 3);
  const v3 = await G('/api/versions/3', director);
  check('v3 中该句已删除', !v3.lines.find((l) => l.lineId === line2.id));
  check('v2 中该句仍在（历史版本不变）', !!(await G('/api/versions/2', director)).lines.find((l) => l.lineId === line2.id));
  // 再拿一个基于 v2 原文想改已删句子的修订 -> line_deleted
  const revZ = await J(`/api/plays/${playId}/revisions`, director, { title: '改已删句', baseVersionId: 2 }, 201);
  // 提交时基准 v2 里还在，允许提交
  await J(`/api/revisions/${revZ.id}/items`, director, {
    action: 'modify', lineId: line2.id, oldText: '船舵彻底失灵了，我们只能跟着潮水漂。', newText: 'x',
  });
  const pub5 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revZ.id] }, 409);
  check('现行已删 -> line_deleted 冲突', pub5.conflicts[0].kind === 'line_deleted');

  console.log('— 新增台词修订 —');
  const revAdd = await J(`/api/plays/${playId}/revisions`, director, { title: '加一句' }, 201);
  await J(`/api/revisions/${revAdd.id}/items`, director, {
    action: 'add', sceneId: detail.scenes[0].id, roleId: detail.roles[1].id, newText: '快看，灯塔的光转过来了！',
  });
  const pub6 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revAdd.id] }, 201);
  check('新增合入 v4', pub6.newVersion.versionNo === 4);
  const v4 = await G('/api/versions/4', director);
  check('v4 含新增句', v4.lines.some((l) => l.text === '快看，灯塔的光转过来了！'));
  // 作废 open 修订
  await J(`/api/revisions/${revC.id}/abandon`, director, {}, 200);
  await J(`/api/revisions/${revC.id}/abandon`, director, {}, 400);
  check('作废幂等保护（再次作废 400）', true);

  console.log('— 版本不可改写（数据库触发器） —');
  // 用独立内存库自检触发器（不依赖本地 ./data 目录的残留状态）
  process.env.DB_PATH = ':memory:';
  const { db: memdb } = require('/workspace/src/db.js');
  const tPlay = memdb.prepare('INSERT INTO plays (title) VALUES (?)').run('触发器自检').lastInsertRowid;
  const tVer = memdb.prepare('INSERT INTO versions (play_id, version_no) VALUES (?, 1)').run(tPlay).lastInsertRowid;
  memdb.prepare('INSERT INTO version_lines (version_id, line_id, scene_id, role_id, seq, text) VALUES (?, 1, 1, 1, 1, ?)').run(tVer, 'x');
  let blockedUpdate = false;
  try { memdb.prepare('UPDATE versions SET note = ? WHERE id = ?').run('hacked', tVer); } catch { blockedUpdate = true; }
  let blockedVL = false;
  try { memdb.prepare('UPDATE version_lines SET text = ? WHERE version_id = ?').run('h', tVer); } catch { blockedVL = true; }
  let blockedDel = false;
  try { memdb.prepare('DELETE FROM versions WHERE id = ?').run(tVer); } catch { blockedDel = true; }
  check('versions UPDATE/DELETE 与 version_lines UPDATE 被触发器拒绝', blockedUpdate && blockedVL && blockedDel);

  console.log('— 排练：创建固定版本、派角、确认、换版 —');
  // 无效版本创建排练
  await J(`/api/plays/${playId}/rehearsals`, director, { versionId: 99999 }, 400);
  const reh = await J(`/api/plays/${playId}/rehearsals`, director, { versionId: 1, name: '测试排练固定v1' }, 201);
  check('排练创建时固定 v1', reh.versionId === 1);
  const actors = (await G('/api/actors', director)).actors;
  const zhouId = actors.find((a) => a.username === 'zhou').id;
  const linId = actors.find((a) => a.username === 'lin').id;
  const keeperRole = detail.roles.find((r) => r.code === 'KEEPER').id;
  const sailorRole = detail.roles.find((r) => r.code === 'SAILOR').id;
  await J(`/api/rehearsals/${reh.id}/cast`, director, { roleId: keeperRole, actorId: linId }, 201);
  // 演员不能看未派角排练
  await G(`/api/rehearsals/${reh.id}/script`, chen, 403);
  // 演员不能给别人的角色确认
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: sailorRole, sceneId: detail.scenes[0].id }, 403);
  // 无效场次确认
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: 99999 }, 400);
  check('越权确认 / 无效场次被拒', true);

  // 林晚确认两个场次（v1 守塔人：s1 第1句、s2 第5/7句）
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: detail.scenes[0].id });
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: detail.scenes[1].id });
  let rehView = await G(`/api/rehearsals/${reh.id}`, director);
  check('林晚两场确认后，其角色无待确认', !rehView.pending.some((p) => p.actorId === linId));

  // 换版到 v2：守塔人 s1 文本变了，s2 没变 -> s1 重新待确认，s2 保留
  const sw = await J(`/api/rehearsals/${reh.id}/switch-version`, director, { versionId: 2 }, 200);
  const linPend = sw.pending.filter((p) => p.actorId === linId);
  check('换版 v2：守塔人 s1 需重新确认', linPend.some((p) => p.sceneId === detail.scenes[0].id), JSON.stringify(linPend));
  check('换版 v2：守塔人 s2（文本未变）不需确认', !linPend.some((p) => p.sceneId === detail.scenes[1].id));

  // 改派：守塔人改派给周海 -> 原林晚确认不计入；周海两场都待确认
  await J(`/api/rehearsals/${reh.id}/cast`, director, { roleId: keeperRole, actorId: zhouId }, 200);
  rehView = await G(`/api/rehearsals/${reh.id}`, director);
  const zhouPend = rehView.pending.filter((p) => p.actorId === zhouId);
  check('改派后新演员待确认（s1）', zhouPend.some((p) => p.sceneId === detail.scenes[0].id));
  // s2 保留了林晚的旧确认 -> 周海看到的原因是“已改派，原确认不计入”
  const s2p = zhouPend.find((p) => p.sceneId === detail.scenes[1].id);
  check('s2 标注“原演员确认不计入”', !!s2p && s2p.reason.includes('改派'), s2p?.reason);
  check('改派后原演员不再出现在待确认（她已无角色）', !rehView.pending.some((p) => p.actorId === linId));
  // 周海用演员视角看稿，只能看到守塔人台词
  const script = await G(`/api/rehearsals/${reh.id}/script`, zhou);
  check('演员排练稿只含所派角色', script.lines.every((l) => l.roleId === keeperRole) && script.lines.length > 0);

  // 换版到 v3（删掉了船员的句子）；未派船员，只看守塔人：v3 守塔人内容与 v2 相同 => 无需再确认
  // 先把 s1 确认掉
  await J(`/api/rehearsals/${reh.id}/confirm`, zhou, { roleId: keeperRole, sceneId: detail.scenes[0].id });
  await J(`/api/rehearsals/${reh.id}/confirm`, zhou, { roleId: keeperRole, sceneId: detail.scenes[1].id });
  const sw3 = await J(`/api/rehearsals/${reh.id}/switch-version`, director, { versionId: 3 }, 200);
  check('v2→v3 守塔人无文本变化 => 无待确认', !sw3.pending.some((p) => p.actorId === zhouId), JSON.stringify(sw3.pending));

  console.log('— 待确认演员与冲突详情展示 —');
  const dash = await G('/api/dashboard', director);
  check('总览含每个排练的 pending', Array.isArray(dash.rehearsals[0].pending));
  check('总览含冲突详情', dash.recentConflicts.some((c) => c.details.length > 0));
  const attempts = (await G(`/api/plays/${playId}/publish-attempts`, director)).attempts;
  check('发布尝试历史含成功与冲突两种', attempts.some((a) => a.hadConflict) && attempts.some((a) => !a.hadConflict));

  console.log('— 排练日程：带时区时段、参与者、待补派 —');
  const chenId = actors.find((a) => a.username === 'chen').id;
  // 专用剧本：sc1/sc2/scEmpty；角色 RA/RB
  const p2 = await J('/api/plays', director, { title: '日程测试剧' }, 201);
  const sc1 = (await J(`/api/plays/${p2.id}/scenes`, director, { code: 'A1', title: '码头' }, 201)).id;
  const sc2 = (await J(`/api/plays/${p2.id}/scenes`, director, { code: 'A2', title: '船舱' }, 201)).id;
  const scEmpty = (await J(`/api/plays/${p2.id}/scenes`, director, { code: 'A3', title: '空场' }, 201)).id;
  const roleA = (await J(`/api/plays/${p2.id}/roles`, director, { code: 'RA', name: '甲' }, 201)).id;
  const roleB = (await J(`/api/plays/${p2.id}/roles`, director, { code: 'RB', name: '乙' }, 201)).id;
  await J(`/api/plays/${p2.id}/lines`, director, { sceneId: sc1, roleId: roleA, text: '甲一句一', seq: 1 }, 201);
  await J(`/api/plays/${p2.id}/lines`, director, { sceneId: sc2, roleId: roleA, text: '甲二句一', seq: 1 }, 201);
  await J(`/api/plays/${p2.id}/lines`, director, { sceneId: sc2, roleId: roleB, text: '乙二句一', seq: 2 }, 201);
  const pv1 = (await J(`/api/plays/${p2.id}/publish-initial`, director, { note: 'v1' }, 201)).version.id;
  // v2：给乙在 sc1 加一句（换版后乙才在 sc1 有台词）
  const revAddB = await J(`/api/plays/${p2.id}/revisions`, director, { title: '乙加 sc1 台词' }, 201);
  await J(`/api/revisions/${revAddB.id}/items`, director, { action: 'add', sceneId: sc1, roleId: roleB, newText: '乙一句一', seq: 2 }, 201);
  const pv2 = (await J(`/api/plays/${p2.id}/publish`, director, { revisionIds: [revAddB.id] }, 201)).newVersion.id;
  // v3：删掉 sc2 全部台词（换版后 sc2 场次无台词 -> 既有安排待调整）
  const p2detail = await G(`/api/plays/${p2.id}`, director);
  const revDel2 = await J(`/api/plays/${p2.id}/revisions`, director, { title: '清空 sc2' }, 201);
  await J(`/api/revisions/${revDel2.id}/items`, director, { action: 'delete', lineId: p2detail.lines.find((l) => l.text === '甲二句一').id, oldText: '甲二句一' }, 201);
  await J(`/api/revisions/${revDel2.id}/items`, director, { action: 'delete', lineId: p2detail.lines.find((l) => l.text === '乙二句一').id, oldText: '乙二句一' }, 201);
  const pv3 = (await J(`/api/plays/${p2.id}/publish`, director, { revisionIds: [revDel2.id] }, 201)).newVersion.id;

  // RH_A 固定 v2：甲=林晚，乙=陈默
  const rhA = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练A' }, 201)).id;
  await J(`/api/rehearsals/${rhA}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhA}/cast`, director, { roleId: roleB, actorId: chenId }, 201);

  // 校验：演员越权 / 排练不存在 / 无时区 / 结束不晚于开始 / 场次无效 / 场次当前版本无台词
  await J(`/api/rehearsals/${rhA}/schedules`, lin, { sceneId: sc1, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 403);
  await J('/api/rehearsals/99999/schedules', director, { sceneId: sc1, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 404);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T11:00:00+08:00', endAt: '2030-01-01T10:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: 99999, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: detail.scenes[0].id, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: scEmpty, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  check('日程：越权/无排练/无时区/起止颠倒/无效场次/无台词场次均被拒', true);

  // 正常创建：参与者=当前版本本场有台词且已派角的演员
  const schA1 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 201)).schedule;
  check('日程参与者为有台词且已派角的演员', schA1.participants.length === 2 && schA1.participants.every((p) => [linId, chenId].includes(p.actorId)), JSON.stringify(schA1.participants));
  check('全部派角时无待补派', schA1.pendingCast.length === 0);
  // 端点相接不算重叠
  const schA2 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc2, startAt: '2030-01-01T11:00:00+08:00', endAt: '2030-01-01T12:00:00+08:00' }, 201)).schedule;
  check('端点相接（11:00 接 11:00）不算重叠', !!schA2.id);
  // 重叠 -> 409，返回冲突演员与时段
  const ov = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:30:00+08:00', endAt: '2030-01-01T11:30:00+08:00' }, 409);
  check('时段重叠返回 SCHEDULE_CONFLICT', ov.error === 'SCHEDULE_CONFLICT');
  check('冲突详情含冲突演员与时段', ov.details.conflicts.some((c) => c.actorId === linId && c.overlapsWith.id === schA1.id), JSON.stringify(ov.details));
  // 不同时区表示的同一时段也判重叠（10:30+09:00 = 09:30+08:00）
  const ovTz = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:30:00+09:00', endAt: '2030-01-01T12:30:00+09:00' }, 409);
  check('跨时区同一时间轴同样判重叠', ovTz.error === 'SCHEDULE_CONFLICT');
  // Z 时区写法，端点相接于 schA2 末端（12:00+08:00 = 04:00Z）
  const schA3 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T04:00:00Z', endAt: '2030-01-01T05:00:00Z' }, 201)).schedule;
  check('Z 时区可提交且端点相接不冲突', !!schA3.id);

  console.log('— 日程：待补派 / 跨排练冲突 / 派角冲突 —');
  // RH_B 固定 v1：乙=陈默（v1 中乙在 sc1 无台词）
  const rhB = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '日程排练B' }, 201)).id;
  await J(`/api/rehearsals/${rhB}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const schB1 = (await J(`/api/rehearsals/${rhB}/schedules`, director, { sceneId: sc1, startAt: '2030-01-02T10:00:00+08:00', endAt: '2030-01-02T11:00:00+08:00' }, 201)).schedule;
  check('当前版本无台词角色不参与（参与者为空）', schB1.participants.length === 0);
  check('未派角色列为待补派，不阻止安排', schB1.pendingCast.some((r) => r.roleId === roleA));
  const schB2 = (await J(`/api/rehearsals/${rhB}/schedules`, director, { sceneId: sc2, startAt: '2030-01-02T10:00:00+08:00', endAt: '2030-01-02T11:00:00+08:00' }, 201)).schedule;
  check('参与者按排练当前版本计算', schB2.participants.some((p) => p.actorId === chenId));
  // 跨排练冲突：陈默在 RH_B 的 sc2 有时段，RH_A 同时段不可再排
  const ovReh = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-02T10:30:00+08:00', endAt: '2030-01-02T11:30:00+08:00' }, 409);
  check('跨排练的演员重叠也冲突', ovReh.details.conflicts.some((c) => c.actorId === chenId && c.overlapsWith.id === schB2.id));
  const schA4 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-02T11:00:00+08:00', endAt: '2030-01-02T12:00:00+08:00' }, 201)).schedule;
  check('跨排练端点相接可安排', !!schA4.id);

  // 派角冲突：RH_C 甲=周海并排好时段；陈默在 RH_A 同时段有安排 -> 派角整次拒绝
  const rhC = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练C' }, 201)).id;
  await J(`/api/rehearsals/${rhC}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  const schC1 = (await J(`/api/rehearsals/${rhC}/schedules`, director, { sceneId: sc1, startAt: '2030-01-03T10:00:00+08:00', endAt: '2030-01-03T11:00:00+08:00' }, 201)).schedule;
  check('待补派列出未派角的有台词角色', schC1.pendingCast.some((r) => r.roleId === roleB));
  const schA5 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-03T10:30:00+08:00', endAt: '2030-01-03T11:30:00+08:00' }, 201)).schedule;
  const castConflict = await J(`/api/rehearsals/${rhC}/cast`, director, { roleId: roleB, actorId: chenId }, 409);
  check('派角与既有时段重叠 -> 整次拒绝', castConflict.error === 'SCHEDULE_CONFLICT' && castConflict.details.conflicts.some((c) => c.actorId === chenId));
  const rhCsched = await G(`/api/rehearsals/${rhC}/schedules`, director);
  check('派角被拒绝后仍未派角', rhCsched.schedules.find((s) => s.id === schC1.id).pendingCast.some((r) => r.roleId === roleB));
  // 取消冲突时段后派角成功
  await J(`/api/rehearsals/${rhA}/schedules/${schA5.id}/cancel`, director, {}, 200);
  await J(`/api/rehearsals/${rhC}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  check('取消冲突时段后派角成功', true);

  console.log('— 日程：换版冲突 / 失败换版不动版本与确认 / 待调整 —');
  // 陈默先确认 RH_B 的 sc2（v1），验证失败换版不影响确认
  await J(`/api/rehearsals/${rhB}/confirm`, chen, { roleId: roleB, sceneId: sc2 }, 200);
  // RH_B v1->v2：schB1(sc1) 将纳入陈默，与同排练同时段 schB2(sc2) 冲突
  const swFail = await J(`/api/rehearsals/${rhB}/switch-version`, director, { versionId: pv2 }, 409);
  check('换版后参与者重叠 -> 换版整次拒绝', swFail.error === 'SCHEDULE_CONFLICT' && swFail.details.conflicts.some((c) => c.actorId === chenId), JSON.stringify(swFail));
  const rhBAfter = await G(`/api/rehearsals/${rhB}`, director);
  check('失败的换版不改变版本', rhBAfter.rehearsal.versionId === pv1);
  check('失败的换版不改变确认', !rhBAfter.pending.some((p) => p.actorId === chenId));
  // 调整 schB1 到不相交时段后，换版成功
  const adjB1 = await req('PATCH', `/api/rehearsals/${rhB}/schedules/${schB1.id}`, director, { startAt: '2030-01-02T12:00:00+08:00', endAt: '2030-01-02T13:00:00+08:00' }, 200);
  check('调整时段成功', adjB1.schedule.status === 'active');
  const swOk = await J(`/api/rehearsals/${rhB}/switch-version`, director, { versionId: pv2 }, 200);
  check('冲突解除后换版成功', swOk.rehearsal.versionId === pv2);
  check('换版后文本未变的确认保留（sc2）', !swOk.pending.some((p) => p.actorId === chenId && p.sceneId === sc2));
  check('换版后新增台词的场次需确认（sc1）', swOk.pending.some((p) => p.actorId === chenId && p.sceneId === sc1));

  // RH_D 固定 v2 -> v3：sc2 在 v3 无台词 -> 既有安排待调整，不计入冲突
  const rhD = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练D' }, 201)).id;
  await J(`/api/rehearsals/${rhD}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  const schD1 = (await J(`/api/rehearsals/${rhD}/schedules`, director, { sceneId: sc2, startAt: '2030-01-04T10:00:00+08:00', endAt: '2030-01-04T11:00:00+08:00' }, 201)).schedule;
  const swD = await J(`/api/rehearsals/${rhD}/switch-version`, director, { versionId: pv3 }, 200);
  check('换版后无台词的既有安排标为待调整', swD.needsAdjustmentSchedules.includes(schD1.id), JSON.stringify(swD.needsAdjustmentSchedules));
  // 待调整不计入冲突：林晚在 schD1 同时段可另排
  const schA6 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-04T10:30:00+08:00', endAt: '2030-01-04T11:30:00+08:00' }, 201)).schedule;
  check('待调整时段不计入冲突', !!schA6.id);
  // 待调整 -> 调整回有台词场次但时间重叠 -> 409；调到空档 -> 恢复有效
  await req('PATCH', `/api/rehearsals/${rhD}/schedules/${schD1.id}`, director, { sceneId: sc1, startAt: '2030-01-04T10:00:00+08:00', endAt: '2030-01-04T11:00:00+08:00' }, 409);
  const adjD = await req('PATCH', `/api/rehearsals/${rhD}/schedules/${schD1.id}`, director, { sceneId: sc1, startAt: '2030-01-04T12:00:00+08:00', endAt: '2030-01-04T13:00:00+08:00' }, 200);
  check('待调整经调整后恢复有效', adjD.schedule.status === 'active' && adjD.schedule.sceneId === sc1);

  console.log('— 日程：取消与可见性 —');
  await J(`/api/rehearsals/${rhD}/schedules/${schD1.id}/cancel`, director, {}, 200);
  await J(`/api/rehearsals/${rhD}/schedules/${schD1.id}/cancel`, director, {}, 400);
  check('取消幂等保护（重复取消 400）', true);
  // RH_E：制造一个仍处于待调整的安排，验证导演可见、演员不可见
  const rhE = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练E' }, 201)).id;
  await J(`/api/rehearsals/${rhE}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  const schE1 = (await J(`/api/rehearsals/${rhE}/schedules`, director, { sceneId: sc2, startAt: '2030-01-05T10:00:00+08:00', endAt: '2030-01-05T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhE}/switch-version`, director, { versionId: pv3 }, 200);
  const dirViewE = await G(`/api/rehearsals/${rhE}/schedules`, director);
  check('导演可见待调整安排', dirViewE.schedules.some((s) => s.id === schE1.id && s.status === 'needs_adjustment'));
  const dirViewEf = await G(`/api/rehearsals/${rhE}/schedules?status=needs_adjustment`, director);
  check('导演可按状态过滤日程', dirViewEf.schedules.length === 1 && dirViewEf.schedules[0].id === schE1.id);
  const dirViewD = await G(`/api/rehearsals/${rhD}/schedules`, director);
  check('导演可见已取消安排', dirViewD.schedules.some((s) => s.id === schD1.id && s.status === 'cancelled'));
  // 演员只看自己当前参与的有效时段
  const linViewA = await G(`/api/rehearsals/${rhA}/schedules`, lin);
  check('演员可见自己参与的有效时段', linViewA.schedules.length > 0 && linViewA.schedules.every((s) => s.status === 'active'));
  check('演员时段含本人角色', linViewA.schedules.every((s) => s.myRoles.some((r) => r.roleId === roleA)));
  const linViewD = await G(`/api/rehearsals/${rhD}/schedules`, lin);
  check('演员看不到已取消时段', linViewD.schedules.length === 0);
  const linViewE = await G(`/api/rehearsals/${rhE}/schedules`, lin);
  check('演员看不到待调整时段', linViewE.schedules.length === 0);
  await G(`/api/rehearsals/${rhC}/schedules`, lin, 403);
  await J(`/api/rehearsals/${rhA}/schedules/${schA1.id}/cancel`, lin, {}, 403);
  await req('PATCH', `/api/rehearsals/${rhA}/schedules/${schA1.id}`, lin, { startAt: '2030-01-01T09:00:00+08:00' }, 403);
  check('未派角演员查看 403；演员不能调整/取消日程', true);

  console.log('— 日程：批量调整入参校验（重复/跨排练/已取消/无台词/无效时间/空批次）—');
  const rhF = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '批量排练F' }, 201)).id;
  await J(`/api/rehearsals/${rhF}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhF}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const f1 = (await J(`/api/rehearsals/${rhF}/schedules`, director, { sceneId: sc1, startAt: '2032-01-01T10:00:00+08:00', endAt: '2032-01-01T11:00:00+08:00' }, 201)).schedule;
  const f2 = (await J(`/api/rehearsals/${rhF}/schedules`, director, { sceneId: sc2, startAt: '2032-01-01T11:00:00+08:00', endAt: '2032-01-01T12:00:00+08:00' }, 201)).schedule;
  const f3 = (await J(`/api/rehearsals/${rhF}/schedules`, director, { sceneId: sc1, startAt: '2032-01-03T10:00:00+08:00', endAt: '2032-01-03T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhF}/schedules/${f3.id}/cancel`, director, {}, 200);
  const batchUrl = `/api/rehearsals/${rhF}/schedules/batch-adjust`;
  await J(batchUrl, lin, { items: [{ scheduleId: f1.id }, { scheduleId: f2.id }] }, 403);
  for (const bad of [undefined, {}, { items: 'x' }, { items: [] }, { items: [{ scheduleId: f1.id }] }]) {
    await J(batchUrl, director, bad, 400);
  }
  check('批量调整：演员 403；非数组/空批次/不足两条 400', true);
  const eDup = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-09-01T10:00:00+08:00', endAt: '2032-09-01T11:00:00+08:00' },
    { scheduleId: f1.id, startAt: '2032-09-01T11:00:00+08:00', endAt: '2032-09-01T12:00:00+08:00' },
  ] }, 400);
  check('批次内重复时段拒绝', /重复时段/.test(eDup.message), eDup.message);
  const eCross = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-09-01T10:00:00+08:00', endAt: '2032-09-01T11:00:00+08:00' },
    { scheduleId: schC1.id, startAt: '2032-09-01T11:00:00+08:00', endAt: '2032-09-01T12:00:00+08:00' },
  ] }, 400);
  check('跨排练时段拒绝', /不属于排练/.test(eCross.message), eCross.message);
  const eCancelled = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-09-01T10:00:00+08:00', endAt: '2032-09-01T11:00:00+08:00' },
    { scheduleId: f3.id, startAt: '2032-09-01T11:00:00+08:00', endAt: '2032-09-01T12:00:00+08:00' },
  ] }, 400);
  check('已取消时段拒绝', /已取消/.test(eCancelled.message), eCancelled.message);
  const eNoLines = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, sceneId: scEmpty, startAt: '2032-09-01T10:00:00+08:00', endAt: '2032-09-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-09-02T10:00:00+08:00', endAt: '2032-09-02T11:00:00+08:00' },
  ] }, 400);
  check('无台词场次拒绝', /没有台词/.test(eNoLines.message), eNoLines.message);
  const eNoTz = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-09-01T10:00', endAt: '2032-09-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-09-02T10:00:00+08:00', endAt: '2032-09-02T11:00:00+08:00' },
  ] }, 400);
  const eOrder = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-09-01T11:00:00+08:00', endAt: '2032-09-01T10:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-09-02T10:00:00+08:00', endAt: '2032-09-02T11:00:00+08:00' },
  ] }, 400);
  check('无时区/起止颠倒拒绝', !!eNoTz.message && !!eOrder.message);
  await J(batchUrl, director, { items: [
    { scheduleId: 99999, startAt: '2032-09-01T10:00:00+08:00', endAt: '2032-09-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-09-02T10:00:00+08:00', endAt: '2032-09-02T11:00:00+08:00' },
  ] }, 404);
  check('批次中时段不存在返回 404', true);

  console.log('— 日程：批量互换时间成功并各发一批通知 —');
  const f1seq0 = (await G(`/api/rehearsals/${rhF}/schedules/${f1.id}/notifications`, director)).current.seq;
  const f2seq0 = (await G(`/api/rehearsals/${rhF}/schedules/${f2.id}/notifications`, director)).current.seq;
  const swapped = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-01-01T11:00:00+08:00', endAt: '2032-01-01T12:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-01-01T10:00:00+08:00', endAt: '2032-01-01T11:00:00+08:00' },
  ] }, 200);
  check('批量互换返回更新时段与通知摘要', swapped.schedules.length === 2
    && swapped.notifications.length === 2
    && swapped.schedules.every((s) => s.notificationChanged && s.newNotificationId)
    && swapped.unchanged.length === 0, JSON.stringify(swapped.notifications));
  check('互换后各生成新批次（seq+1）',
    (await G(`/api/rehearsals/${rhF}/schedules/${f1.id}/notifications`, director)).current.seq === f1seq0 + 1
    && (await G(`/api/rehearsals/${rhF}/schedules/${f2.id}/notifications`, director)).current.seq === f2seq0 + 1);
  const linF = await G(`/api/rehearsals/${rhF}/schedules`, lin);
  check('演员看到互换后的时段', linF.schedules.find((s) => s.id === f1.id).startAt === '2032-01-01T03:00:00.000Z'
    && linF.schedules.find((s) => s.id === f2.id).startAt === '2032-01-01T02:00:00.000Z', JSON.stringify(linF.schedules.map((s) => s.startAt)));

  console.log('— 日程：批量最终状态冲突整批不生效（批内/不可用/跨排练）—');
  const eInternal = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-02-01T10:00:00+08:00', endAt: '2032-02-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-02-01T10:30:00+08:00', endAt: '2032-02-01T11:30:00+08:00' },
  ] }, 409);
  check('批内最终重叠返回 SCHEDULE_CONFLICT 且含演员/双方时段',
    eInternal.error === 'SCHEDULE_CONFLICT'
    && eInternal.details.conflicts.some((c) => c.actorId === linId && c.schedule.id === f1.id && c.overlapsWith.id === f2.id),
    JSON.stringify(eInternal.details));
  const afterInternal = await G(`/api/rehearsals/${rhF}/schedules`, director);
  check('批内冲突整批回滚（仍为互换后的时间）',
    afterInternal.schedules.find((s) => s.id === f1.id).startAt === '2032-01-01T03:00:00.000Z'
    && afterInternal.schedules.find((s) => s.id === f2.id).startAt === '2032-01-01T02:00:00.000Z');
  check('批内冲突不留新批次',
    (await G(`/api/rehearsals/${rhF}/schedules/${f1.id}/notifications`, director)).current.seq === f1seq0 + 1);

  const unBatch = (await J('/api/me/unavailability', lin, { startAt: '2032-03-01T09:00:00+08:00', endAt: '2032-03-01T12:00:00+08:00', reason: '批量冲突' }, 201)).unavailability;
  const eUnavail = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-03-01T10:00:00+08:00', endAt: '2032-03-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-03-02T10:00:00+08:00', endAt: '2032-03-02T11:00:00+08:00' },
  ] }, 409);
  check('撞本人不可用返回 UNAVAILABILITY_CONFLICT（演员/时段/不可用记录）',
    eUnavail.error === 'UNAVAILABILITY_CONFLICT'
    && eUnavail.details.conflicts.some((c) => c.actorId === linId && c.schedule.id === f1.id && c.unavailability.id === unBatch.id),
    JSON.stringify(eUnavail.details));
  check('不可用冲突整批回滚', (await G(`/api/rehearsals/${rhF}/schedules`, director)).schedules.find((s) => s.id === f1.id).startAt === '2032-01-01T03:00:00.000Z');
  await D(`/api/me/unavailability/${unBatch.id}`, lin, 200);

  const fCross = (await J(`/api/rehearsals/${rhC}/schedules`, director, { sceneId: sc1, startAt: '2032-04-01T10:00:00+08:00', endAt: '2032-04-01T11:00:00+08:00' }, 201)).schedule;
  const eXReh = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-04-01T10:30:00+08:00', endAt: '2032-04-01T11:30:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-04-02T10:00:00+08:00', endAt: '2032-04-02T11:00:00+08:00' },
  ] }, 409);
  check('与其他排练有效日程冲突 409 并指出对方时段',
    eXReh.error === 'SCHEDULE_CONFLICT'
    && eXReh.details.conflicts.some((c) => c.overlapsWith.id === fCross.id), JSON.stringify(eXReh.details));

  console.log('— 日程：批量端点相接允许 / 无实质变化不重发通知 —');
  const touch = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-05-01T10:00:00+08:00', endAt: '2032-05-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-05-01T11:00:00+08:00', endAt: '2032-05-01T12:00:00+08:00' },
  ] }, 200);
  check('端点相接批内不冲突', touch.schedules.length === 2);
  const f1seqTouch = (await G(`/api/rehearsals/${rhF}/schedules/${f1.id}/notifications`, director)).current.seq;
  const nochg = await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-05-01T10:00:00+08:00', endAt: '2032-05-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-05-01T11:00:00+08:00', endAt: '2032-05-01T12:00:00+08:00' },
  ] }, 200);
  check('无实质变化的批次不重发通知', nochg.notifications.length === 0
    && nochg.unchanged.length === 2
    && nochg.schedules.every((s) => s.notificationChanged === false), JSON.stringify(nochg));
  check('无变化批次后 seq 不变', (await G(`/api/rehearsals/${rhF}/schedules/${f1.id}/notifications`, director)).current.seq === f1seqTouch);

  console.log('— 日程：批量调整保持到场登记快照 —');
  const fAtt = (await J(`/api/rehearsals/${rhF}/schedules/${f1.id}/attendance`, director, {}, 201)).session;
  await J(`/api/rehearsals/${rhF}/schedules/${f1.id}/attendance/check-in`, lin, {}, 201);
  await J(batchUrl, director, { items: [
    { scheduleId: f1.id, startAt: '2032-06-01T10:00:00+08:00', endAt: '2032-06-01T11:00:00+08:00' },
    { scheduleId: f2.id, startAt: '2032-06-02T10:00:00+08:00', endAt: '2032-06-02T11:00:00+08:00' },
  ] }, 200);
  const fAttAfter = (await G(`/api/rehearsals/${rhF}/schedules/${f1.id}/attendance`, director)).session;
  check('批量改时间不回写登记快照（UTC 时段/版本/签到保留）',
    fAttAfter.startAt === fAtt.startAt && fAttAfter.versionId === fAtt.versionId
    && fAttAfter.roster.some((m) => m.actorId === linId && m.state === 'checked_in'),
    `${fAttAfter.startAt} vs ${fAtt.startAt}`);

  console.log('— 日程：待调整时段批量合法化后恢复有效并发新批次 —');
  const rhG = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '批量排练G' }, 201)).id;
  await J(`/api/rehearsals/${rhG}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhG}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const g1 = (await J(`/api/rehearsals/${rhG}/schedules`, director, { sceneId: sc2, startAt: '2032-07-01T10:00:00+08:00', endAt: '2032-07-01T11:00:00+08:00' }, 201)).schedule;
  const g2 = (await J(`/api/rehearsals/${rhG}/schedules`, director, { sceneId: sc2, startAt: '2032-07-02T10:00:00+08:00', endAt: '2032-07-02T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhG}/switch-version`, director, { versionId: pv3 }, 200);
  check('换版后两条均待调整', (await G(`/api/rehearsals/${rhG}/schedules?status=needs_adjustment`, director)).schedules.length === 2);
  // 恢复批中故意保留一处冲突 -> 整批拒绝且仍为待调整
  const eRecoverConflict = await J(`/api/rehearsals/${rhG}/schedules/batch-adjust`, director, { items: [
    { scheduleId: g1.id, sceneId: sc1, startAt: '2032-08-01T10:00:00+08:00', endAt: '2032-08-01T11:00:00+08:00' },
    { scheduleId: g2.id, sceneId: sc1, startAt: '2032-08-01T10:30:00+08:00', endAt: '2032-08-01T11:30:00+08:00' },
  ] }, 409);
  check('恢复批冲突返回 409 且整批仍待调整', eRecoverConflict.error === 'SCHEDULE_CONFLICT'
    && (await G(`/api/rehearsals/${rhG}/schedules?status=needs_adjustment`, director)).schedules.length === 2);
  const recovered = await J(`/api/rehearsals/${rhG}/schedules/batch-adjust`, director, { items: [
    { scheduleId: g1.id, sceneId: sc1, startAt: '2032-08-01T10:00:00+08:00', endAt: '2032-08-01T11:00:00+08:00' },
    { scheduleId: g2.id, sceneId: sc1, startAt: '2032-08-02T10:00:00+08:00', endAt: '2032-08-02T11:00:00+08:00' },
  ] }, 200);
  check('待调整两条批量合法化后恢复有效', recovered.schedules.length === 2
    && recovered.schedules.every((s) => s.status === 'active' && s.sceneId === sc1),
    JSON.stringify(recovered.schedules.map((s) => ({ st: s.status, sc: s.sceneId }))));
  const g1view = await G(`/api/rehearsals/${rhG}/schedules/${g1.id}/notifications`, director);
  const g2view = await G(`/api/rehearsals/${rhG}/schedules/${g2.id}/notifications`, director);
  check('恢复有效各生成新批次（seq=2，冻结新场次/版本）',
    g1view.current.seq === 2 && g1view.current.sceneId === sc1 && g1view.current.versionId === pv3
    && g2view.current.seq === 2, JSON.stringify({ a: g1view.current?.seq, b: g2view.current?.seq }));
  const linG = await G(`/api/rehearsals/${rhG}/schedules`, lin);
  check('演员重新可见恢复后的时段', linG.schedules.length === 2 && linG.schedules.every((s) => s.status === 'active'));

  console.log('— 到场登记：开启冻结名单与缺口 —');
  // 专用剧本 p3：AT1/AT2；角色 RX/RY/RZ；v1 三角在 AT1 均有台词；v2 仅改 RX 文本（场次台词仍在）
  const p3 = await J('/api/plays', director, { title: '登记测试剧' }, 201);
  const at1 = (await J(`/api/plays/${p3.id}/scenes`, director, { code: 'T1', title: '集合场' }, 201)).id;
  const at2 = (await J(`/api/plays/${p3.id}/scenes`, director, { code: 'T2', title: '走位场' }, 201)).id;
  const roleX = (await J(`/api/plays/${p3.id}/roles`, director, { code: 'RX', name: '甲' }, 201)).id;
  const roleY = (await J(`/api/plays/${p3.id}/roles`, director, { code: 'RY', name: '乙' }, 201)).id;
  const roleZ = (await J(`/api/plays/${p3.id}/roles`, director, { code: 'RZ', name: '丙' }, 201)).id;
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at1, roleId: roleX, text: '甲到场一句', seq: 1 }, 201);
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at1, roleId: roleY, text: '乙到场一句', seq: 2 }, 201);
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at1, roleId: roleZ, text: '丙到场一句', seq: 3 }, 201);
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at2, roleId: roleX, text: '甲走位一句', seq: 1 }, 201);
  const p3v1 = (await J(`/api/plays/${p3.id}/publish-initial`, director, { note: 'v1' }, 201)).version.id;
  const revX = await J(`/api/plays/${p3.id}/revisions`, director, { title: '改甲词' }, 201);
  await J(`/api/revisions/${revX.id}/items`, director, { action: 'modify', lineId: (await G(`/api/plays/${p3.id}`, director)).lines.find((l) => l.text === '甲到场一句').id, oldText: '甲到场一句', newText: '甲到场一句（改）' }, 201);
  const p3v2 = (await J(`/api/plays/${p3.id}/publish`, director, { revisionIds: [revX.id] }, 201)).newVersion.id;

  // RH_ATT1：RX=林晚、RY=陈默，RZ 未派 -> 开启时名单=[林晚,陈默]，缺口=[丙]
  const rhAtt1 = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '登记排练1' }, 201)).id;
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleY, actorId: chenId }, 201);
  const schAtt1 = (await J(`/api/rehearsals/${rhAtt1}/schedules`, director, { sceneId: at1, startAt: '2031-01-01T10:00:00+08:00', endAt: '2031-01-01T11:00:00+08:00' }, 201)).schedule;
  check('未开启时日程 attendance 为 null', schAtt1.attendance === null);
  // 越权与无效目标
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, lin, {}, 403);
  await J(`/api/rehearsals/${rhAtt1}/schedules/99999/attendance`, director, {}, 404);
  check('演员开启登记 403；日程不存在 404', true);
  const att1 = (await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director, {}, 201)).session;
  check('开启即冻结 UTC 时段与固定版本', att1.startAt === '2031-01-01T02:00:00.000Z' && att1.versionId === p3v1, JSON.stringify({ startAt: att1.startAt, versionId: att1.versionId }));
  check('名单=当时有台词且已派角的演员', att1.roster.length === 2 && att1.roster.every((m) => [linId, chenId].includes(m.actorId)), JSON.stringify(att1.roster));
  check('未派角角色列为缺口且不计应到', att1.gaps.length === 1 && att1.gaps[0].roleId === roleZ && att1.stats.expected === 2);
  check('开启时全员待签到', att1.stats.pending === 2 && att1.roster.every((m) => m.state === 'pending'));
  const attDup = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director, {}, 409);
  check('已有登记的时段不得再开（409 ATTENDANCE_EXISTS）', attDup.error === 'ATTENDANCE_EXISTS');
  // 已取消 / 待调整的时段不得开启（复用前面造好的 schD1=已取消、schE1=待调整）
  await J(`/api/rehearsals/${rhD}/schedules/${schD1.id}/attendance`, director, {}, 400);
  await J(`/api/rehearsals/${rhE}/schedules/${schE1.id}/attendance`, director, {}, 400);
  check('已取消/待调整时段开启登记被拒（400）', true);

  console.log('— 到场登记：签到幂等与名单边界 —');
  const ci1 = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, lin, {}, 201);
  check('名单内演员签到成功', ci1.checkIn.alreadyCheckedIn === false && !!ci1.checkIn.checkedInAt);
  const ci1r = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, lin, {}, 200);
  check('重试返回首次签到结果', ci1r.checkIn.alreadyCheckedIn === true && ci1r.checkIn.checkedInAt === ci1.checkIn.checkedInAt);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, zhou, {}, 403);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, director, {}, 403);
  check('非名单演员/导演签到 403', true);
  await J(`/api/rehearsals/${rhA}/schedules/${schA1.id}/attendance/check-in`, lin, {}, 404);
  check('未开启登记的时段签到 404', true);

  console.log('— 到场登记：改派/换版/调日程不回写 —');
  // 开启后才派角 RZ=周海：后来加入者不能签到；缺口仍按冻结显示
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleZ, actorId: zhouId }, 200);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, zhou, {}, 403);
  await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, zhou, 403);
  check('后来加入者不能签到、也看不了该次登记', true);
  // 改派 RY 陈默->周海：名单不回写——周海仍不能签到，陈默（冻结名单内）仍可签到
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleY, actorId: zhouId }, 200);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, zhou, {}, 403);
  const ciChen = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, chen, {}, 201);
  check('改派不回写名单：原演员仍在冻结名单可签到', ciChen.checkIn.alreadyCheckedIn === false);
  // 调整日程时间：登记内冻结的 UTC 时段不变
  await req('PATCH', `/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}`, director, { startAt: '2031-01-01T12:00:00+08:00', endAt: '2031-01-01T13:00:00+08:00' }, 200);
  const att1AfterMove = (await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director)).session;
  check('调整日程不回写冻结时段', att1AfterMove.startAt === '2031-01-01T02:00:00.000Z', att1AfterMove.startAt);
  // 换版 v1->v2（文本变化但场次台词仍在）：名单与签到不回写，登记仍冻结在 v1
  await J(`/api/rehearsals/${rhAtt1}/switch-version`, director, { versionId: p3v2 }, 200);
  const att1AfterSwitch = (await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director)).session;
  check('换版不回写名单与冻结版本', att1AfterSwitch.versionId === p3v1 && att1AfterSwitch.roster.length === 2 && att1AfterSwitch.stats.checkedIn === 2);
  check('缺口保持开启时快照', att1AfterSwitch.gaps.length === 1 && att1AfterSwitch.gaps[0].roleId === roleZ);

  console.log('— 到场登记：关闭记缺席、关闭后拒绝 —');
  // RH_ATT2：RX=林晚（RY/RZ 未派）；林晚不签到 -> 关闭后缺席 1
  const rhAtt2 = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '登记排练2' }, 201)).id;
  await J(`/api/rehearsals/${rhAtt2}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  const schAtt2 = (await J(`/api/rehearsals/${rhAtt2}/schedules`, director, { sceneId: at1, startAt: '2031-01-02T10:00:00+08:00', endAt: '2031-01-02T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance`, director, {}, 201);
  const att2Closed = (await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance/close`, director, {}, 200)).session;
  check('关闭后未签到者记缺席', att2Closed.stats.absent === 1 && att2Closed.roster[0].state === 'absent', JSON.stringify(att2Closed.stats));
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance/check-in`, lin, {}, 409);
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance/close`, director, {}, 400);
  check('关闭后签到 409、再次关闭 400', true);
  // 关闭后取消日程：仅标注取消，原统计保留
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/cancel`, director, {}, 200);
  const att2AfterCancel = (await G(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance`, director)).session;
  check('关闭后取消日程仅标注、统计保留', att2AfterCancel.scheduleCancelled === true && att2AfterCancel.status === 'closed' && att2AfterCancel.stats.absent === 1 && att2AfterCancel.stats.counted === true);

  console.log('— 到场登记：开放期取消日程 -> 作废 —');
  // RH_ATT3：RX=林晚；开启并签到后取消日程 -> 作废，痕迹保留但不计出勤
  const rhAtt3 = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '登记排练3' }, 201)).id;
  await J(`/api/rehearsals/${rhAtt3}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  const schAtt3 = (await J(`/api/rehearsals/${rhAtt3}/schedules`, director, { sceneId: at1, startAt: '2031-01-03T10:00:00+08:00', endAt: '2031-01-03T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, director, {}, 201);
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance/check-in`, lin, {}, 201);
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/cancel`, director, {}, 200);
  const att3 = (await G(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, director)).session;
  check('开放期取消日程 -> 登记作废', att3.status === 'voided');
  check('作废保留已签到痕迹但不计出勤', att3.roster[0].state === 'checked_in' && !!att3.roster[0].checkedInAt && att3.stats.counted === false && att3.stats.absent === 0, JSON.stringify(att3.stats));
  const ciVoid = await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance/check-in`, lin, {}, 409);
  check('作废后停止签到（409 ATTENDANCE_NOT_OPEN）', ciVoid.error === 'ATTENDANCE_NOT_OPEN');
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance/close`, director, {}, 400);
  check('作废的登记不能关闭', true);
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, director, {}, 400);
  check('作废（且日程已取消）后该时段不得再次开启登记', true);

  console.log('— 到场登记：可见性与日程摘要 —');
  // 导演日程列表带登记摘要；演员只见本人状态
  const dirScheds1 = await G(`/api/rehearsals/${rhAtt1}/schedules`, director);
  const sumAtt1 = dirScheds1.schedules.find((s) => s.id === schAtt1.id).attendance;
  check('导演日程列表含登记统计摘要', sumAtt1 && sumAtt1.expected === 2 && sumAtt1.checkedIn === 2, JSON.stringify(sumAtt1));
  const linScheds1 = await G(`/api/rehearsals/${rhAtt1}/schedules`, lin);
  const myAtt1 = linScheds1.schedules.find((s) => s.id === schAtt1.id).attendance;
  check('演员日程含本人登记状态', myAtt1 && myAtt1.myState === 'checked_in' && !!myAtt1.checkedInAt, JSON.stringify(myAtt1));
  // 演员详情视图：只有本人记录，没有名单/缺口
  const linAtt1 = (await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, lin)).session;
  check('演员只看本人记录（无名单/缺口字段）', linAtt1.my && linAtt1.my.state === 'checked_in' && linAtt1.roster === undefined && linAtt1.gaps === undefined);
  // 作废登记中演员的本人视图
  const linAtt3 = (await G(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, lin)).session;
  check('演员可见本人在作废登记中的签到痕迹', linAtt3.status === 'voided' && linAtt3.my.state === 'checked_in');
  // 未开启登记的日程：演员摘要为 null
  const linSchedsA = await G(`/api/rehearsals/${rhA}/schedules`, lin);
  check('未开启登记时演员摘要为 null', linSchedsA.schedules.every((s) => s.attendance === null));

  console.log('— 演员不可用时段：登记 / 校验 / 本人可见 —');
  // 导演不可用该接口
  await J('/api/me/unavailability', director, { startAt: '2030-06-01T10:00:00+08:00', endAt: '2030-06-01T11:00:00+08:00', reason: 'x' }, 403);
  await G('/api/me/unavailability', director, 403);
  // 参数校验：无时区 / 结束不晚于开始 / 缺原因
  await J('/api/me/unavailability', lin, { startAt: '2030-06-01T10:00', endAt: '2030-06-01T11:00:00+08:00', reason: 'x' }, 400);
  await J('/api/me/unavailability', lin, { startAt: '2030-06-01T11:00:00+08:00', endAt: '2030-06-01T10:00:00+08:00', reason: 'x' }, 400);
  await J('/api/me/unavailability', lin, { startAt: '2030-06-01T10:00:00+08:00', endAt: '2030-06-01T11:00:00+08:00' }, 400);
  check('不可用时段：导演 403、无时区/起止颠倒/缺原因 400', true);
  // 正常登记：带时区提交，UTC 归一化保存
  const un1 = (await J('/api/me/unavailability', lin, { startAt: '2030-06-01T10:00:00+08:00', endAt: '2030-06-01T12:00:00+08:00', reason: '家中有事' }, 201)).unavailability;
  check('登记成功且按 UTC 保存', un1.startAt === '2030-06-01T02:00:00.000Z' && un1.endAt === '2030-06-01T04:00:00.000Z' && un1.reason === '家中有事', JSON.stringify(un1));
  const linUnav = (await G('/api/me/unavailability', lin)).unavailability;
  check('演员可查看本人不可用记录', linUnav.some((u) => u.id === un1.id));
  check('他人记录互不可见', !(await G('/api/me/unavailability', chen)).unavailability.some((u) => u.id === un1.id));

  console.log('— 演员不可用时段：与本人有效日程重叠即拒 —');
  // 林晚在 RH_A 的 schA1 = 2030-01-01 10:00-11:00(+08:00)
  const unOv = await J('/api/me/unavailability', lin, { startAt: '2030-01-01T09:30:00+08:00', endAt: '2030-01-01T10:30:00+08:00', reason: '看病' }, 409);
  check('与本人参与的有效日程重叠 -> 409 UNAVAILABILITY_CONFLICT', unOv.error === 'UNAVAILABILITY_CONFLICT');
  check('冲突详情指出冲突日程', unOv.details.conflicts.some((c) => c.schedule.id === schA1.id && c.actorId === linId), JSON.stringify(unOv.details));
  // 端点相接不算重叠：schA3 = 12:00-13:00(+08:00)，登记 13:00-14:00
  const un2 = (await J('/api/me/unavailability', lin, { startAt: '2030-01-01T13:00:00+08:00', endAt: '2030-01-01T14:00:00+08:00', reason: '临时有事' }, 201)).unavailability;
  check('端点相接不算重叠', !!un2.id);
  // 已取消（schA5）与待调整（schE1）日程不参与
  const un3 = (await J('/api/me/unavailability', lin, { startAt: '2030-01-03T10:00:00+08:00', endAt: '2030-01-03T12:00:00+08:00', reason: '与已取消时段重叠' }, 201)).unavailability;
  check('已取消日程不参与冲突检测', !!un3.id);
  const un4 = (await J('/api/me/unavailability', lin, { startAt: '2030-01-05T10:00:00+08:00', endAt: '2030-01-05T11:00:00+08:00', reason: '与待调整时段重叠' }, 201)).unavailability;
  check('待调整日程不参与冲突检测', !!un4.id);
  // 非本人参与的日程不影响：周海登记与 schA1 重叠的不可用
  const unZhou = (await J('/api/me/unavailability', zhou, { startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00', reason: '与己无关' }, 201)).unavailability;
  check('非本人参与的日程不冲突', !!unZhou.id);

  console.log('— 演员不可用时段：修改与撤销 —');
  // 修改 un2 到与 schA1 重叠 -> 409，原记录不变
  const un2Bad = await req('PATCH', `/api/me/unavailability/${un2.id}`, lin, { startAt: '2030-01-01T10:30:00+08:00', endAt: '2030-01-01T11:30:00+08:00' }, 409);
  check('修改为重叠时段被拒', un2Bad.error === 'UNAVAILABILITY_CONFLICT' && un2Bad.details.conflicts.some((c) => c.schedule.id === schA1.id));
  const un2After = (await G('/api/me/unavailability', lin)).unavailability.find((u) => u.id === un2.id);
  check('修改被拒后原记录不变', un2After.startAt === un2.startAt && un2After.reason === '临时有事');
  // 只改原因
  const un2b = (await req('PATCH', `/api/me/unavailability/${un2.id}`, lin, { reason: '改成别的理由' }, 200)).unavailability;
  check('可只修改原因', un2b.reason === '改成别的理由' && un2b.startAt === un2.startAt);
  // 无效修改：起止颠倒 / 空 body
  await req('PATCH', `/api/me/unavailability/${un2.id}`, lin, { startAt: '2030-01-01T14:00:00+08:00', endAt: '2030-01-01T13:00:00+08:00' }, 400);
  await req('PATCH', `/api/me/unavailability/${un2.id}`, lin, {}, 400);
  // 他人不能改/删；不存在 404
  await req('PATCH', `/api/me/unavailability/${un2.id}`, chen, { reason: 'hack' }, 404);
  await D(`/api/me/unavailability/${un2.id}`, chen, 404);
  await D('/api/me/unavailability/99999', lin, 404);
  check('越权修改/撤销与不存在均被拒', true);
  // 撤销
  await D(`/api/me/unavailability/${un4.id}`, lin, 200);
  check('撤销成功', !(await G('/api/me/unavailability', lin)).unavailability.some((u) => u.id === un4.id));

  console.log('— 导演操作：排期/调期/派角/换版撞上不可用时段 —');
  // 排期：林晚 un3 = 2030-01-03 10:00-12:00(+08:00)；schA5 已取消、schC1 端点相接，唯撞 un3
  const beforeCnt = (await G(`/api/rehearsals/${rhA}/schedules`, director)).schedules.filter((s) => s.status === 'active').length;
  const dirOv = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-03T11:00:00+08:00', endAt: '2030-01-03T12:00:00+08:00' }, 409);
  check('排期撞演员不可用 -> 409 UNAVAILABILITY_CONFLICT', dirOv.error === 'UNAVAILABILITY_CONFLICT');
  check('返回演员、日程及不可用时段', dirOv.details.conflicts.some((c) => c.actorId === linId && c.schedule && c.unavailability && c.unavailability.id === un3.id && c.unavailability.reason === '与已取消时段重叠'), JSON.stringify(dirOv.details));
  const afterCnt = (await G(`/api/rehearsals/${rhA}/schedules`, director)).schedules.filter((s) => s.status === 'active').length;
  check('整次操作不生效（未新增日程）', beforeCnt === afterCnt);
  // 调整日程撞不可用：schA4 2030-01-02 11:00-12:00 -> 改到 01-03 11:00-12:00
  const patchOv = await req('PATCH', `/api/rehearsals/${rhA}/schedules/${schA4.id}`, director, { startAt: '2030-01-03T11:00:00+08:00', endAt: '2030-01-03T12:00:00+08:00' }, 409);
  check('调整日程撞不可用 -> 整次拒绝', patchOv.error === 'UNAVAILABILITY_CONFLICT');
  const schA4After = (await G(`/api/rehearsals/${rhA}/schedules`, director)).schedules.find((s) => s.id === schA4.id);
  check('调整未生效（时间保持原样）', schA4After.startAt === schA4.startAt && schA4After.status === 'active');
  // 日程互撞仍是 SCHEDULE_CONFLICT（无不可用干扰的时段）
  const stillSched = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:30:00+08:00', endAt: '2030-01-01T11:30:00+08:00' }, 409);
  check('日程互撞仍返回 SCHEDULE_CONFLICT', stillSched.error === 'SCHEDULE_CONFLICT');
  // 派角：RH_C 的 schC1 = 2030-01-03 10:00-11:00(+08:00)；把乙改派给林晚 -> 撞 un3
  const castOv = await J(`/api/rehearsals/${rhC}/cast`, director, { roleId: roleB, actorId: linId }, 409);
  check('派角撞不可用 -> 整次拒绝', castOv.error === 'UNAVAILABILITY_CONFLICT' && castOv.details.conflicts.some((c) => c.actorId === linId && c.unavailability.id === un3.id && c.schedule.id === schC1.id), JSON.stringify(castOv.details));
  const rhCCast = (await G(`/api/rehearsals/${rhC}`, director)).cast;
  check('派角未生效（乙仍是陈默）', rhCCast.find((c) => c.roleId === roleB).actorId === chenId);
  // 换版：RH_U 固定 v1（sc1 仅甲有台词），甲=周海；林晚登记不可用后派为乙，换 v2 使乙进入 sc1 -> 撞
  const rhU = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '不可用排练U' }, 201)).id;
  await J(`/api/rehearsals/${rhU}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  const schU1 = (await J(`/api/rehearsals/${rhU}/schedules`, director, { sceneId: sc1, startAt: '2030-02-01T10:00:00+08:00', endAt: '2030-02-01T11:00:00+08:00' }, 201)).schedule;
  // 林晚此时不是 schU1 参与者，可登记重叠不可用
  const un5 = (await J('/api/me/unavailability', lin, { startAt: '2030-02-01T10:30:00+08:00', endAt: '2030-02-01T11:30:00+08:00', reason: '换版冲突测试' }, 201)).unavailability;
  // 派乙=林晚（v1 中乙在 sc1 无台词，不撞）
  await J(`/api/rehearsals/${rhU}/cast`, director, { roleId: roleB, actorId: linId }, 201);
  const swOv = await J(`/api/rehearsals/${rhU}/switch-version`, director, { versionId: pv2 }, 409);
  check('换版使演员进入与其不可用相撞的时段 -> 整次拒绝', swOv.error === 'UNAVAILABILITY_CONFLICT' && swOv.details.conflicts.some((c) => c.actorId === linId && c.schedule.id === schU1.id && c.unavailability.id === un5.id), JSON.stringify(swOv));
  check('失败的换版不改变版本', (await G(`/api/rehearsals/${rhU}`, director)).rehearsal.versionId === pv1);
  // 撤销不可用后换版成功
  await D(`/api/me/unavailability/${un5.id}`, lin, 200);
  const swU2 = await J(`/api/rehearsals/${rhU}/switch-version`, director, { versionId: pv2 }, 200);
  check('撤销不可用后换版成功', swU2.rehearsal.versionId === pv2);

  console.log('— 不可用时段不改写已开启的到场登记 —');
  // 经历了上述登记/修改/撤销后，schAtt1 的登记仍是开启时快照
  const att1Final = (await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director)).session;
  check('登记名单与签到保持开启时快照', att1Final.roster.length === 2 && att1Final.stats.checkedIn === 2 && att1Final.versionId === p3v1, JSON.stringify(att1Final.stats));

  console.log('— 时段通知：生成 / 冻结 / 确认幂等 —');
  // 演示数据的示例日程自带一条通知批次（林晚、陈默为接收人）
  const seedNotif = await G('/api/rehearsals/1/schedules/1/notifications', director);
  check('演示数据自带通知批次', seedNotif.current && seedNotif.current.seq === 1 && seedNotif.current.stats.expected === 2, JSON.stringify(seedNotif.current));
  // 专用剧本 p4：N1（甲+乙）、N2（仅甲）；v2 改甲 N1 文本；v3 删 N2 全部台词
  const p4 = await J('/api/plays', director, { title: '通知测试剧' }, 201);
  const n1 = (await J(`/api/plays/${p4.id}/scenes`, director, { code: 'N1', title: '集结' }, 201)).id;
  const n2 = (await J(`/api/plays/${p4.id}/scenes`, director, { code: 'N2', title: '独白' }, 201)).id;
  const rnA = (await J(`/api/plays/${p4.id}/roles`, director, { code: 'NA', name: '甲' }, 201)).id;
  const rnB = (await J(`/api/plays/${p4.id}/roles`, director, { code: 'NB', name: '乙' }, 201)).id;
  await J(`/api/plays/${p4.id}/lines`, director, { sceneId: n1, roleId: rnA, text: '甲通知句一', seq: 1 }, 201);
  await J(`/api/plays/${p4.id}/lines`, director, { sceneId: n1, roleId: rnB, text: '乙通知句一', seq: 2 }, 201);
  await J(`/api/plays/${p4.id}/lines`, director, { sceneId: n2, roleId: rnA, text: '甲通知句二', seq: 1 }, 201);
  const p4v1 = (await J(`/api/plays/${p4.id}/publish-initial`, director, { note: 'v1' }, 201)).version.id;
  const revN1 = await J(`/api/plays/${p4.id}/revisions`, director, { title: '改甲通知句一' }, 201);
  await J(`/api/revisions/${revN1.id}/items`, director, { action: 'modify', lineId: (await G(`/api/plays/${p4.id}`, director)).lines.find((l) => l.text === '甲通知句一').id, oldText: '甲通知句一', newText: '甲通知句一（改）' }, 201);
  const p4v2 = (await J(`/api/plays/${p4.id}/publish`, director, { revisionIds: [revN1.id] }, 201)).newVersion.id;
  const p4detail = await G(`/api/plays/${p4.id}`, director);
  const revN2 = await J(`/api/plays/${p4.id}/revisions`, director, { title: '清空 N2' }, 201);
  await J(`/api/revisions/${revN2.id}/items`, director, { action: 'delete', lineId: p4detail.lines.find((l) => l.text === '甲通知句二').id, oldText: '甲通知句二' }, 201);
  const p4v3 = (await J(`/api/plays/${p4.id}/publish`, director, { revisionIds: [revN2.id] }, 201)).newVersion.id;

  const rhN = (await J(`/api/plays/${p4.id}/rehearsals`, director, { versionId: p4v1, name: '通知排练' }, 201)).id;
  await J(`/api/rehearsals/${rhN}/cast`, director, { roleId: rnA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhN}/cast`, director, { roleId: rnB, actorId: chenId }, 201);

  // 创建有效时段 -> 生成批次 1（冻结 UTC 时段/场次/版本/当时参与演员）
  const sn1 = (await J(`/api/rehearsals/${rhN}/schedules`, director, { sceneId: n1, startAt: '2040-01-01T10:00:00+08:00', endAt: '2040-01-01T11:00:00+08:00' }, 201)).schedule;
  check('创建时段生成通知批次', sn1.notification && sn1.notification.seq === 1 && sn1.notification.status === 'current', JSON.stringify(sn1.notification));
  check('批次待确认=当时参与演员数', sn1.notification.expected === 2 && sn1.notification.pending === 2 && sn1.notification.confirmed === 0);
  let notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('导演见当前批次待确认名单', notifView.current.recipients.length === 2 && notifView.current.recipients.every((r) => r.state === 'pending'));
  check('批次冻结 UTC 时段、场次与固定版本', notifView.current.startAt === '2040-01-01T02:00:00.000Z' && notifView.current.sceneId === n1 && notifView.current.versionId === p4v1, JSON.stringify(notifView.current));
  check('首批无历史批次', notifView.history.length === 0);
  await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, lin, 403);
  check('演员不能访问导演通知视图', true);

  // 演员：仅本人批次可见；确认幂等
  const myN1 = (await G('/api/me/schedule-notifications', lin)).notifications.find((x) => x.scheduleId === sn1.id);
  check('演员看到本人批次', myN1 && myN1.myState === 'pending' && myN1.seq === 1 && myN1.rehearsalName === '通知排练');
  check('非接收人看不到该批次', !(await G('/api/me/schedule-notifications', zhou)).notifications.some((x) => x.scheduleId === sn1.id));
  await G('/api/me/schedule-notifications', director, 403);
  const nb1 = myN1.id;
  await J('/api/schedule-notifications/99999/confirm', lin, {}, 404);
  await J(`/api/schedule-notifications/${nb1}/confirm`, zhou, {}, 403);
  await J(`/api/schedule-notifications/${nb1}/confirm`, director, {}, 403);
  check('确认：批次不存在 404 / 非接收人 403 / 导演 403', true);
  const cf1 = await J(`/api/schedule-notifications/${nb1}/confirm`, lin, {}, 201);
  check('演员确认当前批次', cf1.confirmation.alreadyConfirmed === false && !!cf1.confirmation.confirmedAt);
  const cf1r = await J(`/api/schedule-notifications/${nb1}/confirm`, lin, {}, 200);
  check('重试返回首次确认时间', cf1r.confirmation.alreadyConfirmed === true && cf1r.confirmation.confirmedAt === cf1.confirmation.confirmedAt);
  notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('导演见已确认/待确认名单', notifView.current.stats.confirmed === 1 && notifView.current.stats.pending === 1
    && notifView.current.recipients.find((r) => r.actorId === linId).state === 'confirmed'
    && notifView.current.recipients.find((r) => r.actorId === chenId).state === 'pending', JSON.stringify(notifView.current.stats));

  // 无实质变化不重复生成：相同内容的调整 / 派角不变
  await req('PATCH', `/api/rehearsals/${rhN}/schedules/${sn1.id}`, director, { sceneId: n1, startAt: '2040-01-01T10:00:00+08:00', endAt: '2040-01-01T11:00:00+08:00' }, 200);
  await J(`/api/rehearsals/${rhN}/cast`, director, { roleId: rnA, actorId: linId }, 200); //  unchanged
  notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('无实质变化不重复生成批次', notifView.current.id === nb1 && notifView.history.length === 0);

  // 调整起止 -> 新批次；旧批次保留但不计当前待确认；过期批次确认被拒
  await req('PATCH', `/api/rehearsals/${rhN}/schedules/${sn1.id}`, director, { endAt: '2040-01-01T12:00:00+08:00' }, 200);
  notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('调整起止生成新批次', notifView.current.seq === 2 && notifView.current.id !== nb1);
  check('旧批次保留为历史（已被取代）', notifView.history.length === 1 && notifView.history[0].id === nb1 && notifView.history[0].status === 'superseded');
  check('新批次全员重新待确认', notifView.current.stats.pending === 2 && notifView.current.stats.confirmed === 0);
  const cfOld = await J(`/api/schedule-notifications/${nb1}/confirm`, chen, {}, 409);
  check('过期批次确认被拒（409 NOTIFICATION_EXPIRED）', cfOld.error === 'NOTIFICATION_EXPIRED');

  // 演员日程列表带通知摘要；确认新批次
  const linSchedN = (await G(`/api/rehearsals/${rhN}/schedules`, lin)).schedules.find((s) => s.id === sn1.id);
  check('演员日程含通知摘要', linSchedN.notification && linSchedN.notification.myState === 'pending' && linSchedN.notification.seq === 2, JSON.stringify(linSchedN.notification));
  const nb2 = linSchedN.notification.id;
  await J(`/api/schedule-notifications/${nb2}/confirm`, lin, {}, 201);
  await J(`/api/schedule-notifications/${nb2}/confirm`, chen, {}, 201);

  // 派角/撤派改变参与演员 -> 新批次；被撤派演员不在新批次接收名单
  await J(`/api/rehearsals/${rhN}/cast`, director, { roleId: rnB, actorId: zhouId }, 200);
  notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('改派生成新批次且接收人随之变化', notifView.current.seq === 3
    && notifView.current.recipients.some((r) => r.actorId === zhouId)
    && !notifView.current.recipients.some((r) => r.actorId === chenId), JSON.stringify(notifView.current.recipients));
  await J(`/api/schedule-notifications/${notifView.current.id}/confirm`, chen, {}, 403);
  check('被撤派演员不能确认新批次', true);
  await D(`/api/rehearsals/${rhN}/cast/${rnB}`, director, 200);
  notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('撤派生成新批次（仅剩余参与者）', notifView.current.seq === 4 && notifView.current.recipients.length === 1 && notifView.current.recipients[0].actorId === linId);

  // 显式换版 -> 版本变化生成新批次（冻结新版本）
  await J(`/api/rehearsals/${rhN}/switch-version`, director, { versionId: p4v2 }, 200);
  notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('显式换版生成新批次（冻结新版本）', notifView.current.seq === 5 && notifView.current.versionId === p4v2);

  // 取消时段 -> 不再待确认；确认被拒；摘要不计待确认
  const nb5 = notifView.current.id;
  await J(`/api/rehearsals/${rhN}/schedules/${sn1.id}/cancel`, director, {}, 200);
  notifView = await G(`/api/rehearsals/${rhN}/schedules/${sn1.id}/notifications`, director);
  check('取消后无当前批次', notifView.current === null);
  check('取消后批次标为失效并保留在历史', notifView.history.some((b) => b.id === nb5 && b.status === 'inactive'));
  const cfCancelled = await J(`/api/schedule-notifications/${nb5}/confirm`, lin, {}, 409);
  check('取消后确认被拒（过期）', cfCancelled.error === 'NOTIFICATION_EXPIRED');
  const dirSchedN = (await G(`/api/rehearsals/${rhN}/schedules`, director)).schedules.find((s) => s.id === sn1.id);
  check('取消时段摘要不计待确认', dirSchedN.notification.status === 'inactive' && dirSchedN.notification.pending === 0, JSON.stringify(dirSchedN.notification));

  console.log('— 时段通知：待调整/恢复、冲突不留批次 —');
  // RH_N2 固定 v1，甲=林晚；sn2 排在 N2（v3 中 N2 无台词）
  const rhN2 = (await J(`/api/plays/${p4.id}/rehearsals`, director, { versionId: p4v1, name: '通知排练2' }, 201)).id;
  await J(`/api/rehearsals/${rhN2}/cast`, director, { roleId: rnA, actorId: linId }, 201);
  const sn2 = (await J(`/api/rehearsals/${rhN2}/schedules`, director, { sceneId: n2, startAt: '2040-02-01T10:00:00+08:00', endAt: '2040-02-01T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhN2}/switch-version`, director, { versionId: p4v3 }, 200);
  let notifView2 = await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/notifications`, director);
  check('待调整时段不再待确认', notifView2.current === null && notifView2.history.some((b) => b.status === 'inactive'));
  // 恢复有效 -> 生成新批次
  await req('PATCH', `/api/rehearsals/${rhN2}/schedules/${sn2.id}`, director, { sceneId: n1, startAt: '2040-02-01T12:00:00+08:00', endAt: '2040-02-01T13:00:00+08:00' }, 200);
  notifView2 = await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/notifications`, director);
  check('恢复有效时生成新批次', notifView2.current && notifView2.current.seq === 2 && notifView2.current.sceneId === n1 && notifView2.current.versionId === p4v3, JSON.stringify(notifView2.current));

  // 排期冲突导致调整失败 -> 不留新批次
  const sn3 = (await J(`/api/rehearsals/${rhN2}/schedules`, director, { sceneId: n1, startAt: '2040-02-01T14:00:00+08:00', endAt: '2040-02-01T15:00:00+08:00' }, 201)).schedule;
  const sn3Seq = (await G(`/api/rehearsals/${rhN2}/schedules/${sn3.id}/notifications`, director)).current.seq;
  await req('PATCH', `/api/rehearsals/${rhN2}/schedules/${sn3.id}`, director, { startAt: '2040-02-01T12:30:00+08:00', endAt: '2040-02-01T13:30:00+08:00' }, 409);
  check('排期冲突导致调整失败时不留新批次', (await G(`/api/rehearsals/${rhN2}/schedules/${sn3.id}/notifications`, director)).current.seq === sn3Seq);

  // 不可用冲突导致创建失败 -> 不留批次（演员批次总数不变）
  const unN1 = (await J('/api/me/unavailability', lin, { startAt: '2040-02-02T10:00:00+08:00', endAt: '2040-02-02T12:00:00+08:00', reason: '通知冲突测试' }, 201)).unavailability;
  const notifCntBefore = (await G('/api/me/schedule-notifications', lin)).notifications.length;
  await J(`/api/rehearsals/${rhN2}/schedules`, director, { sceneId: n1, startAt: '2040-02-02T10:30:00+08:00', endAt: '2040-02-02T11:30:00+08:00' }, 409);
  check('不可用冲突导致创建失败时不留批次', (await G('/api/me/schedule-notifications', lin)).notifications.length === notifCntBefore);
  await D(`/api/me/unavailability/${unN1.id}`, lin, 200);

  // 派角撞不可用 -> 整次失败不留批次；解除后派角成功并生成新批次
  const unN2 = (await J('/api/me/unavailability', chen, { startAt: '2040-02-01T12:00:00+08:00', endAt: '2040-02-01T13:00:00+08:00', reason: '派角冲突测试' }, 201)).unavailability;
  const sn2Seq = (await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/notifications`, director)).current.seq;
  await J(`/api/rehearsals/${rhN2}/cast`, director, { roleId: rnB, actorId: chenId }, 409);
  check('派角撞不可用失败时不留新批次', (await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/notifications`, director)).current.seq === sn2Seq);
  await D(`/api/me/unavailability/${unN2.id}`, chen, 200);
  await J(`/api/rehearsals/${rhN2}/cast`, director, { roleId: rnB, actorId: chenId }, 201);
  check('冲突解除后派角成功并生成新批次', (await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/notifications`, director)).current.seq === sn2Seq + 1);

  // 换版撞不可用 -> 整次失败不留批次（p2：v2 让乙进入 sc1）
  const rhW = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '通知排练W' }, 201)).id;
  await J(`/api/rehearsals/${rhW}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  const schW1 = (await J(`/api/rehearsals/${rhW}/schedules`, director, { sceneId: sc1, startAt: '2040-04-01T10:00:00+08:00', endAt: '2040-04-01T11:00:00+08:00' }, 201)).schedule;
  let notifW = await G(`/api/rehearsals/${rhW}/schedules/${schW1.id}/notifications`, director);
  check('当前版本无台词角色不进批次接收人', notifW.current.recipients.length === 1 && notifW.current.recipients[0].actorId === zhouId);
  await J(`/api/rehearsals/${rhW}/cast`, director, { roleId: roleB, actorId: linId }, 201);
  check('派角未改变参与者时不重复生成批次', (await G(`/api/rehearsals/${rhW}/schedules/${schW1.id}/notifications`, director)).current.seq === 1);
  const unW = (await J('/api/me/unavailability', lin, { startAt: '2040-04-01T10:30:00+08:00', endAt: '2040-04-01T11:30:00+08:00', reason: '换版通知测试' }, 201)).unavailability;
  await J(`/api/rehearsals/${rhW}/switch-version`, director, { versionId: pv2 }, 409);
  check('换版失败（不可用冲突）不留新批次', (await G(`/api/rehearsals/${rhW}/schedules/${schW1.id}/notifications`, director)).current.seq === 1);
  await D(`/api/me/unavailability/${unW.id}`, lin, 200);
  await J(`/api/rehearsals/${rhW}/switch-version`, director, { versionId: pv2 }, 200);
  notifW = await G(`/api/rehearsals/${rhW}/schedules/${schW1.id}/notifications`, director);
  check('换版成功生成新批次（新版本+新参与演员）', notifW.current.seq === 2 && notifW.current.versionId === pv2 && notifW.current.recipients.some((r) => r.actorId === linId), JSON.stringify(notifW.current));

  console.log('— 时段通知不影响签到名单与逐场确认 —');
  // sn2（rhN2，v3，参与者 林晚+陈默）：开启登记并签到，再做通知批次变更
  await J(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/attendance`, director, {}, 201);
  await J(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/attendance/check-in`, lin, {}, 201);
  await J(`/api/rehearsals/${rhN2}/confirm`, lin, { roleId: rnA, sceneId: n1 }, 200);
  const sn2SeqBefore = (await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/notifications`, director)).current.seq;
  await req('PATCH', `/api/rehearsals/${rhN2}/schedules/${sn2.id}`, director, { startAt: '2040-02-01T16:00:00+08:00', endAt: '2040-02-01T17:00:00+08:00' }, 200);
  check('调整时段生成新通知批次', (await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/notifications`, director)).current.seq === sn2SeqBefore + 1);
  const attSn2 = (await G(`/api/rehearsals/${rhN2}/schedules/${sn2.id}/attendance`, director)).session;
  check('通知批次变化不改写签到名单与冻结快照', attSn2.roster.length === 2 && attSn2.stats.checkedIn === 1 && attSn2.versionId === p4v3 && attSn2.startAt === '2040-02-01T04:00:00.000Z', JSON.stringify(attSn2.stats));
  const rhN2View = await G(`/api/rehearsals/${rhN2}`, director);
  check('台词逐场确认不受通知影响', !rhN2View.pending.some((p) => p.actorId === linId && p.sceneId === n1));

  console.log('— 批量派角：入参校验（重复角色/跨剧角色/无效演员/不足两条）—');
  const rhBC = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '批量派角排练' }, 201)).id;
  const batchCastUrl = `/api/rehearsals/${rhBC}/cast/batch`;
  await J(batchCastUrl, lin, { items: [{ roleId: roleA, actorId: linId }, { roleId: roleB, actorId: chenId }] }, 403);
  await J('/api/rehearsals/99999/cast/batch', director, { items: [{ roleId: roleA, actorId: linId }, { roleId: roleB, actorId: chenId }] }, 404);
  for (const bad of [undefined, {}, { items: 'x' }, { items: [] }, { items: [{ roleId: roleA, actorId: linId }] }]) {
    await J(batchCastUrl, director, bad, 400);
  }
  check('批量派角：演员 403；排练不存在 404；非数组/空批次/不足两条 400', true);
  const eDupRole = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: linId }, { roleId: roleA, actorId: chenId },
  ] }, 400);
  check('批次内重复角色拒绝', /重复角色/.test(eDupRole.message), eDupRole.message);
  const eCrossRole = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: linId }, { roleId: keeperRole, actorId: chenId },
  ] }, 400);
  check('跨剧角色拒绝', /不属于该剧/.test(eCrossRole.message), eCrossRole.message);
  const eNoRole = await J(batchCastUrl, director, { items: [
    { roleId: 99999, actorId: linId }, { roleId: roleB, actorId: chenId },
  ] }, 400);
  check('不存在的角色拒绝', /角色 #99999 不存在/.test(eNoRole.message), eNoRole.message);
  const dirId = (await G('/api/me', director)).user.id;
  const eBadActor1 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: 99999 }, { roleId: roleB, actorId: chenId },
  ] }, 400);
  const eBadActor2 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: dirId }, { roleId: roleB, actorId: chenId },
  ] }, 400);
  const eBadActor3 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: 'x' }, { roleId: roleB, actorId: chenId },
  ] }, 400);
  check('无效演员（不存在/非演员/非整数）拒绝',
    /演员 #99999/.test(eBadActor1.message) && /演员/.test(eBadActor2.message) && /actorId/.test(eBadActor3.message),
    `${eBadActor1.message} | ${eBadActor2.message} | ${eBadActor3.message}`);
  check('入参校验失败不产生任何派角', (await G(`/api/rehearsals/${rhBC}`, director)).cast.length === 0);

  console.log('— 批量派角：整批生效、只更新变更项、确认规则 —');
  // 初始：甲=林晚、乙=陈默（单条接口）；林晚确认甲 sc1/sc2，陈默确认乙 sc2
  await J(`/api/rehearsals/${rhBC}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhBC}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  await J(`/api/rehearsals/${rhBC}/confirm`, lin, { roleId: roleA, sceneId: sc1 }, 200);
  await J(`/api/rehearsals/${rhBC}/confirm`, lin, { roleId: roleA, sceneId: sc2 }, 200);
  await J(`/api/rehearsals/${rhBC}/confirm`, chen, { roleId: roleB, sceneId: sc2 }, 200);
  // 有效时段 + 到场登记快照（后续批量派角不得改写）
  const bcS1 = (await J(`/api/rehearsals/${rhBC}/schedules`, director, { sceneId: sc1, startAt: '2033-01-01T10:00:00+08:00', endAt: '2033-01-01T11:00:00+08:00' }, 201)).schedule;
  const bcAtt0 = (await J(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/attendance`, director, {}, 201)).session;
  await J(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/attendance/check-in`, lin, {}, 201);
  // 整批 1：甲维持林晚（unchanged）+ 乙改派周海（reassigned）
  const bc1 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: linId }, { roleId: roleB, actorId: zhouId },
  ] }, 200);
  check('整批结果逐条返回动作（unchanged/reassigned）',
    bc1.results.find((x) => x.roleId === roleA).action === 'unchanged'
    && bc1.results.find((x) => x.roleId === roleB).action === 'reassigned'
    && bc1.results.find((x) => x.roleId === roleB).fromActorId === chenId
    && bc1.changed === 1 && bc1.unchanged.includes(roleA), JSON.stringify(bc1.results));
  check('未变派角的确认继续有效（林晚无待确认）', !bc1.pending.some((p) => p.actorId === linId), JSON.stringify(bc1.pending));
  const bc1Zhou = bc1.pending.filter((p) => p.actorId === zhouId);
  check('改派后新演员按逐场确认规则重确（乙 sc1/sc2）', bc1Zhou.length === 2
    && bc1Zhou.find((p) => p.sceneId === sc2).reason.includes('改派'), JSON.stringify(bc1Zhou));
  check('原演员历史确认保留但不计入（陈默不在待确认）', !bc1.pending.some((p) => p.actorId === chenId));
  const bcNotif1 = await G(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/notifications`, director);
  // 整批 2：甲改派周海 + 乙撤派（actorId 为空）
  const bc2 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: zhouId }, { roleId: roleB, actorId: null },
  ] }, 200);
  const bcNotif2 = await G(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/notifications`, director);
  check('整批支持改派+撤派混合',
    bc2.results.find((x) => x.roleId === roleA).action === 'reassigned'
    && bc2.results.find((x) => x.roleId === roleB).action === 'unassigned'
    && bc2.changed === 2, JSON.stringify(bc2.results));
  check('响应含整批最终派角（仅剩甲=周海）', bc2.cast.length === 1 && bc2.cast[0].actorId === zhouId, JSON.stringify(bc2.cast));
  check('撤派角色不再产生待确认', !bc2.pending.some((p) => p.roleId === roleB));
  // 整批 3：全部维持现状（actorId 空串同样表示撤派/不派）-> 全部 unchanged
  const bc3 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: zhouId }, { roleId: roleB, actorId: '' },
  ] }, 200);
  check('无变化批次全部 unchanged 且 changed=0', bc3.changed === 0 && bc3.unchanged.length === 2
    && bc3.results.every((x) => x.action === 'unchanged'), JSON.stringify(bc3.results));

  console.log('— 批量派角：通知按最终名单仅生成必要新批次、签到快照不变 —');
  check('整批 1（参与者 林晚+陈默→林晚+周海）生成新批次', bc1.notifications.length === 1
    && bc1.notifications[0].scheduleId === bcS1.id && bcNotif1.current.seq === 2
    && bcNotif1.current.recipients.some((r) => r.actorId === zhouId)
    && bcNotif1.current.recipients.some((r) => r.actorId === linId)
    && !bcNotif1.current.recipients.some((r) => r.actorId === chenId), JSON.stringify(bcNotif1.current.recipients));
  check('整批 2（→仅周海）再生成新批次', bc2.notifications.length === 1
    && bcNotif2.current.seq === 3
    && bcNotif2.current.recipients.length === 1 && bcNotif2.current.recipients[0].actorId === zhouId);
  const bcNotif3 = await G(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/notifications`, director);
  check('无实质变化的整批不生成新批次', bc3.notifications.length === 0 && bcNotif3.current.seq === 3);
  const bcAtt1 = (await G(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/attendance`, director)).session;
  check('批量派角不改写已开启的签到快照', bcAtt1.roster.length === 2
    && bcAtt1.roster.some((m) => m.actorId === linId && m.state === 'checked_in')
    && bcAtt1.startAt === bcAtt0.startAt && bcAtt1.versionId === bcAtt0.versionId, JSON.stringify(bcAtt1.stats));

  console.log('— 批量派角：与其他有效日程重叠 -> 409 SCHEDULE_CONFLICT 整批不生效 —');
  // RH_BC2：甲=陈默，bcS2 = 2033-02-01 10:00-11:00；rhBC 的 bcS3 = 同日 10:30-11:30（当前参与者仅周海）
  const rhBC2 = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '批量派角排练2' }, 201)).id;
  await J(`/api/rehearsals/${rhBC2}/cast`, director, { roleId: roleA, actorId: chenId }, 201);
  const bcS2 = (await J(`/api/rehearsals/${rhBC2}/schedules`, director, { sceneId: sc1, startAt: '2033-02-01T10:00:00+08:00', endAt: '2033-02-01T11:00:00+08:00' }, 201)).schedule;
  const bcS3 = (await J(`/api/rehearsals/${rhBC}/schedules`, director, { sceneId: sc1, startAt: '2033-02-01T10:30:00+08:00', endAt: '2033-02-01T11:30:00+08:00' }, 201)).schedule;
  const bcSeqBefore = (await G(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/notifications`, director)).current.seq;
  const eBcSched = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: chenId }, { roleId: roleB, actorId: linId },
  ] }, 409);
  check('整批最终派角与其他有效日程重叠 -> 409 且 details.conflicts 指出双方时段',
    eBcSched.error === 'SCHEDULE_CONFLICT'
    && eBcSched.details.conflicts.some((c) => c.actorId === chenId && c.schedule.id === bcS3.id && c.overlapsWith.id === bcS2.id),
    JSON.stringify(eBcSched.details));
  const bcCastAfter = (await G(`/api/rehearsals/${rhBC}`, director)).cast;
  check('冲突整批不生效（派角保持原样）', bcCastAfter.length === 1 && bcCastAfter[0].actorId === zhouId);
  check('冲突失败不留新通知批次', (await G(`/api/rehearsals/${rhBC}/schedules/${bcS1.id}/notifications`, director)).current.seq === bcSeqBefore);
  // 取消对方时段后同一批次成功（端点相接允许：bcS5 与 bcS1 在 11:00 相接）
  await J(`/api/rehearsals/${rhBC2}/schedules/${bcS2.id}/cancel`, director, {}, 200);
  const bc4 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: linId }, { roleId: roleB, actorId: chenId },
  ] }, 200);
  check('冲突解除后整批成功', bc4.changed === 2 && bc4.cast.length === 2);

  console.log('— 批量派角：撞本人不可用时段 -> 409 UNAVAILABILITY_CONFLICT 整批不生效 —');
  const bcS4 = (await J(`/api/rehearsals/${rhBC}/schedules`, director, { sceneId: sc2, startAt: '2033-03-01T10:30:00+08:00', endAt: '2033-03-01T11:30:00+08:00' }, 201)).schedule;
  // 周海此时不是任何 2033-03 时段的参与者，可登记不可用
  const unBC = (await J('/api/me/unavailability', zhou, { startAt: '2033-03-01T09:00:00+08:00', endAt: '2033-03-01T12:00:00+08:00', reason: '批量派角冲突测试' }, 201)).unavailability;
  const eBcUnav = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: zhouId }, { roleId: roleB, actorId: linId },
  ] }, 409);
  check('整批最终派角撞本人不可用 -> 409 且 details.conflicts 含不可用时段',
    eBcUnav.error === 'UNAVAILABILITY_CONFLICT'
    && eBcUnav.details.conflicts.some((c) => c.actorId === zhouId && c.schedule.id === bcS4.id && c.unavailability.id === unBC.id),
    JSON.stringify(eBcUnav.details));
  const bcCastAfter2 = (await G(`/api/rehearsals/${rhBC}`, director)).cast;
  check('不可用冲突整批不生效', bcCastAfter2.find((c) => c.roleId === roleA).actorId === linId
    && bcCastAfter2.find((c) => c.roleId === roleB).actorId === chenId);
  await D(`/api/me/unavailability/${unBC.id}`, zhou, 200);
  const bc5 = await J(batchCastUrl, director, { items: [
    { roleId: roleA, actorId: zhouId }, { roleId: roleB, actorId: linId },
  ] }, 200);
  check('撤销不可用后整批成功', bc5.cast.find((c) => c.roleId === roleA).actorId === zhouId);

  console.log('— 批量派角：端点相接允许；原单条接口保持可用 —');
  // RH_BC3：bcS5 = 2033-01-01 11:00-12:00，与 bcS1（10:00-11:00，参与者周海+林晚）端点相接
  const rhBC3 = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '批量派角排练3' }, 201)).id;
  await J(`/api/rehearsals/${rhBC3}/cast`, director, { roleId: roleA, actorId: chenId }, 201);
  const bcS5 = (await J(`/api/rehearsals/${rhBC3}/schedules`, director, { sceneId: sc1, startAt: '2033-01-01T11:00:00+08:00', endAt: '2033-01-01T12:00:00+08:00' }, 201)).schedule;
  const bc6 = await J(`/api/rehearsals/${rhBC3}/cast/batch`, director, { items: [
    { roleId: roleA, actorId: zhouId }, { roleId: roleB, actorId: chenId },
  ] }, 200);
  check('端点相接不算冲突（周海 11:00 相接另一时段）', bc6.cast.find((c) => c.roleId === roleA).actorId === zhouId && !!bcS5.id);
  // 原单条派角/撤派接口语义不变
  await J(`/api/rehearsals/${rhBC}/cast`, director, { roleId: roleB, actorId: chenId }, 200);
  await D(`/api/rehearsals/${rhBC}/cast/${roleB}`, director, 200);
  check('原单条派角/撤派接口保持可用', true);

  console.log('— 换版预演：确认/日程/参与者与通知接收人变化、只读 —');
  // RH_P 固定 pv2：甲=林晚、乙=陈默；sc1/sc2 各一段日程；林晚确认 sc1/sc2（甲在两场均有台词）
  const rhP = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '预演排练P' }, 201)).id;
  await J(`/api/rehearsals/${rhP}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhP}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const sp1 = (await J(`/api/rehearsals/${rhP}/schedules`, director, { sceneId: sc1, startAt: '2034-01-01T10:00:00+08:00', endAt: '2034-01-01T11:00:00+08:00' }, 201)).schedule;
  const sp2 = (await J(`/api/rehearsals/${rhP}/schedules`, director, { sceneId: sc2, startAt: '2034-01-02T10:00:00+08:00', endAt: '2034-01-02T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhP}/confirm`, lin, { roleId: roleA, sceneId: sc1 }, 200);
  await J(`/api/rehearsals/${rhP}/confirm`, lin, { roleId: roleA, sceneId: sc2 }, 200);

  // 预演 pv2 -> pv3（pv3 删除了 sc2 全部台词）
  const prevP = await J(`/api/rehearsals/${rhP}/switch-version/preview`, director, { versionId: pv3 }, 200);
  check('预演返回令牌与版本信息', !!prevP.previewToken && prevP.fromVersion.id === pv2 && prevP.toVersion.id === pv3);
  check('预演：文本未变的确认保留（sc1 甲）', prevP.confirmations.kept.some((c) => c.actorId === linId && c.sceneId === sc1), JSON.stringify(prevP.confirmations));
  check('预演：无台词场次的确认将重做（sc2 甲）', prevP.confirmations.redone.some((c) => c.actorId === linId && c.sceneId === sc2));
  const prevSp1 = prevP.schedules.find((s) => s.id === sp1.id);
  const prevSp2 = prevP.schedules.find((s) => s.id === sp2.id);
  check('预演：sc1 日程继续有效、sc2 日程将转待调整',
    prevSp1?.afterStatus === 'active' && prevSp2?.afterStatus === 'needs_adjustment' && prevP.needsAdjustmentSchedules.includes(sp2.id));
  check('预演：转待调整日程参与者将退出、当前通知批次将失效',
    prevSp2.participantsRemoved.length === 2 && prevSp2.notification.willBecomeInactive === true);
  check('预演：继续有效日程将生成新通知批次', prevSp1.notification.willGenerateBatch === true);
  check('预演：无冲突可提交', prevP.canCommit === true && prevP.conflicts.schedule.length === 0 && prevP.conflicts.unavailability.length === 0);

  // 预演为只读：版本/确认/日程/通知均不变
  const rhPAfterPrev = await G(`/api/rehearsals/${rhP}`, director);
  check('预演不改写排练版本与确认', rhPAfterPrev.rehearsal.versionId === pv2 && !rhPAfterPrev.pending.some((p) => p.actorId === linId));
  check('预演不改写日程状态', (await G(`/api/rehearsals/${rhP}/schedules`, director)).schedules.every((s) => s.status === 'active'));
  const sp1Notif0 = await G(`/api/rehearsals/${rhP}/schedules/${sp1.id}/notifications`, director);
  check('预演不生成新通知批次', sp1Notif0.current.seq === 1 && sp1Notif0.history.length === 0);
  // 越权与无效目标
  await J(`/api/rehearsals/${rhP}/switch-version/preview`, lin, { versionId: pv3 }, 403);
  await J(`/api/rehearsals/${rhP}/switch-version/preview`, director, { versionId: 99999 }, 400);
  await J(`/api/rehearsals/${rhP}/switch-version/preview`, director, { versionId: pv2 }, 400);
  await J(`/api/rehearsals/${rhP}/switch-version/preview`, director, {}, 400);
  check('预演：演员 403；无效版本/当前版本/缺参 400', true);

  console.log('— 凭预演提交换版：成功与预演一致、签到快照不变 —');
  const commitP = await J(`/api/rehearsals/${rhP}/switch-version/commit`, director, { versionId: pv3, previewToken: prevP.previewToken }, 200);
  check('提交成功，版本已切换', commitP.rehearsal.versionId === pv3);
  check('提交结果与预演一致（确认/待调整日程）',
    commitP.preview.confirmations.kept.length === prevP.confirmations.kept.length
    && commitP.preview.confirmations.redone.length === prevP.confirmations.redone.length
    && JSON.stringify(commitP.needsAdjustmentSchedules) === JSON.stringify(prevP.needsAdjustmentSchedules),
    JSON.stringify(commitP.needsAdjustmentSchedules));
  check('提交后 sc2 日程已转待调整', (await G(`/api/rehearsals/${rhP}/schedules?status=needs_adjustment`, director)).schedules.some((s) => s.id === sp2.id));
  check('提交后 sc1 确认保留（林晚无待确认）', !commitP.pending.some((p) => p.actorId === linId));
  // 换回 pv2（原接口）：sc2 确认已在换版中作废 -> 需重新确认；sc1 确认保留
  const swBack = await J(`/api/rehearsals/${rhP}/switch-version`, director, { versionId: pv2 }, 200);
  check('原换版接口响应结构保持不变', swBack.ok === true && !!swBack.rehearsal && Array.isArray(swBack.pending)
    && Array.isArray(swBack.needsAdjustmentSchedules) && swBack.preview === undefined);
  check('sc2 确认已作废（换回后需重新确认）', swBack.pending.some((p) => p.actorId === linId && p.sceneId === sc2));
  check('sc1 确认保留（换回后仍无需确认）', !swBack.pending.some((p) => p.actorId === linId && p.sceneId === sc1));
  // 已开启的签到快照在凭预演提交换版后保持不变
  const attP = (await J(`/api/rehearsals/${rhP}/schedules/${sp1.id}/attendance`, director, {}, 201)).session;
  const prevP2 = await J(`/api/rehearsals/${rhP}/switch-version/preview`, director, { versionId: pv3 }, 200);
  const sp1SeqBefore = (await G(`/api/rehearsals/${rhP}/schedules/${sp1.id}/notifications`, director)).current.seq;
  await J(`/api/rehearsals/${rhP}/switch-version/commit`, director, { versionId: pv3, previewToken: prevP2.previewToken }, 200);
  const attPAfter = (await G(`/api/rehearsals/${rhP}/schedules/${sp1.id}/attendance`, director)).session;
  check('凭预演提交换版不改写签到快照', attPAfter.versionId === attP.versionId && attPAfter.startAt === attP.startAt
    && attPAfter.roster.length === 2 && attPAfter.stats.expected === 2, JSON.stringify(attPAfter.stats));
  check('凭预演提交换版生成新通知批次（冻结新版本）',
    (await G(`/api/rehearsals/${rhP}/schedules/${sp1.id}/notifications`, director)).current.seq === sp1SeqBefore + 1);

  console.log('— 凭预演提交：预演后状态变化即过期（PREVIEW_STALE） —');
  const rhP2 = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '预演排练P2' }, 201)).id;
  await J(`/api/rehearsals/${rhP2}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  // 预演后改派角 -> 过期
  const stale1 = await J(`/api/rehearsals/${rhP2}/switch-version/preview`, director, { versionId: pv3 }, 200);
  await J(`/api/rehearsals/${rhP2}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const staleCommit1 = await J(`/api/rehearsals/${rhP2}/switch-version/commit`, director, { versionId: pv3, previewToken: stale1.previewToken }, 409);
  check('预演后改派角 -> 提交过期拒绝', staleCommit1.error === 'PREVIEW_STALE', JSON.stringify(staleCommit1));
  check('过期提交不改变版本', (await G(`/api/rehearsals/${rhP2}`, director)).rehearsal.versionId === pv2);
  // 预演后改日程 -> 过期
  const stale2 = await J(`/api/rehearsals/${rhP2}/switch-version/preview`, director, { versionId: pv3 }, 200);
  await J(`/api/rehearsals/${rhP2}/schedules`, director, { sceneId: sc1, startAt: '2034-02-01T10:00:00+08:00', endAt: '2034-02-01T11:00:00+08:00' }, 201);
  const staleCommit2 = await J(`/api/rehearsals/${rhP2}/switch-version/commit`, director, { versionId: pv3, previewToken: stale2.previewToken }, 409);
  check('预演后改日程 -> 提交过期拒绝', staleCommit2.error === 'PREVIEW_STALE');
  // 预演后参与演员登记不可用 -> 过期
  const stale3 = await J(`/api/rehearsals/${rhP2}/switch-version/preview`, director, { versionId: pv3 }, 200);
  const unStale = (await J('/api/me/unavailability', lin, { startAt: '2034-05-01T10:00:00+08:00', endAt: '2034-05-01T11:00:00+08:00', reason: '过期测试' }, 201)).unavailability;
  const staleCommit3 = await J(`/api/rehearsals/${rhP2}/switch-version/commit`, director, { versionId: pv3, previewToken: stale3.previewToken }, 409);
  check('预演后参与演员不可用记录变化 -> 提交过期拒绝', staleCommit3.error === 'PREVIEW_STALE');
  await D(`/api/me/unavailability/${unStale.id}`, lin, 200);
  // 预演后确认变化 -> 过期
  const stale4 = await J(`/api/rehearsals/${rhP2}/switch-version/preview`, director, { versionId: pv3 }, 200);
  await J(`/api/rehearsals/${rhP2}/confirm`, lin, { roleId: roleA, sceneId: sc1 }, 200);
  const staleCommit4 = await J(`/api/rehearsals/${rhP2}/switch-version/commit`, director, { versionId: pv3, previewToken: stale4.previewToken }, 409);
  check('预演后确认变化 -> 提交过期拒绝', staleCommit4.error === 'PREVIEW_STALE');
  // 缺令牌 400；错令牌 409；演员 403
  await J(`/api/rehearsals/${rhP2}/switch-version/commit`, director, { versionId: pv3 }, 400);
  const badToken = await J(`/api/rehearsals/${rhP2}/switch-version/commit`, director, { versionId: pv3, previewToken: 'deadbeef' }, 409);
  check('缺令牌 400；错令牌 409 PREVIEW_STALE', badToken.error === 'PREVIEW_STALE');
  await J(`/api/rehearsals/${rhP2}/switch-version/commit`, lin, { versionId: pv3, previewToken: stale4.previewToken }, 403);
  check('演员提交 403', true);
  // 重新预演后正常提交
  const okPrev = await J(`/api/rehearsals/${rhP2}/switch-version/preview`, director, { versionId: pv3 }, 200);
  const okCommit = await J(`/api/rehearsals/${rhP2}/switch-version/commit`, director, { versionId: pv3, previewToken: okPrev.previewToken }, 200);
  check('重新预演后提交成功', okCommit.rehearsal.versionId === pv3);

  console.log('— 凭预演提交：提交时存在冲突整次不生效 —');
  // RH_P3 固定 pv1：甲=周海、乙=林晚（pv1 乙在 sc1 无台词）；sp3 = sc1 10:00-11:00（参与者仅周海）
  const rhP3 = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '预演排练P3' }, 201)).id;
  await J(`/api/rehearsals/${rhP3}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  await J(`/api/rehearsals/${rhP3}/cast`, director, { roleId: roleB, actorId: linId }, 201);
  const sp3 = (await J(`/api/rehearsals/${rhP3}/schedules`, director, { sceneId: sc1, startAt: '2034-03-01T10:00:00+08:00', endAt: '2034-03-01T11:00:00+08:00' }, 201)).schedule;
  // RH_P4 固定 pv2：甲=陈默；sp4 = sc1 10:30-11:30（与 sp3 重叠但参与者不同）
  const rhP4 = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '预演排练P4' }, 201)).id;
  await J(`/api/rehearsals/${rhP4}/cast`, director, { roleId: roleA, actorId: chenId }, 201);
  const sp4 = (await J(`/api/rehearsals/${rhP4}/schedules`, director, { sceneId: sc1, startAt: '2034-03-01T10:30:00+08:00', endAt: '2034-03-01T11:30:00+08:00' }, 201)).schedule;
  // 预演 RH_P3 -> pv2：乙进入 sc1（参与者 +林晚）；与 sp4（陈默）不冲突
  const prevP3 = await J(`/api/rehearsals/${rhP3}/switch-version/preview`, director, { versionId: pv2 }, 200);
  const prevSp3 = prevP3.schedules.find((s) => s.id === sp3.id);
  check('预演参与者变化：乙加入 sc1 参与者', prevSp3.participantsAdded.some((p) => p.actorId === linId), JSON.stringify(prevSp3.participantsAdded));
  check('预演通知接收人变化：新批次将含林晚', prevSp3.notification.recipientsAdded.some((a) => a.actorId === linId));
  check('预演时无冲突可提交', prevP3.canCommit === true);
  // 预演后：其他排练 RH_P4 改派 甲 陈默->林晚（不使令牌过期，但引入冲突）
  await J(`/api/rehearsals/${rhP4}/cast`, director, { roleId: roleA, actorId: linId }, 200);
  const cfCommit = await J(`/api/rehearsals/${rhP3}/switch-version/commit`, director, { versionId: pv2, previewToken: prevP3.previewToken }, 409);
  check('提交时存在冲突 -> 整次不生效并返回冲突详情', cfCommit.error === 'SCHEDULE_CONFLICT'
    && cfCommit.details.conflicts.some((c) => c.actorId === linId && c.overlapsWith.id === sp4.id), JSON.stringify(cfCommit.details));
  check('冲突提交不改变版本', (await G(`/api/rehearsals/${rhP3}`, director)).rehearsal.versionId === pv1);
  // 再预演：应列出冲突，canCommit=false；带冲突的预演令牌提交仍返回冲突
  const prevP3b = await J(`/api/rehearsals/${rhP3}/switch-version/preview`, director, { versionId: pv2 }, 200);
  check('预演列出与其他有效日程的冲突', prevP3b.canCommit === false
    && prevP3b.conflicts.schedule.some((c) => c.actorId === linId && c.overlapsWith.id === sp4.id), JSON.stringify(prevP3b.conflicts));
  const cfCommit2 = await J(`/api/rehearsals/${rhP3}/switch-version/commit`, director, { versionId: pv2, previewToken: prevP3b.previewToken }, 409);
  check('带冲突的预演提交仍返回冲突详情', cfCommit2.error === 'SCHEDULE_CONFLICT');
  // 取消冲突时段后重新预演可提交
  await J(`/api/rehearsals/${rhP4}/schedules/${sp4.id}/cancel`, director, {}, 200);
  const prevP3c = await J(`/api/rehearsals/${rhP3}/switch-version/preview`, director, { versionId: pv2 }, 200);
  check('冲突解除后预演可提交', prevP3c.canCommit === true);
  const cfCommit3 = await J(`/api/rehearsals/${rhP3}/switch-version/commit`, director, { versionId: pv2, previewToken: prevP3c.previewToken }, 200);
  check('冲突解除后提交成功', cfCommit3.rehearsal.versionId === pv2);

  console.log('— 换版预演：不可用时段冲突 —');
  // RH_P5 固定 pv1：甲=周海、乙=林晚；sp5 = sc1；林晚登记重叠不可用（她当前不是 sp5 参与者）
  const rhP5 = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '预演排练P5' }, 201)).id;
  await J(`/api/rehearsals/${rhP5}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  await J(`/api/rehearsals/${rhP5}/cast`, director, { roleId: roleB, actorId: linId }, 201);
  const sp5 = (await J(`/api/rehearsals/${rhP5}/schedules`, director, { sceneId: sc1, startAt: '2034-04-01T10:00:00+08:00', endAt: '2034-04-01T11:00:00+08:00' }, 201)).schedule;
  const unP5 = (await J('/api/me/unavailability', lin, { startAt: '2034-04-01T10:30:00+08:00', endAt: '2034-04-01T11:30:00+08:00', reason: '预演不可用测试' }, 201)).unavailability;
  const prevP5 = await J(`/api/rehearsals/${rhP5}/switch-version/preview`, director, { versionId: pv2 }, 200);
  check('预演列出不可用冲突', prevP5.canCommit === false
    && prevP5.conflicts.unavailability.some((c) => c.actorId === linId && c.schedule.id === sp5.id && c.unavailability.id === unP5.id),
    JSON.stringify(prevP5.conflicts));
  const unCommit = await J(`/api/rehearsals/${rhP5}/switch-version/commit`, director, { versionId: pv2, previewToken: prevP5.previewToken }, 409);
  check('不可用冲突提交整次不生效', unCommit.error === 'UNAVAILABILITY_CONFLICT'
    && (await G(`/api/rehearsals/${rhP5}`, director)).rehearsal.versionId === pv1);
  await D(`/api/me/unavailability/${unP5.id}`, lin, 200);
  const prevP5b = await J(`/api/rehearsals/${rhP5}/switch-version/preview`, director, { versionId: pv2 }, 200);
  const okCommit5 = await J(`/api/rehearsals/${rhP5}/switch-version/commit`, director, { versionId: pv2, previewToken: prevP5b.previewToken }, 200);
  check('撤销不可用后提交成功', okCommit5.rehearsal.versionId === pv2);

  console.log('— 共享道具：登记 / 权限 / 入参拒绝 —');
  // 种子数据自带 3 个道具与示例时段预约（2026-10 的种子时段，不影响本轮 2035 用例）
  const seedProps = await G('/api/props', director);
  check('导演可查看道具登记册（含种子道具）', seedProps.props.length >= 3, JSON.stringify(seedProps));
  await G('/api/props', lin, 403);
  await G('/api/props', null, 401);
  check('演员不可查看道具登记册；未登录 401', true);
  const propCrate = await J('/api/props', director, { name: '道具箱E2E', totalCount: 2 }, 201);
  const crateId = propCrate.prop.id;
  check('登记道具返回总件数与占用统计', propCrate.prop.totalCount === 2 && propCrate.prop.peakReserved === 0);
  await J('/api/props', lin, { name: 'x', totalCount: 1 }, 403);
  await J('/api/props', director, { name: '道具箱E2E', totalCount: 1 }, 400);
  await J('/api/props', director, { name: '无件数道具' }, 400);
  await J('/api/props', director, { name: '负数道具', totalCount: -1 }, 400);
  await J('/api/props', director, { name: '小数道具', totalCount: 1.5 }, 400);
  await J('/api/props', director, { name: '字符串件数', totalCount: '2' }, 400);
  await J('/api/props', director, { name: '布尔件数', totalCount: true }, 400);
  check('重复名称/无效件数/演员调用一律拒绝', true);
  await req('PATCH', `/api/props/${crateId}`, director, {}, 400);
  await req('PATCH', `/api/props/99999`, director, { totalCount: 1 }, 404);

  console.log('— 共享道具：预约、余量、半开区间与整批校验 —');
  // 两个演员互不重叠的排练：PR_X=林晚+陈默，PR_Y=周海（道具占用跨排练叠加）
  const rhX = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '道具排练X' }, 201)).id;
  await J(`/api/rehearsals/${rhX}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhX}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const rhY = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '道具排练Y' }, 201)).id;
  await J(`/api/rehearsals/${rhY}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  const mk = (rh, st, en, scene = sc1) =>
    J(`/api/rehearsals/${rh}/schedules`, director, { sceneId: scene, startAt: st, endAt: en }, 201);
  const x1 = (await mk(rhX, '2035-06-01T10:00:00Z', '2035-06-01T11:00:00Z')).schedule;
  const y1 = (await mk(rhY, '2035-06-01T10:30:00Z', '2035-06-01T11:30:00Z')).schedule;
  const yTouch = (await mk(rhY, '2035-06-01T11:30:00Z', '2035-06-01T12:30:00Z')).schedule;
  // x1 预约道具箱 1
  const vx1 = await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 1 }] }, 200);
  check('单时段预约成功并返回时段内最低余量', vx1.ok && vx1.minRemaining === 1
    && vx1.props[0].quantity === 1 && vx1.props[0].peakReservedInSlot === 1, JSON.stringify(vx1));
  // y1 与 x1 重叠：预约 2 件 -> 峰值 3 > 2，409
  const over = await req('PUT', `/api/rehearsals/${rhY}/schedules/${y1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 2 }] }, 409);
  check('重叠超库存 -> 409 PROP_CAPACITY_CONFLICT 且返回道具/冲突时段/缺口',
    over.error === 'PROP_CAPACITY_CONFLICT'
      && over.details.shortages[0].propId === crateId
      && over.details.shortages[0].shortage === 1
      && over.details.shortages[0].peakReserved === 3
      && over.details.shortages[0].schedules.some((s) => s.id === x1.id)
      && over.details.shortages[0].schedules.some((s) => s.id === y1.id),
    JSON.stringify(over.details));
  const vy1After = await G(`/api/rehearsals/${rhY}/schedules/${y1.id}/props`, director);
  check('失败后预约不生效', vy1After.props.length === 0, JSON.stringify(vy1After));
  // y1 预约 1 件：峰值 2 == 2 成功
  const vy1Ok = await req('PUT', `/api/rehearsals/${rhY}/schedules/${y1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 1 }] }, 200);
  check('重叠但总量恰为库存 -> 成功，时段内最低余量 0', vy1Ok.minRemaining === 0);
  // yTouch 与 y1 端点相接（11:30）：可再用满 2 件
  const vyTouch = await req('PUT', `/api/rehearsals/${rhY}/schedules/${yTouch.id}/props`, director,
    { items: [{ propId: crateId, quantity: 2 }] }, 200);
  check('端点相接可复用：相接时段可各用满库存', vyTouch.ok && vyTouch.minRemaining === 0);
  // 入参拒绝
  await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: 99999, quantity: 1 }] }, 400);
  await req('PUT', `/api/rehearsals/${rhX}/schedules/99999/props`, director, { items: [] }, 404);
  await req('PUT', `/api/rehearsals/999/schedules/${x1.id}/props`, director, { items: [] }, 404);
  await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: crateId, quantity: -2 }] }, 400);
  await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 2.5 }] }, 400);
  const dup = await J('/api/schedules/props/batch', director, {
    items: [
      { scheduleId: x1.id, propId: crateId, quantity: 1 },
      { scheduleId: x1.id, propId: crateId, quantity: 2 },
    ],
  }, 400);
  check('同批重复 (时段,道具) 组合 400', /重复/.test(dup.message), dup.message);
  await J('/api/schedules/props/batch', director, { items: [{ scheduleId: x1.id, propId: crateId, quantity: 1 }] }, 400);
  await req('POST', '/api/schedules/props/batch', director, { items: 'nope' }, 400);
  await J('/api/schedules/props/batch', director, {
    items: [{ scheduleId: 99999, propId: crateId, quantity: 1 }, { scheduleId: x1.id, propId: crateId, quantity: 1 }],
  }, 404);
  await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, lin,
    { items: [{ propId: crateId, quantity: 1 }] }, 403);
  check('未知道具/时段、无效件数、批量不足两条、演员调用均明确拒绝', true);

  console.log('— 共享道具：撤销(0)与未列出道具不变 —');
  const keep = await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 1 }] }, 200);
  check('同值重提幂等（保持 1 件）', keep.props.length === 1);
  // 再登记一个道具：撤销目标道具时，未列出的另一道具保持不变
  const propFlag = (await J('/api/props', director, { name: '令旗E2E', totalCount: 5 }, 201)).prop.id;
  await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: propFlag, quantity: 3 }] }, 200);
  const revoked = await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 0 }] }, 200);
  check('quantity=0 撤销该道具；未列出的道具保持不变',
    !revoked.props.some((p) => p.propId === crateId)
      && revoked.props.some((p) => p.propId === propFlag && p.quantity === 3),
    JSON.stringify(revoked.props));

  console.log('— 共享道具：跨时段整批修改按最终状态校验 —');
  // 撤销令旗，恢复道具箱基线：x1=1、y1=1（10:30-11:30，重叠峰值 2）
  await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: propFlag, quantity: 0 }, { propId: crateId, quantity: 1 }] }, 200);
  // 最终 x1=1（10-11）、y1=1（10:30-11:30）-> 峰值 2，成功
  const batchOk = await J('/api/schedules/props/batch', director, {
    items: [
      { scheduleId: x1.id, propId: crateId, quantity: 1 },
      { scheduleId: y1.id, propId: crateId, quantity: 1 },
    ],
  }, 200);
  check('批量按整批最终状态生效', batchOk.ok && batchOk.schedules.length === 2
    && batchOk.schedules.find((s) => s.schedule.id === x1.id).minRemaining === 0, JSON.stringify(batchOk.schedules));
  // 整批失败：x1=2, y1=1 -> 峰值 3 > 2
  const batchFail = await J('/api/schedules/props/batch', director, {
    items: [
      { scheduleId: x1.id, propId: crateId, quantity: 2 },
      { scheduleId: y1.id, propId: crateId, quantity: 1 },
    ],
  }, 409);
  check('批量任一时刻不足 -> 整批不生效并返回缺口',
    batchFail.error === 'PROP_CAPACITY_CONFLICT' && batchFail.details.shortages[0].shortage === 1);
  const afterX = await G(`/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director);
  const afterY = await G(`/api/rehearsals/${rhY}/schedules/${y1.id}/props`, director);
  check('整批失败后两条均保持原值',
    afterX.props.find((p) => p.propId === crateId).quantity === 1
      && afterY.props.find((p) => p.propId === crateId).quantity === 1,
    JSON.stringify([afterX.props, afterY.props]));
  // 批次内互换件数（x1=1,y1=1 同值）后改为 x1=0、y1=2：最终峰值 y1 独占 2，成功
  const batchShift = await J('/api/schedules/props/batch', director, {
    items: [
      { scheduleId: x1.id, propId: crateId, quantity: 0 },
      { scheduleId: y1.id, propId: crateId, quantity: 2 },
    ],
  }, 200);
  check('批量可在最终状态下把占用从一个时段移到另一个时段',
    batchShift.schedules.find((s) => s.schedule.id === y1.id).props.find((p) => p.propId === crateId).quantity === 2);

  console.log('— 共享道具：调期携带预约移动（库存不足整体不生效）—');
  // 基线：y1=2（10:30-11:30），x1 无道具箱
  // y1 调期到 10:00-11:00 仍独占 2 件：成功
  await req('PATCH', `/api/rehearsals/${rhY}/schedules/${y1.id}`, director,
    { startAt: '2035-06-01T10:00:00Z', endAt: '2035-06-01T11:00:00Z' }, 200);
  // x1 重新预约 1 件：与 y1 完全重合 -> 峰值 3，失败
  const bumpX = await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 1 }] }, 409);
  check('重合时段加件超库存失败', bumpX.error === 'PROP_CAPACITY_CONFLICT');
  // 把 y1 调期到与 x1 完全重合（y1 持 2、x1 无）— 先给 x1 占 1 件需要 y1 移开：
  // y1 调到 08:00-09:00（与任何时段不重叠）后，x1 可预约 2 件
  await req('PATCH', `/api/rehearsals/${rhY}/schedules/${y1.id}`, director,
    { startAt: '2035-06-01T08:00:00Z', endAt: '2035-06-01T09:00:00Z' }, 200);
  await req('PUT', `/api/rehearsals/${rhX}/schedules/${x1.id}/props`, director,
    { items: [{ propId: crateId, quantity: 2 }] }, 200);
  // y1（持 2）调期回与 x1 重叠 -> 原日程操作整体不生效，时间不动
  const moveFail = await req('PATCH', `/api/rehearsals/${rhY}/schedules/${y1.id}`, director,
    { startAt: '2035-06-01T10:30:00Z', endAt: '2035-06-01T11:30:00Z' }, 409);
  check('调期携带预约移动后超库存 -> 409 且原日程操作整体不生效',
    moveFail.error === 'PROP_CAPACITY_CONFLICT'
      && moveFail.details.shortages[0].schedules.some((s) => s.id === x1.id)
      && moveFail.details.shortages[0].schedules.some((s) => s.id === y1.id),
    JSON.stringify(moveFail.details));
  const y1Kept = await G(`/api/rehearsals/${rhY}/schedules/${y1.id}/props`, director);
  check('调期失败后时间与预约均不变', y1Kept.schedule.startAt === '2035-06-01T08:00:00.000Z'
    && y1Kept.props.find((p) => p.propId === crateId).quantity === 2);

  console.log('— 共享道具：下调库存校验 / 取消释放占用 —');
  // 占用峰值：x1=2（10-11）、y1=2（08-09）、yTouch=2（11:30-12:30），互不重叠
  await req('PATCH', `/api/props/${crateId}`, director, { totalCount: 2 }, 200);
  const lowerFail = await req('PATCH', `/api/props/${crateId}`, director, { totalCount: 1 }, 409);
  check('下调库存不足 -> 409 且整次不生效（返回缺口时段与缺口数）', lowerFail.error === 'PROP_CAPACITY_CONFLICT'
    && lowerFail.details.shortages[0].propId === crateId
    && lowerFail.details.shortages[0].totalCount === 1
    && lowerFail.details.shortages[0].peakReserved === 2
    && lowerFail.details.shortages[0].shortage === 1
    && [x1.id, y1.id].some((id) => lowerFail.details.shortages[0].schedules.some((s) => s.id === id)));
  check('下调失败库存保持 2',
    (await G('/api/props', director)).props.find((p) => p.id === crateId).totalCount === 2);
  // 已取消时段不能改预约；记录保留但不占用
  await J(`/api/rehearsals/${rhY}/schedules/${yTouch.id}/cancel`, director, {}, 200);
  await req('PUT', `/api/rehearsals/${rhY}/schedules/${yTouch.id}/props`, director,
    { items: [{ propId: crateId, quantity: 1 }] }, 400);
  const cancelledView = await G(`/api/rehearsals/${rhY}/schedules/${yTouch.id}/props`, director);
  check('已取消时段预约记录可查但不占用（occupying=false, minRemaining=null）',
    cancelledView.status === 'cancelled'
      && cancelledView.props.every((p) => p.occupying === false && p.minRemaining === null),
    JSON.stringify(cancelledView));
  // 取消 x1、y1 释放占用 -> 库存可下调到 0（令旗 5 不受影响）
  await J(`/api/rehearsals/${rhX}/schedules/${x1.id}/cancel`, director, {}, 200);
  await J(`/api/rehearsals/${rhY}/schedules/${y1.id}/cancel`, director, {}, 200);
  await req('PATCH', `/api/props/${crateId}`, director, { totalCount: 0 }, 200);
  check('全部取消后库存释放，可下调总件数到 0', true);

  console.log('— 共享道具：待调整释放占用，恢复有效时重新校验 —');
  const propAdj = (await J('/api/props', director, { name: '待调整道具E2E', totalCount: 1 }, 201)).prop.id;
  // rhZ 固定 pv1：甲=周海，乙=林晚（pv1 中乙仅 sc2 有台词）；spZ 排 sc2
  const rhZ = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '待调整排练Z' }, 201)).id;
  await J(`/api/rehearsals/${rhZ}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  await J(`/api/rehearsals/${rhZ}/cast`, director, { roleId: roleB, actorId: linId }, 201);
  const spZ = (await J(`/api/rehearsals/${rhZ}/schedules`, director,
    { sceneId: sc2, startAt: '2035-07-01T10:00:00Z', endAt: '2035-07-01T11:00:00Z' }, 201)).schedule;
  await req('PUT', `/api/rehearsals/${rhZ}/schedules/${spZ.id}/props`, director,
    { items: [{ propId: propAdj, quantity: 1 }] }, 200);
  // pv3 删除了 sc2 全部台词：换版后 spZ 转待调整（若按 pv1 的原参与者重算会有林晚撞其他日程的风险，
  // 故 rhZ 只使用 2035-07 专属时间）
  const swZ = await J(`/api/rehearsals/${rhZ}/switch-version`, director, { versionId: pv3 }, 200);
  check('换版后无台词场次的时段转待调整', swZ.needsAdjustmentSchedules.includes(spZ.id),
    JSON.stringify(swZ.needsAdjustmentSchedules));
  const zNA = await G(`/api/rehearsals/${rhZ}/schedules/${spZ.id}/props`, director);
  check('待调整时段：预约保留但不占用', zNA.status === 'needs_adjustment'
    && zNA.props[0].quantity === 1 && zNA.props[0].occupying === false, JSON.stringify(zNA));
  // 待调整期间可改预约（不校验库存）
  await req('PUT', `/api/rehearsals/${rhZ}/schedules/${spZ.id}/props`, director,
    { items: [{ propId: propAdj, quantity: 1 }] }, 200);
  // 另一有效时段（陈默，pv2 的 sc2 有乙台词）占用同一道具、时间重叠
  const rhPW = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '待调整排练W' }, 201)).id;
  await J(`/api/rehearsals/${rhPW}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const spPW = (await J(`/api/rehearsals/${rhPW}/schedules`, director,
    { sceneId: sc2, startAt: '2035-07-01T10:00:00Z', endAt: '2035-07-01T11:00:00Z' }, 201)).schedule;
  await req('PUT', `/api/rehearsals/${rhPW}/schedules/${spPW.id}/props`, director,
    { items: [{ propId: propAdj, quantity: 1 }] }, 200);
  // spZ 恢复有效（改到 pv3 中仍有台词的 sc1）：库存被 spPW 占满 -> 整体不生效，保持待调整
  const restoreFail = await req('PATCH', `/api/rehearsals/${rhZ}/schedules/${spZ.id}`, director,
    { sceneId: sc1, startAt: '2035-07-01T10:00:00Z', endAt: '2035-07-01T11:00:00Z' }, 409);
  check('待调整恢复有效时重新校验库存：不足则原日程操作整体不生效',
    restoreFail.error === 'PROP_CAPACITY_CONFLICT'
      && restoreFail.details.shortages[0].propId === propAdj
      && restoreFail.details.shortages[0].schedules.some((s) => s.id === spPW.id)
      && restoreFail.details.shortages[0].schedules.some((s) => s.id === spZ.id),
    JSON.stringify(restoreFail.details));
  const stillNA = await G(`/api/rehearsals/${rhZ}/schedules/${spZ.id}/props`, director);
  check('恢复失败后仍为待调整、预约保留', stillNA.status === 'needs_adjustment'
    && stillNA.props[0].quantity === 1);
  // spPW 移到端点相接（09:00-10:00）-> spZ 恢复成功
  await req('PATCH', `/api/rehearsals/${rhPW}/schedules/${spPW.id}`, director,
    { startAt: '2035-07-01T09:00:00Z', endAt: '2035-07-01T10:00:00Z' }, 200);
  const restoreOk = await req('PATCH', `/api/rehearsals/${rhZ}/schedules/${spZ.id}`, director,
    { sceneId: sc1, startAt: '2035-07-01T10:00:00Z', endAt: '2035-07-01T11:00:00Z' }, 200);
  check('占用解除后待调整时段恢复有效', restoreOk.schedule.status === 'active'
    && restoreOk.schedule.sceneId === sc1, JSON.stringify(restoreOk.schedule));
  const zActive = await G(`/api/rehearsals/${rhZ}/schedules/${spZ.id}/props`, director);
  check('恢复后预约重新占用（occupying=true, 最低余量 0）',
    zActive.props[0].occupying === true && zActive.props[0].minRemaining === 0);

  console.log('— 共享道具：演员只可见自己当前参与有效时段的道具清单 —');
  await G(`/api/rehearsals/${rhY}/schedules/${y1.id}/props`, chen, 403);
  await G(`/api/rehearsals/${rhY}/schedules/${y1.id}/props`, null, 401);
  await G(`/api/rehearsals/${rhZ}/schedules/${spZ.id}/props`, chen, 403);
  check('非参与演员/未登录看不到时段道具清单（含跨排练隔离）', true);
  const chenView = await G(`/api/rehearsals/${rhPW}/schedules/${spPW.id}/props`, chen);
  check('参与演员看到本时段道具清单（仅名称与件数，无库存/余量/其他时段）',
    chenView.scheduleId === spPW.id && chenView.props.length === 1
      && chenView.props[0].propId === propAdj && chenView.props[0].quantity === 1
      && chenView.props[0].totalCount === undefined && chenView.minRemaining === undefined,
    JSON.stringify(chenView));
  await G(`/api/rehearsals/${rhPW}/schedules/${spPW.id}/props`, zhou, 403);
  check('不参与演员 403，不能读取其他预约', true);
  const chenScheds = await G(`/api/rehearsals/${rhPW}/schedules`, chen);
  check('演员日程列表自带 props 清单',
    chenScheds.schedules.some((s) => s.id === spPW.id && Array.isArray(s.props)
      && s.props.some((p) => p.propId === propAdj)), JSON.stringify(chenScheds.schedules));
  const dirScheds = await G(`/api/rehearsals/${rhPW}/schedules`, director);
  check('导演日程列表含道具预约简表',
    dirScheds.schedules.some((s) => s.id === spPW.id && s.props.some((p) => p.propId === propAdj)));
  // 已取消时段对任何人都不作为“有效清单”：演员看不到（参与者也不行）
  await G(`/api/rehearsals/${rhY}/schedules/${yTouch.id}/props`, zhou, 403);

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常中断:', e.message);
  process.exit(1);
});

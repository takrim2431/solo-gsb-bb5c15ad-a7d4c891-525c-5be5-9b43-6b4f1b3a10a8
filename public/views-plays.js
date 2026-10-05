/* 导演：剧本与版本 */
async function loadPlaysTab() {
  const panel = document.getElementById('tab-plays');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  const { plays } = await api('GET', '/api/plays');
  state.plays = plays;
  panel.innerHTML = '';

  const createCard = el(`
    <div class="card">
      <h2>新建剧本（草稿 → 发布首版）</h2>
      <form id="newPlayForm" class="flex">
        <input name="title" placeholder="剧名，如：夜航灯塔" required />
        <input name="description" placeholder="简介（可选）" />
        <button class="btn primary" type="submit">创建</button>
      </form>
    </div>`);
  createCard.querySelector('#newPlayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const p = await api('POST', '/api/plays', {
        title: fd.get('title'),
        description: fd.get('description'),
      });
      toast(`已创建剧本 #${p.id}`);
      state.currentPlayId = p.id;
      await renderPlayDetail(p.id);
      await refreshPlayList();
    } catch (err) { toast(err.message, true); }
  });
  panel.appendChild(createCard);

  const listCard = el('<div class="card"><h2>剧本列表</h2><div id="playList"></div></div>');
  panel.appendChild(listCard);
  await refreshPlayList();
}

async function refreshPlayList() {
  const { plays } = await api('GET', '/api/plays');
  state.plays = plays;
  const box = document.getElementById('playList');
  if (!box) return;
  box.innerHTML = '';
  for (const p of plays) {
    const row = el(`
      <div class="flex line-row" style="cursor:pointer">
        <div class="grow">
          <strong>${esc(p.title)}</strong>
          ${p.latestVersionId ? `<span class="badge v">最新 v${p.latestVersionId}</span>` : '<span class="badge pending">草稿</span>'}
          <div class="muted">${esc(p.description)}</div>
        </div>
        <button class="btn small">打开</button>
      </div>`);
    row.addEventListener('click', () => renderPlayDetail(p.id));
    box.appendChild(row);
  }
}

async function renderPlayDetail(playId) {
  const panel = document.getElementById('tab-plays');
  const detail = await api('GET', `/api/plays/${playId}`);
  const { play, scenes, roles, lines } = detail;
  state.currentPlayId = playId;

  const existing = document.getElementById('playDetail');
  if (existing) existing.remove();

  const card = el(`<div class="card" id="playDetail"></div>`);
  card.innerHTML = `
    <h2>《${esc(play.title)}》
      ${play.latestVersionId ? `<span class="badge v">最新版本 v${play.latestVersionId}</span>` : '<span class="badge pending">草稿（尚未发布首版）</span>'}
    </h2>
    <div class="muted">场次 ${scenes.length} · 角色 ${roles.length} · 现行台词 ${lines.length} 条</div>`;

  // 场次/角色新增
  const struct = el(`
    <div class="flex" style="align-items:flex-start;margin-top:10px">
      <form class="grow" id="addSceneForm">
        <h3>新增场次</h3>
        <div class="flex">
          <input name="code" placeholder="编号 I" style="max-width:90px" />
          <input name="title" placeholder="场次名" />
          <button class="btn">加场次</button>
        </div>
      </form>
      <form class="grow" id="addRoleForm">
        <h3>新增角色</h3>
        <div class="flex">
          <input name="code" placeholder="编号 HERO" style="max-width:120px" />
          <input name="name" placeholder="角色名" />
          <button class="btn">加角色</button>
        </div>
      </form>
    </div>`);
  card.appendChild(struct);
  card.querySelector('#addSceneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/plays/${playId}/scenes`, { code: fd.get('code'), title: fd.get('title') });
      toast('场次已添加');
      renderPlayDetail(playId);
    } catch (err) { toast(err.message, true); }
  });
  card.querySelector('#addRoleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/plays/${playId}/roles`, { code: fd.get('code'), name: fd.get('name') });
      toast('角色已添加');
      renderPlayDetail(playId);
    } catch ( err) { toast(err.message, true); }
  });

  // 草稿台词（仅发布前）
  if (!play.latestVersionId) {
    const addLine = el(`
      <form id="addLineForm" style="margin-top:12px">
        <h3>录入台词（按场次、角色、顺序）</h3>
        <div class="flex">
          <select name="sceneId" required>${scenes.map((s) => `<option value="${s.id}">${esc(s.code)} ${esc(s.title)}</option>`).join('')}</select>
          <select name="roleId" required>${roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>
          <input name="text" placeholder="台词文本" required />
          <button class="btn primary">加入草稿</button>
        </div>
      </form>`);
    card.appendChild(addLine);
    addLine.querySelector('#addLineForm')?.addEventListener('submit', async () => {});
    addLine.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('POST', `/api/plays/${playId}/lines`, {
          sceneId: Number(fd.get('sceneId')),
          roleId: Number(fd.get('roleId')),
          text: fd.get('text'),
        });
        toast('已加入草稿');
        renderPlayDetail(playId);
      } catch (err) { toast(err.message, true); }
    });

    card.appendChild(el('<div style="margin-top:12px" class="flex"><button id="publishInitialBtn" class="btn primary">发布首版</button><span class="hint">首版发布后，现行文本改动必须走修订流程</span></div>'));
    card.querySelector('#publishInitialBtn').addEventListener('click', async () => {
      try {
        const r = await api('POST', `/api/plays/${playId}/publish-initial`, { note: '首版' });
        toast(`首版 v${r.version.id} 已发布`);
        renderPlayDetail(playId);
        refreshPlayList();
      } catch (err) { toast(err.message, true); }
    });
  }

  renderLinesAndVersions(card, play, scenes, roles, lines);
  panel.insertBefore(card, panel.children[1] || null);
}

function renderLinesAndVersions(card, play, scenes, roles, lines) {
  // 现行台词
  const lbox = el('<div style="margin-top:14px"></div>');
  lbox.innerHTML = '<h3>现行台词（按场次/顺序）</h3>';
  const sceneMap = new Map(scenes.map((s) => [s.id, s]));
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const byScene = new Map();
  for (const l of lines) {
    if (!byScene.has(l.sceneId)) byScene.set(l.sceneId, []);
    byScene.get(l.sceneId).push(l);
  }
  for (const s of scenes) {
    const block = el(`<div class="scene-block"><div class="muted">${esc(s.code)} · ${esc(s.title)}</div></div>`);
    for (const l of byScene.get(s.id) || []) {
      block.appendChild(el(`
        <div class="line-row">
          <div class="meta">#${l.id} · ${esc(roleMap.get(l.roleId)?.name || l.roleId)} · 顺序 ${l.seq}</div>
          <div>${esc(l.text)}</div>
        </div>`));
    }
    lbox.appendChild(block);
  }
  card.appendChild(lbox);

  // 版本列表
  const vbox = el('<div style="margin-top:14px"></div>');
  vbox.innerHTML = '<h3>已发布版本（不可改写）</h3><div id="versionList" class="pill-row"><span class="muted">加载中…</span></div><div id="versionDetail"></div>';
  card.appendChild(vbox);
  api('GET', `/api/plays/${play.id}/versions`).then(({ versions }) => {
    const vl = vbox.querySelector('#versionList');
    vl.innerHTML = versions.length
      ? versions.map((v) => `<button class="btn small" data-vid="${v.id}">v${v.version_no}</button>`).join('')
      : '<span class="muted">尚无版本</span>';
    vl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => showVersion(vbox.querySelector('#versionDetail'), b.dataset.vid)));
    if (versions[0]) showVersion(vbox.querySelector('#versionDetail'), versions[versions.length - 1].id);
  });
}

async function showVersion(container, versionId) {
  const v = await api('GET', `/api/versions/${versionId}`);
  container.innerHTML = `
    <h3>版本 v${v.version.versionNo} <span class="muted">${esc(v.version.note)} · ${v.version.createdAt}</span></h3>
    <div id="vLines"></div>`;
  const box = container.querySelector('#vLines');
  let lastScene = null;
  for (const l of v.lines) {
    if (l.sceneId !== lastScene) {
      box.appendChild(el(`<div class="muted" style="margin-top:8px">${esc(l.sceneCode)} · ${esc(l.sceneTitle)}</div>`));
      lastScene = l.sceneId;
    }
    box.appendChild(el(`
      <div class="line-row">
        <div class="meta">#${l.lineId} · ${esc(l.roleName)} · 顺序 ${l.seq}</div>
        <div>${esc(l.text)}</div>
      </div>`));
  }
}

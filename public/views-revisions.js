/* 导演：修订发布 */
async function loadRevisionsTab() {
  const panel = document.getElementById('tab-revisions');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  if (!state.plays.length) await refreshPlayList();
  const plays = state.plays;
  panel.innerHTML = '';

  const card = el('<div class="card"></div>');
  card.innerHTML = `
    <h2>修订与发布</h2>
    <div class="flex">
      <select id="revPlaySel">
        ${plays.filter((p) => p.latestVersionId).map((p) => `<option value="${p.id}">《${esc(p.title)}》</option>`).join('')}
      </select>
      <button id="refreshRevBtn" class="btn small">刷新</button>
    </div>
    <div id="revWorkspace" style="margin-top:12px"></div>`;
  panel.appendChild(card);

  async function sync() {
    const playId = Number(sel.value);
    state.currentPlayId = playId;
    await renderRevisionWorkspace(playId);
  }
  const sel = card.querySelector('#revPlaySel');
  sel.addEventListener('change', sync);
  card.querySelector('#refreshRevBtn').addEventListener('click', sync);
  if (sel.value) sync();
}

async function renderRevisionWorkspace(playId) {
  const box = document.getElementById('revWorkspace');
  box.innerHTML = '<span class="muted">加载中…</span>';
  const [detail, { revisions }, { attempts }] = await Promise.all([
    api('GET', `/api/plays/${playId}`),
    api('GET', `/api/plays/${playId}/revisions`),
    api('GET', `/api/plays/${playId}/publish-attempts`),
  ]);
  const { scenes, roles, lines, play } = detail;
  box.innerHTML = '';

  // 新建修订
  const create = el(`
    <div class="card" style="box-shadow:none;border:1px solid #e7e1d6">
      <h3>新建修订（以某个已发布版本为基准）</h3>
      <div class="flex">
        <input id="revTitle" placeholder="修订标题，如：第二幕台词打磨" />
        <select id="revBase"></select>
        <button id="createRevBtn" class="btn primary">创建</button>
      </div>
    </div>`);
  const { versions } = await api('GET', `/api/plays/${playId}/versions`);
  create.querySelector('#revBase').innerHTML = versions
    .slice()
    .reverse()
    .map((v) => `<option value="${v.id}">基准 v${v.versionNo}${v.id === play.latestVersionId ? '（最新）' : '（旧版）'}</option>`)
    .join('');
  create.querySelector('#createRevBtn').addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/plays/${playId}/revisions`, {
        title: create.querySelector('#revTitle').value,
        baseVersionId: Number(create.querySelector('#revBase').value),
      });
      toast(`修订 #${r.id} 已创建（基准 v${r.baseVersion.versionNo}）`);
      renderRevisionWorkspace(playId);
    } catch (err) { toast(err.message, true); }
  });
  box.appendChild(create);

  // 发布区
  const pub = el(`
    <div class="card" style="box-shadow:none;border:1px solid #e7e1d6;margin-top:10px">
      <h3>发布（逐条核对现行文本，有冲突则整体不生效）</h3>
      <div class="flex">
        <input id="pubNote" placeholder="新版本说明（可选）" />
        <button id="publishBtn" class="btn primary">发布勾选的修订</button>
      </div>
      <div id="publishResult" style="margin-top:8px"></div>
    </div>`);
  pub.querySelector('#publishBtn').addEventListener('click', async () => {
    const ids = [...box.querySelectorAll('.rev-check:checked')].map((c) => Number(c.value));
    if (!ids.length) return toast('请勾选至少一个进行中的修订', true);
    const result = pub.querySelector('#publishResult');
    result.innerHTML = '<span class="muted">发布中…</span>';
    try {
      const r = await api('POST', `/api/plays/${playId}/publish`, {
        revisionIds: ids,
        note: pub.querySelector('#pubNote').value,
      });
      result.innerHTML = `<div class="line-row">✅ 已合入 <strong>v${r.newVersion.versionNo}</strong>（修订 ${r.mergedRevisionIds.join(', ')}）</div>`;
      toast('发布成功');
      renderRevisionWorkspace(playId);
    } catch (err) {
      if (err.code === 'PUBLISH_CONFLICT') {
        result.innerHTML = renderConflictBox(err.data);
        toast('存在冲突，本次发布不生效', true);
      } else {
        result.innerHTML = '';
        toast(err.message, true);
      }
    }
  });
  box.appendChild(pub);

  // 修订列表
  const listCard = el('<div style="margin-top:10px"></div>');
  for (const rev of revisions) {
    listCard.appendChild(renderRevisionCard(rev, { playId, lines, scenes, roles, refresh: () => renderRevisionWorkspace(playId) }));
  }
  box.appendChild(listCard);

  // 发布尝试历史
  const hist = el(`
    <div class="card" style="box-shadow:none;border:1px solid #e7e1d6;margin-top:10px">
      <h3>发布记录与冲突详情</h3>
      <div id="attemptList"></div>
    </div>`);
  const al = hist.querySelector('#attemptList');
  if (!attempts.length) al.innerHTML = '<span class="muted">暂无发布尝试</span>';
  for (const a of attempts) {
    const item = el(`
      <div class="line-row">
        <div class="meta">${a.createdAt} · ${a.hadConflict ? '<strong style="color:#8a2f2f">冲突，未生效</strong>' : `已生成 v${a.newVersionId}`}</div>
        <div>${esc(a.note || '(无说明)')}；修订 [${a.revisionIds.join(', ')}]${a.conflicts.length ? ` · ${a.conflicts.length} 处冲突` : ''}</div>
        <div class="conflicts-here"></div>
      </div>`);
    for (const c of a.conflicts) item.querySelector('.conflicts-here').appendChild(renderConflictItem(c));
    al.appendChild(item);
  }
  box.appendChild(hist);
}

function renderConflictBox(data) {
  return `
    <div class="conflict">
      <div class="kind">⛔ ${esc(data.message)}</div>
      ${data.conflicts.map((c) => conflictItemHtml(c)).join('')}
    </div>`;
}

function conflictItemHtml(c) {
  return `<div style="margin-top:6px">
      <div class="kind">[${esc(c.kind)}] 修订 #${c.revisionId} · 台词 #${c.lineId ?? '-'}</div>
      <div>${esc(c.reason)}</div>
      ${c.baseText ? `<div class="diff old">原文（修订声称）：${esc(c.baseText)}</div>` : ''}
      ${c.currentText ? `<div class="diff new">现行文本：${esc(c.currentText)}</div>` : ''}
    </div>`;
}

function renderConflictItem(c) {
  return el(`<div class="conflict" style="margin-top:6px">${conflictItemHtml(c)}</div>`);
}

function renderRevisionCard(rev, ctx) {
  const lineMap = new Map(ctx.lines.map((l) => [l.id, l]));
  const sceneMap = new Map(ctx.scenes.map((s) => [s.id, s]));
  const roleMap = new Map(ctx.roles.map((r) => [r.id, r]));

  const card = el(`
    <div class="card" style="box-shadow:none;border:1px solid #e7e1d6;margin-top:10px">
      <div class="flex">
        ${rev.status === 'open' ? `<input type="checkbox" class="rev-check" value="${rev.id}" />` : ''}
        <div class="grow">
          <strong>#${rev.id} ${esc(rev.title)}</strong>
          <span class="badge ${rev.status}">${{ open: '进行中', merged: '已合入', abandoned: '已作废' }[rev.status]}</span>
          <span class="badge v">基准 v${rev.baseVersion.versionNo}</span>
          ${rev.mergedVersionId ? `<span class="badge merged">合入 v${rev.mergedVersionId}</span>` : ''}
          <div class="muted">${rev.createdBy?.displayName || ''} · ${rev.createdAt}</div>
        </div>
        ${rev.status === 'open' ? '<button class="btn small danger abandonBtn">作废</button>' : ''}
      </div>
      <div class="items" style="margin-top:8px"></div>
      <div class="additem" style="margin-top:8px"></div>
    </div>`);

  const itemsBox = card.querySelector('.items');
  for (const it of rev.items) {
    let target;
    if (it.action === 'add') {
      target = `新增到 ${sceneMap.get(it.sceneId)?.code || '?'} / ${roleMap.get(it.roleId)?.name || '?'}`;
    } else {
      const l = lineMap.get(it.lineId);
      target = `#${it.lineId} ${l ? `${sceneMap.get(l.sceneId)?.code} · ${roleMap.get(l.roleId)?.name}` : '(已删除)'}`;
    }
    const row = el(`
      <div class="line-row">
        <div class="meta">[${{ modify: '改', add: '增', delete: '删' }[it.action]}] ${target}
          ${rev.status === 'open' ? '<button class="btn small removeBtn" style="float:right">移除</button>' : ''}
        </div>
        ${it.action !== 'add' ? `<div class="diff old">原文：${esc(it.oldText)}</div>` : ''}
        ${it.action !== 'delete' ? `<div class="diff new">新文：${esc(it.newText)}</div>` : '<div class="diff old">删除该台词</div>'}
      </div>`);
    if (rev.status === 'open') {
      row.querySelector('.removeBtn').addEventListener('click', async () => {
        try {
          await api('DELETE', `/api/revision-items/${it.id}`);
          ctx.refresh();
        } catch (err) { toast(err.message, true); }
      });
    }
    itemsBox.appendChild(row);
  }
  if (!rev.items.length) itemsBox.innerHTML = '<span class="muted">暂无条目</span>';

  if (rev.status === 'open') {
    card.querySelector('.abandonBtn').addEventListener('click', async () => {
      if (!confirm('确定作废该修订？')) return;
      try {
        await api('POST', `/api/revisions/${rev.id}/abandon`);
        ctx.refresh();
      } catch (err) { toast(err.message, true); }
    });

    // 添加条目
    const addBox = card.querySelector('.additem');
    addBox.innerHTML = `
      <div class="flex">
        <select class="itAction" style="max-width:80px">
          <option value="modify">修改</option>
          <option value="delete">删除</option>
          <option value="add">新增</option>
        </select>
        <select class="itLine" style="max-width:260px"></select>
        <select class="itScene hidden"></select>
        <select class="itRole hidden"></select>
      </div>
      <div class="oldWrap"><textarea class="itOld" placeholder="原文（须与基准版本逐字一致，可从下方现行台词复制）"></textarea></div>
      <div class="newWrap"><textarea class="itNew" placeholder="新文"></textarea></div>
      <button class="btn small addBtn">添加条目</button>`;
    const actionSel = addBox.querySelector('.itAction');
    const lineSel = addBox.querySelector('.itLine');
    const sceneSel = addBox.querySelector('.itScene');
    const roleSel = addBox.querySelector('.itRole');
    sceneSel.innerHTML = ctx.scenes.map((s) => `<option value="${s.id}">${esc(s.code)} ${esc(s.title)}</option>`).join('');
    roleSel.innerHTML = ctx.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    function fillLines() {
      lineSel.innerHTML = ctx.lines
        .map((l) => {
          const s = sceneMap.get(l.sceneId);
          const r = roleMap.get(l.roleId);
          return `<option value="${l.id}">#${l.id} ${esc(s?.code || '')} ${esc(r?.name || '')}：${esc(l.text.slice(0, 24))}…</option>`;
        })
        .join('');
    }
    fillLines();
    function toggleMode() {
      const isAdd = actionSel.value === 'add';
      lineSel.classList.toggle('hidden', isAdd);
      sceneSel.classList.toggle('hidden', !isAdd);
      roleSel.classList.toggle('hidden', !isAdd);
      addBox.querySelector('.oldWrap').classList.toggle('hidden', isAdd);
      addBox.querySelector('.newWrap').classList.toggle('hidden', actionSel.value === 'delete');
    }
    actionSel.addEventListener('change', toggleMode);
    toggleMode();

    addBox.querySelector('.addBtn').addEventListener('click', async () => {
      const action = actionSel.value;
      const body = { action };
      if (action === 'add') {
        body.sceneId = Number(sceneSel.value);
        body.roleId = Number(roleSel.value);
        body.newText = addBox.querySelector('.itNew').value;
      } else {
        body.lineId = Number(lineSel.value);
        body.oldText = addBox.querySelector('.itOld').value;
        if (action === 'modify') body.newText = addBox.querySelector('.itNew').value;
      }
      try {
        await api('POST', `/api/revisions/${rev.id}/items`, body);
        toast('条目已加入修订');
        ctx.refresh();
      } catch (err) { toast(err.message, true); }
    });

    // 方便复制原文：点击现行台词下拉旁的按钮
    const copyBtn = el('<button class="btn small" type="button">填入所选台词原文</button>');
    copyBtn.addEventListener('click', () => {
      const l = lineMap.get(Number(lineSel.value));
      if (l) addBox.querySelector('.itOld').value = l.text;
    });
    addBox.querySelector('.oldWrap').prepend(copyBtn);
  }
  return card;
}

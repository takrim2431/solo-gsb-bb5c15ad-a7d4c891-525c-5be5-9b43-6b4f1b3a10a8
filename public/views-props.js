/* 导演：共享道具登记册（登记/调整总件数、占用概览） */

async function loadPropsTab() {
  const panel = document.getElementById('tab-props');
  panel.innerHTML = '<p class="muted">加载中…</p>';

  const card = el('<div class="card"><h2>共享道具登记册</h2><div class="propRows muted">加载中…</div></div>');
  const form = el(`
    <form class="flex propForm" style="margin-top:8px">
      <input name="name" placeholder="道具名称" required style="max-width:200px" />
      <input name="totalCount" type="number" min="0" step="1" placeholder="总件数（非负整数）" required style="max-width:180px" />
      <button class="btn small primary" type="submit">登记道具</button>
    </form>
    <div class="muted">仅有效时段的预约占用库存；取消或待调整时段释放占用，恢复有效时重新校验。
      半开区间计算，端点相接可复用。可在“排练与确认”的各时段行内填写/撤销预约。</div>`);
  panel.innerHTML = '';
  panel.appendChild(card);
  panel.appendChild(form);

  async function reload() {
    const box = card.querySelector('.propRows');
    let props;
    try {
      ({ props } = await api('GET', '/api/props'));
    } catch (err) {
      box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
      return;
    }
    if (!props.length) {
      box.innerHTML = '<span class="muted">尚未登记任何道具</span>';
      return;
    }
    box.innerHTML = `<table>
      <tr><th>道具</th><th>总件数</th><th>有效预约时段</th><th>峰值同时占用</th><th>当前余量</th><th>操作</th></tr>
      ${props
        .map(
          (p) => `<tr data-id="${p.id}">
        <td class="pName">${esc(p.name)}</td>
        <td class="pTotal">${p.totalCount}</td>
        <td>${p.activeReservationCount}</td>
        <td>${p.peakReserved}</td>
        <td><span class="badge ${p.availableNow === 0 ? 'pending' : 'done'}">${p.availableNow}</span></td>
        <td><button class="btn small editProp">调整总件数</button></td>
      </tr>`
        )
        .join('')}
    </table>`;
    box.querySelectorAll('.editProp').forEach((b) =>
      b.addEventListener('click', () => {
        const tr = b.closest('tr');
        const id = tr.dataset.id;
        const name = tr.querySelector('.pName').textContent;
        const cur = tr.querySelector('.pTotal').textContent;
        const v = prompt(`调整道具「${name}」的总件数（非负整数；下调时若不足现有有效预约将被拒绝）：`, cur);
        if (v == null) return;
        const totalCount = Number(v);
        if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
          toast('总件数必须是非负整数', true);
          return;
        }
        api('PATCH', `/api/props/${id}`, { totalCount })
          .then(() => {
            toast('道具总件数已更新');
            reload();
          })
          .catch((err) => toast(propErr(err), true));
      })
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('POST', '/api/props', {
        name: String(fd.get('name') || '').trim(),
        totalCount: Number(fd.get('totalCount')),
      });
      toast('道具已登记');
      form.reset();
      reload();
    } catch (err) {
      toast(propErr(err), true);
    }
  });

  reload();
}

/** 道具库存冲突的错误提示（展开 details.shortages：道具、缺口、冲突时段） */
function propErr(err) {
  if (err.code !== 'PROP_CAPACITY_CONFLICT' || !err.data?.details?.shortages?.length) return err.message;
  const lines = err.data.details.shortages.slice(0, 3).map((sh) => {
    const when = fmtTime(sh.peakAt);
    const who = sh.schedules.map((s) => `#${s.id} ${s.rehearsalName || ''} ${s.sceneTitle || ''}×${s.quantity}`).join('、');
    return `「${sh.propName}」${when} 需 ${sh.peakReserved}/${sh.totalCount} 件（缺口 ${sh.shortage}）：${who}`;
  });
  return `${err.message}；${lines.join('；')}`;
}

/**
 * 导演：某时段的道具预约编辑弹窗（在排练日程行内调用）。
 * 保存走 PUT 整组提交（PATCH 语义：未列出的道具不变；0 = 撤销该行）。
 */
async function openSchedulePropsDialog(rehearsalId, scheduleId) {
  let props;
  let current;
  try {
    [props, current] = await Promise.all([
      api('GET', '/api/props'),
      api('GET', `/api/rehearsals/${rehearsalId}/schedules/${scheduleId}/props`),
    ]);
  } catch (err) {
    toast(propErr(err), true);
    return;
  }
  const qtyMap = new Map(current.props.map((p) => [p.propId, p.quantity]));
  const rows = props.props
    .map((p) => {
      const q = qtyMap.has(p.id) ? qtyMap.get(p.id) : '';
      return `<tr>
        <td>${esc(p.name)}</td>
        <td>库存 ${p.totalCount}</td>
        <td><input type="number" min="0" step="1" data-prop="${p.id}" value="${q}" style="max-width:90px" placeholder="0" /></td>
      </tr>`;
    })
    .join('');
  const minText = current.minRemaining == null ? '（该时段当前不占用库存）' : `时段内最低余量：${current.minRemaining}`;
  const overlay = el(`
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:50;display:flex;align-items:center;justify-content:center">
      <div class="card" style="min-width:420px;max-width:560px">
        <h3>时段 #${scheduleId} 的道具预约</h3>
        <div class="muted">${esc(current.schedule.sceneTitle || '')} · ${fmtTime(current.schedule.startAt)} → ${fmtTime(current.schedule.endAt)} · ${minText}</div>
        <table class="propEditRows" style="margin-top:6px"><tr><th>道具</th><th>总件数</th><th>目标件数</th></tr>${rows}</table>
        <div class="muted">填写非负整数后保存；0 表示撤销该道具的预约，留空表示不变更。</div>
        <div class="flex" style="margin-top:8px">
          <button class="btn small primary saveProps" type="button"${current.status === 'cancelled' ? ' disabled' : ''}>保存预约</button>
          <button class="btn small cancelProps" type="button">关闭</button>
        </div>
        ${current.status === 'cancelled' ? '<div class="muted">该时段已取消：预约记录保留但不占用库存，不能再修改。</div>' : ''}
        ${current.status === 'needs_adjustment' ? '<div class="muted">该时段待调整：可编辑预约但暂不占用库存；恢复有效时重新校验。</div>' : ''}
      </div>
    </div>`);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.cancelProps').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.saveProps').addEventListener('click', async () => {
    const items = [];
    for (const input of overlay.querySelectorAll('input[data-prop]')) {
      if (input.value === '') continue;
      const quantity = Number(input.value);
      if (!Number.isSafeInteger(quantity) || quantity < 0) {
        toast('目标件数必须是非负整数（留空表示不变更）', true);
        return;
      }
      items.push({ propId: Number(input.dataset.prop), quantity });
    }
    try {
      await api('PUT', `/api/rehearsals/${rehearsalId}/schedules/${scheduleId}/props`, { items });
      toast('道具预约已保存');
      close();
      if (typeof reloadScheduleTable === 'function') reloadScheduleTable();
    } catch (err) {
      toast(propErr(err), true);
    }
  });
}

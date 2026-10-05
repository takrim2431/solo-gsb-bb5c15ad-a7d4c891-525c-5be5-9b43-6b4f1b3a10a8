/* 导演：排练与确认 + 总览 */
const SCHED_STATUS_LABEL = { active: '有效', needs_adjustment: '待调整', cancelled: '已取消' };
const SCHED_STATUS_CLASS = { active: 'done', needs_adjustment: 'pending', cancelled: 'abandoned' };
const ATT_STATUS_LABEL = { open: '开放中', closed: '已关闭', voided: '已作废' };
const ATT_STATUS_CLASS = { open: 'open', closed: 'done', voided: 'abandoned' };
const ATT_STATE_LABEL = { checked_in: '已签到', pending: '待签到', absent: '缺席', unmarked: '未签到' };
const ATT_STATE_CLASS = { checked_in: 'done', pending: 'pending', absent: 'abandoned', unmarked: 'abandoned' };
const NOTIF_STATUS_LABEL = { current: '当前批次', superseded: '已被取代', inactive: '已失效' };
const NOTIF_STATUS_CLASS = { current: 'open', superseded: 'abandoned', inactive: 'abandoned' };
const NOTIF_REASON_LABEL = { create: '创建时段', adjust: '调整时段', batch_adjust: '批量调整时段', cast: '派角/撤派', batch_cast: '批量派角', version_switch: '显式换版' };
const MY_NOTIF_STATE_LABEL = { pending: '待确认', confirmed: '已确认', superseded: '已被新批次取代', inactive: '已失效' };
const MY_NOTIF_STATE_CLASS = { pending: 'pending', confirmed: 'done', superseded: 'abandoned', inactive: 'abandoned' };

function fmtTime(iso) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** ISO(UTC) -> datetime-local 输入框所需的本地时间串 */
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 日程冲突（409 SCHEDULE_CONFLICT / UNAVAILABILITY_CONFLICT）时把冲突演员与不可用时段一并提示 */
function scheduleErr(err) {
  const conflicts = err?.data?.details?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length) {
    const actors = [...new Set(conflicts.map((c) => c.actorName))].join('、');
    let msg = `${err.message}（冲突演员：${actors}）`;
    const unavs = conflicts.filter((c) => c.unavailability);
    if (unavs.length) {
      const info = unavs.map(
        (c) =>
          `${c.actorName} ${fmtTime(c.unavailability.startAt)}→${fmtTime(c.unavailability.endAt)}` +
          `${c.unavailability.reason ? `（${c.unavailability.reason}）` : ''}`
      );
      msg += `；不可用时段：${[...new Set(info)].join('；')}`;
    }
    return msg;
  }
  return err.message;
}

/** 演员提交/修改不可用时段被拒（409 UNAVAILABILITY_CONFLICT）时指出冲突日程 */
function unavailabilityErr(err) {
  const conflicts = err?.data?.details?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length) {
    const scheds = conflicts.map((c) => {
      const s = c.schedule || {};
      return `${s.sceneTitle || '日程'} ${s.startAt ? fmtTime(s.startAt) : ''}→${s.endAt ? fmtTime(s.endAt) : ''}`;
    });
    return `${err.message}（冲突日程：${[...new Set(scheds)].join('；')}）`;
  }
  return err.message;
}

async function loadRehearsalsTab() {
  const panel = document.getElementById('tab-rehearsals');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  if (!state.plays.length) await refreshPlayList();
  const { rehearsals } = await api('GET', '/api/rehearsals');
  panel.innerHTML = '';

  const create = el(`
    <div class="card">
      <h2>创建排练（创建时固定引用一个版本，换版须显式操作）</h2>
      <form id="newRehForm" class="flex">
        <select name="playId" required></select>
        <select name="versionId" required></select>
        <input name="name" placeholder="排练名称（可选）" />
        <button class="btn primary" type="submit">创建</button>
      </form>
    </div>`);
  const playSel = create.querySelector('[name=playId]');
  const verSel = create.querySelector('[name=versionId]');
  playSel.innerHTML = state.plays
    .filter((p) => p.latestVersionId)
    .map((p) => `<option value="${p.id}">《${esc(p.title)}》</option>`)
    .join('');
  async function fillVersions() {
    if (!playSel.value) { verSel.innerHTML = ''; return; }
    const { versions } = await api('GET', `/api/plays/${playSel.value}/versions`);
    verSel.innerHTML = versions
      .slice()
      .reverse()
      .map((v) => `<option value="${v.id}">固定引用 v${v.versionNo}</option>`)
      .join('');
  }
  playSel.addEventListener('change', fillVersions);
  fillVersions();
  create.querySelector('#newRehForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/plays/${fd.get('playId')}/rehearsals`, {
        versionId: Number(fd.get('versionId')),
        name: fd.get('name'),
      });
      toast('排练已创建');
      loadRehearsalsTab();
    } catch (err) { toast(err.message, true); }
  });
  panel.appendChild(create);

  const list = el('<div class="card"><h2>排练列表</h2><div id="rehList"></div></div>');
  panel.appendChild(list);
  const box = list.querySelector('#rehList');
  for (const r of rehearsals) {
    const row = el(`
      <div class="line-row">
        <div class="flex">
          <div class="grow">
            <strong>${esc(r.name)}</strong>
            <span class="badge v">《${esc(r.playTitle)}》固定 v${r.versionNo}</span>
          </div>
          <button class="btn small openBtn">打开</button>
        </div>
        <div id="rehDetail-${r.id}"></div>
      </div>`);
    row.querySelector('.openBtn').addEventListener('click', () => toggleRehearsalDetail(r.id));
    box.appendChild(row);
  }
  if (!rehearsals.length) box.innerHTML = '<span class="muted">暂无排练</span>';
}

async function toggleRehearsalDetail(id) {
  const box = document.getElementById(`rehDetail-${id}`);
  if (box.dataset.open) { box.innerHTML = ''; box.dataset.open = ''; return; }
  box.dataset.open = '1';
  box.innerHTML = '<span class="muted">加载中…</span>';
  const data = await api('GET', `/api/rehearsals/${id}`);
  box.innerHTML = '';
  box.appendChild(renderRehearsalDetail(data, () => toggleRehearsalDetail(id).then(() => {})));
}

function renderRehearsalDetail(data, reload) {
  const wrap = el('<div style="margin-top:10px"></div>');
  const { rehearsal, cast, pending, versionLog, lastPublishAttempt } = data;

  // 换版
  const ver = el(`
    <div class="flex" style="margin:8px 0">
      <strong>固定版本 v${rehearsal.versionNo}</strong>
      <select class="switchVer" style="max-width:200px"></select>
      <button class="btn small previewBtn">预演换版</button>
      <button class="btn small switchBtn">显式换版</button>
    </div>
    <div class="switchPreview"></div>
    <div class="verLog muted"></div>`);
  api('GET', `/api/plays/${rehearsal.playId}/versions`).then(({ versions }) => {
    ver.querySelector('.switchVer').innerHTML = versions
      .map((v) => `<option value="${v.id}" ${v.id === rehearsal.versionId ? 'disabled' : ''}>v${v.versionNo}${v.id === rehearsal.versionId ? '（当前）' : ''}</option>`)
      .join('');
  });
  ver.querySelector('.previewBtn').addEventListener('click', () => {
    const vid = Number(ver.querySelector('.switchVer').value);
    showSwitchPreview(ver.querySelector('.switchPreview'), rehearsal, vid);
  });
  ver.querySelector('.switchBtn').addEventListener('click', async () => {
    const vid = Number(ver.querySelector('.switchVer').value);
    if (!confirm(`确定将排练切换固定到 v? 仅文本变化的角色×场次需要重新确认。`)) return;
    try {
      const r = await api('POST', `/api/rehearsals/${rehearsal.id}/switch-version`, { versionId: vid });
      const adj = r.needsAdjustmentSchedules?.length ? `；待调整时段 ${r.needsAdjustmentSchedules.length} 个` : '';
      toast(`已换版；待确认 ${r.pending.length} 项${adj}`);
      toggleRehearsalDetail(rehearsal.id).catch(() => {});
    } catch (err) { toast(scheduleErr(err), true); }
  });
  ver.querySelector('.verLog').textContent = versionLog.length
    ? '换版历史：' + versionLog.map((l) => `v${l.fromNo}→v${l.toNo}`).join('，')
    : '尚未换过版';
  wrap.appendChild(ver);

  // 派角
  const castBox = el(`
    <div style="margin-top:8px">
      <h3>派角 / 改派（改派后原演员确认不再计入）</h3>
      <div class="castRows"></div>
      <form class="flex assignForm" style="margin-top:6px">
        <select name="roleId" class="roleSel"></select>
        <select name="actorId" class="actorSel"></select>
        <button class="btn small">派角/改派</button>
        <button class="btn small openBatchCast" type="button">批量派角调整…</button>
      </form>
      <div class="batchCastBox" style="margin-top:8px;display:none">
        <h3 style="margin-bottom:4px">批量派角调整（至少两条；按整批最终派角统一校验，任一冲突整批不生效）</h3>
        <div class="batchCastRows muted">加载中…</div>
        <div class="flex" style="margin-top:6px">
          <button class="btn small primary batchCastSubmit" type="button">整批提交</button>
          <button class="btn small batchCastCancel" type="button">收起批量派角</button>
        </div>
        <div class="muted">勾选至少两个角色并选定目标演员（“— 撤派 / 不派 —”表示取消派角）；与当前相同的条目保持不变。
          整批按最终派角重算所有有效时段参与者：与其他有效日程或演员不可用时段冲突则整批不生效。</div>
      </div>
    </div>`);
  const roleSel = castBox.querySelector('.roleSel');
  const actorSel = castBox.querySelector('.actorSel');
  const batchCastBox = castBox.querySelector('.batchCastBox');
  const batchCastRows = castBox.querySelector('.batchCastRows');
  Promise.all([
    api('GET', `/api/plays/${rehearsal.playId}`),
    loadActors(),
  ]).then(([detail, actors]) => {
    roleSel.innerHTML = detail.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    actorSel.innerHTML = actors.map((a) => `<option value="${a.id}">${esc(a.displayName)}（@${esc(a.username)}）</option>`).join('');
    // 批量派角面板：每个角色一行（纳入勾选 + 当前演员 + 目标演员下拉，预填当前派角）
    const castMap = new Map(cast.map((c) => [c.roleId, c]));
    batchCastRows.innerHTML = detail.roles.length
      ? `<table>
          <tr><th>纳入</th><th>角色</th><th>当前演员</th><th>目标演员</th></tr>
          ${detail.roles
            .map((role) => {
              const cur = castMap.get(role.id);
              return `<tr data-role="${role.id}">
                <td><input type="checkbox" class="bcPick" /></td>
                <td>${esc(role.name)}</td>
                <td>${cur ? `${esc(cur.actorName)}（@${esc(cur.actorUsername)}）` : '<span class="muted">未派角</span>'}</td>
                <td><select class="bcActor">
                  <option value=""${cur ? '' : ' selected'}>— 撤派 / 不派 —</option>
                  ${actors
                    .map((a) => `<option value="${a.id}"${cur && cur.actorId === a.id ? ' selected' : ''}>${esc(a.displayName)}（@${esc(a.username)}）</option>`)
                    .join('')}
                </select></td>
              </tr>`;
            })
            .join('')}
        </table>`
      : '<span class="muted">该剧暂无角色</span>';
  });
  castBox.querySelector('.assignForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/rehearsals/${rehearsal.id}/cast`, {
        roleId: Number(roleSel.value),
        actorId: Number(actorSel.value),
      });
      toast('派角已更新（相关确认已重置）');
      toggleRehearsalDetail(rehearsal.id).catch(() => {});
    } catch (err) { toast(scheduleErr(err), true); }
  });
  // 批量派角：展开/收起面板；整批提交（至少两条，actorId 为空表示撤派）
  castBox.querySelector('.openBatchCast').addEventListener('click', () => {
    batchCastBox.style.display = batchCastBox.style.display === 'none' ? '' : 'none';
  });
  batchCastBox.querySelector('.batchCastCancel').addEventListener('click', () => {
    batchCastBox.style.display = 'none';
  });
  batchCastBox.querySelector('.batchCastSubmit').addEventListener('click', async () => {
    const items = [];
    batchCastRows.querySelectorAll('tr[data-role]').forEach((tr) => {
      if (!tr.querySelector('.bcPick').checked) return;
      const v = tr.querySelector('.bcActor').value;
      items.push({ roleId: Number(tr.dataset.role), actorId: v === '' ? null : Number(v) });
    });
    if (items.length < 2) {
      toast('批量派角一次至少勾选两个角色（单条请用上方“派角/改派”）', true);
      return;
    }
    try {
      const data = await api('POST', `/api/rehearsals/${rehearsal.id}/cast/batch`, { items });
      const notif = data.notifications.length ? `；${data.notifications.length} 个时段已生成新通知` : '';
      const same = data.unchanged.length ? `，${data.unchanged.length} 项无变化` : '';
      toast(`整批派角已生效：变更 ${data.changed} 项${same}${notif}`);
      toggleRehearsalDetail(rehearsal.id).catch(() => {});
    } catch (err) { toast(scheduleErr(err), true); }
  });
  const rows = castBox.querySelector('.castRows');
  rows.innerHTML = cast.length
    ? `<table><tr><th>角色</th><th>演员</th><th>操作</th></tr>${
        cast.map((c) => `<tr><td>${esc(c.roleName)}</td><td>${esc(c.actorName)}（@${esc(c.actorUsername)}）</td>
          <td><button class="btn small danger unassign" data-role="${c.roleId}">取消派角</button></td></tr>`).join('')
      }</table>`
    : '<span class="muted">尚未派角</span>';
  castBox.querySelectorAll('.unassign').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/rehearsals/${rehearsal.id}/cast/${b.dataset.role}`);
      toggleRehearsalDetail(rehearsal.id).catch(() => {});
    } catch (err) { toast(err.message, true); }
  }));
  wrap.appendChild(castBox);

  // 待确认
  const pendBox = el(`<div style="margin-top:8px"><h3>待确认（${pending.length} 项）</h3><div class="pendRows"></div></div>`);
  pendBox.querySelector('.pendRows').innerHTML = pending.length
    ? `<table><tr><th>演员</th><th>角色</th><th>场次</th><th>原因</th></tr>${
        pending.map((p) => `<tr><td>${esc(p.actorName)}</td><td>${esc(p.roleName)}</td><td>${esc(p.sceneTitle)}</td><td><span class="badge pending">${esc(p.reason)}</span></td></tr>`).join('')
      }</table>`
    : '<span class="badge done">全部确认完毕</span>';
  wrap.appendChild(pendBox);

  // 日程安排：为某场次安排带时区时段；参与者=当前版本本场有台词且已派角的演员
  const schedBox = el(`
    <div style="margin-top:8px">
      <h3>日程安排（带时区时段；重叠即冲突，端点相接不算）</h3>
      <div class="schedRows muted">加载中…</div>
      <div class="attDetail"></div>
      <div class="notifDetail"></div>
      <form class="flex schedForm" style="margin-top:6px">
        <select name="sceneId" class="sceneSel" style="max-width:180px"></select>
        <input type="datetime-local" name="startAt" required style="max-width:210px" />
        <input type="datetime-local" name="endAt" required style="max-width:210px" />
        <button class="btn small primary schedSubmit" type="submit">保存时段</button>
        <button class="btn small schedCancelEdit hidden" type="button">放弃调整</button>
      </form>
      <div class="muted">按本地时间选择，提交时自动携带时区；结束须晚于开始。未派角角色列为“待补派”，不阻止安排。</div>
      <div class="batchBox" style="margin-top:10px;display:none">
        <h3 style="margin-bottom:4px">批量调整时段（至少两条；整批按最终状态校验，任一冲突整批不生效）</h3>
        <div class="muted batchSelected">尚未选择时段</div>
        <div class="batchRows"></div>
        <div class="flex" style="margin-top:6px">
          <button class="btn small primary batchSubmit" type="button">整批提交</button>
          <button class="btn small batchCancel" type="button">收起批量调整</button>
        </div>
        <div class="muted">每行可改目标场次与起止时间；只勾选本排练内未取消的时段。无实质变化的行不会重发通知；待调整时段合法化后随批恢复有效。</div>
      </div>
    </div>`);
  wrap.appendChild(schedBox);
  setupScheduleEditor(schedBox, rehearsal);

  // 冲突详情
  if (lastPublishAttempt && lastPublishAttempt.hadConflict) {
    const cbox = el(`<div style="margin-top:8px"><h3>最近一次发布冲突（本次发布未生效）</h3></div>`);
    for (const c of lastPublishAttempt.conflicts) {
      cbox.appendChild(el(`
        <div class="conflict">
          <div class="kind">[${esc(c.kind)}] 修订 #${c.revisionId} · 台词 #${c.lineId ?? '-'}</div>
          <div>${esc(c.reason)}</div>
          ${c.baseText ? `<div class="diff old">原文：${esc(c.baseText)}</div>` : ''}
          ${c.currentText ? `<div class="diff new">现行：${esc(c.currentText)}</div>` : ''}
        </div>`));
    }
    wrap.appendChild(cbox);
  }
  return wrap;
}

async function loadActors() {
  // 导演可通过演员列表接口获取；若未暴露则从后端 dashboard 不可得，这里走专用端点
  return (await api('GET', '/api/actors')).actors;
}

/** 导演：换版预演（只读）——确认保留/重做、日程去向、参与者与通知接收人变化、冲突；可凭预演令牌提交 */
async function showSwitchPreview(box, rehearsal, versionId) {
  box.innerHTML = '<span class="muted">预演中…</span>';
  let p;
  try {
    p = await api('POST', `/api/rehearsals/${rehearsal.id}/switch-version/preview`, { versionId });
  } catch (err) {
    box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    return;
  }
  const names = (list) => list.map((a) => esc(a.actorName)).join('、');
  const confRows = (list, tag) =>
    list
      .map(
        (c) =>
          `<div class="muted">${tag}：${esc(c.actorName)} · ${esc(c.roleName)} · ${esc(c.sceneTitle)}` +
          `${c.reason ? `（${esc(c.reason)}）` : ''}</div>`
      )
      .join('');
  const schedRows = p.schedules
    .map((s) => {
      const parts = [
        s.afterStatus === 'needs_adjustment'
          ? '<span class="badge pending">将转为待调整</span>'
          : '<span class="badge done">继续有效</span>',
      ];
      if (s.participantsAdded.length) parts.push(`新增参与者：${names(s.participantsAdded)}`);
      if (s.participantsRemoved.length) parts.push(`退出参与者：${names(s.participantsRemoved)}`);
      if (s.notification?.willBecomeInactive) parts.push('当前通知批次将失效');
      else if (s.notification?.willGenerateBatch) {
        const n = [];
        if (s.notification.recipientsAdded?.length) n.push(`新增接收人：${names(s.notification.recipientsAdded)}`);
        if (s.notification.recipientsRemoved?.length) n.push(`移除接收人：${names(s.notification.recipientsRemoved)}`);
        parts.push(`将生成新通知批次（第 ${(s.notification.currentSeq ?? 0) + 1} 批）${n.length ? `：${n.join('；')}` : ''}`);
      }
      return `<div>#${s.id} ${esc(s.sceneTitle || '')} · ${fmtTime(s.startAt)} → ${fmtTime(s.endAt)}：${parts.join('；')}</div>`;
    })
    .join('');
  const conflictRows = [
    ...p.conflicts.schedule.map(
      (c) =>
        `<div>日程冲突：${esc(c.actorName)} · ${esc(c.schedule?.sceneTitle || '时段')} 与「${esc(c.overlapsWith?.rehearsalName || '')}」` +
        `${esc(c.overlapsWith?.sceneTitle || '时段')} ${c.overlapsWith?.startAt ? fmtTime(c.overlapsWith.startAt) : ''}→${c.overlapsWith?.endAt ? fmtTime(c.overlapsWith.endAt) : ''} 重叠</div>`
    ),
    ...p.conflicts.unavailability.map(
      (c) =>
        `<div>不可用冲突：${esc(c.actorName)} · ${esc(c.schedule?.sceneTitle || '时段')} 撞上不可用 ` +
        `${c.unavailability ? `${fmtTime(c.unavailability.startAt)}→${fmtTime(c.unavailability.endAt)}${c.unavailability.reason ? `（${esc(c.unavailability.reason)}）` : ''}` : ''}</div>`
    ),
  ].join('');
  box.innerHTML = `
    <div class="conflict" style="border-color:#8ca3b9;background:#f4f7fa">
      <div class="kind" style="color:#2b2620">换版预演：v${p.fromVersion.versionNo} → v${p.toVersion.versionNo}
        <span class="badge ${p.canCommit ? 'done' : 'pending'}">${p.canCommit ? '无冲突，可提交' : '存在冲突，暂不可提交'}</span></div>
      <div class="muted">预演为只读，不改变任何数据；提交前若排练版本、派角、确认、相关日程或参与演员的不可用记录变化，需重新预演。</div>
      <div style="margin-top:4px"><strong>确认：</strong>保留 ${p.confirmations.kept.length} 条，重做 ${p.confirmations.redone.length} 条</div>
      ${confRows(p.confirmations.redone, '重做')}
      <div style="margin-top:4px"><strong>有效日程：</strong></div>
      ${schedRows || '<div class="muted">无有效日程</div>'}
      ${conflictRows ? `<div style="margin-top:4px"><strong>冲突：</strong></div>${conflictRows}` : ''}
      <div class="flex" style="margin-top:6px">
        ${p.canCommit ? '<button class="btn small primary commitSwitch">按预演结果提交换版</button>' : ''}
        <button class="btn small closePreview">收起预演</button>
      </div>
    </div>`;
  box.querySelector('.closePreview').addEventListener('click', () => { box.innerHTML = ''; });
  const commitBtn = box.querySelector('.commitSwitch');
  if (commitBtn) {
    commitBtn.addEventListener('click', async () => {
      try {
        const r = await api('POST', `/api/rehearsals/${rehearsal.id}/switch-version/commit`, {
          versionId,
          previewToken: p.previewToken,
        });
        const adj = r.needsAdjustmentSchedules?.length ? `；待调整时段 ${r.needsAdjustmentSchedules.length} 个` : '';
        toast(`已按预演提交换版；待确认 ${r.pending.length} 项${adj}`);
        toggleRehearsalDetail(rehearsal.id).catch(() => {});
      } catch (err) {
        if (err?.data?.error === 'PREVIEW_STALE') {
          toast('预演已过期：相关状态已变化，请重新预演', true);
          box.innerHTML = '';
        } else {
          toast(scheduleErr(err), true);
        }
      }
    });
  }
}

/** 导演日程表“到场登记”列：未开启可开启（仅有效时段）；已开启显示状态与统计 */
function attendanceCell(s) {
  const a = s.attendance;
  if (!a) {
    return s.status === 'active'
      ? `<button class="btn small openAtt" data-id="${s.id}">开启登记</button>`
      : '<span class="muted">—</span>';
  }
  const stat = a.counted
    ? `应到 ${a.expected} · 签到 ${a.checkedIn}${a.status === 'closed' ? ` · 缺席 ${a.absent}` : ''}`
    : `已作废（应到 ${a.expected} · 曾签到 ${a.checkedIn}，不计出勤）`;
  const cancelledMark = a.scheduleCancelled ? ' <span class="badge abandoned">日程已取消</span>' : '';
  return `<span class="badge ${ATT_STATUS_CLASS[a.status]}">${ATT_STATUS_LABEL[a.status]}</span>${cancelledMark}
    <div class="muted">${stat}</div>
    <button class="btn small viewAtt" data-id="${s.id}">查看</button>
    ${a.status === 'open' ? `<button class="btn small danger closeAtt" data-id="${s.id}">关闭登记</button>` : ''}`;
}

/** 导演日程表“时段通知”列：当前批次待确认/已确认统计；已取消/待调整时段不计待确认 */
function notificationCell(s) {
  const n = s.notification;
  if (!n) return '<span class="muted">—</span>';
  const stat =
    n.status === 'current'
      ? n.expected === 0
        ? '无接收演员'
        : n.pending > 0
          ? `待确认 ${n.pending}/${n.expected}`
          : `全部已知悉（${n.expected} 人）`
      : `${NOTIF_STATUS_LABEL[n.status]}，不计待确认`;
  return `第 ${n.seq} 批<div class="muted">${stat}</div>
    <button class="btn small viewNotif" data-id="${s.id}">查看</button>`;
}

/** 导演：时段通知详情（当前批次的已确认/待确认名单 + 历史批次） */
async function showNotificationDetail(schedBox, rehearsal, scheduleId) {
  const box = schedBox.querySelector('.notifDetail');
  box.innerHTML = '<span class="muted">加载中…</span>';
  let data;
  try {
    data = await api('GET', `/api/rehearsals/${rehearsal.id}/schedules/${scheduleId}/notifications`);
  } catch (err) {
    box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    return;
  }
  const { current, history } = data;
  const names = (recipients, state) =>
    recipients
      .filter((r) => r.state === state)
      .map((r) => `${esc(r.actorName)}${r.confirmedAt ? `（${fmtTime(r.confirmedAt)}）` : ''}`)
      .join('、');
  const batchLine = (b) =>
    `#${b.seq} ${esc(NOTIF_REASON_LABEL[b.reason] || b.reason)} · ${fmtTime(b.createdAt)} 生成 · ` +
    `冻结 ${esc(b.sceneCode)} ${esc(b.sceneTitle)} · v${b.versionNo} · ${fmtTime(b.startAt)} → ${fmtTime(b.endAt)}`;
  box.innerHTML = `
    <div class="conflict" style="border-color:#8ca3b9;background:#f4f7fa">
      <div class="kind" style="color:#2b2620">时段知悉通知</div>
      ${
        current
          ? `<div style="margin-top:4px"><strong>当前批次 ${batchLine(current)}</strong></div>
             <div style="margin-top:4px">已确认：${names(current.recipients, 'confirmed') || '<span class="muted">无</span>'}</div>
             <div>待确认：${names(current.recipients, 'pending') || '<span class="muted">无</span>'}</div>`
          : '<div class="muted" style="margin-top:4px">当前无需确认的批次（时段已取消或待调整）。</div>'
      }
      ${
        history.length
          ? `<div class="muted" style="margin-top:6px">历史批次（保留但不计当前待确认）：</div>
             ${history
               .map(
                 (b) => `<div style="margin-top:2px">
                   <span class="badge ${NOTIF_STATUS_CLASS[b.status]}">${NOTIF_STATUS_LABEL[b.status]}</span>
                   ${batchLine(b)} · 已确认 ${b.stats.confirmed}/${b.stats.expected}
                 </div>`
               )
               .join('')}`
          : ''
      }
    </div>`;
}

/** 导演：登记详情（冻结的名单/缺口/统计） */
async function showAttendanceDetail(schedBox, rehearsal, scheduleId) {
  const box = schedBox.querySelector('.attDetail');
  box.innerHTML = '<span class="muted">加载中…</span>';
  let session;
  try {
    ({ session } = await api('GET', `/api/rehearsals/${rehearsal.id}/schedules/${scheduleId}/attendance`));
  } catch (err) {
    box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    return;
  }
  const st = session.stats;
  box.innerHTML = `
    <div class="conflict" style="border-color:#b9a98c;background:#faf8f4">
      <div class="kind" style="color:#2b2620">到场登记 #${session.id} · ${esc(session.sceneCode)} ${esc(session.sceneTitle)}
        · 固定 v${session.versionNo} · ${fmtTime(session.startAt)} → ${fmtTime(session.endAt)}
        <span class="badge ${ATT_STATUS_CLASS[session.status]}">${ATT_STATUS_LABEL[session.status]}</span>
        ${session.scheduleCancelled ? '<span class="badge abandoned">日程已取消</span>' : ''}
      </div>
      <div class="muted">名单、缺口与版本为开启时冻结的快照；后续改派/换版/调整日程不回写。</div>
      <table style="margin-top:6px">
        <tr><th>演员</th><th>角色（冻结）</th><th>状态</th><th>签到时间</th></tr>
        ${session.roster.map((m) => `<tr>
          <td>${esc(m.actorName)}（@${esc(m.actorUsername)}）</td>
          <td>${m.roles.map((r) => esc(r.roleName)).join('、')}</td>
          <td><span class="badge ${ATT_STATE_CLASS[m.state]}">${ATT_STATE_LABEL[m.state]}</span></td>
          <td>${m.checkedInAt ? fmtTime(m.checkedInAt) : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">开启时无应到演员</td></tr>'}
      </table>
      <div style="margin-top:6px">
        缺口（有台词未派角，不计应到）：${session.gaps.length ? session.gaps.map((g) => esc(g.roleName)).join('、') : '无'}
      </div>
      <div style="margin-top:4px">
        ${st.counted
          ? `应到 ${st.expected} · 已签到 ${st.checkedIn} · ${session.status === 'closed' ? `缺席 ${st.absent}` : `待签到 ${st.pending}`}`
          : `登记已作废：曾签到 ${st.checkedIn} 人（痕迹保留，不计出勤）`}
      </div>
    </div>`;
}

/** 导演：排练日程的列表 / 新建 / 单条调整 / 取消 / 批量调整 */
function setupScheduleEditor(schedBox, rehearsal) {
  const sceneSel = schedBox.querySelector('.sceneSel');
  const submitBtn = schedBox.querySelector('.schedSubmit');
  const cancelEditBtn = schedBox.querySelector('.schedCancelEdit');
  const batchBox = schedBox.querySelector('.batchBox');
  const batchRows = schedBox.querySelector('.batchRows');
  const batchSelected = schedBox.querySelector('.batchSelected');
  let editingId = null;
  let lastSchedules = [];
  const batchIds = new Set(); // 勾选待批量调整的时段 id

  // 渲染批量调整面板：每个所选时段一行（场次下拉 + 起止时间，预填当前值）
  function renderBatchBox(schedules) {
    lastSchedules = schedules;
    const picked = schedules.filter((s) => batchIds.has(s.id));
    batchSelected.textContent = picked.length
      ? `已选 ${picked.length} 条：#${picked.map((s) => s.id).join('、#')}`
      : '尚未选择时段';
    batchRows.innerHTML = picked.length
      ? `<table>
          <tr><th>时段</th><th>场次</th><th>开始</th><th>结束</th></tr>
          ${picked
            .map(
              (s) => `<tr data-id="${s.id}">
                <td>#${s.id} <span class="badge ${SCHED_STATUS_CLASS[s.status]}">${SCHED_STATUS_LABEL[s.status]}</span></td>
                <td><select class="bScene" style="max-width:170px">${sceneSel.innerHTML}</select></td>
                <td><input type="datetime-local" class="bStart" style="max-width:200px" value="${toLocalInput(s.startAt)}" /></td>
                <td><input type="datetime-local" class="bEnd" style="max-width:200px" value="${toLocalInput(s.endAt)}" /></td>
              </tr>`
            )
            .join('')}
        </table>`
      : '<span class="muted">请先在上方表格勾选至少两条未取消时段。</span>';
    // 预选每行当前场次
    picked.forEach((s) => {
      const tr = batchRows.querySelector(`tr[data-id="${s.id}"]`);
      if (tr) tr.querySelector('.bScene').value = String(s.sceneId);
    });
    batchBox.style.display = '';
  }

  schedBox.querySelector('.batchCancel').addEventListener('click', () => {
    batchBox.style.display = 'none';
  });

  schedBox.querySelector('.batchSubmit').addEventListener('click', async () => {
    const picked = lastSchedules.filter((s) => batchIds.has(s.id));
    if (picked.length < 2) {
      toast('批量调整一次至少选择两条时段（单条请用“调整”）', true);
      return;
    }
    const items = [];
    for (const s of picked) {
      const tr = batchRows.querySelector(`tr[data-id="${s.id}"]`);
      if (!tr) continue;
      const startVal = tr.querySelector('.bStart').value;
      const endVal = tr.querySelector('.bEnd').value;
      if (!startVal || !endVal) {
        toast(`时段 #${s.id} 的起止时间不能为空`, true);
        return;
      }
      items.push({
        scheduleId: s.id,
        sceneId: Number(tr.querySelector('.bScene').value),
        startAt: new Date(startVal).toISOString(),
        endAt: new Date(endVal).toISOString(),
      });
    }
    try {
      const data = await api('POST', `/api/rehearsals/${rehearsal.id}/schedules/batch-adjust`, { items });
      const changed = data.notifications.length;
      const unchanged = data.unchanged.length;
      toast(`整批调整已生效：${changed} 条时段有实质变化并已生成通知${unchanged ? `，${unchanged} 条无变化未重发` : ''}`);
      batchIds.clear();
      batchBox.style.display = 'none';
      reloadSchedules();
    } catch (err) {
      toast(scheduleErr(err), true);
    }
  });

  api('GET', `/api/plays/${rehearsal.playId}`).then((detail) => {
    sceneSel.innerHTML = detail.scenes
      .map((s) => `<option value="${s.id}">${esc(s.code)} ${esc(s.title)}</option>`)
      .join('');
  });

  const resetEdit = () => {
    editingId = null;
    submitBtn.textContent = '保存时段';
    cancelEditBtn.classList.add('hidden');
  };
  cancelEditBtn.addEventListener('click', resetEdit);

  async function reloadSchedules() {
    const rowsBox = schedBox.querySelector('.schedRows');
    let schedules;
    try {
      ({ schedules } = await api('GET', `/api/rehearsals/${rehearsal.id}/schedules`));
    } catch (err) {
      rowsBox.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
      return;
    }
    schedBox.querySelector('.attDetail').innerHTML = '';
    schedBox.querySelector('.notifDetail').innerHTML = '';
    // 已取消或不再存在的时段不能再纳入批量调整，从勾选集合中剔除
    for (const id of [...batchIds]) {
      if (!schedules.some((s) => s.id === id && s.status !== 'cancelled')) batchIds.delete(id);
    }
    if (batchBox.style.display !== 'none') renderBatchBox(schedules);
    if (!schedules.length) {
      rowsBox.innerHTML = '<span class="muted">暂无日程</span>';
      return;
    }
    rowsBox.innerHTML = `<table>
      <tr><th>选择</th><th>场次</th><th>时间</th><th>状态</th><th>参与演员</th><th>待补派</th><th>道具预约</th><th>到场登记</th><th>知悉通知</th><th>操作</th></tr>
      ${schedules.map((s) => `<tr>
        <td>${s.status !== 'cancelled' ? `<input type="checkbox" class="pickSched" data-id="${s.id}"${batchIds.has(s.id) ? ' checked' : ''} />` : ''}</td>
        <td>${esc(s.sceneCode)} ${esc(s.sceneTitle)}</td>
        <td>${fmtTime(s.startAt)} → ${fmtTime(s.endAt)}</td>
        <td><span class="badge ${SCHED_STATUS_CLASS[s.status]}">${SCHED_STATUS_LABEL[s.status]}</span></td>
        <td>${s.participants.map((p) => esc(p.actorName)).join('、') || '<span class="muted">无</span>'}</td>
        <td>${s.pendingCast.map((p) => esc(p.roleName)).join('、') || '—'}</td>
        <td><span class="propBrief">${(s.props || []).map((p) => `${esc(p.propName)}×${p.quantity}`).join('、') || '<span class="muted">—</span>'}</span>
            <button class="btn small viewProps" data-id="${s.id}">道具</button></td>
        <td>${attendanceCell(s)}</td>
        <td>${notificationCell(s)}</td>
        <td>${s.status !== 'cancelled'
          ? `<button class="btn small editSched" data-id="${s.id}">调整</button>
             <button class="btn small danger cancelSched" data-id="${s.id}">取消</button>`
          : ''}</td>
      </tr>`).join('')}
    </table>
    <div class="flex" style="margin-top:6px">
      <button class="btn small openBatch" type="button">批量调整所选时段…</button>
      <span class="muted batchCount">已选 ${schedules.filter((s) => batchIds.has(s.id)).length} 条（至少 2 条）</span>
    </div>`;
    rowsBox.querySelectorAll('.pickSched').forEach((cb) =>
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.id);
        if (cb.checked) batchIds.add(id);
        else batchIds.delete(id);
        rowsBox.querySelector('.batchCount').textContent =
          `已选 ${batchIds.size} 条（至少 2 条）`;
      })
    );
    rowsBox.querySelector('.openBatch').addEventListener('click', () => renderBatchBox(schedules));
    rowsBox.querySelectorAll('.cancelSched').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api('POST', `/api/rehearsals/${rehearsal.id}/schedules/${b.dataset.id}/cancel`);
          toast('该时段已取消');
          reloadSchedules();
        } catch (err) { toast(scheduleErr(err), true); }
      })
    );
    // 道具预约：打开该时段的道具编辑弹窗（含最低余量）
    rowsBox.querySelectorAll('.viewProps').forEach((b) =>
      b.addEventListener('click', () => openSchedulePropsDialog(rehearsal.id, Number(b.dataset.id)))
    );
    rowsBox.querySelectorAll('.editSched').forEach((b) =>
      b.addEventListener('click', () => {
        const s = schedules.find((x) => String(x.id) === b.dataset.id);
        if (!s) return;
        editingId = s.id;
        sceneSel.value = String(s.sceneId);
        schedBox.querySelector('[name=startAt]').value = toLocalInput(s.startAt);
        schedBox.querySelector('[name=endAt]').value = toLocalInput(s.endAt);
        submitBtn.textContent = '保存调整';
        cancelEditBtn.classList.remove('hidden');
      })
    );
    // 到场登记：开启 / 查看 / 关闭
    rowsBox.querySelectorAll('.openAtt').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api('POST', `/api/rehearsals/${rehearsal.id}/schedules/${b.dataset.id}/attendance`);
          toast('到场登记已开启（名单与缺口已冻结）');
          reloadSchedules();
        } catch (err) { toast(err.message, true); }
      })
    );
    rowsBox.querySelectorAll('.viewAtt').forEach((b) =>
      b.addEventListener('click', () => showAttendanceDetail(schedBox, rehearsal, b.dataset.id))
    );
    // 时段通知：查看当前批次名单与历史
    rowsBox.querySelectorAll('.viewNotif').forEach((b) =>
      b.addEventListener('click', () => showNotificationDetail(schedBox, rehearsal, b.dataset.id))
    );
    rowsBox.querySelectorAll('.closeAtt').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          const { session } = await api('POST', `/api/rehearsals/${rehearsal.id}/schedules/${b.dataset.id}/attendance/close`);
          toast(`登记已关闭：应到 ${session.stats.expected}，签到 ${session.stats.checkedIn}，缺席 ${session.stats.absent}`);
          reloadSchedules();
        } catch (err) { toast(err.message, true); }
      })
    );
  }

  // 道具弹窗保存后由 views-props.js 调用的刷新入口（仅刷新当前打开的日程表）
  // eslint-disable-next-line no-global-assign
  window.reloadScheduleTable = reloadSchedules;

  schedBox.querySelector('.schedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      sceneId: Number(fd.get('sceneId')),
      startAt: new Date(fd.get('startAt')).toISOString(),
      endAt: new Date(fd.get('endAt')).toISOString(),
    };
    try {
      if (editingId) {
        await api('PATCH', `/api/rehearsals/${rehearsal.id}/schedules/${editingId}`, body);
        toast('时段已调整');
      } else {
        await api('POST', `/api/rehearsals/${rehearsal.id}/schedules`, body);
        toast('时段已保存');
      }
      resetEdit();
      reloadSchedules();
    } catch (err) { toast(scheduleErr(err), true); }
  });

  reloadSchedules();
}

async function loadDashboard() {
  const panel = document.getElementById('tab-dashboard');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  const d = await api('GET', '/api/dashboard');
  panel.innerHTML = '';
  const card = el('<div class="card"><h2>各排练待确认</h2></div>');
  for (const item of d.rehearsals) {
    const block = el(`
      <div class="line-row">
        <strong>${esc(item.rehearsal.name)}</strong>
        <span class="badge v">v${item.rehearsal.versionId}</span>
        <span class="badge ${item.pending.length ? 'pending' : 'done'}">待确认 ${item.pending.length}</span>
        <table style="margin-top:6px">
          <tr><th>演员</th><th>角色</th><th>场次</th><th>原因</th></tr>
          ${item.pending.map((p) => `<tr><td>${esc(p.actorName)}</td><td>${esc(p.roleName)}</td><td>${esc(p.sceneTitle)}</td><td>${esc(p.reason)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">无</td></tr>'}
        </table>
      </div>`);
    card.appendChild(block);
  }
  panel.appendChild(card);

  const cc = el('<div class="card"><h2>最近冲突详情</h2></div>');
  if (!d.recentConflicts.length) {
    cc.innerHTML += '<span class="muted">暂无冲突发布</span>';
  }
  for (const a of d.recentConflicts) {
    const block = el(`
      <div class="conflict">
        <div class="kind">《${esc(a.playTitle)}》· ${a.createdAt} · ${esc(a.note)}</div>
        ${a.details.map((c) => `<div style="margin-top:4px">
          [${esc(c.kind)}] 修订 #${c.revisionId} 台词 #${c.lineId ?? '-'}：${esc(c.reason)}
          ${c.baseText ? `<div class="diff old">原文：${esc(c.baseText)}</div>` : ''}
          ${c.currentText ? `<div class="diff new">现行：${esc(c.currentText)}</div>` : ''}
        </div>`).join('')}
      </div>`);
    cc.appendChild(block);
  }
  panel.appendChild(cc);
}

/* ---------- 演员视图 ---------- */
async function loadActorHome() {
  const panel = document.getElementById('actorView');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  const { rehearsals } = await api('GET', '/api/rehearsals');
  panel.innerHTML = '';
  const card = el('<div class="card"><h2>我的排练</h2></div>');
  for (const r of rehearsals) {
    const row = el(`
      <div class="line-row" style="cursor:pointer">
        <strong>${esc(r.name)}</strong>
        <span class="badge v">《${esc(r.playTitle)}》固定 v${r.versionNo}</span>
        <div class="muted">点击查看只含你所派角色的排练稿</div>
      </div>`);
    row.addEventListener('click', () => loadActorScript(r.id));
    card.appendChild(row);
  }
  if (!rehearsals.length) card.innerHTML += '<p class="muted">你暂时没有被分配到任何排练。</p>';
  panel.appendChild(card);
  panel.appendChild(renderMyNotificationsCard());
  panel.appendChild(renderUnavailabilityCard());
}

/** 演员：我的时段通知（导演调整安排后需确认知悉；旧批次保留可查但不能确认） */
function renderMyNotificationsCard() {
  const card = el(`
    <div class="card">
      <h2>我的时段通知</h2>
      <div class="notifRows muted">加载中…</div>
      <div class="muted">导演新建/调整时段、派角/撤派或显式换版后会生成新通知批次；请确认“待确认”的批次。
        旧批次保留可查，但不能再确认。</div>
    </div>`);
  const rowsBox = card.querySelector('.notifRows');

  async function reload() {
    let items;
    try {
      ({ notifications: items } = await api('GET', '/api/me/schedule-notifications'));
    } catch (err) {
      rowsBox.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
      return;
    }
    if (!items.length) {
      rowsBox.innerHTML = '<span class="muted">暂无时段通知</span>';
      return;
    }
    rowsBox.innerHTML = `<table>
      <tr><th>排练 / 场次</th><th>时间</th><th>版本</th><th>批次</th><th>状态</th><th>操作</th></tr>
      ${items.map((n) => `<tr>
        <td>${esc(n.rehearsalName)} · ${esc(n.sceneCode)} ${esc(n.sceneTitle)}
          <div class="muted">${(n.myRoles || []).map((r) => esc(r.roleName)).join('、')}</div></td>
        <td>${fmtTime(n.startAt)} → ${fmtTime(n.endAt)}</td>
        <td>v${n.versionNo}</td>
        <td>第 ${n.seq} 批</td>
        <td><span class="badge ${MY_NOTIF_STATE_CLASS[n.myState]}">${MY_NOTIF_STATE_LABEL[n.myState]}</span>
          ${n.confirmedAt ? `<div class="muted">${fmtTime(n.confirmedAt)}</div>` : ''}</td>
        <td>${n.myState === 'pending' ? `<button class="btn small primary confirmNotif" data-id="${n.id}">确认知悉</button>` : ''}</td>
      </tr>`).join('')}
    </table>`;
    rowsBox.querySelectorAll('.confirmNotif').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          const { confirmation } = await api('POST', `/api/schedule-notifications/${b.dataset.id}/confirm`);
          toast(confirmation.alreadyConfirmed ? '此前已确认过该批次' : '已确认知悉该时段');
          reload();
        } catch (err) {
          toast(err.message, true);
          reload();
        }
      })
    );
  }

  reload();
  return card;
}

/** 演员：我的不可用时段（登记/修改/撤销；与本人有效日程重叠会被整次拒绝） */
function renderUnavailabilityCard() {
  const card = el(`
    <div class="card">
      <h2>我的不可用时段</h2>
      <div class="unavRows muted">加载中…</div>
      <form class="flex unavForm" style="margin-top:6px">
        <input type="datetime-local" name="startAt" required style="max-width:210px" />
        <input type="datetime-local" name="endAt" required style="max-width:210px" />
        <input name="reason" placeholder="原因（必填）" required style="max-width:180px" />
        <button class="btn small primary unavSubmit" type="submit">登记不可用</button>
        <button class="btn small unavCancelEdit hidden" type="button">放弃修改</button>
      </form>
      <div class="muted">按本地时间选择，提交时自动携带时区，系统按 UTC 保存；结束须晚于开始，端点相接不算重叠。
        若与本人当前参与的有效排练日程重叠，登记/修改会被整次拒绝。</div>
    </div>`);
  const rowsBox = card.querySelector('.unavRows');
  const form = card.querySelector('.unavForm');
  const submitBtn = card.querySelector('.unavSubmit');
  const cancelEditBtn = card.querySelector('.unavCancelEdit');
  let editingId = null;
  const resetEdit = () => {
    editingId = null;
    submitBtn.textContent = '登记不可用';
    cancelEditBtn.classList.add('hidden');
    form.reset();
  };
  cancelEditBtn.addEventListener('click', resetEdit);

  async function reload() {
    let items;
    try {
      ({ unavailability: items } = await api('GET', '/api/me/unavailability'));
    } catch (err) {
      rowsBox.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
      return;
    }
    if (!items.length) {
      rowsBox.innerHTML = '<span class="muted">暂无不可用时段</span>';
      return;
    }
    rowsBox.innerHTML = `<table>
      <tr><th>开始</th><th>结束</th><th>原因</th><th>操作</th></tr>
      ${items.map((u) => `<tr>
        <td>${fmtTime(u.startAt)}</td>
        <td>${fmtTime(u.endAt)}</td>
        <td>${esc(u.reason)}</td>
        <td>
          <button class="btn small editUnav" data-id="${u.id}">修改</button>
          <button class="btn small danger delUnav" data-id="${u.id}">撤销</button>
        </td>
      </tr>`).join('')}
    </table>`;
    rowsBox.querySelectorAll('.editUnav').forEach((b) =>
      b.addEventListener('click', () => {
        const u = items.find((x) => String(x.id) === b.dataset.id);
        if (!u) return;
        editingId = u.id;
        form.querySelector('[name=startAt]').value = toLocalInput(u.startAt);
        form.querySelector('[name=endAt]').value = toLocalInput(u.endAt);
        form.querySelector('[name=reason]').value = u.reason;
        submitBtn.textContent = '保存修改';
        cancelEditBtn.classList.remove('hidden');
      })
    );
    rowsBox.querySelectorAll('.delUnav').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api('DELETE', `/api/me/unavailability/${b.dataset.id}`);
          toast('该不可用时段已撤销');
          if (editingId === Number(b.dataset.id)) resetEdit();
          reload();
        } catch (err) { toast(err.message, true); }
      })
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      startAt: new Date(fd.get('startAt')).toISOString(),
      endAt: new Date(fd.get('endAt')).toISOString(),
      reason: fd.get('reason'),
    };
    try {
      if (editingId) {
        await api('PATCH', `/api/me/unavailability/${editingId}`, body);
        toast('不可用时段已修改');
      } else {
        await api('POST', '/api/me/unavailability', body);
        toast('不可用时段已登记');
      }
      resetEdit();
      reload();
    } catch (err) { toast(unavailabilityErr(err), true); }
  });

  reload();
  return card;
}

async function loadActorScript(rehearsalId) {
  const panel = document.getElementById('actorView');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  let data;
  try {
    data = await api('GET', `/api/rehearsals/${rehearsalId}/script`);
  } catch (err) {
    toast(err.message, true);
    loadActorHome();
    return;
  }
  const { rehearsal, lines, confirmations } = data;
  const confMap = new Map(confirmations.map((c) => [`${c.roleId}:${c.sceneId}`, c]));

  panel.innerHTML = '';
  const head = el(`
    <div class="card">
      <button class="btn small" id="backBtn">← 返回我的排练</button>
      <h2 style="margin-top:8px">${esc(reh2(rehearsal))}</h2>
      <div class="muted">排练固定引用 v${rehearsal.versionNo}；仅显示你获分配角色的台词。请逐场确认。</div>
    </div>`);
  head.querySelector('#backBtn').addEventListener('click', loadActorHome);
  panel.appendChild(head);

  // 我的排练时段：仅自己当前参与的有效时段；到场登记开放中且本人在名单上时可签到；
  // 有时段通知当前批次时可确认知悉
  let mySchedules = [];
  try {
    ({ schedules: mySchedules } = await api('GET', `/api/rehearsals/${rehearsalId}/schedules`));
  } catch { mySchedules = []; }
  const schedCard = el('<div class="card"><h2>我的排练时段</h2><div class="mySched"></div></div>');
  const mySchedBox = schedCard.querySelector('.mySched');
  if (!mySchedules.length) {
    mySchedBox.innerHTML = '<span class="muted">暂无日程安排</span>';
  } else {
    for (const s of mySchedules) {
      const row = el(`
        <div class="line-row">
          <div class="meta">${esc(s.sceneCode)} ${esc(s.sceneTitle)} · ${(s.myRoles || []).map((r) => esc(r.roleName)).join('、')}</div>
          ${(s.props && s.props.length) ? `<div class="muted">共享道具：${s.props.map((p) => `${esc(p.propName)}×${p.quantity}`).join('、')}</div>` : ''}
          <div class="flex">
            <span class="grow">${fmtTime(s.startAt)} → ${fmtTime(s.endAt)}</span>
            <span class="notifArea"></span>
            <span class="attArea"></span>
          </div>
        </div>`);
      const nArea = row.querySelector('.notifArea');
      const notif = s.notification;
      if (notif) {
        if (notif.myState === 'confirmed') {
          nArea.innerHTML = `<span class="badge done">已知悉第 ${notif.seq} 批</span>`;
        } else {
          const btn = el(`<button class="btn small">知悉确认（第 ${notif.seq} 批）</button>`);
          btn.addEventListener('click', async () => {
            try {
              const { confirmation } = await api('POST', `/api/schedule-notifications/${notif.id}/confirm`);
              toast(confirmation.alreadyConfirmed ? '此前已确认过该批次' : '已确认知悉该时段');
              loadActorScript(rehearsalId);
            } catch (err) { toast(err.message, true); }
          });
          nArea.appendChild(btn);
        }
      }
      const area = row.querySelector('.attArea');
      const att = s.attendance;
      if (att) {
        if (att.myState === 'checked_in') {
          area.innerHTML = `<span class="badge done">已签到 ${fmtTime(att.checkedInAt)}</span>`;
        } else if (att.myState === 'absent') {
          area.innerHTML = '<span class="badge abandoned">缺席（登记已关闭）</span>';
        } else if (att.status === 'voided') {
          area.innerHTML = '<span class="badge abandoned">登记已作废</span>';
        } else {
          const btn = el('<button class="btn small primary">到场签到</button>');
          btn.addEventListener('click', async () => {
            try {
              const { checkIn } = await api('POST', `/api/rehearsals/${rehearsalId}/schedules/${s.id}/attendance/check-in`);
              toast(checkIn.alreadyCheckedIn ? '此前已签到' : '签到成功');
              loadActorScript(rehearsalId);
            } catch (err) { toast(err.message, true); }
          });
          area.appendChild(btn);
        }
      }
      mySchedBox.appendChild(row);
    }
  }
  panel.appendChild(schedCard);

  const scenes = new Map();
  for (const l of lines) {
    if (!scenes.has(l.sceneId)) scenes.set(l.sceneId, { code: l.sceneCode, title: l.sceneTitle, seq: l.sceneSeq, lines: [] });
    scenes.get(l.sceneId).lines.push(l);
  }
  for (const [sceneId, s] of [...scenes.entries()].sort((a, b) => a[1].seq - b[1].seq)) {
    const roleIds = [...new Set(s.lines.map((l) => l.roleId))];
    // 一个场次若有多个所派角色，合并到一张确认卡
    const statuses = roleIds.map((rid) => confMap.get(`${rid}:${sceneId}`));
    const allDone = statuses.every((c) => c && c.confirmed);
    const block = el(`
      <div class="card scene-card">
        <div class="flex">
          <h2 class="grow">${esc(s.code)} · ${esc(s.title)}</h2>
          <span class="badge ${allDone ? 'done' : 'pending'}">${allDone ? '已确认' : '待确认'}</span>
        </div>
        <div class="line-list"></div>
        <div class="confirmArea" style="margin-top:8px"></div>
      </div>`);
    for (const l of s.lines) {
      block.querySelector('.line-list').appendChild(el(`
        <div class="line-row">
          <div class="meta">${esc(l.roleName)} · 顺序 ${l.seq}</div>
          <div>${esc(l.text)}</div>
        </div>`));
    }
    const area = block.querySelector('.confirmArea');
    for (const rid of roleIds) {
      const c = confMap.get(`${rid}:${sceneId}`);
      const roleName = s.lines.find((l) => l.roleId === rid)?.roleName || rid;
      const btn = el(`
        <div class="flex" style="margin:4px 0">
          <span class="grow">角色「${esc(roleName)}」${c?.confirmed ? `<span class="badge done">已于 ${c.confirmedAt} 确认</span>` : '<span class="badge pending">未确认</span>'}</span>
          <button class="btn small primary">${c?.confirmed ? '重新确认本场' : '确认本场台词'}</button>
        </div>`);
      btn.querySelector('button').addEventListener('click', async () => {
        try {
          await api('POST', `/api/rehearsals/${rehearsalId}/confirm`, { roleId: rid, sceneId: Number(sceneId) });
          toast('已确认');
          loadActorScript(rehearsalId);
        } catch (err) { toast(err.message, true); }
      });
      area.appendChild(btn);
    }
    panel.appendChild(block);
  }
}

function reh2(r) {
  return `${r.name}（《${r.playTitle}》）`;
}

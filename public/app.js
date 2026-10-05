/* global */
const state = {
  user: null,
  plays: [],
  currentPlayId: null,
  currentRehearsalId: null,
};

// ---------- API 封装 ----------
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (!res.ok) {
    const err = new Error(data?.message || `${method} ${url} -> ${res.status}`);
    err.status = res.status;
    err.code = data?.error;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
  el.classList.remove('hidden');
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- 登录 / 启动 ----------
async function bootstrap() {
  try {
    const { user } = await api('GET', '/api/me');
    state.user = user;
    enterApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('directorView').classList.add('hidden');
  document.getElementById('actorView').classList.add('hidden');
  document.getElementById('userbox').classList.add('hidden');
}

function enterApp() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('userbox').classList.remove('hidden');
  document.getElementById('userinfo').textContent =
    `${state.user.displayName}（${state.user.role === 'director' ? '导演' : '演员'} · @${state.user.username}）`;
  if (state.user.role === 'director') {
    document.getElementById('directorView').classList.remove('hidden');
    document.getElementById('actorView').classList.add('hidden');
    initDirectorTabs();
    loadPlaysTab();
  } else {
    document.getElementById('directorView').classList.add('hidden');
    document.getElementById('actorView').classList.remove('hidden');
    loadActorHome();
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const data = await api('POST', '/api/login', {
      username: fd.get('username'),
      password: fd.get('password'),
    });
    state.user = data.user;
    enterApp();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }
  location.reload();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const name = tab.dataset.tab;
    document.querySelectorAll('.tabpanel').forEach((p) => p.classList.add('hidden'));
    document.getElementById(`tab-${name}`).classList.remove('hidden');
    if (name === 'plays') loadPlaysTab();
    if (name === 'revisions') loadRevisionsTab();
    if (name === 'rehearsals') loadRehearsalsTab();
    if (name === 'props') loadPropsTab();
    if (name === 'dashboard') loadDashboard();
  });
});

function initDirectorTabs() {
  // 首次 enterApp 时触发一次
}

bootstrap();

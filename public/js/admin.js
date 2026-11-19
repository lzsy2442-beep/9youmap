// 管理台：概览 / 公告 / 用户 / 标记 / 举报
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const ROLE_LABEL = { site_admin: '站长', admin: '管理员', user: '普通' };
const roleLabel = (r) => ROLE_LABEL[r] || r;

const state = { me: null, tab: 'overview', notices: [], users: { page: 1, q: '' }, markers: { page: 1, q: '', server: '' }, servers: [] };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || (data && data.ok === false)) {
    const err = data?.error || {};
    const e = new Error(err.message || `请求失败（${res.status}）`);
    e.code = err.code;
    e.status = res.status;
    throw e;
  }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#admin-toasts').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ── 启动 ───────────────────────────────────────────────────
async function boot() {
  let me;
  try {
    me = await api('/api/admin/me');
  } catch (err) {
    if (err.status === 401) return renderDenied('请先登录', '管理台需要登录后才能使用。请先回到地图登录你的账号，再回来。');
    return renderDenied('读取失败', err.message);
  }
  state.me = me;
  $('#admin-user').textContent = `${me.user.nickname}（${me.user.role === 'site_admin' ? '站长' : '管理员'}）`;
  if (!me.isAdmin) {
    return renderDenied('没有管理员权限', `当前账号是「${me.user.nickname}」，还没有管理权限。在服务器上执行下面这条命令即可提升：<br><code>node scripts/admin.mjs promote ${esc(me.user.nickname)}</code>`);
  }
  const boot = await api('/api/bootstrap');
  state.servers = boot.servers;
  switchTab('overview');
}

function renderDenied(title, detail) {
  $('#admin-main').innerHTML = `
    <h2 class="admin-h2">${esc(title)}</h2>
    <p class="admin-hint">${detail}</p>
    <p style="margin-top:16px"><a class="admin-btn ghost" href="/" style="display:inline-block;text-decoration:none">← 回到地图</a></p>`;
}

// ── Tab ────────────────────────────────────────────────────
document.querySelectorAll('#admin-tabs button').forEach((b) => {
  b.onclick = () => switchTab(b.dataset.tab);
});

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#admin-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'overview') loadOverview();
  if (tab === 'notices') loadNotices();
  if (tab === 'users') loadUsers();
  if (tab === 'markers') loadMarkers();
  if (tab === 'reports') loadReports();
}

// ── 概览 ───────────────────────────────────────────────────
async function loadOverview() {
  const d = await api('/api/admin/overview');
  const maxServer = Math.max(1, ...d.byServer.map((s) => s.n));
  $('#admin-main').innerHTML = `
    <div class="stat-grid">
      <div class="stat"><b>${d.markers}</b><span>地图上的标记</span></div>
      <div class="stat"><b>${d.users}</b><span>注册账号</span></div>
      <div class="stat"><b>+${d.newUsers}</b><span>24 小时新增账号</span></div>
      <div class="stat"><b>+${d.newMarkers}</b><span>24 小时新增标记</span></div>
      <div class="stat"><b>${d.notices}</b><span>公告</span></div>
      <div class="stat"><b>${d.reportsOpen}</b><span>待处理举报</span></div>
    </div>

    <h2 class="admin-h2">各渠道服分布</h2>
    ${d.byServer.map((s) => `
      <div class="bar-row">
        <span class="bar-name">${esc(s.name || s.key)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((s.n / maxServer) * 100)}%;background:${esc(s.color || '#B08A4F')}"></span></span>
        <span class="bar-num">${s.n}</span>
      </div>`).join('') || '<p class="admin-hint">还没有数据</p>'}

    <h2 class="admin-h2">最近注册</h2>
    <div class="table-wrap">
      <table class="admin-table">
        <thead><tr><th>昵称</th><th>渠道服</th><th>城市</th><th>角色</th><th>时间</th></tr></thead>
        <tbody>
          ${d.recentUsers.map((u) => `<tr>
            <td>${esc(u.nickname)}</td>
            <td>${esc(u.server_name || u.server_key)}</td>
            <td>${esc(u.city_name || '—')}</td>
            <td>${u.role === 'user' ? '普通' : `<span class="tag role">${esc(roleLabel(u.role))}</span>`}</td>
            <td>${fmtDate(u.created_at)}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty-row">暂无</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2 class="admin-h2">最近落点</h2>
    <div class="table-wrap">
      <table class="admin-table">
        <thead><tr><th>昵称</th><th>类型</th><th>地点</th><th>时间</th></tr></thead>
        <tbody>
          ${d.recentMarkers.map((m) => `<tr>
            <td>${esc(m.nickname)}</td>
            <td>${m.kind === 'rabbit' ? '金兔子' : '伞'}</td>
            <td>${esc(m.label || '—')}</td>
            <td>${fmtDate(m.created_at)}</td>
          </tr>`).join('') || '<tr><td colspan="4" class="empty-row">暂无</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

// ── 公告 ───────────────────────────────────────────────────
async function loadNotices() {
  const { notices } = await api('/api/admin/notices');
  state.notices = notices;
  $('#admin-main').innerHTML = `
    <h2 class="admin-h2">发一条新公告</h2>
    <form class="admin-form" id="notice-form">
      <label>标题<input name="title" maxlength="60" placeholder="例如：维护通知" required></label>
      <label>正文<textarea name="body" maxlength="2000" placeholder="支持换行，最多 2000 字" required></textarea></label>
      <div class="row">
        <label>级别
          <select name="level">
            <option value="info">普通（info）</option>
            <option value="warn">提醒（warn）</option>
            <option value="important">重要（important）</option>
          </select>
        </label>
        <label>到期时间（可留空）<input name="expiresAt" placeholder="2026-12-01T00:00:00Z"></label>
      </div>
      <label style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" name="pinned" style="width:16px;height:16px"> 置顶
      </label>
      <div><button class="admin-btn" type="submit">发布公告</button></div>
    </form>

    <h2 class="admin-h2">已有的公告（${notices.length}）</h2>
    <div class="table-wrap">
      <table class="admin-table">
        <thead><tr><th>标题</th><th>级别</th><th>置顶</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          ${notices.map((n) => `<tr data-id="${n.id}">
            <td class="wrap">${esc(n.title)}</td>
            <td><span class="tag ${esc(n.level)}">${esc(n.level)}</span></td>
            <td>${n.pinned ? '<span class="tag pin">置顶</span>' : '—'}</td>
            <td>${fmtDate(n.created_at)}</td>
            <td>
              <button class="admin-btn small ghost" data-pin="${n.id}" data-v="${n.pinned ? 0 : 1}">${n.pinned ? '取消置顶' : '置顶'}</button>
              <button class="admin-btn small danger" data-del="${n.id}">删除</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty-row">还没有公告</td></tr>'}
        </tbody>
      </table>
    </div>`;

  $('#notice-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/admin/notices', {
        method: 'POST',
        body: {
          title: f.title.value.trim(),
          body: f.body.value.trim(),
          level: f.level.value,
          pinned: f.pinned.checked,
          expiresAt: f.expiresAt.value.trim() || null
        }
      });
      toast('公告已发布', 'ok');
      loadNotices();
    } catch (err) { toast(err.message, 'warn'); }
  };

  document.querySelectorAll('[data-pin]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/admin/notices/${b.dataset.pin}`, { method: 'PATCH', body: { pinned: b.dataset.v === '1' } });
        toast('已更新');
        loadNotices();
      } catch (err) { toast(err.message, 'warn'); }
    };
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这条公告？')) return;
      try {
        await api(`/api/admin/notices/${b.dataset.del}`, { method: 'DELETE' });
        toast('已删除');
        loadNotices();
      } catch (err) { toast(err.message, 'warn'); }
    };
  });
}

// ── 用户 ───────────────────────────────────────────────────
async function loadUsers(page = state.users.page, q = state.users.q) {
  state.users = { page, q };
  const d = await api(`/api/admin/users?q=${encodeURIComponent(q)}&page=${page}`);
  $('#admin-main').innerHTML = `
    <div class="toolbar">
      <input id="user-q" placeholder="搜昵称 / 邮箱 / ID" value="${esc(q)}">
      <button class="admin-btn ghost small" id="user-search">搜索</button>
      <span class="admin-hint">共 ${d.total} 个账号</span>
    </div>
    <div class="table-wrap">
      <table class="admin-table">
        <thead><tr><th>昵称</th><th>渠道服</th><th>标记</th><th>角色</th><th>状态</th><th>注册</th><th>操作</th></tr></thead>
        <tbody>
          ${d.rows.map((u) => `<tr>
            <td>${esc(u.nickname)}${u.is_seed ? ' <span class="tag">示例</span>' : ''}</td>
            <td>${esc(u.server_name || u.server_key)}</td>
            <td>${u.marker_count}</td>
            <td><span class="tag role">${esc(roleLabel(u.role))}</span></td>
            <td>${u.banned ? '<span class="tag banned">已封禁</span>' : '正常'}</td>
            <td>${fmtDate(u.created_at)}</td>
            <td>
              <button class="admin-btn small ghost" data-role="${esc(u.id)}" data-v="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? '降为普通' : '设为管理员'}</button>
              <button class="admin-btn small ${u.banned ? 'ghost' : 'danger'}" data-ban="${esc(u.id)}" data-v="${u.banned ? 0 : 1}">${u.banned ? '解封' : '封禁'}</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty-row">没有匹配的账号</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="pager">
      <button class="admin-btn ghost small" id="prev-page" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${d.page} 页 / 共 ${Math.max(1, Math.ceil(d.total / d.size))} 页</span>
      <button class="admin-btn ghost small" id="next-page" ${page * d.size >= d.total ? 'disabled' : ''}>下一页</button>
    </div>`;

  $('#user-search').onclick = () => loadUsers(1, $('#user-q').value.trim());
  $('#user-q').onkeydown = (e) => { if (e.key === 'Enter') loadUsers(1, e.target.value.trim()); };
  $('#prev-page').onclick = () => loadUsers(page - 1, q);
  $('#next-page').onclick = () => loadUsers(page + 1, q);

  document.querySelectorAll('[data-role]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/admin/users/${b.dataset.role}`, { method: 'PATCH', body: { role: b.dataset.v } });
        toast('角色已更新', 'ok');
        loadUsers(page, q);
      } catch (err) { toast(err.message, 'warn'); }
    };
  });
  document.querySelectorAll('[data-ban]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/admin/users/${b.dataset.ban}`, { method: 'PATCH', body: { banned: b.dataset.v === '1' } });
        toast('状态已更新', 'ok');
        loadUsers(page, q);
      } catch (err) { toast(err.message, 'warn'); }
    };
  });
}

// ── 标记 ───────────────────────────────────────────────────
async function loadMarkers(page = state.markers.page, q = state.markers.q, server = state.markers.server) {
  state.markers = { page, q, server };
  const d = await api(`/api/admin/markers?q=${encodeURIComponent(q)}&server=${encodeURIComponent(server)}&page=${page}`);
  $('#admin-main').innerHTML = `
    <div class="toolbar">
      <input id="marker-q" placeholder="搜昵称 / 地点备注" value="${esc(q)}">
      <select id="marker-server">
        <option value="">全部渠道服</option>
        ${state.servers.map((s) => `<option value="${esc(s.key)}"${s.key === server ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
      <button class="admin-btn ghost small" id="marker-search">筛选</button>
      <span class="admin-hint">共 ${d.total} 个标记</span>
    </div>
    <div class="table-wrap">
      <table class="admin-table">
        <thead><tr><th>昵称</th><th>类型</th><th>渠道服</th><th>坐标</th><th>备注</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          ${d.rows.map((m) => `<tr>
            <td>${esc(m.nickname)}</td>
            <td>${m.kind === 'rabbit' ? '金兔子' : '伞'}</td>
            <td>${esc(m.server_name || m.server_key)}</td>
            <td>${m.lat.toFixed(3)}, ${m.lng.toFixed(3)}</td>
            <td>${esc(m.label || '—')}</td>
            <td>${fmtDate(m.created_at)}</td>
            <td><button class="admin-btn small danger" data-delmarker="${esc(m.id)}">删除</button></td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty-row">没有匹配的标记</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="pager">
      <button class="admin-btn ghost small" id="prev-page" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${d.page} 页 / 共 ${Math.max(1, Math.ceil(d.total / d.size))} 页</span>
      <button class="admin-btn ghost small" id="next-page" ${page * d.size >= d.total ? 'disabled' : ''}>下一页</button>
    </div>`;

  $('#marker-search').onclick = () => loadMarkers(1, $('#marker-q').value.trim(), $('#marker-server').value);
  $('#prev-page').onclick = () => loadMarkers(page - 1, q, server);
  $('#next-page').onclick = () => loadMarkers(page + 1, q, server);

  document.querySelectorAll('[data-delmarker]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这个标记？不可恢复。')) return;
      try {
        await api(`/api/admin/markers/${encodeURIComponent(b.dataset.delmarker)}`, { method: 'DELETE' });
        toast('已删除');
        loadMarkers(page, q, server);
      } catch (err) { toast(err.message, 'warn'); }
    };
  });
}

// ── 举报 ───────────────────────────────────────────────────
const statusTag = (s) => (s === 'open'
  ? '<span class="tag warn">待处理</span>'
  : s === 'done'
    ? '<span class="tag role">已处理</span>'
    : '<span class="tag">已忽略</span>');

async function loadReports() {
  const { reports } = await api('/api/admin/reports');
  $('#admin-main').innerHTML = `
    <h2 class="admin-h2">举报（${reports.length}）</h2>
    <p class="admin-hint" style="margin:-4px 0 12px">点「处理 TA」可以直接看到被举报人的主页，封禁、删点位都在里面。</p>
    <div class="table-wrap">
      <table class="admin-table">
        <thead><tr><th>时间</th><th>被举报人</th><th>点位</th><th>原因</th><th>举报人</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${reports.map((r) => {
            const who = r.target_nickname
              ? `<button class="admin-btn small ghost" data-user="${esc(r.target_user_id)}">${esc(r.target_nickname)}${r.target_banned ? '（已封禁）' : ''}</button>`
              : '<span class="muted">已被删除</span>';
            const pos = Number.isFinite(r.target_lat)
              ? `${r.target_lat.toFixed(3)}, ${r.target_lng.toFixed(3)}`
              : '';
            const spot = r.target_type === 'marker'
              ? `${r.target_marker_kind === 'rabbit' ? '金兔子' : '伞'}${r.target_marker_label ? ' · ' + esc(r.target_marker_label) : ''}${pos ? `<br><span class="muted">${pos}</span>` : ''}`
              : `${esc(r.target_type)} / ${esc(String(r.target_id).slice(0, 10))}`;
            return `<tr>
              <td>${fmtDate(r.created_at)}</td>
              <td>${who}${r.target_server_name ? `<br><span class="muted">${esc(r.target_server_name)}</span>` : ''}</td>
              <td class="wrap">${spot}</td>
              <td class="wrap">${esc(r.reason || '—')}</td>
              <td>${esc(r.reporter || '游客')}</td>
              <td>${statusTag(r.status)}</td>
              <td>
                ${r.target_user_id ? `<button class="admin-btn small" data-user="${esc(r.target_user_id)}">处理 TA</button>` : ''}
                <button class="admin-btn small ghost" data-rep="${r.id}" data-v="done">已处理</button>
                <button class="admin-btn small ghost" data-rep="${r.id}" data-v="ignored">忽略</button>
              </td>
            </tr>`;
          }).join('') || '<tr><td colspan="7" class="empty-row">还没有举报</td></tr>'}
        </tbody>
      </table>
    </div>`;

  document.querySelectorAll('[data-user]').forEach((b) => {
    b.onclick = () => openUserPanel(b.dataset.user);
  });
  document.querySelectorAll('[data-rep]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/admin/reports/${b.dataset.rep}`, { method: 'PATCH', body: { status: b.dataset.v } });
        toast('已更新');
        loadReports();
      } catch (err) { toast(err.message, 'warn'); }
    };
  });
}

// 单个用户的主页：从举报直接跳进来做处理
let userModal = null;

function closeUserPanel() {
  if (userModal) { userModal.remove(); userModal = null; }
}

async function openUserPanel(userId) {
  let d;
  try {
    d = await api(`/api/admin/users/${encodeURIComponent(userId)}`);
  } catch (err) {
    toast(err.message, 'warn');
    return;
  }
  const u = d.user;
  const markers = d.markers.map((m) => `<tr>
      <td>${m.kind === 'rabbit' ? '金兔子' : '伞'}</td>
      <td>${m.lat.toFixed(3)}, ${m.lng.toFixed(3)}</td>
      <td>${esc(m.label || '—')}</td>
      <td>${fmtDate(m.created_at)}</td>
      <td><button class="admin-btn small danger" data-delmarker="${esc(m.id)}">删除</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty-row">没有标记</td></tr>';

  closeUserPanel();
  userModal = document.createElement('div');
  userModal.className = 'admin-modal';
  userModal.innerHTML = `
    <div class="admin-modal-card">
      <header class="admin-modal-head">
        <strong>${esc(u.nickname)}</strong>
        <span class="tag role">${esc(roleLabel(u.role))}</span>
        ${u.banned ? '<span class="tag banned">已封禁</span>' : ''}
        <button class="admin-btn small ghost" data-close style="margin-left:auto">关闭</button>
      </header>

      <dl class="admin-kv">
        <dt>渠道服</dt><dd>${esc(u.server_name || u.server_key)}</dd>
        <dt>所在地</dt><dd>${esc(u.city_name || '—')}</dd>
        <dt>邮箱</dt><dd>${esc(u.email || '—')}</dd>
        <dt>游戏 UID</dt><dd>${esc(u.uid_game || '—')}${u.uid_public ? '（对同服公开）' : ''}</dd>
        <dt>注册时间</dt><dd>${fmtDate(u.created_at)}</dd>
        <dt>最近活跃</dt><dd>${fmtDate(u.last_seen)}</dd>
        <dt>被举报</dt><dd>${d.reportCount} 次</dd>
      </dl>

      <div class="admin-actions">
        <button class="admin-btn ${u.banned ? 'ghost' : 'danger'}" data-ban="${u.banned ? 0 : 1}">
          ${u.banned ? '解封这个账号' : '封禁这个账号'}
        </button>
        <button class="admin-btn ghost" data-role="${u.role === 'admin' ? 'user' : 'admin'}">
          ${u.role === 'admin' ? '取消管理员' : '设为管理员'}
        </button>
      </div>

      <h3 class="admin-h2">TA 的标记（${d.markers.length}）</h3>
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr><th>类型</th><th>坐标</th><th>备注</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>${markers}</tbody>
        </table>
      </div>
    </div>`;

  document.body.appendChild(userModal);
  userModal.addEventListener('click', (e) => { if (e.target === userModal) closeUserPanel(); });
  userModal.querySelector('[data-close]').onclick = closeUserPanel;

  userModal.querySelector('[data-ban]').onclick = async (e) => {
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { banned: e.target.dataset.ban === '1' } });
      toast('状态已更新', 'ok');
      openUserPanel(u.id);
      if (state.tab === 'reports') loadReports();
      if (state.tab === 'users') loadUsers();
    } catch (err) { toast(err.message, 'warn'); }
  };
  userModal.querySelector('[data-role]').onclick = async (e) => {
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { role: e.target.dataset.role } });
      toast('角色已更新', 'ok');
      openUserPanel(u.id);
    } catch (err) { toast(err.message, 'warn'); }
  };
  userModal.querySelectorAll('[data-delmarker]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这个标记？')) return;
      try {
        await api(`/api/admin/markers/${encodeURIComponent(b.dataset.delmarker)}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        openUserPanel(u.id);
        if (state.tab === 'reports') loadReports();
      } catch (err) { toast(err.message, 'warn'); }
    };
  });
}
boot();

import { PaperMap } from './map.js';
import { createWeatherFx } from './fx.js';

const $ = (sel) => document.querySelector(sel);
const isNarrow = () => window.innerWidth <= 720;
// 兼容旧内核（华为浏览器等 Chromium<80）：不使用 ?. 与 ??
const nz = (v, d) => (v === null || v === undefined ? d : v);
const legalDocs = (site) => (site && site.legal && site.legal.docs) || [];
const esc = (s) => String(nz(s, '')).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  site: null,
  servers: [],
  cities: [],
  me: null,
  consent: null,
  stats: null,
  markers: [],
  seq: 0,
  weather: null,
  weatherMock: '',
  cityCode: '110000',
  serverFilter: 'all',
  map: null,
  fx: null,
  selectedId: null
};

// ── API ─────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
  } catch {
    // 网络层失败（断网、域名被拦、服务没起来）——给一句人话，别直接抛 Failed to fetch
    throw new Error('连不上服务器，请检查网络后重试');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 可能是 HTML */ }
  if (!res.ok || (data && data.ok === false)) {
    const err = (data && data.error) || {};
    const e = new Error(err.message || `请求失败（${res.status}）`);
    e.code = err.code;
    e.status = res.status;
    e.detail = err;
    throw e;
  }
  return data;
}

/** 刚刚 / 5 分钟前 / 3 小时前 / 2 天前 */
function fmtAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

// ── Toast ───────────────────────────────────────────────────
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

// ── 弹层 ───────────────────────────────────────────────────
let cardCleanup = null;
function openCard({ title, body, foot = '', onMount, wide = false }) {
  $('#card-title').textContent = title;
  const card = $('#card');
  card.style.width = wide ? 'min(560px, 100%)' : '';
  $('#card-body').innerHTML = '';
  if (typeof body === 'string') $('#card-body').innerHTML = body;
  else if (body) $('#card-body').appendChild(body);
  $('#card-foot').innerHTML = foot;
  $('#overlay').hidden = false;
  if (typeof onMount === 'function') cardCleanup = onMount($('#card-body'), $('#card-foot')) || null;
}
function closeCard() {
  $('#overlay').hidden = true;
  if (typeof cardCleanup === 'function') { try { cardCleanup(); } catch { /* noop */ } }
  cardCleanup = null;
}
$('#card-close').addEventListener('click', closeCard);
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeCard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });

// ── 启动 ───────────────────────────────────────────────────
async function boot() {
  let boot;
  try {
    boot = await api('/api/bootstrap');
  } catch (err) {
    $('#counter-text').textContent = '连不上服务器，地图先只显示底图';
    return;
  }
  S.site = boot.site;
  S.servers = boot.servers;
  S.cities = boot.cities;
  S.stats = boot.stats;
  S.me = boot.me;
  S.consent = (boot.me && boot.me.consent) || null;
  S.cityCode = (S.me && S.me.cityCode) || '110000';

  S.settings = loadSettings();
  initMap();
  applySettings();
  refreshNoticeDot();
  renderCounter();
  renderAuthState();
  await loadFeed();
  updateWeatherChip();
  loadWeather(S.cityCode);

  connectStream();

  if (!S.me) {
    setTimeout(() => toast('拖动地图看看 · 登录后就能把伞放在这里'), 900);
  }
}

function initMap() {
  const tk = (S.site && S.site.tdtTk) || '';
  const map = new PaperMap($('#map'), {
    cities: S.cities,
    center: { lat: 34.2, lng: 108.9 },
    zoom: isNarrow() ? 3.5 : 4.6,
    tileUrl: tk ? (z, x, y, layer) => {
      const host = `t${(x + y) % 8}`;
      return `https://${host}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0`
        + `&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles`
        + `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${encodeURIComponent(tk)}`;
    } : null,
    onClick: onMapClick,
    onMarkerClick: (m) => openMarkerCard(m),
    onViewChange: handleViewChange
  });
  S.map = map;
  S.fx = createWeatherFx($('#fx'));
  $('#basemap-text').textContent = tk ? '天地图' : '纸面';
  $('#foot-map').textContent = tk
    ? '底图数据 © 天地图（国家地理信息公共服务平台）'
    : '地图：纸面底图（未配置天地图 Key，不展示任何行政边界）';
  // 只有真正用天地图时才需要展示审图号
  const attrib = $('#foot-attrib');
  if (attrib) attrib.hidden = !tk;
  if (tk) $('#btn-basemap').title = '天地图底图已启用';
}

// ── 比例尺 / 视图变化 ──────────────────────────────────────
let lastCenter = null;

function handleViewChange(view) {
  // 地图中心被拖动 → 立刻收起雷达，免得挡着看
  if (lastCenter) {
    const moved = Math.abs(view.center.lat - lastCenter.lat) > 1e-7
      || Math.abs(view.center.lng - lastCenter.lng) > 1e-7;
    if (moved && !$('#panel').hidden) showPanel(false);
  }
  lastCenter = { lat: view.center.lat, lng: view.center.lng };
}
// ── 计数与登录态 ────────────────────────────────────────────
function renderCounter() {
  const st = S.stats;
  if (!st) return;
  const total = st.total || 0;
  const players = st.players || 0;
  $('#counter-text').textContent = total === 0
    ? (isNarrow() ? '还没人撑伞' : '还没有人撑伞 · 你来当第一个')
    : (isNarrow()
      ? `${total} 处 · ${players} 位`
      : `全球 ${total} 处标记 · ${players} 位司辰${S.me ? '' : ' · 登录后能看到 TA 们'}`);
}

function renderAuthState() {
  const logged = !!S.me;
  $('#btn-login').textContent = logged ? '我的' : '登录';
  $('#btn-login').dataset.logged = logged ? '1' : '0';
  $('#btn-place').textContent = logged
    ? ((S.consent && S.consent.state && S.consent.state.location) ? '在地图上撑伞' : '开启位置展示')
    : '撑起你的伞';
}

// ── 地图数据 ────────────────────────────────────────────────
async function loadFeed() {
  try {
    const data = await api(`/api/map/feed?since=${S.seq}`);
    if (data.markers.length) {
      const map = new Map(S.markers.map((m) => [m.id, m]));
      for (const m of data.markers) map.set(m.id, m);
      S.markers = [...map.values()];
      S.seq = data.seq || S.seq;
      S.map.setMarkers(S.markers);
    }
    S.stats = await api('/api/stats').then((d) => d.stats);
    renderCounter();
  } catch { /* 静默 */ }
}

// 删除 / 撤权 / 换账号后需要整表重拉（since 增量拿不到「消失」）
async function reloadAll() {
  S.seq = 0;
  S.markers = [];
  S.map.setMarkers([]);
  await loadFeed();
}

function connectStream() {
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'feed') loadFeed();
      } catch { /* noop */ }
    };
    es.onerror = () => { /* 浏览器会自动重连 */ };
  } catch { /* 不支持就算了 */ }
}

// ── 天气 ───────────────────────────────────────────────────
function updateWeatherChip() {
  const w = S.weather;
  const narrow = isNarrow();
  const label = (w && (w.regionLabel || w.cityName)) || '';

  if (!w || !w.ok) {
    $('#weather-text').textContent = narrow ? '天气不可用' : `${label || '天气'} · 不可用`;
    $('#weather-dot').style.background = 'var(--fog)';
    document.body.dataset.weather = 'clear';
    delete document.body.dataset.night;
    if (S.fx) S.fx.set('off');
    return;
  }

  // 手机上只留「晴 2°」，把城市名省出来给计数器
  $('#weather-text').textContent = (narrow || !label)
    ? `${w.text} ${w.temp}°`
    : `${label} · ${w.text} ${w.temp}°`;

  const colors = { clear: '#D8B77A', cloudy: '#C9C2AE', fog: '#C9C2AE', drizzle: '#8FA9C4', rain: '#7FA8C9', storm: '#8C3B2B', snow: '#DCE6EA' };
  $('#weather-dot').style.background = colors[w.kind] || 'var(--brass)';
  document.body.dataset.weather = w.kind || 'clear';
  document.body.dataset.night = w.isDay ? '0' : '1';
  if (S.fx) S.fx.set(w.kind || 'off');
}
async function loadWeather(cityCode, mock = '') {
  try {
    const q = new URLSearchParams({ cityCode });
    if (mock) q.set('mock', mock);
    S.weather = await api(`/api/weather?${q}`);
  } catch (err) {
    S.weather = { ok: false, error: err.message };
  }
  updateWeatherChip();
  maybeStormEgg();
}

// 暴雨彩蛋：城市真在下暴雨时，出司辰语气的一句话
let stormEggShown = false;
function maybeStormEgg() {
  if (stormEggShown) return;
  if (S.weather && S.weather.ok && S.weather.kind === 'storm') {
    stormEggShown = true;
    setTimeout(() => {
      openCard({
        title: '暴雨预警',
        body: `<p class="profile-bio">这场雨，是从哪一年下过来的？</p>
          <p class="tip">你所在的城市正在下暴雨。地图上的金兔子会短暂消失——它们比我们更怕雨。</p>`,
        foot: `<button class="btn btn-primary" data-close>我知道了</button>`,
        onMount: (body, foot) => {
          foot.querySelector('[data-close]').onclick = closeCard;
        }
      });
    }, 900);
  }
}

// ── 附近 / 雷达 ─────────────────────────────────────────────
async function loadNear() {
  const v = S.map.getView();
  try {
    const data = await api(`/api/map/around?lat=${v.center.lat}&lng=${v.center.lng}&server=${S.serverFilter}`);
    renderNear(data.near);
  } catch (err) {
    $('#near-list').innerHTML = `<li class="near-item"><span class="near-sub">${esc(err.message)}</span></li>`;
  }
}

function renderNear(list) {
  const ul = $('#near-list');
  if (!list.length) {
    ul.innerHTML = `<li class="near-item"><span class="near-sub">这片地图暂时没人，把地图拖到城市附近再看看。</span></li>`;
    return;
  }
  ul.innerHTML = list.map((m) => {
    const same = m.sameServer;
    const dist = m.distance < 1000 ? `${m.distance} m` : `${(m.distance / 1000).toFixed(1)} km`;
    return `<li class="near-item" data-id="${esc(m.id)}">
      <span class="near-avatar ${same ? 'same' : ''}">${esc((m.nickname || '?').slice(0, 1))}</span>
      <span class="near-main">
        <span class="near-name">${esc(m.nickname)}
          <span class="badge-server ${same ? '' : 'other'}" style="${same ? `color:${esc(m.serverColor)}` : ''}">${esc(m.serverShort)}</span>
        </span>
        <span class="near-sub">${m.kind === 'rabbit' ? '金兔子' : '伞'}${m.favChar ? ' · ' + esc(m.favChar) : ''}${m.label ? ' · ' + esc(m.label) : ''}</span>
      </span>
      <span class="near-dist">${dist}</span>
    </li>`;
  }).join('');
  ul.querySelectorAll('.near-item[data-id]').forEach((li) => {
    li.onclick = () => {
      const m = S.markers.find((x) => x.id === li.dataset.id) || list.find((x) => x.id === li.dataset.id);
      if (!m) return;
      S.map.flyTo(m.lat, m.lng, Math.max(S.map.zoom, 7));
      S.map.setSelected(m.id);
      openMarkerCard(m);
    };
  });
}

function showPanel(open, title) {
  const panel = $('#panel');
  panel.hidden = !open;
  document.body.classList.toggle('panel-open', open);
  if (open && title) $('#panel-title').textContent = title;
  if (open) loadNear();
}

function openPanel(title) { showPanel(true, title); }
$('#panel-close').onclick = () => showPanel(false);
document.querySelectorAll('.seg').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.seg').forEach((x) => x.classList.toggle('on', x === b));
    S.serverFilter = b.dataset.server;
    loadNear();
  };
});

// ── 落点 ───────────────────────────────────────────────────
function onMapClick(lat, lng) {
  if (!S.me) {
    toast('登录后就能把伞放在这里');
    openLogin();
    return;
  }
  if (!(S.consent && S.consent.state && S.consent.state.location)) {
    openLocationConsent(lat, lng);
    return;
  }
  openPlaceCard(lat, lng);
}

function openPlaceCard(lat, lng) {
  const hasMain = S.markers.some((m) => m.isMine && m.kind === 'umbrella');
  openCard({
    title: '在这里落点',
    body: `
      <div class="field-row">
        <button class="btn ${hasMain ? 'btn-ghost' : 'btn-primary'}" data-kind="umbrella" type="button">☂ 撑一把伞</button>
        <button class="btn ${hasMain ? 'btn-primary' : 'btn-ghost'}" data-kind="rabbit" type="button">金兔子</button>
      </div>
      <label class="field" style="margin-top:12px">
        <span>地点备注 <em>可选，最多 20 字</em></span>
        <input type="text" id="place-label" maxlength="20" placeholder="例如：某个商圈、某所大学">
      </label>
      <p class="tip">坐标会被模糊到约 500 米再展示。请不要把标记放在住所、宿舍或工作单位。<br>
      位置：${lat.toFixed(4)}, ${lng.toFixed(4)}</p>`,
    foot: `<button class="btn btn-ghost" data-cancel>算了</button><button class="btn btn-primary" data-ok>落点</button>`,
    onMount: (body, foot) => {
      let kind = hasMain ? 'rabbit' : 'umbrella';
      body.querySelectorAll('[data-kind]').forEach((b) => {
        b.onclick = () => {
          kind = b.dataset.kind;
          body.querySelectorAll('[data-kind]').forEach((x) => {
            x.className = `btn ${x.dataset.kind === kind ? 'btn-primary' : 'btn-ghost'}`;
          });
        };
      });
      foot.querySelector('[data-cancel]').onclick = closeCard;
      foot.querySelector('[data-ok]').onclick = async () => {
        try {
          const label = body.querySelector('#place-label').value.trim();
          await api('/api/map/place', { method: 'POST', body: { lat, lng, kind, label } });
          closeCard();
          toast(kind === 'rabbit' ? '金兔子放好了，等别的司辰发现它' : '伞撑好了', 'ok');
          await loadFeed();
          S.map.flyTo(lat, lng, Math.max(S.map.zoom, 8));
        } catch (err) {
          toast(err.message, 'warn');
          if (err.code === 'RECONSENT_REQUIRED') openLocationConsent(lat, lng);
        }
      };
    }
  });
}

function openLocationConsent(lat, lng) {
  const doc = legalDocs(S.site).find((d) => d.type === 'privacy');
  openCard({
    title: '还需要你单独同意一件事',
    body: `
      <p class="profile-bio">位置属于**敏感个人信息**，按《个人信息保护法》第二十九条需要你单独同意。</p>
      <div class="consent-box">
        <label class="consent">
          <input type="checkbox" id="c-loc">
          <span>我同意在公开地图上展示我选择的位置<em>坐标会模糊到约 500 米；可随时在「箱子 → 隐私」里关闭</em></span>
        </label>
      </div>
      <p class="tip">不开启也能用：看地图、看天气、轻敲别人。只是不能落点。</p>
      <p class="form-fine">当前隐私政策版本 ${esc((doc && doc.hash) || '')}</p>`,
    foot: `<button class="btn btn-ghost" data-cancel>先不</button><button class="btn btn-primary" data-ok disabled>同意并继续</button>`,
    onMount: (body, foot) => {
      const cb = body.querySelector('#c-loc');
      const ok = foot.querySelector('[data-ok]');
      cb.onchange = () => { ok.disabled = !cb.checked; };
      foot.querySelector('[data-cancel]').onclick = closeCard;
      ok.onclick = async () => {
        try {
          const r = await api('/api/consents', { method: 'POST', body: { type: 'location', action: 'agree' } });
          S.consent = r.consent;
          renderAuthState();
          closeCard();
          toast('好了，可以落点了', 'ok');
          openPlaceCard(lat, lng);
        } catch (err) { toast(err.message, 'warn'); }
      };
    }
  });
}

// ── 名片 / 互动 ─────────────────────────────────────────────
function openMarkerCard(m) {
  const same = m.sameServer;
  const mine = m.isMine;
  const uidLine = m.uid && same
    ? `<dt>游戏 UID</dt><dd>${esc(m.uid)} <a href="#" id="copy-uid" class="foot-links">复制</a></dd>`
    : `<dt>游戏 UID</dt><dd>${same ? '对方没有公开' : '不在同一渠道服，看不到'}</dd>`;

  openCard({
    title: mine ? '这是您的标记' : '遇到一位司辰',
    body: `
      <div class="profile-top">
        <div class="profile-avatar">${esc((m.nickname || '?').slice(0, 1))}</div>
        <div>
          <div class="profile-name">${esc(m.nickname)}
            <span class="badge-server" style="color:${esc(m.serverColor)}">${esc(m.serverName)}</span>
          </div>
          <div class="profile-meta">
            <span>${m.kind === 'rabbit' ? '金兔子' : '一把伞'}</span>
            ${m.favChar ? `<span>本命 · ${esc(m.favChar)}</span>` : ''}
            ${m.label ? `<span>${esc(m.label)}</span>` : ''}
          </div>
        </div>
      </div>
      ${m.bio ? `<p class="profile-bio">“${esc(m.bio)}”</p>` : ''}
      <dl class="kv">
        <dt>坐标</dt><dd>${m.lat.toFixed(3)}, ${m.lng.toFixed(3)}<span class="near-sub">（约 500 米精度）</span></dd>
        ${uidLine}
      </dl>
      ${same ? '' : `<p class="tip">您和 TA 在不同的渠道服（TA 在${esc(m.serverName)}）。可以轻敲打招呼，但**游戏里加不了好友**，悬着递伞按钮就是这个原因。</p>`}
      <p class="tip">只显示模糊后的坐标。请不要根据点位去推测他人的住址。</p>`,
    foot: mine
      ? `<button class="btn btn-danger" data-del>收回</button>`
      : `<button class="btn btn-ghost" data-knock>轻敲伞沿</button>
         <button class="btn btn-primary" data-give ${same ? '' : 'disabled title="不同渠道服无法加游戏好友"'}>递伞</button>
         <button class="btn btn-ghost" data-report>举报</button>`,
    onMount: (body, foot) => {
      const copyBtn = body.querySelector('#copy-uid');
      if (copyBtn) copyBtn.onclick = (e) => { e.preventDefault(); navigator.clipboard && navigator.clipboard.writeText(m.uid); toast('复制好了', 'ok'); };
      if (mine) {
        foot.querySelector('[data-del]').onclick = async () => {
          try {
            await api(`/api/map/${m.id}`, { method: 'DELETE' });
            closeCard(); toast('收回了'); reloadAll();
          } catch (err) { toast(err.message, 'warn'); }
        };
      } else {
        foot.querySelector('[data-knock]').onclick = () => doTouch(m, 'knock');
        const give = foot.querySelector('[data-give]');
        if (give && !same) give.onclick = () => toast('您和 TA 不在一个服务器，游戏里加不了好友', 'warn');
        else if (give) give.onclick = () => doTouch(m, 'give');
        foot.querySelector('[data-report]').onclick = () => openReport(m);
      }
    }
  });
}

async function doTouch(m, kind) {
  try {
    const r = await api('/api/touch', { method: 'POST', body: { markerId: m.id, kind } });
    if (r.friend) toast('你们互相递了伞，成了同伞之交', 'ok');
    else if (kind === 'give') toast('伞递过去了，等 TA 也递回来', 'ok');
    else toast('轻轻碰了一下，TA 只知道伞动了一下');
  } catch (err) { toast(err.message, 'warn'); }
}

function openReport(m) {
  openCard({
    title: '举报',
    body: `<p class="profile-bio">举报内容会直接进入人工审核。恶意举报会被反向处理。</p>
      <label class="field"><span>原因</span>
        <select id="report-reason">
          <option>发布了他人隐私 / 开盒</option>
          <option>位置可疑（疑似住址 / 精确到门牌）</option>
          <option>广告或诈骗</option>
          <option>辱骂或引战</option>
          <option>不是司辰，与游戏无关的内容</option>
          <option>重复发布 / 刷屏</option>
          <option>冒充他人 / 冒充官方</option>
          <option>头像或签名不合规</option>
          <option>其他（请在下面说明）</option>
        </select></label>
      <label class="field"><span>补充说明<span class="opt">（选「其他」时必填）</span></span>
        <textarea id="report-detail" maxlength="500" rows="3" placeholder="简单说一下情况，方便我们判断"></textarea></label>
      <p class="form-fine">还可以写清楚：什么时候看到的、对方昵称、具体哪里有问题。</p>`,
    foot: `<button class="btn btn-ghost" data-cancel>算了</button><button class="btn btn-danger" data-ok>提交</button>`,
    onMount: (body, foot) => {
      foot.querySelector('[data-cancel]').onclick = closeCard;
      foot.querySelector('[data-ok]').onclick = async () => {
        const reason = body.querySelector('#report-reason').value;
        const detail = body.querySelector('#report-detail').value.trim();
        if (reason.indexOf('其他') >= 0 && !detail) {
          toast('选「其他」时请简单说明一下情况', 'warn');
          body.querySelector('#report-detail').focus();
          return;
        }
        try {
          await api('/api/report', {
            method: 'POST',
            body: { targetType: 'marker', targetId: m.id, reason, detail }
          });
          closeCard();
          toast('举报收到了，站长会尽快处理', 'ok');
        } catch (err) {
          toast(err.message, 'warn');
        }
      };
    }
  });
}

// ── 三级行政区划 ───────────────────────────────────────────
async function getRegionTree() {
  if (S.regionTree) return S.regionTree;
  const r = await api('/api/regions');
  S.regionTree = r.provinces;
  return S.regionTree;
}

/** 从 code 反查 [省, 市, 区县] */
function regionPath(tree, code) {
  if (!code) return [];
  for (const p of tree) {
    if (p.code === code) return [p];
    for (const c of p.children || []) {
      if (c.code === code) return [p, c];
      for (const d of c.children || []) {
        if (d.code === code) return [p, c, d];
      }
    }
  }
  return [];
}

/**
 * 在 root 里挂载「省 / 市 / 区县」三级联动，结果写进同名 field 下的 input[name=cityCode]
 * 直辖市与特别行政区只有两级：省 → 区
 */
function mountRegionPicker(root, tree, initialCode) {
  if (!root) return;
  const selP = root.querySelector('[data-region="province"]');
  const selC = root.querySelector('[data-region="city"]');
  const selD = root.querySelector('[data-region="county"]');
  const hidden = root.parentElement.querySelector('input[name="cityCode"]')
    || document.querySelector('input[name="cityCode"]');

  // 直辖市 / 特别行政区没有地级市，第二级直接是区
  const MUNI = new Set(['110000', '120000', '310000', '500000', '810000', '820000']);

  const fill = (sel, items, placeholder) => {
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      items.map((n) => `<option value="${n.code}">${esc(n.name)}</option>`).join('');
    sel.disabled = items.length === 0;
    sel.hidden = items.length === 0;
    root.classList.toggle('two', selD.hidden);
  };

  fill(selP, tree, '省 / 直辖市');
  fill(selC, [], '市 / 地区');
  fill(selD, [], '区县');

  const sync = () => {
    const p = tree.find((x) => x.code === selP.value);
    const c = p ? (p.children || []).find((x) => x.code === selC.value) : null;
    const d = c ? (c.children || []).find((x) => x.code === selD.value) : null;
    hidden.value = (d && d.code) || (c && c.code) || (p && p.code) || '';
  };

  selP.onchange = () => {
    const p = tree.find((x) => x.code === selP.value);
    fill(selC, (p && p.children) || [], MUNI.has(selP.value) ? '区 / 县' : '市 / 地区');
    fill(selD, [], '区县');
    selC.value = '';
    selD.value = '';
    sync();
  };
  selC.onchange = () => {
    const p = tree.find((x) => x.code === selP.value);
    const c = p ? (p.children || []).find((x) => x.code === selC.value) : null;
    fill(selD, (c && c.children) || [], '区县（可选）');
    selD.value = '';
    sync();
  };
  selD.onchange = sync;

  // 回填
  const path = regionPath(tree, initialCode);
  if (path.length) {
    selP.value = path[0].code;
    selP.onchange();
    if (path[1]) { selC.value = path[1].code; selC.onchange(); }
    if (path[2]) { selD.value = path[2].code; }
    sync();
  }
}
// ── 登录 ───────────────────────────────────────────────────
async function openLogin() {
  if (S.me) return openCase();
  let tree;
  try { tree = await getRegionTree(); } catch { toast('地区数据没加载出来，稍后再试', 'warn'); return; }

  const tpl = $('#tpl-login');
  const node = tpl.content.cloneNode(true);
  const wrap = document.createElement('div');
  wrap.appendChild(node);

  const serverSel = wrap.querySelector('#sel-server');
  serverSel.innerHTML = `<option value="">选择渠道服</option>` + S.servers.map((s) =>
    `<option value="${esc(s.key)}">${esc(s.name)}${s.region === 'cn_official' ? '（官方大区）' : ''}</option>`
  ).join('');

  openCard({
    title: S.me ? '你已经登录了' : '登录 9友地图',
    body: wrap,
    onMount: (body) => {
      mountRegionPicker(body.querySelector('#login-region'), tree, S.cityCode);
      const form = body.querySelector('#login-form');
      const btnSend = body.querySelector('#btn-send-code');
      const btnSubmit = body.querySelector('#btn-do-login');
      const devHint = body.querySelector('#dev-hint');

      const profile = body.querySelector('#login-profile');
      const checks = ['c_terms', 'c_age'].map((n) => form.elements[n]);
      // 资料区没展开时（老用户），只要有验证码就能提交
      const syncBtn = () => {
        // 只按验证码长度禁用；同意条款交给提交时校验，
        // 否则按钮是灰的、条款又在卡片下方，用户会以为「点了没反应」。
        btnSubmit.disabled = form.elements.code.value.trim().length < 4;
      };
      checks.forEach((c) => (c.onchange = syncBtn));
      form.elements.code.oninput = syncBtn;

      // 一键同意：四个勾选框一起勾上
      const agreeAll = body.querySelector('#btn-agree-all');
      if (agreeAll) {
        agreeAll.onclick = () => {
          ['c_terms', 'c_location', 'c_uid', 'c_age'].forEach((n) => {
            if (form.elements[n]) form.elements[n].checked = true;
          });
          syncBtn();
          toast('已勾选全部条款，可以登录了', 'ok');
        };
      }

      btnSend.onclick = async () => {
        const email = form.elements.email.value.trim();
        if (!email) return toast('先填邮箱');
        btnSend.disabled = true;
        try {
          const r = await api('/api/auth/request-code', { method: 'POST', body: { email } });
          toast('验证码已生成', 'ok');
          if (r.devCode) {
            form.elements.code.value = r.devCode;
            devHint.hidden = false;
            devHint.textContent = `开发模式：验证码 ${r.devCode}（正式环境会发到邮箱）`;
            syncBtn(); // 程序赋值不会触发 input 事件，手动刷一次按钮状态
          }
          let left = 60;
          btnSend.textContent = `${left}s`;
          const timer = setInterval(() => {
            left--;
            btnSend.textContent = `${left}s`;
            if (left <= 0) { clearInterval(timer); btnSend.disabled = false; btnSend.textContent = '获取验证码'; }
          }, 1000);
        } catch (err) {
          btnSend.disabled = false;
          toast(err.message, 'warn');
        }
      };

      form.onsubmit = async (e) => {
        e.preventDefault();
        // 资料区没展开（老用户）时，不要提交同意项——否则未勾选会被当成「撤回同意」记进 consent 日志
        const payload = {
          email: form.elements.email.value.trim(),
          code: form.elements.code.value.trim(),
          consents: profile.hidden ? {} : {
            terms: form.elements.c_terms.checked,
            privacy: form.elements.c_terms.checked,
            age14: form.elements.c_age.checked,
            location: form.elements.c_location.checked,
            uid: form.elements.c_uid.checked
          }
        };
        if (!profile.hidden) {
          payload.serverKey = form.elements.serverKey.value;
          payload.cityCode = form.elements.cityCode.value;
          payload.nickname = form.elements.nickname.value.trim();
        }
        if (!payload.code) return toast('请填写验证码');
        // 只在「首次登录」的表单展开后，才校验资料与同意项
        if (!profile.hidden) {
          const box = form.querySelector('.consent-box');
          const head = form.querySelector('.consent-head');
          const flash = () => {
            if (head) head.scrollIntoView({ block: 'center', behavior: 'smooth' });
            if (box) {
              box.classList.remove('flash');
              void box.offsetWidth;      // 重排以重启动画
              box.classList.add('flash');
            }
          };
          if (!payload.consents.terms || !payload.consents.age14) {
            flash();
            return toast('请勾选下方的同意条款', 'warn');
          }
          if (!payload.cityCode) return toast('请选择所在地区', 'warn');
        }
        try {
          const r = await api('/api/auth/verify', { method: 'POST', body: payload });
          S.me = r.user;
          S.consent = r.consent;
          S.cityCode = r.user.cityCode || S.cityCode;
          closeCard();
          renderAuthState();
          toast(`欢迎回来，${r.user.nickname}`, 'ok');
          loadWeather(S.cityCode);
          await reloadAll();
          if (r.isNew) openGuideWelcome(); // 首次注册：强推教程，可跳过
        } catch (err) {
          // 兼容旧后端：老版本返回 CONSENT_REQUIRED，含义相同——都是「新用户还得补资料」
          if (err.code === 'PROFILE_REQUIRED' || err.code === 'CONSENT_REQUIRED') {
            // 新用户：展开资料区，让 TA 补完再提交一次
            profile.hidden = false;
            body.querySelector('#login-profile-note').textContent =
              '这是您第一次登录，还需要补完下面几项；以后登录只凭邮箱和验证码。';
            profile.scrollIntoView({ block: 'start', behavior: 'smooth' });
            syncBtn();
            toast('首次登录，请补完下面的资料', 'warn');
            return;
          }
          toast(err.message, 'warn');
        }
      };
    }
  });
}

// ── 箱子（我的） ───────────────────────────────────────────
async function openCase() {
  if (!S.me) { openLogin(); return; }
  let data;
  try { data = await api('/api/me'); } catch (err) { toast(err.message, 'warn'); return; }
  S.consent = data.consent;
  const u = data.user;

  let charGroups = [];
  try { charGroups = await getCharacters(); } catch { /* 列表挂了也不影响其它设置 */ }

  const myMarkers = data.markers.length
    ? data.markers.map((m) => `<li class="near-item"><span class="near-avatar same">${m.kind === 'rabbit' ? '兔' : '伞'}</span>
        <span class="near-main"><span class="near-name">${m.kind === 'rabbit' ? '金兔子' : '伞'}</span>
        <span class="near-sub">${m.lat.toFixed(3)}, ${m.lng.toFixed(3)}</span></span>
        <button class="btn btn-small" data-del="${esc(m.id)}">收回</button></li>`).join('')
    : `<li class="near-item"><span class="near-sub">还没有标记，点地图放一个吧。</span></li>`;

  const touchMap = data.touches || [];
  const friendItems = data.friends.length
    ? data.friends.map((f) => `<li class="near-item">
        <span class="near-avatar same">${esc((f.nickname || '?').slice(0, 1))}</span>
        <span class="near-main">
          <span class="near-name">${esc(f.nickname)}<span class="badge-server">${esc(f.server_name || '')}</span></span>
          <span class="near-sub">${f.label ? esc(f.label) : (f.lat ? '地图上有伞' : '暂时没放伞')} · 结交于 ${fmtAgo(f.since)}</span>
        </span>
        <button class="btn btn-small" data-fly-friend="${esc(f.id)}" ${f.lat ? '' : 'disabled'}>去看看</button>
      </li>`).join('')
    : `<li class="near-item"><span class="near-sub">还没有同伞之交。互相递伞才会成为同伞之交。</span></li>`;

  const touchItems = touchMap.length
    ? touchMap.slice(0, 12).map((x, i) => `<li class="near-item">
        <span class="near-avatar ${x.kind === 'give' ? 'same' : ''}">${x.kind === 'give' ? '伞' : '敲'}</span>
        <span class="near-main">
          <span class="near-name">${esc(x.from_nickname)}<span class="badge-server">${esc(x.from_server_name || '')}</span></span>
          <span class="near-sub">${x.kind === 'give' ? '向您递了伞' : '敲了敲您的伞沿'} · ${fmtAgo(x.created_at)}</span>
        </span>
        <button class="btn btn-small" data-touch-go="${i}" ${x.from_lat ? '' : 'disabled'}>去看看</button>
      </li>`).join('')
    : `<li class="near-item"><span class="near-sub">还没有人来敲伞。把伞撑在人多的地方试试。</span></li>`;

  openCard({
    wide: true,
    title: '箱子',
    body: `
      <p style="margin:0 0 8px"><a class="btn btn-small" href="/guide" target="_blank" rel="noopener">使用指南 →</a></p>
      ${['admin', 'site_admin'].includes(u.role)
        ? '<p style="margin:0 0 10px"><a class="btn btn-small" href="/admin" target="_blank" rel="noopener">进入管理台 →</a></p>'
        : ''}
      <div class="profile-top">
        <div class="profile-avatar">${esc((u.nickname || '?').slice(0, 1))}</div>
        <div>
          <div class="profile-name">${esc(u.nickname)}<span class="badge-server">${esc(u.serverName)}</span></div>
          <div class="profile-meta"><span>${esc(u.cityName || '未选城市')}</span><span>同伞之交 ${data.friendCount}</span><span>${u.uidPublic ? 'UID 已公开' : 'UID 未公开'}</span></div>
        </div>
      </div>
      <h3 style="font-size:13px;margin:14px 0 6px">我的标记</h3>
      <ul class="near-list" style="max-height:150px;border:1px solid var(--line);border-radius:2px">${myMarkers}</ul>

      <h3 style="font-size:13px;margin:16px 0 6px">同伞之交（${data.friendCount}）</h3>
      <ul class="near-list" style="max-height:170px;border:1px solid var(--line);border-radius:2px">${friendItems}</ul>

      <h3 style="font-size:13px;margin:16px 0 6px">有人敲过您</h3>
      <ul class="near-list" style="max-height:170px;border:1px solid var(--line);border-radius:2px">${touchItems}</ul>

      <h3 style="font-size:13px;margin:16px 0 6px">资料</h3>
      <label class="field"><span>昵称</span><input id="me-nickname" maxlength="16" value="${esc(u.nickname)}"></label>
      <div class="field" style="margin-top:8px">
        <span>本命角色 <em>可搜索，也可以不填</em></span>
        <div id="me-fav-picker"></div>
      </div>
      <label class="field" style="margin-top:8px">
        <span>个性签名 <em>最多 80 字，可只对自己可见</em></span>
        <input id="me-bio" maxlength="80" value="${esc(u.bio || '')}" placeholder="想遇到什么样的同好">
      </label>
      <label class="consent" style="margin-top:6px">
        <input type="checkbox" id="me-bio-public" ${u.bioPublic ? 'checked' : ''}>
        <span>公开个性签名<em>公开后所有访客都能在您的伞上看到，不限服务器</em></span>
      </label>
      <div class="field-row" style="margin-top:8px">
        <label class="field grow"><span>游戏 UID <em>可选</em></span><input id="me-uid" maxlength="12" value="${esc(u.uid || '')}" placeholder="纯数字"></label>
        <label class="consent" style="align-items:center"><input type="checkbox" id="me-uid-public" ${u.uidPublic ? 'checked' : ''}><span>对同服公开</span></label>
      </div>
      <label class="field" style="margin-top:8px"><span>位置精度</span>
        <select id="me-precision">
          <option value="fuzzy" ${u.precision === 'fuzzy' ? 'selected' : ''}>模糊（约 500 米，推荐）</option>
          <option value="exact" ${u.precision === 'exact' ? 'selected' : ''}>精确（不推荐）</option>
          <option value="city" ${u.precision === 'city' ? 'selected' : ''}>仅城市中心</option>
        </select></label>

      <h3 style="font-size:13px;margin:16px 0 6px">隐私与同意</h3>
      <div class="consent-box">
        <label class="consent"><input type="checkbox" id="p-location" ${data.consent.state.location ? 'checked' : ''}><span>在公开地图展示我的位置</span></label>
        <label class="consent"><input type="checkbox" id="p-uid" ${data.consent.state.uid ? 'checked' : ''}><span>向同服用户展示我的 UID</span></label>
      </div>
      <p class="tip">关掉位置展示后，您的标记会立刻从地图上消失（数据保留，可以再打开）。</p>`,
    foot: `<button class="btn btn-ghost" data-logout>退出登录</button><button class="btn btn-primary" data-save>保存</button>`,
    onMount: (body, foot) => {
      const favPicker = mountCharPicker(body.querySelector('#me-fav-picker'), charGroups, u.favChar);
      body.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          await api(`/api/map/${b.dataset.del}`, { method: 'DELETE' });
          toast('收回了一个标记'); closeCard(); reloadAll();
        };
      });
      body.querySelectorAll('[data-fly-friend]').forEach((b) => {
        b.onclick = () => {
          const f = data.friends.find((x) => x.id === b.dataset.flyFriend);
          if (!f || !f.lat) return toast('TA 现在没有放伞', 'warn');
          S.map.flyTo(f.lat, f.lng, Math.max(S.map.zoom, 8));
          closeCard();
          toast(`来到了 ${f.nickname} 的伞边`);
        };
      });
      body.querySelectorAll('[data-touch-go]').forEach((b) => {
        b.onclick = () => {
          const x = touchMap[Number(b.dataset.touchGo)];
          if (!x || !x.from_lat) return toast('TA 现在没有放伞', 'warn');
          S.map.flyTo(x.from_lat, x.from_lng, Math.max(S.map.zoom, 8));
          closeCard();
          toast(`来到了 ${x.from_nickname} 的伞边，点那把伞可以回敲或递伞`);
        };
      });
      body.querySelector('#p-location').onchange = async (e) => {
        await api('/api/consents', { method: 'POST', body: { type: 'location', action: e.target.checked ? 'agree' : 'withdraw' } });
        toast(e.target.checked ? '已开启位置展示' : '已关闭，标记已下架');
        reloadAll();
      };
      body.querySelector('#p-uid').onchange = async (e) => {
        await api('/api/consents', { method: 'POST', body: { type: 'uid', action: e.target.checked ? 'agree' : 'withdraw' } });
        toast(e.target.checked ? '已开启 UID 展示' : '已关闭 UID 展示');
      };
      foot.querySelector('[data-logout]').onclick = async () => {
        await api('/api/auth/logout', { method: 'POST' });
        S.me = null; S.consent = null;
        closeCard(); renderAuthState(); toast('已退出');
        reloadAll();
      };
      foot.querySelector('[data-save]').onclick = async () => {
        try {
          const r = await api('/api/me', {
            method: 'PATCH',
            body: {
              nickname: body.querySelector('#me-nickname').value,
              favChar: favPicker.get(),
              bio: body.querySelector('#me-bio').value,
              bioPublic: body.querySelector('#me-bio-public').checked,
              uidGame: body.querySelector('#me-uid').value,
              uidPublic: body.querySelector('#me-uid-public').checked,
              precision: body.querySelector('#me-precision').value
            }
          });
          S.me = { ...S.me, ...r.user };
          closeCard(); toast('保存好了', 'ok'); await reloadAll(); renderAuthState();
        } catch (err) { toast(err.message, 'warn'); }
      };
    }
  });
}

// ── 我的 ───────────────────────────────────────────────────
// 旧的「我的」面板已并入 openCase（侧边栏只留一个「我的」），这里保留函数备将来拆分用
async function openMine() {
  if (!S.me) { openLogin(); return; }
  const mine = S.markers.filter((m) => m.isMine);

  let friends = [];
  try { friends = (await api('/api/me')).friends || []; } catch { /* 拿不到就只显示自己的标记 */ }

  const friendBlock = friends.length
    ? `<h3 style="font-size:13px;margin:14px 0 6px">同伞之交（${friends.length}）</h3>
       <ul class="near-list" style="max-height:180px;border:1px solid var(--line);border-radius:2px">
         ${friends.map((f) => `<li class="near-item" data-fly-friend="${esc(f.id)}">
           <span class="near-avatar same">${esc((f.nickname || '?').slice(0, 1))}</span>
           <span class="near-main">
             <span class="near-name">${esc(f.nickname)}<span class="badge-server">${esc(f.server_name || '')}</span></span>
             <span class="near-sub">${f.label ? esc(f.label) : (f.lat ? '地图上有伞' : '暂时没放伞')}</span>
           </span>
           <span class="near-sub">${f.lat ? '去看看 ›' : ''}</span>
         </li>`).join('')}
       </ul>`
    : '';

  openCard({
    title: '我的',
    body: mine.length
      ? `<ul class="near-list" style="max-height:220px">${mine.map((m) => `
          <li class="near-item" data-fly="${esc(m.id)}">
            <span class="near-avatar same">${m.kind === 'rabbit' ? '兔' : '伞'}</span>
            <span class="near-main"><span class="near-name">${m.kind === 'rabbit' ? '金兔子' : '伞'}</span>
            <span class="near-sub">${m.label ? esc(m.label) + ' · ' : ''}${m.lat.toFixed(3)}, ${m.lng.toFixed(3)}</span></span>
          </li>`).join('')}</ul>
         <p class="tip">点一个标记飞过去；在地图上点别处可以放金兔子。</p>${friendBlock}`
      : `<p class="profile-bio">您还没有撑伞。</p><p class="tip">在地图上点一下，放下您的第一把伞。</p>${friendBlock}`,
    foot: `<button class="btn btn-ghost" data-guide>使用指南</button><button class="btn btn-primary" data-close>去地图上看看</button>`,
    onMount: (body, foot) => {
      body.querySelectorAll('[data-fly]').forEach((li) => {
        li.onclick = () => {
          const m = mine.find((x) => x.id === li.dataset.fly);
          if (m) { S.map.flyTo(m.lat, m.lng, Math.max(S.map.zoom, 8)); closeCard(); }
        };
      });
      body.querySelectorAll('[data-fly-friend]').forEach((li) => {
        li.onclick = () => {
          const f = friends.find((x) => x.id === li.dataset.flyFriend);
          if (!f || !f.lat) return toast('TA 现在没有放伞', 'warn');
          S.map.flyTo(f.lat, f.lng, Math.max(S.map.zoom, 8));
          closeCard();
          toast(`来到了 ${f.nickname} 的伞边`);
        };
      });
      foot.querySelector('[data-guide]').onclick = () => window.open('/guide', '_blank', 'noopener');
      foot.querySelector('[data-close]').onclick = () => { closeCard(); showPanel(false); };
    }
  });
}

// ── 新手引导 ───────────────────────────────────────────────
const GUIDE_SEEN_KEY = 'jy_map_guide_seen_v1';

function guideSeen() {
  try { return localStorage.getItem(GUIDE_SEEN_KEY) === '1'; } catch { return false; }
}
function markGuideSeen() {
  try { localStorage.setItem(GUIDE_SEEN_KEY, '1'); } catch { /* 隐私模式下忽略 */ }
}

/** 首次注册后强推；handbook=true 表示用户主动从「箱子」打开 */
function openGuideWelcome({ force = false } = {}) {
  if (!force && guideSeen()) return;
  openCard({
    title: '欢迎来到 9友地图',
    body: `
      <p class="form-hint">三件事，一分钟看懂。</p>
      <ol class="guide-steps">
        <li><b>撑伞</b>：在地图上点一下您在的位置，选「伞」，确认。</li>
        <li><b>找同服</b>：点「雷达」，同服的人排在最前面，带铜金描边。</li>
        <li><b>递伞</b>：互相递伞才会成为「同伞之交」，那时才能看到对方的游戏 UID，去游戏里加好友。</li>
      </ol>
      <p class="tip">为什么不能直接加好友？因为官服和渠道服不互通——所以我们只让您看到真加得上的人。</p>
      <p class="tip">以后想再看：箱子 →「使用指南」。</p>`,
    foot: `<button class="btn btn-ghost" data-skip>跳过教程</button><button class="btn btn-primary" data-full>打开完整指南</button>`,
    onMount: (body, foot) => {
      foot.querySelector('[data-skip]').onclick = () => { markGuideSeen(); closeCard(); };
      foot.querySelector('[data-full]').onclick = () => {
        markGuideSeen();
        closeCard();
        window.open('/guide', '_blank', 'noopener');
      };
    }
  });
}

// ── 条款 ───────────────────────────────────────────────────
function openLegal() {
  const docs = legalDocs(S.site);
  openCard({
    title: '条款与文件',
    body: `<p class="form-hint">版本 ${esc((S.site && S.site.legal && S.site.legal.version) || '')}。每份文件的文本校验码是留痕用的，条款更新后会要求重新同意。</p>
      <ul class="near-list" style="max-height:320px">
        ${docs.map((d) => `<li class="near-item"><span class="near-main">
          <span class="near-name">${esc(d.title)}</span>
          <span class="near-sub">${esc(d.type)} · 校验码 ${esc(d.hash)}</span></span>
          <a class="btn btn-small" href="/legal/${esc(d.slug)}" target="_blank" rel="noopener">查看</a></li>`).join('')}
      </ul>`,
    foot: `<button class="btn btn-ghost" data-close>关上</button>`,
    onMount: (body, foot) => { foot.querySelector('[data-close]').onclick = closeCard; }
  });
}

// ── 天气 / 底图设置 ────────────────────────────────────────
async function openWeatherCard() {
  let tree;
  try { tree = await getRegionTree(); } catch { toast('地区数据没加载出来，稍后再试', 'warn'); return; }

  const current = S.weather && S.weather.ok
    ? `${S.weather.regionLabel || S.weather.cityName} · ${S.weather.text} ${S.weather.temp}°`
    : '暂时取不到天气';

  openCard({
    title: '界面天气',
    body: `
      <p class="form-hint">现在：${esc(current)}</p>
      <div class="field">
        <span>所在地区 <em>省 → 市 → 区县，只用来取天气，不会公开</em></span>
        <div class="region-row" id="weather-region">
          <select data-region="province" aria-label="省级行政区"></select>
          <select data-region="city" aria-label="地级市"></select>
          <select data-region="county" aria-label="区县"></select>
        </div>
        <input type="hidden" name="cityCode">
      </div>
      <div class="field-row" style="margin-top:14px;flex-wrap:wrap">
        <button class="btn btn-small" data-mock="clear">晴</button>
        <button class="btn btn-small" data-mock="rain">雨</button>
        <button class="btn btn-small" data-mock="storm">暴雨</button>
        <button class="btn btn-small" data-mock="snow">雪</button>
        <button class="btn btn-small" data-mock="fog">雾</button>
        <button class="btn btn-small" data-mock="night">夜</button>
      </div>
      <p class="tip">上面的按钮是预览效果。正式环境会按你选的地区实时取天气；你所在地区真在下暴雨时，会触发「暴雨预警」。</p>`,
    foot: `<button class="btn btn-primary" data-ok>按这个地区取天气</button>`,
    onMount: (body, foot) => {
      mountRegionPicker(body.querySelector('#weather-region'), tree, S.cityCode);
      foot.querySelector('[data-ok]').onclick = async () => {
        const code = body.querySelector('input[name="cityCode"]').value;
        if (!code) return toast('先选到市或区县', 'warn');
        S.cityCode = code;
        S.weatherMock = '';
        closeCard();
        if (S.me) await api('/api/me', { method: 'PATCH', body: { cityCode: code } }).catch(() => {});
        loadWeather(code);
      };
      body.querySelectorAll('[data-mock]').forEach((b) => {
        b.onclick = () => {
          S.weatherMock = b.dataset.mock;
          loadWeather(S.cityCode, b.dataset.mock);
          toast(`预览：${b.textContent}`);
        };
      });
    }
  });
}
// ── 本命角色选择 ───────────────────────────────────────────
let charCache = null;

async function getCharacters() {
  if (charCache) return charCache;
  const res = await fetch('/data/characters.json');
  if (!res.ok) throw new Error('角色列表没加载出来');
  const data = await res.json();
  charCache = data.groups || [];
  return charCache;
}

/** 搜索框 + 分组多行下拉（142 位角色，直接一个下拉太难翻） */
function mountCharPicker(root, groups, initial) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const options = groups.map((g) => {
    const items = g.items.map((n) =>
      `<option value="${esc(n)}"${n === initial ? ' selected' : ''}>${esc(n)}</option>`).join('');
    return `<optgroup label="${esc(g.g)}">${items}</optgroup>`;
  }).join('');

  // 旧数据可能是手填的名字，列表里没有就单独留一项，别把人家的选择吞掉
  const all = groups.flatMap((g) => g.items);
  const extra = initial && !all.includes(initial)
    ? `<optgroup label="之前填的"><option value="${esc(initial)}" selected>${esc(initial)}</option></optgroup>`
    : '';

  root.innerHTML = `
    <div class="char-current">
      <span>已选</span>
      <strong class="char-current-name">（未选择）</strong>
      <button type="button" class="link-btn char-clear">清除</button>
    </div>
    <input type="search" class="char-search" placeholder="搜索角色（共 ${total} 位）" autocomplete="off">
    <select class="char-select" size="8" aria-label="角色列表">
      <option value="">（不填）</option>
      ${extra}
      ${options}
    </select>`;

  const search = root.querySelector('.char-search');
  const sel = root.querySelector('.char-select');
  const current = root.querySelector('.char-current-name');

  const syncCurrent = () => {
    const v = sel.value;
    current.textContent = v || '（未选择）';
    current.classList.toggle('empty', !v);
  };
  sel.onchange = syncCurrent;
  root.querySelector('.char-clear').onclick = () => {
    sel.value = '';
    search.value = '';
    search.oninput();
    syncCurrent();
  };

  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    root.querySelectorAll('optgroup').forEach((og) => {
      let visible = 0;
      og.querySelectorAll('option').forEach((o) => {
        const hit = !q || o.value.toLowerCase().includes(q);
        o.hidden = !hit;
        o.style.display = hit ? '' : 'none';
        if (hit) visible++;
      });
      og.hidden = visible === 0;
      og.style.display = visible === 0 ? 'none' : '';
    });
  };
  syncCurrent();
  return {
    get: () => sel.value,
    set: (v) => { sel.value = v || ''; syncCurrent(); }
  };
}
// ── 设置 ───────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  font: 'm', labels: true, rabbits: true,
  sameOnly: false, grain: true, reduceMotion: false
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('you.settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { localStorage.setItem('you.settings', JSON.stringify(S.settings)); } catch { /* 忽略 */ }
}
function applySettings() {
  const s = S.settings;
  document.documentElement.dataset.font = s.font;
  document.body.classList.toggle('no-grain', !s.grain);
  document.body.dataset.reduceMotion = s.reduceMotion ? '1' : '0';
  if (S.map) {
    S.map.setOptions({
      labels: s.labels, rabbits: s.rabbits, sameOnly: s.sameOnly
    });
  }
}

function openSettings() {
  const s = S.settings;
  openCard({
    title: '设置',
    body: `
      <h3 class="set-h">字体大小</h3>
      <div class="set-seg" id="set-font">
        <button data-v="s" type="button">小</button>
        <button data-v="m" type="button">标准</button>
        <button data-v="l" type="button">大</button>
        <button data-v="xl" type="button">特大</button>
      </div>

      <h3 class="set-h">图层</h3>
      <div class="set-list">
        <label class="set-row"><input type="checkbox" data-k="labels"><span>城市名</span></label>
        <label class="set-row"><input type="checkbox" data-k="rabbits"><span>金兔子</span></label>
        <label class="set-row"><input type="checkbox" data-k="sameOnly"><span>只看同服（异服标记会隐藏）</span></label>
        <label class="set-row"><input type="checkbox" data-k="grain"><span>纸面纹理</span></label>
      </div>

      <h3 class="set-h">动效</h3>
      <div class="set-list">
        <label class="set-row"><input type="checkbox" data-k="reduceMotion"><span>减少动态效果（关闭天气粒子与动画）</span></label>
      </div>
      <p class="tip">这些设置只保存在这台设备上，不影响别人看到的地图。</p>`,
    foot: `<button class="btn btn-ghost" data-reset>恢复默认</button><button class="btn btn-primary" data-close>好了</button>`,
    onMount: (body, foot) => {
      const seg = body.querySelector('#set-font');
      const syncSeg = () => {
        seg.querySelectorAll('[data-v]').forEach((b) => {
          b.classList.toggle('on', b.dataset.v === S.settings.font);
        });
      };
      seg.querySelectorAll('[data-v]').forEach((b) => {
        b.onclick = () => {
          S.settings.font = b.dataset.v;
          syncSeg();
          applySettings();
          saveSettings();
        };
      });
      body.querySelectorAll('input[data-k]').forEach((cb) => {
        cb.checked = !!S.settings[cb.dataset.k];
        cb.onchange = () => {
          S.settings[cb.dataset.k] = cb.checked;
          applySettings();
          saveSettings();
        };
      });
      syncSeg();
      foot.querySelector('[data-reset]').onclick = () => {
        S.settings = { ...DEFAULT_SETTINGS };
        applySettings();
        saveSettings();
        closeCard();
        toast('已恢复默认设置', 'ok');
      };
      foot.querySelector('[data-close]').onclick = closeCard;
    }
  });
}

// ── 公告 ───────────────────────────────────────────────────
const NOTICE_SEEN_KEY = 'you.noticesSeen';

function latestNoticeTime(list) {
  return list.reduce((max, n) => Math.max(max, Date.parse(n.created_at) || 0), 0);
}

async function refreshNoticeDot() {
  try {
    const { notices } = await api('/api/notices');
    const seen = Number(localStorage.getItem(NOTICE_SEEN_KEY) || 0);
    const dot = $('#notice-dot');
    if (dot) dot.hidden = !(latestNoticeTime(notices) > seen);
  } catch { /* 静默 */ }
}

/** 公告正文：先转义，再把 [[img:ID]] 换成图片 */
function renderNoticeBody(raw) {
  return esc(raw)
    .replace(/\n/g, '<br>')
    .replace(/\[\[img:([a-f0-9]{6,32})\]\]/g, function (_, id) {
      return '<img class="notice-img" src="/api/media/' + id + '" loading="lazy" alt="">';
    });
}

async function openNotices() {
  let notices = [];
  try {
    notices = (await api('/api/notices')).notices;
  } catch (err) {
    toast(err.message, 'warn');
    return;
  }
  const fmt = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const body = notices.length
    ? `<div class="notice-list">${notices.map((n) => `
        <article class="notice ${esc(n.level || 'info')}">
          <div class="notice-head">
            <strong>${esc(n.title)}</strong>
            ${n.pinned ? '<em class="pin">置顶</em>' : ''}
            <time>${fmt(n.created_at)}</time>
          </div>
          <p>${renderNoticeBody(n.body)}</p>
        </article>`).join('')}</div>`
    : `<p class="profile-bio">还没有公告。</p>`;

  openCard({
    title: '公告',
    body,
    foot: `<button class="btn btn-ghost" data-close>关上</button>`,
    onMount: (bodyEl, foot) => {
      foot.querySelector('[data-close]').onclick = closeCard;
    }
  });

  try { localStorage.setItem(NOTICE_SEEN_KEY, String(latestNoticeTime(notices))); } catch { /* 忽略 */ }
    const dot = $('#notice-dot');
  if (dot) dot.hidden = true;
}
// ── 绑定 ───────────────────────────────────────────────────
$('#btn-login').onclick = () => { S.me ? openCase() : openLogin(); };
$('#btn-place').onclick = () => {
  if (!S.me) return openLogin();
  if (!(S.consent && S.consent.state && S.consent.state.location)) {
    const v = S.map.getView();
    return openLocationConsent(v.center.lat, v.center.lng);
  }
  toast('在地图上点一下，就能把伞撑在那里');
  S.map.onClick = onMapClick;
};
$('#btn-weather').onclick = openWeatherCard;
document.querySelectorAll('[data-act="settings"]').forEach((b) => {
  b.onclick = openSettings;
});
document.querySelectorAll('[data-zoom]').forEach((b) => {
  b.onclick = () => {
    const act = b.dataset.zoom;
    if (act === 'in') S.map.zoomBy(0.7);
    else if (act === 'out') S.map.zoomBy(-0.7);
  };
});
$('#btn-basemap').onclick = () => {
  toast((S.site && S.site.tdtTk) ? '当前是天地图底图。未配置 Key 时会用纸面底图。' : '未配置天地图 Key，当前是纸面底图（不展示行政边界）');
};

// 面板入口统一兜底：异步函数抛错时给出提示，而不是静默没反应
function runAction(fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.error(err);
      toast(`打开失败：${err && err.message ? err.message : '未知错误'}`, 'warn');
    });
}

document.querySelectorAll('.rail-item').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.rail-item').forEach((x) => x.classList.toggle('on', x === b));
    const act = b.dataset.act;
    if (act === 'map') { showPanel(false); closeCard(); if (S.map) S.map.resetView(); }
    if (act === 'radar') runAction(() => openPanel('暴雨雷达'));
    if (act === 'notices') runAction(openNotices);
    if (act === 'case') runAction(openCase);
    if (act === 'legal') runAction(openLegal);
  };
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(`出错了：${e.reason && e.reason.message ? e.reason.message : '未知错误'}`, 'warn');
});

boot();

// 9友地图 · HTTP 服务（零依赖：node:http + node:sqlite）
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  PORT, HOST, PUBLIC_DIR, LEGAL_DIR, SITE_NAME, TDT_TK,
  SERVERS, SERVER_MAP, LEGAL_DOCS, DOC_VERSION, DOC_HASHES,
  REQUIRED_CONSENTS, LIMITS, DEV_NO_MAIL
} from './config.js';
import * as store from './db.js';
import { isInChina } from './geo.js';
import { PROVINCES, CITY_POINTS, REGION_STATS, getRegion, regionLabel } from './regions.js';
import { issueSession, clearCookie, readSession, hashCode, newCode, sendCodeMail, mailConfigured, CODE_TTL, CODE_COOLDOWN, MAX_TRIES } from './auth.js';
import { getWeather } from './weather.js';
import { renderMarkdown } from './md.js';

store.seedIfEmpty();
store.seedNotices();
if (process.env.ADMIN_EMAIL) {
  const promoted = store.promoteUser(process.env.ADMIN_EMAIL, 'site_admin');
  if (promoted) console.log('  [admin] ' + promoted.nickname + ' 已是 site_admin');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8'
};

// ── 工具 ────────────────────────────────────────────────────
const sseClients = new Set();

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  const acceptsGzip = /gzip/.test(res.reqRef?.headers['accept-encoding'] || '');
  const buf = Buffer.from(payload);
  const useGzip = acceptsGzip && buf.length > 2048;
  const out = useGzip ? gzipSync(buf) : buf;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': out.length,
    ...(useGzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
    ...extraHeaders
  });
  res.end(out);
}

function fail(res, status, code, message, extra = {}) {
  json(res, status, { ok: false, error: { code, message, ...extra } });
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

// 极简限流：按 IP + 路由 计数
const buckets = new Map();
function rateLimit(req, key, max, windowMs) {
  const ip = clientIp(req);
  const k = `${ip}|${key}`;
  const now = Date.now();
  const b = buckets.get(k);
  if (!b || now - b.start > windowMs) {
    buckets.set(k, { start: now, n: 1 });
    return true;
  }
  b.n++;
  return b.n <= max;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    nickname: u.nickname,
    avatar: u.avatar,
    bio: u.bio,
    favChar: u.fav_char,
    serverKey: u.server_key,
    serverName: SERVER_MAP.get(u.server_key)?.name || u.server_key,
    cityCode: u.city_code,
    cityName: u.city_name,
    regionLabel: u.city_code ? regionLabel(u.city_code) : '',
    uid: u.uid_public ? (u.uid_game || '') : '',
    uidPublic: !!u.uid_public,
    precision: u.precision,
    role: u.role,
    isSeed: !!u.is_seed
  };
}

function publicMarker(m, viewer) {
  const server = SERVER_MAP.get(m.server_key);
  const sameServer = viewer ? viewer.server_key === m.server_key : false;
  return {
    id: m.id,
    kind: m.kind,
    lat: m.lat,
    lng: m.lng,
    label: m.label,
    nickname: m.nickname,
    favChar: m.fav_char || '',
    serverKey: m.server_key,
    serverName: server?.name || m.server_key,
    serverShort: server?.short || '?',
    serverColor: server?.color || '#B08A4F',
    uid: m.uid_public ? (m.uid_game || '') : '',
    sameServer,
    isMine: viewer ? viewer.id === m.user_id : false,
    createdAt: m.created_at
  };
}

function userConsentView(userId) {
  const state = store.consentState(userId);
  return {
    state,
    needs: REQUIRED_CONSENTS.filter((t) => !state[t]),
    version: DOC_VERSION,
    hashes: Object.fromEntries(DOC_HASHES)
  };
}

// ── 静态文件 ────────────────────────────────────────────────
function serveStatic(req, res, urlPath) {
  const rel = normalize(urlPath).replace(/^([/\\])+/, '');
  const full = join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden', '非法路径');
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const ext = extname(full).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    // 开发期不缓存，改了刷新就能看到；上线再换成长缓存 + 文件名 hash
    'cache-control': ext === '.html' ? 'no-cache' : 'no-cache'
  });
  createReadStream(full).pipe(res);
  return true;
}

// ── 法律页面 ────────────────────────────────────────────────
const legalCache = new Map();
function legalDoc(slug) {
  if (legalCache.has(slug)) return legalCache.get(slug);
  const meta = LEGAL_DOCS.find((d) => d.slug === slug);
  if (!meta) return null;
  const file = join(LEGAL_DIR, meta.file);
  if (!existsSync(file)) return null;
  const md = readFileSync(file, 'utf8');
  const doc = {
    ...meta,
    version: DOC_VERSION,
    hash: createHash('sha256').update(md).digest('hex').slice(0, 16),
    html: renderMarkdown(md)
  };
  legalCache.set(slug, doc);
  return doc;
}

function legalPageHtml(slug) {
  const doc = legalDoc(slug);
  if (!doc) return null;
  const nav = LEGAL_DOCS.map((d) =>
    `<a href="/legal/${d.slug}" class="${d.slug === slug ? 'on' : ''}">${d.title}</a>`
  ).join('');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${doc.title} · ${SITE_NAME}</title>
<link rel="stylesheet" href="/css/style.css">
</head><body class="legal-body">
<header class="legal-top">
  <a class="legal-back" href="/">← 回到地图</a>
  <span class="legal-brand">${SITE_NAME}</span>
</header>
<div class="legal-wrap">
  <nav class="legal-nav">${nav}</nav>
  <article class="legal-doc">
    <div class="legal-meta">
      <span>版本 ${doc.version}</span>
      <span>文本校验码 ${doc.hash}</span>
    </div>
    ${doc.html}
  </article>
</div>
</body></html>`;
}

// ── 路由 ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  res.reqRef = req;
  res.setHeader('x-content-type-options', 'nosniff');
  // 必须用 strict-origin-when-cross-origin：天地图的浏览器端 Key 要求请求带 Referer，
  // 设成 same-origin 会让跨域的瓦片请求不带 Referer，直接被 403 拒绝。
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');

  try {
    // 健康检查
    if (path === '/api/health') return json(res, 200, { ok: true, t: Date.now() });

    // 启动引导数据
    if (path === '/api/bootstrap') {
      const viewer = readSession(req) ? store.getUserById(readSession(req)) : null;
      return json(res, 200, {
        ok: true,
        site: {
          name: SITE_NAME,
          tagline: '非官方同人项目 · 与深蓝互动无关',
          mapProvider: TDT_TK ? 'tianditu' : 'paper',
          tdtTk: TDT_TK || '',
          devNoMail: DEV_NO_MAIL
        },
        servers: SERVERS,
        cities: CITY_POINTS,
        regions: { stats: REGION_STATS },
        legal: {
          version: DOC_VERSION,
          docs: LEGAL_DOCS.map((d) => ({
            slug: d.slug, title: d.title, type: d.type, hash: DOC_HASHES.get(d.slug)
          })),
          required: REQUIRED_CONSENTS
        },
        stats: store.stats(),
        me: viewer ? { ...publicUser(viewer), consent: userConsentView(viewer.id) } : null
      });
    }

    if (path === '/api/stats') return json(res, 200, { ok: true, stats: store.stats() });

    // ── 公告 ────────────────────────────────────────────────
    if (path === '/api/notices' && method === 'GET') {
      return json(res, 200, { ok: true, notices: store.listNotices(30) });
    }

    // ── 管理后台 ────────────────────────────────────────────
    if (path.startsWith('/api/admin/')) {
      const uid = readSession(req);
      const viewer = uid ? store.getUserById(uid) : null;
      if (!viewer) return fail(res, 401, 'unauthorized', '请先登录');

      const isAdmin = viewer.role === 'admin' || viewer.role === 'site_admin';
      if (path === '/api/admin/me') {
        return json(res, 200, {
          ok: true, isAdmin,
          user: { ...publicUser(viewer), role: viewer.role }
        });
      }
      if (!isAdmin) return fail(res, 403, 'forbidden', '需要管理员权限');

      if (path === '/api/admin/overview' && method === 'GET') {
        return json(res, 200, { ok: true, ...store.adminOverview() });
      }

      if (path === '/api/admin/notices' && method === 'GET') {
        return json(res, 200, { ok: true, notices: store.listNotices(100) });
      }
      if (path === '/api/admin/notices' && method === 'POST') {
        const body = await readBody(req);
        const title = String(body.title || '').trim().slice(0, 60);
        const text = String(body.body || '').trim().slice(0, 2000);
        if (!title || !text) return fail(res, 400, 'bad_notice', '标题和正文都要填');
        const notice = store.addNotice({
          title, body: text,
          level: ['info', 'warn', 'important'].includes(body.level) ? body.level : 'info',
          pinned: !!body.pinned,
          expiresAt: body.expiresAt || null
        });
        broadcast({ type: 'feed' });
        return json(res, 200, { ok: true, notice });
      }
      const mNotice = path.match(/^\/api\/admin\/notices\/(\d+)$/);
      if (mNotice && method === 'PATCH') {
        const body = await readBody(req);
        const notice = store.adminUpdateNotice(Number(mNotice[1]), body);
        if (!notice) return fail(res, 400, 'bad_request', '没有可更新的字段');
        return json(res, 200, { ok: true, notice });
      }
      if (mNotice && method === 'DELETE') {
        const done = store.adminDeleteNotice(Number(mNotice[1]));
        return json(res, 200, { ok: true, deleted: done });
      }

      if (path === '/api/admin/users' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        return json(res, 200, { ok: true, ...store.adminListUsers({ q, page, size: 20 }) });
      }
      const mUser = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (mUser && method === 'GET') {
        const detail = store.adminGetUser(mUser[1]);
        if (!detail) return fail(res, 404, 'not_found', '找不到这个用户');
        return json(res, 200, { ok: true, ...detail });
      }
      if (mUser && method === 'PATCH') {
        const body = await readBody(req);
        if (mUser[1] === viewer.id && body.role && body.role !== 'site_admin' && viewer.role === 'site_admin') {
          return fail(res, 400, 'bad_request', '不能给自己降权');
        }
        const u = store.adminSetUser(mUser[1], body);
        if (!u) return fail(res, 400, 'bad_request', '没有可更新的字段');
        return json(res, 200, { ok: true, user: u });
      }

      if (path === '/api/admin/markers' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const server = url.searchParams.get('server') || '';
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        return json(res, 200, { ok: true, ...store.adminListMarkers({ q, server, page, size: 20 }) });
      }
      const mMarker = path.match(/^\/api\/admin\/markers\/([^/]+)$/);
      if (mMarker && method === 'DELETE') {
        const done = store.adminDeleteMarker(decodeURIComponent(mMarker[1]));
        if (!done) return fail(res, 404, 'not_found', '找不到这个标记');
        broadcast({ type: 'feed' });
        return json(res, 200, { ok: true });
      }

      if (path === '/api/admin/reports' && method === 'GET') {
        return json(res, 200, { ok: true, reports: store.adminListReports() });
      }
      const mReport = path.match(/^\/api\/admin\/reports\/(\d+)$/);
      if (mReport && method === 'PATCH') {
        const body = await readBody(req);
        const status = ['open', 'done', 'ignored'].includes(body.status) ? body.status : 'done';
        return json(res, 200, { ok: true, report: store.adminSetReport(Number(mReport[1]), status) });
      }

      return fail(res, 404, 'not_found', '没有这个管理接口');
    }

    // ── 地图 ────────────────────────────────────────────────
    if (path === '/api/map/feed' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const viewer = readSession(req) ? store.getUserById(readSession(req)) : null;
      const rows = store.listMarkers({ since });
      const markers = rows.map((m) => publicMarker(m, viewer));
      const lastSeq = rows.length ? rows[rows.length - 1].seq : since;
      return json(res, 200, { ok: true, markers, seq: lastSeq, total: markers.length });
    }

    if (path === '/api/map/around' && method === 'GET') {
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const mode = url.searchParams.get('server') || 'all';
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(res, 400, 'bad_request', '缺少坐标');
      const viewer = readSession(req) ? store.getUserById(readSession(req)) : null;
      let list = store.listAround(lat, lng, { radiusKm: 50, limit: 60 });
      if (mode === 'mine' && viewer) list = list.filter((m) => m.server_key === viewer.server_key);
      // 同服置顶，再按距离
      list.sort((a, b) => {
        const sa = viewer && a.server_key === viewer.server_key ? 0 : 1;
        const sb = viewer && b.server_key === viewer.server_key ? 0 : 1;
        return sa - sb || a.distance - b.distance;
      });
      const near = list.slice(0, 20).map((m) => ({ ...publicMarker(m, viewer), distance: Math.round(m.distance) }));
      return json(res, 200, { ok: true, near, count: list.length });
    }

    if (path === '/api/map/me' && method === 'GET') {
      const uid = readSession(req);
      if (!uid) return fail(res, 401, 'unauthorized', '请先登录');
      const viewer = store.getUserById(uid);
      const markers = store.listUserMarkers(uid).map((m) => publicMarker(m, viewer));
      return json(res, 200, { ok: true, markers, limits: LIMITS });
    }

    if (path === '/api/map/place' && method === 'POST') {
      const uid = readSession(req);
      if (!uid) return fail(res, 401, 'unauthorized', '请先登录');
      const viewer = store.getUserById(uid);
      if (viewer.banned) return fail(res, 403, 'banned', '账号已被限制');
      if (!store.hasConsent(uid, 'location')) {
        return fail(res, 428, 'RECONSENT_REQUIRED', '需要先同意在公开地图展示位置', { consentType: 'location' });
      }
      if (!rateLimit(req, 'place', 30, 3600e3)) return fail(res, 429, 'rate_limited', '操作太频繁了');

      const body = await readBody(req);
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const kind = body.kind === 'rabbit' ? 'rabbit' : 'umbrella';
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(res, 400, 'bad_request', '坐标不合法');
      if (!isInChina(lat, lng)) return fail(res, 422, 'OUT_OF_CHINA', '司辰只在这片土地上留伞');

      if (kind === 'umbrella' && store.countMain(uid) >= 1) {
        return fail(res, 409, 'MAIN_EXISTS', '你已经有一把伞了。先收回它，或者放一只金兔子');
      }
      if (kind === 'rabbit' && store.countRabbits(uid) >= LIMITS.rabbitsPerUser) {
        return fail(res, 409, 'RABBIT_LIMIT', `最多放 ${LIMITS.rabbitsPerUser} 只金兔子`);
      }
      const m = store.createMarker({ userId: uid, kind, lat, lng, label: body.label || '' });
      broadcast({ type: 'feed' });
      return json(res, 200, { ok: true, marker: publicMarker({ ...m, nickname: viewer.nickname, server_key: viewer.server_key }, viewer) });
    }

    if (path.startsWith('/api/map/') && method === 'DELETE') {
      const uid = readSession(req);
      if (!uid) return fail(res, 401, 'unauthorized', '请先登录');
      const id = path.split('/')[3];
      const okDel = store.removeMarker(id, uid);
      if (!okDel) return fail(res, 404, 'not_found', '找不到这把伞');
      broadcast({ type: 'feed' });
      return json(res, 200, { ok: true });
    }

    // ── 互动 ────────────────────────────────────────────────
    if (path === '/api/touch' && method === 'POST') {
      const uid = readSession(req);
      if (!uid) return fail(res, 401, 'unauthorized', '请先登录');
      const body = await readBody(req);
      const kind = body.kind === 'give' ? 'give' : 'knock';
      const result = store.addTouch(uid, String(body.markerId || ''), kind);
      if (!result.ok) {
        const map = {
          marker_not_found: [404, '找不到对方'],
          self: [400, '不能碰自己'],
          rate_limited: [429, '今天碰得够多了'],
          server_mismatch: [409, '你们不在一个服务器，游戏里加不了好友']
        };
        const [status, msg] = map[result.error] || [400, '操作失败'];
        return fail(res, status, result.error, msg, result.toServer ? { toServer: SERVER_MAP.get(result.toServer)?.name } : {});
      }
      broadcast({ type: 'feed' });
      return json(res, 200, { ok: true, ...result });
    }

    // ── 认证 ────────────────────────────────────────────────
    if (path === '/api/auth/request-code' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, 'bad_email', '邮箱格式不对');
      if (!rateLimit(req, 'code', 20, 3600e3)) return fail(res, 429, 'rate_limited', '申请太频繁，晚点再试');

      const existing = store.getCode(email);
      if (existing && Date.now() - existing.sent_at < CODE_COOLDOWN * 1000) {
        const wait = Math.ceil((CODE_COOLDOWN * 1000 - (Date.now() - existing.sent_at)) / 1000);
        return fail(res, 429, 'cooldown', `请 ${wait} 秒后再试`, { retryAfter: wait });
      }
      const code = newCode();
      store.setCode(email, hashCode(email, code), CODE_TTL);
      let send;
      try {
        send = await sendCodeMail(email, code);
      } catch (err) {
        store.clearCode(email);
        console.error('[mail] 发送失败：', err.message);
        return fail(res, 502, 'mail_failed', '验证码邮件发送失败，请稍后再试');
      }
      return json(res, 200, {
        ok: true,
        delivered: send.delivered,
        // 只在「没配 SMTP」的开发环境下把码带回来；配了真实邮件就绝不返回
        devCode: send.dev && DEV_NO_MAIL ? code : undefined,
        ttl: CODE_TTL
      });
    }

    if (path === '/api/auth/verify' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').trim();
      const row = store.getCode(email);
      if (!row) return fail(res, 400, 'code_missing', '请先获取验证码');
      if (Date.now() > row.expires_at) return fail(res, 400, 'code_expired', '验证码过期了');
      if (row.tries >= MAX_TRIES) return fail(res, 429, 'too_many_tries', '试错次数太多，重新获取吧');
      if (row.hash !== hashCode(email, code)) {
        store.bumpCodeTry(email);
        return fail(res, 400, 'code_wrong', '验证码不对');
      }
      store.clearCode(email);

      const consents = body.consents || {};
      const missing = REQUIRED_CONSENTS.filter((t) => consents[t] !== true);

      let user = store.getUserByEmail(email);
      const isNew = !user;

      if (isNew && missing.length) {
        return fail(res, 428, 'CONSENT_REQUIRED', '请先同意相关条款', { missing });
      }

      if (isNew) {
        const serverKey = String(body.serverKey || '');
        const cityCode = String(body.cityCode || '');
        if (!SERVER_MAP.has(serverKey)) return fail(res, 400, 'bad_server', '请选择渠道服');
        const cityNode = getRegion(cityCode);
      if (!cityNode) return fail(res, 400, 'bad_city', '请选择省 / 市 / 区县');
        const nickname = String(body.nickname || '').trim().slice(0, 16);
        if (nickname.length < 2) return fail(res, 400, 'bad_nickname', '昵称至少 2 个字');
        if (store.getUserByNickname(nickname)) return fail(res, 409, 'nickname_taken', '这个昵称已经有人用了');
        user = store.createUser({ email, nickname, serverKey, cityCode, cityName: cityNode.name });
      }

      // 记录同意
      for (const type of ['terms', 'privacy', 'age14', 'location', 'uid']) {
        if (consents[type] === true) store.recordConsent({ userId: user.id, docType: type, action: 'agree', ip: clientIp(req), ua: req.headers['user-agent'] });
        else if (consents[type] === false) store.recordConsent({ userId: user.id, docType: type, action: 'withdraw', ip: clientIp(req), ua: req.headers['user-agent'] });
      }
      store.touchLastSeen(user.id);

      const session = issueSession(user.id);
      const consent = userConsentView(user.id);
      return json(res, 200, {
        ok: true,
        user: publicUser(user),
        consent,
        needsConsent: consent.needs
      }, { 'set-cookie': session.cookie });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      return json(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
    }

    // ── 我 ──────────────────────────────────────────────────
    if (path === '/api/me' && method === 'GET') {
      const uid = readSession(req);
      if (!uid) return fail(res, 401, 'unauthorized', '请先登录');
      const u = store.getUserById(uid);
      return json(res, 200, {
        ok: true,
        user: { ...publicUser(u), uid: u.uid_game || '' },
        consent: userConsentView(uid),
        markers: store.listUserMarkers(uid),
        friends: store.listFriends(uid),
        friendCount: store.countFriends(uid)
      });
    }

    if (path === '/api/me' && method === 'PATCH') {
      const uid = readSession(req);
      if (!uid) return fail(res, 401, 'unauthorized', '请先登录');
      const body = await readBody(req);
      const patch = {};
      if (body.nickname !== undefined) {
        const n = String(body.nickname).trim().slice(0, 16);
        if (n.length < 2) return fail(res, 400, 'bad_nickname', '昵称至少 2 个字');
        const other = store.getUserByNickname(n);
        if (other && other.id !== uid) return fail(res, 409, 'nickname_taken', '这个昵称已经有人用了');
        patch.nickname = n;
      }
      if (body.bio !== undefined) patch.bio = String(body.bio).slice(0, 80);
      if (body.favChar !== undefined) patch.fav_char = String(body.favChar).slice(0, 20);
      if (body.uidGame !== undefined) patch.uid_game = String(body.uidGame).replace(/[^0-9]/g, '').slice(0, 12);
      if (body.uidPublic !== undefined) patch.uid_public = body.uidPublic ? 1 : 0;
      if (body.precision !== undefined && ['fuzzy', 'exact', 'city'].includes(body.precision)) patch.precision = body.precision;
      if (body.cityCode !== undefined && getRegion(String(body.cityCode))) {
        patch.city_code = String(body.cityCode);
        patch.city_name = getRegion(String(body.cityCode)).name;
      }
      const u = store.updateProfile(uid, patch);
      return json(res, 200, { ok: true, user: publicUser(u) });
    }

    // ── 同意 ────────────────────────────────────────────────
    if (path === '/api/consents' && method === 'POST') {
      const uid = readSession(req);
      if (!uid) return fail(res, 401, 'unauthorized', '请先登录');
      const body = await readBody(req);
      const type = String(body.type || '');
      if (!['terms', 'privacy', 'location', 'uid', 'age14'].includes(type)) {
        return fail(res, 400, 'bad_type', '未知的同意类型');
      }
      const action = body.action === 'withdraw' ? 'withdraw' : 'agree';
      store.recordConsent({ userId: uid, docType: type, action, ip: clientIp(req), ua: req.headers['user-agent'] });
      return json(res, 200, { ok: true, consent: userConsentView(uid) });
    }

    // ── 天气 ────────────────────────────────────────────────
    if (path === '/api/weather' && method === 'GET') {
      const cityCode = url.searchParams.get('cityCode') || '';
      const mock = url.searchParams.get('mock') || '';
      const w = await getWeather(cityCode, { mock: mock || undefined });
      return json(res, w.ok ? 200 : 502, w);
    }

    // ── 举报 ────────────────────────────────────────────────
    if (path === '/api/report' && method === 'POST') {
      const uid = readSession(req) || '';
      const body = await readBody(req);
      if (!rateLimit(req, 'report', 10, 3600e3)) return fail(res, 429, 'rate_limited', '举报太频繁');
      store.addReport({
        targetType: String(body.targetType || 'marker'),
        targetId: String(body.targetId || ''),
        reason: String(body.reason || '').slice(0, 500),
        fromUser: uid
      });
      return json(res, 200, { ok: true });
    }

    // ── SSE ────────────────────────────────────────────────
    if (path === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 5000\n\n');
      sseClients.add(res);
      const timer = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(timer); sseClients.delete(res); });
      return;
    }

    // ── 法律页面 ────────────────────────────────────────────
    if (path.startsWith('/legal/')) {
      const slug = path.slice('/legal/'.length).replace(/\/$/, '');
      const html = legalPageHtml(slug);
      if (!html) return fail(res, 404, 'not_found', '没有这份文件');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (path === '/api/regions') {
      return json(res, 200, {
        ok: true,
        stats: REGION_STATS,
        provinces: PROVINCES
      }, { 'cache-control': 'public, max-age=86400' });
    }
    if (path === '/api/legal') {
      return json(res, 200, {
        ok: true, version: DOC_VERSION,
        docs: LEGAL_DOCS.map((d) => ({ slug: d.slug, title: d.title, type: d.type, hash: DOC_HASHES.get(d.slug) }))
      });
    }

    // ── 管理页面 ────────────────────────────────────────────
    if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
      if (serveStatic(req, res, '/admin.html')) return;
    }

    // ── 静态 ────────────────────────────────────────────────
    if (method === 'GET' && serveStatic(req, res, path === '/' ? '/index.html' : path)) return;

    return fail(res, 404, 'not_found', '页面不存在');
  } catch (err) {
    if (String(err.message) === 'bad_json') return fail(res, 400, 'bad_json', '请求格式不对');
    if (String(err.message) === 'body_too_large') return fail(res, 413, 'too_large', '请求太大');
    console.error('[error]', req.method, path, err);
    return fail(res, 500, 'internal', '服务器出了点问题');
  }
});

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  9友地图 已启动');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log(`  底图：${TDT_TK ? '天地图（已配置 tk）' : '纸面底图（未配置 TDT_TK，不展示行政边界）'}`);
  console.log(`  数据库：${store.DB_PATH}`);
  if (mailConfigured()) {
    console.log('  邮件：SMTP 已配置，验证码会真的发出去');
  } else {
    console.log('  邮件：未配置 SMTP（开发模式，验证码直接返回给前端）');
    if (process.env.NODE_ENV === 'production') {
      console.log('  ⚠ 生产环境请配置 SMTP_HOST / SMTP_USER / SMTP_PASS / MAIL_FROM，否则任何人都能登录任意邮箱');
    }
  }
  console.log('');
});


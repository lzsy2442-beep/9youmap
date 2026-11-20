// 9友地图 · Cloudflare Worker 入口（fetch handler）
// 与 server/index.js 功能对齐；差异：D1 代替 node:sqlite、WebCrypto 代替 node:crypto、
// 邮件走 HTTP API、SSE 降级为「让浏览器自己重连」。
import {
  SITE_NAME, SERVERS, LIMITS, REQUIRED_CONSENTS, LEGAL_DOCS
} from '../server/constants.js';
import { renderMarkdown } from '../server/md.js';
import { PROVINCES, CITY_POINTS, REGION_STATS, getRegion, regionLabel, isInChina } from './regions.js';
import { LEGAL_TEXT, LEGAL_HASHES } from './data-legal.js';
import { SCHEMA_SQL, SEED_SQL } from './data-schema.js';
import { createStore } from './db.js';
import { issueSession, readSession, clearCookie, hashCode, newCode } from './session.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const fail = (status, code, message, extra = {}) => json({ ok: false, error: { code, message, ...extra } }, status);
const clientIp = (req) => req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '0.0.0.0';

// ── 自动初始化：首次请求时建表（省掉手工粘 SQL）──────────────
let schemaReady = false;
let schemaError = null;

/** 把一段 SQL 拆成单条语句（跳过注释，忽略字符串里的分号） */
function splitStatements(sql) {
  const cleaned = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "'") {
      if (inStr && cleaned[i + 1] === "'") { cur += "''"; i++; continue; }
      inStr = !inStr;
      cur += ch;
      continue;
    }
    if (ch === ';' && !inStr) {
      const s = cur.trim();
      if (s) out.push(s);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

async function runStatements(env, sql, label) {
  const stmts = splitStatements(sql);
  let ok = 0;
  const errors = [];
  for (const s of stmts) {
    try {
      await env.DB.prepare(s).run();
      ok++;
    } catch (err) {
      const msg = String(err.message || err);
      // 已存在属于正常（可重复执行）
      if (/already exists|duplicate column/i.test(msg)) { ok++; continue; }
      errors.push(`${msg} | ${s.slice(0, 60)}`);
    }
  }
  if (errors.length) {
    console.error(`[db] ${label} ${errors.length} 条失败：`, errors.slice(0, 3).join(' ;; '));
  } else {
    console.log(`[db] ${label} 完成，${ok} 条`);
  }
  return errors;
}

async function ensureSchema(env) {
  if (schemaReady) return;
  try {
    await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    schemaReady = true;
    schemaError = null;
    return;
  } catch { /* 表不存在，继续建 */ }

  const errs = await runStatements(env, SCHEMA_SQL, '建表');
  if (errs.length) {
    schemaError = errs.slice(0, 3).join(' ;; ');
    return; // 建表失败就别继续了，下次请求再试
  }
  schemaError = null;

  if (env.AUTO_SEED === '1' && SEED_SQL) {
    try {
      const markers = await env.DB.prepare('SELECT COUNT(*) AS n FROM markers').first();
      if (!markers || markers.n === 0) await runStatements(env, SEED_SQL, '示例数据');
    } catch (err) {
      console.error('[db] 示例数据写入失败：', err.message);
    }
  }
  schemaReady = true;
}
// 简易限流：每个 isolate 内存里，够用且不会跨实例一致（文档里说明了）
const buckets = new Map();
function rateLimit(req, key, max, windowMs) {
  const k = `${clientIp(req)}|${key}`;
  const nowMs = Date.now();
  const b = buckets.get(k);
  if (!b || nowMs - b.start > windowMs) { buckets.set(k, { start: nowMs, n: 1 }); return true; }
  b.n++;
  return b.n <= max;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, nickname: u.nickname, avatar: u.avatar, bio: u.bio, favChar: u.fav_char,
    serverKey: u.server_key, serverName: (SERVERS.find((s) => s.key === u.server_key) || {}).name || u.server_key,
    cityCode: u.city_code, cityName: u.city_name,
    regionLabel: u.city_code ? regionLabel(u.city_code) : '',
    uid: u.uid_public ? (u.uid_game || '') : '', uidPublic: !!u.uid_public,
    precision: u.precision, role: u.role, isSeed: !!u.is_seed
  };
}

function publicMarker(m, viewer) {
  const server = SERVERS.find((s) => s.key === m.server_key);
  return {
    id: m.id, kind: m.kind, lat: m.lat, lng: m.lng, label: m.label,
    nickname: m.nickname, favChar: m.fav_char || '',
    serverKey: m.server_key, serverName: server?.name || m.server_key,
    serverShort: server?.short || '?', serverColor: server?.color || '#B08A4F',
    uid: m.uid_public ? (m.uid_game || '') : '',
    sameServer: viewer ? viewer.server_key === m.server_key : false,
    isMine: viewer ? viewer.id === m.user_id : false,
    createdAt: m.created_at
  };
}

// ── 天气（Open-Meteo，可换境内服务）────────────────────────
const WMO = {
  0: ['clear', '晴'], 1: ['clear', '大致晴朗'], 2: ['cloudy', '多云'], 3: ['cloudy', '阴'],
  45: ['fog', '雾'], 48: ['fog', '雾凇'], 51: ['drizzle', '小毛毛雨'], 53: ['drizzle', '毛毛雨'],
  55: ['drizzle', '密毛毛雨'], 61: ['rain', '小雨'], 63: ['rain', '中雨'], 65: ['rain', '大雨'],
  71: ['snow', '小雪'], 73: ['snow', '中雪'], 75: ['snow', '大雪'], 80: ['rain', '阵雨'],
  81: ['rain', '强阵雨'], 82: ['storm', '暴雨'], 95: ['storm', '雷阵雨'], 99: ['storm', '强雷暴']
};

async function getWeather(store, cityCode, mock) {
  const city = getRegion(cityCode);
  if (!city) return { ok: false, error: 'city_not_found' };
  if (mock) {
    const map = {
      clear: ['clear', '晴', true], cloudy: ['cloudy', '多云', true], rain: ['rain', '小雨', true],
      storm: ['storm', '暴雨', true], snow: ['snow', '小雪', true], fog: ['fog', '雾', true],
      night: ['clear', '晴', false]
    };
    const [kind, text, isDay] = map[mock] || map.clear;
    return { ok: true, mock: true, cityCode, cityName: city.name, regionLabel: regionLabel(cityCode), kind, text, isDay, temp: 18, updatedAt: new Date().toISOString() };
  }
  const cached = await store.getWeatherCache(cityCode);
  if (cached) return { ok: true, ...cached, cityName: city.name, regionLabel: regionLabel(cityCode) };
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lng}`
      + '&current=temperature_2m,weather_code,is_day,precipitation,wind_speed_10m&timezone=Asia%2FShanghai';
    const res = await fetch(url, { cf: { cacheTtl: 900 } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const j = await res.json();
    const cur = j.current || {};
    const [kind, text] = WMO[cur.weather_code] || ['cloudy', '未知'];
    const payload = {
      kind, text, isDay: cur.is_day === 1,
      temp: Math.round(cur.temperature_2m ?? 0),
      precipitation: cur.precipitation ?? 0,
      wind: Math.round(cur.wind_speed_10m ?? 0),
      updatedAt: new Date().toISOString(), source: 'open-meteo'
    };
    await store.setWeatherCache(cityCode, payload);
    return { ok: true, cityCode, cityName: city.name, regionLabel: regionLabel(cityCode), ...payload };
  } catch (err) {
    return { ok: false, error: 'weather_unavailable', detail: String(err.message || err), cityCode, cityName: city.name };
  }
}

// ── 邮件：Workers 里没有 SMTP，走 HTTP 接口（Resend / 自建网关）──
async function sendMail(env, to, code) {
  const text = `你的验证码是 ${code}，5 分钟内有效。\n\n如果这不是你本人的操作，忽略这封邮件即可。\n\n—— ${SITE_NAME}（非官方同人项目）`;

  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: `${SITE_NAME} · 登录验证码`, text })
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return { delivered: true };
  }

  if (env.MAIL_API_URL) {
    const res = await fetch(env.MAIL_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.MAIL_API_TOKEN ? { authorization: `Bearer ${env.MAIL_API_TOKEN}` } : {})
      },
      body: JSON.stringify({ to, subject: `${SITE_NAME} · 登录验证码`, text })
    });
    if (!res.ok) throw new Error(`MAIL_API ${res.status}`);
    return { delivered: true };
  }

  if (env.ALLOW_DEV_CODE === '1') {
    console.log(`[mail:dev] ${to} -> ${code}`);
    return { delivered: false, dev: true };
  }

  throw new Error('未配置邮件服务（RESEND_API_KEY 或 MAIL_API_URL），已拒绝发送验证码');
}

// ── 主入口 ─────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const store = createStore(env);
    await ensureSchema(env);
    const secret = env.SESSION_SECRET || 'dev-secret-change-me';

    // 按 ADMIN_EMAIL 提权：用户还没注册时下次请求再试，成功一次就不再查
    if (env.ADMIN_EMAIL && !env.__adminChecked) {
      try {
        const promoted = await store.promoteUser(env.ADMIN_EMAIL, 'site_admin');
        if (promoted) env.__adminChecked = true;
      } catch { /* 忽略 */ }
    }
    const viewerId = await readSession(secret, request);
    const viewer = viewerId ? await store.getUserById(viewerId) : null;

    const body = async () => {
      try { return await request.json(); } catch { return {}; }
    };

    try {
      // ── 基础 ───────────────────────────────────────────
      if (path === '/api/health') return json({ ok: true, t: Date.now(), runtime: 'worker' });

      if (path === '/api/bootstrap') {
        return json({
          ok: true,
          site: {
            name: SITE_NAME,
            tagline: '非官方同人项目 · 与深蓝互动无关',
            mapProvider: env.TDT_TK ? 'tianditu' : 'paper',
            tdtTk: env.TDT_TK || '',
            devNoMail: env.ALLOW_DEV_CODE === '1'
          },
          servers: SERVERS,
          cities: CITY_POINTS,
          regions: { stats: REGION_STATS },
          legal: {
            version: 'v1.0',
            docs: LEGAL_DOCS.map((d) => ({ slug: d.slug, title: d.title, type: d.type, hash: LEGAL_HASHES[d.slug] })),
            required: REQUIRED_CONSENTS
          },
          stats: await store.stats(),
          me: viewer ? { ...publicUser(viewer), consent: { state: await store.consentState(viewer.id), needs: [], version: 'v1.0', hashes: LEGAL_HASHES } } : null
        });
      }

      if (path === '/api/stats') return json({ ok: true, stats: await store.stats() });
      if (path === '/api/regions') return json({ ok: true, stats: REGION_STATS, provinces: PROVINCES }, 200, { 'cache-control': 'public, max-age=86400' });
      if (path === '/api/legal') {
        return json({ ok: true, version: 'v1.0', docs: LEGAL_DOCS.map((d) => ({ slug: d.slug, title: d.title, type: d.type, hash: LEGAL_HASHES[d.slug] })) });
      }

      if (path === '/api/notices') return json({ ok: true, notices: await store.listNotices(30) });

      // ── 地图 ───────────────────────────────────────────
      if (path === '/api/map/feed') {
        const since = Number(url.searchParams.get('since') || 0);
        const rows = await store.listMarkers({ since });
        const markers = rows.map((m) => publicMarker(m, viewer));
        const lastSeq = rows.length ? rows[rows.length - 1].seq : since;
        return json({ ok: true, markers, seq: lastSeq, total: markers.length });
      }

      if (path === '/api/map/around') {
        const lat = Number(url.searchParams.get('lat'));
        const lng = Number(url.searchParams.get('lng'));
        const mode = url.searchParams.get('server') || 'all';
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(400, 'bad_request', '缺少坐标');
        let list = await store.listAround(lat, lng, { radiusKm: 50, limit: 60 });
        if (mode === 'mine' && viewer) list = list.filter((m) => m.server_key === viewer.server_key);
        list.sort((a, b) => {
          const sa = viewer && a.server_key === viewer.server_key ? 0 : 1;
          const sb = viewer && b.server_key === viewer.server_key ? 0 : 1;
          return sa - sb || a.distance - b.distance;
        });
        const near = list.slice(0, 20).map((m) => ({ ...publicMarker(m, viewer), distance: Math.round(m.distance) }));
        return json({ ok: true, near, count: list.length });
      }

      if (path === '/api/map/me') {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        const markers = (await store.listUserMarkers(viewer.id)).map((m) => publicMarker(m, viewer));
        return json({ ok: true, markers, limits: LIMITS });
      }

      if (path === '/api/map/place' && method === 'POST') {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        if (viewer.banned) return fail(403, 'banned', '账号已被限制');
        if (!(await store.hasConsent(viewer.id, 'location'))) {
          return fail(428, 'RECONSENT_REQUIRED', '需要先同意在公开地图展示位置', { consentType: 'location' });
        }
        if (!rateLimit(request, 'place', 30, 3600e3)) return fail(429, 'rate_limited', '操作太频繁了');

        const b = await body();
        const lat = Number(b.lat); const lng = Number(b.lng);
        const kind = b.kind === 'rabbit' ? 'rabbit' : 'umbrella';
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(400, 'bad_request', '坐标不合法');
        if (!isInChina(lat, lng)) return fail(422, 'OUT_OF_CHINA', '司辰只在这片土地上留伞');
        if (kind === 'umbrella' && (await store.countMain(viewer.id)) >= 1) {
          return fail(409, 'MAIN_EXISTS', '你已经有一把伞了。先收回它，或者放一只金兔子');
        }
        if (kind === 'rabbit' && (await store.countRabbits(viewer.id)) >= LIMITS.rabbitsPerUser) {
          return fail(409, 'RABBIT_LIMIT', `最多放 ${LIMITS.rabbitsPerUser} 只金兔子`);
        }
        const m = await store.createMarker({ userId: viewer.id, kind, lat, lng, label: b.label || '' });
        return json({ ok: true, marker: publicMarker({ ...m, nickname: viewer.nickname, server_key: viewer.server_key }, viewer) });
      }

      if (path.startsWith('/api/map/') && method === 'DELETE') {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        const id = path.split('/')[3];
        const done = await store.removeMarker(id, viewer.id);
        if (!done) return fail(404, 'not_found', '找不到这把伞');
        return json({ ok: true });
      }

      // ── 互动 ───────────────────────────────────────────
      if (path === '/api/touch' && method === 'POST') {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        const b = await body();
        const kind = b.kind === 'give' ? 'give' : 'knock';
        const r = await store.addTouch(viewer.id, String(b.markerId || ''), kind);
        if (!r.ok) {
          const map = {
            marker_not_found: [404, '找不到对方'], self: [400, '不能碰自己'],
            rate_limited: [429, '今天碰得够多了'], server_mismatch: [409, '你们不在一个服务器，游戏里加不了好友']
          };
          const [status, msg] = map[r.error] || [400, '操作失败'];
          return fail(status, r.error, msg, r.toServer ? { toServer: (SERVERS.find((s) => s.key === r.toServer) || {}).name } : {});
        }
        return json({ ok: true, ...r });
      }

      // ── 认证 ───────────────────────────────────────────
      if (path === '/api/auth/request-code' && method === 'POST') {
        const b = await body();
        const email = String(b.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'bad_email', '邮箱格式不对');
        if (!rateLimit(request, 'code', LIMITS.codePerHourPerIp, 3600e3)) return fail(429, 'rate_limited', '申请太频繁，晚点再试');

        const existing = await store.getCode(email);
        if (existing && Date.now() - existing.sent_at < LIMITS.codeCooldownSec * 1000) {
          const wait = Math.ceil((LIMITS.codeCooldownSec * 1000 - (Date.now() - existing.sent_at)) / 1000);
          return fail(429, 'cooldown', `请 ${wait} 秒后再试`, { retryAfter: wait });
        }
        const code = newCode();
        await store.setCode(email, await hashCode(secret, email, code), LIMITS.codeTtlSec);
        let sent;
        try {
          sent = await sendMail(env, email, code);
        } catch (err) {
          await store.clearCode(email);
          console.error('[mail] 发送失败：', err.message);
          return fail(502, 'mail_failed', '验证码邮件发送失败，请稍后再试');
        }
        return json({ ok: true, delivered: sent.delivered, devCode: sent.dev ? code : undefined, ttl: LIMITS.codeTtlSec });
      }

      if (path === '/api/auth/verify' && method === 'POST') {
        const b = await body();
        const email = String(b.email || '').trim().toLowerCase();
        const code = String(b.code || '').trim();
        const row = await store.getCode(email);
        if (!row) return fail(400, 'code_missing', '请先获取验证码');
        if (Date.now() > row.expires_at) return fail(400, 'code_expired', '验证码过期了');
        if (row.tries >= LIMITS.codeMaxTries) return fail(429, 'too_many_tries', '试错次数太多，重新获取吧');
        if (row.hash !== await hashCode(secret, email, code)) {
          await store.bumpCodeTry(email);
          return fail(400, 'code_wrong', '验证码不对');
        }
        await store.clearCode(email);

        const consents = b.consents || {};
        const missing = REQUIRED_CONSENTS.filter((t) => consents[t] !== true);
        let user = await store.getUserByEmail(email);
        const isNew = !user;
        if (isNew && missing.length) return fail(428, 'CONSENT_REQUIRED', '请先同意相关条款', { missing });

        if (isNew) {
          const serverKey = String(b.serverKey || '');
          const cityCode = String(b.cityCode || '');
          if (!SERVERS.some((s) => s.key === serverKey)) return fail(400, 'bad_server', '请选择渠道服');
          const cityNode = getRegion(cityCode);
          if (!cityNode) return fail(400, 'bad_city', '请选择省 / 市 / 区县');
          const nickname = String(b.nickname || '').trim().slice(0, 16);
          if (nickname.length < 2) return fail(400, 'bad_nickname', '昵称至少 2 个字');
          if (await store.getUserByNickname(nickname)) return fail(409, 'nickname_taken', '这个昵称已经有人用了');
          user = await store.createUser({ email, nickname, serverKey, cityCode, cityName: cityNode.name });
        }

        for (const type of ['terms', 'privacy', 'age14', 'location', 'uid']) {
          if (consents[type] === true) await store.recordConsent({ userId: user.id, docType: type, action: 'agree', ip: clientIp(request), ua: request.headers.get('user-agent') });
          else if (consents[type] === false) await store.recordConsent({ userId: user.id, docType: type, action: 'withdraw', ip: clientIp(request), ua: request.headers.get('user-agent') });
        }
        await store.touchLastSeen(user.id);

        const session = await issueSession(secret, user.id, { secure: new URL(request.url).protocol === 'https:' });
        return json({ ok: true, user: publicUser(user), consent: { state: await store.consentState(user.id) } }, 200, { 'set-cookie': session.cookie });
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
      }

      if (path === '/api/me' && method === 'GET') {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        return json({
          ok: true,
          user: { ...publicUser(viewer), uid: viewer.uid_game || '' },
          consent: { state: await store.consentState(viewer.id), needs: [], version: 'v1.0', hashes: LEGAL_HASHES },
          markers: await store.listUserMarkers(viewer.id),
          friends: await store.listFriends(viewer.id),
          friendCount: await store.countFriends(viewer.id)
        });
      }

      if (path === '/api/me' && method === 'PATCH') {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        const b = await body();
        const patch = {};
        if (b.nickname !== undefined) {
          const n = String(b.nickname).trim().slice(0, 16);
          if (n.length < 2) return fail(400, 'bad_nickname', '昵称至少 2 个字');
          const other = await store.getUserByNickname(n);
          if (other && other.id !== viewer.id) return fail(409, 'nickname_taken', '这个昵称已经有人用了');
          patch.nickname = n;
        }
        if (b.bio !== undefined) patch.bio = String(b.bio).slice(0, 80);
        if (b.favChar !== undefined) patch.fav_char = String(b.favChar).slice(0, 20);
        if (b.uidGame !== undefined) patch.uid_game = String(b.uidGame).replace(/[^0-9]/g, '').slice(0, 12);
        if (b.uidPublic !== undefined) patch.uid_public = b.uidPublic ? 1 : 0;
        if (b.precision !== undefined && ['fuzzy', 'exact', 'city'].includes(b.precision)) patch.precision = b.precision;
        if (b.cityCode !== undefined && getRegion(String(b.cityCode))) {
          patch.city_code = String(b.cityCode);
          patch.city_name = getRegion(String(b.cityCode)).name;
        }
        const u = await store.updateProfile(viewer.id, patch);
        return json({ ok: true, user: publicUser(u) });
      }

      if (path === '/api/consents' && method === 'POST') {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        const b = await body();
        const type = String(b.type || '');
        if (!['terms', 'privacy', 'location', 'uid', 'age14'].includes(type)) return fail(400, 'bad_type', '未知的同意类型');
        const action = b.action === 'withdraw' ? 'withdraw' : 'agree';
        await store.recordConsent({ userId: viewer.id, docType: type, action, ip: clientIp(request), ua: request.headers.get('user-agent') });
        return json({ ok: true, consent: { state: await store.consentState(viewer.id) } });
      }

      if (path === '/api/weather') {
        const cityCode = url.searchParams.get('cityCode') || '';
        const mock = url.searchParams.get('mock') || '';
        const w = await getWeather(store, cityCode, mock || undefined);
        return json(w, w.ok ? 200 : 502);
      }

      if (path === '/api/report' && method === 'POST') {
        if (!rateLimit(request, 'report', 10, 3600e3)) return fail(429, 'rate_limited', '举报太频繁');
        const b = await body();
        await store.addReport({
          targetType: String(b.targetType || 'marker'),
          targetId: String(b.targetId || ''),
          reason: String(b.reason || '').slice(0, 500),
          fromUser: viewer ? viewer.id : ''
        });
        return json({ ok: true });
      }

      // SSE 在 Workers 上没法跨请求广播，让浏览器自己隔一分钟重连
      if (path === '/api/stream') {
        return new Response('retry: 60000\n\n', {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }
        });
      }

      // ── 法律页面 ───────────────────────────────────────
      if (path.startsWith('/legal/')) {
        const slug = path.slice('/legal/'.length).replace(/\/$/, '');
        const meta = LEGAL_DOCS.find((d) => d.slug === slug);
        const md = LEGAL_TEXT[slug];
        if (!meta || !md) return fail(404, 'not_found', '没有这份文件');
        const nav = LEGAL_DOCS.map((d) => `<a href="/legal/${d.slug}" class="${d.slug === slug ? 'on' : ''}">${d.title}</a>`).join('');
        const html = `<!doctype html><html lang="zh-CN" class="legal-html"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${meta.title} · ${SITE_NAME}</title>
<link rel="stylesheet" href="/css/style.css"></head><body class="legal-body">
<header class="legal-top"><a class="legal-back" href="/">← 回到地图</a><span class="legal-brand">${SITE_NAME}</span></header>
<div class="legal-wrap"><nav class="legal-nav">${nav}</nav>
<article class="legal-doc"><div class="legal-meta"><span>版本 v1.0</span><span>文本校验码 ${LEGAL_HASHES[slug]}</span></div>
${renderMarkdown(md)}</article></div></body></html>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      // ── 自检（仅管理员；不含任何密钥值，只报布尔）──────────
      if (path === '/api/diag') {
        if (!viewer || (viewer.role !== 'admin' && viewer.role !== 'site_admin')) {
          return fail(403, 'forbidden', '需要管理员权限');
        }
        let tables = [];
        try {
          const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
          tables = (r.results || []).map((x) => x.name);
        } catch (err) {
          tables = [`读取失败: ${err.message}`];
        }
        let counts = {};
        try {
          const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
          const m = await env.DB.prepare('SELECT COUNT(*) AS n FROM markers').first();
          counts = { users: u ? u.n : 0, markers: m ? m.n : 0 };
        } catch (err) {
          counts = { error: String(err.message || err) };
        }
        return json({
          ok: true,
          runtime: 'worker',
          schemaError,
          tables,
          counts,
          hasDB: !!env.DB,
          hasAssets: !!env.ASSETS,
          hasTdtTk: !!(env.TDT_TK && env.TDT_TK.length > 8),
          hasAdminEmail: !!(env.ADMIN_EMAIL && env.ADMIN_EMAIL.includes('@')),
          hasMailFrom: !!env.MAIL_FROM,
          hasResend: !!env.RESEND_API_KEY,
          sessionSecretIsDefault: !env.SESSION_SECRET || env.SESSION_SECRET === 'dev-secret-change-me'
        });
      }

      // ── 管理后台 ───────────────────────────────────────
      if (path.startsWith('/api/admin/')) {
        if (!viewer) return fail(401, 'unauthorized', '请先登录');
        const isAdmin = viewer.role === 'admin' || viewer.role === 'site_admin';
        if (path === '/api/admin/me') return json({ ok: true, isAdmin, user: publicUser(viewer) });
        if (!isAdmin) return fail(403, 'forbidden', '需要管理员权限');

        if (path === '/api/admin/overview') return json({ ok: true, ...(await store.adminOverview()) });
        if (path === '/api/admin/notices' && method === 'GET') return json({ ok: true, notices: await store.listNotices(100) });
        if (path === '/api/admin/notices' && method === 'POST') {
          const b = await body();
          const title = String(b.title || '').trim().slice(0, 60);
          const text = String(b.body || '').trim().slice(0, 2000);
          if (!title || !text) return fail(400, 'bad_notice', '标题和正文都要填');
          const notice = await store.addNotice({
            title, body: text,
            level: ['info', 'warn', 'important'].includes(b.level) ? b.level : 'info',
            pinned: !!b.pinned, expiresAt: b.expiresAt || null
          });
          return json({ ok: true, notice });
        }
        const mNotice = path.match(/^\/api\/admin\/notices\/(\d+)$/);
        if (mNotice && method === 'PATCH') {
          const notice = await store.adminUpdateNotice(Number(mNotice[1]), await body());
          if (!notice) return fail(400, 'bad_request', '没有可更新的字段');
          return json({ ok: true, notice });
        }
        if (mNotice && method === 'DELETE') {
          return json({ ok: true, deleted: await store.adminDeleteNotice(Number(mNotice[1])) });
        }

        if (path === '/api/admin/users' && method === 'GET') {
          const q = url.searchParams.get('q') || '';
          const page = Math.max(1, Number(url.searchParams.get('page') || 1));
          return json({ ok: true, ...(await store.adminListUsers({ q, page, size: 20 })) });
        }

        const mUser = path.match(/^\/api\/admin\/users\/([^/]+)$/);
        if (mUser && method === 'GET') {
          const detail = await store.adminGetUser(mUser[1]);
          if (!detail) return fail(404, 'not_found', '找不到这个用户');
          return json({ ok: true, ...detail });
        }
        if (mUser && method === 'PATCH') {
          const b = await body();
          if (mUser[1] === viewer.id && b.role && b.role !== 'site_admin' && viewer.role === 'site_admin') {
            return fail(400, 'bad_request', '不能给自己降权');
          }
          const u = await store.adminSetUser(mUser[1], b);
          if (!u) return fail(400, 'bad_request', '没有可更新的字段');
          return json({ ok: true, user: u });
        }

        if (path === '/api/admin/markers' && method === 'GET') {
          const q = url.searchParams.get('q') || '';
          const server = url.searchParams.get('server') || '';
          const page = Math.max(1, Number(url.searchParams.get('page') || 1));
          return json({ ok: true, ...(await store.adminListMarkers({ q, server, page, size: 20 })) });
        }
        const mMarker = path.match(/^\/api\/admin\/markers\/([^/]+)$/);
        if (mMarker && method === 'DELETE') {
          const done = await store.adminDeleteMarker(decodeURIComponent(mMarker[1]));
          if (!done) return fail(404, 'not_found', '找不到这个标记');
          return json({ ok: true });
        }

        if (path === '/api/admin/reports' && method === 'GET') return json({ ok: true, reports: await store.adminListReports() });
        const mReport = path.match(/^\/api\/admin\/reports\/(\d+)$/);
        if (mReport && method === 'PATCH') {
          const b = await body();
          const status = ['open', 'done', 'ignored'].includes(b.status) ? b.status : 'done';
          return json({ ok: true, report: await store.adminSetReport(Number(mReport[1]), status) });
        }

        return fail(404, 'not_found', '没有这个管理接口');
      }

      // ── 静态资源交给 Cloudflare 的 assets 绑定 ──────────
      if (env.ASSETS) return env.ASSETS.fetch(request);

      return fail(404, 'not_found', '页面不存在');
    } catch (err) {
      console.error('[worker]', err);
      return fail(500, 'internal', '服务器出了点问题', {
        detail: String(err && err.message ? err.message : err),
        schema: schemaError || undefined
      });
    }
  }
};

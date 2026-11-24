// D1（Cloudflare SQLite）数据层：SQL 与 server/db.js 保持一致，接口全部 async
import { LIMITS, SERVER_MAP } from '../server/constants.js';
import { LEGAL_HASHES } from './data-legal.js';
import { getRegion } from './regions.js';

const now = () => new Date().toISOString();

// 确定性抖动：同一标记永远得到同一个模糊点（FNV-1a，同步、够用）
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fuzzCoord(id, lat, lng, precision = 'fuzzy', cityCode = null) {
  if (precision === 'city' && cityCode) {
    const c = getRegion(cityCode);
    if (c) return { lat: c.lat, lng: c.lng };
  }
  if (precision === 'exact') {
    return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
  }
  const cell = 0.005;
  const baseLat = Math.floor(lat / cell) * cell;
  const baseLng = Math.floor(lng / cell) * cell;
  const h = fnv(id + ':fuzz');
  const a = (h & 0xffff) / 65535;
  const b = ((h >>> 16) & 0xffff) / 65535;
  return {
    lat: Math.round((baseLat + a * cell) * 1e6) / 1e6,
    lng: Math.round((baseLng + b * cell) * 1e6) / 1e6
  };
}

export function createStore(env) {
  const db = env.DB;
  const stmt = (sql, args) => (args && args.length ? db.prepare(sql).bind(...args) : db.prepare(sql));
  const first = async (sql, ...args) => stmt(sql, args).first();
  const all = async (sql, ...args) => ((await stmt(sql, args).all()).results) || [];
  const run = async (sql, ...args) => stmt(sql, args).run();

  const store = {
    // ── 用户 ──────────────────────────────────────────────
    async getUserByEmail(email) { return first('SELECT * FROM users WHERE email = ?', email); },
    async getUserById(id) { return first('SELECT * FROM users WHERE id = ?', id); },
    async getUserByNickname(nick) { return first('SELECT * FROM users WHERE nickname = ?', nick); },

    async createUser({ email, nickname, serverKey, cityCode, cityName, precision = 'fuzzy' }) {
      const id = crypto.randomUUID();
      await run(
        `INSERT INTO users (id,email,nickname,server_key,city_code,city_name,precision,created_at,last_seen)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id, email, nickname, serverKey, cityCode, cityName, precision, now(), now()
      );
      return store.getUserById(id);
    },

    async updateProfile(userId, patch) {
      const fields = [];
      const values = [];
      for (const k of ['nickname', 'bio', 'bio_public', 'fav_char', 'avatar', 'uid_game', 'uid_public', 'precision', 'city_code', 'city_name']) {
        if (patch[k] !== undefined) { fields.push(`${k} = ?`); values.push(patch[k]); }
      }
      if (!fields.length) return store.getUserById(userId);
      values.push(userId);
      await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...values);
      return store.getUserById(userId);
    },

    async touchLastSeen(userId) { await run('UPDATE users SET last_seen = ? WHERE id = ?', now(), userId); },

    // ── 标记 ──────────────────────────────────────────────
    async createMarker({ userId, kind, lat, lng, label = '' }) {
      const id = crypto.randomUUID().slice(0, 8) + Date.now().toString(36);
      const user = await store.getUserById(userId);
      const p = fuzzCoord(id, lat, lng, user.precision, user.city_code);
      const seqRow = await first('SELECT COALESCE(MAX(seq),0)+1 AS n FROM markers');
      await run(
        `INSERT INTO markers (id,user_id,kind,lat,lng,label,visible,created_at,seq)
         VALUES (?,?,?,?,?,?,1,?,?)`,
        id, userId, kind, p.lat, p.lng, label, now(), seqRow.n
      );
      return store.getMarker(id);
    },

    async getMarker(id) { return first('SELECT * FROM markers WHERE id = ?', id); },

    async listMarkers({ since = 0, limit = 5000 } = {}) {
      return all(`
        SELECT m.*, u.nickname, u.server_key, u.fav_char, u.bio, u.bio_public, u.avatar, u.uid_game, u.uid_public,
               s.name AS server_name, s.short AS server_short, s.color AS server_color
        FROM markers m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN servers s ON s.key = u.server_key
        WHERE m.visible = 1 AND u.banned = 0 AND m.seq > ?
        ORDER BY m.seq ASC LIMIT ?
      `, since, limit);
    },

    async listUserMarkers(userId) {
      return all('SELECT * FROM markers WHERE user_id = ? ORDER BY kind DESC, created_at', userId);
    },

    async removeMarker(id, userId) {
      const m = await store.getMarker(id);
      if (!m || m.user_id !== userId) return false;
      await run('DELETE FROM markers WHERE id = ?', id);
      return true;
    },

    async countRabbits(userId) {
      return (await first("SELECT COUNT(*) AS n FROM markers WHERE user_id = ? AND kind = 'rabbit'", userId)).n;
    },

    async countMain(userId) {
      return (await first("SELECT COUNT(*) AS n FROM markers WHERE user_id = ? AND kind = 'umbrella'", userId)).n;
    },

    async listAround(lat, lng, { radiusKm = 50, limit = 40 } = {}) {
      const rows = await all(`
        SELECT m.*, u.nickname, u.server_key, u.fav_char, u.bio, u.bio_public, u.avatar, u.uid_game, u.uid_public,
               s.name AS server_name, s.short AS server_short, s.color AS server_color
        FROM markers m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN servers s ON s.key = u.server_key
        WHERE m.visible = 1 AND u.banned = 0
          AND m.lat BETWEEN ? AND ? AND m.lng BETWEEN ? AND ?
      `, lat - 1.2, lat + 1.2, lng - 1.4, lng + 1.4);

      const R = 6371000;
      const toRad = (d) => (d * Math.PI) / 180;
      const dist = (lat2, lng2) => {
        const dLat = toRad(lat2 - lat);
        const dLng = toRad(lng2 - lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
      };
      return rows
        .map((m) => ({ ...m, distance: dist(m.lat, m.lng) }))
        .filter((m) => m.distance <= radiusKm * 1000)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
    },

    async stats() {
      const total = (await first('SELECT COUNT(*) AS n FROM markers WHERE visible = 1')).n;
      const players = (await first('SELECT COUNT(DISTINCT user_id) AS n FROM markers WHERE visible = 1')).n;
      const mains = (await first("SELECT COUNT(*) AS n FROM markers WHERE visible = 1 AND kind = 'umbrella'")).n;
      const byServer = await all(`
        SELECT u.server_key AS key, s.name, s.color, COUNT(*) AS n
        FROM markers m JOIN users u ON u.id = m.user_id LEFT JOIN servers s ON s.key = u.server_key
        WHERE m.visible = 1 GROUP BY u.server_key ORDER BY n DESC
      `);
      return { total, players, mains, rabbits: total - mains, byServer };
    },

    // ── 互动 ──────────────────────────────────────────────
    async addTouch(fromUser, markerId, kind, note = '') {
      const m = await store.getMarker(markerId);
      if (!m) return { ok: false, error: 'marker_not_found' };
      if (m.user_id === fromUser) return { ok: false, error: 'self' };

      const day = new Date(Date.now() - 86400e3).toISOString();
      const todayCount = (await first('SELECT COUNT(*) AS n FROM touches WHERE from_user = ? AND created_at > ?', fromUser, day)).n;
      if (todayCount >= LIMITS.touchesPerDay) return { ok: false, error: 'rate_limited' };

      const from = await store.getUserById(fromUser);
      const to = await store.getUserById(m.user_id);
      if (kind === 'give' && from.server_key !== to.server_key) {
        return { ok: false, error: 'server_mismatch', toServer: to.server_key };
      }

      const dup = await first(
        'SELECT 1 AS x FROM touches WHERE from_user = ? AND to_marker = ? AND kind = ? AND created_at > ?',
        fromUser, markerId, kind, day
      );
      if (!dup) {
        await run('INSERT INTO touches (from_user,to_marker,to_user,kind,created_at) VALUES (?,?,?,?,?)',
          fromUser, markerId, m.user_id, kind, now());
      }

      let friend = false;
      if (kind === 'give') {
        const back = await first(`
          SELECT 1 AS x FROM touches t JOIN markers mm ON mm.id = t.to_marker
          WHERE t.from_user = ? AND mm.user_id = ? AND t.kind = 'give' LIMIT 1
        `, m.user_id, fromUser);
        if (back) {
          const [a, b] = [fromUser, m.user_id].sort();
          const exists = await first('SELECT 1 AS x FROM friends WHERE a = ? AND b = ?', a, b);
          if (!exists) {
            await run('INSERT INTO friends (a,b,since) VALUES (?,?,?)', a, b, now());
            friend = true;
          }
        }
      }
      return { ok: true, friend, alreadyTouched: !!dup };
    },

    async countFriends(userId) {
      return (await first('SELECT COUNT(*) AS n FROM friends WHERE a = ? OR b = ?', userId, userId)).n;
    },

    async listFriends(userId) {
      return all(`
        SELECT u.id, u.nickname, u.server_key, u.fav_char, u.bio,
               s.name AS server_name, s.color AS server_color, s.short AS server_short,
               f.since,
               m.id AS marker_id, m.lat, m.lng, m.label
        FROM friends f
        JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
        LEFT JOIN servers s ON s.key = u.server_key
        LEFT JOIN markers m ON m.id = (
          SELECT id FROM markers WHERE user_id = u.id AND kind = 'umbrella' AND visible = 1
          ORDER BY created_at LIMIT 1
        )
        WHERE f.a = ? OR f.b = ?
        ORDER BY f.since DESC
      `, userId, userId, userId);
    },

    async listTouchesReceived(userId, limit = 40) {
      return all(`
        SELECT t.id, t.kind, t.created_at, t.from_user, t.note, t.seen,
               u.nickname AS from_nickname,
               u.server_key AS from_server_key,
               s.name AS from_server_name, s.short AS from_server_short, s.color AS from_server_color,
               m.id AS from_marker_id, m.lat AS from_lat, m.lng AS from_lng, m.label AS from_label
        FROM touches t
        JOIN users u ON u.id = t.from_user
        LEFT JOIN servers s ON s.key = u.server_key
        LEFT JOIN markers m ON m.id = (
          SELECT id FROM markers WHERE user_id = t.from_user AND kind = 'umbrella' AND visible = 1
          ORDER BY created_at LIMIT 1
        )
        WHERE t.to_user = ?
        ORDER BY t.created_at DESC
        LIMIT ?
      `, userId, limit);
    },

    // ── 同意 ──────────────────────────────────────────────
    async recordConsent({ userId, docType, action, ip, ua }) {
      const hash = LEGAL_HASHES[docType] || LEGAL_HASHES.terms || 'v';
      await run(
        `INSERT INTO consents (user_id,doc_type,doc_version,doc_hash,action,ip,ua,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        userId, docType, 'v1.0', hash, action, ip || '', ua || '', now()
      );
    },

    async consentState(userId) {
      const rows = await all(
        'SELECT doc_type, doc_hash, action, created_at FROM consents WHERE user_id = ? ORDER BY created_at ASC',
        userId
      );
      const latest = new Map();
      for (const r of rows) latest.set(r.doc_type, r);
      const out = {};
      for (const [type, r] of latest) {
        const currentHash = LEGAL_HASHES[type] || '';
        out[type] = r.action === 'agree' && (!currentHash || r.doc_hash === currentHash);
      }
      return out;
    },

    async hasConsent(userId, type) {
      return !!(await store.consentState(userId))[type];
    },

    // ── 验证码 ────────────────────────────────────────────
    async setCode(email, hash, ttlSec) {
      const t = Date.now();
      await run(`
        INSERT INTO codes (email,hash,expires_at,tries,sent_at) VALUES (?,?,?,0,?)
        ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at, tries = 0, sent_at = excluded.sent_at
      `, email, hash, t + ttlSec * 1000, t);
    },
    async getCode(email) { return first('SELECT * FROM codes WHERE email = ?', email); },
    async bumpCodeTry(email) { await run('UPDATE codes SET tries = tries + 1 WHERE email = ?', email); },
    async clearCode(email) { await run('DELETE FROM codes WHERE email = ?', email); },

    // ── 天气缓存 ──────────────────────────────────────────
    async getWeatherCache(cityCode) {
      const row = await first('SELECT * FROM weather_cache WHERE city_code = ?', cityCode);
      if (!row) return null;
      if (Date.now() - row.fetched_at > 15 * 60 * 1000) return null;
      return { ...JSON.parse(row.payload), cached: true };
    },
    async setWeatherCache(cityCode, payload) {
      await run(`
        INSERT INTO weather_cache (city_code,payload,fetched_at) VALUES (?,?,?)
        ON CONFLICT(city_code) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
      `, cityCode, JSON.stringify(payload), Date.now());
    },

    // ── 举报 ──────────────────────────────────────────────
    async addReport({ targetType, targetId, reason, detail, fromUser }) {
      await run('INSERT INTO reports (target_type,target_id,reason,detail,from_user,created_at) VALUES (?,?,?,?,?,?)',
        targetType, targetId, reason, detail || '', fromUser || '', now());
    },

    // ── 公告 ──────────────────────────────────────────────
    async listNotices(limit = 30) {
      return all(`
        SELECT * FROM notices
        WHERE expires_at IS NULL OR expires_at > ?
        ORDER BY pinned DESC, created_at DESC LIMIT ?
      `, now(), limit);
    },

    async addNotice({ title, body, level = 'info', category = 'notice', pinned = 0, expiresAt = null }) {
      await run('INSERT INTO notices (title,body,level,category,pinned,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',
        title, body, level, category, pinned ? 1 : 0, now(), expiresAt);
      return first('SELECT * FROM notices ORDER BY id DESC LIMIT 1');
    },

    // ── 管理后台 ──────────────────────────────────────────
    async adminOverview() {
      const markers = (await first('SELECT COUNT(*) AS n FROM markers WHERE visible = 1')).n;
      const users = (await first('SELECT COUNT(*) AS n FROM users')).n;
      const dayAgo = new Date(Date.now() - 86400e3).toISOString();
      const newUsers = (await first('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', dayAgo)).n;
      const newMarkers = (await first('SELECT COUNT(*) AS n FROM markers WHERE created_at > ?', dayAgo)).n;
      const notices = (await first('SELECT COUNT(*) AS n FROM notices')).n;
      const reportsOpen = (await first("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'")).n;
      const byServer = await all(`
        SELECT u.server_key AS key, s.name, s.color, COUNT(*) AS n
        FROM markers m JOIN users u ON u.id = m.user_id LEFT JOIN servers s ON s.key = u.server_key
        WHERE m.visible = 1 GROUP BY u.server_key ORDER BY n DESC
      `);
      const recentUsers = await all(`
        SELECT u.id, u.nickname, u.server_key, s.name AS server_name, u.city_name, u.created_at, u.role
        FROM users u LEFT JOIN servers s ON s.key = u.server_key
        ORDER BY u.created_at DESC LIMIT 8
      `);
      const recentMarkers = await all(`
        SELECT m.id, m.kind, m.label, m.created_at, u.nickname
        FROM markers m JOIN users u ON u.id = m.user_id
        ORDER BY m.created_at DESC LIMIT 8
      `);
      return { markers, users, newUsers, newMarkers, notices, reportsOpen, byServer, recentUsers, recentMarkers };
    },

    async adminListUsers({ q = '', page = 1, size = 20 } = {}) {
      const like = `%${q}%`;
      const where = q ? 'WHERE u.nickname LIKE ? OR u.email LIKE ? OR u.id LIKE ?' : '';
      const params = q ? [like, like, like] : [];
      const total = (await first(`SELECT COUNT(*) AS n FROM users u ${where}`, ...params)).n;
      const rows = await all(`
        SELECT u.*, s.name AS server_name,
          (SELECT COUNT(*) FROM markers m WHERE m.user_id = u.id AND m.visible = 1) AS marker_count
        FROM users u LEFT JOIN servers s ON s.key = u.server_key
        ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?
      `, ...params, size, (page - 1) * size);
      return { total, page, size, rows };
    },

    async adminSetUser(id, patch) {
      const fields = [];
      const values = [];
      if (patch.role && ['user', 'admin', 'site_admin'].includes(patch.role)) { fields.push('role = ?'); values.push(patch.role); }
      if (patch.banned !== undefined) { fields.push('banned = ?'); values.push(patch.banned ? 1 : 0); }
      if (!fields.length) return null;
      values.push(id);
      await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...values);
      return first('SELECT id, nickname, role, banned FROM users WHERE id = ?', id);
    },

    async adminGetUser(id) {
      const user = await first(`
        SELECT u.id, u.nickname, u.email, u.server_key, s.name AS server_name,
               u.city_name, u.role, u.banned, u.created_at, u.last_seen, u.uid_game, u.uid_public
        FROM users u LEFT JOIN servers s ON s.key = u.server_key WHERE u.id = ?
      `, id);
      if (!user) return null;
      const markers = await all('SELECT id, kind, lat, lng, label, created_at FROM markers WHERE user_id = ? ORDER BY created_at DESC', id);
      const reportCount = (await first(`
        SELECT COUNT(*) AS n FROM reports r JOIN markers m ON m.id = r.target_id WHERE m.user_id = ?
      `, id)).n;
      return { user, markers, reportCount };
    },

    async adminListMarkers({ q = '', server = '', page = 1, size = 20 } = {}) {
      const conds = [];
      const params = [];
      if (q) { conds.push('(u.nickname LIKE ? OR m.label LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
      if (server) { conds.push('u.server_key = ?'); params.push(server); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = (await first(`SELECT COUNT(*) AS n FROM markers m JOIN users u ON u.id = m.user_id ${where}`, ...params)).n;
      const rows = await all(`
        SELECT m.*, u.nickname, u.server_key, s.name AS server_name
        FROM markers m JOIN users u ON u.id = m.user_id LEFT JOIN servers s ON s.key = u.server_key
        ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?
      `, ...params, size, (page - 1) * size);
      return { total, page, size, rows };
    },

    async adminDeleteMarker(id) {
      const r = await run('DELETE FROM markers WHERE id = ?', id);
      return (r.meta?.changes || 0) > 0;
    },

    async adminListReports() {
      return all(`
        SELECT r.*, u.nickname AS reporter,
               tt.note AS target_note, tt.kind AS target_touch_kind, tt.created_at AS target_touch_at,
               tn.id AS note_author_id, tn.nickname AS note_author,
               m.label AS target_marker_label, m.kind AS target_marker_kind,
               m.lat AS target_lat, m.lng AS target_lng,
               t.id AS target_user_id, t.nickname AS target_nickname, t.banned AS target_banned,
               t.server_key AS target_server_key, s.name AS target_server_name
        FROM reports r
        LEFT JOIN users u ON u.id = r.from_user
        LEFT JOIN markers m ON m.id = r.target_id AND r.target_type = 'marker'
        LEFT JOIN touches tt ON tt.id = r.target_id AND r.target_type = 'touch'
        LEFT JOIN users tn ON tn.id = tt.from_user
        LEFT JOIN users t ON t.id = m.user_id
        LEFT JOIN servers s ON s.key = t.server_key
        ORDER BY r.created_at DESC LIMIT 100
      `);
    },

    async adminSetReport(id, status) {
      await run('UPDATE reports SET status = ? WHERE id = ?', status, id);
      return first('SELECT * FROM reports WHERE id = ?', id);
    },

    async adminDeleteNotice(id) {
      const r = await run('DELETE FROM notices WHERE id = ?', id);
      return (r.meta?.changes || 0) > 0;
    },

    async adminUpdateNotice(id, patch) {
      const fields = [];
      const values = [];
      if (patch.title !== undefined) { fields.push('title = ?'); values.push(String(patch.title).slice(0, 60)); }
      if (patch.body !== undefined) { fields.push('body = ?'); values.push(String(patch.body).slice(0, 2000)); }
      if (patch.level !== undefined && ['info', 'warn', 'important'].includes(patch.level)) { fields.push('level = ?'); values.push(patch.level); }
      if (patch.pinned !== undefined) { fields.push('pinned = ?'); values.push(patch.pinned ? 1 : 0); }
      if (patch.expiresAt !== undefined) { fields.push('expires_at = ?'); values.push(patch.expiresAt || null); }
      if (!fields.length) return null;
      values.push(id);
      await run(`UPDATE notices SET ${fields.join(', ')} WHERE id = ?`, ...values);
      return first('SELECT * FROM notices WHERE id = ?', id);
    },

    async promoteUser(identifier, role = 'admin') {
      const u = await first('SELECT * FROM users WHERE email = ? OR nickname = ?', identifier, identifier);
      if (!u) return null;
      await run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
      return { ...u, role };
    },

    async countAdmins() {
      return (await first("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','site_admin')")).n;
    },

    // ── 图片 ──────────────────────────────────────────────
    async saveMedia({ id, mime, data, size }) {
      await run('INSERT INTO media (id, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?)',
        id, mime, data, size, now());
    },

    async getMedia(id) {
      return await first('SELECT id, mime, data FROM media WHERE id = ?', id);
    },

    // ── 站点设置 ──────────────────────────────────────────
    async getSetting(key) {
      const row = await first('SELECT value FROM settings WHERE key = ?', key);
      return row ? row.value : null;
    },

    async setSetting(key, value) {
      await run(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `, key, String(value ?? ''), now());
    },

    async readWhitelist() {
      const raw = (await store.getSetting('test_emails')) || '';
      return String(raw).split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
    },

    async writeWhitelist(raw) {
      const list = String(raw || '')
        .split(/[,;\s]+/).map((s) => s.trim().toLowerCase())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s));
      await store.setSetting('test_emails', list.join('\n'));
      return list;
    },

    /** 未读互动数 */
    async countUnreadTouches(userId) {
      const row = await first('SELECT COUNT(*) AS n FROM touches WHERE to_user = ? AND seen = 0', userId);
      return row ? row.n : 0;
    },

    /** 把收到的互动全部标记为已读 */
    async markTouchesSeen(userId) {
      await run('UPDATE touches SET seen = 1 WHERE to_user = ? AND seen = 0', userId);
    },

    /** 单条互动（举报留言时用来校验归属） */
    async getTouch(id) {
      return first('SELECT id, from_user, to_user, to_marker, kind, note FROM touches WHERE id = ?', id);
    },

    SERVER_MAP
  };

  return store;
}

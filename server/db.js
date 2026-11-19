// SQLite 数据层（node:sqlite 同步 API，零依赖）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_DIR, SERVERS, DOC_HASHES, DOC_VERSION, LIMITS } from './config.js';
import { fuzzCoord, haversine } from './geo.js';

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'app.db');
export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS servers (
  key TEXT PRIMARY KEY, name TEXT, short TEXT, region TEXT,
  color TEXT, sort INTEGER, active INTEGER DEFAULT 1, note TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  nickname TEXT NOT NULL,
  avatar TEXT DEFAULT 'umbrella',
  bio TEXT DEFAULT '',
  fav_char TEXT DEFAULT '',
  server_key TEXT NOT NULL,
  city_code TEXT,
  city_name TEXT,
  uid_game TEXT DEFAULT '',
  uid_public INTEGER DEFAULT 0,
  precision TEXT DEFAULT 'fuzzy',
  role TEXT DEFAULT 'user',
  banned INTEGER DEFAULT 0,
  is_seed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS markers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('umbrella','rabbit')),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  label TEXT DEFAULT '',
  visible INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  moved_at TEXT,
  seq INTEGER
);


CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL,
  to_marker TEXT NOT NULL,
  to_user TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('knock','give')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friends (
  a TEXT NOT NULL, b TEXT NOT NULL, since TEXT NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_version TEXT NOT NULL,
  doc_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codes (
  email TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  tries INTEGER DEFAULT 0,
  sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_cache (
  city_code TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level TEXT DEFAULT 'info',
  pinned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT, target_id TEXT, reason TEXT,
  from_user TEXT, status TEXT DEFAULT 'open', created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_markers_seq ON markers(seq);
CREATE INDEX IF NOT EXISTS idx_markers_user ON markers(user_id);
CREATE INDEX IF NOT EXISTS idx_touches_to ON touches(to_marker);
CREATE INDEX IF NOT EXISTS idx_consents_user ON consents(user_id, doc_type, created_at);
`);

const now = () => new Date().toISOString();

// ── 服务器配置同步 ──────────────────────────────────────────
const upsertServer = db.prepare(`
  INSERT INTO servers (key,name,short,region,color,sort,active,note)
  VALUES (?,?,?,?,?,?,1,?)
  ON CONFLICT(key) DO UPDATE SET name=excluded.name, short=excluded.short,
    region=excluded.region, color=excluded.color, sort=excluded.sort, note=excluded.note
`);
for (const s of SERVERS) upsertServer.run(s.key, s.name, s.short, s.region, s.color, s.sort, s.note);

export function listServers() {
  return db.prepare('SELECT key,name,short,region,color,note FROM servers WHERE active=1 ORDER BY sort').all();
}

// ── 用户 ────────────────────────────────────────────────────
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function getUserByNickname(nick) {
  return db.prepare('SELECT * FROM users WHERE nickname = ?').get(nick);
}

export function createUser({ email, nickname, serverKey, cityCode, cityName, precision = 'fuzzy' }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id,email,nickname,server_key,city_code,city_name,precision,created_at,last_seen)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, email, nickname, serverKey, cityCode, cityName, precision, now(), now());
  return getUserById(id);
}

export function updateProfile(userId, patch) {
  const fields = [];
  const values = [];
  for (const k of ['nickname', 'bio', 'fav_char', 'avatar', 'uid_game', 'uid_public', 'precision', 'city_code', 'city_name']) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); values.push(patch[k]); }
  }
  if (!fields.length) return getUserById(userId);
  values.push(userId);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(userId);
}

export function touchLastSeen(userId) {
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), userId);
}

// ── 标记 ────────────────────────────────────────────────────
export function createMarker({ userId, kind, lat, lng, label = '' }) {
  const id = randomUUID().slice(0, 8) + Date.now().toString(36);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM markers').get().n) | 0;
  const user = getUserById(userId);
  const p = fuzzCoord(id, lat, lng, user.precision, user.city_code);
  db.prepare(`INSERT INTO markers (id,user_id,kind,lat,lng,label,visible,created_at,seq)
              VALUES (?,?,?,?,?,?,1,?,?)`)
    .run(id, userId, kind, p.lat, p.lng, label, now(), seq);
  return getMarker(id);
}

export function getMarker(id) {
  return db.prepare('SELECT * FROM markers WHERE id = ?').get(id);
}

export function listMarkers({ since = 0, limit = 20000 } = {}) {
  return db.prepare(`
    SELECT m.*, u.nickname, u.server_key, u.fav_char, u.avatar, u.uid_game, u.uid_public, u.is_seed,
           s.name AS server_name, s.short AS server_short, s.color AS server_color, s.region AS server_region
    FROM markers m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN servers s ON s.key = u.server_key
    WHERE m.visible = 1 AND u.banned = 0 AND m.seq > ?
    ORDER BY m.seq ASC LIMIT ?
  `).all(since, limit);
}

export function listUserMarkers(userId) {
  return db.prepare('SELECT * FROM markers WHERE user_id = ? ORDER BY kind DESC, created_at').all(userId);
}

export function removeMarker(id, userId) {
  const m = getMarker(id);
  if (!m || m.user_id !== userId) return false;
  db.prepare('DELETE FROM markers WHERE id = ?').run(id);
  return true;
}

export function countRabbits(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM markers WHERE user_id = ? AND kind = 'rabbit'").get(userId).n;
}

export function countMain(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM markers WHERE user_id = ? AND kind = 'umbrella'").get(userId).n;
}

// ── 附近 ────────────────────────────────────────────────────
export function listAround(lat, lng, { radiusKm = 50, limit = 40 } = {}) {
  // 先用 1 度网格粗筛，再精算距离（数据量小，够用）
  const box = db.prepare(`
    SELECT m.*, u.nickname, u.server_key, u.fav_char, u.avatar, u.uid_game, u.uid_public,
           s.name AS server_name, s.short AS server_short, s.color AS server_color
    FROM markers m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN servers s ON s.key = u.server_key
    WHERE m.visible = 1 AND u.banned = 0
      AND m.lat BETWEEN ? AND ? AND m.lng BETWEEN ? AND ?
  `).all(lat - 1.2, lat + 1.2, lng - 1.4, lng + 1.4);
  return box
    .map((m) => ({ ...m, distance: haversine(lat, lng, m.lat, m.lng) }))
    .filter((m) => m.distance <= radiusKm * 1000)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

// ── 统计 ────────────────────────────────────────────────────
export function stats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM markers WHERE visible = 1').get().n;
  const players = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM markers WHERE visible = 1').get().n;
  const mains = db.prepare("SELECT COUNT(*) AS n FROM markers WHERE visible = 1 AND kind='umbrella'").get().n;
  const byServer = db.prepare(`
    SELECT u.server_key AS key, s.name, s.color, COUNT(*) AS n
    FROM markers m JOIN users u ON u.id=m.user_id LEFT JOIN servers s ON s.key=u.server_key
    WHERE m.visible=1 GROUP BY u.server_key ORDER BY n DESC
  `).all();
  return { total, players, mains, rabbits: total - mains, byServer };
}

// ── 互动 ────────────────────────────────────────────────────
export function addTouch(fromUser, markerId, kind) {
  const m = getMarker(markerId);
  if (!m) return { ok: false, error: 'marker_not_found' };
  if (m.user_id === fromUser) return { ok: false, error: 'self' };

  const day = new Date(Date.now() - 86400e3).toISOString();
  const todayCount = db.prepare('SELECT COUNT(*) AS n FROM touches WHERE from_user=? AND created_at>?').get(fromUser, day).n;
  if (todayCount >= LIMITS.touchesPerDay) return { ok: false, error: 'rate_limited' };

  const from = getUserById(fromUser);
  const to = getUserById(m.user_id);
  if (kind === 'give' && from.server_key !== to.server_key) {
    return { ok: false, error: 'server_mismatch', toServer: to.server_key };
  }

  // 同一天重复同类互动不再记录
  const dup = db.prepare(`SELECT 1 FROM touches WHERE from_user=? AND to_marker=? AND kind=? AND created_at>?`)
    .get(fromUser, markerId, kind, new Date(Date.now() - 86400e3).toISOString());
  if (!dup) {
    db.prepare('INSERT INTO touches (from_user,to_marker,to_user,kind,created_at) VALUES (?,?,?,?,?)')
      .run(fromUser, markerId, m.user_id, kind, now());
  }

  // 互相「递伞」→ 同伞之交
  let friend = false;
  if (kind === 'give') {
    const back = db.prepare(`
      SELECT 1 FROM touches t JOIN markers mm ON mm.id = t.to_marker
      WHERE t.from_user = ? AND mm.user_id = ? AND t.kind='give' LIMIT 1
    `).get(m.user_id, fromUser);
    if (back) {
      const [a, b] = [fromUser, m.user_id].sort();
      const exists = db.prepare('SELECT 1 FROM friends WHERE a=? AND b=?').get(a, b);
      if (!exists) {
        db.prepare('INSERT INTO friends (a,b,since) VALUES (?,?,?)').run(a, b, now());
        friend = true;
      }
    }
  }
  return { ok: true, friend, alreadyTouched: !!dup };
}

export function countFriends(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM friends WHERE a=? OR b=?').get(userId, userId).n;
}

export function listFriends(userId) {
  return db.prepare(`
    SELECT u.id,u.nickname,u.server_key,s.name AS server_name,s.color AS server_color,f.since
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.a=? THEN f.b ELSE f.a END
    LEFT JOIN servers s ON s.key=u.server_key
    WHERE f.a=? OR f.b=? ORDER BY f.since DESC
  `).all(userId, userId, userId);
}

// ── 同意记录 ────────────────────────────────────────────────
export function recordConsent({ userId, docType, action, ip, ua }) {
  const hash = DOC_HASHES.get(docType) || DOC_HASHES.get(docType === 'privacy' ? 'privacy' : 'terms') || 'v';
  db.prepare(`INSERT INTO consents (user_id,doc_type,doc_version,doc_hash,action,ip,ua,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(userId, docType, DOC_VERSION, hash, action, ip ?? '', ua ?? '', now());
}

export function consentState(userId) {
  const rows = db.prepare(`
    SELECT doc_type, doc_hash, action, created_at FROM consents
    WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId);
  const latest = new Map();
  for (const r of rows) latest.set(r.doc_type, r);
  const out = {};
  for (const [type, r] of latest) {
    const currentHash = DOC_HASHES.get(type) || '';
    out[type] = r.action === 'agree' && (!currentHash || r.doc_hash === currentHash);
  }
  return out;
}

export function hasConsent(userId, type) {
  return !!consentState(userId)[type];
}

// ── 验证码 ──────────────────────────────────────────────────
export function setCode(email, hash, ttlSec) {
  const t = Date.now();
  db.prepare(`INSERT INTO codes (email,hash,expires_at,tries,sent_at) VALUES (?,?,?,0,?)
              ON CONFLICT(email) DO UPDATE SET hash=excluded.hash, expires_at=excluded.expires_at, tries=0, sent_at=excluded.sent_at`)
    .run(email, hash, t + ttlSec * 1000, t);
}
export function getCode(email) {
  return db.prepare('SELECT * FROM codes WHERE email = ?').get(email);
}
export function bumpCodeTry(email) {
  db.prepare('UPDATE codes SET tries = tries + 1 WHERE email = ?').run(email);
}
export function clearCode(email) {
  db.prepare('DELETE FROM codes WHERE email = ?').run(email);
}

// ── 天气缓存 ────────────────────────────────────────────────
export function getWeatherCache(cityCode) {
  const row = db.prepare('SELECT * FROM weather_cache WHERE city_code = ?').get(cityCode);
  if (!row) return null;
  if (Date.now() - row.fetched_at > 15 * 60 * 1000) return null;
  return { ...JSON.parse(row.payload), cached: true };
}
export function setWeatherCache(cityCode, payload) {
  db.prepare(`INSERT INTO weather_cache (city_code,payload,fetched_at) VALUES (?,?,?)
              ON CONFLICT(city_code) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`)
    .run(cityCode, JSON.stringify(payload), Date.now());
}

// ── 公告 ────────────────────────────────────────────────────
export function listNotices(limit = 30) {
  return db.prepare(`
    SELECT * FROM notices
    WHERE expires_at IS NULL OR expires_at > ?
    ORDER BY pinned DESC, created_at DESC
    LIMIT ?
  `).all(now(), limit);
}

export function addNotice({ title, body, level = 'info', pinned = 0, expiresAt = null }) {
  const info = db.prepare(`
    INSERT INTO notices (title, body, level, pinned, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, body, level, pinned ? 1 : 0, now(), expiresAt);
  return db.prepare('SELECT * FROM notices WHERE id = ?').get(info.lastInsertRowid);
}

export function seedNotices() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM notices').get().n;
  if (n > 0) return { seeded: false };
  addNotice({
    title: '9友地图上线了',
    body: '在荒原纸面上撑一把伞，看看同服的司辰都散落在哪些城市。\n'
      + '· 注册时请如实选择渠道服——不同渠道服在游戏里加不了好友。\n'
      + '· 坐标会模糊到约 500 米再展示，请不要把伞放在住处或学校。\n'
      + '· 觉得哪里不好看、哪里不好用，都欢迎告诉站长。',
    level: 'info',
    pinned: 1
  });
  addNotice({
    title: '关于位置与隐私',
    body: '位置属于敏感个人信息，需要你单独同意才会展示，随时可以在「手提箱 → 隐私」里关掉。\n'
      + '地图上所有坐标都是模糊后的结果，任何人（包括站长）都看不到你的精确位置。',
    level: 'warn'
  });
  addNotice({
    title: '示例公告：可以删掉这条',
    body: '发布新公告：node scripts/notice.mjs "标题" "正文" --level warn --pin\n'
      + '或配置 ADMIN_TOKEN 后调用 POST /api/admin/notices。',
    level: 'info'
  });
  return { seeded: true };
}
// ── 举报 ────────────────────────────────────────────────────
export function addReport({ targetType, targetId, reason, fromUser }) {
  db.prepare('INSERT INTO reports (target_type,target_id,reason,from_user,created_at) VALUES (?,?,?,?,?)')
    .run(targetType, targetId, reason, fromUser ?? '', now());
}

// ── 种子数据 ────────────────────────────────────────────────
const SEED_NICKS = [
  ['维尔汀的伞', 'official', '星锑'], ['十四行诗', 'official', '十四行诗'],
  ['暴雨观察员', 'bilibili', '6'], ['拉普拉斯值班员', 'huawei', '卡卡尼亚'],
  ['小梅斯梅尔', 'xiaomi', '梅斯梅尔'], ['司辰不加班', 'official', '维尔汀'],
  ['雨滴收藏家', 'harmony', '牙仙'], ['时代见证者', 'bilibili', '镭'],
  ['手提箱管理员', 'vivo', '布朗'], ['无声综合征', 'official', '艾拉'],
  ['荒原拓荒者', 'oppo', '莉拉'], ['孤屿居民', 'tencent', 'Z'],
  ['雨里的怀表', 'official', '瑞秋'], ['乌尔里希', '4399', '乌尔里希'],
  ['深眠域常客', 'huawei', '波莉娜'], ['醒梦域逃兵', 'bilibili', '诺娜'],
  ['基金会文员', 'official', '索菲亚'], ['暴雨预警中', 'xiaomi', '莉莉娅'],
  ['纯雨滴不够', 'official', '安可'], ['时代滤镜', 'vivo', '曼努埃拉'],
  ['镜中人', 'official', '镜'], ['倒流的分针', 'oppo', '阿尔伯特'],
  ['旧日邮差', 'harmony', '伊索尔德'], ['雨声采样师', 'bilibili', '查理'],
  ['凌晨四点的伞', 'official', '艾玛'], ['多雨地带', 'tencent', '雷'],
  ['静默收藏', 'official', '卡莲'], ['雨前漫游', 'xiaomi', '乌尔里希'],
  ['司辰的第一天', 'official', '维尔汀'], ['一把旧伞', '4399', '老伞']
];

const SEED_CITIES = [
  ['北京', 39.90, 116.40], ['上海', 31.23, 121.47], ['广州', 23.12, 113.26],
  ['深圳', 22.54, 114.05], ['杭州', 30.27, 120.15], ['成都', 30.57, 104.07],
  ['武汉', 30.59, 114.30], ['西安', 34.34, 108.94], ['南京', 32.06, 118.80],
  ['重庆', 29.56, 106.55], ['长沙', 28.23, 112.94], ['天津', 39.34, 117.36],
  ['郑州', 34.75, 113.63], ['青岛', 36.07, 120.38], ['沈阳', 41.81, 123.43],
  ['大连', 38.91, 121.61], ['哈尔滨', 45.80, 126.53], ['长春', 43.82, 125.32],
  ['济南', 36.65, 117.12], ['合肥', 31.82, 117.23], ['福州', 26.07, 119.30],
  ['厦门', 24.48, 118.09], ['南昌', 28.68, 115.86], ['昆明', 25.04, 102.72],
  ['贵阳', 26.65, 106.63], ['南宁', 22.82, 108.37], ['海口', 20.04, 110.20],
  ['兰州', 36.06, 103.83], ['西宁', 36.62, 101.78], ['银川', 38.49, 106.23],
  ['乌鲁木齐', 43.83, 87.62], ['拉萨', 29.65, 91.17], ['呼和浩特', 40.84, 111.75],
  ['太原', 37.87, 112.55], ['石家庄', 38.04, 114.51], ['宁波', 29.87, 121.54],
  ['苏州', 31.30, 120.59], ['无锡', 31.49, 120.31], ['温州', 27.99, 120.70],
  ['佛山', 23.02, 113.12], ['东莞', 23.02, 113.75], ['珠海', 22.27, 113.58],
  ['泉州', 24.87, 118.68], ['烟台', 37.46, 121.45], ['洛阳', 34.62, 112.45],
  ['桂林', 25.27, 110.29], ['三亚', 18.25, 109.51]
];

export function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM markers').get().n;
  if (n > 0) return { seeded: false, markers: n };

  const insertUser = db.prepare(`INSERT INTO users
    (id,email,nickname,fav_char,server_key,city_code,city_name,uid_game,uid_public,precision,is_seed,created_at,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`);

  SEED_NICKS.forEach(([nick, server, fav], i) => {
    const city = SEED_CITIES[i % SEED_CITIES.length];
    const id = `seed-${i + 1}`;
    insertUser.run(
      id, null, nick, fav, server, null, city[0],
      '', 0, 'fuzzy', now(), now()
    );
  });

  const insertMarker = db.prepare(`INSERT INTO markers
    (id,user_id,kind,lat,lng,label,visible,created_at,seq) VALUES (?,?,?,?,?,?,1,?,?)`);

  let seq = 0;
  for (let i = 0; i < SEED_NICKS.length; i++) {
    const city = SEED_CITIES[i % SEED_CITIES.length];
    const userId = `seed-${i + 1}`;
    // 在城市附近撒点
    const jitterLat = ((i * 37) % 100) / 100 - 0.5;
    const jitterLng = ((i * 61) % 100) / 100 - 0.5;
    const lat = city[1] + jitterLat * 0.18;
    const lng = city[2] + jitterLng * 0.18;
    const mid = `seedm-${i + 1}`;
    const p = fuzzCoord(mid, lat, lng, 'fuzzy');
    insertMarker.run(mid, userId, 'umbrella', p.lat, p.lng, city[0], now(), ++seq);
    // 一部分人放金兔子
    if (i % 3 === 0) {
      const rp = fuzzCoord(`${mid}-r`, lat + 0.05, lng - 0.04, 'fuzzy');
      insertMarker.run(`${mid}-r`, userId, 'rabbit', rp.lat, rp.lng, city[0], now(), ++seq);
    }
  }
  return { seeded: true, markers: seq };
}

export { DB_PATH, now };

// ── 管理后台 ────────────────────────────────────────────────
export function promoteUser(identifier, role = 'admin') {
  const u = db.prepare('SELECT * FROM users WHERE email = ? OR nickname = ?').get(identifier, identifier);
  if (!u) return null;
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  return { ...u, role };
}

export function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','site_admin')").get().n;
}

export function adminOverview() {
  const markers = db.prepare('SELECT COUNT(*) AS n FROM markers WHERE visible = 1').get().n;
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const dayAgo = new Date(Date.now() - 86400e3).toISOString();
  const newUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').get(dayAgo).n;
  const newMarkers = db.prepare('SELECT COUNT(*) AS n FROM markers WHERE created_at > ?').get(dayAgo).n;
  const notices = db.prepare('SELECT COUNT(*) AS n FROM notices').get().n;
  const reportsOpen = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
  const byServer = db.prepare(`
    SELECT u.server_key AS key, s.name, s.color, COUNT(*) AS n
    FROM markers m JOIN users u ON u.id = m.user_id LEFT JOIN servers s ON s.key = u.server_key
    WHERE m.visible = 1 GROUP BY u.server_key ORDER BY n DESC
  `).all();
  const recentUsers = db.prepare(`
    SELECT u.id, u.nickname, u.server_key, s.name AS server_name, u.city_name, u.created_at, u.role
    FROM users u LEFT JOIN servers s ON s.key = u.server_key
    ORDER BY u.created_at DESC LIMIT 8
  `).all();
  const recentMarkers = db.prepare(`
    SELECT m.id, m.kind, m.label, m.created_at, u.nickname
    FROM markers m JOIN users u ON u.id = m.user_id
    ORDER BY m.created_at DESC LIMIT 8
  `).all();
  return { markers, users, newUsers, newMarkers, notices, reportsOpen, byServer, recentUsers, recentMarkers };
}

export function adminListUsers({ q = '', page = 1, size = 20 } = {}) {
  const like = `%${q}%`;
  const where = q ? 'WHERE nickname LIKE ? OR email LIKE ? OR id LIKE ?' : '';
  const params = q ? [like, like, like] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...params).n;
  const rows = db.prepare(`
    SELECT u.*, s.name AS server_name,
      (SELECT COUNT(*) FROM markers m WHERE m.user_id = u.id AND m.visible = 1) AS marker_count
    FROM users u LEFT JOIN servers s ON s.key = u.server_key
    ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, size, (page - 1) * size);
  return { total, page, size, rows };
}

export function adminSetUser(id, patch) {
  const fields = [];
  const values = [];
  if (patch.role && ['user', 'admin', 'site_admin'].includes(patch.role)) { fields.push('role = ?'); values.push(patch.role); }
  if (patch.banned !== undefined) { fields.push('banned = ?'); values.push(patch.banned ? 1 : 0); }
  if (!fields.length) return null;
  values.push(id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT id, nickname, role, banned FROM users WHERE id = ?').get(id);
}

export function adminListMarkers({ q = '', server = '', page = 1, size = 20 } = {}) {
  const conds = [];
  const params = [];
  if (q) { conds.push('(u.nickname LIKE ? OR m.label LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (server) { conds.push('u.server_key = ?'); params.push(server); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM markers m JOIN users u ON u.id = m.user_id ${where}
  `).get(...params).n;
  const rows = db.prepare(`
    SELECT m.*, u.nickname, u.server_key, s.name AS server_name
    FROM markers m JOIN users u ON u.id = m.user_id LEFT JOIN servers s ON s.key = u.server_key
    ${where}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, size, (page - 1) * size);
  return { total, page, size, rows };
}

export function adminDeleteMarker(id) {
  const info = db.prepare('DELETE FROM markers WHERE id = ?').run(id);
  return info.changes > 0;
}

export function adminListReports() {
  return db.prepare(`
    SELECT r.*,
           u.nickname AS reporter,
           m.label AS target_marker_label,
           m.kind AS target_marker_kind,
           m.lat AS target_lat,
           m.lng AS target_lng,
           t.id AS target_user_id,
           t.nickname AS target_nickname,
           t.banned AS target_banned,
           t.server_key AS target_server_key,
           s.name AS target_server_name
    FROM reports r
    LEFT JOIN users u ON u.id = r.from_user
    LEFT JOIN markers m ON m.id = r.target_id AND r.target_type = 'marker'
    LEFT JOIN users t ON t.id = m.user_id
    LEFT JOIN servers s ON s.key = t.server_key
    ORDER BY r.created_at DESC LIMIT 100
  `).all();
}

/** 管理台：单个用户的资料 + 他的标记 + 被举报次数 */
export function adminGetUser(id) {
  const u = db.prepare(`
    SELECT u.id, u.nickname, u.email, u.server_key, s.name AS server_name,
           u.city_name, u.role, u.banned, u.created_at, u.last_seen, u.uid_game, u.uid_public
    FROM users u LEFT JOIN servers s ON s.key = u.server_key
    WHERE u.id = ?
  `).get(id);
  if (!u) return null;
  const markers = db.prepare(`
    SELECT id, kind, lat, lng, label, created_at FROM markers
    WHERE user_id = ? ORDER BY created_at DESC
  `).all(id);
  const reportCount = db.prepare(`
    SELECT COUNT(*) AS n FROM reports r
    JOIN markers m ON m.id = r.target_id
    WHERE m.user_id = ?
  `).get(id).n;
  return { user: u, markers, reportCount };
}

export function adminSetReport(id, status) {
  db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id);
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
}

export function adminDeleteNotice(id) {
  return db.prepare('DELETE FROM notices WHERE id = ?').run(id).changes > 0;
}

export function adminUpdateNotice(id, patch) {
  const fields = [];
  const values = [];
  if (patch.title !== undefined) { fields.push('title = ?'); values.push(String(patch.title).slice(0, 60)); }
  if (patch.body !== undefined) { fields.push('body = ?'); values.push(String(patch.body).slice(0, 2000)); }
  if (patch.level !== undefined && ['info', 'warn', 'important'].includes(patch.level)) { fields.push('level = ?'); values.push(patch.level); }
  if (patch.pinned !== undefined) { fields.push('pinned = ?'); values.push(patch.pinned ? 1 : 0); }
  if (patch.expiresAt !== undefined) { fields.push('expires_at = ?'); values.push(patch.expiresAt || null); }
  if (!fields.length) return null;
  values.push(id);
  db.prepare(`UPDATE notices SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
}

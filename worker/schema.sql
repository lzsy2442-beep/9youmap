-- 9友地图 · D1 数据库结构
-- 部署：npx wrangler d1 execute jiuyoumap --remote --file=worker/schema.sql
-- 本地：npx wrangler d1 execute jiuyoumap --local --file=worker/schema.sql

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
  bio_public INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
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

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT, target_id TEXT, reason TEXT, detail TEXT DEFAULT '',
  from_user TEXT, status TEXT DEFAULT 'open', created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_markers_seq ON markers(seq);
CREATE INDEX IF NOT EXISTS idx_markers_user ON markers(user_id);
CREATE INDEX IF NOT EXISTS idx_touches_to ON touches(to_marker);
CREATE INDEX IF NOT EXISTS idx_consents_user ON consents(user_id, doc_type, created_at);
CREATE INDEX IF NOT EXISTS idx_markers_geo ON markers(lat, lng);

INSERT OR REPLACE INTO servers (key,name,short,region,color,sort,active,note) VALUES
 ('official','官服','官','cn_official','#B08A4F',10,1,'官方大区 · iOS/Android 互通'),
 ('bilibili','B 服','B','cn_channel','#7FA8C9',20,1,'Bilibili 应用中心'),
 ('huawei','华为服','华','cn_channel','#C08585',30,1,'华为应用市场'),
 ('harmony','鸿蒙服','鸿','cn_channel','#8FA9C4',35,1,'鸿蒙应用商店'),
 ('xiaomi','小米服','米','cn_channel','#D09A6A',40,1,'小米应用商店'),
 ('vivo','vivo 服','V','cn_channel','#8FB8B0',50,1,'vivo 应用商店'),
 ('oppo','OPPO 服','O','cn_channel','#9BB58F',60,1,'OPPO 应用商店'),
 ('tencent','应用宝服','应','cn_channel','#A99BC0',70,1,'应用宝'),
 ('4399','4399 服','4','cn_channel','#C2A878',80,1,'4399 游戏中心');

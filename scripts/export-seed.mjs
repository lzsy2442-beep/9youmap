// 把本地 SQLite 里的示例数据导出成 D1 可用的 seed.sql
// 用法：node scripts/export-seed.mjs
// 产出：worker/seed.sql（可重复执行，用 INSERT OR IGNORE）
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(join(ROOT, 'data', 'app.db'), { readOnly: true });

const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

const lines = [
  '-- 9友地图 · 示例数据（由 scripts/export-seed.mjs 生成）',
  '-- 用法：npx wrangler d1 execute jiuyoumap --remote --file=worker/seed.sql',
  '-- 或者在 Cloudflare 控制台的 D1 查询窗口里整段粘贴执行',
  ''
];

// 只导出演示账号（is_seed = 1），不要真实用户
const users = db.prepare('SELECT * FROM users WHERE is_seed = 1 ORDER BY id').all();
lines.push(`-- 演示账号 ${users.length} 个`);
for (const u of users) {
  lines.push(
    `INSERT OR IGNORE INTO users (id,email,nickname,avatar,bio,fav_char,server_key,city_code,city_name,uid_game,uid_public,precision,role,banned,is_seed,created_at,last_seen) VALUES (` +
    [q(u.id), 'NULL', q(u.nickname), q(u.avatar), q(u.bio), q(u.fav_char), q(u.server_key),
      q(u.city_code), q(u.city_name), q(u.uid_game), u.uid_public, q(u.precision), q(u.role),
      u.banned, 1, q(u.created_at), q(u.last_seen)].join(',') + ');'
  );
}

const markers = db.prepare(`
  SELECT m.* FROM markers m JOIN users u ON u.id = m.user_id
  WHERE u.is_seed = 1 ORDER BY m.seq
`).all();
lines.push('');
lines.push(`-- 演示标记 ${markers.length} 个`);
for (const m of markers) {
  lines.push(
    `INSERT OR IGNORE INTO markers (id,user_id,kind,lat,lng,label,visible,created_at,moved_at,seq) VALUES (` +
    [q(m.id), q(m.user_id), q(m.kind), m.lat, m.lng, q(m.label), m.visible, q(m.created_at), q(m.moved_at), m.seq].join(',') + ');'
  );
}

const notices = db.prepare('SELECT * FROM notices ORDER BY id').all();
lines.push('');
lines.push(`-- 公告 ${notices.length} 条`);
for (const n of notices) {
  lines.push(
    `INSERT OR IGNORE INTO notices (id,title,body,level,pinned,created_at,expires_at) VALUES (` +
    [n.id, q(n.title), q(n.body), q(n.level), n.pinned, q(n.created_at), q(n.expires_at)].join(',') + ');'
  );
}

const out = join(ROOT, 'worker', 'seed.sql');
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`已导出：${out}`);
console.log(`  演示账号 ${users.length} 个、标记 ${markers.length} 个、公告 ${notices.length} 条`);

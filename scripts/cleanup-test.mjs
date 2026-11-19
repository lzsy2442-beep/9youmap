// 清理测试账号：删掉邮箱为 @example.com / @9you.test 的账号及其数据
// 用法：node scripts/cleanup-test.mjs [--dry]
import { db } from '../server/db.js';

const dry = process.argv.includes('--dry');
const KEEP = new Set(['admin@9you.test']);

const targets = db.prepare(`
  SELECT id, nickname, email FROM users
  WHERE (email LIKE '%@example.com' OR email LIKE '%@9you.test')
`).all().filter((u) => !KEEP.has(u.email) && !u.email?.startsWith('seed-'));

if (!targets.length) {
  console.log('没有需要清理的测试账号。');
  process.exit(0);
}

console.log(`找到 ${targets.length} 个测试账号：`);
targets.forEach((u) => console.log(`  ${u.nickname}  ${u.email}`));

if (dry) {
  console.log('\n（--dry 模式，未实际删除）');
  process.exit(0);
}

const delMarkers = db.prepare('DELETE FROM markers WHERE user_id = ?');
const delTouches = db.prepare('DELETE FROM touches WHERE from_user = ? OR to_user = ?');
const delFriends = db.prepare('DELETE FROM friends WHERE a = ? OR b = ?');
const delConsents = db.prepare('DELETE FROM consents WHERE user_id = ?');
const delUser = db.prepare('DELETE FROM users WHERE id = ?');

let markers = 0;
for (const u of targets) {
  markers += delMarkers.run(u.id).changes;
  delTouches.run(u.id, u.id);
  delFriends.run(u.id, u.id);
  delConsents.run(u.id);
  delUser.run(u.id);
}
console.log(`\n已删除 ${targets.length} 个账号、${markers} 个标记。`);

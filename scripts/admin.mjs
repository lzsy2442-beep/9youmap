// 管理账号：把某个人提升为管理员 / 降级 / 列出所有管理员
//
// 用法：
//   node scripts/admin.mjs promote <邮箱或昵称>
//   node scripts/admin.mjs demote  <邮箱或昵称>
//   node scripts/admin.mjs list
//
// 提示：也可以启动服务时设置 ADMIN_EMAIL=你的邮箱，会自动把该账号设为站长。

const { promoteUser, countAdmins } = await import('../server/db.js');
const { db } = await import('../server/db.js');

const [cmd, who] = process.argv.slice(2);

if (cmd === 'list') {
  const rows = db.prepare("SELECT nickname, email, role FROM users WHERE role != 'user' ORDER BY role DESC, nickname").all();
  if (!rows.length) {
    console.log('还没有管理员。用 node scripts/admin.mjs promote <邮箱或昵称> 添加一个。');
  } else {
    rows.forEach((u) => console.log(`  ${u.role.padEnd(10)} ${u.nickname.padEnd(12)} ${u.email || '(无邮箱)'}`));
  }
  process.exit(0);
}

if (cmd !== 'promote' && cmd !== 'demote') {
  console.error('用法:');
  console.error('  node scripts/admin.mjs promote <邮箱或昵称>');
  console.error('  node scripts/admin.mjs demote  <邮箱或昵称>');
  console.error('  node scripts/admin.mjs list');
  process.exit(1);
}

if (!who) {
  console.error('请给出邮箱或昵称');
  process.exit(1);
}

const isPromote = cmd === 'promote';
const role = isPromote ? 'site_admin' : 'user';
const user = promoteUser(who, role);

if (!user) {
  console.error(`找不到账号：${who}`);
  console.error('先用该邮箱在地图上注册，再执行这条命令。');
  process.exit(1);
}

console.log(`${isPromote ? '已提升' : '已降级'}：${user.nickname} → ${role}`);
console.log(`当前共有 ${countAdmins()} 个管理员。`);
console.log('现在可以打开 http://127.0.0.1:3000/admin 了。');

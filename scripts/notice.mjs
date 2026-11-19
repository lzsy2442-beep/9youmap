// 发布一条公告
// 用法：
//   node scripts/notice.mjs "标题" "正文"
//   node scripts/notice.mjs "维护通知" "今晚 23:00 停服 30 分钟" --level warn --pin
//   node scripts/notice.mjs "活动" "..." --expire 2026-12-01T00:00:00Z
//
// level: info（默认） | warn | important

const args = process.argv.slice(2);
const positional = [];
let level = 'info';
let pin = false;
let expire = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--level') level = args[++i] || 'info';
  else if (a === '--pin') pin = true;
  else if (a === '--expire') expire = args[++i] || null;
  else positional.push(a);
}

const [title, body] = positional;
if (!title || !body) {
  console.error('用法: node scripts/notice.mjs "标题" "正文" [--level warn] [--pin] [--expire ISO时间]');
  process.exit(1);
}
if (!['info', 'warn', 'important'].includes(level)) {
  console.error('level 只能是 info / warn / important');
  process.exit(1);
}

// 动态引入，避免在参数错误时也去建库
const { addNotice } = await import('../server/db.js');
const notice = addNotice({
  title: title.slice(0, 60),
  body: body.slice(0, 2000),
  level,
  pinned: pin ? 1 : 0,
  expiresAt: expire
});

console.log(`已发布 #${notice.id} [${notice.level}] ${notice.title}`);
console.log(notice.pinned ? '（已置顶）' : '');
console.log(`时间：${notice.created_at}`);

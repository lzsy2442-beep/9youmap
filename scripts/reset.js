// 清空本地数据库（下次启动会重新写入示例数据）
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'data');
const files = ['app.db', 'app.db-wal', 'app.db-shm'];
let removed = 0;
for (const f of files) {
  const p = join(dir, f);
  if (existsSync(p)) { rmSync(p, { force: true }); removed++; console.log('删除', p); }
}
console.log(removed ? '已重置，重新启动即可生成示例数据。' : '没有找到数据库文件，本来就是干净的。');

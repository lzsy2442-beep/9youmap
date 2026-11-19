// SQLite 备份：用 VACUUM INTO 生成一致性快照，可在服务运行时执行
// 用法：node scripts/backup.mjs [输出目录]
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { db, DB_PATH } from '../server/db.js';

const dir = resolve(process.argv[2] || 'backups');
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = join(dir, `app-${stamp}.db`);

// 路径里的单引号要转义，否则 SQL 语法错误
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const size = statSync(target).size;
console.log(`已备份 ${DB_PATH}`);
console.log(`  → ${target}（${(size / 1024).toFixed(0)} KB）`);
console.log('恢复方法：停掉服务，把该文件覆盖回 data/app.db，再启动。');

// Node 运行时配置：路径、本地私密配置、法律文本哈希
// 与运行时无关的常量（渠道服、限额、法律文件清单）在 constants.js，Worker 也共用那份。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LEGAL_DOCS } from './constants.js';

export {
  SITE_NAME, SITE_TAGLINE, SERVERS, SERVER_MAP, LIMITS,
  CHINA_BBOX, REQUIRED_CONSENTS, DOC_VERSION, LEGAL_DOCS
} from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const DATA_DIR = join(ROOT, 'data');
export const LEGAL_DIR = join(ROOT, 'docs', 'legal');

// 本地私密配置（不进版本库）：data/local.json，例如 { "tdtTk": "xxxx" }
let LOCAL = {};
try {
  LOCAL = JSON.parse(readFileSync(join(DATA_DIR, 'local.json'), 'utf8'));
} catch { LOCAL = {}; }

export const PORT = Number(process.env.PORT || LOCAL.port || 3000);
export const HOST = process.env.HOST || '127.0.0.1';

// 天地图 Key：没有 Key 时用「纸面底图」（不画任何行政边界，仅经纬网 + 城市点）
export const TDT_TK = process.env.TDT_TK || LOCAL.tdtTk || '';
export const DEV_NO_MAIL = process.env.DEV_NO_MAIL !== '0';

// 启动时算一次法律文本哈希，作为 consent 的举证依据
export const DOC_HASHES = new Map();
for (const d of LEGAL_DOCS) {
  const p = join(LEGAL_DIR, d.file);
  const hash = existsSync(p)
    ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
    : 'missing';
  DOC_HASHES.set(d.slug, hash);
}

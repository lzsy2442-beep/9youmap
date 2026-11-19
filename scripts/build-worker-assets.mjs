// 把「运行时读文件」的东西打包成 JS 模块，供 Cloudflare Worker 直接 import
// 用法：node scripts/build-worker-assets.mjs
// 产出：worker/data-regions.js、worker/data-legal.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'worker');
mkdirSync(OUT, { recursive: true });

// ── 行政区划 ────────────────────────────────────────────────
const regionsRaw = readFileSync(join(ROOT, 'server', 'regions.json'), 'utf8');
const regions = JSON.parse(regionsRaw);
const regionsJs = `// 由 scripts/build-worker-assets.mjs 生成，请勿手改
export const REGIONS = ${JSON.stringify(regions)};
`;
writeFileSync(join(OUT, 'data-regions.js'), regionsJs, 'utf8');
console.log(`data-regions.js  ${(regionsJs.length / 1024).toFixed(0)} KB`);

// ── 法律文本 ────────────────────────────────────────────────
const legalFiles = {
  terms: '01-用户协议.md',
  privacy: '02-隐私政策.md',
  inventory: '03-个人信息收集与用途清单.md',
  disclaimer: '04-免责声明.md',
  community: '05-社区规范.md'
};

const texts = {};
const hashes = {};
for (const [slug, file] of Object.entries(legalFiles)) {
  const raw = readFileSync(join(ROOT, 'docs', 'legal', file));
  texts[slug] = raw.toString('utf8');
  hashes[slug] = createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

const legalJs = `// 由 scripts/build-worker-assets.mjs 生成，请勿手改
export const LEGAL_TEXT = ${JSON.stringify(texts)};
export const LEGAL_HASHES = ${JSON.stringify(hashes)};
`;
writeFileSync(join(OUT, 'data-legal.js'), legalJs, 'utf8');
console.log(`data-legal.js    ${(legalJs.length / 1024).toFixed(0)} KB`);
console.log('完成：改过法律文本或行政区划后，需要重新跑一次这个脚本再部署。');

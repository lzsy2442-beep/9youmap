// 本地跑 Worker：用 node:sqlite 模拟 D1，用 node:http 模拟 Cloudflare 的边缘，
// 这样在没装 wrangler 的情况下也能验证 worker/index.js 的完整链路。
// 用法：node scripts/worker-dev.mjs [port]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.argv[2] || 3001);

// ── D1 模拟 ────────────────────────────────────────────────
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = OFF');

class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : a)); return this; }
  async first(col) {
    const row = sqlite.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return col ? row[col] : row;
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.args) };
  }
  async run() {
    const info = sqlite.prepare(this.sql).run(...this.args);
    return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}

const DB = {
  prepare(sql) { return new Stmt(sql); },
  async exec(sql) { sqlite.exec(sql); return { count: 0 }; },
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
};

// ── ASSETS 模拟 ────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.webp': 'image/webp'
};

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let p = normalize(url.pathname).replace(/^([/\\])+/, '');
    if (p === '' || p === '/') p = 'index.html';
    if (p === 'admin' || p === 'admin/') p = 'admin.html';
    const full = join(PUBLIC, p);
    if (!full.startsWith(PUBLIC)) return new Response('forbidden', { status: 403 });
    try {
      const st = await stat(full);
      if (!st.isFile()) throw new Error('not a file');
      const buf = await readFile(full);
      return new Response(buf, {
        headers: { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' }
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }
};

// ── 载入 schema ────────────────────────────────────────────
const schema = await readFile(join(ROOT, 'worker', 'schema.sql'), 'utf8');
sqlite.exec(schema);

const env = {
  DB,
  ASSETS,
  SESSION_SECRET: 'local-test-secret',
  ALLOW_DEV_CODE: '1',       // 本地测试才允许把验证码返回给前端
  ADMIN_EMAIL: 'admin@9you.test',
  TDT_TK: ''
};

const { default: worker } = await import('../worker/index.js');

// ── HTTP ↔ Request/Response ────────────────────────────────
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);

  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf
  });

  try {
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('[harness]', err);
    res.writeHead(500);
    res.end('harness error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Worker 本地模拟已启动：http://127.0.0.1:${PORT}`);
  console.log('（D1 用 node:sqlite 内存库模拟；重启即清空数据）');
});

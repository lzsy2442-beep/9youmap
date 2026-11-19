# Cloudflare 免费部署（Workers + D1）

> 目标：用 Cloudflare 的免费额度把 9友地图 跑起来，**月成本 ¥0**。
> 代价：后端从 Node 换到 Workers 运行时，代码在 `worker/` 目录（与 `server/` 并存，本地仍可继续用 Node 版本）。

---

## 一、先看免费额度够不够

| 资源 | 免费额度（以官网为准） | 说明 |
|---|---|---|
| Workers 请求 | 10 万次/天 | 3000 日活 × 20 请求 ≈ 6 万，够 |
| D1 存储 | 5 GB | 一个点位约 200 字节，能存几百万 |
| D1 读 | 500 万行/天 | 首屏拉全量点位是主要消耗 |
| 静态资源 | 不限量 | `public/` 由边缘直接返回 |
| 出站流量 | 不限量 | — |

超过免费额度后 Workers 是 $5/月（含 1000 万请求）。对同人站来说基本等于永久免费。

---

## 二、一次性准备

```bash
# 1. 装 wrangler（本地开发依赖，不影响线上）
npm i -D wrangler

# 2. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 3. 建 D1 数据库，记下返回的 database_id
npx wrangler d1 create jiuyoumap

# 4. 把 database_id 填进 wrangler.jsonc
```

---

## 三、初始化数据库

```bash
# 远程（线上库）
npx wrangler d1 execute jiuyoumap --remote --file=worker/schema.sql

# 本地（wrangler dev 用）
npx wrangler d1 execute jiuyoumap --local --file=worker/schema.sql
```

`schema.sql` 里已经包含 9 个渠道服的基础数据。

想要示例点位（30 个演示账号）的话，先在本机 Node 版本里跑出数据，再导出：

```bash
node scripts/reset.js          # 重置本地 SQLite 并写入示例数据
# 然后用 D1 的 .dump 或自己的脚本导入；不想折腾可以直接跳过，站点空着也能用
```

---

## 四、设置密钥

```bash
npx wrangler secret put SESSION_SECRET   # 随便一串 32 字节以上的随机值
npx wrangler secret put RESEND_API_KEY   # 邮件（见下）
```

`wrangler.jsonc` 里的 `vars` 直接填：

```jsonc
"vars": {
  "TDT_TK": "你的天地图Key",
  "ADMIN_EMAIL": "你的邮箱@example.com"
}
```

---

## 五、邮件（Workers 上没有 SMTP）

Cloudflare 不能直连 SMTP 端口，所以走 HTTP 邮件 API。二选一：

**方案 A：Resend（最省事）**

1. https://resend.com 注册，创建 API Key；
2. 验证你的发信域名（或者用它的测试域名先跑）；
3. `npx wrangler secret put RESEND_API_KEY`；
4. `vars.MAIL_FROM` 填 `9友地图 <no-reply@你的域名>`。

**方案 B：自建邮件网关**

任意一个能收 JSON 的 HTTP 接口即可：

```bash
npx wrangler secret put MAIL_API_URL     # https://your-gateway/send
npx wrangler secret put MAIL_API_TOKEN   # 可选
```

请求体是 `{ to, subject, text }`。

> ⚠️ **两个都没配时**：Worker 会拒绝发码并返回 `502`（不会退化成"把验证码返回给前端"）。
> 只有显式设置 `ALLOW_DEV_CODE=1` 才会返回 `devCode`，仅供本地调试。

---

## 六、部署

```bash
# 改了法律文本或行政区划后，先重新打包数据
node scripts/build-worker-assets.mjs

npx wrangler deploy
```

输出会给你一个 `https://jiuyoumap.<你的子域>.workers.dev`。

绑定自己的域名：Cloudflare 控制台 → Workers → 你的项目 → Settings → Domains & Routes → Add custom domain。证书自动。

---

## 七、本地跑一遍（不装 wrangler 也行）

我写了一个本地模拟器：用 `node:sqlite` 模拟 D1、用 `node:http` 模拟边缘，直接执行 `worker/index.js`。

```bash
node scripts/worker-dev.mjs 3001
# → http://127.0.0.1:3001
```

这样在提交部署之前就能验证接口、静态页、管理后台。

---

## 八、两种运行时的差异

| | Node（`server/`） | Worker（`worker/`） |
|---|---|---|
| 数据库 | `node:sqlite` 文件 | D1 |
| 会话 | `node:crypto` HMAC | WebCrypto |
| 邮件 | SMTP（465/587） | HTTP API（Resend / 自建） |
| 实时 | SSE 真广播 | **降级**：`/api/stream` 每 60 秒让浏览器重连一次，等于准轮询 |
| 限流 | 进程内计数，准确 | 每个 isolate 内存，**跨实例不共享**（尽力而为，真正防刷要上 Durable Object 或 Turnstile） |
| 法律文本 / 行政区划 | 运行时读文件 | 构建时打包成 JS（`scripts/build-worker-assets.mjs`） |
| 静态文件 | Node 自己发 | Cloudflare Assets |

### 已知限制

1. **实时性下降**：别人落点后你要刷新或等一分钟才看到。人少的时候无所谓。
2. **限流不严格**：同一 IP 可能绕过（多个 isolate）。要更严可以加 Cloudflare Turnstile 或 WAF 规则。
3. **D1 没有事务跨请求**：写操作各自独立，够用；真要做强一致得上 Durable Objects。
4. **首次请求冷启动**：几十毫秒，可忽略。

---

## 九、更新流程

```bash
# 改了后端
npx wrangler deploy

# 只改了静态文件（public/）
npx wrangler deploy        # 仍然要 deploy 一次，但不会动数据库

# 改了法律文本 / 行政区划
node scripts/build-worker-assets.mjs && npx wrangler deploy
```

数据库结构变更：把新的 `ALTER TABLE` 写进一个新文件，执行
`npx wrangler d1 execute jiuyoumap --remote --file=worker/migrations/xxx.sql`。

---

## 十、回滚

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

D1 数据不会跟着回滚——所以结构变更前先导出：

```bash
npx wrangler d1 export jiuyoumap --remote --output=backup.sql
```

---

## 十一、和"免费云主机"怎么选

| | Cloudflare | 免费云主机（Oracle/学生机） |
|---|---|---|
| 成本 | ¥0 | ¥0–99/年 |
| 运维 | 几乎不用 | 要打补丁、看日志、配防火墙 |
| 速度（国内） | 一般（可开 Argo 优化） | 境内机快，需备案 |
| 上手难度 | 要装 wrangler、懂点 Cloudflare | 照文档敲命令即可 |
| 实时/长连接 | 弱 | 强 |
| 代码改动 | 已适配好（`worker/`） | 无 |

**建议**：先用云主机跑（`server/`，功能全），把 Cloudflare 这条当作"以后不想管服务器了"的退路——代码已经就绪。

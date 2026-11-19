// 会话与验证码：HMAC 签名 Cookie、scrypt、一次性验证码
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, LIMITS } from './config.js';

const KEY_FILE = join(DATA_DIR, 'session.key');
let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(KEY_FILE)) SECRET = readFileSync(KEY_FILE, 'utf8').trim();
  else {
    SECRET = randomBytes(32).toString('hex');
    writeFileSync(KEY_FILE, SECRET, { mode: 0o600 });
  }
}

const COOKIE = 'sid';
const MAX_AGE = 30 * 24 * 3600; // 30 天

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function hmac(data) {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function issueSession(userId) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = b64url(JSON.stringify({ u: userId, e: exp }));
  const token = `${payload}.${hmac(payload)}`;
  return {
    token,
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`
  };
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSession(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expect = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.e || data.e < Math.floor(Date.now() / 1000)) return null;
    return data.u;
  } catch {
    return null;
  }
}

// ── 验证码 ──────────────────────────────────────────────────
export function hashCode(email, code) {
  return createHash('sha256').update(`${email}|${code}|${SECRET}`).digest('hex');
}

export function newCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

import { sendMail, smtpConfigFromEnv } from './mail.js';

const SMTP = smtpConfigFromEnv();

export const mailConfigured = () => !!SMTP;

export async function sendCodeMail(email, code) {
  if (!SMTP) {
    // 没配 SMTP：验证码只写日志 + 由接口返回给前端（仅限本地开发）
    console.log(`[mail] ${email} -> 验证码 ${code}（未配置 SMTP，开发模式）`);
    return { delivered: false, dev: true };
  }
  await sendMail({
    ...SMTP,
    to: email,
    subject: '9友地图 · 登录验证码',
    text: [
      `你的验证码是 ${code}，5 分钟内有效。`,
      '',
      '如果这不是你本人的操作，忽略这封邮件即可，你的邮箱不会被注册。',
      '',
      '—— 9友地图（非官方同人项目）'
    ].join('\n')
  });
  console.log(`[mail] ${email} 已发送`);
  return { delivered: true, dev: false };
}

export const CODE_TTL = LIMITS.codeTtlSec;
export const CODE_COOLDOWN = LIMITS.codeCooldownSec;
export const MAX_TRIES = LIMITS.codeMaxTries;

// Worker 端会话与哈希：用 WebCrypto，不依赖 node:crypto
const enc = new TextEncoder();

function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const keyCache = new Map();
async function hmacKey(secret) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache.set(secret, key);
  return key;
}

async function hmac(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlFromBytes(sig);
}

const COOKIE = 'sid';
const MAX_AGE = 30 * 24 * 3600;

export async function issueSession(secret, userId, { secure = true } = {}) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = b64urlFromBytes(enc.encode(JSON.stringify({ u: userId, e: exp })));
  const token = `${payload}.${await hmac(secret, payload)}`;
  // 只有 https 才加 Secure：本地 http 调试时加了会导致 Cookie 不被回传
  return {
    token,
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`
  };
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function readSession(secret, request) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expect = await hmac(secret, payload);
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(bytesFromB64url(payload)));
    if (!data.e || data.e < Math.floor(Date.now() / 1000)) return null;
    return data.u;
  } catch {
    return null;
  }
}

export async function hashCode(secret, email, code) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${email}|${code}|${secret}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

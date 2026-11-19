// 极简 SMTP 客户端（零依赖）：465 直连 TLS / 587 STARTTLS + AUTH LOGIN
// 目标：不引入 nodemailer 也能在正式环境把验证码发出去。
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/**
 * SMTP 响应读取：服务端可能返回多行
 *   250-xxx
 *   250 yyy
 * 只有「三位数字 + 空格」那一行才是结束。
 */
function createReader(socket) {
  let buffer = '';
  let current = [];
  const queue = [];
  const waiters = [];
  let fatal = null;

  const pump = () => {
    while (waiters.length && queue.length) {
      waiters.shift()({ ok: true, resp: queue.shift() });
    }
    if (fatal) {
      while (waiters.length) waiters.shift()({ ok: false, error: fatal });
    }
  };

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf(CRLF)) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      current.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        queue.push({ code: Number(line.slice(0, 3)), lines: current, raw: current.join('\n') });
        current = [];
      }
    }
    pump();
  });
  socket.on('error', (err) => { fatal = err; pump(); });
  socket.on('close', () => { fatal = fatal || new Error('SMTP 连接被关闭'); pump(); });

  return {
    read(timeoutMs = 15000) {
      if (queue.length) return Promise.resolve({ ok: true, resp: queue.shift() });
      if (fatal) return Promise.resolve({ ok: false, error: fatal });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(fn);
          if (i >= 0) waiters.splice(i, 1);
          resolve({ ok: false, error: new Error('SMTP 响应超时') });
        }, timeoutMs);
        const fn = (result) => { clearTimeout(timer); resolve(result); };
        waiters.push(fn);
      });
    }
  };
}

function connect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
    socket.setTimeout(20000, () => socket.destroy(new Error('SMTP 连接超时')));
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => resolve(t));
    t.once('error', reject);
  });
}

export async function sendMail({ host, port, secure, user, pass, from, to, subject, text, allowPlain = false }) {
  let socket = await connect({ host, port, secure });
  let reader = createReader(socket);

  const write = (line) => socket.write(line + CRLF);
  const step = async (want, label) => {
    const r = await reader.read();
    if (!r.ok) throw new Error(`SMTP ${label} 失败：${r.error.message}`);
    if (r.resp.code !== want) throw new Error(`SMTP ${label} 失败：${r.resp.raw}`);
    return r.resp;
  };

  try {
    await step(220, '握手');

    write('EHLO jiuyoumap');
    const ehlo = await step(250, 'EHLO');

    if (!secure) {
      const supportsStartTls = /STARTTLS/i.test(ehlo.raw);
      if (supportsStartTls) {
        write('STARTTLS');
        await step(220, 'STARTTLS');
        socket = await upgradeToTls(socket, host);
        reader = createReader(socket);
        write('EHLO jiuyoumap');
        await step(250, 'EHLO(TLS)');
      } else if (!allowPlain) {
        throw new Error('SMTP 服务端未提供 STARTTLS，已中止（如为本地测试可设 SMTP_ALLOW_PLAIN=1）');
      }
    }

    if (user) {
      write('AUTH LOGIN');
      await step(334, 'AUTH');
      write(b64(user));
      await step(334, 'AUTH 用户名');
      write(b64(pass));
      await step(235, 'AUTH 密码');
    }

    write(`MAIL FROM:<${from}>`);
    await step(250, 'MAIL FROM');
    write(`RCPT TO:<${to}>`);
    const rcpt = await reader.read();
    if (!rcpt.ok) throw new Error(`SMTP RCPT 失败：${rcpt.error.message}`);
    if (rcpt.resp.code !== 250 && rcpt.resp.code !== 251) throw new Error(`SMTP RCPT 失败：${rcpt.resp.raw}`);

    write('DATA');
    await step(354, 'DATA');

    const payload = [
      `From: 9友地图 <${from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@${from.split('@')[1] || 'localhost'}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`)
    ].join(CRLF);

    socket.write(payload + CRLF + '.' + CRLF);
    await step(250, 'DATA 提交');

    write('QUIT');
    await reader.read(3000).catch(() => {});
    return { ok: true };
  } finally {
    try { socket.end(); } catch { /* 忽略 */ }
  }
}

/** 从环境变量读配置；缺字段返回 null */
export function smtpConfigFromEnv(env = process.env) {
  const host = env.SMTP_HOST;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.MAIL_FROM || user;
  if (!host || !user || !pass || !from) return null;
  const port = Number(env.SMTP_PORT || (env.SMTP_SECURE === '0' ? 587 : 465));
  const secure = env.SMTP_SECURE === '0' ? false : port === 465;
  return { host, port, secure, user, pass, from, allowPlain: env.SMTP_ALLOW_PLAIN === '1' };
}

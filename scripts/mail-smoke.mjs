// 用一个假 SMTP 服务端验证客户端协议：握手 → EHLO → AUTH LOGIN → DATA
import net from 'node:net';
import { sendMail } from '../server/mail.js';

const received = [];

const server = net.createServer((socket) => {
  let inData = false;
  let dataLines = [];
  let authStep = 0;

  socket.write('220 fake.local ESMTP\r\n');

  socket.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\r\n')) {
      if (inData) {
        if (line === '.') {
          inData = false;
          received.push(dataLines.join('\n'));
          dataLines = [];
          socket.write('250 2.0.0 queued\r\n');
        } else {
          dataLines.push(line);
        }
        continue;
      }
      if (!line) continue;
      if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
      if (authStep === 2) { authStep = 0; socket.write('235 2.7.0 Authentication successful\r\n'); continue; }
      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO')) {
        socket.write('250-fake.local\r\n250-SIZE 10240000\r\n250 AUTH LOGIN\r\n');
      } else if (cmd.startsWith('AUTH LOGIN')) {
        authStep = 1;
        socket.write('334 VXNlcm5hbWU6\r\n');
      } else if (cmd.startsWith('MAIL FROM')) {
        socket.write('250 2.1.0 Ok\r\n');
      } else if (cmd.startsWith('RCPT TO')) {
        socket.write('250 2.1.5 Ok\r\n');
      } else if (cmd === 'DATA') {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (cmd === 'QUIT') {
        socket.write('221 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 Ok\r\n');
      }
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`假 SMTP 服务端监听 127.0.0.1:${port}`);

const result = await sendMail({
  host: '127.0.0.1',
  port,
  secure: false,
  allowPlain: true,
  user: 'bot@example.com',
  pass: 'secret',
  from: 'bot@example.com',
  to: 'user@example.com',
  subject: '9友地图 · 登录验证码',
  text: '你的验证码是 123456，5 分钟内有效。'
});

console.log('sendMail:', JSON.stringify(result));
console.log('收到 message 数据行数:', received.length);

const raw = received[0] || '';
const checks = {
  '有 From 头': /^From: 9友地图/m.test(raw),
  '有 To 头': /^To: <user@example.com>/m.test(raw),
  '主题用 RFC2047 编码': /^Subject: =\?UTF-8\?B\?/m.test(raw),
  '正文 base64': /Content-Transfer-Encoding: base64/.test(raw),
  '正文可解出验证码': Buffer.from(raw.split('\n\n')[1] || '', 'base64').toString('utf8').includes('123456')
};
let ok = result.ok === true;
for (const [k, v] of Object.entries(checks)) { console.log((v ? '✓' : '✗'), k); if (!v) ok = false; }

server.close();
console.log(ok ? '\nSMTP 客户端协议通过' : '\n有失败项');
process.exit(ok ? 0 : 1);

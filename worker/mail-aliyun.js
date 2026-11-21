// 阿里云邮件推送（DirectMail）发信：RPC API + HMAC-SHA1 签名
// 文档：https://help.aliyun.com/zh/direct-mail/developer-reference/api-dm-2015-11-23-singlesendmail
// 特点：境内服务、数据不出境，免费版每天 200 封

const ENC = new TextEncoder();

/** RFC 3986 编码：阿里云签名要求，! ' ( ) * 也要编码，~ 不编码 */
function pe(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmacSha1Base64(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', ENC.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, ENC.encode(message));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 生成带签名的请求体（导出便于单测） */
export async function signRpcQuery(params, accessKeySecret, method = 'POST') {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${pe(k)}=${pe(params[k])}`)
    .join('&');
  const stringToSign = `${method}&${pe('/')}&${pe(canonical)}`;
  const signature = await hmacSha1Base64(`${accessKeySecret}&`, stringToSign);
  return `${canonical}&Signature=${pe(signature)}`;
}

/**
 * 发送一封纯文本邮件
 * @returns {Promise<{ok:true, requestId?:string}>}
 */
export async function sendMailAliyun({
  accessKeyId, accessKeySecret, accountName, to, subject, text, endpoint = 'https://dm.aliyuncs.com/'
}) {
  const params = {
    Action: 'SingleSendMail',
    Version: '2015-11-23',
    Format: 'JSON',
    RegionId: 'cn-hangzhou',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    AccountName: accountName,   // 发信地址，如 no-reply@jiyoumap.top
    AddressType: '1',           // 1 = 随机账号：触发邮件专用，不需要逐个验证发信地址
    ReplyToAddress: 'false',
    ToAddress: to,
    Subject: subject,
    TextBody: text
  };

  const form = await signRpcQuery(params, accessKeySecret, 'POST');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });

  let data = {};
  try { data = await res.json(); } catch { /* 可能返回空体 */ }

  if (!res.ok || data.Code) {
    throw new Error(`Aliyun DirectMail ${res.status}: ${data.Message || data.Code || JSON.stringify(data)}`);
  }
  return { ok: true, requestId: data.RequestId };
}

/** 从环境变量取配置；缺字段返回 null（表示没配） */
export function aliyunMailConfigFromEnv(env) {
  const accessKeyId = env.ALIYUN_DM_AK_ID;
  const accessKeySecret = env.ALIYUN_DM_AK_SECRET;
  const accountName = env.ALIYUN_DM_ACCOUNT || env.MAIL_FROM;
  if (!accessKeyId || !accessKeySecret || !accountName) return null;
  return { accessKeyId, accessKeySecret, accountName };
}

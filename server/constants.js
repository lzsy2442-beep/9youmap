// 运行时无关的常量：Node 与 Cloudflare Worker 共用（不依赖 fs / node:sqlite）

export const SITE_NAME = '9友地图';
export const SITE_TAGLINE = '非官方同人项目 · 与深蓝互动无关';

// 渠道服（国内）。官服 iOS/Android 互通；官服与渠道服、渠道服之间不互通，不能互加好友。
export const SERVERS = [
  { key: 'official',  name: '官服',      short: '官',  region: 'cn_official', color: '#B08A4F', sort: 10, note: '官方大区 · iOS/Android 互通' },
  { key: 'bilibili',  name: 'B 服',      short: 'B',   region: 'cn_channel',  color: '#7FA8C9', sort: 20, note: 'Bilibili 应用中心' },
  { key: 'huawei',    name: '华为服',    short: '华',  region: 'cn_channel',  color: '#C08585', sort: 30, note: '华为应用市场' },
  { key: 'harmony',   name: '鸿蒙服',    short: '鸿',  region: 'cn_channel',  color: '#8FA9C4', sort: 35, note: '鸿蒙应用商店' },
  { key: 'xiaomi',    name: '小米服',    short: '米',  region: 'cn_channel',  color: '#D09A6A', sort: 40, note: '小米应用商店' },
  { key: 'vivo',      name: 'vivo 服',   short: 'V',   region: 'cn_channel',  color: '#8FB8B0', sort: 50, note: 'vivo 应用商店' },
  { key: 'oppo',      name: 'OPPO 服',   short: 'O',   region: 'cn_channel',  color: '#9BB58F', sort: 60, note: 'OPPO 应用商店' },
  { key: 'tencent',   name: '应用宝服',  short: '应',  region: 'cn_channel',  color: '#A99BC0', sort: 70, note: '应用宝' },
  { key: '4399',      name: '4399 服',   short: '4',   region: 'cn_channel',  color: '#C2A878', sort: 80, note: '4399 游戏中心' }
];

export const SERVER_MAP = new Map(SERVERS.map((s) => [s.key, s]));

export const LIMITS = {
  rabbitsPerUser: 3,
  touchesPerDay: 30,
  codeCooldownSec: 60,
  codeTtlSec: 300,
  codeMaxTries: 5,
  codePerHourPerIp: 20
};

// 中国范围（含港澳台）粗边界，落点校验第一道闸
export const CHINA_BBOX = { minLat: 3.5, maxLat: 53.8, minLng: 73.4, maxLng: 135.2 };

export const REQUIRED_CONSENTS = ['terms', 'privacy', 'age14'];
export const DOC_VERSION = 'v1.0';

// 法律文件清单（正文由各自运行时提供：Node 读文件，Worker 用打包的字符串）
export const LEGAL_DOCS = [
  { slug: 'terms',      type: 'terms',   title: '用户协议',              file: '01-用户协议.md' },
  { slug: 'privacy',    type: 'privacy', title: '隐私政策',              file: '02-隐私政策.md' },
  { slug: 'inventory',  type: 'privacy', title: '个人信息收集与用途清单', file: '03-个人信息收集与用途清单.md' },
  { slug: 'disclaimer', type: 'terms',   title: '免责声明',              file: '04-免责声明.md' },
  { slug: 'community',  type: 'terms',   title: '社区规范',              file: '05-社区规范.md' }
];

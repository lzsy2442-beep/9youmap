// 用打桩 canvas 在 Node 里跑一遍 PaperMap 的绘制路径，抓运行时错误
import { PaperMap, project, unproject } from '../public/js/map.js';

const calls = [];
const ctxHandler = {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === 'measureText') return () => ({ width: 20 });
    if (String(prop).startsWith('create')) return () => ({ addColorStop: () => {} });
    return (...args) => { calls.push(String(prop)); };
  },
  set(target, prop, value) { target[prop] = value; return true; }
};
const ctx = new Proxy({}, ctxHandler);

const canvas = {
  width: 0, height: 0,
  style: {},
  getContext: () => ctx,
  getBoundingClientRect: () => ({ width: 1440, height: 900, left: 0, top: 0 }),
  addEventListener: () => {},
  setPointerCapture: () => {}
};

globalThis.window = { devicePixelRatio: 2, addEventListener: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class {
  constructor() { this.complete = false; this.naturalWidth = 0; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
};

const cities = [
  { code: '110000', name: '北京', lat: 39.9042, lng: 116.4074 },
  { code: '310000', name: '上海', lat: 31.2304, lng: 121.4737 }
];

const map = new PaperMap(canvas, { cities, center: { lat: 34.2, lng: 108.9 }, zoom: 4 });
map.setMarkers([
  { id: 'a', kind: 'umbrella', lat: 39.9, lng: 116.4, sameServer: true, isMine: false, nickname: '甲' },
  { id: 'b', kind: 'rabbit', lat: 31.23, lng: 121.47, sameServer: false, isMine: true, nickname: '乙' },
  { id: 'c', kind: 'umbrella', lat: 23.12, lng: 113.26, sameServer: true, isMine: false, nickname: '丙' }
]);

// 1) 纸面模式绘制（含聚合）
map._draw();

// 2) 放大到逐个标记的层级
map.flyTo(31.23, 121.47, 8);
map._draw();

// 3) 瓦片模式绘制
map.setTileUrl((z, x, y, layer) => `https://t0.tianditu.gov.cn/${layer}_w/${z}/${x}/${y}`);
map._draw();

// 4) 投影往返
const p = project(31.23, 121.47, 6);
const back = unproject(p.x, p.y, 6);
const ok = Math.abs(back.lat - 31.23) < 1e-6 && Math.abs(back.lng - 121.47) < 1e-6;

// 5) 命中测试
const hit = map._hit(map.toScreen(31.23, 121.47).x, map.toScreen(31.23, 121.47).y);
const hitOk = hit && hit.type === 'marker' && hit.marker.id === 'b';

const ops = new Set(calls);
console.log('绘制调用种类:', ops.size);
console.log('关键绘制原语:', ['fillRect', 'beginPath', 'arc', 'fill', 'drawImage', 'fillText']
  .map((k) => `${k}=${ops.has(k) ? '✓' : '✗'}`).join(' '));
console.log('投影往返:', ok ? '✓' : '✗', JSON.stringify(back));
console.log('命中测试:', hitOk ? '✓' : '✗', JSON.stringify(hit && { type: hit.type, id: hit.marker.id }));
console.log('聚合数(zoom=4):', map.clusters.length);
process.exit(ok && hitOk ? 0 : 1);

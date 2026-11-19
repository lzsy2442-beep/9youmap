// 用真实接口数据校验地图绘制：屏幕上出现多少点、聚合是否生效
import { PaperMap } from '../public/js/map.js';

const calls = [];
const ctx = new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'measureText') return () => ({ width: 20 });
    if (String(p).startsWith('create')) return () => ({ addColorStop: () => {} });
    return (...a) => { calls.push(String(p)); };
  },
  set(t, p, v) { t[p] = v; return true; }
});
const canvas = {
  width: 0, height: 0, style: {},
  getContext: () => ctx,
  getBoundingClientRect: () => ({ width: 1440, height: 900, left: 0, top: 0 }),
  addEventListener: () => {}, setPointerCapture: () => {}
};
globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; } set src(v) { this._s = v; } };

const res = await fetch('http://127.0.0.1:3000/api/map/feed');
const { markers } = await res.json();
console.log('接口返回标记数:', markers.length);

const cities = (await (await fetch('http://127.0.0.1:3000/api/bootstrap')).json()).cities;
const map = new PaperMap(canvas, { cities, center: { lat: 34.2, lng: 108.9 }, zoom: 4 });
map.setMarkers(markers);

for (const z of [4, 5, 6, 8]) {
  map.flyTo(34.2, 108.9, z);
  map._draw();
  const onScreen = markers.filter((m) => {
    const p = map.toScreen(m.lat, m.lng);
    return p.x > -30 && p.x < 1470 && p.y > -30 && p.y < 930;
  }).length;
  console.log(`zoom=${z} 屏幕内标记=${onScreen} 聚合点=${map.clusters.length}`);
}

// 北京附近放大后，逐个标记应能命中
map.flyTo(39.9, 116.4, 9);
map._draw();
const near = map.markers.filter((m) => {
  const p = map.toScreen(m.lat, m.lng);
  return p.x > 0 && p.x < 1440 && p.y > 0 && p.y < 900;
});
console.log('北京放大后可见:', near.length, near.slice(0, 3).map((m) => m.nickname).join(' / '));
const hitCount = near.filter((m) => {
  const p = map.toScreen(m.lat, m.lng);
  const h = map._hit(p.x, p.y);
  return h && h.type === 'marker' && h.marker.id === m.id;
}).length;
console.log(`命中测试: ${hitCount}/${near.length}`);

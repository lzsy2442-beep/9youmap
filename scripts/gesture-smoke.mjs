// 手势打桩测试：双指捏合缩放 / 双击放大 / 单指点击
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

const handlers = new Map();
const canvas = {
  width: 0, height: 0, style: {},
  getContext: () => ctx,
  getBoundingClientRect: () => ({ width: 400, height: 600, left: 0, top: 0 }),
  addEventListener: (type, fn) => { handlers.set(type, fn); },
  setPointerCapture: () => {}
};
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  visualViewport: null
};
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; } set src(v) { this._s = v; } };

let clicked = 0;
let markerClicked = 0;
const map = new PaperMap(canvas, {
  cities: [],
  center: { lat: 34, lng: 108 },
  zoom: 5,
  onClick: () => clicked++,
  onMarkerClick: () => markerClicked++
});
map.setMarkers([]);
map._draw();

const ev = (type, id, x, y, pointerType = 'touch') => {
  const fn = handlers.get(type);
  if (!fn) throw new Error(`没有绑定 ${type}`);
  fn({ pointerId: id, clientX: x, clientY: y, pointerType, preventDefault() {} });
};

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

// ── 1. 双指张开：距离翻倍 → 缩放 +1 ──────────────
const z0 = map.targetZoom;
ev('pointerdown', 1, 150, 300);
ev('pointerdown', 2, 250, 300);
ev('pointermove', 2, 350, 300);          // 距离 100 → 200
check('双指张开后缩放 +1', near(map.targetZoom, z0 + 1, 1e-6), `zoom ${z0} → ${map.targetZoom.toFixed(3)}`);

// ── 2. 双指捏合：距离减半 → 缩放 -1 ──────────────
ev('pointermove', 2, 200, 300);          // 距离 200 → 50
check('双指捏合后缩放变小', map.targetZoom < z0 + 1, `zoom → ${map.targetZoom.toFixed(3)}`);

// ── 3. 抬起后状态复位 ────────────────────────────
ev('pointerup', 1, 150, 300);
ev('pointerup', 2, 200, 300);
check('抬起后 pinch 清空', map.pinch === null);
check('双指操作不触发点击', clicked === 0 && markerClicked === 0, `clicked=${clicked}`);

// ── 4. 双击放大 ─────────────────────────────────
const z1 = map.targetZoom;
ev('pointerdown', 3, 200, 300);
ev('pointerup', 3, 200, 300);
ev('pointerdown', 4, 202, 301);
ev('pointerup', 4, 202, 301);
check('双击放大 +1', near(map.targetZoom, z1 + 1, 1e-6), `zoom ${z1.toFixed(2)} → ${map.targetZoom.toFixed(2)}`);

// ── 5. 单指点击（等防抖窗口过去） ────────────────
const before = clicked;
ev('pointerdown', 5, 60, 60);
ev('pointerup', 5, 60, 60);
await new Promise((r) => setTimeout(r, 320));
check('单指点击落到地图', clicked === before + 1, `clicked=${clicked}`);

// ── 6. 拖拽后不算点击 ────────────────────────────
const before2 = clicked;
ev('pointerdown', 6, 100, 100);
ev('pointermove', 6, 180, 160);
ev('pointerup', 6, 180, 160);
await new Promise((r) => setTimeout(r, 320));
check('拖拽不触发点击', clicked === before2, `clicked=${clicked}`);

const ok = results.every(Boolean);
console.log(ok ? '\n全部通过' : '\n有失败项');
process.exit(ok ? 0 : 1);

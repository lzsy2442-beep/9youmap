// 打桩验证天气粒子的动画循环（不需要浏览器）
const calls = [];
const ctx = new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    return (...a) => { calls.push(String(p)); };
  },
  set(t, p, v) { t[p] = v; return true; }
});

let pending = null;
globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pending = null; };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.document = {
  hidden: false,
  addEventListener: () => {}
};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 2,
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
};

const canvas = {
  width: 0, height: 0, style: {},
  getContext: () => ctx
};

const { createWeatherFx } = await import('../public/js/fx.js');
const fx = createWeatherFx(canvas);

const tick = (frames = 12) => {
  for (let i = 0; i < frames; i++) {
    const cb = pending;
    if (!cb) break;
    pending = null;
    cb(performance.now() + i * 16.7);
  }
};

const count = (name) => calls.filter((c) => c === name).length;

fx.set('rain');
tick();
const rainStrokes = count('stroke');
console.log(`雨：stroke 调用 ${rainStrokes} 次，clearRect ${count('clearRect')} 次`);

calls.length = 0;
fx.set('storm');
tick();
console.log(`暴雨：stroke ${count('stroke')} 次，水花 ellipse ${count('ellipse')} 次`);

calls.length = 0;
fx.set('snow');
tick();
console.log(`雪：arc ${count('arc')} 次`);

calls.length = 0;
fx.set('off');
console.log(`关闭后仍有帧调度: ${pending ? '是（不应该）' : '否'}`);

const ok = rainStrokes > 0 && count('arc') === 0;
console.log('结果:', ok ? '✓ 粒子在动，且切换模式正确' : '✗ 异常');
process.exit(ok ? 0 : 1);

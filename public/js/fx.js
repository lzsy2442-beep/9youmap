// 天气粒子：雨滴 / 暴雨 / 雪
// 独立 canvas，只在需要时跑 rAF；尊重「减少动态效果」

const RAIN = {
  count: 240,
  speed: [820, 1250],   // px/s
  len: [10, 22],
  width: [0.7, 1.5],
  alpha: [0.16, 0.4],
  slant: 0.16,
  color: '104, 118, 132'
};

const STORM = {
  count: 460,
  speed: [1350, 2050],
  len: [16, 38],
  width: [1, 1.9],
  alpha: [0.2, 0.46],
  slant: 0.26,
  color: '84, 98, 112'
};

const SNOW = {
  count: 240,
  speed: [22, 66],
  radius: [1.3, 3.2],
  alpha: [0.62, 0.98],
  drift: 0.55,
  color: '255, 253, 246'
};

const rand = (a, b) => a + Math.random() * (b - a);

export function createWeatherFx(canvas) {
  const ctx = canvas.getContext('2d');
  let mode = 'off';
  let parts = [];
  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let t = 0;
  let reduce = false;

  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduce = mq.matches;
    mq.addEventListener?.('change', (e) => { reduce = e.matches; applyMode(); });
  } catch { /* 忽略 */ }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeRain(cfg) {
    return {
      x: rand(-40, w + 40),
      y: rand(-h, h),
      speed: rand(cfg.speed[0], cfg.speed[1]),
      len: rand(cfg.len[0], cfg.len[1]),
      width: rand(cfg.width[0], cfg.width[1]),
      alpha: rand(cfg.alpha[0], cfg.alpha[1])
    };
  }

  function makeSnow(cfg) {
    return {
      x: rand(0, w),
      y: rand(-h, h),
      speed: rand(cfg.speed[0], cfg.speed[1]),
      r: rand(cfg.radius[0], cfg.radius[1]),
      alpha: rand(cfg.alpha[0], cfg.alpha[1]),
      phase: rand(0, Math.PI * 2),
      sway: rand(0.4, 1.3)
    };
  }

  function applyMode() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (mode === 'rain' || mode === 'storm') {
      const cfg = mode === 'storm' ? STORM : RAIN;
      parts = Array.from({ length: cfg.count }, () => makeRain(cfg));
    } else if (mode === 'snow') {
      parts = Array.from({ length: SNOW.count }, () => makeSnow(SNOW));
    } else {
      parts = [];
    }
    ctx.clearRect(0, 0, w, h);
    if (parts.length && !reduce && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;
    ctx.clearRect(0, 0, w, h);

    if (mode === 'rain' || mode === 'storm') {
      const cfg = mode === 'storm' ? STORM : RAIN;
      ctx.lineCap = 'round';
      for (const p of parts) {
        p.y += p.speed * dt;
        p.x -= p.speed * cfg.slant * dt;
        if (p.y > h + 30) { Object.assign(p, makeRain(cfg)); p.y = -30; }
        if (p.x < -60) p.x = w + 40;
        ctx.strokeStyle = `rgba(${cfg.color}, ${p.alpha})`;
        ctx.lineWidth = p.width;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.len * cfg.slant, p.y - p.len);
        ctx.stroke();
      }
      // 落地水花：少量、轻
      if (mode === 'storm') {
        ctx.fillStyle = 'rgba(150, 172, 190, 0.10)';
        for (let i = 0; i < 18; i++) {
          const sx = ((i * 197 + Math.floor(t * 60) * 13) % w);
          const sy = h - ((i * 89 + Math.floor(t * 30) * 27) % 70);
          ctx.beginPath();
          ctx.ellipse(sx, sy, 5, 1.6, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (mode === 'snow') {
      for (const p of parts) {
        p.y += p.speed * dt;
        p.x += Math.sin(t * 0.6 + p.phase) * SNOW.drift * p.sway * 30 * dt;
        if (p.y > h + 10) { Object.assign(p, makeSnow(SNOW)); p.y = -10; }
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        // 先画一圈浅灰投影，雪花在米色纸面上才不会糊掉
        ctx.beginPath();
        ctx.fillStyle = `rgba(64, 82, 100, ${p.alpha * 0.2})`;
        ctx.arc(p.x + 0.7, p.y + 0.9, p.r * 1.85, 0, Math.PI * 2);
        ctx.fill();
        // 再画雪芯
        ctx.beginPath();
        ctx.fillStyle = `rgba(${SNOW.color}, ${p.alpha})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    raf = requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => {
    resize();
    if (mode !== 'off') applyMode();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (mode !== 'off') applyMode();
  });

  resize();

  return {
    set(kind) {
      const next = ['rain', 'storm', 'snow'].includes(kind) ? kind : 'off';
      if (next === mode) return;
      mode = next;
      applyMode();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, w, h);
    }
  };
}

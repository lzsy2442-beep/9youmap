// 荒原纸面地图：Canvas 自绘瓦片 / 经纬网 / 伞 / 金兔子
// 设计要点：无第三方地图库；未配置天地图 Key 时退化为「纸面经纬网」，不绘制任何行政边界。

const TILE = 256;
const MIN_ZOOM = 2.6;
const ICON_SCALE = 1.3;   // 地图上伞 / 金兔子的整体大小
const MAX_ZOOM = 13;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// 城市名重要性（越靠前越优先显示，其余排后面）
const LABEL_PRIORITY = [
  '北京', '上海', '广州', '深圳', '成都', '杭州', '武汉', '西安', '南京', '重庆',
  '天津', '苏州', '长沙', '郑州', '青岛', '沈阳', '大连', '哈尔滨', '长春', '济南',
  '合肥', '福州', '厦门', '南昌', '昆明', '贵阳', '南宁', '海口', '兰州', '西宁',
  '银川', '乌鲁木齐', '拉萨', '呼和浩特', '太原', '石家庄', '宁波', '温州'
];

export function project(lat, lng, zoom) {
  const size = TILE * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * size;
  const s = Math.sin(rad(clamp(lat, -85.05, 85.05)));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return { x, y };
}

export function unproject(x, y, zoom) {
  const size = TILE * Math.pow(2, zoom);
  const lng = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = deg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
  return { lat, lng };
}

export class PaperMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.center = opts.center || { lat: 34.2, lng: 108.9 };
    this.zoom = (opts.zoom === null || opts.zoom === undefined) ? 4 : opts.zoom;
    this.targetZoom = this.zoom;
    this.markers = [];
    this.cities = opts.cities || [];
    this.clusters = [];
    this.hover = null;
    this.selected = null;
    this.tileUrl = opts.tileUrl || null; // (z,x,y,layer) => url
    this.options = Object.assign(
      { labels: true, rabbits: true, sameOnly: false },
      opts.options || {}
    );
    this.tileCache = new Map();
    this.dragging = false;
    this.moved = 0;
    this.onClick = opts.onClick || (() => {});
    this.onMarkerClick = opts.onMarkerClick || (() => {});
    this.onViewChange = opts.onViewChange || (() => {});
    this._bind();
    this.resize();
    this._loop();
  }

  setTileUrl(fn) { this.tileUrl = fn; this.tileCache.clear(); this.dirty = true; }
  setCities(cities) { this.cities = cities; this.dirty = true; }
  setMarkers(list) { this.markers = list || []; this.dirty = true; }
  setSelected(id) { this.selected = id; this.dirty = true; }
  setOptions(patch) { Object.assign(this.options, patch || {}); this.dirty = true; }
  getOptions() { return { ...this.options }; }
  getView() { return { center: this.center, zoom: this.zoom }; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  toScreen(lat, lng) {
    const c = project(this.center.lat, this.center.lng, this.zoom);
    const p = project(lat, lng, this.zoom);
    return { x: p.x - c.x + this.w / 2, y: p.y - c.y + this.h / 2 };
  }

  toLatLng(sx, sy) {
    const c = project(this.center.lat, this.center.lng, this.zoom);
    return unproject(c.x + sx - this.w / 2, c.y + sy - this.h / 2, this.zoom);
  }

  flyTo(lat, lng, zoom = this.zoom) {
    this.center = { lat, lng };
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.targetZoom = this.zoom;
    this.dirty = true;
  }

  /** 以视图中心为锚点缩放 */
  zoomBy(delta) {
    this.targetZoom = clamp(this.targetZoom + delta, MIN_ZOOM, MAX_ZOOM);
    this.dirty = true;
  }

  /** 回到全国视野 */
  resetView() {
    this.flyTo(34.2, 108.9, 4.6);
  }

  /** 以某个屏幕点为锚缩放 */
  _applyZoom(sx, sy, z, instant = true) {
    const nz = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const before = this.toLatLng(sx, sy);
    const cp = project(before.lat, before.lng, nz);
    const next = unproject(cp.x - (sx - this.w / 2), cp.y - (sy - this.h / 2), nz);
    this.center = { lat: next.lat, lng: next.lng };
    this.targetZoom = nz;
    if (instant) this.zoom = nz;
    this.dirty = true;
  }

  _bind() {
    const c = this.canvas;
    let last = null;
    this.pointers = new Map();
    this.pinch = null;
    this.tapTimer = 0;
    this.lastTap = null;

    const emitTap = (clientX, clientY) => {
      const rect = c.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const hit = this._hit(mx, my);
      if (hit) {
        if (hit.type === 'cluster') {
          this.flyTo(hit.lat, hit.lng, Math.min(this.zoom + 1.6, MAX_ZOOM));
        } else {
          this.selected = hit.marker.id;
          this.onMarkerClick(hit.marker);
        }
      } else {
        const ll = this.toLatLng(mx, my);
        this.onClick(ll.lat, ll.lng);
      }
      this.dirty = true;
    };

    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointers.size === 1) {
        this.dragging = true;
        this.moved = 0;
        this.pinch = null;
        last = { x: e.clientX, y: e.clientY };
      } else if (this.pointers.size === 2) {
        // 进入双指捏合
        this.dragging = false;
        const [a, b] = [...this.pointers.values()];
        const rect = c.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
        this.pinch = {
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          zoom: this.targetZoom,
          anchor: this.toLatLng(mid.x, mid.y)
        };
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      // 双指缩放：以两指中点为锚
      if (this.pointers.size >= 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const rect = c.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left;
        const my = (a.y + b.y) / 2 - rect.top;
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const z = clamp(this.pinch.zoom + Math.log2(dist / this.pinch.dist), MIN_ZOOM, MAX_ZOOM);
        this.zoom = z;
        this.targetZoom = z;
        const cp = project(this.pinch.anchor.lat, this.pinch.anchor.lng, z);
        const next = unproject(cp.x - (mx - this.w / 2), cp.y - (my - this.h / 2), z);
        this.center = { lat: clamp(next.lat, -85, 85), lng: ((next.lng + 540) % 360) - 180 };
        this.moved = 999;
        this.dirty = true;
        return;
      }

      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (this.dragging && last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        this.moved += Math.abs(dx) + Math.abs(dy);
        const cp = project(this.center.lat, this.center.lng, this.zoom);
        const next = unproject(cp.x - dx, cp.y - dy, this.zoom);
        this.center = { lat: clamp(next.lat, -80, 80), lng: ((next.lng + 540) % 360) - 180 };
        last = { x: e.clientX, y: e.clientY };
        this.dirty = true;
      } else {
        this.hover = this._hit(mx, my);
        c.style.cursor = this.hover ? 'pointer' : 'grab';
        this.dirty = true;
      }
    });

    const endPointer = (e, cancelled) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size > 0) return;

      const wasDrag = this.moved > 6;
      this.dragging = false;
      last = null;
      c.style.cursor = 'grab';
      if (cancelled) { this.moved = 0; return; }
      if (wasDrag) { this.moved = 0; return; }

      const now = Date.now();
      // 双击放大
      if (this.lastTap
        && now - this.lastTap.t < 320
        && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30) {
        clearTimeout(this.tapTimer);
        this.lastTap = null;
        const rect = c.getBoundingClientRect();
        this._applyZoom(e.clientX - rect.left, e.clientY - rect.top, this.targetZoom + 1, true);
        this.moved = 0;
        return;
      }

      // 触屏：先等 240ms，确认不是双击再当作点击（避免双击第一下就弹落点框）
      if (e.pointerType === 'touch') {
        const { clientX, clientY } = e;
        clearTimeout(this.tapTimer);
        this.tapTimer = setTimeout(() => emitTap(clientX, clientY), 240);
        this.lastTap = { x: clientX, y: clientY, t: now };
      } else {
        emitTap(e.clientX, e.clientY);
        this.lastTap = null;
      }
      this.moved = 0;
    };

    c.addEventListener('pointerup', (e) => endPointer(e, false));
    c.addEventListener('pointercancel', (e) => endPointer(e, true));

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = -e.deltaY * 0.0018;
      const before = this.toLatLng(mx, my);
      const nz = clamp(this.targetZoom + delta, MIN_ZOOM, MAX_ZOOM);
      this.targetZoom = nz;
      const cp = project(before.lat, before.lng, nz);
      const next = unproject(cp.x - (mx - this.w / 2), cp.y - (my - this.h / 2), nz);
      this.center = { lat: next.lat, lng: next.lng };
      this.dirty = true;
    }, { passive: false });

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 260));
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this.resize());
    }
  }

  _hit(sx, sy) {
    if (this.zoom < 6) {
      for (const cl of this.clusters) {
        if (Math.hypot(cl.x - sx, cl.y - sy) < 22) return { type: 'cluster', ...cl };
      }
      return null;
    }
    for (const m of this.markers) {
      const p = this.toScreen(m.lat, m.lng);
      if (Math.hypot(p.x - sx, p.y - sy) < 20) return { type: 'marker', marker: m };
    }
    return null;
  }

  _loop() {
    const step = () => {
      if (Math.abs(this.targetZoom - this.zoom) > 0.001) {
        this.zoom += (this.targetZoom - this.zoom) * 0.18;
        if (Math.abs(this.targetZoom - this.zoom) < 0.002) this.zoom = this.targetZoom;
        this.dirty = true;
      }
      if (this.dirty) {
        this.dirty = false;
        this._draw();
        this.onViewChange(this.getView());
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _draw() {
    const { ctx, w, h } = this;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    // 纸面
    ctx.fillStyle = '#E9DDBF';
    ctx.fillRect(0, 0, w, h);

    if (this.tileUrl) this._drawTiles();
    // 有天地图注记时不再重复画城市名，避免地名叠字
    if (!this.tileUrl && this.options.labels) this._drawCities();
    this._drawMarkers();
    ctx.restore();
  }

  _drawTiles() {
    const { ctx, w, h } = this;
    const zi = clamp(Math.round(this.zoom), 3, 17);
    const scale = Math.pow(2, this.zoom - zi);
    const centerPx = project(this.center.lat, this.center.lng, zi);
    const n = Math.pow(2, zi);
    const halfW = w / 2 / scale;
    const halfH = h / 2 / scale;
    const x0 = Math.floor((centerPx.x - halfW) / TILE);
    const x1 = Math.floor((centerPx.x + halfW) / TILE);
    const y0 = Math.floor((centerPx.y - halfH) / TILE);
    const y1 = Math.floor((centerPx.y + halfH) / TILE);
    const size = TILE * scale;

    ctx.imageSmoothingEnabled = true;
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const px = (tx * TILE - centerPx.x) * scale + w / 2;
        const py = (ty * TILE - centerPx.y) * scale + h / 2;
        this._tile('vec', zi, wx, ty, px, py, size);
        this._tile('cva', zi, wx, ty, px, py, size);
      }
    }
  }

  _tile(layer, z, x, y, px, py, size) {
    const key = `${layer}/${z}/${x}/${y}`;
    let img = this.tileCache.get(key);
    if (!img) {
      img = new Image();
      // 不设 crossOrigin：不需要读像素，设了反而会被 CORS 预检卡住
      img.onload = () => { this.dirty = true; };
      img.onerror = () => { this.tileCache.set(key, 'err'); this.dirty = true; };
      img.src = this.tileUrl(z, x, y, layer);
      this.tileCache.set(key, img);
    }
    if (img === 'err' || !img.complete || img.naturalWidth === 0) return;
    // 让底图「旧」下来
    this.ctx.filter = 'sepia(0.28) saturate(0.82) contrast(0.94) brightness(1.03)';
    this.ctx.drawImage(img, px, py, size + 0.6, size + 0.6);
    this.ctx.filter = 'none';
  }

  _drawCities() {
    if (this.zoom < 3.6) return;
    const { ctx, w, h } = this;
    ctx.save();
    ctx.font = '12px "Songti SC", "Noto Serif SC", "SimSun", serif';
    ctx.textAlign = 'center';

    const pts = [];
    for (const c of this.cities) {
      const p = this.toScreen(c.lat, c.lng);
      if (p.x < -40 || p.x > w + 40 || p.y < -20 || p.y > h + 20) continue;
      pts.push({ c, x: p.x, y: p.y });
    }

    // 先点
    for (const p of pts) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(44, 36, 25, 0.5)';
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.zoom <= 4.2) { ctx.restore(); return; }

    // 再标签：按重要性排序 + 碰撞检测，避免长三角一堆地名糊在一起
    const prio = (name) => {
      const i = LABEL_PRIORITY.indexOf(name);
      return i === -1 ? 999 : i;
    };
    pts.sort((a, b) => prio(a.c.name) - prio(b.c.name));

    const taken = [];
    const hit = (r) => taken.some((t) =>
      r.x - r.w / 2 < t.x + t.w / 2 && r.x + r.w / 2 > t.x - t.w / 2 &&
      r.y - r.h < t.y + t.h && r.y > t.y - t.h);

    for (const p of pts) {
      const text = p.c.name;
      const tw = ctx.measureText(text).width + 6;
      const rect = { x: p.x, y: p.y - 7, w: tw, h: 13 };
      if (hit(rect)) continue;
      taken.push(rect);
      ctx.fillStyle = 'rgba(44, 36, 25, 0.6)';
      ctx.fillText(text, p.x, p.y - 7);
    }
    ctx.restore();
  }

  _drawMarkers() {
    const { ctx, w, h } = this;
    const visible = [];
    const pool = this.markers.filter((m) =>
      (this.options.rabbits || m.kind !== 'rabbit') &&
      (!this.options.sameOnly || m.sameServer || m.isMine));
    for (const m of pool) {
      const p = this.toScreen(m.lat, m.lng);
      if (p.x < -30 || p.x > w + 30 || p.y < -30 || p.y > h + 30) continue;
      visible.push({ ...m, _x: p.x, _y: p.y });
    }

    if (this.zoom < 6) {
      const cell = 64;
      const grid = new Map();
      for (const m of visible) {
        const k = `${Math.floor(m._x / cell)}:${Math.floor(m._y / cell)}`;
        const g = grid.get(k);
        if (g) { g.items.push(m); }
        else grid.set(k, { x: m._x, y: m._y, lat: m.lat, lng: m.lng, items: [m] });
      }
      this.clusters = [...grid.values()];
      for (const g of this.clusters) {
        const n = g.items.length;
        const same = g.items.filter((i) => i.sameServer).length;
        const r = Math.min(9 + Math.sqrt(n) * 2.6, 22);
        ctx.beginPath();
        ctx.fillStyle = same > 0 ? 'rgba(176, 138, 79, 0.92)' : 'rgba(72, 62, 48, 0.62)';
        ctx.strokeStyle = 'rgba(44, 36, 25, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#FBF3E2';
        ctx.font = `600 ${n > 99 ? 10 : 11}px "Songti SC", serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n > 999 ? '999+' : String(n), g.x, g.y + 0.5);
      }
      return;
    }

    this.clusters = [];
    for (const m of visible) this._drawOne(m);
  }

  _drawOne(m) {
    const { ctx } = this;
    const x = m._x;
    const y = m._y;
    const isMe = m.isMine;
    const same = m.sameServer;
    const sel = this.selected === m.id;
    const hovered = !!(this.hover && this.hover.type === 'marker' && this.hover.marker.id === m.id);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(ICON_SCALE, ICON_SCALE);

    if (same || isMe) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(176, 138, 79, 0.16)';
      ctx.arc(0, -6, 13, 0, Math.PI * 2);
      ctx.fill();
    }
    if (sel || hovered) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(140, 59, 43, 0.9)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([3, 3]);
      ctx.arc(0, -6, 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (m.kind === 'rabbit') drawRabbit(ctx, same);
    else drawUmbrella(ctx, same ? '#B08A4F' : '#8A7F6D', same);

    if (isMe) {
      ctx.beginPath();
      ctx.fillStyle = '#8C3B2B';
      ctx.arc(0, -22, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawUmbrella(ctx, color, strong) {
  ctx.save();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = 'rgba(44,36,25,0.8)';
  ctx.fillStyle = color;
  // 伞面
  ctx.beginPath();
  ctx.moveTo(-8, -6);
  ctx.quadraticCurveTo(-8, -17, 0, -17);
  ctx.quadraticCurveTo(8, -17, 8, -6);
  ctx.quadraticCurveTo(4, -9, 0, -6);
  ctx.quadraticCurveTo(-4, -9, -8, -6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 伞杆
  ctx.beginPath();
  ctx.moveTo(0, -17);
  ctx.lineTo(0, 1);
  ctx.quadraticCurveTo(0, 5, 3.5, 5);
  ctx.stroke();
  if (strong) {
    ctx.beginPath();
    ctx.fillStyle = 'rgba(251, 243, 226, 0.55)';
    ctx.arc(-2.6, -10, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function capsule(ctx, x1, y1, x2, y2, r) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.arc(x1, y1, r, a + Math.PI / 2, a - Math.PI / 2);
  ctx.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
  ctx.closePath();
}

// 金兔子：一只正面兔子头像的铜牌（独一律的简化造型）
// 坐标与 scripts/rabbit-preview.py 完全一致，改了要两边一起改
function drawRabbit(ctx, strong) {
  const ink = strong ? 'rgba(44, 36, 25, 0.88)' : 'rgba(44, 36, 25, 0.6)';
  const grad = ctx.createLinearGradient(0, -18, 0, 1);
  if (strong) {
    grad.addColorStop(0, '#F7DFA6');
    grad.addColorStop(0.45, '#DDB268');
    grad.addColorStop(1, '#A0702C');
  } else {
    grad.addColorStop(0, '#D2C9B6');
    grad.addColorStop(0.45, '#A79C88');
    grad.addColorStop(1, '#7A7163');
  }
  const innerEar = strong ? 'rgba(255, 246, 222, 0.62)' : 'rgba(255, 255, 255, 0.16)';

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 落点投影
  ctx.beginPath();
  ctx.fillStyle = 'rgba(44, 36, 25, 0.13)';
  ctx.ellipse(0, 0.9, 4.8, 1.15, 0, 0, Math.PI * 2);
  ctx.fill();

  // 两只耳朵：先画深色描边，再叠金色
  for (const s of [-1, 1]) {
    ctx.fillStyle = ink;
    capsule(ctx, s * 2.3, -9.2, s * 2.9, -18.4, 1.75 + 0.72);
    ctx.fill();
    ctx.fillStyle = grad;
    capsule(ctx, s * 2.3, -9.2, s * 2.9, -18.4, 1.75);
    ctx.fill();
    ctx.fillStyle = innerEar;
    capsule(ctx, s * 2.3, -10.0, s * 2.8, -17.2, 0.75);
    ctx.fill();
  }

  // 脸
  ctx.beginPath();
  ctx.fillStyle = grad;
  ctx.ellipse(0, -6.5, 5.9, 5.9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // 眼睛
  ctx.beginPath();
  ctx.fillStyle = ink;
  ctx.ellipse(-2.05, -7.2, 0.8, 0.9, 0, 0, Math.PI * 2);
  ctx.ellipse(2.05, -7.2, 0.8, 0.9, 0, 0, Math.PI * 2);
  ctx.fill();

  // 鼻子
  ctx.beginPath();
  ctx.fillStyle = 'rgba(140, 59, 43, 0.9)';
  ctx.moveTo(0, -5.3);
  ctx.lineTo(-0.7, -4.4);
  ctx.lineTo(0.7, -4.4);
  ctx.closePath();
  ctx.fill();

  // 嘴
  ctx.beginPath();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.45;
  ctx.moveTo(0, -4.3);
  ctx.lineTo(0, -3.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -4.1, 1.6, 0.9, 0, 0.35, Math.PI - 0.35);
  ctx.stroke();

  ctx.restore();
}
// 三级行政区划（省 / 地级市 / 区县）加载与查询
// 数据由 scripts/build-regions.mjs 生成，来源：DataV GeoAtlas + modood 行政区划
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, 'regions.json'), 'utf8'));

export const REGIONS_VERSION = raw.version;
export const PROVINCES = raw.provinces;

/** code -> { code, name, lat, lng, depth, provinceCode, cityCode, parents: [] } */
export const REGION_MAP = new Map();

function walk(nodes, depth, ancestors) {
  for (const n of nodes) {
    const path = [...ancestors, n];
    REGION_MAP.set(n.code, {
      code: n.code,
      name: n.name,
      lat: n.lat,
      lng: n.lng,
      depth,
      provinceCode: path[0].code,
      cityCode: depth >= 1 ? path[1].code : null,
      parentCode: ancestors.length ? ancestors[ancestors.length - 1].code : null,
      leaf: !n.children || n.children.length === 0
    });
    if (n.children) walk(n.children, depth + 1, path);
  }
}
walk(PROVINCES, 0, []);

/** 地图打点与「境内判定」用的城市级点（省 + 地级市 + 直辖市各区） */
export const CITY_POINTS = [];
for (const p of PROVINCES) {
  CITY_POINTS.push({ code: p.code, name: p.name, lat: p.lat, lng: p.lng, depth: 0 });
  for (const c of p.children || []) {
    CITY_POINTS.push({ code: c.code, name: c.name, lat: c.lat, lng: c.lng, depth: 1 });
  }
}

export function getRegion(code) {
  return REGION_MAP.get(String(code || '')) || null;
}

/** "江苏省 苏州市 昆山市" */
export function regionLabel(code) {
  const node = getRegion(code);
  if (!node) return '';
  const names = [];
  let cur = node;
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parentCode ? getRegion(cur.parentCode) : null;
  }
  // 直辖市的省级与市级同名时去重
  return names.filter((n, i) => i === 0 || n !== names[i - 1]).join(' ');
}

export function nearestRegion(lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const c of CITY_POINTS) {
    const d = haversine(lat, lng, c.lat, c.lng);
    if (d < bestD) { bestD = d; best = c; }
  }
  return { node: best, distance: bestD };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const REGION_STATS = raw.count;

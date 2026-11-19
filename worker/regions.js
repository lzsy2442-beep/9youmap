// Worker 端的三级行政区划查询（数据打包在 data-regions.js 里）
import { REGIONS } from './data-regions.js';
import { CHINA_BBOX } from '../server/constants.js';

export const REGIONS_VERSION = REGIONS.version;
export const PROVINCES = REGIONS.provinces;
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

export function regionLabel(code) {
  const node = getRegion(code);
  if (!node) return '';
  const names = [];
  let cur = node;
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parentCode ? getRegion(cur.parentCode) : null;
  }
  return names.filter((n, i) => i === 0 || n !== names[i - 1]).join(' ');
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

export const REGION_STATS = REGIONS.count;

/** 境内判定：包围盒 + 距最近行政区划点 ≤ 500km（与 Node 端一致） */
export function isInChina(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const { minLat, maxLat, minLng, maxLng } = CHINA_BBOX;
  if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) return false;
  return nearestRegion(lat, lng).distance <= 500_000;
}
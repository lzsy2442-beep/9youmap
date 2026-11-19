// 地理工具：距离、坐标模糊化、境内校验
import { createHash } from 'node:crypto';
import { CHINA_BBOX } from './constants.js';
import { nearestRegion, getRegion } from './regions.js';

const R = 6371000; // 地球半径（米）

export function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 距离最近的行政区划点（省级 + 地级市） */
export function nearestCity(lat, lng) {
  return nearestRegion(lat, lng);
}

/**
 * 境内校验（第一版为粗筛）
 * 1) 中国经纬度包围盒
 * 2) 距任一城市中心 ≤ 500km
 * TODO(合规): 上线前替换为经审图的地理围栏数据。
 */
export function isInChina(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const { minLat, maxLat, minLng, maxLng } = CHINA_BBOX;
  if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) return false;
  const { distance } = nearestCity(lat, lng);
  return distance <= 500_000;
}

/** 确定性抖动：同一标记永远得到同一个模糊点 */
function jitter(id, salt) {
  const h = createHash('sha256').update(`${id}:${salt}`).digest();
  const a = (h[0] * 256 + h[1]) / 65535; // 0..1
  const b = (h[2] * 256 + h[3]) / 65535;
  return { a, b };
}

/**
 * 坐标模糊化（在服务端落地，前端拿不到原始坐标）
 * fuzzy: 500m 网格 + 格内确定性抖动（约 ±220m）
 * exact: 保留 5 位小数（约 1m）
 * city : 直接落到城市中心
 */
export function fuzzCoord(id, lat, lng, precision = 'fuzzy', cityCode = null) {
  if (precision === 'city' && cityCode) {
    const c = getRegion(cityCode);
    if (c) return { lat: c.lat, lng: c.lng };
  }
  if (precision === 'exact') {
    return { lat: round(lat, 5), lng: round(lng, 5) };
  }
  const cell = 0.005; // 约 500m（纬度方向）
  const baseLat = Math.floor(lat / cell) * cell;
  const baseLng = Math.floor(lng / cell) * cell;
  const { a, b } = jitter(id, 'fuzz');
  return {
    lat: round(baseLat + a * cell, 6),
    lng: round(baseLng + b * cell, 6)
  };
}

function round(n, d) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

/** 简易游标：把字符串转成稳定数字键，用于 since 增量 */
export function markerKey(createdAt, id) {
  return `${createdAt}|${id}`;
}

/** 供前端做聚合的网格键 */
export function gridKey(lat, lng, size = 1) {
  return `${Math.floor(lat / size)}:${Math.floor(lng / size)}`;
}

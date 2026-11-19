// 生成三级行政区划数据（省 / 地级市 / 区县），带中心点坐标
// 数据源：
//   1) 阿里 DataV GeoAtlas 行政区划（省、地级市：含 adcode + center + 层级）
//   2) modood/Administrative-divisions-of-China 的 pca-code.json（区县：code + name）
// 区县没有经纬度，用所属地级市的中心点（天气本来就是区域级的，够用）
//
// 用法：node scripts/build-regions.mjs
// 输出：server/regions.json

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'server', 'regions.json');

const DATAV = 'https://geo.datav.aliyun.com/areas_v3/bound';
const PCA = 'https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/pca-code.json';
const PCA_CACHE = join(ROOT, 'scripts', '.cache', 'pca-code.json');

const JUNK = new Set(['市辖区', '县', '省直辖县级行政区划', '自治区直辖县级行政区划', '市', '区']);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// 区县数据优先用本地缓存（GitHub 直连经常被重置）
async function getPCA() {
  const { existsSync, readFileSync } = await import('node:fs');
  if (existsSync(PCA_CACHE)) {
    console.log('使用本地缓存的 pca-code.json');
    return JSON.parse(readFileSync(PCA_CACHE, 'utf8'));
  }
  return getJSON(PCA);
}

function centerOf(props) {
  const c = props.center || props.centroid;
  if (!Array.isArray(c) || c.length < 2) return null;
  const [lng, lat] = c;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat: +lat.toFixed(4), lng: +lng.toFixed(4) };
}

console.log('拉取省级列表…');
const country = await getJSON(`${DATAV}/100000_full.json`);
const provinces = country.features
  .map((f) => f.properties)
  .filter((p) => p && p.adcode)
  .sort((a, b) => a.adcode - b.adcode);

console.log(`省级 ${provinces.length} 个，逐个拉取市级…`);
const tree = [];
const byCode = new Map();

for (const p of provinces) {
  const c = centerOf(p) || { lat: 0, lng: 0 };
  const node = { code: String(p.adcode), name: p.name, lat: c.lat, lng: c.lng, children: [] };
  tree.push(node);
  byCode.set(node.code, node);

  if (!p.childrenNum) continue;
  let sub;
  try {
    sub = await getJSON(`${DATAV}/${p.adcode}_full.json`);
  } catch (err) {
    console.warn(`  跳过 ${p.name}: ${err.message}`);
    continue;
  }
  for (const f of sub.features) {
    const q = f.properties;
    if (!q || !q.adcode) continue;
    const cc = centerOf(q) || c;
    const child = {
      code: String(q.adcode), name: q.name, lat: cc.lat, lng: cc.lng,
      level: q.level || '', children: []
    };
    node.children.push(child);
    byCode.set(child.code, child);
  }
  process.stdout.write(`  ${p.name} +${sub.features.length}\n`);
}

console.log('拉取区县数据（pca-code）…');
const pca = await getPCA();

let countyCount = 0;
let orphan = 0;
for (const prov of pca) {
  if (!Array.isArray(prov.children)) continue;
  const provCode = String(prov.code).padStart(2, '0') + '0000';
  const provNode = byCode.get(provCode);
  if (!provNode) continue;

  for (const city of prov.children) {
    const areas = city.children || [];
    if (!areas.length) continue;
    const cityCode = String(city.code).padStart(4, '0') + '00';
    // 普通地级市：挂到对应市级节点；直辖市 / 省直辖县级：挂到省级节点
    let host = byCode.get(cityCode);
    if (!host) host = provNode;
    if (host === provNode && provNode.children.some((x) => x.code === String(areas[0].code))) {
      // 已经由 DataV 直接给出（例如直辖市的区），跳过重复
      continue;
    }
    for (const a of areas) {
      const name = String(a.name || '').trim();
      if (!name || JUNK.has(name)) continue;
      const code = String(a.code);
      if (byCode.has(code)) continue;
      const leaf = { code, name, lat: host.lat, lng: host.lng, children: [] };
      const list = host === provNode ? provNode.children : (host.children || (host.children = []));
      list.push(leaf);
      byCode.set(code, leaf);
      countyCount++;
    }
  }
}

// 清理：空 children 数组统一删掉，减小体积
function prune(node) {
  if (!node.children || node.children.length === 0) { delete node.children; return; }
  node.children.forEach(prune);
  delete node.level;
}

tree.forEach(prune);
tree.sort((a, b) => a.code.localeCompare(b.code));

const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: 'DataV GeoAtlas + modood/Administrative-divisions-of-China',
  count: { provinces: tree.length, cities: tree.reduce((n, p) => n + (p.children?.length || 0), 0), counties: countyCount },
  provinces: tree
};

const json = JSON.stringify(payload);
writeFileSync(OUT, json, 'utf8');
console.log(`\n完成：${payload.count.provinces} 省 / ${payload.count.cities} 市 / ${payload.count.counties} 区县`);
console.log(`输出：${OUT}（${(json.length / 1024).toFixed(0)} KB）`);

#!/usr/bin/env node
/**
 * 真实影像画廊抓取：用 NASA 官方影像库 API 为各天体抓 2–3 张真实照片，
 * 保存到 web/images/ 并生成 data/gallery.json（离线可用）。
 *
 * 用法：node tools/fetch-gallery.mjs [--force]
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'web', 'images');
const OUT = path.join(ROOT, 'data', 'gallery.json');
const force = process.argv.includes('--force');

/** 天体 → NASA 影像库检索词（每个抓 2–3 张） */
const QUERIES = [
  ['sun', 'solar dynamics observatory sun eruption', 3],
  ['mercury', 'messenger mercury planet', 2],
  ['venus', 'magellan venus surface radar', 2],
  ['earth', 'earth blue marble', 2],
  ['moon', 'apollo 11 moon surface', 3],
  ['mars', 'mars curiosity rover panorama gale crater', 3],
  ['phobos', 'phobos mars moon', 2],
  ['jupiter', 'juno jupiter great red spot', 3],
  ['io', 'juno io volcano', 3],
  ['europa', 'europa galileo ice', 2],
  ['ganymede', 'juno ganymede', 2],
  ['callisto', 'callisto galileo', 2],
  ['saturn', 'cassini saturn rings', 3],
  ['titan', 'cassini titan haze', 2],
  ['enceladus', 'cassini enceladus plume', 2],
  ['mimas', 'cassini mimas', 1],
  ['iapetus', 'cassini iapetus', 1],
  ['uranus', 'voyager 2 uranus', 2],
  ['neptune', 'voyager 2 neptune dark spot', 2],
  ['triton', 'voyager triton neptune moon', 2],
  ['pluto', 'new horizons pluto', 3],
  ['charon', 'new horizons charon', 2],
  ['ceres', 'dawn ceres occator', 2],
  ['vesta', 'dawn vesta', 2],
  ['arrokoth', 'ultima thule kuiper belt', 2],
  ['bennu', 'osiris-rex bennu', 2],
  ['ryugu', 'hayabusa2 asteroid ryugu', 2],
  ['itokawa', 'asteroid itokawa hayabusa', 2],
  ['67P', 'rosetta comet 67p', 2],
  ['1P', 'halley comet nucleus', 1],
  ['voyager1', 'voyager spacecraft', 2],
  ['juno', 'juno spacecraft jupiter', 2],
  ['cassini', 'cassini spacecraft saturn', 2],
  ['perseverance', 'perseverance rover selfie', 2],
  // 星际天体：只有艺术想象图（没有真实照片），单独允许
  ['1I', 'Oumuamua', 2, true],
];

/**
 * 直接指定 URL 的补充影像（NASA 影像库没有的）：
 *   [天体 id, 图片 URL, 标题, 来源, 类型]
 *   类型：photo=原始影像 / processed=后处理（多次曝光叠加、轨道跟踪、去噪增强）/ concept=科学模拟或艺术家重建
 */
const EXTRA = [
  // ---- 星际天体：真实观测（粗糙但真实）+ 科学家模拟的表面 ----
  ['1I', 'https://cdn.eso.org/images/screen/eso1737d.jpg',
    'VLT 等多台望远镜叠加的深场影像（奥陌陌）', 'ESO / VLT', 'processed'],
  ['1I', 'https://cdn.esahubble.org/archives/images/screen/heic1813b.jpg',
    '哈勃：预测位置与实际观测位置对比（轨道跟踪叠加）', 'NASA / ESA / STScI', 'processed'],
  ['1I', 'https://cdn.eso.org/images/screen/eso1737a.jpg',
    '艺术家想象图：细长的星际小行星', 'ESO / M. Kornmesser', 'concept'],
  ['2I', 'https://cdn.esahubble.org/archives/images/screen/heic1918a.jpg',
    '哈勃 2019 年 10 月观测到的 2I/Borisov', 'NASA / ESA / D. Jewitt', 'photo'],
  ['2I', 'https://cdn.esahubble.org/archives/images/screen/heic1922a.jpg',
    '哈勃拍摄的 2I/Borisov 与背景星系', 'NASA / ESA / STScI', 'photo'],
  ['3I', 'https://cdn.esahubble.org/archives/images/screen/heic2509a.jpg',
    '哈勃拍摄的 3I/ATLAS', 'NASA / ESA / STScI', 'photo'],
  // ---- 从未被直接拍到的天体：科学家据掩星 / 光谱推测的表面 ----
  ['makemake', 'https://cdn.eso.org/images/screen/eso1246a.jpg',
    '据掩星与光谱数据推测的鸟神星表面', 'ESO', 'concept'],
  ['makemake', 'https://cdn.esahubble.org/archives/images/screen/opo1618b.jpg',
    '哈勃实际探测到的鸟神星与它的暗卫星', 'NASA / ESA / STScI', 'photo'],
  ['eris', 'https://images-assets.nasa.gov/image/PIA17307/PIA17307~medium.jpg',
    '艺术家概念图：阋神星与阋卫一', 'NASA / JPL-Caltech', 'concept'],
  ['quaoar', 'https://cdn.esahubble.org/archives/images/screen/opo0217b.jpg',
    '哈勃 ACS 实际拍到的创神星', 'NASA / ESA / STScI', 'photo'],
  ['quaoar', 'https://cdn.esahubble.org/archives/images/screen/opo0217a.jpg',
    '艺术家想象图：海王星外的冰世界', 'NASA / ESA / STScI', 'concept'],
  ['sedna', 'https://cdn.esahubble.org/archives/images/screen/opo0414b.jpg',
    '哈勃拍到的最清晰的塞德娜影像', 'NASA / ESA / STScI', 'photo'],
  // ---- 其他有价值的原始影像 ----
  ['pluto', 'https://cdn.esahubble.org/archives/images/screen/heic1212a.jpg',
    '哈勃发现的第五颗冥卫（标注版）', 'NASA / ESA / STScI', 'photo'],
  ['nix', 'https://cdn.esahubble.org/archives/images/screen/heic1512a.jpg',
    '哈勃观测到的冥卫二（尼克斯）', 'NASA / ESA / STScI', 'photo'],
  ['uranus', 'https://cdn.esahubble.org/archives/images/screen/opo2518.jpg',
    '哈勃拍摄的天王星与四颗大卫星', 'NASA / ESA / STScI', 'photo'],
  ['ganymede', 'https://cdn.esahubble.org/archives/images/screen/heic2107a.jpg',
    '哈勃 1996 年拍摄的木卫三', 'NASA / ESA / STScI', 'photo'],
  ['triton', 'https://cdn.esahubble.org/archives/images/screen/opo9823a.jpg',
    '哈勃观测到的海卫一', 'NASA / ESA / STScI', 'photo'],
  ['vesta', 'https://cdn.eso.org/images/screen/eso2114a.jpg',
    'ESO VLT 拍摄的 42 颗小行星（含灶神星、智神星等）', 'ESO / VLT / SPHERE', 'photo'],
  ['ceres', 'https://cdn.eso.org/images/screen/eso2114b.jpg',
    'VLT 拍摄的谷神星与灶神星', 'ESO / VLT / SPHERE', 'photo'],
];

const UA = { 'user-agent': 'Mozilla/5.0 little-cosmos/1.0 (local educational)' };

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function search(q) {
  const url = `https://images-api.nasa.gov/search?media_type=image&page_size=8&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j?.collection?.items || [];
}

async function grab(url, file) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 3000) throw new Error('文件过小');
      await writeFile(file, buf);
      return buf.length;
    } catch (e) {
      lastErr = e;
      // 某些站点（ESA/Hubble、ESO CDN）对 Node fetch 不友好，退回系统 curl
      try {
        execFileSync('curl', ['-sS', '-L', '--max-time', '60', '-A', UA['user-agent'], '-o', file, url], { stdio: 'ignore' });
        const size = (await stat(file)).size;
        if (size >= 3000) return size;
      } catch { /* 继续重试 */ }
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

await mkdir(DIR, { recursive: true });
const gallery = {};
let total = 0;

for (const [id, q, want, allowConcept] of QUERIES) {
  const list = [];
  try {
    const items = await search(q);
    for (const it of items) {
      if (list.length >= want) break;
      const d = it.data?.[0];
      const links = it.links || [];
      const pick = links.find((l) => /~small\.jpg$/.test(l.href)) || links.find((l) => /~medium\.jpg$/.test(l.href)) || links[0];
      if (!d?.title || !pick?.href) continue;
      const concept = /illustration|artist|concept|depiction/i.test(d.title);
      if (!allowConcept && /illustration|artist|concept|poster|logo|infographic/i.test(d.title)) continue;
      const n = list.length + 1;
      const file = `${id}-${n}.jpg`;
      const full = path.join(DIR, file);
      try {
        if (force || !(await exists(full))) await grab(pick.href, full);
        list.push({
          file, title: d.title, date: d.date_created?.slice(0, 10) || '',
          nasaId: d.nasa_id || '', credit: d.center || 'NASA',
          kind: concept ? 'concept' : 'photo',
        });
      } catch (e) { console.log(`    · 跳过 ${d.title}: ${e.message}`); }
    }
  } catch (e) {
    console.log(`  ✗ ${id}: ${e.message}`);
  }
  if (list.length) { gallery[id] = list; total += list.length; }
  console.log(`  ${list.length ? '✓' : '✗'} ${id.padEnd(14)} ${list.length} 张  ${list.map((x) => x.title.slice(0, 34)).join(' | ')}`);
}

// 补充影像（NASA 库里没有的）
for (const [id, url, title, credit, kind] of EXTRA) {
  const n = (gallery[id]?.length || 0) + 1;
  const file = `${id}-${n}.jpg`;
  const full = path.join(DIR, file);
  try {
    if (force || !(await exists(full))) await grab(url, full);
    (gallery[id] = gallery[id] || []).push({ file, title, date: '', nasaId: '', credit, kind });
    total++;
    console.log(`  ✓ ${id.padEnd(14)} 1 张  ${title.slice(0, 40)}`);
  } catch (e) {
    console.log(`  ✗ ${id}: ${e.message}`);
  }
}

await writeFile(OUT, JSON.stringify({
  meta: { source: 'NASA Image and Video Library (images-api.nasa.gov)', count: total, note: '缩略图已本地化，可离线浏览' },
  gallery,
}, null, 1));
console.log(`\n→ data/gallery.json（${total} 张，${Object.keys(gallery).length} 个天体）`);

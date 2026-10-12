#!/usr/bin/env node
/**
 * 高清全球图发现器：从 NASA 影像库找各天体的「全球马赛克 / 地图」原图，
 * 下载后读取 JPEG 尺寸，筛出接近 2:1（等距圆柱投影）的高分辨率候选。
 *
 * 用法：node tools/find-maps.mjs [--only=jupiter,pluto] [--force]
 * 产物：data/raw/nasa/<PIA>.jpg + data/raw/nasa-maps.json
 */
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'raw', 'nasa');
const OUT = path.join(ROOT, 'data', 'raw', 'nasa-maps.json');
const force = process.argv.includes('--force');

const BODIES = [
  ['pluto', ['Pluto global mosaic', 'Pluto color map']],
  ['charon', ['Global Map of Pluto Moon Charon', 'Charon global mosaic']],
  ['ceres', ['Ceres global mosaic', 'Ceres map Dawn']],
  ['vesta', ['Vesta global mosaic', 'Vesta map Dawn']],
  ['mimas', ['Mimas global mosaic', 'Mimas map Cassini']],
  ['tethys', ['Tethys global mosaic', 'Tethys map Cassini']],
  ['dione', ['Dione global mosaic', 'Dione map Cassini']],
  ['rhea', ['Rhea global mosaic', 'Rhea map Cassini']],
  ['iapetus', ['Iapetus global mosaic', 'Iapetus map Cassini']],
  ['enceladus', ['Enceladus global mosaic', 'Enceladus map Cassini']],
  ['titan', ['Titan global mosaic', 'Titan map Cassini']],
  ['miranda', ['Miranda global mosaic', 'Miranda map Voyager']],
  ['ariel', ['Ariel global mosaic', 'Ariel map Voyager']],
  ['titania', ['Titania global mosaic', 'Titania map Voyager']],
  ['oberon', ['Oberon global mosaic', 'Oberon map Voyager']],
  ['triton', ['Triton global mosaic', 'Triton map Voyager']],
  ['europa', ['Europa global mosaic', 'Europa map Galileo']],
  ['ganymede', ['Ganymede global mosaic', 'Ganymede map']],
  ['callisto', ['Callisto global mosaic', 'Callisto map']],
  ['io', ['Io global mosaic', 'Io map Galileo']],
  ['phobos', ['Phobos global mosaic', 'Phobos map']],
  ['deimos', ['Deimos global mosaic', 'Deimos map']],
  ['bennu', ['Bennu global mosaic', 'Bennu map']],
  ['ryugu', ['Ryugu global map', 'Ryugu mosaic']],
  ['itokawa', ['Itokawa global mosaic', 'Itokawa map']],
  ['eros', ['Eros global mosaic', 'Eros map NEAR']],
  ['arrokoth', ['Arrokoth global', 'Ultima Thule map']],
  ['mercury', ['Mercury global mosaic', 'Mercury map MESSENGER']],
  ['moon', ['Moon global mosaic', 'LRO moon map']],
  ['mars', ['Mars global mosaic', 'Mars map Viking']],
];

const UA = { 'user-agent': 'Mozilla/5.0 little-cosmos/1.0 (local educational)' };

/** 读取 JPEG 尺寸（不依赖任何库） */
async function jpegSize(file) {
  const buf = await readFile(file);
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function grab(url, file) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 5000) throw new Error('文件过小');
      await writeFile(file, buf);
      return buf.length;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function search(q) {
  const url = `https://images-api.nasa.gov/search?media_type=image&page_size=8&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j?.collection?.items || [];
}

await mkdir(DIR, { recursive: true });
const out = {};
const only = process.argv.find((a) => a.startsWith('--only='));

for (const [id, queries] of BODIES) {
  if (only && !only.slice(7).split(',').includes(id)) continue;
  const cands = [];
  for (const q of queries) {
    try {
      for (const it of await search(q)) {
        const d = it.data?.[0];
        const orig = (it.links || []).map((l) => l.href).find((l) => /~orig\.jpg$/.test(l));
        if (!orig || !d?.nasa_id) continue;
        if (cands.some((c) => c.id === d.nasa_id)) continue;
        cands.push({ id: d.nasa_id, title: d.title, url: orig });
      }
    } catch (e) { /* 忽略单个查询失败 */ }
    if (cands.length >= 6) break;
  }
  const got = [];
  for (const c of cands.slice(0, 6)) {
    const file = path.join(DIR, `${c.id}.jpg`);
    try {
      if (force || !(await exists(file))) await grab(c.url, file);
      const size = await jpegSize(file);
      const bytes = (await stat(file)).size;
      const ratio = size ? size.w / size.h : 0;
      got.push({ ...c, ...size, ratio: +ratio.toFixed(3), bytes });
    } catch (e) { /* 忽略下载失败 */ }
  }
  // 2:1 且够大者优先
  got.sort((a, b) => (Math.abs(a.ratio - 2) - Math.abs(b.ratio - 2)) || (b.w * b.h) - (a.w * a.h));
  out[id] = got.slice(0, 4);
  const best = got[0];
  console.log(`${best ? '✓' : '✗'} ${id.padEnd(10)} ${got.map((g) => `${g.id}(${g.w}×${g.h})`).join(' ')}`);
}

await writeFile(OUT, JSON.stringify({ meta: { source: 'NASA Image and Video Library (~orig.jpg)' }, maps: out }, null, 1));
console.log(`\n→ ${path.relative(ROOT, OUT)}`);

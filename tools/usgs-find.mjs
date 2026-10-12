#!/usr/bin/env node
/**
 * USGS Astrogeology 贴图候选清单：列出每个天体所有可下载资源（含体积），供挑选。
 * 输出 data/raw/usgs-textures.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const BODIES = [
  ['mercury', 'Mercury'], ['venus', 'Venus'], ['moon', 'Moon'], ['mars', 'Mars'],
  ['phobos', 'Phobos'], ['deimos', 'Deimos'],
  ['io', 'Io'], ['europa', 'Europa'], ['ganymede', 'Ganymede'], ['callisto', 'Callisto'],
  ['jupiter', 'Jupiter'],
  ['titan', 'Titan'], ['enceladus', 'Enceladus'], ['mimas', 'Mimas'], ['tethys', 'Tethys'],
  ['dione', 'Dione'], ['rhea', 'Rhea'], ['iapetus', 'Iapetus'], ['hyperion', 'Hyperion'],
  ['phoebe', 'Phoebe'], ['janus', 'Janus'],
  ['miranda', 'Miranda'], ['ariel', 'Ariel'], ['umbriel', 'Umbriel'],
  ['titania', 'Titania'], ['oberon', 'Oberon'], ['puck', 'Puck'],
  ['triton', 'Triton'], ['proteus', 'Proteus'],
  ['pluto', 'Pluto'], ['charon', 'Charon'],
  ['ceres', 'Ceres'], ['vesta', 'Vesta'],
];

async function jget(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function tget(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: UA, redirect: 'follow' });
    return { ok: r.ok, bytes: Number(r.headers.get('content-length') || 0) };
  } catch { return { ok: false, bytes: -1 }; }
}

const out = {};
for (const [id, name] of BODIES) {
  const rec = { id, name, pages: [] };
  try {
    const s = await jget(`https://astrogeology.usgs.gov/search/results?searchBar=${encodeURIComponent(name)}&p=1`);
    const hits = (s.results || []).filter((r) => (r.geoform || []).includes('Global Mosaic')
      && /simple\s+cylindrical|global\s+mosaic|image\s+mosaic\s+map/i.test(r.title));
    for (const h of hits.slice(0, 3)) {
      const page = await tget(h.onlink);
      const links = [...new Set([...page.matchAll(/https:\/\/astrogeology\.usgs\.gov\/ckan\/[^"'\s<>]+?\/download\/[^"'\s<>]+?\.(?:jpg|jpeg|png|tif|tiff|jp2)/gi)].map((m) => m[0]))]
        .filter((l) => !/thumb|browse|clipping|preview|_100\.|_512\./i.test(l));
      const cands = [];
      for (const l of links) {
        const h2 = await head(l);
        cands.push({ url: l, bytes: h2.bytes, file: l.split('/').pop() });
      }
      cands.sort((a, b) => b.bytes - a.bytes);
      rec.pages.push({ title: h.title, slug: h.name, cands: cands.slice(0, 6) });
    }
  } catch (e) { rec.error = e.message; }
  out[id] = rec;
  console.log(`\n### ${id} (${name})`);
  for (const p of rec.pages) {
    console.log(`  [${p.title}]`);
    for (const c of p.cands) console.log(`     ${(c.bytes / 1048576).toFixed(1).padStart(7)}MB  ${c.file}`);
  }
  if (!rec.pages.length) console.log('  (none)', rec.error || '');
}

await mkdir(path.join(ROOT, 'data', 'raw'), { recursive: true });
await writeFile(path.join(ROOT, 'data', 'raw', 'usgs-textures.json'), JSON.stringify(out, null, 1));
console.log('\n→ data/raw/usgs-textures.json');

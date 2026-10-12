#!/usr/bin/env node
/**
 * 高清贴图抓取器 —— 全部来自公开可再分发的科学数据源
 *
 *  A) Solar System Scope 8K 贴图集（CC BY 4.0）
 *     太阳 / 八大行星 / 月球 / 地球昼夜·云层·法线·高光
 *  B) Celestia Content 行星与卫星全球图（NASA / USGS / JPL 影像汇编，GPL-2.0+）
 *     伽利略卫星、土星与天王星与海王星各大卫星、冥王星与卡戎、谷神星与灶神星、
 *     近地小行星、行星环……
 *
 * 产物：data/raw/textures/<name>  （原始分辨率，后续由 tools/build-textures.py 处理）
 *
 * 用法：node tools/fetch-textures.mjs [--only=sss,celestia] [--force]
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw', 'textures');
const argOnly = process.argv.find((a) => a.startsWith('--only='));
const only = new Set((argOnly ? argOnly.slice(7) : 'all').split(',').map((s) => s.trim()));
const force = process.argv.includes('--force');
const want = (k) => only.has('all') || only.has(k);

/* ---------- A. Solar System Scope 8K ---------- */
const SSS = [
  '8k_sun.jpg',
  '8k_mercury.jpg',
  '8k_venus_surface.jpg',
  '4k_venus_atmosphere.jpg',
  '8k_earth_daymap.jpg',
  '8k_earth_nightmap.jpg',
  '8k_earth_clouds.jpg',
  '8k_earth_normal_map.tif',
  '8k_earth_specular_map.tif',
  '8k_moon.jpg',
  '8k_mars.jpg',
  '8k_jupiter.jpg',
  '8k_saturn.jpg',
  '8k_saturn_ring_alpha.png',
];

/* ---------- B. Celestia Content ---------- */
const CEL = [
  // 木星系
  ['io.png', 'celestia_io.png'],
  ['europa.jpg', 'celestia_europa.jpg'],
  ['ganymede.jpg', 'celestia_ganymede.jpg'],
  ['callisto.jpg', 'celestia_callisto.jpg'],
  ['jupiter.jpg', 'celestia_jupiter.jpg'],
  ['jupiter-2018.jpg', 'celestia_jupiter2018.jpg'],
  // 火星卫星
  ['phobos.jpg', 'celestia_phobos.jpg'],
  ['deimos.jpg', 'celestia_deimos.jpg'],
  // 土星系
  ['titan.png', 'celestia_titan.png'],
  ['enceladus.jpg', 'celestia_enceladus.jpg'],
  ['mimas.jpg', 'celestia_mimas.jpg'],
  ['tethys.jpg', 'celestia_tethys.jpg'],
  ['dione.jpg', 'celestia_dione.jpg'],
  ['rhea.jpg', 'celestia_rhea.jpg'],
  ['iapetus.jpg', 'celestia_iapetus.jpg'],
  ['phoebe.jpg', 'celestia_phoebe.jpg'],
  ['saturn.jpg', 'celestia_saturn.jpg'],
  ['saturn-rings.png', 'celestia_saturn_rings.png'],
  // 天王星系
  ['miranda.jpg', 'celestia_miranda.jpg'],
  ['ariel.jpg', 'celestia_ariel.jpg'],
  ['umbriel.jpg', 'celestia_umbriel.jpg'],
  ['titania.jpg', 'celestia_titania.jpg'],
  ['oberon.jpg', 'celestia_oberon.jpg'],
  ['puck.jpg', 'celestia_puck.jpg'],
  ['uranus.jpg', 'celestia_uranus.jpg'],
  ['uranus-rings.png', 'celestia_uranus_rings.png'],
  // 海王星系
  ['triton.jpg', 'celestia_triton.jpg'],
  ['neptune.jpg', 'celestia_neptune.jpg'],
  ['neptune-rings.png', 'celestia_neptune_rings.png'],
  // 矮行星与海外天体
  ['pluto.jpg', 'celestia_pluto.jpg'],
  ['charon.jpg', 'celestia_charon.jpg'],
  ['nix.jpg', 'celestia_nix.jpg'],
  ['ceres.jpg', 'celestia_ceres.jpg'],
  ['vesta.jpg', 'celestia_vesta.jpg'],
  // 小天体
  ['eros.jpg', 'celestia_eros.jpg'],
  ['itokawa.jpg', 'celestia_itokawa.jpg'],
  ['bennu.jpg', 'celestia_bennu.jpg'],
  ['ryugu.jpg', 'celestia_ryugu.jpg'],
  ['arrokoth.jpg', 'celestia_arrokoth.jpg'],
];

/* ---------- 中分辨率补充（土卫七 等） ---------- */
const CELMED = [
  ['hyperion.jpg', 'celestia_hyperion.jpg'],
  ['umbriel.jpg', 'celestia_umbriel.jpg'],
  ['titania.jpg', 'celestia_titania.jpg'],
  ['oberon.jpg', 'celestia_oberon.jpg'],
  ['puck.jpg', 'celestia_puck.jpg'],
  ['nix.jpg', 'celestia_nix.jpg'],
  ['dinkinesh.jpg', 'celestia_dinkinesh.jpg'],
  ['gaspra.jpg', 'celestia_gaspra.jpg'],
  ['ida.jpg', 'celestia_ida.jpg'],
  ['lutetia.jpg', 'celestia_lutetia.jpg'],
  ['mathilde.jpg', 'celestia_mathilde.jpg'],
];

const SSS_BASE = 'https://www.solarsystemscope.com/textures/download/';
const CEL_BASE = 'https://raw.githubusercontent.com/CelestiaProject/CelestiaContent/master/textures/hires/';
const CELMED_BASE = 'https://raw.githubusercontent.com/CelestiaProject/CelestiaContent/master/textures/medres/';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function get(url, { retries = 4, timeout = 300000 } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (little-cosmos local educational visualization)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      if (buf.length < 512) throw new Error(`响应过小 (${buf.length} B)`);
      return buf;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

async function grab(url, file, label) {
  const out = path.join(RAW, file);
  if (!force && (await exists(out))) {
    const s = await stat(out);
    console.log(`  · 已存在 ${file} (${(s.size / 1048576).toFixed(2)} MB)`);
    return true;
  }
  try {
    const buf = await get(url);
    await writeFile(out, buf);
    console.log(`  ✓ ${label} → ${file} (${(buf.length / 1048576).toFixed(2)} MB)`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    return false;
  }
}

await mkdir(RAW, { recursive: true });
console.log('=== 高清贴图抓取 ===');

if (want('sss')) {
  console.log('\n[A] Solar System Scope 8K (CC BY 4.0)');
  let ok = 0;
  for (const name of SSS) if (await grab(SSS_BASE + name, name, name)) ok++;
  console.log(`  → ${ok}/${SSS.length}`);
}

if (want('celestia')) {
  console.log('\n[B] Celestia Content 全球图（NASA/USGS/JPL 影像）');
  let ok = 0;
  for (const [src, dst] of CEL) if (await grab(CEL_BASE + src, dst, src)) ok++;
  for (const [src, dst] of CELMED) if (await grab(CELMED_BASE + src, dst, src)) ok++;
  console.log(`  → ${ok}/${CEL.length + CELMED.length}`);
}

console.log('\n=== 完成 → data/raw/textures ===');

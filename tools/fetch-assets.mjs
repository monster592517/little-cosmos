#!/usr/bin/env node
/**
 * 资产抓取器（全部为公开可再分发的科研/开放数据源）
 *
 *  1) 行星表面纹理  Solar System Scope 2k 贴图集（CC BY 4.0）
 *  2) 恒星表        HYG Database v41（David Nash，CC BY-SA 4.0，Gaia/Hipparcos 汇编）
 *  3) 系外行星      NASA Exoplanet Archive TAP（公有领域）
 *  4) 轨道要素      JPL SBDB API（NASA/JPL，公有领域）
 *
 * 用法：node tools/fetch-assets.mjs [--only=textures,stars,exo,orbits] [--force]
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const TEX = path.join(ROOT, 'web', 'textures');

const argOnly = process.argv.find((a) => a.startsWith('--only='));
const only = new Set((argOnly ? argOnly.slice(7) : 'all').split(',').map((s) => s.trim()));
const force = process.argv.includes('--force');
const want = (k) => only.has('all') || only.has(k);

const TEXTURES = [
  '2k_sun.jpg', '2k_mercury.jpg', '2k_venus_surface.jpg', '2k_venus_atmosphere.jpg',
  '2k_earth_daymap.jpg', '2k_earth_nightmap.jpg', '2k_earth_clouds.jpg', '2k_moon.jpg',
  '2k_mars.jpg', '2k_jupiter.jpg', '2k_saturn.jpg', '2k_saturn_ring_alpha.png',
  '2k_uranus.jpg', '2k_neptune.jpg', '2k_stars_milky_way.jpg',
  '2k_ceres_fictional.jpg', '2k_eris_fictional.jpg', '2k_haumea_fictional.jpg',
  '2k_makemake_fictional.jpg',
];

/** 需要从 TIFF 转成 PNG 的高质量贴图（法线 / 高光遮罩） */
const TIFF_TEXTURES = ['2k_earth_normal_map.tif', '2k_earth_specular_map.tif'];

const SBDB_BODIES = [
  // 行星与矮行星
  'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune',
  'Pluto', 'Ceres', 'Eris', 'Haumea', 'Makemake',
  // 主带小行星
  'Vesta', 'Pallas', 'Hygiea', 'Interamnia', 'Davida', 'Eunomia', 'Juno', 'Psyche',
  'Cybele', 'Sylvia', 'Euphrosyne', 'Camilla', 'Hermione', 'Thisbe', 'Gaspra', 'Ida',
  'Mathilde', 'Lutetia',
  // 近地小行星
  'Eros', 'Bennu', 'Ryugu', 'Itokawa', 'Apophis', 'Didymos', 'Dinkinesh', 'Kleopatra',
  // 木星特洛伊
  'Hektor', 'Patroclus', 'Achilles', 'Eurybates', 'Agamemnon', 'Diomedes', 'Deiphobus',
  'Menelaus', 'Thule',
  // 半人马
  'Chariklo', 'Chiron', 'Pholus', 'Nessus', 'Asbolus', 'Bienor',
  // 柯伊伯带 / 离散盘 / 极端海外天体
  'Arrokoth', 'Quaoar', 'Sedna', 'Orcus', 'Gonggong', 'Ixion', 'Varuna', 'Salacia', 'Varda',
  '2002 MS4', '2002 AW197', '2003 AZ84', '2002 UX25', '2005 UQ513', '2004 GV9',
  '2007 JJ43', '2013 FY27', '2014 UZ224', '2015 RR245', '1996 TL66', '2002 TC302',
  '2018 VG18', '2018 AG37',
  // 彗星
  '1P', '2P', '9P', '19P', '21P', '55P', '67P', '81P', '103P', '109P', '12P', '46P',
  'C/1995 O1', 'C/1996 B2', 'C/2006 P1', 'C/2011 W3', 'C/2020 F3', 'C/2012 S1', 'C/2023 A3',
  // 星际天体
  '1I', '2I', '3I',
];

/**
 * NASA Exoplanet Archive TAP —— 确认行星表。
 *
 * ⚠️ 这里的门槛原来长这样：`where sy_dist < 40`（40 秒差距 ≈ 130 光年）。
 *   后果：确认行星表里约 6 千颗，只抓回 **758 颗（约 12%）**，
 *   而**每一颗都有精确的 RA/Dec** —— 位置是确定的，只是远。
 *   用户的验收口径是「目前能精确位置的都应该放进去」，
 *   所以准入判据按**有没有位置**定，不按远近定：
 *   距离缺失（`sy_dist` 为 null）的行会在 build-data 里被**计数丢弃**，
 *   并且必须写进产物的 meta 自证，不许悄悄少收。
 *
 * `top` 是**保险丝不是筛子**：全表约 6–7 千行，给到 4 万是为了
 * 防止将来表变大时一次性拖回一个 TB 级结果，不是用来砍数据的 ——
 * 所以真正的护栏是下面 fetchExoplanets() 里的「行数自证」，
 * 而不是这个数字。别把 top 调小来"优化"。
 */
const EXO_SELECT_FULL = 'pl_name,hostname,ra,dec,sy_dist,pl_orbper,pl_rade,pl_bmasse,pl_eqt,'
  + 'discoverymethod,disc_year,pl_orbsmax,pl_orbeccen,pl_insol,st_spectype,st_teff,st_rad,st_mass';
const EXO_SELECT_LEAN = 'pl_name,hostname,ra,dec,sy_dist,pl_orbper,pl_rade,pl_bmasse,pl_eqt,'
  + 'discoverymethod,disc_year,pl_orbsmax,pl_orbeccen';

/** 首选 / 兜底两张表。`ps` 是逐参考文献一行，只在 pscomppars 拉不到时才用。 */
const EXO_QUERIES = [
  { table: 'pscomppars', count: 'select count(*) as n from pscomppars', query: `select top 40000 ${EXO_SELECT_FULL} from pscomppars` },
  { table: 'ps', count: 'select count(*) as n from ps', query: `select top 120000 ${EXO_SELECT_LEAN} from ps` },
];

/** 两张表之间允许的容差：TAP 的 count 与实际取行之间隔了一次提交，允许几行的抖动。 */
const EXO_COUNT_TOLERANCE = 5;

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function get(url, { retries = 4, timeout = 180000 } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'little-cosmos/1.0 (local educational visualization)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      return buf;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) {
        const wait = 1200 * i;
        console.log(`    重试 ${i}/${retries - 1} (${e.message}) — ${wait}ms 后再试`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function save(file, buf, label) {
  await writeFile(file, buf);
  console.log(`  ✓ ${label} → ${path.relative(ROOT, file)} (${(buf.length / 1048576).toFixed(2)} MB)`);
}

async function fetchTextures() {
  await mkdir(TEX, { recursive: true });
  console.log('[1/4] 行星纹理 Solar System Scope (CC BY 4.0)');
  let ok = 0;
  for (const name of TEXTURES) {
    const out = path.join(TEX, name);
    if (!force && (await exists(out))) { console.log(`  · 跳过（已存在）${name}`); ok++; continue; }
    try {
      const buf = await get(`https://www.solarsystemscope.com/textures/download/${name}`);
      await save(out, buf, name);
      ok++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }
  console.log(`  纹理完成 ${ok}/${TEXTURES.length}`);

  // 法线/高光贴图：源站只提供 TIFF，用 Python(Pillow) 转 PNG
  let needConvert = false;
  for (const name of TIFF_TEXTURES) {
    const out = path.join(TEX, name);
    const png = out.replace(/\.tiff?$/, '.png');
    if (!force && (await exists(png))) { console.log(`  · 跳过（已存在）${path.basename(png)}`); continue; }
    try {
      const buf = await get(`https://www.solarsystemscope.com/textures/download/${name}`);
      await save(out, buf, name);
      needConvert = true;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }
  if (needConvert) {
    console.log('  转换 TIFF → PNG …');
    try {
      execFileSync('py', ['-3.13', path.join(ROOT, 'tools', 'tif2png.py'), TEX], { stdio: 'inherit' });
    } catch (e) {
      console.log(`  ✗ 转换失败（可手动运行 py -3.13 tools/tif2png.py）：${e.message}`);
    }
  }
}

async function fetchStars() {
  await mkdir(RAW, { recursive: true });
  const out = path.join(RAW, 'hyg.csv');
  console.log('[2/4] HYG 恒星表 v41');
  if (!force && (await exists(out))) { console.log('  · 跳过（已存在）hyg.csv'); return; }
  const url = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';
  await save(out, await get(url), 'hygdata_v41.csv');
}

/** 单次 TAP sync 查询 → JSON 数组 */
async function tapJson(query, timeout = 180000) {
  const url = `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${encodeURIComponent(query)}&format=json`;
  const rows = JSON.parse((await get(url, { timeout })).toString('utf8'));
  if (!Array.isArray(rows)) throw new Error('应答不是数组（多半是 TAP 的错误信封）');
  return rows;
}

async function fetchExoplanets() {
  await mkdir(RAW, { recursive: true });
  const out = path.join(RAW, 'exoplanets.json');
  console.log('[3/4] NASA 系外行星档案 (TAP)');
  if (!force && (await exists(out))) { console.log('  · 跳过（已存在）exoplanets.json'); return; }
  let lastErr;
  for (const q of EXO_QUERIES) {
    try {
      const rows = await tapJson(q.query);
      if (rows.length === 0) throw new Error('空结果');

      /* ---------- 行数自证：服务端截断不许悄悄通过 ----------
       * 这是本抓取器唯一一处「防静默」的地方，别删。
       *   TAP 的 sync 端点会在结果集过大时静默截断（不报错、HTTP 200），
       *   而我们现在正是从「按距离筛选」改成「全表取回」——
       *   一旦被截断，症状就是**行星表突然少一半，而一切都"成功"**。
       *   所以另发一个 count(*) 对账：差超过容差就**拒绝落盘**。
       *   宁可抓取失败（看得见），也不要落一个残缺的原始数据（看不见）。 */
      let official = null;
      try {
        const c = await tapJson(q.count, 60000);
        official = Number(c?.[0]?.n);
      } catch (e) {
        console.log(`  ! 官方计数查不到（${e.message}）—— 本次跳过行数自证`);
      }
      if (Number.isFinite(official)) {
        const gap = official - rows.length;
        console.log(`  行数自证：抓回 ${rows.length} / ${q.table} 计数 ${official}（差 ${gap}）`);
        if (gap > EXO_COUNT_TOLERANCE) {
          throw new Error(`疑似被服务端截断：${q.table} 官方 ${official} 行，只抓回 ${rows.length} 行`);
        }
      }

      await save(out, Buffer.from(JSON.stringify(rows)), `系外行星 ${q.table} ${rows.length} 行`);
      return;
    } catch (e) { lastErr = e; console.log(`  · ${q.table} 查询失败：${e.message}`); }
  }
  /* ⚠️ 走到这里**必须让进程以非零码退出**。
   * 原来只是打一行 ✗ 就继续跑下一个步骤 —— 于是抓取失败与抓取成功在退出码上
   * 完全一样，自动化里根本分不出来（典型的静默故障）。 */
  console.log(`  ✗ 系外行星抓取失败（两张表都没拿到）：${lastErr?.message}`);
  process.exitCode = 1;
}

async function fetchOrbits() {
  await mkdir(RAW, { recursive: true });
  const out = path.join(RAW, 'sbdb.json');
  console.log('[4/4] JPL SBDB 轨道要素');
  if (!force && (await exists(out))) { console.log('  · 跳过（已存在）sbdb.json'); return; }
  const result = {};
  for (const body of SBDB_BODIES) {
    try {
      const url = `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(body)}&full-prec=true`;
      const data = JSON.parse((await get(url, { timeout: 45000 })).toString('utf8'));
      const el = {};
      for (const e of data?.orbit?.elements ?? []) el[e.name] = parseFloat(e.value);
      result[body] = {
        fullname: data?.object?.fullname ?? body,
        shortname: data?.object?.shortname ?? body,
        kind: data?.object?.kind ?? null,
        orbitClass: data?.object?.orbit_class?.name ?? null,
        epoch: data?.orbit?.epoch ?? null,
        elements: el,
        tp: data?.orbit?.tp ?? null,
      };
      console.log(`  ✓ ${body} a=${el.a ?? '?'} e=${el.e ?? '?'} i=${el.i ?? '?'}`);
    } catch (e) {
      console.log(`  ✗ ${body}: ${e.message}`);
    }
  }
  await save(out, Buffer.from(JSON.stringify(result, null, 1)), `SBDB ${Object.keys(result).length} 个天体`);
}

console.log('=== 小小宇宙 · 资产抓取 ===');
if (want('textures')) await fetchTextures();
if (want('stars')) await fetchStars();
if (want('exo')) await fetchExoplanets();
if (want('orbits')) await fetchOrbits();
console.log('=== 完成 ===');

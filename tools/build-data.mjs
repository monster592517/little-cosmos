#!/usr/bin/env node
/**
 * 数据管线：把原始公开数据整理成前端直接可用的紧凑数据集。
 *
 *   data/raw/hyg.csv          → data/stars.json        （120 光年内恒星，赤道直角坐标，单位光年）
 *   data/raw/exoplanets.json  → data/exoplanets.json   （**全表**确认系外行星，按宿主恒星归并）
 *
 * ⚠️ 系外行星那一行原来写的是「40 pc 内」—— 那是筛选门槛时代的说明，
 *    门槛（`where sy_dist < 40`）已经去掉，口径改成「有精确位置就收录」。
 *
 * 用法：node tools/build-data.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'data');

const PC_TO_LY = 3.2615637769;
const MAX_LY = 120;

/** 极简 CSV 解析（HYG 使用标准引号转义） */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function buildStars() {
  console.log('[1/2] 解析 HYG 恒星表');
  const csv = await readFile(path.join(RAW, 'hyg.csv'), 'utf8');
  const rows = parseCsv(csv);
  const head = rows[0];
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const stars = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < head.length) continue;
    const distPc = num(r[idx.dist]);
    if (!distPc || distPc <= 0 || distPc > MAX_LY / PC_TO_LY) continue;
    if (idx.proper && r[idx.proper] === 'Sol') continue;
    const name = (r[idx.proper] || '').trim() || (r[idx.bf] || '').trim() || (r[idx.gl] ? `Gliese ${r[idx.gl]}` : '') ||
      (r[idx.hd] ? `HD ${r[idx.hd]}` : '') || (r[idx.hip] ? `HIP ${r[idx.hip]}` : '') || `HYG ${r[idx.id]}`;
    stars.push([
      name,
      +(num(r[idx.x]) * PC_TO_LY).toFixed(4) || 0,
      +(num(r[idx.y]) * PC_TO_LY).toFixed(4) || 0,
      +(num(r[idx.z]) * PC_TO_LY).toFixed(4) || 0,
      num(r[idx.mag]) ?? 99,
      num(r[idx.absmag]) ?? 99,
      num(r[idx.ci]),
      (r[idx.spect] || '').trim(),
      num(r[idx.lum]),
      [r[idx.hd] ? `HD ${r[idx.hd]}` : '', r[idx.hip] ? `HIP ${r[idx.hip]}` : '', r[idx.gl] ? `GJ ${r[idx.gl]}` : ''].filter(Boolean).join('|'),
    ]);
  }
  stars.sort((a, b) => (a[1] ** 2 + a[2] ** 2 + a[3] ** 2) - (b[1] ** 2 + b[2] ** 2 + b[3] ** 2));
  const payload = {
    meta: {
      source: 'HYG Database v41 (David Nash, CC BY-SA 4.0) — 汇编自 Hipparcos / Gaia / Gliese',
      unit: '光年（赤道 J2000 直角坐标，太阳位于原点）',
      radiusLy: MAX_LY,
      count: stars.length,
    },
    columns: ['name', 'x', 'y', 'z', 'mag', 'absmag', 'ci', 'spect', 'lum', 'ids'],
    rows: stars,
  };
  await writeFile(path.join(OUT, 'stars.json'), JSON.stringify(payload));
  console.log(`  ✓ data/stars.json — ${stars.length} 颗恒星（≤ ${MAX_LY} 光年）`);
  return stars;
}

async function buildExoplanets(stars) {
  console.log('[2/2] 解析 NASA 系外行星档案');
  const rows = JSON.parse(await readFile(path.join(RAW, 'exoplanets.json'), 'utf8'));

  /* ---------- 吸纳台账 ----------
   * 原始表的**每一行都必须有去处**：要么变成某个系统里的一颗行星，
   * 要么被下面的某一项**点名丢弃**。四项之和必须严格等于原始行数，
   * 不符就 throw（见函数末尾的断言）。
   *
   * 为什么非要这样：这张表原来被抓取器用 `where sy_dist < 40` 砍到 758/6360 行，
   * 而产物里只写了一个 `count: 471`（还是**系统**数）——
   * 从产物上完全看不出少了 88%。这就是最典型的「静默少收」：
   * 账本上只有一个数，没有一个「应该有多少」可以对照。
   *
   * 现在 `fetchedRows` 跟着产物一起走，`tools/model-probe.mjs` 拿它对账。
   * ⚠️ 判据的口径是「**有精确位置就收录**」：
   *   ra/dec 缺失 → droppedNoPosition；距离缺失 → droppedNoDistance。
   *   两者都不是「位置不确定」，而是**根本没有位置**，放不进去。
   */
  const led = {
    fetchedRows: rows.length,
    planets: 0,
    droppedNoHost: 0,       // 没有宿主星名 —— 连归属都没有
    droppedNoPosition: 0,   // 缺 ra/dec —— 不知道在哪个方向
    droppedNoDistance: 0,   // 缺距离 —— 知道方向但不知道多远
    dupRows: 0,             // 同一宿主的同一颗行星出现两次（ps 兜底表会有）
  };
  const byHost = new Map();
  for (const r of rows) {
    if (!r.hostname) { led.droppedNoHost++; continue; }
    if (r.ra == null || r.dec == null) { led.droppedNoPosition++; continue; }
    if (!Number.isFinite(num(r.sy_dist)) || num(r.sy_dist) <= 0) { led.droppedNoDistance++; continue; }
    const host = String(r.hostname).trim();
    if (!byHost.has(host)) {
      byHost.set(host, {
        host,
        ra: num(r.ra), dec: num(r.dec), distPc: num(r.sy_dist),
        spect: r.st_spectype || '', teff: num(r.st_teff), stMass: num(r.st_mass), stRad: num(r.st_rad),
        planets: [],
      });
    }
    const sys = byHost.get(host);
    /* 同一宿主的多行共用**第一条**带位置的行的坐标（pscomppars 里本来就一致）。
     * 早前的写法是先建系统再补行星，于是「第一行恰好缺距离」会让整个系统被丢掉；
     * 现在逐行过闸，缺距离的那行自己出局，后面带距离的行照样能把系统建起来。 */
    if (sys.planets.some((p) => p.name === r.pl_name)) { led.dupRows++; continue; }
    sys.planets.push({
      name: r.pl_name,
      periodDays: num(r.pl_orbper),
      radiusEarth: num(r.pl_rade),
      massEarth: num(r.pl_bmasse),
      eqTempK: num(r.pl_eqt),
      semiMajorAu: num(r.pl_orbsmax),
      ecc: num(r.pl_orbeccen),
      method: r.discoverymethod || '',
      year: num(r.disc_year),
    });
    led.planets++;
  }

  // 与 HYG 恒星表匹配（HD / HIP / GJ / 专名）
  const keyOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const index = new Map();
  for (const s of stars) {
    const [name, , , , , , , , , ids] = s;
    for (const token of [name, ...String(ids).split('|')]) {
      const k = keyOf(token);
      if (k) index.set(k, s);
    }
  }
  const systems = [];
  let matched = 0;
  for (const sys of byHost.values()) {
    const aliases = [sys.host, sys.host.replace(/^GJ\s*/i, 'Gliese '), sys.host.replace(/^HD\s*/i, 'HD '), sys.host.replace(/\s+[A-C]$/, '')];
    let star = null;
    for (const a of aliases) { const hit = index.get(keyOf(a)); if (hit) { star = hit; break; } }
    let x, y, z, distLy, name;
    if (star) {
      [, x, y, z] = star; name = star[0]; distLy = Math.hypot(x, y, z); matched++;
    } else if (sys.ra != null && sys.dec != null && sys.distPc) {
      const ra = (sys.ra * Math.PI) / 180, dec = (sys.dec * Math.PI) / 180, d = sys.distPc * PC_TO_LY;
      x = +(d * Math.cos(dec) * Math.cos(ra)).toFixed(4);
      y = +(d * Math.cos(dec) * Math.sin(ra)).toFixed(4);
      z = +(d * Math.sin(dec)).toFixed(4);
      distLy = d; name = sys.host;
    } else continue;
    systems.push({
      host: sys.host, starName: name, x, y, z, distLy: +distLy.toFixed(3),
      spect: sys.spect, teff: sys.teff,
      /* ⚠️ 这两列**必须 emit**。`st_mass`（太阳质量）与 `st_rad`（太阳半径）
       *    在 pscomppars 里覆盖率极高 —— 实测原始表 6,360 行里 **6,351 行有 st_mass**。
       *    上面 byHost 那一层已经把它们读进来了，但 emit 时漏写 ⇒ 整条链路
       *    「抓到了、解析了、产物里没有」，界面上永远显示不出恒星质量。
       *    这正是本项目最贵的一类静默故障：**每一段单独看都成功**。
       *    加字段时先问一句「这个字段会走到产物里吗」。 */
      massSolar: sys.stMass, radiusSolar: sys.stRad,
      planetCount: sys.planets.length,
      planets: sys.planets.sort((a, b) => (a.semiMajorAu ?? 1e9) - (b.semiMajorAu ?? 1e9)),
    });
  }
  systems.sort((a, b) => a.distLy - b.distLy);

  /* 台账必须平：四项丢弃 + 落地行星 === 原始行数。
   * 这条断言的作用是**让记账本身不可能悄悄漂**——
   * 将来有人再加一条 continue，如果没同步加计数，构建立刻红，而不是少收几千颗还全绿。 */
  const outPlanets = systems.reduce((a, s) => a + s.planets.length, 0);
  const accounted = outPlanets + led.droppedNoHost + led.droppedNoPosition + led.droppedNoDistance + led.dupRows;
  if (accounted !== led.fetchedRows) {
    throw new Error(`吸纳台账对不上：落地 ${outPlanets} + 无宿主 ${led.droppedNoHost} + 无位置 ${led.droppedNoPosition}`
      + ` + 无距离 ${led.droppedNoDistance} + 重复 ${led.dupRows} = ${accounted}，但原始表有 ${led.fetchedRows} 行`);
  }
  const distLyMax = systems.reduce((a, s) => Math.max(a, s.distLy), 0);

  /* ---------- 恒星属性的**覆盖率台账**（防 emit 漏列复发） ----------
   * 「原始表里有，产物里没有」是看不见的：产物自己不知道它缺什么。
   * 所以这里把「原始覆盖率」和「产物覆盖率」都写进 meta，并加一条硬断言。
   * 断言的口径是**相对**的（原始有值率 vs 产物有值率），不是某个写死的常数 ——
   * 常数会随着档案更新腐烂，相对比较不会。 */
  const rawWithMass = rows.filter((r) => Number.isFinite(num(r.st_mass))).length;
  const outWithMass = systems.filter((s) => Number.isFinite(s.massSolar)).length;
  if (rawWithMass / Math.max(1, rows.length) > 0.9 && outWithMass === 0) {
    throw new Error(`恒星质量整列丢失：原始表 ${rawWithMass}/${rows.length} 行有 st_mass，产物里 0 个系统有 massSolar。`
      + ' 十有八九是 systems.push 漏写了这个字段。');
  }

  const payload = {
    meta: {
      source: 'NASA Exoplanet Archive (pscomppars, TAP)',
      url: 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync',
      license: '公有领域（NASA/IPAC）',
      /* ⚠️ 这里**故意不写 `radiusPc`**。
       *    原来写死 `radiusPc: 40`，那是上一版抓取器的筛选门槛
       *    （`where sy_dist < 40`）。门槛一去掉，这个字段就成了一句谎话，
       *    而且会一直躺在产物里、没人会去发现它不对。
       *    要距离范围就从 `distLyMax` 现场读，或者干脆从 systems 现算。 */
      fetchedRows: led.fetchedRows,
      systems: systems.length,
      planets: outPlanets,
      matchedToHyg: matched,
      hostsFromCatalog: systems.length - matched,
      droppedNoHost: led.droppedNoHost,
      droppedNoPosition: led.droppedNoPosition,
      droppedNoDistance: led.droppedNoDistance,
      dupRows: led.dupRows,
      distLyMax: +distLyMax.toFixed(1),
      /* 恒星质量/半径的覆盖率 —— 让「产物到底带没带这两列」变成一个**看得见的数** */
      rawRowsWithStMass: rawWithMass,
      hostStarsWithMass: outWithMass,
      hostStarsWithRadius: systems.filter((s) => Number.isFinite(s.radiusSolar)).length,
      admission: '准入看「有没有位置」：ra/dec 与非空距离齐全即收录，不看远近。缺失的行按 dropped* 三项计数，不静默少收。',
    },
    systems,
  };
  await writeFile(path.join(OUT, 'exoplanets.json'), JSON.stringify(payload));
  console.log(`  ✓ data/exoplanets.json — ${systems.length} 个行星系统 / ${outPlanets} 颗行星（${matched} 个宿主与恒星表匹配，${systems.length - matched} 个由星表坐标新建）`);
  console.log(`    吸纳台账：原始 ${led.fetchedRows} = 行星 ${outPlanets} + 无宿主 ${led.droppedNoHost}`
    + ` + 无位置 ${led.droppedNoPosition} + 无距离 ${led.droppedNoDistance} + 重复 ${led.dupRows}；最远 ${distLyMax.toFixed(0)} 光年`);
}

/** JPL SBDB 轨道要素 → data/small-bodies.json（供前端 Orbit 使用） */
async function buildSmallBodies() {
  console.log('[3/3] 整理 JPL SBDB 轨道要素');
  let raw;
  try { raw = JSON.parse(await readFile(path.join(RAW, 'sbdb.json'), 'utf8')); }
  catch { console.log('  ✗ 缺少 data/raw/sbdb.json，跳过'); return; }
  const out = {};
  for (const [key, v] of Object.entries(raw)) {
    const e = v.elements || {};
    if (e.a == null || e.e == null) continue;
    out[key] = {
      fullname: v.fullname, orbitClass: v.orbitClass, epochJD: v.epoch ? Number(v.epoch) : null,
      a: e.a, e: e.e, i: e.i ?? 0, om: e.om ?? 0, w: e.w ?? 0, ma: e.ma ?? 0,
      q: e.q ?? null, ad: e.ad ?? null, periodDays: e.per_y != null ? e.per_y * 365.25 : null,
    };
  }
  await writeFile(path.join(OUT, 'small-bodies.json'), JSON.stringify({ meta: { source: 'JPL SBDB API', count: Object.keys(out).length }, bodies: out }));
  console.log(`  ✓ data/small-bodies.json — ${Object.keys(out).length} 个小天体轨道`);
}

/**
 * 银河系局部尺度（≤ 1000 pc ≈ 3262 ly）全量恒星点云 → data/stars-galactic.json
 * 仅保留坐标/星等/色指数/光度，去掉名称与光谱型以压体积。
 */
async function buildGalacticStars() {
  console.log('[4/4] 解析 HYG 恒星表（银河系尺度 ≤ 1000 pc）');
  const MAX_PC = 1000;                       // 1000 pc ≈ 3262 ly
  const csv = await readFile(path.join(RAW, 'hyg.csv'), 'utf8');
  const rows = parseCsv(csv);
  const head = rows[0];
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const toLy = (v) => +(num(v) * PC_TO_LY).toFixed(6);

  // 先收集中间数据（保留 distPc 以便排序与分档），再按需渲染
  const mid = [];
  let tier120 = 0, tier1000Ly = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < head.length) continue;          // 字段不足的行跳过
    const distPc = num(r[idx.dist]);
    if (distPc == null || distPc <= 0 || distPc > MAX_PC) continue; // 剔除哨兵值/超范围
    const distLy = distPc * PC_TO_LY;
    if (distLy <= 120) tier120++;
    if (distLy <= 1000) tier1000Ly++;
    mid.push([
      distPc,
      toLy(r[idx.x]), toLy(r[idx.y]), toLy(r[idx.z]),
      num(r[idx.mag]), num(r[idx.absmag]), num(r[idx.ci]), num(r[idx.lum]),
    ]);
  }
  mid.sort((a, b) => a[0] - b[0]);                        // 距离升序，方便前端先加载近处

  const round = (v, d) => (v == null ? null : +v.toFixed(d));
  const render = (degraded) => {
    const posD = degraded ? 2 : 3, magD = degraded ? 2 : 3;
    const columns = degraded
      ? ['x', 'y', 'z', 'mag', 'absmag', 'ci']
      : ['x', 'y', 'z', 'mag', 'absmag', 'ci', 'lum'];
    const outRows = mid.map((m) => {
      const row = [round(m[1], posD), round(m[2], posD), round(m[3], posD),
        round(m[4], magD), round(m[5], magD), round(m[6], 3)];
      if (!degraded) row.push(m[7] == null ? null : m[7]);
      return row;
    });
    const payload = {
      meta: {
        source: 'HYG Database v41 (David Nash, CC BY-SA 4.0) — 汇编自 Hipparcos / Gaia / Gliese',
        unit: '光年（赤道 J2000 直角坐标，太阳位于原点）',
        count: outRows.length,
        maxLy: Math.round(MAX_PC * PC_TO_LY),
        note: degraded
          ? '已剔除 HYG 中 dist=100000 pc 的距离未测定哨兵记录；因体积超限已做精度裁剪（坐标与星等 2 位小数，省略 lum 列）'
          : '已剔除 HYG 中 dist=100000 pc 的距离未测定哨兵记录',
        tiers: { le120: tier120, le1000: tier1000Ly, all: outRows.length },
      },
      columns,
      rows: outRows,
    };
    return JSON.stringify(payload);
  };

  let json = render(false);
  let degraded = false;
  if (Buffer.byteLength(json) > 10 * 1024 * 1024) {       // 超过 10 MB → 降级
    json = render(true);
    degraded = true;
  }
  await writeFile(path.join(OUT, 'stars-galactic.json'), json);
  console.log(`  ✓ data/stars-galactic.json — ${mid.length} 颗恒星，${(Buffer.byteLength(json) / 1048576).toFixed(2)} MB${degraded ? '（已精度裁剪）' : ''}`);
  return { count: mid.length, bytes: Buffer.byteLength(json), degraded };
}

await mkdir(OUT, { recursive: true });
const stars = await buildStars();
await buildExoplanets(stars);
await buildSmallBodies();
await buildGalacticStars();
console.log('完成。');

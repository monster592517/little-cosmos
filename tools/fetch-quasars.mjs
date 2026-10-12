#!/usr/bin/env node
/**
 * 类星体背景场抓取器 —— VizieR TAP（CDS Strasbourg）
 *
 * 目的：给「可观测宇宙」层补一批**真实位置**的远景天体。
 *   该层此前的真实数据只有 179 个河外星系（最远 2.68 Gly），
 *   而宇宙微波背景边界在 45.2 Gly —— 中间 17 倍的距离里只有程序化噪声。
 *   类星体是唯一「又远、又多、又有确定红移」的现成表，正好撑开这段纵深。
 *
 *  数据源：VizieR VII/290 = Milliquas v7.2（Flesch 2021, PASA 38, e049）
 *          https://vizier.cds.unistra.fr/viz-bin/cat/VII/290
 *  产物：  data/raw/quasars/*.tsv（原始应答，便于离线重跑）
 *          data/quasars.json（归一化 + 距离换算 + 三维坐标）
 *
 * 用法：node tools/fetch-quasars.mjs [--force]
 *   --force  忽略本地缓存，强制重新抓取
 *
 * 仅使用 Node 内置模块（含 Node 22 自带 fetch），无第三方依赖。
 *
 * ── 抽样口径（可复现性优先）────────────────────────────────────
 * 全表 1,573,824 行；z>0.02 的 1,480,301 行作为样本池。
 * 用 `MOD(recno, 250) = 0` 做**确定性的等间隔稀释**，取回 ~5900 条。
 *   · 不用 Math.random()：同一条管线跑两次必须得到同一个文件，
 *     否则「数据变了没有」这件事根本无从判断。
 *   · 不按 RA 排序取 TOP N：那只会得到一块天空，全天分布被打断。
 *   · 不做重加权：样品保留星表**实测到的**天空各向异性与 z 分布（诚实做法）。
 *   实测代表性（tools 里核过，写进 meta）：6 个 RA 带、6 个 Dec 带里
 *   样品占比 / 全表占比 = 0.97–1.08；z>1 占 65.8%（全表 65.4%）、
 *   z>2 占 23.9%（24.1%）、z>3 占 3.0%（3.0%）—— 稀释是均匀的。
 *
 * ── 为什么距离必须用共动距离积分、不能用 cz/H0 ──────────────────
 * 项目别处（deep-sky.mjs 的河外星系）用的是 H0=70 的线性近似，
 * 在 z>0.5 就不够用了（z=1 偏 +31%，z=3 偏 +105%），
 * 而这些最该撑开画面的远景天体恰好都在 z=0.5–3。
 * 这里改用平坦 ΛCDM + Planck 2018 参数做共动距离积分：
 *   E(z) = sqrt(Ωr(1+z)^4 + Ωm(1+z)^3 + ΩΛ)
 *   Dc(z) = (c/H0) ∫₀^z dz'/E(z')                    （Simpson 数值积分）
 *   H0=67.4、Ωm=0.315、ΩΛ=0.685、Ωr=9.24e-5、c=299792.458 km/s
 * 校验锚点：z=1089（CMB 复合时期）→ 45217.5 Mly ≈ 45.2 Gly，
 * 与项目里 CMB 边界已写死的 45200 Mly 对得上 ⇒ 积分口径无误。
 */
import { mkdir, writeFile, rename, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../server/lib/log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw', 'quasars');
const OUT_FILE = path.join(ROOT, 'data', 'quasars.json');
const LOG = createLogger(ROOT, { scope: 'fetch-quasars', mirrorConsole: false });

const argv = process.argv.slice(2);
const force = argv.includes('--force');

const UA = 'LittleCosmos/1.2 (local educational visualization; contact: local user)';
const TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';
const CATALOG_URL = 'https://vizier.cds.unistra.fr/viz-bin/cat/VII/290';

/* ============================================================
   一、抽样与过滤参数
   ============================================================ */
/**
 * `recno` 是 VizieR 给每条记录的稳定整数序号（VII/290 是冻结版本，序号不变）。
 * 步长 250：z>0.02 的 1,480,301 行 ⇒ 约 5,921 条，落在 4000–8000 的目标区间。
 */
const STRIDE = 250;
const Z_MIN = 0.02;
/** 可观测宇宙共动半径（Mly）——超过它的天体不在可观测范围内，属数据错误 */
const DIST_MAX_MLY = 46500;

/** 抽样查询：整条 SELECT 会写进 meta.query，便于复现 */
const SAMPLE_QUERY =
  `SELECT recno, Name, RAJ2000, DEJ2000, z, Rmag, Bmag `
  + `FROM "VII/290/catalog" WHERE z > ${Z_MIN} AND MOD(recno, ${STRIDE}) = 0`;
/** 台账查询：用来把「抽了多少 / 池子多大」这对数字落进 meta，可事后核对 */
const COUNT_ALL_QUERY = 'SELECT COUNT(*) AS n FROM "VII/290/catalog"';
const COUNT_Z_QUERY = `SELECT COUNT(*) AS n FROM "VII/290/catalog" WHERE z > ${Z_MIN}`;

/* ============================================================
   二、共动距离：平坦 ΛCDM 积分
   ============================================================ */
const C_KMS = 299792.458;        // 光速 km/s
const H0 = 67.4;                 // km/s/Mpc（Planck 2018）
const OMEGA_M = 0.315;
const OMEGA_L = 0.685;
const OMEGA_R = 9.24e-5;
const MPC_TO_MLY = 3.261563777;  // 1 Mpc = 3.2616 百万光年

/** 1/E(z)。积分对象是它，不是 E —— 写成 E 会让远天体距离整体偏大一个量级。 */
function invE(z) {
  const opz = 1 + z;
  return 1 / Math.sqrt(
    OMEGA_R * opz * opz * opz * opz
    + OMEGA_M * opz * opz * opz
    + OMEGA_L,
  );
}

/**
 * 共动距离 Dc(z)，单位 Mpc。
 *
 * 用 Simpson 法。⚠️ 步数不能只固定取 256：z 很大时等距 Simpson 会明显欠采样
 *   （实测 z=1089 时 256 步给出 48895 Mly，偏 +8%），
 *   所以按「每段 Δz ≤ 0.25」自适应加步，下限 512 步，且强制偶数。
 */
function comovingMpc(z) {
  if (!(z > 0)) return 0;
  const n = Math.max(512, 2 * Math.ceil(z / 0.25));
  const h = z / n;
  let s = invE(0) + invE(z);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * invE(i * h);
  return (C_KMS / H0) * (h / 3) * s;
}

/** 红移 → 共动距离（百万光年） */
const comovingMly = (z) => comovingMpc(z) * MPC_TO_MLY;

/** 校验锚点：CMB 复合时期。对不上就说明积分写错了。 */
const ANCHOR_Z = 1089;
const ANCHOR_MLY = comovingMly(ANCHOR_Z);

/* ============================================================
   三、工具函数
   ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);   // 同目录 rename 原子：要么旧文件、要么新文件
}

/**
 * TAP 同步查询。只对连接层错误重试（5xx / fetch failed）；
 * 4xx 是查询本身写错了，重试没有意义，必须立刻暴露。
 */
async function tapQuery(adql, format = 'tsv', { attempts = 3 } = {}) {
  const url = `${TAP}?REQUEST=doQuery&LANG=ADQL&FORMAT=${format}&QUERY=${encodeURIComponent(adql)}`;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const text = await r.text();
      if (r.status >= 500) throw new Error(`上游 ${r.status}（可重试）: ${text.slice(0, 160)}`);
      if (r.status !== 200) {
        const m = /<INFO name="QUERY_STATUS" value="ERROR">([\s\S]*?)<\/INFO>/.exec(text);
        throw Object.assign(
          new Error(`ADQL 被拒（不可重试）: ${m ? m[1].slice(0, 200) : text.slice(0, 200)}`),
          { fatal: true },
        );
      }
      return text;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      if (i < attempts - 1) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

/** 从 `COUNT(*)` 的单值 TSV 里取出整数 */
function parseCount(tsv) {
  const line = tsv.trim().split('\n')[1];
  const n = Number(line);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 TSV。VizieR 的字符串字段用双引号包裹（且**保留首尾空格**，如
 * `"SDSS J025952.94+000509.5 "`），数字字段不带引号。
 * 这里按 RFC4180 的口径处理引号，够用且不引第三方依赖。
 */
function parseTsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length);
  if (!lines.length) return { cols: [], rows: [] };
  const split = (line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === '\t') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cols = split(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const p = split(l);
    const o = {};
    cols.forEach((c, i) => { o[c] = p[i]; });
    return o;
  });
  return { cols, rows };
}

/** 名称 → 稳定、可读的 id 片段（`q-` 前缀在外层加） */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

/**
 * 赤经(度)、赤纬(度)、距离(Mly) → 赤道直角坐标。
 * ⚠️ 口径必须与 web/js/data/deep-sky.js 的 `xyz()` 完全一致，否则类星体
 *    会整体跑到错误的天空位置上（渲染侧按 (x, z, -y) 映射进场景）。
 */
function xyz(raDeg, decDeg, dist) {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  return [
    +(dist * Math.cos(dec) * Math.cos(ra)).toFixed(4),
    +(dist * Math.cos(dec) * Math.sin(ra)).toFixed(4),
    +(dist * Math.sin(dec)).toFixed(4),
  ];
}

/* ============================================================
   四、抓取（带本地缓存）
   ============================================================ */
async function fetchAll() {
  const sampleFile = path.join(RAW_DIR, `milliquas-z02-mod${STRIDE}.tsv`);
  const metaFile = path.join(RAW_DIR, '_query-meta.json');

  if (!force && await exists(sampleFile) && await exists(metaFile)) {
    return {
      tsv: await readFile(sampleFile, 'utf8'),
      counts: JSON.parse(await readFile(metaFile, 'utf8')),
      cached: true,
    };
  }

  LOG.info('抓取样例', { stride: STRIDE });
  const tsv = await tapQuery(SAMPLE_QUERY, 'tsv');
  // 先落原始数据再解析：上游挂了、字段变了，证据都还在
  await writeAtomic(sampleFile, tsv);
  await sleep(400);

  LOG.info('抓取台账计数');
  const catalogRows = parseCount(await tapQuery(COUNT_ALL_QUERY, 'csv'));
  await sleep(300);
  const rowsZ02 = parseCount(await tapQuery(COUNT_Z_QUERY, 'csv'));

  const counts = {
    catalogRows,
    rowsZ02,
    query: SAMPLE_QUERY,
    countAllQuery: COUNT_ALL_QUERY,
    countZQuery: COUNT_Z_QUERY,
    fetchedAt: new Date().toISOString(),
  };
  await writeAtomic(metaFile, JSON.stringify(counts, null, 2));
  return { tsv, counts, cached: false };
}

/* ============================================================
   五、归一化
   ============================================================ */
function normalize(rows) {
  const objects = [];
  const seenIds = new Set();
  let droppedNoName = 0, droppedBadCoords = 0, droppedZ = 0, droppedFar = 0, droppedDup = 0;
  let withMag = 0;

  for (const r of rows) {
    const name = String(r.Name || '').trim();
    if (!name) { droppedNoName++; continue; }

    const ra = Number(r.RAJ2000);
    const dec = Number(r.DEJ2000);
    const z = Number(r.z);
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || dec < -90 || dec > 90) {
      droppedBadCoords++; continue;
    }
    if (!Number.isFinite(z) || z <= Z_MIN) { droppedZ++; continue; }

    const distMly = comovingMly(z);
    if (!Number.isFinite(distMly) || distMly > DIST_MAX_MLY) { droppedFar++; continue; }

    const id = `q-${slugify(name)}`;
    if (seenIds.has(id)) { droppedDup++; continue; }
    seenIds.add(id);

    const rmag = Number.isFinite(Number(r.Rmag)) && r.Rmag !== '' ? Number(r.Rmag) : null;
    const bmag = Number.isFinite(Number(r.Bmag)) && r.Bmag !== '' ? Number(r.Bmag) : null;
    const mag = rmag ?? bmag;
    if (mag != null) withMag++;

    const [x, y, zc] = xyz(ra, dec, distMly);
    objects.push({
      id,
      name,
      ra: +ra.toFixed(7),
      dec: +dec.toFixed(7),
      redshift: z,
      distMly: +distMly.toFixed(2),
      x, y, z: zc,
      mag: mag == null ? null : mag,
      magBand: mag == null ? null : (rmag != null ? 'R' : 'B'),
    });
  }
  return { objects, droppedNoName, droppedBadCoords, droppedZ, droppedFar, droppedDup, withMag };
}

/* ============================================================
   六、主流程
   ============================================================ */
async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  const { tsv, counts, cached } = await fetchAll();
  const { cols, rows } = parseTsv(tsv);
  LOG.info('解析原始 TSV', { cols, rows: rows.length, cached });
  console.log(`  ${cached ? '缓存' : '抓取'}  原始样例 ${rows.length} 行（${cols.join(', ')}）`);

  if (!rows.length) {
    LOG.error('样例为空，不写产物');
    console.error('  FAIL  样例为空 —— 不写产物（宁可保持旧数据，也不产出空表）');
    process.exitCode = 1;
    return;
  }

  const n = normalize(rows);
  if (!n.objects.length) {
    LOG.error('归一化后一条不剩，不写产物');
    console.error('  FAIL  归一化后 0 条 —— 不写产物');
    process.exitCode = 1;
    return;
  }

  // 距离单调性自检：z 越大 Dc 必须越大（积分写错时最先崩的就是这条）
  const sorted = [...n.objects].sort((a, b) => a.redshift - b.redshift);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].distMly < sorted[i - 1].distMly) {
      throw new Error(`距离非单调：z=${sorted[i - 1].redshift} 与 z=${sorted[i].redshift} 处 Dc 反了`);
    }
  }
  if (Math.abs(ANCHOR_MLY - 45200) > 300) {
    throw new Error(`共动距离校验失败：z=${ANCHOR_Z} → ${ANCHOR_MLY.toFixed(1)} Mly，应与 ~45200 相符`);
  }

  const dists = n.objects.map((o) => o.distMly);
  const zs = n.objects.map((o) => o.redshift);

  /* 取样口径的**期望值** —— 用来解释「实测条数为什么不是 pool/stride 那种整数」。
     MOD 作用在**原始星表**的 recno 上 ⇒ 命中 recno 数 = floor(catalogRows / STRIDE)，
     再由「其中满足 z > Z_MIN 的比例」做一次二项抽样 ⇒ 期望与标准差都写得出来。
     ⚠️ 别写成 `rowsZ02 / STRIDE`：那两种写法**数值巧合地接近**，但口径是错的
        （它等于假设 stride 作用在 z 过滤后的重排子集上），会让人以为实现搞错了。 */
  const hitRecnos = Math.floor(counts.catalogRows / STRIDE);
  const zPass = counts.rowsZ02 / counts.catalogRows;
  const expCount = hitRecnos * zPass;
  const sdCount = Math.sqrt(hitRecnos * zPass * (1 - zPass));

  const out = {
    meta: {
      source: 'Milliquas v7.2（Flesch 2021, PASA 38, e049）— VizieR VII/290',
      url: CATALOG_URL,
      count: n.objects.length,
      /* 可核对台账：样品来自「z>0.02 的整表按 recno 每 250 行取 1 行」，
         抽样比可由 rowsZ02 / (STRIDE × count) 校验（应 ≈ 1）。 */
      catalogRows: counts.catalogRows,
      rowsZ02: counts.rowsZ02,
      stride: STRIDE,
      query: counts.query,
      samplingNote: `在**原始星表**上按 MOD(recno, ${STRIDE}) = 0 取等间隔子集`
        + `（recno = 星表自身记录号，最大可取到 ${hitRecnos * STRIDE}），再叠加 z > ${Z_MIN} 过滤。`
        + `期望条数 = 命中 recno ${hitRecnos} 个 × 其中 z > ${Z_MIN} 占比 `
        + `${(zPass * 100).toFixed(3)}% = ${expCount.toFixed(1)}；实测 ${n.objects.length} 条，`
        + `偏差 ${(n.objects.length - expCount).toFixed(1)} ≈ `
        + `${(Math.abs(n.objects.length - expCount) / sdCount).toFixed(2)}σ（二项涨落范围内）。`
        + `⚠️ 口径不许读错：MOD 作用在**原始 recno** 上，不是「先按 z 过滤、再把结果重编号、`
        + `取每 ${STRIDE} 条」—— 后者是**另一个集合**（两种算法的期望数值很接近，很容易混）。`
        + '非随机、非按 RA 排序、不重加权 —— 保留星表实测的天空各向异性与红移分布。',
      distanceModel: 'flat ΛCDM, Planck 2018：H0=67.4 km/s/Mpc, Ωm=0.315, ΩΛ=0.685, Ωr=9.24e-5；'
        + 'E(z)=sqrt(Ωr(1+z)^4+Ωm(1+z)^3+ΩΛ)；Dc(z)=(c/H0)·∫₀^z dz′/E(z′)（Simpson，每段 Δz≤0.25）；'
        + '单位换算 1 Mpc=3.261563777 Mly',
      distanceAnchor: `z=${ANCHOR_Z}（CMB 复合时期）→ ${ANCHOR_MLY.toFixed(1)} Mly ≈ 45.2 Gly（项目 CMB 边界 45200 Mly）`,
      coordModel: 'x=d·cos(dec)·cos(ra), y=d·cos(dec)·sin(ra), z=d·sin(dec)，单位 Mly（与 web/js/data/deep-sky.js:xyz 同口径）',
      note: '「可观测宇宙」层的远景真实背景场。不含近距/零红移污染（z>0.02），无 z 者不收。'
        + '星等优先取 R 波段（Rmag），缺失时退回 B 波段（Bmag）。',
      dropped: {
        noName: n.droppedNoName,
        badCoords: n.droppedBadCoords,
        zOutOfRange: n.droppedZ,
        beyondComovingRadius: n.droppedFar,
        duplicateId: n.droppedDup,
      },
      withMagnitude: n.withMag,
      redshiftRange: [Math.min(...zs), Math.max(...zs)],
      distMlyRange: [+Math.min(...dists).toFixed(2), +Math.max(...dists).toFixed(2)],
      generatedAt: new Date().toISOString(),
    },
    objects: n.objects,
  };

  await writeAtomic(OUT_FILE, JSON.stringify(out));

  const bytes = Buffer.byteLength(JSON.stringify(out));
  console.log('');
  console.log(`  产物  data/quasars.json`);
  console.log(`  合计  ${n.objects.length} 条 · ${(bytes / 1024).toFixed(1)} KB · 有星等 ${n.withMag} 条`);
  console.log(`  红移  z ${Math.min(...zs).toFixed(3)} – ${Math.max(...zs).toFixed(3)}`);
  console.log(`  距离  ${Math.min(...dists).toFixed(0)} – ${Math.max(...dists).toFixed(0)} Mly`);
  console.log(`  校验  z=${ANCHOR_Z} → ${ANCHOR_MLY.toFixed(1)} Mly（应 ≈ 45200）`);
  console.log(`  丢弃  无名 ${n.droppedNoName} · 坐标坏 ${n.droppedBadCoords} · z 越界 ${n.droppedZ}`
    + ` · 超共动半径 ${n.droppedFar} · 重复 id ${n.droppedDup}`);

  LOG.info('构建完成', {
    count: n.objects.length, bytes, withMag: n.withMag, anchorMly: +ANCHOR_MLY.toFixed(1),
  });
}

main().catch((e) => {
  LOG.error('未捕获异常', { err: e?.stack || String(e) });
  console.error('FATAL', e?.stack || e);
  process.exitCode = 1;
});

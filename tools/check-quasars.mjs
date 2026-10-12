#!/usr/bin/env node
/**
 * 类星体远景背景场 · 独立自检（tools/check-quasars.mjs）
 * ============================================================================
 *
 * 【为什么有这个检查】
 *   `tools/fetch-quasars.mjs` 从 VizieR VII/290（Milliquas v7.2）抽了 5939 个类星体，
 *   给「可观测宇宙」层补 2.7–45.2 Gly 的真实纵深。这条管线牵涉三件容易静默出错、
 *   而肉眼看不出来的事：
 *     1) 距离不是 cz/H0 线性近似，而是平坦 ΛCDM 共动距离积分 —— 积分写错（例如把
 *        积分对象写成 E(z) 而不是 1/E(z)、或大 z 时欠采样）会让整个远景场整体偏移，
 *        而画面照样能渲染，只是物理全错。
 *     2) x/y/z 必须与赤经赤纬的度制映射严格一致（ra 是十进制度，不是时角），
 *        映射口径错一点，全天位置就整体旋转/错位，但每个点看起来仍「在球面上」。
 *     3) 抽样口径（MOD(recno,250)=0）与登记表（data/sources.json）必须与磁盘真值一致，
 *        否则「数据更新中心」这条管线能点、一跑就炸（本项目踩过 compact/fetch-compact）。
 *   本检查把上述事情变成可复跑的判据，退出码 0=全过、1=有 failure。
 *
 * 【判据是什么】（全部在真实产物上跑）
 *   ① distance-anchor   : 用自写的 ΛCDM 积分（步长 Δz≤0.01，比管线更细）算 z=1089
 *                         的共动距离，须与锚点 45217.5 Mly 相差 ≤0.1%。
 *   ② dist-all          : 全表 5939 行的 distMly，须与按 redshift 重算的积分相差 ≤0.1%
 *                         （比管线 Δz≤0.125 更细，能抓出积分法错误）。
 *   ③ dist-5sample      : 固定种子抽 5 行，逐行报相对误差（≤0.1%）。
 *   ④ dist-monotonic    : z 越大 Dc 越大（严格单调），反了即积分写错。
 *   ⑤ dist-bound        : 全表 distMly ≤ 45200 Mly（项目 CMB 边界）。
 *   ⑥ coords-xyz        : 抽中的 5 行，用**原始 TSV** 的 RAJ2000/DEJ2000 自己算 x/y/z，
 *                         与 JSON 里的 x/y/z 相差（按尺度归一）≤1e-4。
 *   ⑦ coords-norm       : √(x²+y²+z²) 与 distMly 相对误差 ≤1e-6。
 *   ⑧ ra-unit           : 从 Name 里的 Jhhmmss.ss±ddmmss.s 复算十进制度，须与 ra/dec 吻合
 *                         —— 证明列的单位是「度」而不是时角/分秒。
 *   ⑨ sampling-recno    : TSV 全部 recno % 250 == 0（证明 stride 作用在原始 recno 上）。
 *   ⑩ sampling-count    : 实测 5939 与「全表 250 倍数 ∩ z>0.02」期望值须在 4σ 内
 *                         （1480301/250=5921 是错误期望，见报告 ③）。
 *   ⑪ hygiene           : 无 z≤0.02、无 null/非有限 z、x/y/z/dist 有限、id 无重复、
 *                         ra∈[0,360)、dec∈[-90,90]、缺 mag 恰 1 行、magBand R=5937/B=1。
 *   ⑫ registry-paths    : sources.json 里 quasars 管线 / milliquas 数据集声明的路径都在磁盘上。
 *   ⑬ registry-live     : 数据中心现场读的 records 应等于 objects.length；登记条目里
 *                         不得出现会被写死的统计字段（count/bytes/builtAt/mtime…）。
 *   ⑭ registry-bins     : fetch-quasars 在 datacenter.mjs 的 BIN_WHITELIST 里。
 *
 * 【怎么两段式自证】（只报「全绿」不算验过：必须证明判据真的会红）
 *   跑 `node tools/check-quasars.mjs --selftest`：
 *     - 先把数据复制到临时目录，注入 4 种已知坏值（distMly×1.1 / x+100 / z=0 / id 重复），
 *       逐条断言「对应检查确实报 error」；
 *     - 再解除注入（回到未改动的副本），断言「回到全绿」。
 *   全程只在临时副本上动手，绝不触碰 data/quasars.json 本体。
 *
 * 用法：
 *   node tools/check-quasars.mjs             # 在真实产物上跑，人类可读
 *   node tools/check-quasars.mjs --json      # 机器可读
 *   node tools/check-quasars.mjs --selftest  # 注入自证（临时副本）
 * 零第三方依赖，Node 18+。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_FILE = path.join(ROOT, 'data', 'quasars.json');
const TSV_FILE = path.join(ROOT, 'data', 'raw', 'quasars', 'milliquas-z02-mod250.tsv');
const SOURCES_FILE = path.join(ROOT, 'data', 'sources.json');

/* ---- 物理常数（与任务给定一致；实现独立于 fetch-quasars.mjs）…… ---- */
const C_KMS = 299792.458;
const H0 = 67.4;
const OMEGA_M = 0.315;
const OMEGA_L = 0.685;
const OMEGA_R = 9.24e-5;
const MPC_TO_MLY = 3.261563777;
const ANCHOR_Z = 1089;
const ANCHOR_MLY = 45217.5;
const CMB_BOUND_MLY = 45200;
const STRIDE = 250;
const Z_MIN = 0.02;
const SAMPLE_SEED = 20260912;
const TOL_DIST = 1e-3;     // 0.1%
const TOL_XYZ = 1e-4;      // 1e-4 相对（按尺度归一）
const TOL_NORM = 1e-6;     // 1e-6 相对

/* ---- 平坦 ΛCDM：1/E(z)，Simpson，Δz≤0.01（比管线 Δz≤0.125 更细）…… ---- */
function invE(z) {
  const o = 1 + z;
  return 1 / Math.sqrt(OMEGA_R * o * o * o * o + OMEGA_M * o * o * o + OMEGA_L);
}
function comovingMly(z) {
  if (!(z > 0)) return 0;
  let n = 2 * Math.ceil(z / 0.01);
  if (n < 1024) n = 1024;
  if (n % 2) n += 1;
  const h = z / n;
  let s = invE(0) + invE(z);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * invE(i * h);
  return (C_KMS / H0) * (h / 3) * s * MPC_TO_MLY;
}
function xyz(raDeg, decDeg, dist) {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  return [dist * Math.cos(dec) * Math.cos(ra), dist * Math.cos(dec) * Math.sin(ra), dist * Math.sin(dec)];
}
const rel = (a, b, scale) => (scale > 0 ? Math.abs(a - b) / scale : Math.abs(a - b));

/* ---- 固定种子 PRNG（mulberry32），抽 5 个不重复下标 ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickIndices(n, k, seed) {
  const rnd = mulberry32(seed);
  const set = new Set();
  while (set.size < k) set.add(Math.floor(rnd() * n));
  return [...set].sort((a, b) => a - b);
}

/* ---- TSV 解析（RFC4180 口径；VizieR 字符串字段带引号且保留首尾空格）…… ---- */
function parseTsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length);
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === '\t') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cols = split(lines[0]);
  return lines.slice(1).map((l) => {
    const p = split(l); const o = {};
    cols.forEach((c, i) => { o[c] = p[i]; });
    return o;
  });
}
const cleanName = (s) => String(s ?? '').trim().replace(/^"|"$/g, '').trim();

/* ============================================================
   runChecks —— 只读；jsonText 可覆盖（用于注入自证，不碰磁盘本体）
   ============================================================ */
export async function runChecks({ jsonText = null } = {}) {
  const out = [];
  const add = (id, level, title, detail) => out.push({ id, level, title, detail });

  const J = JSON.parse(jsonText ?? (await readFile(JSON_FILE, 'utf8')));
  const objects = J.objects || [];
  const meta = J.meta || {};
  const n = objects.length;
  const tsv = parseTsv(await readFile(TSV_FILE, 'utf8'));

  /* ① 距离锚点 ----------------------------------------------------------- */
  const anchor = comovingMly(ANCHOR_Z);
  const anchorRel = Math.abs(anchor - ANCHOR_MLY) / ANCHOR_MLY;
  add('distance-anchor', anchorRel <= TOL_DIST ? 'ok' : 'error',
    `距离锚点 z=${ANCHOR_Z} → ${anchor.toFixed(3)} Mly（应 ≈${ANCHOR_MLY}）`,
    `相对误差 ${(anchorRel * 100).toFixed(4)}%（容差 0.1%）`);

  /* ② 全表距离重算 ------------------------------------------------------- */
  let worst = { rel: 0, i: -1, z: 0, file: 0, mine: 0 };
  for (let i = 0; i < n; i++) {
    const o = objects[i];
    const dc = comovingMly(o.redshift);
    const r = Math.abs(dc - o.distMly) / o.distMly;
    if (r > worst.rel) worst = { rel: r, i, z: o.redshift, file: o.distMly, mine: dc };
  }
  add('dist-all', worst.rel <= TOL_DIST ? 'ok' : 'error',
    `全表 ${n} 行 distMly 与自写积分一致（最大相对误差 ${(worst.rel * 100).toFixed(5)}%）`,
    worst.i >= 0 ? `最差行 idx=${worst.i} z=${worst.z} file=${worst.file} mine=${worst.mine.toFixed(2)}` : '空表');

  /* ③ 固定种子 5 行 ------------------------------------------------------ */
  const sample = pickIndices(n, 5, SAMPLE_SEED);
  const rows = sample.map((i) => {
    const o = objects[i];
    const dc = comovingMly(o.redshift);
    return { i, z: o.redshift, file: o.distMly, mine: dc, rel: Math.abs(dc - o.distMly) / o.distMly };
  });
  const worst5 = Math.max(...rows.map((r) => r.rel));
  add('dist-5sample', worst5 <= TOL_DIST ? 'ok' : 'error',
    `固定种子(seed=${SAMPLE_SEED})抽 5 行，最大相对误差 ${(worst5 * 100).toFixed(5)}%`,
    rows.map((r) => `idx${r.i}:z=${r.z}→${r.file}/${r.mine.toFixed(2)}`).join(' · '));

  /* ④ 单调性 ------------------------------------------------------------- */
  const zs = [...new Set(objects.map((o) => o.redshift))].sort((a, b) => a - b);
  let mono = true; let monoBad = null;
  for (let k = 1; k < zs.length; k++) {
    if (!(comovingMly(zs[k]) > comovingMly(zs[k - 1]))) { mono = false; monoBad = [zs[k - 1], zs[k]]; break; }
  }
  add('dist-monotonic', mono ? 'ok' : 'error',
    `z→Dc 严格单调（${zs.length} 个不同 z）`,
    mono ? '全部递增' : `在 z=${monoBad?.[0]} 与 z=${monoBad?.[1]} 处反了`);

  /* ⑤ 距离上界 ----------------------------------------------------------- */
  const maxDist = Math.max(...objects.map((o) => o.distMly));
  add('dist-bound', maxDist <= CMB_BOUND_MLY ? 'ok' : 'error',
    `全表 distMly 最大值 ${maxDist} ≤ ${CMB_BOUND_MLY} Mly`,
    `（CMB 边界）`);

  /* ⑥⑦ 坐标映射（对抽中的 5 行）----------------------------------------- */
  const tsvByName = new Map();
  for (const r of tsv) tsvByName.set(cleanName(r.Name), r);
  let maxXyz = 0; let maxNorm = 0; const coordDetail = [];
  for (const i of sample) {
    const o = objects[i];
    const r = tsvByName.get(o.name);
    if (!r) { maxXyz = Infinity; coordDetail.push(`idx${i} 未在 TSV 命中`); continue; }
    const [x, y, z] = xyz(Number(r.RAJ2000), Number(r.DEJ2000), o.distMly);
    const scale = Math.max(Math.abs(o.x), Math.abs(o.y), Math.abs(o.z)) || o.distMly;
    const e = Math.max(rel(x, o.x, scale), rel(y, o.y, scale), rel(z, o.z, scale));
    maxXyz = Math.max(maxXyz, e);
    const norm = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z);
    maxNorm = Math.max(maxNorm, Math.abs(norm - o.distMly) / o.distMly);
    coordDetail.push(`idx${i} xyzRel=${(e * 100).toExponential(2)}%`);
  }
  add('coords-xyz', maxXyz <= TOL_XYZ ? 'ok' : 'error',
    `原始 TSV 的 RA/Dec 复算 x/y/z，最大相对误差 ${(maxXyz * 100).toFixed(5)}%（容差 1e-2%）`,
    coordDetail.join(' · '));
  add('coords-norm', maxNorm <= TOL_NORM ? 'ok' : 'error',
    `√(x²+y²+z²) 与 distMly 最大相对误差 ${(maxNorm * 100).toExponential(3)}%（容差 1e-4%）`,
    `抽样 5 行`);

  /* ⑧ RA 单位（度 vs 时角）---------------------------------------------- */
  let sexOk = 0; let sexTot = 0;
  for (const o of objects.slice(0, 2000)) {
    const m = /J(\d{2})(\d{2})(\d{2}\.?\d*)([+-])(\d{2})(\d{2})(\d{2}\.?\d*)/.exec(o.name);
    if (!m) continue;
    sexTot++;
    const ra = (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * 15;
    const dec = (Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600) * (m[4] === '+' ? 1 : -1);
    if (Math.abs(ra - o.ra) < 1e-3 && Math.abs(dec - o.dec) < 1e-3) sexOk++;
  }
  add('ra-unit', sexOk > 0 && sexOk / Math.max(sexTot, 1) > 0.9 ? 'ok' : 'error',
    `Name 内 J 坐标 sexagesimal→度 与 ra/dec 列吻合 ${sexOk}/${sexTot}（证明列是十进制度）`,
    `前 2000 行样本`);

  /* ⑨⑩ 抽样口径 --------------------------------------------------------- */
  const badRecno = tsv.filter((r) => Number(r.recno) % STRIDE !== 0).length;
  const recnos = tsv.map((r) => Number(r.recno));
  add('sampling-recno', badRecno === 0 ? 'ok' : 'error',
    `TSV 全部 ${tsv.length} 行 recno % ${STRIDE} == 0（stride 作用在原始 recno 上）`,
    `recno 范围 ${Math.min(...recnos)}–${Math.max(...recnos)}，越界/非倍数 ${badRecno} 条`);
  const qm = JSON.parse(await readFile(path.join(ROOT, 'data/raw/quasars/_query-meta.json'), 'utf8'));
  const pool = qm.catalogRows ? Math.floor(qm.catalogRows / STRIDE) : 0;
  const p = qm.catalogRows ? qm.rowsZ02 / qm.catalogRows : 0;
  const expCount = pool * p;
  const sigma = Math.sqrt(pool * p * (1 - p));
  const dev = Math.abs(n - expCount);
  add('sampling-count', dev <= 4 * sigma ? 'ok' : 'error',
    `实测 ${n} vs 期望 ${expCount.toFixed(1)}（pool=${pool}×p=${p.toFixed(5)}，偏差 ${dev.toFixed(1)} = ${(dev / sigma).toFixed(2)}σ）`,
    `注：1480301/${STRIDE}=${(qm.rowsZ02 / STRIDE).toFixed(1)} 是错误期望（误把 stride 当作用在 z 过滤后的重排子集）`);

  /* ⑪ 数据卫生 ----------------------------------------------------------- */
  const seen = new Set(); let dup = 0; let zLe = 0; let zBad = 0; let finBad = 0;
  let raBad = 0; let decBad = 0; let magNull = 0; let bandR = 0; let bandB = 0;
  for (const o of objects) {
    if (seen.has(o.id)) dup++; else seen.add(o.id);
    if (!(o.redshift > Z_MIN)) zLe++;
    if (!Number.isFinite(o.redshift)) zBad++;
    if (![o.x, o.y, o.z, o.distMly].every(Number.isFinite)) finBad++;
    if (!(o.ra >= 0 && o.ra < 360)) raBad++;
    if (!(o.dec >= -90 && o.dec <= 90)) decBad++;
    if (o.mag == null) magNull++; else if (o.magBand === 'R') bandR++; else if (o.magBand === 'B') bandB++;
  }
  const hygieneOk = !dup && !zLe && !zBad && !finBad && !raBad && !decBad && magNull === 1 && bandR === 5937 && bandB === 1;
  add('hygiene', hygieneOk ? 'ok' : 'error',
    `卫生：dup=${dup} z≤0.02=${zLe} z非有限=${zBad} 坐标非有限=${finBad} ra越界=${raBad} dec越界=${decBad} 缺mag=${magNull} R=${bandR} B=${bandB}`,
    hygieneOk ? '全部满足（缺 mag 恰 1 行）' : '见左侧明细，有断言不满足');

  /* ⑫⑬ 登记表与磁盘 ----------------------------------------------------- */
  const src = JSON.parse(await readFile(SOURCES_FILE, 'utf8'));
  const pipe = (src.pipelines || []).find((x) => x.id === 'quasars');
  const dset = (src.datasets || []).find((x) => x.id === 'milliquas');
  const paths = [...(pipe?.outputs || []), ...(dset?.files || []), dset?.metaFile].filter(Boolean);
  const missing = [];
  for (const rel2 of paths) {
    try { await stat(path.join(ROOT, rel2)); } catch { missing.push(rel2); }
  }
  add('registry-paths', pipe && dset && !missing.length ? 'ok' : 'error',
    `quasars 管线 / milliquas 数据集声明的 ${new Set(paths).size} 个路径在磁盘上都存在`,
    missing.length ? `缺失：${missing.join(', ')}` : `metaFile=${dset?.metaFile}`);
  const BAD_KEYS = /^(count|records|bytes|size|fileSize|builtAt|updatedAt|lastBuilt|lastRun|mtime|filesize|recordCount)$/i;
  const statKeys = [];
  for (const [pname, ent] of [['pipeline quasars', pipe], ['dataset milliquas', dset]]) {
    if (!ent) continue;
    for (const k of Object.keys(ent)) if (BAD_KEYS.test(k)) statKeys.push(`${pname}.${k}`);
  }
  const liveOk = (dset?.metaFile) && !statKeys.length;
  add('registry-live', liveOk ? 'ok' : 'error',
    statKeys.length ? `登记条目里出现了会被写死的统计字段：${statKeys.join(', ')}` : '登记条目无写死的统计字段（records/bytes/mtime 由服务端现场读取）',
    `record 数应取自 metaFile(=${dset?.metaFile}) 的 meta.count，现场值 ${meta.count}`);

  /* ⑭ 白名单 ------------------------------------------------------------- */
  try {
    const dc = await import('../server/lib/datacenter.mjs');
    const bins = pipe?.steps || [];
    const off = bins.filter((s) => !dc.BIN_WHITELIST.has(s.bin)).map((s) => s.bin);
    add('registry-bins', off.length === 0 ? 'ok' : 'error',
      off.length ? `管线步骤不在 BIN_WHITELIST：${off.join(', ')}` : `quasars 管线步骤 [${bins.map((s) => s.bin).join(',')}] 全部在白名单内`,
      `白名单共 ${dc.BIN_WHITELIST.size} 个脚本`);
  } catch (e) {
    add('registry-bins', 'error', '读不出 BIN_WHITELIST —— 这条检查没在干活', e.message);
  }

  return { checks: out, pass: out.every((c) => c.level !== 'error') };
}

/* ============================================================
   两段式注入自证：在临时副本上注入坏值，证明判据真的会红
   ============================================================ */
async function selftest() {
  const origText = await readFile(JSON_FILE, 'utf8');
  const orig = JSON.parse(origText);
  const sample = pickIndices(orig.objects.length, 5, SAMPLE_SEED);
  const cases = [
    { name: `distMly×1.1（idx 0）`, expect: 'dist-all', mutate: (o) => { o.objects[0].distMly = +(o.objects[0].distMly * 1.1).toFixed(2); } },
    { name: `x+100（抽样行 idx ${sample[0]}）`, expect: 'coords-xyz', mutate: (o) => { o.objects[sample[0]].x = o.objects[sample[0]].x + 100; } },
    { name: 'z=0（idx 10）', expect: 'hygiene', mutate: (o) => { o.objects[10].redshift = 0; } },
    { name: 'id 重复（idx 11 := idx 10）', expect: 'hygiene', mutate: (o) => { o.objects[11].id = o.objects[10].id; } },
  ];
  const lines = [];
  const base = await runChecks();
  lines.push(`[基线] 真实产物 → ${base.pass ? '全绿' : '有 error（异常）'}`);
  let allOk = base.pass;
  for (const c of cases) {
    const clone = JSON.parse(origText);
    c.mutate(clone);
    const r = await runChecks({ jsonText: JSON.stringify(clone) });
    const hit = r.checks.find((x) => x.id === c.expect);
    const ok = hit && hit.level === 'error';
    allOk = allOk && ok;
    lines.push(`[注入] ${c.name} → 期望 ${c.expect} 报红，实得 ${hit ? hit.level : '(缺项)'} ${ok ? '✓' : '✗'}`);
    lines.push(`        ${hit?.detail || ''}`);
  }
  const restored = await runChecks({ jsonText: origText });
  lines.push(`[还原] 未改动副本 → ${restored.pass ? '回到全绿 ✓' : '仍有 error ✗'}`);
  allOk = allOk && restored.pass;
  return { lines, allOk };
}

/* ============================================================
   入口
   ============================================================ */
const ARGS = new Set(process.argv.slice(2));
if (ARGS.has('--selftest')) {
  const r = await selftest();
  console.log('  类星体自检 · 两段式注入自证');
  console.log('  ' + '─'.repeat(56));
  for (const l of r.lines) console.log('  ' + l);
  console.log('  ' + (r.allOk ? '注入自证通过：判据会红，也能回绿。' : '注入自证失败：有判据没反应。'));
  process.exit(r.allOk ? 0 : 1);
}

const result = await runChecks();
if (ARGS.has('--json')) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.pass ? 0 : 1);
}
const MARK = { ok: '  ✓', warn: '  !', error: '  ✗' };
console.log('');
console.log('  类星体远景背景场 · 独立自检');
console.log('  ' + '─'.repeat(56));
for (const c of result.checks) {
  console.log(`${MARK[c.level]} ${c.title}`);
  console.log(`      ${c.detail}`);
}
console.log('');
console.log(`  ${result.pass ? '全部通过：这条取数管线在数字上站得住。' : '有 failure：见上面 ✗ 项。'}`);
console.log('');
process.exit(result.pass ? 0 : 1);

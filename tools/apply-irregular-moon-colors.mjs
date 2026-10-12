/**
 * 按「动力学族 + 颜色指数」为 82 颗不规则卫星生成真实颜色，并写回 moons.js
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么必须是脚本而不是手改
 * ══════════════════════════════════════════════════════════════
 * 1. 82 个颜色值必须**可复现**：它们由族定义 + 色指数 + 确定性哈希推出，
 *    手改一次就再也对不上生成逻辑，等于把数据变成了"某次手抖的结果"。
 * 2. 写回的是**位置敏感的表**（moons.js 是 11 元组数组），
 *    正则替换必须保证每行**恰好一个** hex，否则静默改错行。
 * 3. 生成值要能被独立的检查器（tools/check-body-colors.mjs）复核：
 *    检查器重跑同一套逻辑，比对文件里的 hex 是否等于生成值。
 *
 * 用法：
 *   node tools/apply-irregular-moon-colors.mjs --dry     只打印，不写
 *   node tools/apply-irregular-moon-colors.mjs           写回（先备份）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

const { FAMILIES, FAMILY_OF, FAMILY_SPREAD, effectiveSpread, hashUnit, KALYKE_SPECTRUM, KALYKE_INDICES, albedoOf } =
  await import(pathToFileURL(path.join(ROOT, 'web/js/color/moon-families.js')).href);
const { indicesToSpectrum, perturbIndices, SOLAR_INDICES } = await import(
  pathToFileURL(path.join(ROOT, 'web/js/color/indices-to-spectrum.js')).href);
const { spectrumToRender } = await import(
  pathToFileURL(path.join(ROOT, 'web/js/color/cie.js')).href);
const { MOONS } = await import(pathToFileURL(path.join(ROOT, 'web/js/data/moons.js')).href);

/* ---------- 1. 为每颗不规则卫星算色 ---------- */
/**
 * 返回 { id, family, hex, k, confidence, note }
 *
 * 亮度锚定：族级分类学反照率。个别天体有实测反照率时**优先用它**
 * （如 Nereid 0.155 是实测，不该被族档 0.055 覆盖）。
 */
function colourOf(m) {
  const famId = FAMILY_OF[m.id];
  if (!famId) return null;
  const f = FAMILIES[famId];

  // Kalyke：显式谱，不走拟合（见 moon-families.js 说明）
  if (m.id === 'kalyke') {
    const hex = spectrumToRender(normalise(KALYKE_SPECTRUM, f.albedo)).hex;
    return {
      id: m.id, family: famId, hex, k: NaN, confidence: 0.35,
      note: '非单斜率：Δ(B−V)=+0.05 但 Δ(V−R)=+0.59，用分段谱忠实还原',
    };
  }

  // 亮度：实测优先，否则用**族分类学反照率档内的逐星值**
  // ⚠️ 不能只用族级中值 —— 那会让同族全体算出同一个 Y，
  //    经 8 位 sRGB 编码后塌成同一个 hex（假多样性）。见 moon-families.js `albedoOf`。
  const albedo = (typeof m.albedo === 'number' && m.albedo > 0) ? m.albedo : albedoOf(m.id, f);

  // 族内确定性微扰（异质族幅度大，同质族幅度小）
  // ⚠️ 必须用 effectiveSpread —— 它把声明幅度压到"不超过到最近邻族距离的一半"，
  //    否则异质族的抖动会把自己人抖进邻族的颜色区间（跨族顺序反转）。
  const spread = effectiveSpread(famId);
  const { bv, vr } = perturbIndices(f.bv, f.vr, hashUnit(m.id) * spread);
  const r = indicesToSpectrum(bv, vr, albedo);
  const hex = spectrumToRender(r.grid).hex;
  const confidence = r.agree <= 0.5 ? (spread > 0.3 ? 0.55 : 0.7) : 0.35;
  return { id: m.id, family: famId, hex, k: r.k, confidence, note: '', albedo };
}

/** 把控制点谱归一到指定反照率（Kalyke 用） */
function normalise(points, geoAlbedo) {
  const { SPEC_LAMBDA_MIN, SPEC_LAMBDA_STEP, SPEC_LAMBDA_MAX } =
    globalThis.__spec ?? {};
  // 直接用 indices-to-spectrum 的栅格尺寸约定：380..780/5
  const n = Math.round((780 - 380) / 5) + 1;
  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lam = 380 + i * 5;
    if (lam <= points[0][0]) { grid[i] = points[0][1]; continue; }
    const last = points[points.length - 1];
    if (lam >= last[0]) { grid[i] = last[1]; continue; }
    let j = 0;
    while (j < points.length - 1 && points[j + 1][0] < lam) j++;
    const [l0, v0] = points[j], [l1, v1] = points[j + 1];
    grid[i] = v0 + (v1 - v0) * (lam - l0) / (l1 - l0);
  }
  // 用 V 通带把亮度缩到 geoAlbedo（与 indices-to-spectrum 同口径）
  const { spectrumToRender: _sr } = {};
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const lam = 380 + i * 5;
    const t = Math.exp(-0.5 * ((lam - 545) / (84 / 2.3548)) ** 2);
    const w = t * lam;
    num += grid[i] * w; den += w;
  }
  const fV = den > 0 ? num / den : 1;
  const k = fV > 0 ? geoAlbedo / fV : 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = grid[i] * k;
  return out;
}

const results = [];
for (const m of MOONS) {
  if (m.grp !== 'irregular') continue;
  const c = colourOf(m);
  if (c) results.push(c);
}

/* ---------- 2. 写回 moons.js（位置敏感，必须逐行、恰好一个 hex） ---------- */
const MOONS_PATH = path.join(ROOT, 'web/js/data/moons.js');
let src = fs.readFileSync(MOONS_PATH, 'utf8');

const byId = new Map(results.map(r => [r.id, r]));
let changed = 0;
const log = [];

const lines = src.split('\n');
const outLines = lines.map((line, idx) => {
  if (!line.trimStart().startsWith('[')) return line;
  // 取出该行第 1 个单引号字段 = id
  const idm = line.match(/^\s*\[\s*'([^']+)'/);
  if (!idm) return line;
  const id = idm[1];
  const c = byId.get(id);
  if (!c) return line;

  // 该行的 hex 必须**恰好一个**
  const hexes = line.match(/'#[0-9a-fA-F]{6}'/g);
  if (!hexes || hexes.length !== 1) {
    throw new Error(`[moons.js:${idx + 1}] ${id} 行内 hex 数 = ${hexes ? hexes.length : 0}，期望恰好 1 个 —— 拒绝替换`);
  }
  if (hexes[0].toLowerCase() === `'${c.hex.toLowerCase()}'`) return line;
  log.push(`${id.padEnd(15)} ${hexes[0]} → '${c.hex}'   ${c.family.padEnd(14)} k=${Number.isNaN(c.k) ? 'n/a' : c.k.toFixed(3)} conf=${c.confidence.toFixed(2)}`);
  changed++;
  return line.replace(hexes[0], `'${c.hex}'`);
});

if (changed === 0) {
  console.log('没有任何行需要改（颜色已是最新）。');
} else {
  const outSrc = outLines.join('\n');
  if (DRY) {
    console.log(`[dry-run] 将修改 ${changed} 行：\n` + log.join('\n'));
  } else {
    const bak = MOONS_PATH + '.bak-famcolor';
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, src);
    fs.writeFileSync(MOONS_PATH, outSrc);
    console.log(`已写回 ${changed} 行 → web/js/data/moons.js（备份 ${path.basename(bak)}）\n` + log.join('\n'));
  }
}

/* ---------- 3. 汇总 ---------- */
const famCount = {};
for (const r of results) famCount[r.family] = (famCount[r.family] || 0) + 1;
console.log(`\n不规则卫星总数 ${results.length}，覆盖 ${Object.keys(famCount).length} 个族：`);
for (const [k, v] of Object.entries(famCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${v} 颗  （${FAMILIES[k].zh}，${FAMILIES[k].colorClass}）`);
}
const uniq = new Set(results.map(r => r.hex));
console.log(`\n不同颜色数：${uniq.size} / ${results.length} 颗 —— 原先是 3 个`);

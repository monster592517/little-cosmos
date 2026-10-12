/**
 * 校验：把所有天体光谱过一遍 CIE 内核，检查输出颜色是否符合
 * 独立观测到的"人眼描述"。
 *
 * ⚠️ 这个校验的要点不是"输出好看"，而是**输出必须能被独立证据证伪**。
 *    所以每条断言都带一个来自文献的人眼描述，而不是"我觉得应该这样"。
 *
 * ⚠️ 两个模式必须分开测：
 *    · 色板模式 spectrumToHex   —— 归一化亮度，测「色相对不对」
 *    · 渲染模式 spectrumToRender —— 保留亮度，测「亮暗关系对不对」
 *    混在一起测会两边都是错的。见 cie.js 里的说明。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// 项目根从**本文件自己的位置**推导（`tools/` 的上一级），不写死绝对路径。
// ⚠️ 这里曾经写死成一个绝对路径（`C:/Users/<用户名>/Desktop/<项目文件夹>`）：
//    工作区一改名、或者便携包被解到别处，脚本不会报错，
//    它会**安静地在那个不存在的路径上找文件**。见 `坑与雷点.md` 坑 93。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cie = await import(pathToFileURL(path.join(ROOT, 'web/js/color/cie.js')).href);
const spectraMod = await import(pathToFileURL(path.join(ROOT, 'web/js/color/spectra.js')).href);
const { spectrumToHex, spectrumToRender } = cie;
const { SPECTRA, pointsToGrid, renderSpectrum } = spectraMod;

const hexToRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : Math.round(((mx - mn) / mx) * 100);
};

const rows = [];
for (const [id, e] of Object.entries(SPECTRA)) {
  // 色板模式用原始形状（只看色相，不看绝对亮度）
  const shape = pointsToGrid(e.points);
  // 渲染模式用归一化到几何反照率的谱（亮度必须是权威值）
  const norm = renderSpectrum(id);
  const hex = spectrumToHex(shape).hex;
  const rHex = spectrumToRender(norm, { exposure: 1 }).hex;
  const rgb = hexToRgb(hex);
  const rRgb = hexToRgb(rHex);
  rows.push({
    id, zh: e.zh, hex, rgb, sat: sat(rgb), luma: +luma(rgb).toFixed(1),
    rHex, rRgb, rLuma: +luma(rRgb).toFixed(1), rSat: sat(rRgb),
    y: cie.spectrumToXYZ(norm).Y,
    src: e.src, conf: e.conf, geoAlbedo: e.geoAlbedo,
  });
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const padS = (s, n) => String(s).padStart(n, ' ');
console.log('=== 色板模式（归一化亮度，测色相）===');
console.log(pad('ID', 16) + pad('中文名', 12) + pad('HEX', 10) + padS('饱和', 6) + padS('亮度', 7) + padS('置信', 6));
console.log('-'.repeat(58));
for (const r of [...rows].sort((a, b) => b.sat - a.sat)) {
  console.log(pad(r.id, 16) + pad(r.zh, 12) + pad(r.hex, 10) + padS(r.sat + '%', 6) + padS(r.luma, 7) + padS(r.conf, 6));
}

console.log('\n=== 渲染模式（保留亮度，测亮暗关系）===');
console.log(pad('ID', 16) + pad('中文名', 12) + pad('HEX', 10) + padS('饱和', 6) + padS('亮度', 7));
console.log('-'.repeat(52));
for (const r of [...rows].sort((a, b) => b.rLuma - a.rLuma)) {
  console.log(pad(r.id, 16) + pad(r.zh, 12) + pad(r.rHex, 10) + padS(r.rSat + '%', 6) + padS(r.rLuma, 7));
}

/* ==============================================================
   断言：每条都引用独立的人眼观测描述
   ============================================================== */
const P = Object.fromEntries(rows.map((r) => [r.id, { hex: r.hex, rgb: r.rgb, sat: r.sat, luma: r.luma }]));
const R = Object.fromEntries(rows.map((r) => [r.id, { hex: r.rHex, rgb: r.rRgb, sat: r.rSat, luma: r.rLuma }]));
const checks = [];
const chk = (name, ok, detail) => checks.push({ name, ok, detail });

/* ---- A 组：色相正确性（色板模式） ---- */
{
  const v = P.venus;
  chk('A1 金星：偏暖但很淡（R>B 且饱和 < 35%）',
    v.rgb[0] > v.rgb[2] && v.sat < 35,
    `${v.hex} 饱和${v.sat}% R-B=${v.rgb[0] - v.rgb[2]}（文献：圆面近白淡黄，非 80% 饱和）`);
}
{
  const m = P.mars;
  chk('A2 火星：明显红棕（R-B > 60 且饱和 > 40%）',
    m.rgb[0] - m.rgb[2] > 60 && m.sat > 40,
    `${m.hex} 饱和${m.sat}% R-B=${m.rgb[0] - m.rgb[2]}（文献：distinctive reddish / ochre）`);
}
{
  const u = P.uranus;
  chk('A3 天王星：青色（B >= R），绝不偏黄',
    u.rgb[2] >= u.rgb[0],
    `${u.hex} R=${u.rgb[0]} G=${u.rgb[1]} B=${u.rgb[2]}（Irwin 2024: greenish blue）`);
}
{
  const n = P.neptune, u = P.uranus;
  chk('A4 海王星：青蓝且色相不弱于天王星',
    n.rgb[2] > n.rgb[0] && Math.abs(n.rgb[2] - n.rgb[0] - (u.rgb[2] - u.rgb[0])) < 15,
    `海王星B-R=${n.rgb[2] - n.rgb[0]}，天王星B-R=${u.rgb[2] - u.rgb[0]}（Irwin 2024: 相似，海王星只稍蓝）`);
}
{
  const n = P.neptune, u = P.uranus;
  const d = Math.max(...[0, 1, 2].map((i) => Math.abs(n.rgb[i] - u.rgb[i])));
  chk('A5 海王星与天王星颜色必须接近（通道最大差 < 60）',
    d < 60,
    `最大通道差 ${d}（Voyager 旧图两者差异极大，那才是错的）`);
}
{
  const i = P.io;
  // 判据锚在光谱斜率上，不用「饱和度 > 40%」这种我编的数字。
  // Io 红/蓝反照率比 = 0.71/0.20 ≈ 3.5，与火星同量级，因此色相强度应接近火星。
  const r = i.rgb[0] - i.rgb[2];
  chk('A6 木卫一：明显黄色（R>G>B，且 R-B 与火星同量级 60–130）',
    i.rgb[0] >= i.rgb[1] && i.rgb[1] > i.rgb[2] && r > 60 && r < 130,
    `${i.hex} 饱和${i.sat}% R-B=${r}（文献：sulfur yellow。红/蓝反照率比≈3.5，与火星 3.1 同量级）`);
}
{
  const m = P.moon_mare;
  chk('A7 月海：接近中性（饱和 < 25%）',
    m.sat < 25,
    `${m.hex} 饱和${m.sat}%（文献：色彩极淡，肉眼近灰）`);
}
{
  const t = P.titan;
  // Titan 红/蓝反照率比 ≈ 0.298/0.148 ≈ 2.0，明显弱于火星 3.1 —— 所以
  // 它的 R-B 本该小于火星，判据锚在这个区间而不是一个绝对值。
  const rb = t.rgb[0] - t.rgb[2];
  chk('A8 土卫六：橙色系（R-B 在 25–60，弱于火星但明显偏暖）',
    rb > 25 && rb < 60,
    `${t.hex} R-B=${rb}（文献：tholin haze, orange-brown。红/蓝反照率比≈2.0，弱于火星 3.1）`);
}
{
  const j = P.jupiter_zone, s = P.saturn, u = P.uranus;
  chk('A9 木星/土星必须比冰巨星暖（R-B 更大）',
    (j.rgb[0] - j.rgb[2]) > (u.rgb[0] - u.rgb[2]) && (s.rgb[0] - s.rgb[2]) > (u.rgb[0] - u.rgb[2]),
    `木星R-B=${j.rgb[0] - j.rgb[2]} 土星R-B=${s.rgb[0] - s.rgb[2]} > 天王星R-B=${u.rgb[0] - u.rgb[2]}`);
}

/* ---- B 组：亮度正确性（渲染模式） ----
   ⚠️ 重要教训：亮度关系要用**线性 Y（反照率）**判，不能用 sRGB 编码后的
      差值判。sRGB 伽马会把线性差压缩：0.08 与 0.23 编码后是 79.9 与 131.8，
      差只有 51.9，而线性比是 0.35。我一开始把阈值写成「编码后差 > 60」，
      这不是物理判据，是我编的数字 —— 见 坑与雷点.md「别用自己编的魔数当判据」。
      现在统一改成：先取回 xyz.Y（线性反照率），再比线性比值。 */
const linY = {};
for (const r of rows) linY[r.id] = r.y;
const rel = (a, b) => linY[a] / linY[b]; // 线性反照率比

{
  const r = rel('enceladus', 'moon_mare');
  chk('B1 冰卫星线性反照率必须远超月海（比 > 8）',
    r > 8,
    `Enceladus/月海 = ${r.toFixed(1)}（文献：Enceladus ~1.0，月海 ~0.08 → 应约 12）`);
}
{
  const r = rel('moon_highland', 'moon_mare');
  chk('B2 月球高地/月海 线性反照率比必须在 2.3–3.5 之间',
    r > 2.3 && r < 3.5,
    `高地/月海 = ${r.toFixed(2)}（Marquardt 1976 表 I：高地 20–28% ÷ 月海 7.5–9% = 2.4–3.5）`);
}
{
  const r = rel('jupiter_zone', 'jupiter_belt');
  chk('B3 木星亮带/暗带 线性反照率比必须在 1.4–1.9 之间',
    r > 1.4 && r < 1.9,
    `亮带/暗带 = ${r.toFixed(2)}（EPIC 551nm 实测 0.779；暗带按同波长缩比）`);
}
{
  const y = linY.moon_mare;
  chk('B4 月海线性反照率必须落在 0.06–0.11（实测区间）',
    y > 0.06 && y < 0.11,
    `Y = ${y.toFixed(4)}（Marquardt 1976 表 I：成熟月海土 7.5–9%）`);
}
{
  const y = linY.venus;
  chk('B5 金星线性反照率必须锚在几何反照率 0.689（±5%）',
    Math.abs(y - 0.689) / 0.689 < 0.05,
    `Y = ${y.toFixed(4)}（目标 0.689，Mallama 2006 Icarus 182,10 / 2017 Icarus 282,19）`);
}
{
  const y = linY.enceladus;
  chk('B6 土卫二线性反照率必须锚在 1.375（±5%，可 >1 因强背散射）',
    Math.abs(y - 1.375) / 1.375 < 0.05,
    `Y = ${y.toFixed(4)}（目标 1.375，Dyudina 2016 表4 / Mallama 2017）`);
}
{
  // 所有条目都必须锚在自己的 geoAlbedo 上 —— 这是归一化的自检
  let worst = null;
  for (const r of rows) {
    if (!(r.geoAlbedo > 0)) continue;
    const d = Math.abs(r.y - r.geoAlbedo) / r.geoAlbedo;
    if (!worst || d > worst.d) worst = { id: r.id, d, y: r.y, g: r.geoAlbedo };
  }
  chk('B7 所有天体归一化后必须锚在各自 geoAlbedo（偏差 < 6%）',
    worst.d < 0.06,
    `最大偏差 ${(worst.d * 100).toFixed(1)}% @ ${worst.id}（实际 ${worst.y.toFixed(4)} vs 目标 ${worst.g}）`);
}
{
  const r = rel('ganymede', 'titan');
  chk('B7 木卫三/土卫六 线性反照率比必须 > 1.5（冰壳 vs 霾层）',
    r > 1.5,
    `木卫三/土卫六 = ${r.toFixed(2)}（文献：Ganymede ~0.43，Titan ~0.24）`);
}
{
  const ys = Object.values(linY);
  const spread = Math.max(...ys) / Math.min(...ys);
  chk('B8 线性反照率必须有足够动态范围（最亮/最暗 > 10）',
    spread > 10,
    `跨度 ${spread.toFixed(1)}×（最亮 ${Math.max(...ys).toFixed(3)}，最暗 ${Math.min(...ys).toFixed(3)}）`);
}
{
  // 渲染模式下不能出现「因为单通道超界而洗白」——即饱和度必须等于色板模式
  let worst = null;
  for (const id of Object.keys(SPECTRA)) {
    const d = Math.abs(P[id].sat - R[id].sat);
    if (!worst || d > worst.d) worst = { id, d };
  }
  chk('B9 渲染模式与色板模式的饱和度必须一致（差 ≤ 2%）',
    worst.d <= 2,
    `最大差 ${worst.d}% @ ${worst.id}（若不一致 = 单通道裁切在洗掉颜色，是 bug）`);
}

const pass = checks.filter((c) => c.ok).length;
console.log(`\n=== 物理合理性断言  ${pass}/${checks.length}  ===`);
let group = '';
for (const c of checks) {
  const g = c.name[0];
  if (g !== group) { group = g; console.log(`\n  【${g === 'A' ? '色相正确性（色板模式）' : '亮度正确性（渲染模式）'}】`); }
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.slice(3)}`);
  console.log(`      ${c.detail}`);
}
if (pass !== checks.length) {
  console.log('\n>>> 有断言未通过');
  process.exitCode = 1;
} else {
  console.log('\n>>> 全部通过');
}

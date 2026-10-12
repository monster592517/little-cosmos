/**
 * 校验：太阳材质输出的颜色必须是物理正确的「近白微暖」，
 * 且临边昏暗与色球红边的相对强度必须正确。
 *
 * ⚠️ 为什么单独为太阳写一个检查：它踩过两次坑，而且**两次都是
 *    「看着对、其实错」** —— shader 不报错，只是颜色不对。
 *    · 第一次 uBoost=1.85 → 输出 #ffc84e（过饱和橙黄，R 被裁）
 *    · 第二次 把自发光体当反射体 → 中心 #d29271（暗橙），边缘比中心亮
 *    这两次都不会抛异常，只能靠**算出来比对**发现。
 *
 * 这个文件**不依赖 WebGL**，纯 JS 复现 shader 的算术。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// 项目根从**本文件自己的位置**推导（`tools/` 的上一级），不写死绝对路径 —— 同 `check-spectra.mjs`，
// 写死路径会让工作区改名或换机器时静默跑到不存在的目录上。见 `坑与雷点.md` 坑 87。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cie = await import(pathToFileURL(path.join(ROOT, 'web/js/color/cie.js')).href);

/* ---- shader 的常量必须与 builders.js 保持一致 ----
 * ⚠️ builders.js 依赖 three，node 里直接 import 会失败，所以**解析源码**
 *    把常量抠出来。这样做的代价是：如果常量改名，本检查会**报错退出**
 *    （而不是静默用错值）—— 这是有意的，见 pick() 的行为。
 *    这就是「豁免要自证、判据要能被证伪」的做法。 */
import fs from 'node:fs';
const builderSrc = fs.readFileSync(path.join(ROOT, 'web/js/objects/builders.js'), 'utf8');

/** 从源码里取一个 `export const NAME = 数值;` */
const pickConst = (name) => {
  const re = new RegExp(`export const ${name}\\s*=\\s*([\\d.]+)`);
  const m = builderSrc.match(re);
  if (!m) throw new Error(`在 builders.js 里找不到常量 ${name} —— 本检查必须同步`);
  return parseFloat(m[1]);
};
/** 从源码里取一个 shader 里的数值字面量 */
const pickExpr = (re, name) => {
  const m = builderSrc.match(re);
  if (!m) throw new Error(`在 builders.js 的 shader 里找不到 ${name}（正则 ${re}）—— 本检查必须同步`);
  return parseFloat(m[1]);
};

const U_EMISSION = pickConst('SUN_EMISSION');
const U_STRUCTURE = pickExpr(/uStructure:\s*\{\s*value:\s*([\d.]+)\s*\}/, 'uStructure');
const TINT = (builderSrc.match(/SUN_TINT\s*=\s*\[([^\]]+)\]/) || [])[1]
  ?.split(',').map((s) => parseFloat(s.trim()));
const TARGET = (builderSrc.match(/SUN_TARGET_HEX\s*=\s*'([^']+)'/) || [])[1];
const LIMB_K = pickExpr(/\*=\s*1\.0\s*-\s*([\d.]+)\s*\*\s*pow\(limb,\s*1\.8\)/, '临边昏暗系数');
const CHROMO_K = pickExpr(/pow\(limb,\s*6\.0\)\s*\*\s*([\d.]+)/, '色球项系数');

if (!TINT || TINT.length !== 3) throw new Error('SUN_TINT 没解析出来');
if (!TARGET) throw new Error('SUN_TARGET_HEX 没解析出来');

/* ---- 算术复现 ---- */
const toLin = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => cie.decodeSRGB(v / 255));
};
const to8 = (lin) => lin.map((v) => Math.round(cie.encodeSRGB(Math.max(0, Math.min(1, v))) * 255));
const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

/** 复现 fragment shader。textureMean 是贴图在人眼亮度上的均值（0..1，sRGB 空间） */
function shade(textureMeanSRGB, limb) {
  const dev = textureMeanSRGB - 0.5;
  const structure = 1 + Math.max(-1, Math.min(1, dev * 2)) * U_STRUCTURE;
  let c = TINT.map((t) => t * U_EMISSION * structure);
  c = c.map((v) => v * (1 - LIMB_K * Math.pow(limb, 1.8)));
  c = c.map((v, i) => v + [1.0, 0.42, 0.12][i] * Math.pow(limb, 6.0) * CHROMO_K);
  return { lin: c, rgb: to8(c), hex: toHex(to8(c)) };
}

/* ---- 断言 ---- */
const checks = [];
const chk = (name, ok, detail) => checks.push({ name, ok, detail });

// 用贴图的典型均值：现有 sun.jpg 平均 #f18727，其亮度均值（sRGB）约 0.56
const MEAN = (0.945 * 0.2126 + 0.529 * 0.7152 + 0.153 * 0.0722);
const center = shade(MEAN, 0.0);
const edge = shade(MEAN, 1.0);

// 1. 中心色必须接近 5772 K 黑体目标
{
  const tgt = cie.blackbodyToHex(5772);
  const d = Math.max(...[0, 1, 2].map((i) => Math.abs(center.rgb[i] - tgt.rgb[i])));
  const m = /^#(..)(..)(..)$/.exec(TARGET);
  const declared = m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
  chk('S1 太阳中心色必须接近 5772 K 黑体（通道最大偏差 < 30）',
    d < 30,
    `${center.hex} vs 目标 ${tgt.hex}（偏差 ${d}）；声明值 ${TARGET}`);
  chk('S2 声明值 SUN_TARGET_HEX 必须与 cie 算出的 5772 K 一致',
    declared && Math.max(...[0, 1, 2].map((i) => Math.abs(declared[i] - tgt.rgb[i]))) < 3,
    `声明 ${TARGET} vs cie ${tgt.hex}`);
}
// 3. 中心必须很亮（太阳不能是暗橙）
{
  const lum = center.rgb[0] * 0.2126 + center.rgb[1] * 0.7152 + center.rgb[2] * 0.0722;
  chk('S3 太阳中心必须很亮（亮度 > 225）',
    lum > 225,
    `${center.hex} 亮度 ${lum.toFixed(1)}（第二次 bug 时是 #d29271，亮度仅 161）`);
}
// 4. 中心必须只是轻微暖，不能饱和
{
  const mx = Math.max(...center.rgb), mn = Math.min(...center.rgb);
  const sat = (mx - mn) / mx;
  chk('S4 太阳中心必须接近中性（饱和度 < 15%）',
    sat < 0.15,
    `${center.hex} 饱和 ${(sat * 100).toFixed(0)}%（第一次 bug 时是 #ffc84e，饱和 69%）`);
}
// 5. 边缘必须比中心暗 —— 临边昏暗生效
{
  const lc = center.rgb[0] * 0.2126 + center.rgb[1] * 0.7152 + center.rgb[2] * 0.0722;
  const le = edge.rgb[0] * 0.2126 + edge.rgb[1] * 0.7152 + edge.rgb[2] * 0.0722;
  chk('S5 边缘必须比中心暗（临边昏暗生效）',
    le < lc,
    `中心亮度 ${lc.toFixed(1)} → 边缘 ${le.toFixed(1)}（第二次 bug 时边缘反而更亮）`);
}
// 6. 边缘必须偏红 —— 色球红边生效
{
  const cr = center.rgb[0] - center.rgb[2];
  const er = edge.rgb[0] - edge.rgb[2];
  chk('S6 边缘必须比中心更偏红（色球红边生效）',
    er > cr,
    `中心 R-B=${cr} → 边缘 R-B=${er}`);
}
// 7. 色球项不能强到让边缘亮过中心（这是踩过的坑，必须钉住）
{
  const pureLimb = TINT.map((t) => t * U_EMISSION * (1 - LIMB_K));
  const withChromo = TINT.map((t, i) => pureLimb[i] + [1.0, 0.42, 0.12][i] * CHROMO_K);
  const brighten = withChromo[0] > TINT[0] * U_EMISSION;
  chk('S7 色球加法项不得让边缘亮过中心基色（历史坑）',
    !brighten,
    `带色球 ${withChromo[0].toFixed(3)} vs 基色 ${(TINT[0] * U_EMISSION).toFixed(3)}（加法项必须弱于临边昏暗）`);
}
// 8. 贴图不能拖暗整体 —— 自发光体语义
{
  const dark = shade(0.15, 0.0);   // 贴图很暗时
  const lum = dark.rgb[0] * 0.2126 + dark.rgb[1] * 0.7152 + dark.rgb[2] * 0.0722;
  chk('S8 贴图偏暗时太阳仍必须亮（亮度 > 200）—— 自发光体语义',
    lum > 200,
    `贴图均值 0.15 → ${dark.hex} 亮度 ${lum.toFixed(1)}（第一次改法这里会变成暗橙）`);
}
// 9. 贴图明暗必须仍能产生影响（结构层没被删掉）
{
  const bright = shade(0.85, 0.0);
  const dark = shade(0.15, 0.0);
  chk('S9 贴图明暗必须仍产生可见结构差异（亮度差 > 10）',
    bright.rgb[0] * 0.2126 + bright.rgb[1] * 0.7152 + bright.rgb[2] * 0.0722
      - (dark.rgb[0] * 0.2126 + dark.rgb[1] * 0.7152 + dark.rgb[2] * 0.0722) > 10,
    `亮贴图 ${bright.hex} vs 暗贴图 ${dark.hex}（结构层不能是死的）`);
}

const pass = checks.filter((c) => c.ok).length;
console.log('=== 太阳材质颜色校验 ===');
console.log(`  常量：uEmission=${U_EMISSION}  uStructure=${U_STRUCTURE}  tint=[${TINT}]`);
console.log(`        临边昏暗系数=${LIMB_K}  色球系数=${CHROMO_K}`);
console.log(`  中心(${center.hex})  边缘(${edge.hex})`);
console.log('');
console.log(`=== ${pass}/${checks.length} ===`);
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.slice(3)}`);
  if (!c.ok || process.env.VERBOSE) console.log(`      ${c.detail}`);
}
if (pass === checks.length) console.log('\n>>> 全部通过');
else { console.log('\n>>> 有断言未通过'); process.exitCode = 1; }

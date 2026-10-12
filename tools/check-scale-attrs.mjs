#!/usr/bin/env node
/**
 * 尺度语义与坐标守卫的**锚点检查**
 *
 * `web/js/data/attrs.js` 是「某一层该用哪个位置口径、该显哪些属性」的唯一定义源。
 * 它里面每一个公式都能在**看起来对**的前提下算错 —— 所以这里不放"有没有报错"
 * 这类判据，只放**能不能复现已知量**。
 *
 * 为什么非要这样：`galacticRadiusKly` 写错过一次符号（`gx + R0` 应为 `gx - R0`）。
 *   · 太阳那个锚点**照样通过**（g_vec = 0，加减都一样）——
 *     它是个退化情形，抓不住这个错。
 *   · 只有 Sgr A*（g_vec 恰好 = +R0·x̂）会给出 2R0 ≈ 53.3 kly 的错值。
 *   ⇒ 教训：**锚点不能只挑方便的那个**，而且要挑一个"错值一眼就荒谬"的。
 *
 * 用法：
 *   node tools/check-scale-attrs.mjs            # 正常检查
 *   node tools/check-scale-attrs.mjs --json
 *   node tools/check-scale-attrs.mjs --selftest # 故障注入：确认判据真的抓得住符号错
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from '../web/js/data/attrs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const SELFTEST = ARGV.includes('--selftest');

const results = [];
const ok = (name, detail) => results.push({ name, pass: true, detail });
const bad = (name, detail) => results.push({ name, pass: false, detail });
const close = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ 锚点 1
 * 太阳 → 银心距必须等于 R0。
 * ⚠️ 这是**退化情形**，它单独通过**不能**证明符号是对的（见文件头）。 */
{
  const r = A.galacticRadiusKly({ x: 0, y: 0, z: 0 }, { allowOrigin: true });
  const want = (A.R0_PC * 3.2615637769) / 1000;      // 8.178 kpc → 26.673 kly
  if (close(r, want, 0.05)) ok('锚点·太阳银心距', `${r.toFixed(3)} kly（R₀ = ${want.toFixed(3)} kly）`);
  else bad('锚点·太阳银心距', `得到 ${r} ，应为 ${want.toFixed(3)} kly —— 加了 allowOrigin 吗？`);
}

/* ------------------------------------------------------------------ 锚点 2
 * Sgr A* → 银心距必须 ≈ 0。**这条才是符号判定器。** */
{
  const sgrA = { ra: 266.4168, dec: -29.0078, distPc: 8178 };
  const r = A.galacticRadiusKly(sgrA);
  if (close(r, 0, 0.3)) ok('锚点·Sgr A* 在银心', `${r.toFixed(4)} kly（应 ≈ 0）`);
  else bad('锚点·Sgr A* 在银心',
    `得到 ${r.toFixed(3)} kly，应 ≈ 0。若约为 ${(2 * 26673 / 1000).toFixed(1)} kly（2R₀），`
    + '就是符号写反了：银心距 = |g_vec − R₀·x̂|，**是减号**。');
}

/* ------------------------------------------------------------------ 锚点 3
 * HYG 星表：所有恒星都在 120 光年内 ⇒ 银心距只可能在 R0 ± 120 ly 内摆动。
 * 这是个**与 R0 无关的形状判据**：不管 R0 取多少，跨度都必须是 ~240 ly = 0.24 kly。 */
{
  let starsJson = null;
  try { starsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stars.json'), 'utf8')); } catch { /* 缺就跳过 */ }
  if (!starsJson?.rows?.length) {
    ok('锚点·HYG 银心距跨度', '跳过（data/stars.json 不存在）');
  } else {
    const rs = [];
    for (const r of starsJson.rows) {
      const v = A.galacticRadiusKly({ x: r[1], y: r[2], z: r[3] });
      if (Number.isFinite(v)) rs.push(v);
    }
    rs.sort((a, b) => a - b);
    const span = rs[rs.length - 1] - rs[0];
    if (!rs.length) bad('锚点·HYG 银心距跨度', '一颗也算不出来');
    else if (span <= 0.26) ok('锚点·HYG 银心距跨度', `${rs.length} 颗 · 跨度 ${span.toFixed(3)} kly（≤120 光年 ⇒ 必然 ≈0.24）`);
    else bad('锚点·HYG 银心距跨度', `跨度 ${span.toFixed(3)} kly 过大 —— 120 光年内的恒星不可能差这么多`);
  }
}

/* ------------------------------------------------------------------ 守卫 */
{
  const cases = [
    ['NaN 坐标', { x: NaN, y: 0, z: 0 }, false, false],
    ['缺少坐标字段', { y: 0, z: 0 }, false, false],
    ['全零 = 缺数据', { x: 0, y: 0, z: 0 }, false, false],
    ['全零 + allowOrigin', { x: 0, y: 0, z: 0 }, true, true],
    ['正常坐标', { x: 1, y: 2, z: 3 }, false, true],
    ['只有 ra/dec + distLy', { ra: 217.43, dec: -62.68, distLy: 4.246 }, false, true],
    ['只有 ra/dec、没有距离', { ra: 217.43, dec: -62.68 }, false, false],
    ['ra/dec + 视差', { ra: 217.43, dec: -62.68, plxMas: 768.5 }, false, true],
  ];
  const missed = [];
  for (const [name, body, allow, want] of cases) {
    const got = A.placeOfLy(body, { allowOrigin: allow }) != null;
    if (got !== want) missed.push(`${name}（期望 ${want ? '有' : '无'}位置，实得 ${got ? '有' : '无'}）`);
  }
  if (!missed.length) ok('坐标守卫', `${cases.length} 个用例全部符合预期`);
  else bad('坐标守卫', missed.join('；'));
}

/* ------------------------------------------------------------------ 反算锚点
 * 比邻星：ra/dec + 距离 → 直角坐标。与 dataset.js / build-data.mjs 同一套约定，
 * 三者不一致就会出现「同一个天体在两个层里位置不同」。 */
{
  const p = A.placeOfLy({ ra: 217.43, dec: -62.68, distLy: 4.246 });
  const want = [-1.549, -1.184, -3.774];
  const got = [p.x, p.y, p.z];
  const off = Math.max(...want.map((w, i) => Math.abs(w - got[i])));
  if (off < 0.01) ok('反算·比邻星直角坐标', got.map((v) => v.toFixed(3)).join(', '));
  else bad('反算·比邻星直角坐标', `${got.map((v) => v.toFixed(3)).join(', ')} ≠ ${want.join(', ')}`);
}

/* ------------------------------------------------------------------ 尺度口径 */
{
  const errs = [];
  if (!A.showsSunDistance('solar') || !A.showsSunDistance('neighborhood')) errs.push('太阳系/邻近层应显示与太阳距离');
  for (const t of ['galaxy', 'localgroup', 'supercluster', 'universe']) {
    if (A.showsSunDistance(t)) errs.push(`${t} 层不该显示与太阳距离（出了太阳系就没这个量）`);
    if (A.showsEcliptic(t)) errs.push(`${t} 层不该显示黄道面夹角`);
  }
  if (!A.showsEcliptic('solar')) errs.push('太阳系层应显示黄道面夹角');
  if (!A.showsGalacticRadius('galaxy')) errs.push('银河系层应显示银心距');
  if (!errs.length) ok('尺度口径', '与太阳距离只在 solar+neighborhood；黄道夹角只在 solar；银心距只在 galaxy+');
  else bad('尺度口径', errs.join('；'));
}

/* ------------------------------------------------------------------ 故障注入
 * 判据「抓得住符号错」这件事本身也要证明。
 * 这里用**方向反了的那个公式**跑一遍 Sgr A* 锚点，断言它**必须失败**。
 * 如果它也"通过"了，说明锚点没有分辨力 —— 那才是真问题。 */
let selftestCaught = false;
if (SELFTEST) {
  const sgrA = { ra: 266.4168, dec: -29.0078, distPc: 8178 };
  const p = A.placeOfLy(sgrA);
  const [gx, gy, gz] = A.equatorialToGalacticVec(p.x, p.y, p.z);
  const r0Ly = A.R0_PC * 3.2615637769;
  const wrongSign = Math.hypot(gx + r0Ly, gy, gz) / 1000;    // ← 故意写错的版本
  selftestCaught = !close(wrongSign, 0, 0.3);
  if (selftestCaught) ok('故障注入·符号错被抓', `反号公式给出 ${wrongSign.toFixed(3)} kly，锚点判定为失败 ✓`);
  else bad('故障注入·符号错被抓', '反号公式竟然通过了 Sgr A* 锚点 —— 这条锚点没有分辨力');
}

/* ------------------------------------------------------------------ 输出 */
const failed = results.filter((r) => !r.pass);
if (JSON_OUT) {
  console.log(JSON.stringify({ results, failed: failed.length, selftest: SELFTEST, selftestCaught }, null, 2));
} else {
  console.log('尺度语义锚点检查 · web/js/data/attrs.js');
  for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name.padEnd(22)} ${r.detail}`);
  console.log(failed.length ? `\n✗ ${failed.length} 项失败` : `\n✓ 全部通过（${results.length} 项）`);
}
process.exit(failed.length ? 1 : 0);

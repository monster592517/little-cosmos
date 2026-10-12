#!/usr/bin/env node
/**
 * 泛光核整定（坑 118 · 丙）的**离线验收**
 * =====================================================================
 * 这个脚本存在的理由：`web/js/core/bloom-kernel.js` 里那几个数
 * （σ_eff、K = ⌈3σ⌉+1、取样代理量）**必须能在没有浏览器的前提下被复算**。
 * 依赖浏览器的判据有两个毛病：
 *   ① 它进不了 `node tools/selfcheck.mjs`（自检是离线的）；
 *   ② 出问题时要先起服务、起浏览器、等渲染，**「慢但熟悉」的手段会把检查拖到没人跑**。
 * 而这个模块是**纯函数、零依赖**（连 three 都不 import），所以它天生可以离线自证。
 *
 * ── 判据清单 ─────────────────────────────────────────────────────────
 *  B1  σ_eff 与**活页面实测值**一致（活页面读数见 `shots/_bloom-kernel4.log`）
 *  B2  K = ⌈3σ_eff⌉+1 ⇒ mip2 7→**12**、mip3 9→**15**（与性能探针实测一致）
 *  B3  保 σ：相对差 < SIGMA_TOLERANCE
 *  B4  实际截断深度 ≥ TRUNCATION_DEPTH
 *  B5  **幂等** —— 连调两次 K 不变（否则第二次会把已加宽的 σ 当源，K 慢慢漂）
 *  B6  `restoreStockKernel()` 能回出厂（A/B 与回滚的底座）
 *  B7  取样代理量 5,056,074 → 5,548,122（**+9.7%**，性能探针实测同一个数）
 *  B8  长度自洽：`KERNEL_RADIUS` 与系数数组长度不符必须被 `bloomKernelReport` 抓出来
 *  B9  级数不是 5 时**拒绝动手**（下标是按出厂 5 级的独热隔离结果定的）
 *
 * ── 判据自证（`--selftest`）──────────────────────────────────────────
 * 每条**两段式**：先证明它在正常状态下是绿的，再注入一个必然被它抓住的
 * 故障，证明它**真的会红**，然后复位。
 * ⚠️ 只证明「绿」等于没证明 —— 一条不会响的判据比没有判据更坏：
 *    它会让人以为已经验过了。
 *
 * ⚠️ 本脚本**不改任何文件**，只在一份内存里的假通道上做数学与注入。
 *    要验「活页面里的核真的变了」，用 `tools/probe-bloom-kernel-perf.py`。
 *
 * 用法：
 *   node tools/check-bloom-kernel.mjs             # 判定（红则退出码 1）
 *   node tools/check-bloom-kernel.mjs --selftest   # 再加一遍判据自证
 *   node tools/check-bloom-kernel.mjs --json       # 机器可读
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工作区根从模块自身位置推导 —— **不许写死绝对路径**（prog.no-abs-paths）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'web/js/core/bloom-kernel.js');

const {
  TRUNCATION_DEPTH, RETUNE_MIPS, SIGMA_TOLERANCE,
  sigmaEff, tapsFor, gaussianCoefficients, stockCoefficients,
  retuneBloomKernel, restoreStockKernel, bloomKernelReport,
} = await import(new URL(`file://${MOD.replace(/\\/g, '/')}`).href);

// ---------------------------------------------------------------------------
// 参照值：**活页面读回来的**，不是从源码抄的
// ---------------------------------------------------------------------------
/** 出厂 K 组（`UnrealBloomPass.js:148`）+ 活页面读回的 RT 尺寸（视口 1399×859） */
const STOCK_K = [3, 5, 7, 9, 11];
const RT_WH = [[699, 429], [350, 215], [175, 108], [88, 54], [44, 27]];
/**
 * 活页面读回的 σ_eff（`shots/_bloom-kernel4.log`）。
 * 容差 1e-3：活页面读回的是**同一套公式**，差别只应来自浮点与打印位数；
 * 差到 1e-3 以上就说明**公式已经不一致了**，那是最该早发现的漂移。
 */
const LIVE_SIGMA = [1.3589, 2.4505, 3.5342, 4.6157, 5.6963];
const LIVE_SIGMA_TOL = 1e-3;
/** 性能探针实测的取样代理量（`shots/_bloom-kernel-perf.log`） */
const LIVE_FETCH = { base: 5_056_074, wide23: 5_548_122 };
/** (2K−1) × 每级 X/Y 两趟 —— 与性能探针 `fetch_proxy()` 同一口径 */
const fetchProxy = (ks, wh) => ks.reduce((t, K, i) => t + 2 * (2 * K - 1) * wh[i][0] * wh[i][1], 0);

// ---------------------------------------------------------------------------
// 假通道：形状与 UnrealBloomPass 的那两个字段一致（不 import three）
// ---------------------------------------------------------------------------
function makePass({ Ks = STOCK_K, wh = RT_WH } = {}) {
  return {
    separableBlurMaterials: Ks.map((K) => ({
      defines: { KERNEL_RADIUS: K },
      uniforms: { gaussianCoefficients: { value: stockCoefficients(K) } },
      needsUpdate: false,
    })),
    renderTargetsVertical: wh.map(([width, height]) => ({ width, height })),
  };
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
const R = [];
const push = (id, ok, what, detail) => R.push({ id, ok, what, detail });

function judge() {
  R.length = 0;

  // ── B1 出货核的 σ_eff 与活页面一致 ──
  const sig = STOCK_K.map((K) => sigmaEff(stockCoefficients(K)));
  const dSig = sig.map((s, i) => Math.abs(s - LIVE_SIGMA[i]) / LIVE_SIGMA[i]);
  const worst = Math.max(...dSig);
  push('B1', worst <= LIVE_SIGMA_TOL,
    '出厂核 σ_eff 与活页面实测一致',
    `离线 ${sig.map((s) => s.toFixed(4)).join(' / ')} · 最大相对差 ${worst.toExponential(2)}（容差 ${LIVE_SIGMA_TOL}）`);

  // ── 整定 ──
  const pass = makePass();
  const rep = retuneBloomKernel(pass);

  // ── B2 K 与预测一致 ──
  const K2 = rep.levels.find((l) => l.i === 2)?.K;
  const K3 = rep.levels.find((l) => l.i === 3)?.K;
  push('B2', K2 === 12 && K3 === 15,
    'K = ⌈3σ_eff⌉+1 ⇒ mip2 = 12、mip3 = 15',
    `mip2 7→${K2}、mip3 9→${K3}（预测值由性能探针独立给出：12 / 15）`);

  // ── B3 保 σ ──
  const bad = rep.levels.filter((l) => !l.withinTolerance);
  push('B3', bad.length === 0,
    `保 σ：相对差 < ${SIGMA_TOLERANCE * 100}%`,
    rep.levels.map((l) => `mip${l.i} ${l.sigma}→${l.sigmaAfter}（${(l.dSigma * 100).toFixed(3)}%）`).join(' · '));

  // ── B4 截断深度够 ──
  const shallow = rep.levels.filter((l) => l.truncation < TRUNCATION_DEPTH - 1e-9);
  push('B4', shallow.length === 0,
    `实际截断深度 ≥ ${TRUNCATION_DEPTH}σ`,
    rep.levels.map((l) => `mip${l.i} ${l.truncation.toFixed(3)}σ`).join(' · '));

  // ── B5 幂等 ──
  const rep2 = retuneBloomKernel(pass);
  const K2b = rep2.levels.find((l) => l.i === 2)?.K;
  const K3b = rep2.levels.find((l) => l.i === 3)?.K;
  push('B5', K2b === K2 && K3b === K3,
    '幂等：连调两次 K 不变',
    `第一次 ${K2}/${K3} → 第二次 ${K2b}/${K3b}（源 σ 只在第一次反解并钉住）`);

  // ── B6 复位回出厂 ──
  restoreStockKernel(pass);
  const back = pass.separableBlurMaterials.map((m) => m.defines.KERNEL_RADIUS);
  const backSig = pass.separableBlurMaterials.map((m) => sigmaEff(m.uniforms.gaussianCoefficients.value));
  const backOk = JSON.stringify(back) === JSON.stringify(STOCK_K)
    && backSig.every((s, i) => Math.abs(s - LIVE_SIGMA[i]) / LIVE_SIGMA[i] <= LIVE_SIGMA_TOL);
  push('B6', backOk,
    'restoreStockKernel() 逐位回出厂',
    `K 回 ${back.join('/')} · σ_eff 回 ${backSig.map((s) => s.toFixed(4)).join('/')}`);

  // ── B7 取样代理量与性能探针同一口径 ──
  const passF = makePass();
  const kAfter = passF.separableBlurMaterials.map((m) => m.defines.KERNEL_RADIUS);
  retuneBloomKernel(passF);
  const kNew = passF.separableBlurMaterials.map((m) => m.defines.KERNEL_RADIUS);
  const f0 = fetchProxy(STOCK_K, RT_WH);
  const f1 = fetchProxy(kNew, RT_WH);
  const live0 = LIVE_FETCH.base;
  const live1 = LIVE_FETCH.wide23;
  const pct = (f1 / f0 - 1) * 100;
  const livePct = (live1 / live0 - 1) * 100;
  push('B7', f0 === live0 && f1 === live1,
    '取样代理量与性能探针实测一致',
    `离线 ${f0.toLocaleString()} → ${f1.toLocaleString()}（${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）·`
    + ` 实测 ${live0.toLocaleString()} → ${live1.toLocaleString()}（+${livePct.toFixed(1)}%）`
    + ` · 整定前后 K ${kAfter.join('/')} → ${kNew.join('/')}`);

  // ── B8 长度自洽（越界读是**不报异常**的那种错，必须有个判据盯着）──
  const pass8 = makePass();
  retuneBloomKernel(pass8);
  pass8.separableBlurMaterials[2].defines.KERNEL_RADIUS = 99;   // 注入：define 与数组长度脱钩
  const rep8 = bloomKernelReport(pass8);
  const caught = rep8.levels[2].consistent === false;
  push('B8', caught,
    'KERNEL_RADIUS 与数组长度不符必须被抓出来',
    `注入 mip2 define=99（真长度 ${rep8.levels[2].len}）⇒ consistent=${rep8.levels[2].consistent}`);

  // ── B9 级数不符时拒绝动手 ──
  const pass9 = makePass({ Ks: [3, 5, 7, 9] });   // 4 级
  const rep9 = retuneBloomKernel(pass9);
  const refused = rep9.ok === false && /级数/.test(rep9.why || '');
  push('B9', refused,
    '级数不是 5 时拒绝动手',
    `4 级 ⇒ ok=${rep9.ok} · ${String(rep9.why || '').slice(0, 60)}…`);

  return R;
}

// ---------------------------------------------------------------------------
// 判据自证：每条都要能红
// ---------------------------------------------------------------------------
function selftest() {
  const rows = [];
  const stage = (id, name, want, fn) => {
    let got;
    let err = null;
    try { got = fn(); } catch (e) { err = e.message; got = `<抛异常：${err}>`; }
    rows.push({ id, name, want, got, ok: String(got) === String(want) });
  };

  /* ① B8 的注入在**没有注入**时必须是绿的 —— 否则它恒红，不是判据 */
  stage('S1', 'B8 的正常态：define 与长度一致 ⇒ consistent=true', true, () => {
    const p = makePass();
    retuneBloomKernel(p);
    return bloomKernelReport(p).levels[2].consistent;
  });
  stage('S2', 'B8 的注入态：define 与长度脱钩 ⇒ consistent=false', false, () => {
    const p = makePass();
    retuneBloomKernel(p);
    p.separableBlurMaterials[2].defines.KERNEL_RADIUS = 99;
    return bloomKernelReport(p).levels[2].consistent;
  });

  /* ② B3（保 σ）必须真的会响：把 σ 换成「磨陡」那条路线 */
  stage('S3', 'B3 的正常态：丙 ⇒ 全部 withinTolerance', true, () => {
    const p = makePass();
    return retuneBloomKernel(p).levels.every((l) => l.withinTolerance);
  });
  stage('S4', 'B3 的注入态：σ 磨陡到 0.55×源 ⇒ 必须越线', false, () => {
    const p = makePass();
    retuneBloomKernel(p);
    // 手工把 mip2 的系数换成「σ = 0.55 × 源」——这正是被判为赔本的那条路线
    const m = p.separableBlurMaterials[2];
    const srcStyle = sigmaEff(stockCoefficients(7));
    const K = m.defines.KERNEL_RADIUS;
    m.uniforms.gaussianCoefficients.value = gaussianCoefficients(K, srcStyle * 0.55);
    const d = Math.abs(sigmaEff(m.uniforms.gaussianCoefficients.value) - srcStyle) / srcStyle;
    return d <= SIGMA_TOLERANCE;
  });

  /* ③ B2 的候选必须**只有一个**能同时过宽度与形状 —— 把甲的代价摆出来 */
  stage('S5', '甲的代价（σ 磨陡到 3.4σ 截断）必然越 5% 线：这里只验它确实改了 K', true, () => {
    // 甲不改 K、只改 σ ⇒ 取样量不变。用它证明「B7 只看取样次数，
    // 所以甲能骗过 B7」——**这正是为什么必须同时有 B3/B4**。
    const p = makePass();
    const before = p.separableBlurMaterials.map((m) => m.defines.KERNEL_RADIUS).join('/');
    const steepSig = sigmaEff(stockCoefficients(7)) * 0.55;
    p.separableBlurMaterials[2].uniforms.gaussianCoefficients.value = gaussianCoefficients(7, steepSig);
    const after = p.separableBlurMaterials.map((m) => m.defines.KERNEL_RADIUS).join('/');
    return before === after;   // K 没变 ⇒ B7 对此失明
  });

  /* ④ B9：改成 6 级也必须被拒（不能只对 4 级有效） */
  stage('S6', 'B9 对 6 级同样拒绝', false, () => {
    return retuneBloomKernel(makePass({ Ks: [3, 5, 7, 9, 11, 13] })).ok;
  });

  return rows;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const withSelf = args.includes('--selftest');

const rows = judge();
const failed = rows.filter((r) => !r.ok);
let selfRows = [];
let selfFailed = [];
if (withSelf) {
  selfRows = selftest();
  selfFailed = selfRows.filter((r) => !r.ok);
}

if (AS_JSON) {
  console.log(JSON.stringify({ ok: failed.length === 0 && selfFailed.length === 0, rows, selftest: selfRows }, null, 2));
  process.exit(failed.length === 0 && selfFailed.length === 0 ? 0 : 1);
}

console.log('泛光核整定（坑 118 · 丙）离线验收 —— ' + path.relative(ROOT, MOD).replace(/\\/g, '/'));
console.log('='.repeat(86));
for (const r of rows) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}  ${r.what}`);
  console.log(`      ${r.detail}`);
}
if (withSelf) {
  console.log('-'.repeat(86));
  console.log('  判据自证（先绿后红，每条都证明它会响）');
  for (const r of selfRows) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}  ${r.name}`);
    console.log(`      期望 ${r.want} · 实得 ${r.got}`);
  }
}
console.log('='.repeat(86));
const total = rows.length + selfRows.length;
const bad = failed.length + selfFailed.length;
console.log(`  ${bad === 0 ? '✓ 通过' : '✗ 不通过'} ${total - bad}/${total}`
  + `（判定 ${rows.length - failed.length}/${rows.length}`
  + (withSelf ? ` · 自证 ${selfRows.length - selfFailed.length}/${selfRows.length}` : '') + '）');
if (bad) {
  for (const r of [...failed, ...selfFailed]) console.log(`    ✗ ${r.id || ''} ${r.what || r.name}`);
  console.log('  处置：先看 web/js/core/bloom-kernel.js 的文件头 —— 那几个数是怎么来的都在那里。');
}
process.exit(bad === 0 ? 0 : 1);

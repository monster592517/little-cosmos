#!/usr/bin/env node
/**
 * 宇宙网密度场的**离线**量具（不起浏览器）
 *
 * ## 为什么要有它
 * 「可观测宇宙背景太空了」这件事，浏览器探针只能告诉你「屏幕上有多少亮像素」，
 * 告诉不了你「点云的**几何**是不是对的」。而这一层点云有两个可以用数字判定的性质：
 *
 *   ① **统计同质性**（宇宙学原理）：大尺度上每单位体积的点数应当大致恒定。
 *      判据 = 各壳层密度的 max/min。旧参数实测 38 倍 ⇒ 画面上「中间空、外圈糊」。
 *      ⚠️ 这里必须用**每单位体积**的密度，不能数点数 —— 外圈体积本来就大，
 *         数点数会把一个完全均匀的点云报成「外密内疏」。
 *   ② **空洞体积占比**要有出处：Cautun et al. 2014 (NEXUS/MMF, MNRAS 441,2923)
 *      z=0 测得空洞占体积 77%。所以接受率必须 ≈ 23%。
 *
 * 这两条都能在离线算出来，而且**和页面用的是同一份代码**
 * （`web/js/proc/cosmic-web.js`）—— 不会出现「工具量的和页面画的是两码事」。
 *
 * ## 用法
 *     node tools/probe-cosmos-web.mjs              # 量当前配置
 *     node tools/probe-cosmos-web.mjs --compare    # 新旧参数对照
 *     node tools/probe-cosmos-web.mjs --sweep      # 扫基频，看同质性怎么随尺度变
 * 退出码：0 = 量到了；1 = 结论不成立。
 */
import { performance } from 'node:perf_hooks';
import { buildCosmicWeb, webCalibration, WEB_CONFIG } from '../web/js/proc/cosmic-web.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const f3 = (x) => (x == null ? '—' : x.toFixed(3));

function report(cfg, wanted = 40000, label = '') {
  const t0 = performance.now();
  const { stats } = buildCosmicWeb(wanted, cfg);
  const ms = performance.now() - t0;
  const cal = webCalibration(cfg);
  console.log(`\n  ${label} freq=${cfg.freq} oct=${cfg.octaves} edgeRatio=${cfg.edgeRatio}`
    + ` | 半径 ${cfg.radius} Gly · 格距 ${(1 / cfg.freq).toFixed(2)} Gly`
    + ` (${(1 / cfg.freq / cfg.radius).toFixed(2)} R)`);
  console.log(`  场实测 μ=${f3(stats.fieldMean)} σ=${f3(stats.fieldSd)}`
    + ` | 阈值 t=${f3(stats.threshold)}（分位反解） 节点线=${f3(stats.nodeLine)}`);
  console.log(`  候选 ${stats.candidates} → 接受 ${stats.accepted}（${pct(stats.acceptRate)}）`);
  console.log(`  ⚠ 接受率 ≠ 空洞占比（阈值以上还按密度分级保留了一层），空洞占比由阈值分位保证`);
  console.log(`  同质性：各壳层**接受率** max/min = `
    + `${stats.spread == null ? '—' : stats.spread.toFixed(2)} 倍`
    + `   ← 按体积归一、每层样本数相同，所以这条线平不平就是场均不均匀`);
  console.log(`  耗时 ${ms.toFixed(0)} ms（wanted=${wanted}）`);
  const a = stats.shellAccept;
  const mx = Math.max(...a) || 1;
  for (let k = 0; k < a.length; k++) {
    const r1 = (k / a.length) * cfg.radius, r2 = ((k + 1) / a.length) * cfg.radius;
    const bar = '█'.repeat(Math.min(36, Math.round((a[k] / mx) * 36)));
    console.log(`     ${r1.toFixed(1).padStart(5)}–${r2.toFixed(1).padEnd(5)} Gly`
      + `  接受率 ${pct(a[k]).padStart(8)}  ${bar}`);
  }
  return { stats, ms, cal };
}

/* 旧参数：基频 0.062 / 细层 0.19 / 半径 40 / 阈值写死 0.585。
 * 用同一套参数化表达出来：阈值 0.585 对应「阈值以上 17.34% 的体积」⇒ 空洞 82.66%。 */
const OLD = {
  radius: 40, freq: 0.062, octaves: 3, seed: 7,
  edgeRatio: 0.19 / 0.062, edgeWeight: 0.22,
  voidFraction: 0.8266, nodeFraction: 0.023,
  calibSamples: WEB_CONFIG.calibSamples,
  shells: WEB_CONFIG.shells, shellSamples: WEB_CONFIG.shellSamples,
};

if (has('--sweep')) {
  console.log('\n扫基频（判据：同质性 max/min 越小越好，但格距不能小到看不出大结构）');
  console.log('  freq   格距(Gly)  占R    同质性(max/min)  接受率');
  for (const f of [0.062, 0.08, 0.10, 0.125, 0.16, 0.20, 0.25]) {
    const cfg = { ...WEB_CONFIG, freq: f };
    const { stats } = buildCosmicWeb(6000, cfg);
    const spread = stats.spread;
    console.log(`  ${f.toFixed(3)}  ${(1 / f).toFixed(2).padStart(8)}`
      + `  ${(1 / f / cfg.radius).toFixed(2).padStart(5)}`
      + `  ${(spread == null ? '—' : spread.toFixed(2)).padStart(14)}`
      + `  ${pct(stats.acceptRate).padStart(8)}`);
  }
  process.exit(0);
}

console.log('='.repeat(96));
console.log('  宇宙网密度场离线量具');
console.log('='.repeat(96));

const NEW = report(WEB_CONFIG, 40000, '【当前】');
if (has('--compare')) report(OLD, 40000, '【旧参数】');

console.log('\n' + '='.repeat(96));
console.log('  判据');
console.log('='.repeat(96));
const spread = NEW.stats.spread ?? Infinity;
/* ⚠️ 判据②不能拿「接受率」当「空洞占比」—— 阈值以上还按密度分级保留了一层，
 *    接受率（≈10%）比空洞占比（77% ⇒ 阈值以上 23%）更小。空洞占比要**回读**
 *    阈值分位：calibrateWeb 里统计了低于阈值的样本比例，那才是 77% 那个量。 */
const voidPct = NEW.stats.voidMeasured;
const ok1 = spread <= 4;
const ok2 = Math.abs(voidPct - WEB_CONFIG.voidFraction) < 0.01;
console.log(`  ① 同质性  各壳层接受率 max/min = ${spread.toFixed(2)} 倍（判据 ≤4）      → ${ok1 ? '通过' : '不通过'}`);
console.log(`  ② 空洞占比 回读 = ${pct(voidPct)}（标定目标 ${pct(WEB_CONFIG.voidFraction)} ±1pp）→ ${ok2 ? '通过' : '不通过'}`);
console.log(`  ③ 点数     = ${NEW.stats.accepted}（wanted 40000），接受率 ${pct(NEW.stats.acceptRate)}`);
console.log('='.repeat(96));
process.exit(ok1 && ok2 ? 0 : 1);

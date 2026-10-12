#!/usr/bin/env node
/* ==============================================================================
   apply-true-colors.mjs —— 用 CIE 真彩值替换 web/js/data/solar-system.js 里的手写色

   为什么需要这个脚本（而不是手改）：
     · 手写的 hex 是谁都没算过的"看起来差不多"值，14 个全错（见 坑 40）。
     · 真彩值必须**从光谱算出来**，不能人肉誊抄 —— 誊抄一次就腐烂一次（坑 33）。
     · 替换必须可重复执行、可审计、失配即报错（不许静默改错行）。

   两种语义，绝不混用（见 cie.js 里 spectrumToHex vs spectrumToRender 的注释）：
     · SWATCH  = spectrumToHex    → Y 归一化，只保证**色相**对。UI 色板用。
     · RENDER  = spectrumToRender → 保留 Y，保证**亮度**也对。网格/发光/轨道用。

   用法：
     node tools/apply-true-colors.mjs            # 实际写入
     node tools/apply-true-colors.mjs --dry      # 只打印将要做的改动
     node tools/apply-true-colors.mjs --verify   # 只核对现状是否已是目标值
   ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET = path.join(ROOT, 'web/js/data/solar-system.js');

const { spectrumToHex, spectrumToRender, blackbodyToHex } = await import(
  'file://' + path.join(ROOT, 'web/js/color/cie.js').replace(/\\/g, '/')
);
const { SPECTRA, renderSpectrum, getSpectrum } = await import(
  'file://' + path.join(ROOT, 'web/js/color/spectra.js').replace(/\\/g, '/')
);

/* ------------------------------------------------------------------------------
   1. 目标值表
   ------------------------------------------------------------------------------
   每条：【行内唯一锚点片段】+ 【新值表达式】+ 【依据】

   为什么锚点要带上下文而不只给颜色字面量：
     '#ffcf5c' 这种字符串在文件里可能出现在注释、多个天体、甚至别的字段里。
     锚点必须让 find 片段**唯一命中**，否则脚本报错退出（防止改错行）。
   ------------------------------------------------------------------------------ */

/** 辅助：取某 id 的两种真彩值 */
function colorsOf(id) {
  const e = SPECTRA[id];
  if (!e) throw new Error(`SPECTRA 里没有 ${id}`);
  const g = renderSpectrum(id);
  return {
    swatch: spectrumToHex(g, { srcWhite: 'E' }).hex,
    render: spectrumToRender(g, { srcWhite: 'E' }).hex,
    geo: e.geoAlbedo,
    zh: e.zh,
    src: e.src,
    conf: e.conf,
    note: e.note || '',
  };
}

/** 辅助：黑体恒星色 */
function starColor(T) {
  return blackbodyToHex(T).hex;
}

/* 每条替换：
     id      —— 天体 id（用于取光谱 & 生成出处注释）
     mode    —— 'swatch' | 'render' | 'star'
     match   —— 必须**唯一命中**的原文片段
     build   —— 用匹配到的组生成新文本
     why     —— 人话解释为什么改（写进文件注释）

   ⚠️ 缩进不是随便写的：SOLAR_SYSTEM 里的太阳用 2 空格，PLANETS/DWARFS 里的用 4 空格。
      锚点缩进写错 → 命中 0 次。这是本脚本第一次跑就栽的地方（坑 41 同族）。
*/
const I4 = '    '; // PLANETS / DWARFS 条目缩进
const I2 = '  ';   // 太阳条目缩进

const RULES = [
  {
    id: 'sun', mode: 'star',
    match: `id: 'sun', type: 'star', name: '太阳', en: 'Sun',\n${I2}color: '#ffcf5c',`,
    build: () => ({
      text:
        `id: 'sun', type: 'star', name: '太阳', en: 'Sun',\n` +
        `${I2}// 真彩：5772 K 黑体色（Kim et al. 2002 色温拟合 → cie.blackbodyToHex）。\n` +
        `${I2}// ⚠️ 别再改回橙黄 —— 太阳肉眼偏黄是地球瑞利散射的结果，出大气层后它**就是**近白微暖（坑 40）。\n` +
        `${I2}color: '${starColor(5772)}',`,
    }),
    why: '旧值 #ffcf5c 饱和 64%，是"穿过大气看太阳"的颜色；真彩 5772 K = #fff1ea（饱和 8%）',
  },
  {
    id: 'mercury', mode: 'render',
    match: `id: 'mercury', type: 'planet', name: '水星', en: 'Mercury', parent: 'sun',\n${I4}color: '#9c8f84',`,
    build: (c) => ({
      text:
        `id: 'mercury', type: 'planet', name: '水星', en: 'Mercury', parent: 'sun',\n` +
        `${I4}// 真彩：几何反照率 ${c.geo}，谱形状借月球月海（水星无公开逐波长曲线，conf ${c.conf}）。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}color: '${c.render}',`,
    }),
    why: '旧值 #9c8f84 是"印象里的灰"，真彩偏暖（月海型近线性上升谱）',
  },
  {
    id: 'venus', mode: 'render',
    match: `id: 'venus', type: 'planet', name: '金星', en: 'Venus', parent: 'sun',\n${I4}color: '#e8c98a',`,
    build: (c) => ({
      text:
        `id: 'venus', type: 'planet', name: '金星', en: 'Venus', parent: 'sun',\n` +
        `${I4}// 真彩：几何反照率 ${c.geo}（⚠️ 不是 Bond 0.76），整条谱按 Mallama 2006/2017 锚定。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}// 怪怪说过"金星偏灰"——方向对，机制相反：旧值 #e8c98a 饱和 41% 是**过饱和**，\n` +
        `${I4}// 真彩是极淡的暖白（饱和 15%），肉眼在天空里看它就是这种淡黄白（坑 40）。\n` +
        `${I4}color: '${c.render}',`,
    }),
    why: '旧值饱和 41% 偏橙；真彩是极淡暖白',
  },
  {
    id: 'mars', mode: 'render',
    match: `id: 'mars', type: 'planet', name: '火星', en: 'Mars', parent: 'sun',\n${I4}color: '#c1502e',`,
    build: (c) => ({
      text:
        `id: 'mars', type: 'planet', name: '火星', en: 'Mars', parent: 'sun',\n` +
        `${I4}// 真彩：几何反照率 ${c.geo}，谱形状来自 Viking 1 着陆点实测（蓝0.11/绿0.17/红0.30-0.39）。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}// 旧值 #c1502e 饱和 76%，是"网上火星图"的观感；真彩饱和 44%（坑 40）。\n` +
        `${I4}color: '${c.render}',`,
    }),
    why: '旧值饱和 76% 明显过艳；真彩饱和 44%',
  },
  {
    id: 'jupiter_zone', mode: 'render',
    match: `id: 'jupiter', type: 'planet', name: '木星', en: 'Jupiter', parent: 'sun',\n${I4}color: '#d8a86b',`,
    build: (c) => ({
      text:
        `id: 'jupiter', type: 'planet', name: '木星', en: 'Jupiter', parent: 'sun',\n` +
        `${I4}// 真彩：取**亮带**光谱（几何反照率 ${c.geo}，DSCOVR/EPIC 实测 disk 最大反照率）。\n` +
        `${I4}// 暗带另有 jupiter_belt 条目（geo ${SPECTRA.jupiter_belt.geoAlbedo}），条带对比在渲染层用贴图叠加。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}// 旧值 #d8a86b 饱和 50%；真彩近白微暖（饱和 9%）—— 木星整体其实就是个奶油白球（坑 40）。\n` +
        `${I4}color: '${c.render}',`,
    }),
    why: '旧值饱和 50% 偏棕；真彩近白微暖',
  },
  {
    id: 'saturn', mode: 'render',
    match: `id: 'saturn', type: 'planet', name: '土星', en: 'Saturn', parent: 'sun',\n${I4}color: '#e0c88a',`,
    build: (c) => ({
      text:
        `id: 'saturn', type: 'planet', name: '土星', en: 'Saturn', parent: 'sun',\n` +
        `${I4}// 真彩：几何反照率 ${c.geo}，红/蓝比≈1.76 → 淡黄（不含环；环见 spectra.NO_SPECTRUM.saturn_ring）。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}color: '${c.render}',`,
    }),
    why: '旧值偏黄褐；真彩是淡黄（红/蓝比 1.76）',
  },
  {
    id: 'uranus', mode: 'render',
    match: `id: 'uranus', type: 'planet', name: '天王星', en: 'Uranus', parent: 'sun',\n${I4}color: '#8fd3e8',`,
    build: (c) => ({
      text:
        `id: 'uranus', type: 'planet', name: '天王星', en: 'Uranus', parent: 'sun',\n` +
        `${I4}// 真彩：几何反照率 ${c.geo}，谱按 Irwin et al. 2024（重建谱，conf ${c.conf}）。\n` +
        `${I4}// ⚠️ 天王星必须**偏青不偏黄**（B≥R）—— 这是整个真彩链路的 sanity gate。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}color: '${c.render}',`,
    }),
    why: '旧值饱和 38% 过艳；真彩偏青（Irwin 2024 修正）',
  },
  {
    id: 'neptune', mode: 'render',
    match: `${I4}color: '#7aa5e0', radiusKm: 24622,`,
    build: (c) => ({
      text:
        `${I4}// 真彩：几何反照率 ${c.geo}，Irwin et al. 2024 修正 —— 不再用 Voyager 的深蓝。\n` +
        `${I4}// ⚠️ 2024 结论：海王星与天王星颜色**非常接近**，海王星只稍蓝（霾层更薄）。\n` +
        `${I4}//    README 里旧的"海王星淡青蓝 vs 天王星青绿"对比说法已过时。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}color: '${c.render}', radiusKm: 24622,`,
    }),
    why: '旧值 #7aa5e0 残留 Voyager 深蓝印象；Irwin 2024 修正为与天王星接近的淡青蓝',
  },
  {
    id: 'pluto', mode: 'render',
    match: `id: 'pluto', type: 'dwarf', name: '冥王星', en: 'Pluto', parent: 'sun', color: '#c9b6a4',`,
    build: (c) => ({
      text:
        `id: 'pluto', type: 'dwarf', name: '冥王星', en: 'Pluto', parent: 'sun',\n` +
        `${I4}// 真彩：几何反照率 ${c.geo}（New Horizons 光度）。tholin 红棕，白斑（Sputnik Planitia）走贴图。\n` +
        `${I4}// 出处：${c.src}\n` +
        `${I4}color: '${c.render}',`,
    }),
    why: '旧值偏土黄；真彩是淡暖白（tholin 只贡献微弱红端）',
  },
];

/* 无独立光谱、暂留旧值但必须标记的天体。
   它们等 Request C 的「属性驱动程序化生成」—— 在用户可见处要说明。 */
const PENDING = [
  { id: 'earth',  note: '地球无"整体反射率谱"可言（海/陆/云/冰混合，随经度剧变）。必须走程序化生成。' },
  { id: 'ceres',  note: '谷神星：Dawn 有影像但无公开逐波长反照率谱。走程序化（碳质小行星类）。' },
  { id: 'eris',   note: '阋神星：几何反照率 0.96（新视野级白），但无分辨率足够的谱。走程序化（冰质矮行星类）。' },
  { id: 'haumea', note: '妊神星：几何反照率约 0.51，形状极端拉长。走程序化。' },
  { id: 'makemake', note: '鸟神星：几何反照率约 0.81（甲烷冰），红棕色调。走程序化。' },
];

/* ------------------------------------------------------------------------------
   2. 执行
   ------------------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const VERIFY = argv.includes('--verify');

let src = fs.readFileSync(TARGET, 'utf8');
const orig = src;
const log = [];

/* —— RULES：逐条替换，每条必须唯一命中 —— */
for (const r of RULES) {
  const c = r.id === 'sun' ? null : colorsOf(r.id);
  const { text } = r.build(c);

  const hits = src.split(r.match).length - 1;
  if (hits === 0) {
    // 可能已经是目标值（幂等重跑），检查一下
    const already = /真彩/.test(src.split(r.match)[0].slice(-400));
    throw new Error(`[${r.id}] 锚点未命中 —— 文件可能已改过或锚点过期。\n  锚点: ${JSON.stringify(r.match.slice(0, 80))}...`);
  }
  if (hits > 1) {
    throw new Error(`[${r.id}] 锚点命中 ${hits} 次（必须唯一）—— 拒绝替换，防止改错行。`);
  }
  src = src.replace(r.match, text);
  log.push(`✓ ${r.id.padEnd(14)} ${c ? c.render : starColor(5772)}  ← ${r.why}`);
}

/* —— PENDING：加标记注释，不动颜色值 —— */
for (const p of PENDING) {
  // 两种形态都要认：id 与 color 同行（dwarf 们），或 id 行 + 下一行 color（planet 们）
  const sameLine = new RegExp(`(\\n${I4}id: '${p.id}',[^\\n]*?)( color: '#([0-9a-f]{6})',)`);
  const nextLine = new RegExp(`(\\n${I4}id: '${p.id}',[^\\n]*\\n)(${I4}color: '#([0-9a-f]{6})',)`);
  let m = src.match(sameLine);
  let mode = 'same';
  if (!m) { m = src.match(nextLine); mode = 'next'; }
  if (!m) { log.push(`· ${p.id.padEnd(14)} （未找到 id 行，跳过标记）`); continue; }

  const probe = src.slice(Math.max(0, m.index - 300), m.index + 500);
  if (probe.includes('待程序化生成')) { log.push(`· ${p.id.padEnd(14)} 已标记过，跳过`); continue; }

  const marker =
    `${I4}// ⚠️ 待程序化生成：${p.note}\n` +
    `${I4}//   现行值 #${m[3]} 是手写近似，**未经 CIE 计算**；Request C 属性驱动生成器接管后替换。`;

  if (mode === 'same') {
    src = src.replace(sameLine, `$1\n${marker}$2`);
  } else {
    src = src.replace(nextLine, `$1${marker}\n$2`);
  }
  log.push(`· ${p.id.padEnd(14)} 加了"待程序化生成"标记（颜色暂留 #${m[3]}）`);
}

/* ------------------------------------------------------------------------------
   3. 输出
   ------------------------------------------------------------------------------ */

console.log(log.join('\n'));
console.log('');

if (VERIFY) {
  console.log(orig === src ? '✅ 文件已是目标状态' : '⚠️ 文件与目标状态不同（需要跑一次不带 --verify 的）');
  process.exit(orig === src ? 0 : 1);
}

if (DRY) {
  console.log('—— DRY RUN，未写入 ——');
  process.exit(0);
}

if (orig === src) {
  console.log('无需改动');
  process.exit(0);
}

/* 写入前备份（幂等：同一天只留一份 .bak） */
const bak = TARGET + '.bak-truecolor';
if (!fs.existsSync(bak)) {
  fs.writeFileSync(bak, orig);
  console.log(`备份原文件 → ${path.basename(bak)}`);
}

fs.writeFileSync(TARGET, src);
console.log(`✅ 已写入 ${path.relative(ROOT, TARGET)}`);

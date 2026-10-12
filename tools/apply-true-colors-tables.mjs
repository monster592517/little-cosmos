#!/usr/bin/env node
/* ==============================================================================
   apply-true-colors-tables.mjs
   —— 给 moons.js / small-bodies.js 的**元组表**里的手写色换成 CIE 真彩值

   为什么单独一个脚本：
     这两个文件用位置元组存数据（moons 的色在第 9 位、small-bodies 在第 7 位），
     没法像 solar-system.js 那样用「锚点片段」替换 —— 得按元组位置解析。
     ⚠️ 但**绝不能**用 JSON.parse 往返重写：那会把注释、注释对齐、字段顺序全冲掉。
     做法：逐行正则，只替换**恰好一个 hex 字面量**，其余字节原样保留。

   只改有权威光谱的天体（本轮的边界）：
     · moons.js  —— io / europa / ganymede / callisto / titan / enceladus / moon
     · 其余卫星留原值 + 标记（它们没有公开逐波长光谱，归 Request C 程序化生成）

   用法：
     node tools/apply-true-colors-tables.mjs --dry
     node tools/apply-true-colors-tables.mjs
   ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DRY = process.argv.includes('--dry');

const { spectrumToRender } = await import('file://' + path.join(ROOT, 'web/js/color/cie.js').replace(/\\/g, '/'));
const { renderSpectrum } = await import('file://' + path.join(ROOT, 'web/js/color/spectra.js').replace(/\\/g, '/'));

/** moons.js 里【id → spectra id】。没列出的不动。 */
const MOON_SPECTRA = {
  // ⚠️ moon 用**圆面**谱 moon，不是 moon_mare ——
  //    纯月海只有 0.09，而月球整体几何反照率是 0.12（见 spectra.js MOON_DISC 注释）
  moon: 'moon',
  io: 'io',
  europa: 'europa',
  ganymede: 'ganymede',
  callisto: 'callisto',
  titan: 'titan',
  enceladus: 'enceladus',
};

const log = [];

/* ------------------------------------------------------------------------------
   moons.js —— 元组第 9 位（0-based）是颜色
   格式：  ['id', '中文', 'En', 'parent', r, a, e, i, period, '#hex', 'group'],
   ------------------------------------------------------------------------------ */
{
  const FILE = path.join(ROOT, 'web/js/data/moons.js');
  let src = fs.readFileSync(FILE, 'utf8');
  const orig = src;
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 只处理"行首是元组"的数据行
    const m = line.match(/^(\s*\[)(.*)(\],?\s*)$/);
    if (!m) continue;

    // 拆出 id 与该行唯一的 hex
    const idMatch = line.match(/'([a-z0-9_]+)'/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const specId = MOON_SPECTRA[id];
    if (!specId) continue;

    const hexes = line.match(/'#[0-9a-fA-F]{6}'/g);
    if (!hexes || hexes.length !== 1) {
      throw new Error(`[moons.js:${i + 1}] ${id} 行内 hex 数 = ${hexes ? hexes.length : 0}，期望恰好 1 个 —— 拒绝替换`);
    }
    const oldHex = hexes[0].slice(1, -1);
    const want = spectrumToRender(renderSpectrum(specId), { srcWhite: 'E' }).hex;
    if (oldHex.toLowerCase() === want.toLowerCase()) { log.push(`· moons/${id} 已是目标值`); continue; }

    lines[i] = line.replace(hexes[0], `'${want}'`);
    log.push(`✓ moons/${id.padEnd(10)} ${oldHex} → ${want}`);
  }

  src = lines.join('\n');
  if (orig !== src) {
    if (!DRY) {
      if (!fs.existsSync(FILE + '.bak-truecolor')) fs.writeFileSync(FILE + '.bak-truecolor', orig);
      fs.writeFileSync(FILE, src);
    }
    log.push(`  ${DRY ? '[dry] ' : ''}moons.js 已更新`);
  } else log.push('  moons.js 无需改动');
}

/* ------------------------------------------------------------------------------
   small-bodies.js —— 元组第 7 位（0-based）是颜色
   格式：['id', '中文', 'En', 'SBDB', 'type', 'group', radius, '#hex', 'shape', {...}]
   ------------------------------------------------------------------------------ */
{
  const FILE = path.join(ROOT, 'web/js/data/small-bodies.js');
  let src = fs.readFileSync(FILE, 'utf8');
  const orig = src;
  const lines = src.split('\n');
  let n = 0;

  /* 彗星：全部换成彗核谱。
     ⚠️ 这是**方向性修正**（亮蓝白 → 极暗红棕），依据 Ciarniello 2015 的 67P 实测。
        22 个彗星核共用一个真实的彗核谱，比 22 个各不相同的"亮蓝白"更诚实 ——
        因为我**没有**各彗核的独立逐波长谱，假装有才是撒谎。
        将来若拿到某个彗核的独立光谱，再单独覆盖。

     ⚠️ 星际天体（1I/2I/3I）单独走 interstellar 谱 —— 它们的谱斜率（23%）比
        67P（20%）更红，几何反照率也更高（0.10 vs 0.060）。**不能与太阳系彗核共用**。 */
  const cometColor = spectrumToRender(renderSpectrum('comet_nucleus'), { srcWhite: 'E' }).hex;
  const isColor = spectrumToRender(renderSpectrum('interstellar'), { srcWhite: 'E' }).hex;
  const INTERSTELLAR_IDS = new Set(['1I', '2I', '3I']);
  const cometIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\['/.test(line)) continue;
    const idMatch = line.match(/^\s*\['([^']+)',/);
    if (!idMatch) continue;
    const id = idMatch[1];

    /* 判定：元组里 type 字段是 'comet' */
    const isComet = /,\s*'comet',\s*'/.test(line);
    const specId = MOON_SPECTRA[id];
    if (!isComet && !specId) continue;

    const hexes = line.match(/'#[0-9a-fA-F]{6}'/g);
    if (!hexes || hexes.length !== 1) {
      throw new Error(`[small-bodies.js:${i + 1}] ${id} 行内 hex 数 = ${hexes ? hexes.length : 0}，期望恰好 1 个 —— 拒绝替换`);
    }
    const oldHex = hexes[0].slice(1, -1);
    let want, tag = '';
    if (INTERSTELLAR_IDS.has(id)) { want = isColor; tag = '  [星际天体]'; }
    else if (isComet) { want = cometColor; tag = '  [彗核]'; }
    else { want = spectrumToRender(renderSpectrum(specId), { srcWhite: 'E' }).hex; }

    if (isComet) cometIds.add(id);
    if (oldHex.toLowerCase() === want.toLowerCase()) continue;
    lines[i] = line.replace(hexes[0], `'${want}'`);
    log.push(`✓ small-bodies/${id.padEnd(14)} ${oldHex} → ${want}${tag}`);
    n++;
  }

  src = lines.join('\n');
  if (orig !== src) {
    if (!DRY) {
      if (!fs.existsSync(FILE + '.bak-truecolor')) fs.writeFileSync(FILE + '.bak-truecolor', orig);
      fs.writeFileSync(FILE, src);
    }
    log.push(`  ${DRY ? '[dry] ' : ''}small-bodies.js 已更新（${n} 处，其中彗核 ${cometIds.size} 个）`);
  } else log.push('  small-bodies.js 无需改动');
}

console.log(log.join('\n'));

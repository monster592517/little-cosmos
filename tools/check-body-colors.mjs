#!/usr/bin/env node
/* ==============================================================================
   check-body-colors.mjs —— 天体颜色一致性校验（覆盖 solar-system.js 的 317 个 color）

   为什么需要它：check-spectra.mjs 只验 spectra.js 里那 17 条光谱，
   而 solar-system.js 里有 **271 个没有贴图、纯靠 color 撑着**的天体，
   它们的 hex 是手写的、从没被任何检查看过。
   只有光谱通过 = 假绿（见 坑 42）。

   三组判据：
     A. 结构性 —— 不许大范围复制粘贴同一个 hex 却声称是不同天体
     B. 物理性 —— 颜色的亮度必须与天体自身的反照率同向（彗核 0.04 不能是纯白）
     C. 回归性 —— 真彩表覆盖到的天体，其 color 必须与 CIE 算出的值一致

   用法：
     node tools/check-body-colors.mjs
     node tools/check-body-colors.mjs --verbose
   ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose') || process.env.VERBOSE === '1';

const { spectrumToRender, blackbodyToHex } = await import(
  'file://' + path.join(ROOT, 'web/js/color/cie.js').replace(/\\/g, '/')
);
const { SPECTRA, renderSpectrum } = await import(
  'file://' + path.join(ROOT, 'web/js/color/spectra.js').replace(/\\/g, '/')
);
const M = await import(
  'file://' + path.join(ROOT, 'web/js/data/solar-system.js').replace(/\\/g, '/')
);

const all = M.allBodies();

let pass = 0, warn = 0, fail = 0;
const notes = [];
const ok = (t, d) => { pass++; if (VERBOSE) notes.push('  ✓ ' + t + (d ? '\n      ' + d : '')); };
const wr = (t, d) => { warn++; notes.push('  ⚠ ' + t + (d ? '\n      ' + d : '')); };
const no = (t, d) => { fail++; notes.push('  ✗ ' + t + (d ? '\n      ' + d : '')); };

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** sRGB 相对亮度（线性）—— 判据一律用线性量，不用编码差（坑 39） */
const lumLin = (h) => {
  const [r, g, b] = hex2rgb(h).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const satOf = (h) => {
  const [r, g, b] = hex2rgb(h);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

notes.push('=== 天体颜色一致性（共 ' + all.length + ' 个天体，' + all.filter((b) => b.color).length + ' 个有 color）===');
notes.push('');

/* ------------------------------------------------------------------------------
   A 组 · 结构性
   ------------------------------------------------------------------------------ */
notes.push('▸ A 组 · 结构性');

const colorGroups = new Map();
for (const b of all) {
  if (!b.color) continue;
  if (!colorGroups.has(b.color)) colorGroups.set(b.color, []);
  colorGroups.get(b.color).push(b);
}

/* A1：同一个 hex 被超过 12 个天体共用 —— 手写色板的征兆。
   分级口径（重要，别把"诚实"判成故障）：
     · 共享的**全是彗核** → warn。因为我**只有**一条实测彗核谱（67P），
       19 个彗核共用一个真实值，比 19 个各不相同的编造值更诚实。
     · 共享的**包含探测器** → warn。探测器不是天然天体，颜色不承载反照率语义。
     · 其余情况（天然天体、无正当理由） → fail。 */
{
  const COMET_IDS = /^([0-9]+P|[0-9]+I|halebopp|hyakutake|mcnaught|lovejoy|neowise|ison|tsuchinshan)$/;
  const isProbeish = (b) => b.type === 'probe' || b.group === 'probe';
  const isCometish = (b) => b.type === 'comet' || COMET_IDS.test(b.id);

  const bad = [...colorGroups.entries()]
    .filter(([, l]) => l.length > 12)
    .sort((a, b) => b[1].length - a[1].length);

  const unjustified = [];
  const justified = [];
  for (const [h, l] of bad) {
    if (l.every(isCometish)) justified.push(h + ' × ' + l.length + '（全是彗核：共用 67P 实测谱）');
    else if (l.every(isProbeish)) justified.push(h + ' × ' + l.length + '（全是探测器：颜色无物理语义）');
    else if (l.some((b) => /程序化|procedural|占位/.test(String(b.note || '') + String(b.desc || '')))) justified.push(h + ' × ' + l.length + '（已标注程序化）');
    else unjustified.push(h + ' × ' + l.length + '（如 ' + l.slice(0, 4).map((x) => x.id).join(',') + '）');
  }

  if (unjustified.length === 0) wr('A1 有 ' + justified.length + ' 组共用 hex，但都有正当理由（彗核/探测器）', justified.join('；'));
  else no('A1 有 ' + unjustified.length + ' 个 hex 被大量天然天体共用且无正当理由', unjustified.join('；'));
}

/* A2：同一天然卫星系内部颜色种类数 —— 少于 3 种说明没做区分 */
{
  const byParent = new Map();
  for (const b of all) {
    const p = b.parent || '(root)';
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(b);
  }
  const suspects = [];
  for (const [p, list] of byParent) {
    if (list.length < 5) continue;
    const c = new Set(list.map((x) => x.color).filter(Boolean)).size;
    if (c <= 3) suspects.push(p + '(' + list.length + '个天体仅' + c + '色)');
  }
  if (suspects.length === 0) ok('A2 各卫星系内部颜色有区分度');
  else wr('A2 以下天体群颜色高度同质化（可能是复制粘贴）', suspects.join('，'));
}

/* A3：每个有 color 的天体，hex 必须是合法的 6 位 */
{
  const bad = all.filter((b) => b.color && !/^#[0-9a-fA-F]{6}$/.test(b.color));
  if (bad.length === 0) ok('A3 全部 hex 格式合法（' + all.filter((b) => b.color).length + ' 个）');
  else no('A3 有非法 hex', bad.map((b) => b.id + '=' + b.color).join(', '));
}

/* A4：无贴图的天体数量必须被显式知晓 —— 它们是纯 color 撑的，风险最高。
   ⚠️ 这里**只报数量**，不再试图统计"有多少个标注了程序化生成"：
      标注写在源码注释里，而注释不会进入解析后的对象，
      所以那个计数**永远为 0** —— 一个不可能响的统计等于没有统计。
      「颜色到底可不可信」改由 F 组按**可追溯来源**实算。 */
{
  const noTex = all.filter((b) => !b.texture && b.color);
  wr('A4 有 ' + noTex.length + ' 个天体无贴图、纯靠 color 渲染',
    '这批颜色的可信度低于行星级。它们各自属于哪一档来源，见下方 F 组（实算，不是标注）。');
}

/* ------------------------------------------------------------------------------
   B 组 · 物理性（核心：亮度必须与反照率同向）
   ------------------------------------------------------------------------------ */
notes.push('');
notes.push('▸ B 组 · 物理性');

/* B1：反照率低（<0.15）的天体，颜色不许是"亮白"（线性亮度 > 0.55） */
{
  const bad = [];
  for (const b of all) {
    if (!b.color || typeof b.albedo !== 'number') continue;
    const L = lumLin(b.color);
    if (b.albedo < 0.15 && L > 0.55) bad.push(b.id + '(' + b.color + ' L=' + L.toFixed(2) + ' alb=' + b.albedo + ')');
  }
  if (bad.length === 0) ok('B1 没有"低反照率却画成亮白"的天体');
  else no('B1 ' + bad.length + ' 个天体颜色亮度与自身反照率**反向**（暗天体画成亮白）',
    bad.slice(0, 14).join('、') + (bad.length > 14 ? ' …等' : ''));
}

/* B2：彗核（albedo 已知且 < 0.10）必须明显暗于月球 —— 太阳系最暗的天体。
   ⚠️ 星际天体（1I/2I/3I）**排除在外**：它们的几何反照率约 0.10（比太阳系彗核的
      0.06 高一档），谱斜率也更红，是另一族。混在一起判会把正确的值报成错的。 */
{
  const INTERSTELLAR = new Set(['1I', '2I', '3I']);
  const comets = all.filter((b) => b.color && typeof b.albedo === 'number'
    && b.albedo < 0.10 && !INTERSTELLAR.has(b.id));
  if (comets.length === 0) wr('B2 没找到反照率 <0.10 的彗核，判据无法验证');
  else {
    const bright = comets.filter((b) => lumLin(b.color) > 0.45);
    const medL = comets.map((b) => lumLin(b.color)).sort((a, b) => a - b)[Math.floor(comets.length / 2)];
    if (bright.length === 0) ok('B2 ' + comets.length + ' 个彗核（albedo<0.10）颜色都够暗', '中位线性亮度 ' + medL.toFixed(3));
    else no('B2 ' + bright.length + '/' + comets.length + ' 个彗核画得比实际亮得多', bright.slice(0, 10).map((b) => b.id + ':' + b.color).join(' ') + ' | 中位线性亮度 ' + medL.toFixed(3));
  }
}

/* B3：月球（albedo 0.136，实为暗灰）的颜色线性亮度必须 < 0.35 */
{
  const moon = all.find((b) => b.id === 'moon');
  if (!moon) wr('B3 找不到 moon 条目');
  else {
    const L = lumLin(moon.color);
    if (L < 0.35) ok('B3 月球颜色够暗（线性亮度 ' + L.toFixed(3) + ' < 0.35）');
    else no('B3 月球颜色偏亮（线性亮度 ' + L.toFixed(3) + ' ≥ 0.35）—— 真实月球反照率仅 0.136（Mallama 2017）');
  }
}

/* ------------------------------------------------------------------------------
   C 组 · 回归性（真彩表覆盖到的必须一致）
   ------------------------------------------------------------------------------ */
notes.push('');
notes.push('▸ C 组 · 回归性');

/* 天体 id → 光谱 id 的映射（行星用行星谱，卫星单独给） */
const MAP = {
  mars: 'mars', moon: 'moon', mercury: 'mercury', venus: 'venus',
  jupiter: 'jupiter_zone', saturn: 'saturn', uranus: 'uranus', neptune: 'neptune',
  pluto: 'pluto', io: 'io', europa: 'europa', ganymede: 'ganymede',
  callisto: 'callisto', titan: 'titan', enceladus: 'enceladus',
  sun: null, // 太阳走黑体，单独算
};

/* C1：真彩覆盖到的天体，现 color 必须等于 CIE render 值（容差 0，因为脚本是算出来的） */
{
  const bad = [];
  let checked = 0;
  for (const [bodyId, specId] of Object.entries(MAP)) {
    if (!specId) continue;
    const b = all.find((x) => x.id === bodyId);
    if (!b || !b.color) { bad.push(bodyId + '(缺条目)'); continue; }
    const want = spectrumToRender(renderSpectrum(specId), { srcWhite: 'E' }).hex;
    checked++;
    if (b.color.toLowerCase() !== want.toLowerCase()) bad.push(bodyId + ' 现 ' + b.color + ' ≠ 应 ' + want);
  }
  if (bad.length === 0) ok('C1 真彩覆盖的 ' + checked + ' 个天体颜色与 CIE 计算一致');
  else no('C1 ' + bad.length + ' 个天体的颜色与 CIE 计算不符（说明被手改了，或脚本没跑）', bad.join('；'));
}

/* C2：太阳必须是 5772 K 黑体色 */
{
  const want = blackbodyToHex(5772).hex;
  const sun = all.find((b) => b.id === 'sun');
  if (!sun || !sun.color) wr('C2 找不到 sun 条目');
  else if (sun.color.toLowerCase() === want.toLowerCase()) ok('C2 太阳色 = 5772 K 黑体 ' + want);
  else no('C2 太阳色 ' + sun.color + ' ≠ 5772 K 黑体 ' + want);
}

/* C3：土卫二几何反照率 1.375 > 1 是合法的（强背散射）—— 防止后人"修好"它 */
{
  const enc = SPECTRA.enceladus;
  if (enc && enc.geoAlbedo > 1) ok('C3 土卫二 geoAlbedo=' + enc.geoAlbedo + ' > 1 是合法的（强背散射），不是 bug');
  else no('C3 土卫二 geoAlbedo 被改成 ≤1，说明有人"修好"了它 —— 这是错的');
}

/* C4：天王星必须偏青（B≥R）—— 链路 sanity gate */
{
  const u = all.find((b) => b.id === 'uranus');
  if (!u || !u.color) wr('C4 找不到 uranus 条目');
  else {
    const [r, , b] = hex2rgb(u.color);
    if (b >= r) ok('C4 天王星偏青（B=' + b + ' ≥ R=' + r + '）—— Irwin 2024 修正生效');
    else no('C4 天王星偏黄（B=' + b + ' < R=' + r + '）—— 退回旧认知了');
  }
}

/* ------------------------------------------------------------------------------
   D 组 · 动力学族（不规则卫星）—— 防止族级颜色被抹平
   ------------------------------------------------------------------------------
   为什么单独一组：
     82 颗不规则卫星原本全挤在 3 个手写 hex 上。现在的颜色由
     「动力学族 + 实测色指数」生成（web/js/color/moon-families.js）。
     如果哪天有人把它们改回一个颜色、或改错了族，**光看 A1 是发现不了的**
     （A1 只查"是否被 >12 个天体共用"，一个族内部抹平它看不见）。
     所以要按族验：族内该同质的同质、该异质的异质，且红度顺序对。
   ------------------------------------------------------------------------------ */
notes.push('');
notes.push('▸ D 组 · 动力学族（不规则卫星）');

let FAM = null;
try {
  FAM = await import('file://' + path.join(ROOT, 'web/js/color/moon-families.js').replace(/\\/g, '/'));
} catch (e) {
  wr('D0 moon-families.js 载入失败', String(e && e.message || e));
}

if (FAM) {
  const { FAMILY_OF, FAMILIES, FAMILY_SPREAD, effectiveSpread, hashUnit } = FAM;
  // D3/D4 都要用：太阳色指数 + 扰动函数 + 反演函数
  // （色指数是相对太阳测的，见 indices-to-spectrum.js）
  const { SOLAR_INDICES, perturbIndices, indicesToSpectrum } = await import(
    'file://' + path.join(ROOT, 'web/js/color/indices-to-spectrum.js').replace(/\\/g, '/'));
  const irr = all.filter((b) => b.grp === 'irregular');

  /* D1：每颗不规则卫星都必须有族归属 —— 漏归族会退回手写色 */
  {
    const noFam = irr.filter((b) => !FAMILY_OF[b.id]);
    if (noFam.length === 0) ok('D1 ' + irr.length + ' 颗不规则卫星全部有族归属（' + new Set(irr.map((b) => FAMILY_OF[b.id])).size + ' 个族）');
    else no('D1 ' + noFam.length + ' 颗不规则卫星没有族归属', noFam.map((b) => b.id).join(', '));
  }

  /* D2：族内不该同质到只剩 1 色 —— 那就是"抹平"回归。
     口径：族级**色相**应当一致（同族同源），但成员之间因反照率档内分布
     必然有亮度差异。若一族所有成员的 hex **完全相同**且成员数 ≥4，判 fail。
     （1–3 颗的小族不判，样本太少。） */
  {
    const byFam = new Map();
    for (const b of irr) {
      const f = FAMILY_OF[b.id];
      if (!f) continue;
      if (!byFam.has(f)) byFam.set(f, []);
      byFam.get(f).push(b);
    }
    const flat = [];
    for (const [f, list] of byFam) {
      if (list.length < 4) continue;
      const u = new Set(list.map((b) => b.color));
      if (u.size === 1) flat.push(f + '(' + list.length + '颗同一色 ' + list[0].color + ')');
    }
    if (flat.length === 0) ok('D2 没有族被抹平成单一颜色（≥4 成员的族都有区分度）');
    else no('D2 以下族的所有成员共用一个 hex —— 说明族级颜色被抹平了', flat.join('、'));
  }

  /* D3：颜色必须由族+色指数**算得出来** —— 重跑生成逻辑比对。
     这一条是真正的回归锁：改族定义或改 moons.js 都会立刻失配。 */
  {
    const { indicesToSpectrum, perturbIndices, SOLAR_INDICES } = await import(
      'file://' + path.join(ROOT, 'web/js/color/indices-to-spectrum.js').replace(/\\/g, '/'));
    const { spectrumToRender } = await import(
      'file://' + path.join(ROOT, 'web/js/color/cie.js').replace(/\\/g, '/'));
    const { albedoOf, hashUnit, KALYKE_SPECTRUM } = FAM;

    const mismatch = [];
    let checked = 0;
    for (const b of irr) {
      const fid = FAMILY_OF[b.id];
      if (!fid) continue;
      const f = FAMILIES[fid];
      let want;
      if (b.id === 'kalyke') {
        // Kalyke 用显式分段谱（非单斜率）。这里只做**存在性**校验：
        // 它必须明显比同族的 Carme 成员红（R−B 更大），否则就是被抹平了。
        continue;
      }
      const albedo = (typeof b.albedo === 'number' && b.albedo > 0) ? b.albedo : albedoOf(b.id, f);
      const spread = effectiveSpread(fid);
      const { bv, vr } = perturbIndices(f.bv, f.vr, hashUnit(b.id) * spread);
      want = spectrumToRender(indicesToSpectrum(bv, vr, albedo).grid).hex;
      checked++;
      if (b.color.toLowerCase() !== want.toLowerCase()) {
        mismatch.push(b.id + ' 现 ' + b.color + ' ≠ 应 ' + want);
      }
    }
    if (mismatch.length === 0) ok('D3 ' + checked + ' 颗不规则卫星的颜色可复现（族+色指数重算一致）');
    else no('D3 ' + mismatch.length + ' 颗不规则卫星的颜色无法由生成逻辑复现',
      mismatch.slice(0, 12).join('；') + (mismatch.length > 12 ? ' …等' : '')
      + ' —— 说明有人手改了 hex，或族定义变了。跑 `node tools/apply-irregular-moon-colors.mjs` 重生成。');
  }

  /* D4：红度顺序必须与 Grav et al. 2003 一致（灰 → 淡红 → 红）。
     ⚠️ 判据是**族级色指数**，不是某个被抖动过的成员的 8 位 hex。
        原因（踩过）：Themisto 与 Sinope 的 Δ(B−V) 只差 0.01 mag，
        属于文献里的**近并列**。取"每族第一个成员"的 hex 去比顺序时，
        逐星抖动能把它俩抖翻，检查器报错而**数据其实是对的** ——
        这类假失败会训练人去改阈值。族级 Δ(B−V) 才是文献的直接对应物。 */
  {
    // 顺序取自 Grav 2003 的分类：中性灰(Phoebe) → 灰(Himalia/Halimede)
    //   → 淡红(Pasiphae/Ananke/Carme) → 红(Themisto/Sinope) → 极红(Kalyke)
    const ORDER = ['sat_phoebe', 'jup_himalia', 'nep_halimede', 'jup_pasiphae',
      'jup_ananke', 'jup_carme', 'jup_themisto', 'jup_sinope', 'jup_kalyke'];
    // 红度 = 该族相对太阳的**红化量**，来自 Grav 2003。
    // ⚠️ 不能只看 B−V：Kalyke 的 Δ(B−V)=0.05（几乎是全样本最灰的之一），
    //    它的红**全在 V−R=0.96** 上 —— 只看 B−V 会把它排到 Himalia 旁边，
    //    而原文明确说它"明显比同族红"。故用两段红化的**最大值**：
    //    B−V 段（蓝-绿端红化）与 V−R 段（绿-红端红化），取较大者。
    //    这对"灰→淡红→红"的单调性判断是正确的：任一端的红化都算红。
    const redOf = (famId) => {
      const f = FAMILIES[famId];
      if (!f) return null;
      const dbv = f.bv - SOLAR_INDICES.bv;
      const dvr = f.vr - SOLAR_INDICES.vr;
      return +Math.max(dbv, dvr).toFixed(4);
    };
    const seq = ORDER.map((f) => ({ f, v: redOf(f) })).filter((x) => x.v !== null);
    // ⚠️ 防空转：若族定义或太阳色指数没取到，redOf 会返回 NaN，
    //    下面的比较全部为 false → 检查"通过"。这是最危险的假绿。
    if (seq.length < 5 || seq.some((x) => !Number.isFinite(x.v))) {
      no('D4 族级红度取不到值（FAMILIES / SOLAR_INDICES 未就绪）',
        'seq=' + JSON.stringify(seq) + ' —— 检查器自身故障，不是数据故障');
    } else {
    const breaks = [];
    for (let i = 1; i < seq.length; i++) {
      // 允许 0.01 mag 的并列容差（文献不确定度量级）
      if (seq[i].v < seq[i - 1].v - 0.005) {
        breaks.push(seq[i - 1].f + '(' + seq[i - 1].v + ') → ' + seq[i].f + '(' + seq[i].v + ')');
      }
    }
    if (breaks.length === 0) ok('D4 族级红度顺序与 Grav 2003 一致（Phoebe 中性 → Kalyke 最红）',
      seq.map((x) => x.f.replace(/^(sat|jup|nep|ura)_/, '') + '=' + x.v).join(' < '));
    else no('D4 族级红度顺序与文献不符', breaks.join('；'));

    /* D4b：**抖动不得翻转文献顺序** —— 判据用**渲染后的 hex**，不用色指数。
       ⚠️ 为什么不能用 Δ(B−V)：Kalyke 的 Δ(B−V)=0.05 而 Δ(V−R)=0.59，
          Sinope 的 Δ(B−V)=0.17 但 Δ(V−R)=0.09。按 B−V 比会得出
          "Sinope 比 Kalyke 红" —— 而它俩实际渲染是 #413e3a vs #3e352b，
          Kalyke 明显红得多。**单看任一个色指数都会给出错的顺序**，
          因为红化可以发生在蓝-绿端或绿-红端。渲染的 hex 同时integrate了两端，
          且它才是真正的交付物 —— 所以就在它上面判。
       ⚠️ 上一版还犯过一个错：用 ±(spreadA+spreadB) 估"最坏情形"来判，
          假设两端各自朝对方取到极值。确定性哈希并不那样取，于是误报三处。
          **用启发式估最坏情形会把没发生的事报成故障** —— 和漏报一样有害。
          现在改成实算全部真实成员。 */
    const RED = (hex) => { const [r, , b] = hex2rgb(hex); return r - b; };
    const { albedoOf } = FAM;
    const memberRedness = (famId) => {
      const f = FAMILIES[famId];
      const sp = effectiveSpread(famId);
      return Object.keys(FAMILY_OF)
        .filter((id) => FAMILY_OF[id] === famId)
        .map((id) => {
          const p = perturbIndices(f.bv, f.vr, hashUnit(id) * sp);
          const grid = indicesToSpectrum(p.bv, p.vr, albedoOf(id, f)).grid;
          return { id, hex: spectrumToRender(grid).hex };
        });
    };
    const flips = [];
    for (let i = 1; i < seq.length; i++) {
      const lo = memberRedness(seq[i - 1].f), hi = memberRedness(seq[i].f);
      if (!lo.length || !hi.length) continue;
      const loMax = lo.reduce((a, b) => (RED(b.hex) > RED(a.hex) ? b : a));  // 较灰族的**最红**成员
      const hiMin = hi.reduce((a, b) => (RED(b.hex) < RED(a.hex) ? b : a));  // 较红族的**最灰**成员
      // 允许 2 个 8 位色阶的并列（肉眼与编码都在此之内）
      if (RED(hiMin.hex) < RED(loMax.hex) - 2) {
        flips.push(seq[i - 1].f.replace(/^[a-z]+_/, '') + '.' + loMax.id + '(' + loMax.hex + ' R−B=' + RED(loMax.hex) + ')'
          + ' 比 ' + seq[i].f.replace(/^[a-z]+_/, '') + '.' + hiMin.id + '(' + hiMin.hex + ' R−B=' + RED(hiMin.hex) + ')'
          + ' 还红 —— 顺序被抖翻');
      }
    }
    if (flips.length === 0) ok('D4b 逐星抖动未翻转任何相邻族的文献顺序（按渲染 hex 实算全部成员）');
    else no('D4b 以下相邻族的成员被抖动翻到了文献顺序之外 —— 调小 FAMILY_SPREAD',
      flips.join('；'));
    }
  }

  /* D5：Kalyke 必须比同族的 Carme 成员更红 —— 它是文献明确记载的例外 */
  {
    const kal = irr.find((b) => b.id === 'kalyke');
    const carme = irr.filter((b) => FAMILY_OF[b.id] === 'jup_carme');
    if (!kal || carme.length === 0) wr('D5 找不到 Kalyke 或 Carme 成员');
    else {
      const kr = (() => { const [r, , bl] = hex2rgb(kal.color); return r - bl; })();
      const maxCarme = Math.max(...carme.map((b) => { const [r, , bl] = hex2rgb(b.color); return r - bl; }));
      if (kr > maxCarme) ok('D5 Kalyke 比同族最红的成员还红（' + kr + ' > ' + maxCarme + '）—— 文献例外已保留');
      else no('D5 Kalyke 不再比同族红（' + kr + ' ≤ ' + maxCarme + '）—— 它的特殊性被抹掉了');
    }
  }
}

/* ------------------------------------------------------------------------------
   E 组 · 有测光、无光谱的天体（色指数反推）—— 防止 `color` 字段"安静地缺失"
   ------------------------------------------------------------------------------
   为什么单独一组：
     谷神星 / 阋神星 / 妊神星 / 鸟神星这 4 颗的 `color` 字段曾经是**失效**的 ——
     它被写在一行 `//` 注释的行尾，于是整行被注释掉，字段根本不存在，
     渲染时吃兜底灰。**没有任何报错**，脚本还报"成功"。
     A 组查的是"颜色是否被滥用"，查不出"字段压根没有"。所以单列一组。

   颜色来源：web/js/color/photometric-colors.js（色指数/谱斜率 → CIE → #rrggbb）。
     和 C1 的区别：C1 比的是 spectra.js 的**实测谱**，这里比的是**测光反推**。
     两者都是"必须算得出来"，都不许手写。
   ------------------------------------------------------------------------------ */
notes.push('');
notes.push('▸ E 组 · 测光反推色（矮行星）');

let PHOTO = null;
try {
  PHOTO = await import('file://' + path.join(ROOT, 'web/js/color/photometric-colors.js').replace(/\\/g, '/'));
} catch (e) {
  no('E0 photometric-colors.js 载入失败', String((e && e.message) || e));
}

if (PHOTO) {
  const { PHOTOMETRY, photometryColor } = PHOTO;

  /* E1：每个登记天体的 color 必须**存在**且等于算出来的 render 值 */
  {
    const missing = [];
    const mismatch = [];
    let checked = 0;
    for (const id of Object.keys(PHOTOMETRY)) {
      const b = all.find((x) => x.id === id);
      const zh = PHOTOMETRY[id].zh || id;
      if (!b) { missing.push(`${id}(${zh}) 不在天体总表里`); continue; }
      if (!b.color) { missing.push(`${id}(${zh}) 的 color 字段不存在 —— 渲染会吃兜底灰`); continue; }
      let want;
      try { want = photometryColor(id).render; }
      catch (e) { mismatch.push(`${id}(${zh}) 算不出颜色：${e.message}`); continue; }
      checked++;
      if (b.color.toLowerCase() !== want.toLowerCase()) {
        mismatch.push(`${id}(${zh}) 现 ${b.color} ≠ 应 ${want}`);
      }
    }
    if (missing.length === 0 && mismatch.length === 0) {
      ok(`E1 ${checked} 颗测光反推天体都有 color 字段且与 CIE 计算一致`);
    } else {
      if (missing.length) {
        no(`E1 ${missing.length} 颗测光反推天体**没有 color 字段**（这正是它们曾经失效的方式）`, missing.join('；'));
      }
      if (mismatch.length) {
        no(`E1 ${mismatch.length} 颗测光反推天体的颜色与计算不符（说明被手改了，或脚本没跑）`, mismatch.join('；'));
      }
    }
  }

  /* E2：**亮度方向**必须对 —— 反照率定了明暗，不许凭"太黑了不好看"手改。
     这一条与 C1 同源：颜色是算出来的，方向错了不是审美问题。 */
  {
    const bad = [];
    const cases = [
      { id: 'ceres', max: 0.28, why: '几何反照率 0.094（Dawn/VIR）—— 谷神星是**暗**的' },
      { id: 'eris', min: 0.80, why: '几何反照率 0.96 —— 阋神星是太阳系最亮的反射体之一' },
    ];
    for (const c of cases) {
      const b = all.find((x) => x.id === c.id);
      if (!b || !b.color) { bad.push(`${c.id} 缺条目或缺 color`); continue; }
      const L = lumLin(b.color);
      if (c.max != null && L >= c.max) bad.push(`${c.id} 线性亮度 ${L.toFixed(3)} ≥ ${c.max} —— 太亮了`);
      if (c.min != null && L <= c.min) bad.push(`${c.id} 线性亮度 ${L.toFixed(3)} ≤ ${c.min} —— 太暗了`);
    }
    if (bad.length === 0) {
      ok('E2 测光反推天体的明暗方向正确（谷神星偏暗、阋神星偏白）',
        cases.map((c) => c.id + ': ' + c.why).join('；'));
    } else {
      no('E2 测光反推天体的明暗与反照率不符 —— 别按"好不好看"改，颜色是算出来的', bad.join('；'));
    }
  }

  /* E3：**色相方向**必须对 —— 这几颗的成色机制是已知的，方向反了就是错的。
     与 C4（天王星必须偏青）同一类 sanity gate。 */
  {
    const bad = [];
    const rgbOf = (id) => {
      const b = all.find((x) => x.id === id);
      return b && b.color ? hex2rgb(b.color) : null;
    };
    // 妊神星：表面是**结晶水冰**，三条约束一致给出 k≈−0.06（中性略偏冷）⇒ 不该偏暖
    const hau = rgbOf('haumea');
    if (!hau) bad.push('haumea 缺条目');
    else if (hau[2] < hau[0]) bad.push(`妊神星偏暖（B=${hau[2]} < R=${hau[0]}）—— 它是结晶水冰，应为中性偏冷`);
    // 鸟神星：甲烷/乙烷冰表面，B−V=0.828 明显比太阳红 ⇒ 必须偏红
    const mak = rgbOf('makemake');
    if (!mak) bad.push('makemake 缺条目');
    else if (mak[0] <= mak[2]) bad.push(`鸟神星不偏红（R=${mak[0]} ≤ B=${mak[2]}）—— 甲烷冰表面应偏红棕`);
    // 阋神星：B−V=0.805 比太阳红 ⇒ 不该偏蓝（旧手写值 #cfd6dd 就是偏蓝的错值）
    const eri = rgbOf('eris');
    if (!eri) bad.push('eris 缺条目');
    else if (eri[2] > eri[0]) bad.push(`阋神星偏蓝（B=${eri[2]} > R=${eri[0]}）—— 实测 B−V=0.805 比太阳红`);

    if (bad.length === 0) {
      ok('E3 测光反推天体的色相方向与各自的成色机制一致（水冰中性 / 甲烷偏红 / 阋神星不偏蓝）');
    } else {
      no('E3 色相方向与成色机制不符', bad.join('；')
        + ' —— 参考旧手写值：#d8d2c8(妊神星暖灰)、#c8a58a(鸟神星土黄)、#cfd6dd(阋神星偏蓝)，三个方向都是错的。');
    }
  }

  /* E4：分档判据自身必须成立 —— **单约束不许判成"最自洽"**。
     `tierOf` 只看 agree 的话，n=1 时 agree 恒为 0，会被判成最可信的一档。
     这条是对判据的判据，防止有人把 `tierOf` 改回去。 */
  {
    const one = PHOTO.tierOf(1, 0);
    const three = PHOTO.tierOf(3, 0.05);
    const loose = PHOTO.tierOf(3, 0.9);
    const bad = [];
    if (one.conf >= three.conf) bad.push(`单约束 conf ${one.conf} 不应 ≥ 三约束自洽的 ${three.conf}`);
    if (loose.conf >= three.conf) bad.push(`极不自洽的 conf ${loose.conf} 不应 ≥ 自洽的 ${three.conf}`);
    if (bad.length === 0) {
      ok('E4 分档先看约束条数再看自洽度（单约束 conf ' + one.conf + ' < 多约束自洽 ' + three.conf + '）');
    } else {
      no('E4 tierOf 的分档顺序错了 —— 单约束会被误判成最可信', bad.join('；'));
    }
  }
}

/* ------------------------------------------------------------------------------
   F 组 · 可信度分档（实算，不是标注）
   ------------------------------------------------------------------------------
   项目口径：**每个天体的颜色属于哪一档，必须说得清** ——
     高  = 实测逐波长光谱/反照率谱            → spectra.js
     中  = 色指数/谱斜率反推（有观测约束）      → photometric-colors.js、moon-families.js
     低  = 其余（属性生成或纯示意）
   为什么放在这里算而不是各写各的：三档的**总账**只有一处能算 ——
   要同时拿到 SPECTRA、PHOTOMETRY、FAMILY_OF 和天体总表。
   ⚠️ 低档数量大**不是故障**，是事实；它必须以 warn 的形式**一直可见**，
      否则"我们全都还原了真彩"这种话会悄悄变成假设。
   ------------------------------------------------------------------------------ */
notes.push('');
notes.push('▸ F 组 · 可信度分档');

{
  const measured = new Set(Object.keys(SPECTRA));
  // ⚠️ 用 PHOTO.PHOTOMETRY 而不是裸 PHOTOMETRY：后者是在上面的 if 块里解构的，
  //    出了块就是 ReferenceError（撞过）。
  const photometric = PHOTO ? new Set(Object.keys(PHOTO.PHOTOMETRY)) : new Set();
  const family = FAM ? new Set(Object.keys(FAM.FAMILY_OF)) : new Set();

  const high = [];
  const mid = [];
  const low = [];
  for (const b of all) {
    if (measured.has(b.id)) { high.push(b.id); continue; }
    if (photometric.has(b.id) || family.has(b.id)) { mid.push(b.id); continue; }
    low.push(b.id);
  }

  const pct = (n) => Math.round((n / all.length) * 100) + '%';
  ok(`F1 三档来源分明：高 ${high.length} · 中 ${mid.length} · 低 ${low.length}（共 ${all.length}）`,
    `高 = 实测谱（${pct(high.length)}）· 中 = 色指数反推（${pct(mid.length)}）· 低 = 其余（${pct(low.length)}）`);

  /* F2：两张登记表各自的**真实契约** —— 别拿错假设去断言，假警报和漏报一样有害。
     ⚠️ SPECTRA **不是天体表，是光谱库**：里面既有天体谱（pluto、io…），
        也有**材质/表面谱**（moon_mare 月海、jupiter_belt 木星暗带、comet_nucleus…）。
        第一版这里断言"SPECTRA 的每个 key 都必须是天体"，于是把 6 个材质谱
        报成了"登记表在骗人" —— 一个由**判据自身的错误假设**制造的假故障。
        改按它们真正的契约验。 */
  {
    const bad = [];

    // F2a：测光登记表的 key 按构造就是天体 id —— 必须真在天体总表里
    for (const id of photometric) {
      if (!all.some((b) => b.id === id)) bad.push(`测光登记表的 ${id} 不是总表里的天体`);
    }

    // F2b：光谱库的自我声明契约（spectra.js 文件头要求的字段）
    for (const [k, v] of Object.entries(SPECTRA)) {
      if (!Array.isArray(v.kinds) || v.kinds.length === 0) bad.push(`SPECTRA.${k} 没有声明 kinds`);
      if (typeof v.src !== 'string' || !v.src.trim()) bad.push(`SPECTRA.${k} 没有 src 出处（文件头禁止无出处条目）`);
      if (!Number.isFinite(v.geoAlbedo) || v.geoAlbedo <= 0) bad.push(`SPECTRA.${k} 的 geoAlbedo 非法`);
    }

    // F2c：凡是**天体 id** 的光谱，必须已被 C1 覆盖 —— 否则它的颜色没人断言
    const covered = new Set(Object.values(MAP).filter(Boolean));
    for (const k of Object.keys(SPECTRA)) {
      const isBody = all.some((b) => b.id === k);
      if (isBody && !covered.has(k)) {
        bad.push(`SPECTRA.${k} 是天体却不在 C1 的映射里 —— 它的颜色没有被任何检查断言`);
      }
    }

    if (bad.length === 0) {
      ok(`F2 两张登记表契约成立（测光 ${photometric.size} 条都是天体；光谱 ${Object.keys(SPECTRA).length} 条均有 kinds/src/geoAlbedo，天体谱均被 C1 覆盖）`);
    } else {
      no('F2 登记表契约被破坏', bad.join('；'));
    }
  }

  /* F3：低档必须一直可见 —— 数量级变了（比如有人批量生成颜色却不标来源）要看得见 */
  {
    if (low.length / all.length > 0.5) {
      wr(`F3 有 ${low.length}/${all.length} 个天体（${pct(low.length)}）的颜色**没有可追溯来源**`,
        '它们既不在实测谱表、也不在测光登记表、也不属于任何动力学族。'
        + '界面上必须把它们标成"示意"档，不能与实测色混在一起呈现。'
        + '要提升这一档，走 Request C：属性驱动程序化生成 + 测光反推。');
    } else {
      ok('F3 无可追溯来源的天体已不足半数');
    }
  }
}

console.log(notes.join('\n'));
console.log('');
console.log('=== ' + pass + ' 通过 / ' + warn + ' 告警 / ' + fail + ' 失败 ===');
if (fail > 0) {
  console.log('>>> 有失败项，需要处理');
  process.exit(1);
}
console.log('>>> 无失败项');

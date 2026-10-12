#!/usr/bin/env node
/**
 * 离线判据：「距离标尺」是否真的都不在场 —— 以及**替代物**是否还在。
 *
 * ## 背景（2026-09-12 第 37 轮）
 *
 * 怪怪对着本星系群层说：「这些超大天体集合体下的这个圈啥情况，恒星上也有，都去了」。
 * 实测定位（`tools/diag-scene-rings.py` 枚举场景对象）后发现**五个层各有一套距离刻度**：
 *
 * | 层 | 原来的东西 | 前缀 |
 * |---|---|---|
 * | 近邻星系 | 10/25/50/100 光年的**正交球壳**（不是圆环） | `shell-` |
 * | 银河系 | 10/25/40/52.8 千光年的同心圆 | `mw-ring-` |
 * | 本星系群 | 1/2/5 百万光年的同心圆 | `lg-ring-` |
 * | 超星系团 | 100/300/600 百万光年的同心圆 | `sc-ring-` |
 * | 可观测宇宙 | 0.1/1/10/45.2 十亿光年的同心圆 | `uv-ring-` |
 *
 * 全部删除。口径写在 `cosmos.js::LocalGroupLevel.build()` 里那段（另有四处同样的注释）。
 *
 * ## 三条判据（每条都要能响）
 *
 * 1. **`no-scale-rings`**：五个层级文件里既没有标尺环的**颜色签名**，也没有它们的**标签前缀**。
 *    为什么要两条一起查：颜色是「线本身」，标签是「挂在线上的字」——
 *    只删线不删标签，会留下四条**指向不存在的东西**的文字，那是另一种静默故障。
 * 2. **`scale-label-alive`**：五个层都还有 `scaleLabel`（底栏的视距读数）。
 *    ⚠️ 这条是**防腐**判据：删掉一个东西之前，必须先确认**替代物真的存在**。
 *    没这条，将来有人把 `scaleLabel` 顺手清了，「尺度感」就彻底没了而没人发现。
 * 3. **`structure-rings-kept`**：`makeRingMarker()` 在超星系团层与可观测宇宙层**仍然在用**。
 *    ⚠️ 同样是**防腐**、方向相反：那一族环**不是刻度**，是「这个结构有多真实地大」
 *    （室女座星系团 7.5 Mly 的边界）—— 它在截图里**长得几乎一样**，
 *    下一次有人照着「把圈都删掉」再来一遍，一定会误删它。这条判据就是拦这个的。
 *
 * 用法：
 *   node tools/check-scale-rings.mjs            # 只看结论
 *   node tools/check-scale-rings.mjs --selftest # 每条判据逐个注入坏值，必须变红
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lib/strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 五个尺度层。`solar` 也列进来：它当时没有标尺环，但要**防止**以后加。 */
const LEVEL_FILES = {
  solar: 'web/js/levels/solar.js',
  neighborhood: 'web/js/levels/neighborhood.js',
  galaxy: 'web/js/levels/galaxy.js',
  supercluster: 'web/js/levels/supercluster.js',
  cosmos: 'web/js/levels/cosmos.js',
};

/** 标尺环的**颜色签名**。两种：平面圆环一种、近邻层的球壳一种。 */
const RING_COLORS = ['0x3a6a9a', '0x3a5a86'];

/** 标尺的标签前缀。命中写成**模板字符串构造**（`` `lg-ring-${r}` ``）才算，
 *  这样「注释里提到这个名字」不会误报（反正也已经剥了注释，双保险）。 */
const RING_LABEL_RE = /`(?:lg|mw|sc|uv)-ring-\$\{|`shell-\$\{/;

/** 结构边界环的现役调用点。
 *  ⚠️ 2026-10-12 从 ['cosmos','supercluster'] 收窄为 ['supercluster']：
 *  用户对着可观测宇宙层的原话「可观测宇宙里面别给宏观结构加莫名其妙的圈」
 *  ⇒ cosmos.js（UniverseLevel）的 makeRingMarker 已按用户判词删除
 *     （半径信息在标签副行与天体面板里，环在画面上只读出噪声）；
 *  超星系团层的环用户没有点名，维持原状、继续受本判据保护。 */
const STRUCTURE_RING_FILES = ['supercluster'];

async function loadCtx() {
  const files = {};
  await Promise.all(Object.entries(LEVEL_FILES).map(async ([k, rel]) => {
    files[k] = await readFile(path.join(ROOT, rel), 'utf8');
  }));
  return { files };
}

function runChecks(ctx) {
  const rows = [];
  const add = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: String(detail) });

  /* —— 1. 标尺环不在场（颜色 + 标签两条一起） —— */
  const colorHits = [];
  const labelHits = [];
  for (const [lv, src] of Object.entries(ctx.files)) {
    const code = stripComments(src);
    for (const c of RING_COLORS) if (code.includes(c)) colorHits.push(`${lv}:${c}`);
    if (RING_LABEL_RE.test(code)) labelHits.push(`${lv}:${code.match(RING_LABEL_RE)[0]}`);
  }
  const noRings = colorHits.length === 0 && labelHits.length === 0;
  add('no-scale-rings', noRings,
    `颜色签名命中 ${colorHits.length ? colorHits.join(' / ') : '无'} · `
    + `标签前缀命中 ${labelHits.length ? labelHits.join(' / ') : '无'}`
    + `（五个层：${Object.keys(LEVEL_FILES).join(' ')}）`);

  /* —— 2. 替代物在场：底栏视距读数 —— */
  const missingScale = [];
  for (const [lv, src] of Object.entries(ctx.files)) {
    if (!stripComments(src).includes('scaleLabel')) missingScale.push(lv);
  }
  add('scale-label-alive', missingScale.length === 0,
    missingScale.length
      ? `这些层没有 scaleLabel：${missingScale.join(' / ')} —— 刻度删了、替代物也没了，「尺度感」会彻底消失`
      : '五个层都还有 scaleLabel（底栏「视距 ≈ X」的读数）');

  /* —— 3. 结构边界环不许被误删 —— */
  const lostStructure = [];
  for (const lv of STRUCTURE_RING_FILES) {
    if (!stripComments(ctx.files[lv]).includes('makeRingMarker({')) lostStructure.push(lv);
  }
  add('structure-rings-kept', lostStructure.length === 0,
    lostStructure.length
      ? `这些层把结构边界环也删了：${lostStructure.join(' / ')} —— 那不是刻度，是结构本身的大小`
      : `${STRUCTURE_RING_FILES.join(' / ')} 仍在用 makeRingMarker()（超星系团/星系群的边界环）`);

  return rows;
}

/* 自证用的「定向破坏」。每一条只该让它指名的那一项变红。 */
const MUTATIONS = [
  // 把标尺环的颜色签名塞回某一个层 ⇒ no-scale-rings 必须红
  ['no-scale-rings', (c) => {
    c.files.galaxy += '\nconst _x = new THREE.LineBasicMaterial({ color: 0x3a6a9a });\n';
  }],
  // 把标尺的标签前缀塞回某一个层 ⇒ 同上（这一条专打「只删线不删字」那一半）
  ['no-scale-rings', (c) => {
    c.files.neighborhood += '\nthis.labels.add(`shell-${r}`, {});\n';
  }],
  // 把底栏视距读数从一个层里拿掉 ⇒ scale-label-alive 必须红
  ['scale-label-alive', (c) => { c.files.cosmos = c.files.cosmos.replaceAll('scaleLabel', 'xLabel'); }],
  // 把结构边界环误删 ⇒ structure-rings-kept 必须红
  ['structure-rings-kept', (c) => { c.files.supercluster = c.files.supercluster.replace('makeRingMarker({', 'noSuchCall({'); }],
];

async function main() {
  const doSelf = process.argv.includes('--selftest');
  let ctx;
  try {
    ctx = await loadCtx();
  } catch (e) {
    console.error(`FAIL  读不到检查对象：${e.message}`);
    process.exit(1);
  }

  const before = runChecks(ctx);
  const width = Math.max(...before.map((r) => r.name.length));
  console.log('');
  for (const r of before) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = before.filter((r) => !r.ok);

  if (!doSelf) {
    console.log('');
    if (failed.length) {
      console.log(`  未通过 ${failed.length} / ${before.length} 项：${failed.map((r) => r.name).join(', ')}`);
      process.exit(1);
    }
    console.log('  全部通过。');
    return;
  }

  console.log('\n  自证（注入 → 该条判据必须变红）');
  let bad = 0;
  for (const [target, mutate] of MUTATIONS) {
    const clone = { files: { ...ctx.files } };
    mutate(clone);
    const after = runChecks(clone);
    const hit = after.find((r) => r.name === target);
    const others = after.filter((r) => !r.ok && r.name !== target).map((r) => r.name);
    if (hit && !hit.ok) {
      console.log(`  ✓ 注入「${target}」→ ${target} 变红${others.length ? `  ⚠ 顺带变红：${others.join(', ')}` : ''}`);
    } else {
      bad++;
      console.log(`  ✗ 注入「${target}」→ **没有变红** —— 这条判据不会响，等于没有`);
    }
  }
  console.log('');
  if (bad || failed.length) {
    console.log(`  未通过：${bad} 条注入没响 · 基线 ${failed.length} 项未通过`);
    process.exit(1);
  }
  console.log(`  自证通过：${MUTATIONS.length} 条注入都会让对应判据变红。`);
}

main();

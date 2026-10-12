#!/usr/bin/env node
/* ==============================================================================
   check-photometry.mjs —— 对账：`photometric-colors.js` 里手抄的测光值，
   是否真的等于 `data/photometry.json` 里机器解析出来的值。

   为什么非要有这条检查
   ──────────────────────────────────────────────────────────────────────────────
   测光值从上游表到颜色登记表，中间是**人手誊抄**的一步：
       data/raw/mboss2.dat → (fetch-mboss.mjs) → data/photometry.json
                                                ↓  ← 这一步是人抄的
                                        web/js/color/photometric-colors.js
   本项目对"抄"这件事有明确结论（坑 33）：**誊抄一次就腐烂一次**，
   而且抄错了不会有任何症状 —— 颜色会安静地偏一点，谁也看不出来。

   ⇒ 所以不许"相信抄对了"，必须机器对账。三件事：

     1. **值对账**   —— 登记表里每个有 `mbossKey` 的量，必须与表里逐位相等；
                        登记表里**没有**的量（如鸟神星的 V−R），表里也必须没有。
                        （防止"把空缺补成一个猜测值"这种最难发现的事）
     2. **豁免自证** —— 没有 `mbossKey` 的条目（谷神星）必须写明 `notInMboss` 理由。
                        **豁免要自证，不要维护中央清单** —— 清单会腐烂。
     3. **派生文件不陈旧** —— `data/photometry.json` 里记的源文件 sha1，
                        必须等于 `data/raw/mboss2.dat` 现在的 sha1。
                        不等就说明表换过了、派生值没重算 —— 一切对账都是空话。

   用法： node tools/check-photometry.mjs
   退出码： 0 = 全部对账通过；1 = 有对不上（或派生文件陈旧）
   ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const RAW = path.join(ROOT, 'data/raw/mboss2.dat');
const DERIVED = path.join(ROOT, 'data/photometry.json');

const { PHOTOMETRY } = await import(pathToFileURL(path.join(ROOT, 'web/js/color/photometric-colors.js')).href);

const fails = [];
let checkedFields = 0;

/* ---------- 3. 派生文件不陈旧 ---------- */
if (!fs.existsSync(DERIVED)) {
  fails.push('data/photometry.json 不存在 —— 跑 node tools/fetch-mboss.mjs --offline 生成');
}
if (!fs.existsSync(RAW)) {
  fails.push('data/raw/mboss2.dat 不存在 —— 跑 node tools/fetch-mboss.mjs 抓取');
}

let table = null;
if (!fails.length) {
  table = JSON.parse(fs.readFileSync(DERIVED, 'utf8'));
  const sha = createHash('sha1').update(fs.readFileSync(RAW)).digest('hex');
  if (table.source?.sha1 !== sha) {
    fails.push(
      `派生文件陈旧：data/photometry.json 记的源 sha1 是 ${String(table.source?.sha1).slice(0, 12)}…，`
      + `而 data/raw/mboss2.dat 现在是 ${sha.slice(0, 12)}… —— 重跑 node tools/fetch-mboss.mjs --offline`,
    );
  }
}

/* ---------- 1 & 2. 逐条对账 ---------- */
const FIELDS = [
  ['bv', 'B−V'],
  ['vr', 'V−R'],
  ['grt', '谱斜率 Grt'],
];
const GRT_KEY = 'grtPctPerKA';   // 登记表里的字段名和表里的列名不一样

const rows = [];
for (const [id, e] of Object.entries(PHOTOMETRY)) {
  if (!e.mbossKey) {
    const ok = typeof e.notInMboss === 'string' && e.notInMboss.trim().length >= 20;
    rows.push(`  ${ok ? '✓' : '✗'} ${id.padEnd(10)} 不在 MBOSS（豁免已自证）`);
    if (!ok) {
      fails.push(
        `${id} 既没有 mbossKey、也没有像样的 notInMboss 理由 —— `
        + '豁免必须自证：写清为什么这个天体不在上游表里（否则无从判断是"表里没有"还是"漏抄了"）',
      );
    }
    continue;
  }
  if (!table) { rows.push(`  · ${id.padEnd(10)} （表不可用，跳过）`); continue; }

  const o = table.objects[e.mbossKey];
  if (!o) {
    fails.push(`${id} 声明的 mbossKey「${e.mbossKey}」在 data/photometry.json 里找不到`);
    rows.push(`  ✗ ${id.padEnd(10)} mbossKey「${e.mbossKey}」不在表里`);
    continue;
  }

  let bad = 0;
  for (const [col, label] of FIELDS) {
    const mine = col === 'grt' ? e[GRT_KEY] : e[col];
    const theirs = o[col]?.v;
    checkedFields++;
    const mineAbsent = mine == null;
    const theirsAbsent = theirs == null;
    if (mineAbsent && theirsAbsent) continue;                 // 两边都没有 = 一致（最要紧的一种）
    if (mineAbsent !== theirsAbsent) {
      bad++;
      fails.push(
        `${id} 的 ${label}：登记表写的是 ${mineAbsent ? '(空)' : mine}，`
        + `而上游表里是 ${theirsAbsent ? '(空)' : theirs} —— `
        + (mineAbsent ? '上游有、我们没用上' : '★上游没有、我们却写了一个值（等于编数据）'),
      );
      continue;
    }
    if (Math.abs(mine - theirs) > 1e-9) {
      bad++;
      fails.push(`${id} 的 ${label} 抄错了：登记表 ${mine}，上游表 ${theirs}`);
    }
  }
  rows.push(`  ${bad ? '✗' : '✓'} ${id.padEnd(10)} <- ${e.mbossKey}（${bad ? bad + ' 处不符' : '逐位一致'}）`);

  if (e.epochs != null && o.epo != null && e.epochs !== o.epo) {
    fails.push(`${id} 的 epochs 抄错了：登记表 ${e.epochs}，上游表 ${o.epo}`);
  }
}

/* ---------- 输出 ---------- */
console.log('');
console.log('  测光登记表 · 对账报告');
console.log('  ' + '─'.repeat(60));
console.log(`  登记条目 ${Object.keys(PHOTOMETRY).length} 个 · 比对字段 ${checkedFields} 个`);
console.log('');
for (const r of rows) console.log(r);
console.log('');

if (fails.length) {
  console.log(`  ✗ ${fails.length} 处对不上：`);
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  console.log('  怎么修：值对不上就改 web/js/color/photometric-colors.js 去匹配表；');
  console.log('          表本身过期就重跑 node tools/fetch-mboss.mjs --offline。');
  console.log('          ⚠️ 绝对不要反过来改 data/ 下的派生文件去迁就登记表。');
  process.exit(1);
}

console.log('  ✓ 登记表与上游测光汇编逐位一致，派生文件也不陈旧。');
console.log('');

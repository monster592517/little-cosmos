#!/usr/bin/env node
/* ==============================================================================
   apply-dwarf-colors.mjs —— 给 4 颗矮行星算出真彩并写回 web/js/data/solar-system.js

   为什么需要这个脚本
   ──────────────────────────────────────────────────────────────────────────────
   谷神星 / 阋神星 / 妊神星 / 鸟神星这 4 颗，`color` 字段**一直是失效的**：
   它们在文件里长这样（以谷神星为例）——

       id: 'ceres', type: 'dwarf', ... parent: 'sun',
       // ⚠️ 待程序化生成：谷神星：Dawn 有影像但无公开逐波长反照率谱。走程序化（碳质小行星类）。
       //   现行值 #a89b8c 是手写近似，**未经 CIE 计算**；Request C 属性驱动生成器接管后替换。 color: '#a89b8c',

   ⚠️ 注意最后一行：`color:` 跟在一行 `//` 注释的**行尾**。
   它是被 `apply-true-colors.mjs` 的 PENDING 分支生成的 —— 那段代码把 color 片段
   拼在了 marker 之后却没有补一个换行，于是` color: '#a89b8c',` 掉进了注释里。
   ⇒ 后果：这 4 个天体在程序里**根本没有 color 字段**，渲染时吃兜底灰，
     而**没有任何报错**；同时脚本自己报的是"已加标记，成功"。
   ⇒ 这是"看着成功、其实什么都没做"的又一例（见 坑与雷点.md：静默故障）。

   本脚本一次性做三件事：
     1. 删掉那两行失效注释（含被吞掉的 color 片段）
     2. 用 photometric-colors.js 算出真彩 render 值
     3. 写成一整块：出处注释 + **独立成行**的 color

   颜色从哪来
   ──────────────────────────────────────────────────────────────────────────────
   这 4 颗都**测不到逐波长反射率谱**，所以不能进 spectra.js 的"高"档。
   但它们都有可靠的宽带测光（MBOSS-2 汇编 + Dawn/VIR）⇒ 走"中"档：
     色指数/谱斜率 → spectrumFromConstraints() → 反射率谱 → CIE → #rrggbb
   全程可复现：同样的输入必然得到同一个 hex，没人需要"相信"我。

   用法
   ──────────────────────────────────────────────────────────────────────────────
     node tools/apply-dwarf-colors.mjs            # 实际写入
     node tools/apply-dwarf-colors.mjs --dry      # 只打印将要做的改动
     node tools/apply-dwarf-colors.mjs --verify   # 只核对现状（CI 用，不改文件）
   ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET = path.join(ROOT, 'web/js/data/solar-system.js');

const { photometryColor } = await import(
  pathToFileURL(path.join(ROOT, 'web/js/color/photometric-colors.js')).href
);

/** 写入后注释里必然出现的字样 —— 幂等重跑靠它认出来「已经是我们写的了」 */
const OUR_MARK = '由色指数反推';
/** 上一轮遗留的失效标记 —— 出现它才允许动手 */
const STALE_MARK = '待程序化生成';

const I4 = '    ';

const IDS = ['ceres', 'eris', 'haumea', 'makemake'];

/** 锚点：id 行 + 紧随的任意条注释行 + 可选的「独立成行」color 行 */
function anchorOf(id) {
  return new RegExp(
    `(\\n${I4}id: '${id}',[^\\n]*\\n)` +          // $1 id 行
    `((?:${I4}//[^\\n]*\\n)*)` +                  // $2 紧随的注释行（含被吞掉 color 的那行）
    `(?:${I4}color: '#[0-9a-fA-F]{6}',\\n)?`,     // 可选：独立成行的 color
  );
}

function buildBlock(id, c) {
  const kStr = Object.entries(c.kFrom).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ');
  return (
    `${I4}// 真彩（${OUR_MARK}）：${c.tier}档 · ${c.n} 条约束（${kStr}，k=${c.k.toFixed(3)}）· 几何反照率 ${c.geoAlbedo}。\n` +
    `${I4}// 出处：${c.src}\n` +
    `${I4}// ${c.note.replace(/\n/g, `\n${I4}// `)}\n` +
    `${I4}color: '${c.render}',\n`
  );
}

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const VERIFY = argv.includes('--verify');

let src = fs.readFileSync(TARGET, 'utf8');
const orig = src;
const log = [];
const problems = [];

for (const id of IDS) {
  const c = photometryColor(id);           // 不在登记表 / 约束不足 → 直接抛，不静默跳过
  const re = anchorOf(id);

  const all = src.match(new RegExp(re.source, 'g'));
  if (!all || all.length !== 1) {
    throw new Error(
      `[${id}] 锚点命中 ${all ? all.length : 0} 次（必须恰好 1 次）——拒绝改动，防止改错行。\n` +
      `  命中片段: ${JSON.stringify(all && all[0] && all[0].slice(0, 120))}`,
    );
  }
  const m = re.exec(src);
  const comments = m[2] || '';

  if (comments.includes(OUR_MARK)) {
    // 已经是我们写的了 —— 核对值有没有变（上游数据更新时会变）
    const cur = new RegExp(`${I4}color: '(#[0-9a-fA-F]{6})',\\n`).exec(src.slice(m.index, m.index + 900));
    const ok = cur && cur[1] === c.render;
    log.push(`${ok ? '✓' : '✗'} ${id.padEnd(10)} 已就位 ${c.render} （${c.tier}档 conf ${c.conf}）`);
    if (!ok) problems.push(`${id}: 文件里是 ${cur ? cur[1] : '(没有)'}，应为 ${c.render}`);
    continue;
  }

  if (!comments.includes(STALE_MARK)) {
    throw new Error(
      `[${id}] 既不是我们写的、也找不到「${STALE_MARK}」标记 —— 文件被手改过？\n` +
      `  现有注释:\n${comments || '(无)'}\n  拒绝覆盖。`,
    );
  }

  const block = buildBlock(id, c);
  src = src.replace(re, `${m[1]}${block}`);
  log.push(
    `· ${id.padEnd(10)} ${c.render}  ← 修掉失效注释` +
    `（旧手写值见 git 历史；${c.tier}档 · ${c.reason}）`,
  );
}

console.log(log.join('\n'));
console.log('');

for (const p of problems) console.log(`⚠️ ${p}`);

if (VERIFY) {
  if (problems.length) { console.log('❌ 与目标状态不一致'); process.exit(1); }
  console.log(orig === src ? '✅ 文件已是目标状态' : '⚠️ 文件与目标状态不同');
  process.exit(orig === src && !problems.length ? 0 : 1);
}

if (problems.length) { console.log('❌ 有问题未解决，不写入'); process.exit(1); }

if (DRY) { console.log('—— DRY RUN，未写入 ——'); process.exit(0); }

if (orig === src) { console.log('无需改动'); process.exit(0); }

/* 写入前备份（幂等：已存在就不覆盖，保住最早那一份） */
const bak = TARGET + '.bak-dwarfcolor';
if (!fs.existsSync(bak)) {
  fs.writeFileSync(bak, orig);
  console.log(`备份原文件 → ${path.basename(bak)}`);
}

fs.writeFileSync(TARGET, src);
console.log(`✅ 已写入 ${path.relative(ROOT, TARGET)}`);

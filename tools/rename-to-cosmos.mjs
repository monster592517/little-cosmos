#!/usr/bin/env node
/**
 * 更名：小小太阳系 → 小小宇宙　｜　Little Solar System → Little Cosmos
 *
 * 用法：
 *   node tools/rename-to-cosmos.mjs            # 预演，只打印将要改什么
 *   node tools/rename-to-cosmos.mjs --apply    # 真的改（会先把原文件备份到 .trash/）
 *
 * 设计原则（沿用 apply-audit-fixes.mjs 的规矩）：
 *   1. 只改**明确列出**的文件，不做全库无差别替换；
 *   2. 每条规则都检查命中次数，命中 0 次会报警（防止规则过期变成摆设）；
 *   3. 改完做反向断言：不该再出现旧名的文件里，若还有旧名就直接报错退出；
 *   4. 尺度层级名「太阳系」必须保留 —— 它现在是「小小宇宙」里的一个层级，不是产品名。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ⚠️ 别用 new URL(...).pathname —— Windows 下路径含中文会被百分号编码，ROOT 直接失效。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const TRASH = path.join(ROOT, '.trash', 'rename-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

// ── 要处理的文件（相对路径） ────────────────────────────────────────────
const TARGETS = [
  'README.md',
  'package.json',
  'server/server.mjs',
  'web/index.html',
  'web/css/app.css',
  'web/js/main.js',
  'web/js/ui/datacenter.js',
  'tools/package.mjs',
  'tools/fetch-assets.mjs',
  'tools/check-scales.py',
  'README.md',
  '启动小小太阳系.bat',
];

// 历史文档：只改标题行，正文里的旧名是**真实历史**，不许篡改
const HISTORY_DOC = '坑与雷点.md';

// ── 通用替换规则（按顺序执行，长串在前） ────────────────────────────────
const RULES = [
  { from: 'Little Solar System Server', to: 'Little Cosmos Server' },
  { from: 'Little Solar System', to: 'Little Cosmos' },
  { from: 'little-solar-system', to: 'little-cosmos' },
  { from: 'SOLARSYSTEM_NO_BROWSER', to: 'COSMOS_NO_BROWSER' },
  { from: '小小太阳系', to: '小小宇宙' },
];

// ── 逐文件的精细补丁（在通用规则之后执行，from 是**通用规则跑完之后**的文本） ──
const PATCHES = [
  {
    file: 'README.md',
    note: '标题与定位',
    from: '# 小小宇宙 · 从太阳系到可观测宇宙\n\n网页版三维宇宙地图：**天体位置按真实星历实时计算**，从太阳系一路连到可观测宇宙，\n共**六个尺度层级**；每个天体都有 3D 建模与完整物理属性，点一下就能看资料、\n看它最新的研究论文（自带检索器 + 中文翻译）。',
    to: '# 小小宇宙 · 全宇宙仿真还原 + 研究论文直达\n\n网页版三维宇宙：**从太阳系一路连到可观测宇宙，六个尺度层级拼成一个完整宇宙**，\n天体位置按真实星历实时计算。每个天体都有 3D 建模与完整物理属性，\n点一下就能看资料、并且**直接跳到它的研究论文**（四源检索 + 中文翻译 + 中文进展简报）。',
  },
  {
    file: 'web/index.html',
    note: '页面标题',
    from: '<title>小小宇宙 · 从太阳系到可观测宇宙</title>',
    to: '<title>小小宇宙 · 全宇宙仿真与论文直达</title>',
  },
  {
    file: 'web/index.html',
    note: 'meta description',
    from: '<meta name="description" content="网页版多尺度三维宇宙：太阳系 → 邻近恒星系 → 银河系 → 本星系群 → 室女座超星系团 → 可观测宇宙。真实星历位置、真实编目天体、3D 建模、自建论文搜索引擎">',
    to: '<meta name="description" content="网页版全宇宙仿真：太阳系 → 邻近恒星系 → 银河系 → 本星系群 → 室女座超星系团 → 可观测宇宙，六个尺度层级拼成完整宇宙。真实星历位置、真实编目天体、全天体 3D 建模，论文直达（arXiv / OpenAlex / Crossref / Semantic Scholar 四源检索 + 中文翻译）">',
  },
  {
    file: 'package.json',
    note: '包描述',
    from: '"description": "小小宇宙：网页版三维太阳系（真实星历位置 + 全天体 3D 建模 + 建模影像来源 + 论文元搜索引擎与中英翻译）"',
    to: '"description": "小小宇宙：网页版全宇宙仿真（太阳系到可观测宇宙六个尺度层级 + 真实星历位置 + 全天体 3D 建模 + 论文四源直达与中文翻译）"',
  },
  {
    file: '坑与雷点.md',
    note: '历史文档标题（正文旧名属真实历史，不改）',
    from: '# 小小太阳系 · 开发对话记录\n',
    to: '# 小小宇宙 · 开发对话记录\n\n> ⚠️ 本文档记录的是**真实历史**：本项目在第 13 轮被命名为「小小太阳系」，\n> 之后（2026-09-11）更名为「小小宇宙」。下文出现的旧名是当时的原话，**保留不改**。\n',
  },
];

// ── 反向断言：这些文件在改完后不许再出现旧名 ──────────────────────────
const FORBIDDEN_AFTER = ['小小太阳系', 'Little Solar System', 'little-solar-system', 'SOLARSYSTEM'];

// 服务端启动横幅要按新宽度重新对齐全角/半角
const BANNER = (() => {
  const w = (s) => [...s].reduce((a, c) => a + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1), 0);
  const content = '小小宇宙 · Little Cosmos';
  const inner = 46;
  const pad = inner - w(content) - 3; // 左侧固定 3 空格
  return [
    '  console.log(\'  ╭──────────────────────────────────────────────╮\');',
    `  console.log('  │   ${content}${' '.repeat(pad)}│');`,
    '  console.log(\'  ╰──────────────────────────────────────────────╯\');',
  ];
})();

// ── 执行 ───────────────────────────────────────────────────────────────
const report = [];
const L = (s = '') => { report.push(s); console.log(s); };
let touched = 0;
let ruleHits = new Map(RULES.map((r) => [r.from, 0]));

for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) { L(`✗ 缺失文件：${rel}`); process.exitCode = 1; continue; }
  const before = readFileSync(abs, 'utf8');
  let text = before;
  const ops = [];

  for (const r of RULES) {
    const n = text.split(r.from).length - 1;
    if (n) { ruleHits.set(r.from, ruleHits.get(r.from) + n); text = text.split(r.from).join(r.to); ops.push(`${r.from} → ${r.to} ×${n}`); }
  }
  for (const p of PATCHES.filter((p) => p.file === rel)) {
    const n = text.split(p.from).length - 1;
    if (n !== 1) { L(`✗ ${rel}：补丁「${p.note}」命中 ${n} 次（应为 1），已跳过`); process.exitCode = 1; continue; }
    text = text.split(p.from).join(p.to);
    ops.push(`补丁「${p.note}」`);
  }

  if (rel === 'server/server.mjs' && text !== before) {
    // 重建横幅。别用大正则去啃行尾：Windows 文件是 CRLF，`\n` 直接匹配不上。
    // 按行定位最稳 —— 找到含「╭」的那行，替换它和它后面两行。
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes("console.log('  ╭"));
    if (i >= 0 && lines[i + 2] && lines[i + 2].includes("console.log('  ╰")) {
      lines.splice(i, 3, ...BANNER);
      text = lines.join(eol);
      ops.push('重排启动横幅对齐');
    } else {
      L(`✗ server/server.mjs：没找到启动横幅（在第 ${i + 1} 行附近），跳过重排`);
      process.exitCode = 1;
    }
  }

  if (text === before) { L(`·  ${rel}　无改动`); continue; }

  // 反向断言
  const still = FORBIDDEN_AFTER.filter((f) => text.includes(f));
  if (still.length) { L(`✗ ${rel}：改完仍含旧名 ${still.join(' / ')}，已中止该文件`); process.exitCode = 1; continue; }

  L(`✓  ${rel}`);
  for (const o of ops) L(`      ${o}`);
  touched++;

  if (APPLY) {
    mkdirSync(path.dirname(path.join(TRASH, rel)), { recursive: true });
    copyFileSync(abs, path.join(TRASH, rel));
    writeFileSync(abs, text, 'utf8');
  }
}

// ── 历史文档单独处理 ───────────────────────────────────────────────────
{
  const abs = path.join(ROOT, HISTORY_DOC);
  if (existsSync(abs)) {
    const before = readFileSync(abs, 'utf8');
    let text = before;
    let n = 0;
    for (const p of PATCHES.filter((p) => p.file === HISTORY_DOC)) {
      const c = text.split(p.from).length - 1;
      if (c === 1) { text = text.split(p.from).join(p.to); n++; }
      else L(`✗ ${HISTORY_DOC}：补丁命中 ${c} 次（应为 1），跳过`);
    }
    if (text !== before) {
      L(`✓  ${HISTORY_DOC}　（仅改标题 + 加说明；正文旧名保留为历史）`);
      touched++;
      if (APPLY) {
        mkdirSync(TRASH, { recursive: true });
        copyFileSync(abs, path.join(TRASH, HISTORY_DOC));
        writeFileSync(abs, text, 'utf8');
      }
    } else L(`·  ${HISTORY_DOC}　无改动`);
  }
}

// ── 启动器改名 ─────────────────────────────────────────────────────────
const OLD_BAT = '启动小小太阳系.bat';
const NEW_BAT = '启动小小宇宙.bat';
if (existsSync(path.join(ROOT, OLD_BAT))) {
  L('');
  L(`✓  启动器改名：${OLD_BAT} → ${NEW_BAT}`);
  if (APPLY) {
    const dst = path.join(ROOT, NEW_BAT);
    if (existsSync(dst)) L(`   ⚠️ 目标已存在，未覆盖，请手工确认：${NEW_BAT}`);
    else {
      const buf = readFileSync(path.join(ROOT, OLD_BAT));           // 已经是改过内部标识的内容
      mkdirSync(TRASH, { recursive: true });
      copyFileSync(path.join(ROOT, OLD_BAT), path.join(TRASH, OLD_BAT));
      // 统一成 CRLF，避免 bat 在 cmd 下换行异常
      writeFileSync(dst, buf.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
      renameSync(path.join(ROOT, OLD_BAT), path.join(TRASH, '_old-bat-removed'));
      L(`   原文件已移入隔离区：${path.relative(ROOT, path.join(TRASH, OLD_BAT))}`);
    }
  }
}

// ── 收尾报告 ───────────────────────────────────────────────────────────
L('');
L('════ 规则命中统计（0 次 = 规则过期，要检查） ════');
for (const [k, v] of ruleHits) L(`  ${v === 0 ? '⚠️ ' : '   '}${k}  ×${v}`);
L('');
L(`共 ${touched} 个文件${APPLY ? '已改写' : '待改写（预演模式，加 --apply 才动）'}`);
if (APPLY) L(`原文件备份在：${path.relative(ROOT, TRASH)}`);

writeFileSync(path.join(ROOT, 'tools', '_rename-report.txt'), report.join('\n'), 'utf8');

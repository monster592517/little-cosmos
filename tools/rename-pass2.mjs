#!/usr/bin/env node
/**
 * 小小宇宙 · 更名收尾（第二轮）
 *
 * 为什么还要第二轮：第一轮 `rename-to-cosmos.mjs` 用的是**手写 TARGETS 清单**（13 个文件），
 * 结果 `server/lib/` 的 UA 字符串、`package-lock.json`、`web/js/core/gpu.js`、
 * 以及所有 `lss.*` schema 前缀全部漏在网外。
 * 教训：靠"我记得改哪几个"来保证全量替换，迟早漏。所以这一轮改成**全仓库扫描**，
 * 只在明确的排除清单之外动手，并且跑完自己做反向断言。
 *
 * 用法：
 *   node tools/rename-pass2.mjs            # 预演（dry-run），只打印不落盘
 *   node tools/rename-pass2.mjs --apply    # 真正执行（先备份到 .trash/rename2-<时间>/）
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

/* ---------------- 扫描范围 ---------------- */
const SKIP_DIRS = new Set(['node_modules', '.git', '.trash', 'dist', 'logs', '.workbuddy']);
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.py', '.bat', '.cmd', '.html', '.css', '.txt', '.yml', '.yaml', '.jsonl']);

/* ---------------- 排除清单：这些文件里的旧名是「有意保留的」 ---------------- */
/**
 * 每一行都要能说出为什么。说不出来就不该在这里——那说明它是漏网之鱼。
 */
const EXCLUDE = new Map([
  // 更名工具自身：规则要以「旧名」形式存在，否则它没法匹配
  ['tools/rename-to-cosmos.mjs', '更名工具本体，RULES/FORBIDDEN 里必须保留旧名字面量'],
  ['tools/rename-pass2.mjs', '本脚本自身，同上'],
  ['tools/_rename-report.txt', '第一轮改名报告，是历史证据'],
  // 历史记录：记录的是「当时怎么写的」，改了就是篡改历史
  ['坑与雷点.md', '开发对话记录，旧名是当时原话'],
  ['自检维修手册.md', '诊断报告，引用的是当时的真实路径与目录名'],
  // 自动生成的诊断产物
  ['tools/_probe.out', '勘查输出'],
  ['tools/_probe2.out', '勘查输出'],
  ['tools/_probe3.out', '勘查输出'],
  ['tools/_after.out', '会话诊断输出'],
  ['shots/scale-test.log', '测试日志产物'],
  // 自指陷阱：更名报告的内容就是「旧名 → 新名」的对照表，扫它等于让工具篡改自己的证据。
  // 踩过一次——报告被自己重写，反向断言因此假通过。
  ['tools/_rename2-report.txt', '本工具自己的报告，成对记录新旧名'],
  ['tools/_rename2-dry.out', '本工具的控制台输出'],
  ['tools/_rename2-apply.out', '本工具的控制台输出'],
]);

/* ---------------- 替换规则（顺序敏感：长串在前） ---------------- */
const RULES = [
  { id: 'ua-class', from: 'LittleSolarSystem', to: 'LittleCosmos', why: 'HTTP User-Agent 里的项目标识' },
  { id: 'pkg-slug', from: 'little-solar-system', to: 'little-cosmos', why: '包名 / UA 里的 slug / package-lock' },
  // schema 前缀：`lss` = little solar system。已核验全仓库没有任何代码去比对这个字符串
  // （datacenter.mjs 只在「文件缺失」时用它造默认值，前端不校验），所以可以整体换。
  { id: 'schema', from: 'lss.', to: 'lc.', why: '数据集 schema 前缀（无读者校验，已核验）' },
];

/* ---------------- 特殊补丁：不能靠裸替换的地方 ---------------- */
/**
 * gpu.js 的画质偏好键 `lss.gpu.v1` → `lc.gpu.v1`。
 * 裸替换会把用户已存的偏好变成孤儿（读到 null，回默认值）。所以替换之后
 * 要补一个「旧键只读回退」，让老偏好平滑迁移。
 */
const GPU_FILE = 'web/js/core/gpu.js';
const GPU_PATCH = {
  anchor: "function readStored() {\n  try {\n    const raw = localStorage.getItem(LS_KEY);",
  insert: `function readStored() {
  try {
    // 更名遗留：旧键 lss.gpu.v1 里的偏好不能丢，读到就顺手迁到新键
    const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem('lss.gpu.v1');
    if (raw) { try { localStorage.setItem(LS_KEY, raw); localStorage.removeItem('lss.gpu.v1'); } catch { /* ignore */ } }`,
};

/* ---------------- 执行 ---------------- */
const files = [];
(function walk(rel) {
  const abs = path.join(ROOT, rel);
  let names;
  try { names = readdirSync(abs); } catch { return; }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const r = rel ? `${rel}/${n}` : n;
    const p = path.join(ROOT, r);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(r);
    else if (TEXT_EXT.has(path.extname(n).toLowerCase()) && st.size < 8 * 1024 * 1024) files.push({ rel: r, abs: p });
  }
})('');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const TRASH = path.join(ROOT, '.trash', `rename2-${stamp}`);
const report = [];
const say = (s) => { report.push(s); console.log(s); };

say(`扫描到 ${files.length} 个文本文件（已排除 ${[...SKIP_DIRS].join(' / ')}）`);
say(`模式：${APPLY ? '★ APPLY（会写盘，先备份）' : 'dry-run（只预演）'}\n`);

const hits = [];
for (const f of files) {
  const ex = EXCLUDE.get(f.rel);
  let text;
  try { text = readFileSync(f.abs, 'utf8'); } catch { continue; }
  const found = RULES.filter((r) => text.includes(r.from));
  if (!found.length) continue;
  hits.push({ ...f, text, found, excluded: ex || null });
}

let totalHit = 0;
for (const h of hits) {
  if (h.excluded) {
    say(`⏭  排除  ${h.rel}`);
    say(`      命中 ${h.found.map((r) => r.from).join(' / ')} —— 原因：${h.excluded}`);
    continue;
  }
  let text = h.text;
  const detail = [];
  for (const r of h.found) {
    const n = text.split(r.from).length - 1;
    text = text.split(r.from).join(r.to);
    totalHit += n;
    detail.push(`${r.from} → ${r.to} ×${n}`);
  }
  // 特殊补丁
  let patched = false;
  if (h.rel === GPU_FILE && text.includes(GPU_PATCH.anchor)) {
    text = text.replace(GPU_PATCH.anchor, GPU_PATCH.insert);
    patched = true;
  }
  say(`✎  ${h.rel}`);
  for (const d of detail) say(`      ${d}`);
  if (patched) say('      + 补丁：旧 localStorage 键只读回退（迁移老偏好）');

  if (APPLY) {
    const bak = path.join(TRASH, h.rel);
    mkdirSync(path.dirname(bak), { recursive: true });
    copyFileSync(h.abs, bak);
    writeFileSync(h.abs, text, 'utf8');
  }
}

/* ---------------- 反向断言：跑完之后不许再有旧名残留 ---------------- */
say('\n—— 反向断言 ——');
// dry-run 下盘上还是旧内容，拿它断言只会报一堆假残留。要么真跑，要么老实说没跑。
if (!APPLY) {
  say('⏭ 预演模式：断言跳过（磁盘上还是原文，此时断言只会撒谎）。加 --apply 后自动执行。');
  say(`\n预演：将替换 ${totalHit} 处，涉及 ${hits.filter((h) => !h.excluded).length} 个文件`);
  writeFileSync(path.join(ROOT, 'tools', '_rename2-report.txt'), report.join('\n') + '\n', 'utf8');
  process.exit(0);
}
const LEGIT = new Set([
  'tools/rename-to-cosmos.mjs', 'tools/rename-pass2.mjs', 'tools/_rename-report.txt',
  '坑与雷点.md', '自检维修手册.md',
  'tools/_probe.out', 'tools/_probe2.out', 'tools/_probe3.out', 'tools/_after.out',
  'shots/scale-test.log',
]);
const leftovers = [];
for (const f of files) {
  if (LEGIT.has(f.rel)) continue;
  let text; try { text = readFileSync(f.abs, 'utf8'); } catch { continue; }
  for (const r of RULES) {
    if (!text.includes(r.from)) continue;
    // gpu.js 的旧键是「有意保留的迁移回退」——单独豁免
    if (f.rel === GPU_FILE && r.id === 'schema' && text.includes("'lss.gpu.v1'")) continue;
    leftovers.push(`${f.rel}  ← ${r.from}`);
  }
}
if (!leftovers.length) say('✅ 无残留（有意保留的排除项已登记在案）');
else { say('❌ 仍有残留：'); for (const l of leftovers) say(`   ${l}`); }

say(`\n共替换 ${totalHit} 处，涉及 ${hits.filter((h) => !h.excluded).length} 个文件`);
say(`备份在 ${path.relative(ROOT, TRASH)}/`);

writeFileSync(path.join(ROOT, 'tools', '_rename2-report.txt'), report.join('\n') + '\n', 'utf8');

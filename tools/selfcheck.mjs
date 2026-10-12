#!/usr/bin/env node
/**
 * 小小宇宙 · 自检（命令行）
 *
 * 和界面上那个自检是同一套内核（server/lib/selfcheck.mjs），区别只是输出方式：
 * 这里不开服务、不需要浏览器，适合「双击一下就体检」以及放进脚本/自动化流程。
 *
 * 用法：
 *   node tools/selfcheck.mjs              # 人类可读报告
 *   node tools/selfcheck.mjs --json       # 机器可读（给脚本/CI 用）
 *   node tools/selfcheck.mjs --quiet      # 只打印有问题的项
 *
 * 退出码：0 = 无 error；1 = 有 error（warn 不影响退出码，它只是提醒）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfCheck } from '../server/lib/selfcheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');
const QUIET = ARGS.has('--quiet');

const MARK = { ok: '  ✓', warn: '  !', error: '  ✗' };
const LABEL = { ok: '通过', warn: '注意', error: '故障' };

const r = await runSelfCheck(ROOT);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.summary.error ? 1 : 0);
}

const lines = [];
lines.push('');
lines.push('  小小宇宙 · 自检报告');
lines.push('  ' + '─'.repeat(60));
lines.push(`  ${new Date(r.generatedAt).toLocaleString('zh-CN')}  ·  耗时 ${r.elapsedMs} ms`);
lines.push(`  合计 ${r.summary.ok} 通过 / ${r.summary.warn} 注意 / ${r.summary.error} 故障`);
lines.push('');

for (const g of r.groups) {
  const shown = QUIET ? g.checks.filter((c) => c.level !== 'ok') : g.checks;
  if (!shown.length) continue;
  lines.push(`  ▸ ${g.label}`);
  for (const c of shown) {
    lines.push(`${MARK[c.level]} ${c.title}`);
    lines.push(`      ${c.detail}`);
    if (c.level !== 'ok') lines.push(`      → 怎么办：${c.fix}`);
  }
  lines.push('');
}

if (r.summary.ok === r.checks.length) lines.push('  全部通过。这台机器上这套程序是健康的。');
else if (r.summary.error === 0) lines.push('  没有故障项，注意项不阻塞使用。');
else lines.push(`  有 ${r.summary.error} 项故障。按上面每条的「怎么办」处理；更细的排查步骤见「自检维修手册.md」。`);
lines.push('');

process.stdout.write(lines.join('\n'));
process.exit(r.summary.error ? 1 : 0);

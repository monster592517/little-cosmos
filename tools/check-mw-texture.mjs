#!/usr/bin/env node
/**
 * 判据 · 银河系盘面贴图（`proc/textures.js::makeMilkyWayDiskTexture`）的四条硬约束。
 *
 * 用法：
 *   node tools/check-mw-texture.mjs             # 跑判据
 *   node tools/check-mw-texture.mjs --selftest  # 判据 + 注入自证
 *
 * 为什么要有这个文件
 * ------------------------------------------------------------------
 * 2026-09-12 第 37 轮，用户报「银河系这样子还是太差了」。把渲染管线里的
 * **贴图原图**取出来（`tools/dump-mw-texture.py`）一看，盘面上有十几条
 * **同心亮环** —— 真因是 `createRadialGradient` 只给了 **14 个 stop**：
 * 相邻 stop 之间是线性插值，而它要逼近的是 `exp(−6.2u)`（凸曲线），
 * 误差 ≈ `f″h²/8`，在 u=0 处达 0.0245（该处 α 只有 0.20 ⇒ **相对 12%**）。
 *
 * 这几条判据守的是**「改回去的方式」**，不是「好看」：
 *   ① STOPS 必须够密 —— 改小了波纹立刻回来；
 *   ② 峰值 α 的改动必须**留下依据**，而且依据要以 `Σα` **实测**为准
 *      （我第一次按解析误差外推补到 0.225，实测 Σα **+6.4%，越了 ±5% 线**）；
 *   ③ 画法变了必须换缓存键前缀（否则同一次加载里会静默复用旧贴图）；
 *   ④ α 不能用 `toFixed(4)`（十进制量化会把外盘那 1–2/255 的结构再削一层）。
 *
 * ⚠️ 这些都是**文本判据**，只认「代码里写了什么」，认不出「画出来好不好看」。
 *    画面那一半必须导出原图**目检**：
 *      py -3.13 -X utf8 tools/dump-mw-texture.py
 *      py -3.13 -X utf8 tools/analyze-mw-texture.py shots/mw-texture-*.png --compare
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from './lib/strip-comments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TEX = join(ROOT, 'web', 'js', 'proc', 'textures.js');

/* ⚠️ 两条相反的定式都要守：
 *   · 找**字面量**（`const STOPS = 256`）看**剥完注释的代码** —— 否则注释里
 *     提到的旧值会让判据假绿；
 *   · 判**理由在不在**看**原始行** —— 理由本来就写在注释里。 */
const RAW0 = readFileSync(TEX, 'utf8');
const CODE0 = stripComments(RAW0);

/** 最小允许的 stop 数。128 段时误差 `0.0245×(14/128)² = 2.9e-4`（相对 0.15%）⇒ 不可见。 */
const MIN_STOPS = 128;
/** 盘面峰值 α 的期望值（由 `Σα` 实测标定，见源码注释）。 */
const ALPHA = '0.204';

const checks = [
  {
    name: 'stops-dense',
    desc: `径向渐变的 STOPS ≥ ${MIN_STOPS}`,
    run(code) {
      const m = code.match(/const\s+STOPS\s*=\s*(\d+)\s*;/);
      if (!m) return { ok: false, why: '找不到 `const STOPS = <数字>;`' };
      const n = Number(m[1]);
      return {
        ok: n >= MIN_STOPS,
        why: `STOPS = ${n}（要求 ≥ ${MIN_STOPS}）`
          + (n >= MIN_STOPS ? ' ✓' : ' ⇒ 折角会回来：14 段时径向波纹 relRms 30%、目检十几条亮环'),
      };
    },
  },
  {
    name: 'alpha-documented',
    desc: `峰值 α = ${ALPHA}，且附近写明了它是按 Σα 实测标定的`,
    run(code, raw) {
      const hasLine = new RegExp(`discGrad\\.addColorStop\\(u,[^\\n]*${ALPHA.replace('.', '\\.')}`).test(code);
      const noteLines = raw.split('\n')
        .filter((l) => l.includes('Σα') || l.includes('±5%') || l.includes('0.204'));
      return {
        ok: hasLine && noteLines.length >= 2,
        why: hasLine
          ? `渐变峰值 α = ${ALPHA} ✓ · 相关注释 ${noteLines.length} 行`
          : `渐变行里找不到 ${ALPHA}（α 被改过却没留依据，或注释里那个旧值让判据假绿）`,
      };
    },
  },
  {
    name: 'cache-prefix',
    desc: '贴图缓存键带 `mwd<n>|` 版本前缀（画法一改必须换）',
    run(code) {
      const m = code.match(/cached\(`(mwd\d+)\|/);
      return { ok: !!m, why: m ? `缓存前缀 ${m[1]} ✓` : '缓存键里没有版本前缀' };
    },
  },
  {
    name: 'alpha-precision',
    desc: '渐变的 α 不用 `toFixed(4)`',
    run(code) {
      const bad = /discGrad\.addColorStop\([^\n]*toFixed\(4\)/.test(code);
      return { ok: !bad, why: bad ? '渐变那行还在用 toFixed(4)' : '≥ 5 位小数 ✓' };
    },
  },
];

const INJECTIONS = [
  { hit: 'stops-dense', desc: 'STOPS 改回 14', apply: (s) => s.replace(/const STOPS = \d+;/, 'const STOPS = 14;') },
  { hit: 'stops-dense', desc: 'STOPS 改成 64（刚好不够密）', apply: (s) => s.replace(/const STOPS = \d+;/, 'const STOPS = 64;') },
  { hit: 'alpha-documented', desc: '峰值 α 改成 0.31（不留依据）', apply: (s) => s.replace(/0\.204 \* I/, '0.31 * I') },
  { hit: 'cache-prefix', desc: '缓存前缀去掉版本号', apply: (s) => s.replace(/cached\(`mwd\d+\|/, 'cached(`mwd|') },
  { hit: 'alpha-precision', desc: 'α 的精度退回 toFixed(4)', apply: (s) => s.replace(/(discGrad\.addColorStop\([^\n]*?)toFixed\(6\)/, '$1toFixed(4)') },
];

function runAll(code = CODE0, raw = RAW0) {
  return checks.map((c) => ({ c, r: c.run(code, raw) }));
}

function main() {
  const selftest = process.argv.includes('--selftest');
  let fails = 0;

  console.log('\n银河系盘面贴图判据（web/js/proc/textures.js）\n');
  for (const { c, r } of runAll()) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${c.name.padEnd(18)} ${c.desc}`);
    console.log(`      ${r.why}`);
    if (!r.ok) fails++;
  }

  if (selftest) {
    console.log('\n  自证（注入 → 该条判据必须变红）');
    for (const inj of INJECTIONS) {
      const mc = inj.apply(CODE0);
      const mr = inj.apply(RAW0);
      const target = checks.find((c) => c.name === inj.hit);
      if (mc === CODE0 && mr === RAW0) {
        console.log(`  ✗ 注入「${inj.desc}」**没有改变源码** ⇒ 这个注入本身是哑的（锚点写错了）`);
        fails++;
        continue;
      }
      const r = target.run(mc, mr);
      const fired = !r.ok;
      console.log(`  ${fired ? '✓' : '✗'} 注入「${inj.desc}」→ ${target.name}`
        + ` ${fired ? '变红' : '**仍然绿**（这条判据是假的）'}`);
      if (!fired) fails++;
    }
    console.log(`\n  自证：${INJECTIONS.length} 条注入 / ${checks.length} 条判据。`);
  }

  if (fails) {
    console.log(`\n  ✗ 失败 ${fails} 项\n`);
    process.exit(1);
  }
  console.log(`\n  全部通过：${checks.length} 项判据。`);
  console.log('  ⚠️ 文本判据守的是「代码里写了什么」。画面的那一半必须导出原图目检：');
  console.log('     py -3.13 -X utf8 tools/dump-mw-texture.py');
  console.log('     py -3.13 -X utf8 tools/analyze-mw-texture.py shots/mw-texture-*.png --compare\n');
}

main();

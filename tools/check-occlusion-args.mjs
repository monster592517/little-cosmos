#!/usr/bin/env node
/**
 * 判据：**每一个「有头」跑浏览器的探针，都必须带上遮挡开关**。
 *
 *   node tools/check-occlusion-args.mjs            # 扫描并报告
 *   node tools/check-occlusion-args.mjs --selftest # 自证会响（两段式）
 *
 * 为什么需要这个脚本
 * ------------------------------------------------------------------
 * 坑 136 教过：有头 Chromium 的窗口被遮挡时会被判降级（rAF 节流 / 合成器不出新帧），
 * 于是探针要么截图假死，要么**整个卡住没有任何输出**，而且读数只偏慢 ⇒ 看起来像
 * 「性能变差了」，把人引去查显卡。
 *
 * 坑 149 是更大的那一课：当时把「已固化」写成了**文档里的一个手写名单**
 * （「这两个探针已带」）。2026-09-12 全量扫了一遍才发现 ——
 * **有头探针 20 个，带开关的只有 3 个，而且名单里点的那个文件名根本不存在。**
 *
 * ⇒ 结论：**「所有 X 都要带 Y」这条纪律，必须配一个能扫出「谁没带」的脚本。**
 *    扫不出来就写「已固化」，等于又造了一条静默故障。
 *
 * 判定口径（每一条都要写清楚，否则这就是个算错方向的判据）
 * ------------------------------------------------------------------
 *  * 「有头」= 该文件里有 `headless=not HEADED` 或 `headless=False` 的 launch 调用。
 *    （`headless=True` 的无头探针**不在管辖范围内** —— 无头没有「窗口被遮挡」这回事。
 *     但仍会打印出来做参考，不算故障。）
 *  * 一次 launch 调用「带开关」= 它自己传下去的 args 里能**看得见** `OCCLUSION_ARGS`：
 *      - `args=OCCLUSION_ARGS`                              → 带
 *      - `args=<var>`，且 `<var>` 在本文件里被 `with_occlusion(...)` 或含
 *        `OCCLUSION_ARGS` 的表达式构造过                     → 带
 *      - `**<dict>` → 去查那个 dict 在本文件里的构造，同上       → 带 / 不带
 *  * **看不见就是不带**：不做「大概它内部带了吧」的宽容 —— 那正是坑 149 的成因。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');
const MARK = 'OCCLUSION_ARGS';
// 「带开关」的**实质**判据是这条字面量在 args 里，不是「用了哪个变量名」。
// ⚠️ 如果只认 `OCCLUSION_ARGS`，那三个**已经把开关写死了**的探针会被报成裸奔 ——
//    判据自己算错方向，比判据不响更坏。用没用单点定义是**风格**，单独报，不算故障。
const LITERAL = '--disable-backgrounding-occluded-windows';

// ---------------------------------------------------------------------------
// 纯函数：给一份 { 文件名: 内容 }，算出每一项判据
// ---------------------------------------------------------------------------

/** 剥掉注释（保留字符串字面量）。
 *  —— 找「实际执行的代码」时必须先做这一步。（踩过：正则扫源码命中注释里的旧写法，得出假结论。） */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      const triple = src.startsWith(q.repeat(3), i);
      const close = triple ? q.repeat(3) : q;
      const start = i;
      i += close.length;
      while (i < n && !src.startsWith(close, i)) {
        if (src[i] === '\\') i++;
        i++;
      }
      i += close.length;
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 同上，但**连字符串内容一起抹掉**。
 *  用途：判 `args=[...]` 里那个 `OCCLUSION_ARGS` 到底是标识符还是字符串
 *  （`args=['OCCLUSION_ARGS']` 是写错了，不能算「带」。） */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      const triple = src.startsWith(q.repeat(3), i);
      const close = triple ? q.repeat(3) : q;
      i += close.length;
      while (i < n && !src.startsWith(close, i)) {
        if (src[i] === '\\') i++;
        i++;
      }
      i += close.length;
      out += triple ? '""""""' : '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 取 `name(` 之后配平的参数文本；找不到返回 null。 */
function callArgs(src, from) {
  const open = src.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return { text: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** 那个 `args=<name>` / `**<name>` 指向的变量，在本文件里一共被怎么构造过？
 *
 *  ⚠️ **必须收集所有** `name = ...` 与 `name += ...` 的写法。只看第一处会漏掉
 *  「先 `args = ['--use-angle=d3d11']`，后面再 `args += OCCLUSION_ARGS`」——
 *  而这恰恰是最正常的写法。实测：只看第一处时，`perf-probe.py`（已经修好的那个）
 *  被误判成裸奔 ⇒ **判据自己算错方向，比判据不响更坏**。
 *
 *  用**保留字符串**的那一份源码（`stripComments`）：因为 `**launch` 这种写法里，
 *  参数是通过 dict 的字符串键 `'args'` 传的，把字符串抹掉就看不见了。 */
function constructionOf(code, name) {
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?<![A-Za-z_.])${name}\\s*(\\+?=)(?!=)`, 'g');
  let out = '';
  let m;
  while ((m = re.exec(code)) !== null) {
    const from = m.index + m[0].length - 1;
    let i = from;
    let line = '';
    while (i < code.length && code[i] !== '\n') { line += code[i]; i++; }
    // 把续行（缩进更深的那些行）也带上：`args = [` 后面常常换行列好几项
    let j = i + 1;
    for (;;) {
      let k = j;
      while (k < code.length && (code[k] === ' ' || code[k] === '\t')) k++;
      if (k > j && k < code.length && code[k] !== '\n' && code[k] !== '#') {
        let l = k;
        line += '\n' + code.slice(k, l);
        while (l < code.length && code[l] !== '\n') { line += code[l]; l++; }
        j = l + 1;
      } else break;
    }
    out += line + '\n';
  }
  return out;
}

export function runChecks(files) {
  const results = [];
  for (const [name, raw] of Object.entries(files)) {
    if (!name.endsWith('.py')) continue;
    const code = stripCommentsAndStrings(raw);
    const codeWithStrings = stripComments(raw);
    const headedHits = [...code.matchAll(/headless\s*=\s*(not\s+HEADED|False)/g)];
    const total = [...code.matchAll(/chromium\.launch\(/g)];
    if (total.length === 0) continue;

    // 每个 launch 调用点单独判
    const sites = [];
    for (const m of total) {
      const call = callArgs(code, m.index);
      const text = call ? call.text : '';
      const isHeaded = /headless\s*=\s*(not\s+HEADED|False)/.test(text);

      let carries = false;
      let viaSingleSource = false;
      let how = '';
      if (text.includes(MARK) || text.includes(LITERAL)) {
        carries = true;
        viaSingleSource = text.includes(MARK);
        how = text.includes(MARK) ? 'args 里直接写着 OCCLUSION_ARGS' : 'args 里写死了那三条字面量';
      } else {
        const am = text.match(/args\s*=\s*([A-Za-z_][\w]*)/);
        const dm = text.match(/\*\*\s*([A-Za-z_][\w]*)/);
        const v = am ? am[1] : dm ? dm[1] : null;
        if (v) {
          const cons = constructionOf(codeWithStrings, v);
          if (cons.includes(MARK) || cons.includes('with_occlusion(') || cons.includes(LITERAL)) {
            carries = true;
            viaSingleSource = cons.includes(MARK) || cons.includes('with_occlusion(');
            how = `${v} 在本文件里由带开关的表达式构造`;
          } else {
            how = `args 走 ${v}，但整份文件里 ${v} 的构造都看不见开关`;
          }
        } else {
          how = '这个调用根本没传 args';
        }
      }
      sites.push({ isHeaded, carries, viaSingleSource, how });
    }

    const headed = sites.filter((s) => s.isHeaded);
    if (headed.length === 0) {
      results.push({ name, kind: 'headless', total: sites.length, bare: 0, detail: [] });
      continue;
    }
    const bare = headed.filter((s) => !s.carries);
    const literal = headed.filter((s) => s.carries && !s.viaSingleSource);
    results.push({
      name,
      kind: 'headed',
      total: headed.length,
      bare: bare.length,
      literal: literal.length,
      detail: bare.map((s, i) => `第 ${i + 1} 个有头调用：${s.how}`),
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));

  const headed = results.filter((r) => r.kind === 'headed');
  const ok = headed.filter((r) => r.bare === 0);
  const bad = headed.filter((r) => r.bare > 0);
  const headless = results.filter((r) => r.kind === 'headless');

  // 单点定义必须真的存在
  const moduleHas = files['browser_args.py'] && files['browser_args.py'].includes(MARK);

  return { headed, ok, bad, headless, moduleHas };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 把 `tools/*.py` 读成 `{ 文件名: 内容 }`。
 *  抽出来是为了让**自检内核**（`server/lib/selfcheck.mjs`）能复用同一套判定，
 *  而不用把逻辑抄第二份 —— 同一个不变量两份实现，必漏一份（坑 131）。 */
export function scanToolsDir(dir) {
  const files = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.py')) continue;
    files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return files;
}

function loadFiles() {
  return scanToolsDir(TOOLS);
}

function report(r) {
  const viaLiteral = r.ok.filter((x) => x.literal > 0);
  console.log(`  有头探针  ${r.headed.length} 个`);
  console.log(`  ✓ 带开关  ${r.ok.length} 个`
    + (viaLiteral.length ? `（其中 ${viaLiteral.length} 个是**写死字面量**、没走单点定义：`
      + viaLiteral.map((x) => x.name).join(' · ') + '）' : ''));
  console.log(`  ✗ 裸奔    ${r.bad.length} 个`);
  if (r.headless.length) {
    console.log(`  · 无头（不在管辖范围，仅供参考）${r.headless.length} 个：`
      + r.headless.map((x) => x.name).join(' · '));
  }
  for (const b of r.bad) {
    console.log(`    ✗ ${b.name}`);
    for (const d of b.detail) console.log(`        ${d}`);
  }
  console.log(`  ${r.moduleHas ? '✓' : '✗'} 单点定义 tools/browser_args.py 存在且导出 OCCLUSION_ARGS`);
  console.log(`  ${r.bad.length === 0 && r.moduleHas ? '✓' : '✗'} 结论：`
    + (r.bad.length === 0 && r.moduleHas
      ? '每个有头探针都带了遮挡开关。'
      : `${r.bad.length} 个有头探针没带 —— 它们跑起来可能卡住不输出。`));
  return r.bad.length === 0 && r.moduleHas;
}

// 自证用的最小夹具：一个「合规」的和一个「裸奔」的有头探针。
const FIXTURE_OK = `
import sys
from playwright.sync_api import sync_playwright
from browser_args import OCCLUSION_ARGS
HEADED = True
def run(pw):
    return pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
`;
const FIXTURE_BARE = `
import sys
from playwright.sync_api import sync_playwright
HEADED = True
def run(pw):
    return pw.chromium.launch(headless=not HEADED, channel='msedge')
`;
const FIXTURE_HEADLESS = `
from playwright.sync_api import sync_playwright
def run(pw):
    return pw.chromium.launch(headless=True, args=['--x'])
`;
const FIXTURE_MODULE = `OCCLUSION_ARGS = ['a', 'b']\n`;

function selftest() {
  const base = {
    'browser_args.py': FIXTURE_MODULE,
    'probe-ok.py': FIXTURE_OK,
    'probe-bare.py': FIXTURE_BARE,
    'probe-headless.py': FIXTURE_HEADLESS,
  };
  let pass = 0;
  const check = (label, cond) => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}`);
    if (cond) pass++;
  };

  console.log('  第一段：注入前必须绿');
  const r0 = runChecks(base);
  check('夹具里识别出 2 个有头探针（ok + bare）', r0.headed.length === 2);
  check('裸奔那个被点名（probe-bare.py）', r0.bad.length === 1 && r0.bad[0].name === 'probe-bare.py');
  check('无头那个被归到 headless、不算故障', r0.headless.some((x) => x.name === 'probe-headless.py'));
  check('合规那个不出现在 bad 里', !r0.bad.some((x) => x.name === 'probe-ok.py'));

  console.log('  第二段：把「合规」那个改成裸奔 ⇒ 它必须变红');
  const r1 = runChecks({ ...base, 'probe-ok.py': FIXTURE_BARE });
  check('probe-ok.py 现在被点名了', r1.bad.some((x) => x.name === 'probe-ok.py'));
  check('bad 变成 2 个', r1.bad.length === 2);

  console.log('  第三段：改由变量间接传（args=ARGS / ARGS 带开关）—— 必须判「带」');
  const indirectOk = `
from browser_args import OCCLUSION_ARGS
HEADED = True
ARGS = ['--use-angle=d3d11'] + OCCLUSION_ARGS
async def go(pw):
    return await pw.chromium.launch(headless=not HEADED, args=ARGS)
`;
  check('间接传也算带', runChecks({ ...base, 'probe-ind.py': indirectOk }).bad.length === 1);
  const indirectBare = indirectOk.replace(' + OCCLUSION_ARGS', '');
  check('间接传但没开关 ⇒ 判裸奔',
    runChecks({ ...base, 'probe-ind.py': indirectBare }).bad.some((x) => x.name === 'probe-ind.py'));

  console.log('  第三之二段：**分两次构造**（先 `ARGS = []`，后面再 `ARGS += ...`）——算带');
  const splitOk = `
from browser_args import OCCLUSION_ARGS
HEADED = True
ARGS = []
ARGS += ['--use-angle=d3d11']
ARGS += OCCLUSION_ARGS
async def go(pw):
    return await pw.chromium.launch(headless=not HEADED, args=ARGS)
`;
  check('分两次构造也算带（只看第一处赋值会误判）',
    !runChecks({ ...base, 'probe-split.py': splitOk }).bad.some((x) => x.name === 'probe-split.py'));
  check('分两次构造但结尾没有开关 ⇒ 判裸奔',
    runChecks({ ...base, 'probe-split.py': splitOk.replace('ARGS += OCCLUSION_ARGS', '') })
      .bad.some((x) => x.name === 'probe-split.py'));

  console.log('  第四段：**写死字面量**也算带（实质判据是「带没带」，不是「用了哪个变量名」）');
  const fixtureLiteral = `
HEADED = True
ARGS = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
async def go(pw):
    return await pw.chromium.launch(headless=not HEADED, args=ARGS)
`;
  const rl = runChecks({ ...base, 'probe-lit.py': fixtureLiteral });
  check('写死字面量不算裸奔', !rl.bad.some((x) => x.name === 'probe-lit.py'));
  check('但它会被记成「没走单点定义」',
    rl.headed.some((x) => x.name === 'probe-lit.py' && x.literal > 0));

  console.log('  第五段：单点定义 ⇒ 必须变红');
  check('缺 browser_args.py 时 moduleHas=false',
    runChecks({ ...base, 'browser_args.py': '# empty\n' }).moduleHas === false);

  console.log('  第六段：注释里写着 OCCLUSION_ARGS 不算带（先剥注释）');
  const fakeComment = `
# 我们本来该带 OCCLUSION_ARGS 的，忘了
HEADED = True
async def go(pw):
    return await pw.chromium.launch(headless=not HEADED, args=['--x'])
`;
  check('注释里的不算', runChecks({ ...base, 'probe-cmt.py': fakeComment })
    .bad.some((x) => x.name === 'probe-cmt.py'));

  console.log(`\n  自证：${pass} / 14 段断言通过`);
  return pass === 14;
}

// ---------------------------------------------------------------------------
// CLI（**只在本文件被直接执行时跑**）
// ---------------------------------------------------------------------------
// ⚠️ 必须加这道门：`server/lib/selfcheck.mjs` 会 import 本模块复用 `runChecks`，
// 而「被 import」时 `process.exit()` 会把自检整个进程干掉 —— 且症状看起来像
// 「自检跑不起来」，会把人派去查自检本身。
const invokedDirectly = (() => {
  try {
    return !!process.argv[1]
      && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    console.log('\n== 自证（两段式：注入前绿 / 注入后指名的那条变红）==\n');
    process.exit(selftest() ? 0 : 1);
  }
  console.log('\n== 有头探针是否都带遮挡开关（坑 136 / 坑 149）==\n');
  process.exit(report(runChecks(loadFiles())) ? 0 : 1);
}

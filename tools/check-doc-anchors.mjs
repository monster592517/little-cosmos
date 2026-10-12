#!/usr/bin/env node
/**
 * 文档锚点检查：手册里那些 `[S23](#s23-...)` 的链接，还指得到东西吗？
 *
 * 为什么需要这个
 * --------------
 * 「踩过的坑必须固化成脚本」这件事本项目做得很足，但**文档自己的链接**一直没人管。
 * 而锚点是**静默失效**的典范：标题改一个字、把「（」换成「(」、把「 / 」改成「/」，
 * 链接就断在那里 —— 点下去哪儿也不去，页面上**什么提示都没有**。
 * 维修手册的主用法就是「按症状查」，症状索引那一列全是锚点，断了等于那张表废了。
 *
 * ⚠️ 这个脚本的第一版**把 11 条正确的链接报成了坏的**。
 *    原因是 slug 口径只剥了 ASCII 标点，而 GitHub 的 slugger 连
 *    `「」（）、。：` 这些 CJK 标点一起剥：
 *
 *      标题  ### S4 天体没有贴图（是纯色球 / 灰球）
 *      锚点  #s4-天体没有贴图是纯色球--灰球        ← （） 被剥掉，" / " 变成 "--"
 *
 *    照第一版去「修」，会去改 11 条本来没问题的链接 —— 这正是
 *    **判据自己算错方向，把人派去修不存在的问题**，而且数字还极其具体（11 个）。
 *    所以本脚本**先自证口径**（`--selftest` 里有一组已知对照 + 一个必拒的反例），
 *    口径不对就直接退出，绝不下判定。
 *
 * 口径（与 GitHub 渲染后的锚点一致）
 * ----------------------------------
 *   1. 去掉标题首尾空白，转小写；
 *   2. 去掉所有**非**「字母 / 数字 / 空格 / `-` / `_`」的字符（含 CJK 标点）；
 *   3. 每个空格换成一个 `-`（**逐个换，不折叠** —— " / " → "--" 就是这么来的）。
 *
 * 扫描口径（2026-09-26 补）
 * ------------------------
 * **先剥代码，再找标题和链接**：围栏（``` / ~~~）与行内代码（`…`）里的同形串
 * **既不是标题、也不是链接**。理由与同目录 `check-refs.mjs` 的 `fenceMask` 一致 ——
 * 两个兄弟工具对同一件事只能有一套口径，否则就是会腐烂的双真源。细节与实测见 `codeStripped`。
 *
 * 用法
 * ----
 *     node tools/check-doc-anchors.mjs
 *     node tools/check-doc-anchors.mjs --selftest   # 先验口径，再验它抓不抓得到坏锚点
 *     node tools/check-doc-anchors.mjs --json
 * 退出码：0 = 全部可解析；1 = 有坏锚点 / 口径自证失败 / 文件读不到。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const SELFTEST = ARGV.includes('--selftest');

/**
 * 标题 → 锚点 id。
 * 第 2 步用 `\p{L}\p{N}`（Unicode 属性转义）才认得中文/日文，
 * 用 `[a-z0-9]` 之类的写法会把中文标题整个剥成空串 —— 那样所有链接都会"通过"。
 */
export function slug(heading) {
  return String(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** 口径自证：这四条是文档里**已知能解析**的锚点，外加一个必须被拒的反例。 */
const SLUG_SAMPLES = [
  ['S4 天体没有贴图（是纯色球 / 灰球）', 's4-天体没有贴图是纯色球--灰球'],
  ['S23 某个尺度上有一坨天体叠在原点 / 属性字段不属于这一层', 's23-某个尺度上有一坨天体叠在原点--属性字段不属于这一层'],
  ['S3 数据更新中心报「无法连接本地服务」', 's3-数据更新中心报无法连接本地服务'],
  ['S9 卡顿、帧率低', 's9-卡顿帧率低'],
  ['S22 内存吃紧 / 显卡没吃上', 's22-内存吃紧--显卡没吃上'],
];
// 反例：口径必须**会拒**「标点没剥干净」的那种写法，否则它什么都放行。
const SLUG_NEGATIVE = ['S3 数据更新中心报「无法连接本地服务」', 's3-数据更新中心报「无法连接本地服务」'];

function slugSelftest() {
  const bad = [];
  for (const [h, exp] of SLUG_SAMPLES) {
    const got = slug(h);
    if (got !== exp) bad.push(`「${h}」→ ${got}，期望 ${exp}`);
  }
  if (slug(SLUG_NEGATIVE[0]) === SLUG_NEGATIVE[1]) {
    bad.push('口径太松：标点没剥干净的写法也被放行了，它会掩盖真实的坏锚点');
  }
  return bad;
}

/**
 * 把**代码**换成等长空格（行数与长度都不变，报错里的行号/列位不漂）。
 *
 * ⚠️ 「代码里的不是引用」这条口径必须与同目录的 `check-refs.mjs`
 *    （`fenceMask` / `maskInlineCode`）**一致**。2026-09-26 实测：
 *
 *    · README 的目录树里写了一句示例 `` `[S25](#s25-…)` ``（省略号表示"这类链接"），
 *      它渲染出来是**一段字面文本、根本不可点**，却被当成真链接、报成坏锚点；
 *    · 这四份文档里本来就有 **3 处**锚点链接躺在围栏里、**3 处**躺在行内代码里；
 *    · 而 `#` 开头的 **bash 注释**（`# 自检（不依赖服务）`）有 **137 行**被当成了标题收进锚点表
 *      —— 那是**假阴性**的表面（真锚点断了可能被一条注释"接住"）。
 *      实测过：**没有任何链接只靠这些伪标题通过**（0 处），所以剥掉是零风险的。
 *
 *    ⇒ 兄弟工具对同一件事有两套口径，本身就是一种会腐烂的双真源。
 */
function codeStripped(src) {
  const out = [];
  let open = false;
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { open = !open; out.push(' '.repeat(line.length)); continue; }
    if (open) { out.push(' '.repeat(line.length)); continue; }
    // 行内代码只在本行内配对（跨行的行内代码在 Markdown 里本来就不成立）
    out.push(line
      .replace(/``.+?``/g, (m) => ' '.repeat(m.length))
      .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)));
  }
  return out.join('\n');
}

/**
 * 收集所有标题锚点 + 所有锚点链接。**先剥代码，再找**（见 `codeStripped`）。
 */
function scan(src) {
  const text = codeStripped(src);
  const heads = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) heads.add(slug(m[1]));
  const links = [];
  // 两种写法都认：纯锚点 `(#x)` 和跨文件 `(文件名.md#x)`
  for (const m of text.matchAll(/\[[^\]]*\]\((?:([^)#\s]+\.md))?#([^)\s]+)\)/g)) {
    links.push({ file: m[1] || null, anchor: m[2], raw: m[0].slice(0, 60) });
  }
  return { heads, links };
}

async function mdFiles() {
  const out = [];
  for (const e of await readdir(ROOT, { withFileTypes: true })) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(e.name);
  }
  return out.sort();
}

async function main() {
  const emit = (s = '') => process.stdout.write(s + '\n');

  const slugBad = slugSelftest();
  if (slugBad.length) {
    emit('✗ slug 口径自证失败 —— 本次不下任何判定：');
    for (const b of slugBad) emit('    ' + b);
    return 1;
  }

  const files = await mdFiles();
  const cache = new Map();
  for (const f of files) cache.set(f, scan(await readFile(path.join(ROOT, f), 'utf8')));

  const problems = [];
  let linkCount = 0;
  for (const f of files) {
    const { heads, links } = cache.get(f);
    for (const l of links) {
      linkCount++;
      const target = l.file || f;
      const tc = cache.get(target);
      if (!tc) { problems.push({ file: f, why: `指向不存在的文件 ${target}`, raw: l.raw }); continue; }
      if (!tc.heads.has(l.anchor)) {
        problems.push({
          file: f,
          why: `锚点 #${l.anchor} 在 ${target} 里没有对应标题`,
          raw: l.raw,
        });
      }
    }
  }

  let injected = null;
  if (SELFTEST) {
    // 注入一条**确定是坏的**锚点，证明这个检查真的会响。
    // 注入在内存里做，不动磁盘上的文档 —— 检查工具去改被检查的东西，是自指的起点。
    const sample = scan('# 标题甲\n\n见 [某处](#不存在的锚点zzz)。\n');
    injected = sample.links.some((l) => !sample.heads.has(l.anchor));
    // 再注入一条**确定是对的**，确认它不会把正确的东西报坏（假警报同价）。
    const okSample = scan('# S9 卡顿、帧率低\n\n见 [S9](#s9-卡顿帧率低)。\n');
    const okClean = okSample.links.every((l) => okSample.heads.has(l.anchor));
    // 反面（2026-09-26 加）：**围栏 / 行内代码里的同形串既不是标题也不是链接**。
    //   README 里那句示例 `[S25](#s25-…)` 就栽在这上面（渲染是字面文本、却被报成坏锚点）。
    const codeOnly = scan('# 标题甲\n\n```bash\n# 伪标题不该被收进来\n见 [x](#不存在的锚点zzz)。\n```\n'
      + '示例写法 `[S25](#s25-省略号)` 也不是链接。\n');
    const codeClean = codeOnly.links.length === 0
      && !codeOnly.heads.has(slug('伪标题不该被收进来'));
    injected = injected && okClean && codeClean;
  }

  if (JSON_OUT) {
    emit(JSON.stringify({ files: files.length, links: linkCount, problems, selftest: injected }, null, 2));
  } else {
    emit('');
    emit(`文档锚点：${files.length} 个 .md · ${linkCount} 个锚点链接`);
    for (const f of files) {
      const n = cache.get(f).links.length;
      const bad = problems.filter((p) => p.file === f).length;
      if (n) emit(`  ${bad ? '✗' : '✓'} ${f}  ${n} 个锚点${bad ? `，其中 ${bad} 个坏了` : ''}`);
    }
    if (SELFTEST) {
      emit('');
      emit(`  口径自证：${SLUG_SAMPLES.length} 组已知对照 + 1 个必拒反例 —— 通过`);
      emit(`  故障注入：${injected ? '✓ 坏锚点会被抓到；正确锚点、以及围栏/行内代码里的同形串都不被误报' : '✗ 注入没生效，这个检查不可信'}`);
    }
    if (problems.length) {
      emit('');
      emit(`  ✗ ${problems.length} 个锚点指不到东西：`);
      for (const p of problems.slice(0, 40)) emit(`      ${p.file} · ${p.why}`);
      if (problems.length > 40) emit(`      …另有 ${problems.length - 40} 个`);
    }
    emit('');
  }

  if (SELFTEST && injected !== true) {
    if (!JSON_OUT) emit('  ✗ 故障注入没生效 —— 这个检查的"会响"没有被证明，本次不认它的"通过"。');
    return 1;
  }
  if (problems.length) {
    if (!JSON_OUT) {
      emit('  处置：改标题就去更新链接，或反过来。');
      emit('  ⚠️ 别反过来「照判据改链接」—— 这个脚本的第一版就因为 slug 口径算错，');
      emit('     把 11 条**正确**的链接报成坏的。先跑 --selftest 确认口径自证通过，再动手。');
    }
    return 1;
  }
  if (!JSON_OUT) emit(`  ✓ 全部 ${linkCount} 个锚点可解析`);
  return 0;
}

process.exit(await main());

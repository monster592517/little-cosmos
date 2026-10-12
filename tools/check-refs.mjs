#!/usr/bin/env node
/**
 * 编号引用检查：文档里那些「见 坑 84」「见第 20 轮」——**真的指得到东西吗？**
 *
 * 为什么需要这个
 * --------------
 * 这是本项目**同一天里踩了四次**的一种病：**指针指向空气**。
 *
 *   1. `坑与雷点.md` 里「坑 21」**有正文、没有标题** —— 标题行退化成 坑 35 段落里的
 *      一行 ` · 直接改工作区文件夹名`。于是**四处引用全部指向一个不存在的编号，谁也不报错**。
 *   2. **坑 71–76 各有两个不同正文**（两个不相干的坑共用一个号）——
 *      「见 坑 73」在 `gpu-preference.mjs` 里指「10 秒的检查项」、在手册里却指别的。
 *      **同一个指针指向两个东西，比指针断了更坏**：断了的至少你一看就知道。
 *   3. 《对话记录.md》（2026-09-26 已并入 `坑与雷点.md` 的**附录**）里
 *      「见第 20 轮」写在**第 20 轮还没写**的时候。
 *   4. 「第 17 轮」被引用三次，而**第 17 轮从来没写过**（2026-09-11 补了存根标题）。
 *
 * `check-doc-anchors.mjs` 只扫**标题锚点**（`[S25](#s25-...)` 那种），
 * 管不了 `坑 N` / `第 N 轮` 这类**编号引用** —— 于是这块一直没人看着。这个脚本补的就是这块。
 *
 * 口径（四条，全部是"必须"）
 * --------------------------
 * 1. **定义文件读不到 ⇒ 拒绝判定**，不是"全都报成悬空"。
 *    判据自己算错方向，比判据不响更坏 —— 会把人派去修 93 个不存在的坑。
 * 2. **悬空引用必须自己声明**：引用所在段落里带「还没写 / 待写 / 待补」这类字样就跳过。
 *    ⚠️ 这条豁免**故意只认行内自证、不认中央清单**（清单会腐烂，改文档的人不会记得更新它）。
 *    ⚠️ 窗口是**引用那行 ± 2 行**（遇空行 / 标题行即停），不是整个列表 ——
 *    否则一个 40 行的列表里随便哪个字都能把整段引用一起免掉。
 *    被跳过的条数会**打印出来**（「跳过也要说出来」，否则豁免是隐形的）。
 * 3. **重复定义也算故障**：同一个编号有两个标题正文 —— 就是第 2 条那个病。
 *    同族还有**重复的小节编号**（同一份文档里两段不相干的内容都叫「十一、」）。
 * 4. **必须剥掉代码围栏再看标题**：`# 贴图尺寸上限…。` 这种行在 `python` 代码块里是**注释**，
 *    不是被提错的标题。第一版口径没剥围栏，**6 条「畸形标题」里 3 条是假警报**。
 *    所以「代码块里的标题样注释不算命中」这条**冻结成了自证用例**。
 *
 * 第四类：**链接目标文件**（2026-09-26 加）
 * ------------------------------------------
 * 前面三类管的是**页内**的指针（标题锚点、编号），管不了 `](x.md)` 指向的那个**文件**。
 * 于是这一类一直没人看，而它断了以后**比锚点断更安静**：
 *
 *     `自检维修手册.md` 里三处 `[坑 29](../坑与雷点.md)`
 *
 * 文件系统里点开就是 **404**；而在应用内的 URL 空间里（`/自检维修手册.md` 的 `..` 到根就停）
 * 它**恰好还能打开** —— 所以肉眼验收永远看不出问题。本机实测这三处**已静默 ≥ 3 个月**
 * （预合并备份 `docs_merge_20260926-185623` 里原文就是 `../`，不是某次搬迁引入的）。
 *
 * 口径（四条，都可指回一次真实故障或一次真实假报）
 *   1. **剥围栏 + 剥行内代码**再看 —— 理由同第 4 条：代码里的不是引用。
 *      2026-09-26 实测：`坑与雷点.md` 里那句 PowerShell
 *      `` `[int]((Get-Date) - [datetime]$_.CreationDate)` `` 曾被报成"链接目标 `(Get-Date`"。
 *   2. 跳过**外部 scheme**（`https:` / `mailto:` …）、**协议相对**（`//`）、**纯锚点**（`#s43-…`）
 *      与 `/` 开头的**站内绝对路径**（那是 URL 空间，不是仓库相对路径）。
 *   3. **目标越出项目根也算问题**：本项目文档全在项目第一层（见 `_governance/README.md` 一点六），
 *      凡是 `../` 都是把**旧布局**（文档还在 `docs/` 里时）的写法带过来了。
 *   4. 只在 `.md` 里查（散文里才有链接）；范围与编号引用**同一套 `REF_ROOTS`**，印在输出里。
 *
 * 范围：`REF_ROOTS` 那四组（顶层 `.md`、`.workbuddy/memory` 的 `.md`、`tools/`、
 * `web/js/`），**排除** `dist/` `.trash/` `shots/` `node_modules/` `web/vendor/`
 * —— 产物/备份/上游代码不该数第二遍。链接目标检查**只跑其中 `.md`**。
 * 编号引用查 `坑 N` 与 `第 N 轮` 两类；小节结构查重复小节号与"标题像正文"；
 * **不查 `§N`、不查行号引用**。
 *
 * 性能（这台机器上量过）
 * ----------------------
 * `--selftest` 第一版在临时目录里搭 9 套夹具再 `rmSync(recursive)`，**实测 1.87 s**，
 * 而空 node 启动只要 **339 ms** —— 也就是说 1.5 s 全花在删除上
 * （本机「删一个文件 40–60 ms」是实测过的老坑）。而这条检查在每次自检里都要跑。
 * ⇒ 自证**改成走内存文件表**（`scan(root, vfs)` 的 `vfs` 参数），一个字节都不落盘。
 *   「慢但熟悉的手段会把检查拖到没人跑，而没人跑的检查等于没有检查。」
 *
 * 用法
 * ----
 *     node tools/check-refs.mjs
 *     node tools/check-refs.mjs --selftest   # 先自证会响（8 个注入 + 6 条反面/边界），再查真文档
 *     node tools/check-refs.mjs --json
 * 退出码：0 = 全部可解析；1 = 有悬空/重复；2 = 自证失败或定义文件读不到（**拒绝判定**）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const SELFTEST = ARGV.includes('--selftest');

/**
 * 两类编号引用。`ref` 里的第二个捕获组是**区间**（「坑 43–47」「第 17–19 轮」）——
 * 区间要求**每一个**编号都存在，不是只看端点。
 */
const DEFS = [
  {
    id: 'pit',
    unit: '坑',
    defFile: '坑与雷点.md',
    heading: /^#{2,4}\s*坑\s*(\d+)/,
    ref: String.raw`坑\s*(\d+)\s*(?:[–—~-]\s*(\d+))?`,
  },
  {
    id: 'round',
    unit: '轮',
    // ⚠️ 2026-09-26 文档合并：原《对话记录.md》已并入 `坑与雷点.md` 的**附录**
    //    ⇒ 两类编号现在同住一份文件，`defFile` 跟着走（旧值是「对话记录.md」，
    //    那份文件在第一层已不存在）。史实保留在下面那条"踩过的病"里。
    defFile: '坑与雷点.md',
    heading: /^#{2,4}\s*第\s*(\d+)\s*轮/,
    ref: String.raw`第\s*(\d+)\s*(?:[–—~-]\s*(\d+)\s*)?轮`,
  },
];

/**
 * 悬空引用的**行内自证**词表。不维护中央清单 —— 声明写在引用旁边。
 * 词要窄：写「待补」是真声明，写「以后」不算。
 */
const REF_EXEMPT = /还没写|尚未写|未写|待写|待补|占位/;

/** 自证豁免的搜索窗口：引用那行 ±2 行，遇空行 / 标题行即停。 */
const EXEMPT_WINDOW = 2;

/** 小节编号前缀：「一、」「十一、」「3.」「3．」。 */
const SECTION_NUM = /^#\s+([一二三四五六七八九十百]+|\d+)\s*[、.．]\s*\S/;

/**
 * Markdown 链接目标。三种写法都要吃下：
 * `](x.md)` · `](<x y.md>)`（尖括号里允许空格）· `](x.md "标题")`。
 * 只捕到目标为止，**不跨行**。
 */
const MD_LINK = /\]\(\s*(?:<([^>]*)>|([^\s)]+))/g;

/** 外部 scheme（`https:` / `mailto:` / `C:` …）与协议相对（`//`）—— 那不是本项目里的文件。 */
const LINK_EXTERNAL = /^(?:[a-zA-Z][a-zA-Z0-9+.\-]*:|\/\/)/;

/** 目标里带这些字符的当**模板/占位**放过：`{name}` `<slot>` `$var`。 */
const LINK_PLACEHOLDER = /[{}<>$]/;

/**
 * 代码围栏掩码：`true` 表示这一行**在代码块里面**。
 * 不看围栏会把 `python` 注释 `# 贴图尺寸上限…。` 当成"正文被提成了标题"。
 */
function fenceMask(lines) {
  const inFence = new Array(lines.length).fill(false);
  let open = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) {
      inFence[i] = true; // 围栏行本身也算"围栏内"
      open = !open;
      return;
    }
    inFence[i] = open;
  });
  return inFence;
}

/**
 * 行内代码掩码：把 ``` ``…`` ``` 与 `` `…` `` 换成**等长空格**。
 *
 * 理由与 `fenceMask` 完全相同 —— **代码里的不是引用**。区别只是粒度：
 * `fenceMask` 管整块，这个管一行里的短片段。只在本行内配对（跨行的行内代码在
 * Markdown 里本来就不成立），所以一个落单的反引号不会被误当成"从这里到行尾都是代码"。
 *
 * 换等长空格（而不是删掉）是为了让报错里的**列位置不漂**。
 */
function maskInlineCode(line) {
  return String(line)
    .replace(/``.+?``/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * 小节结构：① 同一个编号有两个小节（两段不相干的内容共用一个小节号 —— 同 坑 71–76 的病）；
 * ② 正文被写成了标题（H1 以「。」「；」收尾 —— 真标题不会这么写）。
 *
 * ⚠️ **这两条是 Markdown 的形状规则，只能用在 `.md` 上。**
 *    把源码并进扫描范围（见 `fsVfs`）之后，第一版直接对 Python 也跑了这两条，
 *    结果一口气报出 **118 处**「标题像正文」—— 全部来自 `tools/*.py` 里的
 *    `# 中文注释。`。**源码里的 `#` 本来就是注释，以句号收尾才是人话。**
 *    这正是「判据套错格式」：它没有算错方向，它算的是**另一件事**。
 *    ⇒ 引用检查（`坑 N` / 第 N 轮）是跨格式的，照旧全扫；
 *      标题形状检查**按扩展名收窄到 `.md`**。
 *    教训：**扩大判据范围的同一步，就要重新问一遍「这条规则在新范围里还成立吗」。**
 */
function headingProblems(files, vfs) {
  const problems = [];
  let headings = 0;
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue;   // ← 见上面那段：源码不是 Markdown
    const lines = vfs.read(f).split(/\r?\n/);
    const inFence = fenceMask(lines);
    const seen = new Map();
    lines.forEach((l, i) => {
      if (inFence[i]) return;
      const m = /^#\s+(\S.*)$/.exec(l);
      if (!m) return;
      headings++;
      const t = m[1];
      const n = SECTION_NUM.exec(l);
      if (n) seen.set(n[1], (seen.get(n[1]) ?? []).concat([i + 1]));
      if (/[。；]\s*$/.test(t)) {
        problems.push({
          kind: '标题像正文',
          file: f,
          line: i + 1,
          ref: '小节标题',
          why: '这一行以「。」/「；」收尾，看着是**正文**而不是标题 —— 多半是某次批量替换把 `#` 加错了位置。'
            + '（代码块里的同形注释不算命中，已剥围栏。）',
          text: l.trim().slice(0, 80),
        });
      }
    });
    for (const [k, at] of seen) {
      if (at.length > 1) {
        problems.push({
          kind: '重复小节',
          file: f,
          line: at[1],
          ref: `小节 ${k}`,
          why: `${f} 里「${k}、」有两个小节（第 ${at.join(' / ')} 行）—— 同一份文档里两段不相干的内容`
            + '共用一个小节号，跳转和引用都会落到错的那一段。**同一个指针指向两个东西，比指针断了更坏。**',
          text: lines[at[1] - 1].trim().slice(0, 80),
        });
      }
    }
  }
  return { problems, headings };
}

/**
 * ④ 链接目标：`](x.md)` 指得到东西吗？（口径见文件头「第四类」）
 *
 * 与前三类一样，**除读取之外不做判断** —— 自证走的是同一条代码路径。
 */
function linkProblems(files, vfs) {
  const problems = [];
  let links = 0;
  let skipped = 0;
  const existsIn = (rel) => (typeof vfs.exists === 'function'
    ? vfs.exists(rel)
    : vfs.list().includes(rel));

  for (const f of files) {
    if (!f.endsWith('.md')) continue; // 散文里才有链接；源码里的 md 字面量归 check_doc_paths.py 管
    const lines = vfs.read(f).split(/\r?\n/);
    const inFence = fenceMask(lines);
    const dir = path.posix.dirname(f);
    lines.forEach((l, i) => {
      if (inFence[i]) return;
      const masked = maskInlineCode(l);
      MD_LINK.lastIndex = 0;
      let m;
      while ((m = MD_LINK.exec(masked)) !== null) {
        const dest = (m[1] ?? m[2] ?? '').trim();
        if (!dest || dest.startsWith('#') || dest.startsWith('/')
          || LINK_EXTERNAL.test(dest) || LINK_PLACEHOLDER.test(dest)) {
          skipped++;
          continue;
        }
        const core = dest.split('#')[0].split('?')[0].trim();
        if (!core) { skipped++; continue; }
        links++;
        const rel = path.posix.normalize(path.posix.join(dir, core));
        if (rel.startsWith('..')) {
          problems.push({
            kind: '链接越界',
            file: f,
            line: i + 1,
            ref: dest,
            why: `链接目标 \`${dest}\` **越出了项目根**（解析到 \`${rel}\`）。`
              + '本项目文档一律放**项目第一层**（`_governance/README.md` 一点六），'
              + '凡是 `../` 都是**旧布局**（文档还在 `docs/` 里时）的写法留下来了 ——'
              + '在文件系统里点开是 **404**，而在应用内的 URL 空间里 `..` 到根就停、**看着是好的**。',
            text: l.trim().slice(0, 100),
          });
        } else if (!existsIn(rel)) {
          problems.push({
            kind: '链接悬空',
            file: f,
            line: i + 1,
            ref: dest,
            why: `链接目标 \`${rel}\` **在盘上不存在**。点过去哪儿也没有，**页面上不会报错**。`
              + '（若那是尚未生成/已改名的产物，就把链接改成现状；别留一个指不到东西的指针。）',
            text: l.trim().slice(0, 100),
          });
        }
      }
    });
  }
  return { problems, links, skipped };
}

/* ---------- 文件系统抽象（自证走内存，见文件头「性能」） ---------- */

/**
 * 真实磁盘：文档 + **源码里也会引用编号**。
 *
 * ⚠️ 这里原来只列顶层 `.md`，于是漏掉一个**真实的缺号**：
 *    `坑与雷点.md` 里根本没有 `坑 96` 的正文（编号序列是 …95、**97**…），
 *    而三处引用它 —— `tools/build-textures.py:315`、`.workbuddy/memory/MEMORY.md`、
 *    `.workbuddy/memory/MEMORY-附录.md` —— **全在旧扫描范围之外**。
 *    结果就是那句话：「364 处引用全部指得到东西」——**在它自己划的圈里成立，
 *    在整个仓库里不成立**。
 *    ⇒ **判据的范围就是判据的结论。** 范围悄悄写窄，结论就悄悄变假，
 *      而输出里一行提示都不会有。所以范围要尽量往前铺，并且**印出来**。
 *
 * 纳入：顶层 `.md`、`.workbuddy/memory` 下的 `.md`、`tools/` 下的 py/mjs/js、
 *       `web/js` 下的全部 `.js`（递归）。
 *       ⚠️ 别把带 `星号斜杠` 的通配写法写进块注释里 —— `**／*.js` 那个星号斜杠会**提前闭合注释**，
 *          报的是「SyntaxError: Unexpected token '*'」，看着像语法写错，其实是注释被吃掉了一截。
 * 排除：`dist/`（产物）、`.trash/`、`shots/`、`node_modules/`、`web/vendor/`（第三方）
 *       —— 产物/备份/上游代码不该数第二遍，也不能拿上游的字面值当权威（坑 42）。
 */
const REF_ROOTS = [
  { dir: '.', exts: ['.md'], deep: false },
  { dir: '.workbuddy/memory', exts: ['.md'], deep: false },
  /* ⚠️ `tools` 必须 **deep: true**（2026-09-12 第 37 轮改）。
   *    原来是 `deep: false` ⇒ 只扫 `tools/` **顶层**，而 `tools/lib/strip-comments.mjs`
   *    这类子目录里的文件**从来没被扫过**。本脚本自己最后那句警告说的就是这个：
   *    「加新的引用来源时，要把它并进 REF_ROOTS —— 否则就是范围悄悄变窄、结论悄悄变假」。
   *    ⚠️ 而「范围变窄」的症状是**判据更绿了**，不是更红 —— 这正是它最危险的地方。 */
  { dir: 'tools', exts: ['.py', '.mjs', '.js'], deep: true },
  { dir: 'web/js', exts: ['.js'], deep: true },
];

export function fsVfs(root) {
  const walk = (rel, exts, deep, acc) => {
    let ents;
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const child = rel === '.' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { if (deep) walk(child, exts, deep, acc); continue; }
      if (exts.some((x) => e.name.toLowerCase().endsWith(x))) acc.push(child);
    }
  };
  return {
    list() {
      const acc = [];
      for (const r of REF_ROOTS) walk(r.dir, r.exts, r.deep, acc);
      return acc.sort();
    },
    read: (name) => fs.readFileSync(path.join(root, name), 'utf8'),
    /* 链接目标存在性（第四类用）。**不限于 REF_ROOTS 的扩展名** ——
     * 链接可以指向 `.png` / `.html` / 目录，那些本来就不在本脚本的扫描范围内。 */
    exists: (rel) => fs.existsSync(path.join(root, rel)),
  };
}

/** 内存文件表：`{ '手册.md': '正文…' }`。自证用它，不碰磁盘。 */
export function memVfs(files) {
  return {
    list: () => Object.keys(files).sort(),
    read(name) {
      if (!(name in files)) {
        const e = new Error(`ENOENT: ${name}`);
        e.code = 'ENOENT';
        throw e;
      }
      return files[name];
    },
    exists: (rel) => Object.prototype.hasOwnProperty.call(files, rel),
  };
}

/** 段落窗口：以引用行为中心，上下各最多 EXEMPT_WINDOW 行，遇空行或标题行即停。 */
function windowAround(lines, idx) {
  const out = [lines[idx] ?? ''];
  for (let d = 1; d <= EXEMPT_WINDOW; d++) {
    const down = lines[idx + d];
    if (down === undefined || down.trim() === '' || /^#{1,6}\s/.test(down)) break;
    out.push(down);
  }
  for (let d = 1; d <= EXEMPT_WINDOW; d++) {
    const up = lines[idx - d];
    if (up === undefined || up.trim() === '' || /^#{1,6}\s/.test(up)) break;
    out.push(up);
  }
  return out.join('\n');
}

/** 展开一个引用为编号数组（区间展开成 [a..b]）。 */
function expand(a, b) {
  const lo = Number(a);
  if (b === undefined || b === null || b === '') return [lo];
  const hi = Number(b);
  if (!Number.isFinite(hi) || hi < lo || hi - lo > 200) return [lo]; // 明显不是区间的数字不当区间处理
  const out = [];
  for (let n = lo; n <= hi; n++) out.push(n);
  return out;
}

/**
 * 核心：扫一套文档。**除读取之外不做判断**（自证走的是同一条代码路径）。
 * @param {string} root 仓库根（只用于报错信息与默认 vfs）
 * @param {{list:()=>string[], read:(n:string)=>string, exists?:(r:string)=>boolean}} [vfs] 文件来源，默认真实磁盘
 *   `exists` 只有第四类（链接目标）用得上；旧的自定义 vfs 不带它也能跑（回退成查 `list()`）。
 * @returns {{files:string[], refs:number, exempted:number, headings:number,
 *            links:number, linkSkipped:number, problems:object[], refused:string|null}}
 */
export function scan(root, vfs = fsVfs(root)) {
  const problems = [];
  let refTotal = 0;
  let exempted = 0;

  // ① 先收定义。定义文件读不到 ⇒ 拒绝判定（绝不把「我不知道」当成「全都不存在」）。
  const defs = new Map();
  for (const d of DEFS) {
    let txt;
    try {
      txt = vfs.read(d.defFile);
    } catch {
      return {
        files: [],
        refs: 0,
        exempted: 0,
        problems: [],
        refused: `读不到定义文件 ${d.defFile} —— 编号的"正本"不在，任何"悬空"判定都不可信。`,
      };
    }
    const lines = txt.split(/\r?\n/);
    const set = new Set();
    const dup = new Map();
    lines.forEach((l, i) => {
      const m = d.heading.exec(l);
      if (!m) return;
      const n = Number(m[1]);
      set.add(n);
      dup.set(n, (dup.get(n) ?? []).concat([i + 1]));
    });
    for (const [n, at] of dup) {
      if (at.length > 1) {
        problems.push({
          kind: '重复',
          file: d.defFile,
          line: at[1],
          ref: `${d.unit} ${n}`,
          why: `${d.defFile} 里「${d.unit} ${n}」有两个标题（第 ${at.join(' / ')} 行）——`
            + '引用它的人会落到哪一个？**同一个指针指向两个东西，比指针断了更坏。**',
          text: (lines[at[1] - 1] ?? '').trim().slice(0, 80),
        });
      }
    }
    defs.set(d.id, { ...d, set });
  }

  // ② 再扫引用。
  const files = vfs.list();
  for (const f of files) {
    const lines = vfs.read(f).split(/\r?\n/);
    for (const d of DEFS) {
      const table = defs.get(d.id);
      const re = new RegExp(d.ref, 'g');
      lines.forEach((l, i) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(l)) !== null) {
          refTotal++;
          const nums = expand(m[1], m[2]);
          const missing = nums.filter((n) => !table.set.has(n));
          if (!missing.length) continue;
          // 行内自证：引用旁边写明了「还没写」就放行，但要数出来。
          if (REF_EXEMPT.test(windowAround(lines, i))) {
            exempted++;
            continue;
          }
          problems.push({
            kind: '悬空',
            file: f,
            line: i + 1,
            ref: missing.length > 1
              ? `${d.unit} ${missing[0]}–${missing[missing.length - 1]}`
              : `${d.unit} ${missing[0]}`,
            why: `${d.defFile} 里没有${missing.length > 1 ? `这些${d.unit}` : `这个${d.unit}`}：`
              + `${missing.join(' / ')}。引用指向空气，点过去哪儿也没有，**页面上不会报错**。`,
            text: l.trim().slice(0, 80),
          });
        }
      });
    }
  }

  // ③ 小节结构（剥围栏后看标题）。
  const hp = headingProblems(files, vfs);
  problems.push(...hp.problems);

  // ④ 链接目标文件（剥围栏 + 剥行内代码后看 `](x.md)`）。
  const lp = linkProblems(files, vfs);
  problems.push(...lp.problems);

  return {
    files,
    refs: refTotal,
    exempted,
    headings: hp.headings,
    links: lp.links,
    linkSkipped: lp.skipped,
    problems,
    refused: null,
  };
}

/* ============================================================
   自证：8 个注入 + 6 条反面/边界 + 基线必须先绿 —— 共 15 例（全部走内存，不落盘）
   ============================================================ */

const BASE_PIT = [
  '# 坑与雷点',
  '',
  '## 坑 1 · 甲',
  '## 坑 2 · 乙',
  '## 坑 3 · 丙',
  '',
].join('\n');
/**
 * ⚠️ **2026-09-26 文档合并后，坑与轮次同住 `坑与雷点.md`** ——
 *    原《对话记录.md》成了它的**附录**（`_migration/docs_merge.py`）。
 *    夹具必须跟着变：旧夹具是 `{'坑与雷点.md': BASE_PIT, '对话记录.md': BASE_ROUND}`
 *    两个键 —— 若把第二个键也改名成 `坑与雷点.md`，JS 对象**同键覆盖**、
 *    `BASE_PIT` 被整个吃掉，自证当场 7/12 假红（2026-09-26 实测）。
 *    **夹具里的文件名也是"引用"，改名时要一起想。**
 */
const BASE = [
  BASE_PIT.trimEnd(),
  '',
  '## 附录 · 原《对话记录.md》',
  '',
  '## 第 1 轮 · 开张',
  '',
].join('\n');

export function selftest() {
  const cases = [];
  const run = (name, files) => {
    const r = scan('<内存>', memVfs(files));
    cases.push({ name, ...r });
    return r;
  };

  // 0. 基线：好引用必须**绿**（注入前必须先绿，否则这次注入验收了一个它没碰过的结论）
  const base = run('基线 · 全部可解析', {
    '坑与雷点.md': BASE,
    '手册.md': '见 坑 2 与 坑 3，另见第 1 轮。\n',
  });
  cases.push({ name: '基线本身零问题', problems: base.problems });

  // 1. 注入：一个悬空坑引用
  run('注入 · 悬空 坑 9', {
    '坑与雷点.md': BASE,
    '手册.md': '见 坑 2。\n另见 坑 9。\n',
  });

  // 2. 注入：重复定义
  run('注入 · 坑 2 两个标题', {
    '坑与雷点.md': BASE.replace('## 坑 3 · 丙', '## 坑 3 · 丙\n\n## 坑 2 · 又一版'),
    '手册.md': '见 坑 2。\n',
  });

  // 3. 注入：区间只写了一半
  run('注入 · 区间 坑 2–5 缺 4、5', {
    '坑与雷点.md': BASE,
    '手册.md': '见 坑 2–5。\n',
  });

  // 4. 注入：轮次悬空
  run('注入 · 悬空 第 5 轮', {
    '坑与雷点.md': BASE,
    '手册.md': '详见第 5 轮。\n',
  });

  // 5. 豁免：行内自证应当放行，且要**数出来**
  const ex = run('豁免 · 旁边写了「还没写」', {
    '坑与雷点.md': BASE,
    '手册.md': '> 见 坑 9 一节\n> 的正文**还没写**，此处只有引用。\n',
  });
  cases.push({ name: '豁免确实生效（1 条被跳过）', exempted: ex.exempted });

  // 6. 豁免的反面：词在 5 行之外 ⇒ 不许放行（窗口不能无限大）
  run('豁免不生效 · 声明隔了 6 行', {
    '坑与雷点.md': BASE,
    '手册.md': '见 坑 9。\n\n\n\n\n\n\n正文还没写。\n',
  });

  // 7. 拒绝判定：定义文件缺失
  //    ⚠️ 两个 def 现在**同读** `坑与雷点.md`（见下面的合并说明）⇒ 把它整个拿掉，
  //       就是"正本不在"。旧夹具是留 `对话记录.md`、缺 `坑与雷点.md`，那份区分已不存在。
  const ref = run('拒绝判定 · 缺 坑与雷点.md', {
    '手册.md': '见 坑 2。\n',
  });
  cases.push({ name: '定义文件缺失时拒绝判定', refused: ref.refused });

  // 8. 注入：两个小节共用一个小节号
  run('注入 · 两个「一、」小节', {
    '坑与雷点.md': BASE,
    '手册.md': '# 一、甲\n\n正文。\n\n# 一、乙\n\n正文。\n',
  });

  // 9. 注入：正文被 `#` 提成了标题（以句号收尾）
  run('注入 · 正文被写成标题', {
    '坑与雷点.md': BASE,
    '手册.md': '# 正常小节\n\n# 这一行其实是正文，被 `#` 提成了标题。\n',
  });

  // 10. 反面（关键）：**代码块里**的同形注释不算命中 —— 剥围栏就是为它加的。
  //     第一版口径没剥围栏，把 `python` 注释 `# 贴图尺寸上限…。` 当成了畸形标题。
  run('反面 · 代码块里的同形注释不算', {
    '坑与雷点.md': BASE,
    '手册.md': '# 正常小节\n\n```python\n# 这一行是代码注释，以句号收尾。\n```\n',
  });

  // 11. 注入：链接目标**越出项目根**
  //     这不是假想 —— 2026-09-26 真文档里就是这么断的（`自检维修手册.md` 三处 `../坑与雷点.md`）。
  //     ⚠️ 夹具里的**文字**也会被别的检查项吃到：第一版这里写的是 `[坑 29](…)`，
  //        而 BASE 只有坑 1–3 ⇒ 编号引用那一类同时报了「悬空 坑 29」，用例数从 1 变 2。
  //        同 `BASE` 注释里那条：**夹具里的每一样东西都是"引用"，写的时候要一起想。**
  run('注入 · 链接越出项目根', {
    '坑与雷点.md': BASE,
    '手册.md': '详见 [这份清单](../坑与雷点.md)。\n',
  });

  // 12. 注入：链接目标**不存在**（同目录写错名字）
  run('注入 · 链接目标不存在', {
    '坑与雷点.md': BASE,
    '手册.md': '详见 [手册](没有这个文件.md)。\n',
  });

  // 13. 反面（关键）：外链 / 纯锚点 / 站内绝对路径 / **行内代码里**的同形串，**一个都不许报**。
  //     ⇒ 剥行内代码就是为最后那条加的：2026-09-26 实测 `坑与雷点.md` 里那句
  //        PowerShell `[int]((Get-Date) - [datetime]$_.CreationDate)` 被报成
  //        "链接目标 `(Get-Date`" —— 假报会把人派去修一个不存在的链接。
  run('反面 · 外链/锚点/行内代码都不算', {
    '坑与雷点.md': BASE,
    '手册.md': '见 [官网](https://example.com/a.md) 与 [S43](#s43-自检报跑不起来2026-09-26)、'
      + '[站内](/index.html)。\n'
      + '命令里那种写法 `[int]((Get-Date) - $_.X)` 不是链接。\n',
  });

  // ---- 断言 ----
  // ⚠️ 第 4 条断言**第一版写错过**：拿 `p.ref.endsWith('4')` 去判「区间 坑 2–5 缺 4、5」，
  //    而工具正确报出的是 `坑 4–5`（以 5 结尾）⇒ 断言为假、工具被冤枉成"口径有问题"。
  //    **断言的写法本身也会算错方向**，所以这里断言**完整的 ref 串**，不做后缀匹配。
  const expect = [
    ['基线 · 全部可解析', 0, 0, null],
    ['基线本身零问题', 0, null, null],
    ['注入 · 悬空 坑 9', 1, null, ['坑 9']],
    ['注入 · 坑 2 两个标题', 1, null, ['坑 2']],
    ['注入 · 区间 坑 2–5 缺 4、5', 1, null, ['坑 4–5']],
    ['注入 · 悬空 第 5 轮', 1, null, ['轮 5']],
    ['豁免 · 旁边写了「还没写」', 0, 1, null],
    ['豁免不生效 · 声明隔了 6 行', 1, null, null],
    ['拒绝判定 · 缺 坑与雷点.md', 0, null, 'refused'],
    ['注入 · 两个「一、」小节', 1, null, ['小节 一']],
    ['注入 · 正文被写成标题', 1, null, ['小节标题']],
    ['反面 · 代码块里的同形注释不算', 0, null, null],
    ['注入 · 链接越出项目根', 1, null, ['../坑与雷点.md']],
    ['注入 · 链接目标不存在', 1, null, ['没有这个文件.md']],
    ['反面 · 外链/锚点/行内代码都不算', 0, null, null],
  ];

  const lines = [];
  let pass = 0;
  let fail = 0;
  for (const [name, nProb, nExempt, mustRef] of expect) {
    const c = cases.find((x) => x.name === name);
    const okProb = (c.problems?.length ?? -1) === nProb;
    const okEx = nExempt === null || c.exempted === nExempt;
    let okRef = true;
    if (mustRef === 'refused') okRef = Boolean(c.refused);
    else if (mustRef) {
      const got = (c.problems ?? []).map((p) => String(p.ref));
      okRef = mustRef.every((want) => got.includes(want));
    }
    const ok = okProb && okEx && okRef;
    if (ok) pass++; else fail++;
    lines.push(`${ok ? '  ✓' : '  ✗'} ${name}`
      + ` — 问题 ${c.problems?.length ?? '?'}（期望 ${nProb}）`
      + `，跳过 ${c.exempted ?? 0}${nExempt === null ? '' : `（期望 ${nExempt}）`}`
      + `${mustRef === 'refused' ? `，拒绝判定：${c.refused ? '有' : '没有'}` : ''}`);
    if (!ok) {
      for (const p of c.problems ?? []) lines.push(`        · ${p.kind} ${p.ref} @${p.file}:${p.line}`);
    }
  }

  lines.push('');
  lines.push(fail === 0
    ? `  ✓ ${pass}/${expect.length} 自证通过 —— 口径会响，可以拿去查真文档了。`
    : `  ✗ ${pass}/${expect.length} —— **口径本身有问题，拒绝判定**（绝不拿它去报故障）。`);
  return { pass, fail, total: expect.length, lines };
}

/* ============================================================
   CLI
   ============================================================ */

function main() {
  const out = { root: ROOT, selftest: null, result: null };
  let code = 0;

  if (SELFTEST) {
    const st = selftest();
    out.selftest = { pass: st.pass, fail: st.fail, total: st.total };
    if (!JSON_OUT) st.lines.forEach((l) => console.log(l));
    if (st.fail > 0) code = 2;
  }

  if (code === 0) {
    const r = scan(ROOT);
    out.result = {
      files: r.files.length, refs: r.refs, exempted: r.exempted,
      headings: r.headings, links: r.links, linkSkipped: r.linkSkipped,
      problems: r.problems, refused: r.refused,
    };
    if (r.refused) code = 2;
    else if (r.problems.length) code = 1;

    if (!JSON_OUT) {
      if (r.refused) {
        console.log(`  ✗ 拒绝判定：${r.refused}`);
        console.log('    → 从备份或发行包恢复定义文件，再跑一次。');
      } else {
        console.log(`  扫了 ${r.files.length} 个会引用编号的文件`
          + `（顶层 .md + .workbuddy/memory + tools/*.{py,mjs,js} + web/js/**，`
          + `排除 dist/.trash/shots/node_modules/web-vendor）：`
          + `${r.refs} 处编号引用（${r.exempted} 处带行内自证「还没写」，跳过）、`
          + `${r.headings} 个小节标题、`
          + `${r.links} 处本地链接（另有 ${r.linkSkipped} 处外链/锚点/站内绝对路径/行内代码片段，跳过）。`);
        if (!r.problems.length) {
          console.log('  ✓ 全部指得到东西：坑 N 有正文、第 N 轮有轮次，没有悬空引用，'
            + '也没有重复编号 / 被写坏的标题；链接目标**都在项目里**、且没越出项目根。');
          console.log('    ⚠️ 这句只在**上面那个范围内**成立。加新的引用来源（比如新的脚本目录）时，'
            + '要把它并进 REF_ROOTS —— 否则就是「范围悄悄变窄、结论悄悄变假」。');
        } else {
          for (const p of r.problems) {
            console.log(`  ✗ ${p.kind}：${p.ref}  @ ${p.file}:${p.line}`);
            console.log(`      ${p.why}`);
            console.log(`      原文：${p.text}`);
          }
          console.log(`\n  ${r.problems.length} 处指不到东西。`);
          console.log('  → 处置：要么**补上标题**（推荐，正文本来就有的话），要么**改正编号**。');
          console.log('    · 若报的是「链接悬空 / 链接越界」：**改链接**（`../x.md` → `x.md`），'
            + '别去建一个同名文件迁就它 —— 那会把一处笔误固化成一条假结构。');
          console.log('    ⚠️ 别「照着判据改引用」——先确认那个编号是真的不存在，');
          console.log('       而不是定义文件的标题格式没被认出来（本脚本先跑 --selftest 就是为了这个）。');
        }
      }
    }
  }

  if (JSON_OUT) console.log(JSON.stringify(out));
  process.exit(code);
}

// 被 import 时（自检内核 / 别的工具）不自动跑 CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

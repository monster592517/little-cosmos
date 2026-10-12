/**
 * 小小宇宙 · 自检模块
 *
 * 这东西的定位：**把「维修手册」里能用机器判定的部分写成代码**。
 * 所以每一条检查都必须带一个 `fix` —— 一句可以直接照做的话（跑哪个命令 / 改哪个文件）。
 * 只报「有问题」却不告诉你怎么办的检查，等于给车主看仪表盘却把修理厂地址抠掉。
 *
 * 三条设计原则：
 *   1. **现场读，不缓存**。文件 mtime、体积、条目数一律现读。登记表里写死的数字不采信。
 *   2. **登记表要接受拷问**。sources.json 说自己有这个产出、那条管线——就去盘上核对。
 *      登记表与现实不符是最隐蔽的故障：程序不报错，只是悄悄少了一块数据。
 *   3. **分级只管一件事——「现在还能不能正常用」**。
 *      error = 功能已经坏了 / 会立刻坏；warn = 还能用但正在腐坏；ok = 没事。
 *      不搞"总分""健康度百分比"这种自欺欺人的数字。
 *
 * 零第三方依赖，Node 18+。
 */

import { readFile, stat, readdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// ⚠️ 子进程一律走 runCapture（落临时文件），**不要**用 `execFileSync(...,{encoding:'utf8'})`
//    —— 那个写法会建管道，而本机**不许给子进程建管道**（EBUSY，实测 12/12）。
//    根因、实测数据与三条纪律见 `server/lib/run-capture.mjs` 的文件头。
import { runCapture, salvageJson, errText } from './run-capture.mjs';

/* ============================================================
   基础工具
   ============================================================ */

const LEVEL_ORDER = { ok: 0, warn: 1, error: 2 };

/** 一条检查。level 三选一，fix 永远要给（实在没有可执行动作才写「无需处理」并说明）。 */
const mk = (id, level, title, detail, fix) => ({ id, level, title, detail, fix });

async function exists(p) {
  try { await access(p, FS.F_OK); return true; } catch { return false; }
}

async function statOf(p) {
  try { const s = await stat(p); return { exists: true, size: s.size, mtime: s.mtime }; } catch { return { exists: false, size: 0, mtime: null }; }
}

async function readJson(p) {
  try { return { ok: true, data: JSON.parse(await readFile(p, 'utf8')) }; }
  catch (e) { return { ok: false, err: e.message, missing: e.code === 'ENOENT' }; }
}

async function dirCount(rel, ROOT) {
  try { return (await readdir(path.join(ROOT, rel))).length; } catch { return null; }
}

/**
 * 这个路径是不是「原始素材库」里的东西？
 *
 * 便携版发行包**有意**不带 `data/raw/`：280 MB 原始素材只有重跑数据管线时才用得到，
 * 而包要能"解压即用"。所以「raw 里的东西不见了」在包里是**正常状态**，不是故障。
 *
 * ⚠️ 判断依据是**现场**（`data/raw/` 整个目录存不存在），不是"我记得包里没有" ——
 *    靠记忆来定分级，换个环境就开始报假故障，而**假故障会训练人忽略自检**，
 *    那是比漏报更长远的损失。
 * ⚠️ 只有 `data/raw/` **下面**的缺失才豁免。别把这条做成"整个 data.files 降级" ——
 *    那会把真正的数据文件丢失一起放过（见「坑与雷点.md」坑 32 的分级口径那一段）。
 */
const isRawPath = (rel) => /^data\/raw(\/|$)/.test(String(rel));

/** 现场看：这份安装带不带原始素材库。 */
async function hasRawLibrary(ROOT) {
  return exists(path.join(ROOT, 'data', 'raw'));
}

const DAY = 86400000;

/**
 * 「数据该多久重抓一次」——把 sources.json 里人类写的节奏翻成天数。
 * 翻不出来就返回 null，那就干脆不判超期。宁可不说，也不要瞎说。
 */
function cadenceDays(cadence) {
  if (typeof cadence !== 'string') return null;
  const table = [
    [/一次性/, Infinity], [/人工/, null],
    [/周/, 14], [/月/, 45], [/季度/, 120], [/半年/, 240], [/年/, 400],
  ];
  for (const [re, d] of table) if (re.test(cadence)) return d;
  return null;
}

/* ============================================================
   检查组 1：运行环境
   ============================================================ */

function checkRuntime(env) {
  const out = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push(mk(
    'runtime.node', major >= 18 ? 'ok' : 'error',
    `Node 版本 ${process.versions.node}`,
    major >= 18 ? '满足 ≥18 的要求。' : '本程序用了 Node 18 才有的 API（全局 fetch、node: 前缀导入）。',
    major >= 18 ? '无需处理。' : '升级 Node：https://nodejs.org/ 装 20 LTS 或更高，然后重开终端。',
  ));

  const heapMB = Math.round((process.memoryUsage().rss || 0) / 1048576);
  const freeMB = env.freeMemMB;
  out.push(mk(
    'runtime.memory',
    freeMB != null && freeMB < 800 ? 'warn' : 'ok',
    freeMB != null ? `本进程占用 ${heapMB} MB · 系统可用 ${freeMB} MB` : `本进程占用 ${heapMB} MB`,
    freeMB != null && freeMB < 800
      ? '可用物理内存低于 800 MB。再跑一次「恒星表全量」这类管线很可能被系统杀掉。'
      : '内存水位正常。',
    freeMB != null && freeMB < 800
      ? '先关掉占内存的程序（浏览器多标签、其它 Node 进程），再执行重活；或只更新单个管线而不是全部。'
      : '无需处理。',
  ));

  return out;
}

/**
 * 隔离区告警阈值（MB）。
 * 定得偏高是**故意的**：打包一次就会留一份暂存目录，那是正常操作，不该出声。
 */
const TRASH_WARN_MB = 1024;

/**
 * 隔离区（`.trash/`）的体积。
 *
 * 为什么要查：本项目的删除**一律走隔离区**（永久删除是禁止的），于是它**只进不出**。
 * 而 `tools/package.mjs` 每跑一次会往里丢一份约 130 MB 的旧暂存目录 ——
 * 打包四次就是 500 MB。它不影响程序能不能用，所以**最高只 warn**。
 *
 * 阈值取 1 GB 而不是「有几个暂存目录」：打完一次包就必然有这个目录，
 * 按个数判会变成「正常操作也报警」——误报会训练用户无视自检。
 */
async function checkTrash(ROOT) {
  const ID = 'env.trash-size';
  const dir = path.join(path.resolve(ROOT), '.trash');
  if (!(await exists(dir))) {
    return [mk(ID, 'ok', '隔离区还不存在', '还没往隔离区放过东西。', '无需处理。')];
  }

  let bytes = 0;
  let files = 0;
  let stages = 0;
  const walk = async (p) => {
    let ents = [];
    try { ents = await readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) {
        if (/^old-stage-/.test(e.name)) stages++;
        await walk(q);
      } else {
        files++;
        try { bytes += (await stat(q)).size; } catch { /* 读不到就不算，不编数字 */ }
      }
    }
  };
  await walk(dir);

  const mb = Math.round(bytes / 1048576);
  if (mb < TRASH_WARN_MB) {
    return [mk(ID, 'ok', `隔离区 ${mb} MB · ${files} 个文件`,
      `没到 ${TRASH_WARN_MB} MB 的提醒线（其中「old-stage-*」旧暂存目录 ${stages} 个）。`,
      '无需处理。')];
  }
  return [mk(ID, 'warn', `隔离区已经 ${mb} MB · ${files} 个文件`,
    `超过 ${TRASH_WARN_MB} MB 的提醒线，其中「old-stage-*」旧暂存目录 ${stages} 个。`
    + '每跑一次打包就会往里放一个（各约 130 MB），而隔离区是只进不出的。'
    + '这不影响使用，只是白占磁盘。',
    '先看计划：node tools/prune-trash.mjs --dry-run；确认后执行：node tools/prune-trash.mjs --apply')];
}

/* ============================================================
   检查组 2：程序骨架
   ============================================================ */

/**
 * 骨架文件，以及**缺了它到底算不算故障**。
 * 分级要诚实：便携版发行包里本来就不带 package.json（靠启动器直接调 node，不用 npm），
 * 缺了它程序照跑。把它判成 error 的话，用户一解压就看到"2 项故障"——自检自己先学会撒谎了。
 */
const SKELETON = [
  ['server/server.mjs', 'error', '本地服务入口，缺了什么都跑不起来'],
  ['web/index.html', 'error', '前端入口页'],
  ['data/sources.json', 'error', '数据源登记表；缺了「数据更新中心」整体不可用'],
  ['package.json', 'warn', '项目清单；缺失只影响 npm 命令，便携版靠启动器运行，不影响使用'],
];

const VENDOR = [
  ['web/vendor/three/three.module.js', 'error', 'three.js 主模块'],
  ['web/vendor/three/three.core.js', 'error', 'three.js 核心（r180 起拆分）'],
  ['web/vendor/astronomy/astronomy.js', 'error', '星历计算库；缺了所有天体位置都不准'],
];

/* ============================================================
   程序骨架 · 静态约定 A：源码里不许写死绝对路径
   ============================================================ */

/**
 * 为什么要有这条：见 `坑与雷点.md` 坑 93。
 *
 * 全项目取「工作区根」的地方有 44 处，42 处写的是
 * `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`，
 * 只有 2 个工具写死成 `'C:/Users/<local-user>/Desktop/<当时的工作区名>'`。
 *
 * 写死的路径比「写错」更难发现：**在作者这台机器上它永远是对的**。
 * 它只在「工作区改名」或「便携包被解到别处」的那一刻失效 —— 恰好是别人在用的时候。
 * 而且失效的方式不是报错，是**安静地跑到另一个目录里找同名文件**：
 * 找到就用错的，找不到就跳过，两条路都不吭声。
 *
 * 判法三件套（少一条就会退化成噪声或假绿）：
 *   ① **先剥注释再扫** —— 注释里写 `C:\…` 讲「这样不行」不是声明（同 坑 91）；
 *   ② **URL 不算** —— `https://` 里那个 `s:` 会被 `[A-Za-z]:[\\/]` 命中，
 *      所以盘符前面不许是字母数字（负向后顾）。这一条有自证样本盯着；
 *   ③ **工作区外面的东西要能豁免** —— 浏览器安装路径、slug 的测试向量，
 *      这些天生就该是绝对路径。豁免**写在那一行上**，不维护中央清单。
 *   ④ **盘符后面必须紧跟一个路径段，不能是空格/星号**（2026-09-18 补，第四种形态）——
 *      前三件套只认「注释」和「URL」，漏了**模板字符串里的散文**：
 *      `package.mjs` 那份便携版 README 里写着「解压到普通可写目录（桌面 / D:\ 都行）」，
 *      这里的 `D:\` 是**举例文字**，不是路径引用，却被报了 1 处故障。
 *      ⇒ 真正的路径引用写成 `D:\...` 时盘符后面一定有字（`<项目根>`），
 *        而散文里的盘符后面是空格。这条前瞻把两者分开，且**不影响**原有三条自证样本。
 *      ⚠️ 第一版前瞻写成 `(?=[^\s*\\/])`（把 `/` `\` 也排除）⇒ 自证当场报红：
 *        样本 `'C:\\Program Files\\a.exe'` 在正则眼里是 `C:` 后跟**一个** `\`，
 *        第二个反斜杠被我排除了 ⇒ 判成"不是路径"。**只排除空白和 `*`** 才对。
 *        （这条错误是 `ABS_SAMPLES` 挡下来的 —— 判据自证的价值就在这。）
 *      ⚠️ 已知代价（只漏报不误报）：只写盘符根（`'C:/'`）不再命中。
 *        本判据盯的是「工作区根」，那种写法必然带至少一层目录，故可接受。
 *
 * 已知边界（写清楚，不装完美）：同一行里字符串含 `//`（例如 URL）时，
 * 它后面会被当成注释截掉 —— 那只**漏报**不误报，且漏掉的只有
 * 「同一行既写 URL 又写盘符路径」这种极罕见写法。
 */
const ABS_SCAN = ['server', 'tools', 'web/js'];
const ABS_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?=[^\s*])/;
const ABS_EXEMPT = /工作区外面|外部路径|测试向量|本机工具链/;
/** [样本, 期望是否命中] —— 判代码之前必须先证明这条正则会响、且不误报 */
const ABS_SAMPLES = [
  ["fetch('https://example.com/a')", false],
  ["const ROOT = 'C:/Users/x/y';", true],                     // 测试向量
  ["const p = 'C:\\\\Program Files\\\\a.exe';", true],          // 测试向量
  // ★ 2026-09-18 第四种形态的负对照：模板字符串里的举例散文，不许算路径引用
  //   ⚠️ 这行自己必须带 `// 测试向量` —— 它的源码里就写着 `D:\\`，不带标记会被自己抓到（自指陷阱）
  ['`把整个文件夹解压到普通可写目录（桌面 / D:\\ 都行）`', false],  // 测试向量
];

/**
 * 按行剥掉注释，但**保留原始行号**（`stripComments` 会把行删掉，行号就对不上了）。
 * 同时保留**原始行**（`raw`）—— 因为豁免标记通常是行尾注释，
 * 而它恰恰会被剥注释这一步吃掉。
 * ⚠️ 第一版只看剥完的 `code` 去测豁免，于是 `…msedge.exe',  // 外部路径` 那一行的
 *    豁免标记**在判豁免之前就被自己剥掉了** ⇒ 4 处已声明的豁免全被报成故障。
 *    「豁免写在行尾」和「判据先剥行尾注释」这两件事，必须有一方让路：
 *    **找字面量看 `code`，判豁免看 `raw`。**
 */
function codeLines(src) {
  const out = [];
  let inBlock = false;
  src.split(/\r?\n/).forEach((raw, i) => {
    let j = 0;
    let res = '';
    while (j < raw.length) {
      if (inBlock) {
        const e = raw.indexOf('*/', j);
        if (e < 0) { j = raw.length; break; }
        inBlock = false; j = e + 2; continue;
      }
      const b = raw.indexOf('/*', j);
      const l = raw.indexOf('//', j);
      if (l >= 0 && (b < 0 || l < b)) { res += raw.slice(j, l); break; }
      if (b >= 0) { res += raw.slice(j, b); inBlock = true; j = b + 2; continue; }
      res += raw.slice(j); break;
    }
    out.push({ n: i + 1, code: res, raw });
  });
  return out;
}

async function checkAbsPaths(ROOT) {
  // ── 先给判据本身做体检 ──
  const wrong = ABS_SAMPLES.filter(([s, want]) => ABS_RE.test(s) !== want).map(([s]) => s);
  if (wrong.length) {
    return [mk(
      'prog.no-abs-paths', 'error', '判据自证失败，已停止判定',
      `正则口径不对，这些样本判反了：${wrong.join('、')}`,
      '先修 ABS_RE。**一条没被验证过的判据不许拿去判代码** —— 它只会把人派去修不存在的问题。',
    )];
  }

  const found = [];
  for (const rel of ABS_SCAN) {
    const stack = [path.join(ROOT, rel)];
    while (stack.length) {
      const dir = stack.pop();
      const names = await readdir(dir).catch(() => null);
      if (!names) continue;
      for (const n of names) {
        const abs = path.join(dir, n);
        const s = await statOf(abs);
        if (!s.exists) continue;
        if (s.size === 0 && !n.includes('.')) { stack.push(abs); continue; }   // 目录
        if (!/\.(mjs|js)$/.test(n) || s.size > 2 * 1024 * 1024) continue;
        const text = await readFile(abs, 'utf8').catch(() => null);
        if (text == null) continue;
        for (const { n: ln, code, raw } of codeLines(text)) {
          if (!ABS_RE.test(code)) continue;
          if (ABS_EXEMPT.test(raw)) continue;      // 行内自证豁免（看**原始行**，见 codeLines 的说明）
          found.push(`${path.relative(ROOT, abs).replace(/\\/g, '/')}:${ln}`);
        }
      }
    }
  }
  return [mk(
    'prog.no-abs-paths', found.length ? 'error' : 'ok',
    found.length ? `源码里有 ${found.length} 处写死的盘符绝对路径` : '源码里没有写死的绝对路径',
    found.length
      ? found.slice(0, 10).join('；') + (found.length > 10 ? ` …共 ${found.length} 处` : '')
      : `扫了 ${ABS_SCAN.join(' / ')}，没有 \`C:\\…\` 这类字面量。工作区改名或搬到别的机器都不会踩空。`,
    found.length
      ? '改成从模块自身位置推导：`path.resolve(path.dirname(fileURLToPath(import.meta.url)), \'..\')`。'
        + '确实要指向**工作区外面**的东西（浏览器安装路径等），就在那一行写上「外部路径 / 工作区外面」自证豁免。'
      : '无需处理。',
  )];
}

/**
 * 泛光核整定（坑 118 · 丙）的**接线**判据。
 *
 * ── 为什么需要 ─────────────────────────────────────────────────────────
 * 「丙」把出厂泛光核里那两级**近方框**核换成真高斯截断（保 σ、加抽头数），
 * 治的是用户报的「太阳是个大光球很难看」「银河系假爆了」那块方斑。
 * 它有一个很坏的失效形态：**删掉一行调用，画面退回方斑，页面照样能跑、不报任何错**。
 * 这类「改了不报错的修复」最怕被无声撤掉（同族：坑 122 的可选方法缺失、坑 123 的写在不存在属性上）。
 * 所以判据不能只放在代码里，要有**离线**的静态检查盯着。
 *
 * ── 这条判据**能**判什么、**不能**判什么（写清楚，不装完美）──
 * · 能判：接线还在（`engine.js` 既 import 了 `./bloom-kernel.js`、又真的调了 `retuneBloomKernel(`）。
 * · **不能判**：核在 GPU 里真的变了。那只有活页面能量 —— 归 `tools/probe-bloom-kernel.py`
 *   （打印「生产现状」表：活页面 K vs 出厂 K vs σ 相对差）与
 *   `tools/check-bloom-kernel.mjs`（离线核数学 9 条 + 判据自证 6 条）管。
 *   ⚠️ **别把这条静态检查当成"丙 生效了"的证据** —— 那是本文件反复记的两件事。
 *
 * ⚠️ **必须先剥注释再判**：把调用注释掉是一种很自然的「临时关掉」写法，
 *    拿原始行去正则的话，注释里那个调用会被算成接线还在 ⇒ **假绿**。
 */
const BLOOM_IMPORT_RE = /from\s*['"]\.\/bloom-kernel\.js['"]/;
const BLOOM_CALL_RE = /\bretuneBloomKernel\s*\(/;
/** 行内自证豁免：整体撤下这个修复**必须写出来**，不能悄悄删（同 prog.no-abs-paths 的豁免哲学） */
const BLOOM_REVERT_RE = /有意撤下|暂时撤下|有意回退|故意撤下/;

async function checkBloomKernelWiring(ROOT) {
  const modRel = 'web/js/core/bloom-kernel.js';
  const engRel = 'web/js/core/engine.js';
  const mod = await statOf(path.join(ROOT, modRel));
  const eng = await readFile(path.join(ROOT, engRel), 'utf8').catch(() => null);
  if (eng == null) {
    return [mk('shell.bloom-kernel', 'error', '读不到引擎源码',
      `${engRel} 不存在或读不出来`, '先把引擎源码恢复。')];
  }
  if (!mod.exists) {
    // 模块整个不在了 ⇒ 要么是有意撤下（那就得写出来），要么是误删。
    return [mk('shell.bloom-kernel', 'warn', '泛光核整定模块不在',
      `${modRel} 不存在 —— 「丙」已被整体撤下，方斑（坑 118）会回来`,
      `若是有意的，在 engine.js 里那次调用旁写上「有意撤下」自证豁免；`
      + '否则把模块与接线一起恢复。')];
  }

  const lines = codeLines(eng);
  const imp = lines.find((l) => BLOOM_IMPORT_RE.test(l.code));
  const call = lines.find((l) => BLOOM_CALL_RE.test(l.code));
  const mentionedRaw = lines.find((l) => /bloom-kernel|retuneBloomKernel/.test(l.raw));

  // 出现了、但剥完注释就没了 ⇒ 分辨不了「被注释掉了」与「正则过期了」。
  // 分辨不了就**不许下结论**（这正是本项目的口径：判据自己算错方向比判据不响更坏）。
  if (!imp && !call && mentionedRaw) {
    const reverted = BLOOM_REVERT_RE.test(mentionedRaw.raw);
    return [mk('shell.bloom-kernel', reverted ? 'warn' : 'error',
      reverted ? '丙 已被有声明地撤下' : '接线不见了（被注释掉？还是判据过期？）',
      `${engRel}:${mentionedRaw.n} 提到 bloom-kernel / retuneBloomKernel，但**剥掉注释后**`
      + `没有可用的 import 或调用：「${mentionedRaw.code.trim() || '（整行都在注释里）'}」`,
      reverted
        ? '已按声明豁免。注意方斑（坑 118）会回来 —— 恢复时把那次调用放回 `_createComposer()` 里。'
        : '两种可能：① 有人把接线注释掉了（方斑会静默回来）—— 这是更可能的那种；'
          + '② 接线换了写法让正则过期了 —— 那就先修 BLOOM_IMPORT_RE / BLOOM_CALL_RE。'
          + '**一条没被验证过的判据不许拿去判代码**，所以这里不猜。')];
  }
  if (!imp || !call) {
    return [mk('shell.bloom-kernel', 'error', '泛光核整定的接线不完整',
      `接线不完整：${imp ? '有 import' : '**缺 import**'} · ${call ? '有调用' : '**缺 retuneBloomKernel() 调用**'}`,
      `两者缺一不可（只见 import 不调用 = 整定从没跑过）。接线位置在 `
      + `${engRel} 的 \`_createComposer()\` 里、构造 UnrealBloomPass 之后 —— `
      + '写在别处的话，切一次显卡偏好（`_createComposer()` 会被再调一次）这个修复就没了。')];
  }
  return [mk('shell.bloom-kernel', 'ok', '泛光核整定（丙）接线在位',
    `import 在 ${engRel}:${imp.n}、调用在 :${call.n}`,
    '无需处理。⚠️ 这条只证明**接线在**，不证明**核真的变了** —— '
    + '要后者请跑 tools/probe-bloom-kernel.py（看「生产现状」表里的活页面 K）。')];
}

/* ── 「轨道」开关：空实现是静默故障的典型形态（坑 130）─────────────────────
 * 用户报「邻近恒星系：很多恒星系带行星轨道或意义不明的光环」，其中一半是**关不掉**：
 * 底栏有「轨道」开关、tooltip 写着「显示轨道线」，而它在邻近层是 `setOrbitsVisible() {}`
 * —— 一行空实现。它不报错、不影响运行，只在用户按下开关时**什么都不发生**，
 * 于是那些「有行星」的青色圆环只能被理解成「意义不明的光环」。
 *
 * 本判据**能**判两件事：
 *   · 每一层的 `setOrbitsVisible` 要么有实体、要么**写了理由**（行内自证豁免，同 prog.no-abs-paths）；
 *   · 建了 `ExoplanetRenderer` 的层，开关必须**接到它身上**（否则关了开关，走近恒星又冒出轨道线）。
 * 本判据**不能**判：按下去那一刻屏幕真的变了没 —— 那归活页面探针。
 * ⚠️ 必须先剥注释再判（`codeLines`）：拿原始行去正则，注释里写一行示例就能骗它假绿。
 */
const ORBITS_EMPTY_RE = /setOrbitsVisible\s*\([^)]*\)\s*\{\s*\}/;
/** 行内自证豁免：本层真的没有轨道可管，**必须写出来** */
const ORBITS_REASON_RE = /本层没有轨道|没有行星轨道|无轨道|有意留空|有意不实现|无需实现|no orbits/i;

async function checkOrbitsSwitch(ROOT) {
  const dir = path.join(ROOT, 'web/js/levels');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.js')).sort();
  if (files.length === 0) {
    return [mk('shell.orbits-switch', 'warn', '找不到层级目录', `${dir} 读不出来或为空`, '确认 web/js/levels/ 是否还在。')];
  }
  const silent = [];    // 空实现、也没写理由 ⇒ 哑开关
  const unwired = [];   // 建了系外行星渲染器，却没把开关接过去
  const excused = [];   // 空实现 + 写了理由
  let seen = 0;
  for (const f of files) {
    const rel = `web/js/levels/${f}`;
    const src = await readFile(path.join(ROOT, rel), 'utf8').catch(() => null);
    if (src == null) continue;
    const lines = codeLines(src);
    const decls = lines.filter((l) => /setOrbitsVisible\s*\(/.test(l.code) || /setOrbitsVisible\s*\(/.test(l.raw));
    if (decls.length === 0) continue;
    seen += decls.length;
    for (const e of lines.filter((l) => ORBITS_EMPTY_RE.test(l.code))) {
      // 豁免看**原始行与它上面 3 行** —— 理由通常是一条注释，会被 codeLines 剥掉
      const around = lines.filter((l) => l.n >= e.n - 3 && l.n <= e.n).map((l) => l.raw).join('\n');
      (ORBITS_REASON_RE.test(around) ? excused : silent).push(`${rel}:${e.n}`);
    }
    const buildsExo = /new\s+ExoplanetRenderer/.test(src);
    const wired = /exoRenderer\??\.setOrbitsVisible\s*\(/.test(src);
    if (buildsExo && !wired) unwired.push(rel);
  }
  const problems = [...silent.map((s) => `${s}（空实现、没写理由）`), ...unwired.map((u) => `${u}（没接到 exoRenderer）`)];
  if (problems.length) {
    return [mk('shell.orbits-switch', 'error',
      problems.length > 1 ? `${problems.length} 层的「轨道」开关是哑的` : '「轨道」开关在某层是哑的',
      `出问题的层：${problems.join(' · ')}（共扫到 ${seen} 处声明）`,
      '空实现不报错、也不影响运行，只在用户按下开关时什么都没发生 —— 这正是「静默故障」。'
      + '要么把开关接到该管的东西上；要么在那一行上方写明「本层没有轨道」之类的理由自证豁免。'
      + '⚠️ 写了理由就**不该**再报：豁免靠行内自证，不维护中央清单。')];
  }
  return [mk('shell.orbits-switch', 'ok', '「轨道」开关每层都有着落',
    `扫到 ${seen} 处声明 · 空实现但已自证豁免的 ${excused.length} 处${excused.length ? `（${excused.join('、')}）` : ''}`,
    '无需处理。⚠️ 这条只证明**接线在**，不证明**按下去屏幕变了** —— 后者要活页面探针。')];
}

/**
 * 盘面贴图必须做**外缘渐隐**（程序骨架 · 静态约定）。
 *
 * 用户原话：「这个旋臂依旧差点意思，而且**边缘没有淡出效果**」。
 * 根因是同一个文件里**两张盘面贴图口径不一致**：
 *   · `makeMilkyWayDiskTexture` 末尾有 `destination-in` 的径向渐隐（注释写着「免得圆盘露出硬边」）；
 *   · `makeGalaxyTexture`（远景星系 / 本星系群成员用的那张）**没有** ⇒ 盘边一刀切。
 * 这不是"没做"，是**做了一半就换了个人**——所以判据要把这条不变量钉在**两张**上。
 *
 * ⚠️ **为什么这条只能在源码级判、不能靠读像素**（试过，是假绿）：
 *    盘面外缘的 alpha 下降**分不清**「贴图级的 destination-in 渐隐」与
 *    「旋臂自己的末端渐隐」——而后者是**必需**的一步（坑 98：末端不渐隐的臂会封口成环），
 *    它同样把外缘 alpha 压下去。把 `destination-in` 整段删掉，读像素那条判据照样绿。
 *    ⇒ 「这一步在不在」在源码级判；「看起来对不对」归活页面探针 + 目检。
 *
 * ⚠️ 必须先剥注释：注释里写一句示例就能骗它假绿（见 `stripComments` 的说明）。
 * ⚠️ 必须**逐个函数体**判，不能在整文件里找 `destination-in` ——
 *    否则 `makeGalaxyTexture` 缺了这一步，也会被 `makeMilkyWayDiskTexture` 的那一步**顶绿**。
 */
const DISC_TEX_FNS = ['makeGalaxyTexture', 'makeMilkyWayDiskTexture'];
/** 外缘渐隐的唯一实现 —— 两张盘面贴图都调它。**不变量只留一处代码**，
 *  这样「谁漏了」这类漂移从结构上就不可能再发生。 */
const FADE_HELPER = 'fadeDiscEdge';

/** 从剥完注释的源码里取出一个具名函数的**函数体**（含花括号）。取不到返回 null。
 *
 * ⚠️ **不能拿「第一个 `{`」当函数体的开头** —— 第一版就是这么写的，结果取到的是
 *    **解构形参**：这两个函数的签名是 `function makeX({ a = 1, b = 2 } = {}) {`，
 *    第一个 `{` 是形参对象、紧跟的 `}` 就是它的收尾 ⇒ 取出来的"函数体"里
 *    **一个 `destination-in` 都没有**，于是判据连 `makeMilkyWayDiskTexture`
 *    （明明有渐隐）一起报成故障 —— 一次**假警**。
 *    抓到它的方式是：**拿已知正确的参考实现当控制组**，控制组报红 ⇒ 判据错，不是代码错。
 *    正确做法：先配对形参表的 `)`，再取它后面第一个 `{`。
 */
function fnBodyOf(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  // ① 配对形参表：从 `(` 开始数括号深度
  let i = m.index + m[0].length - 1;      // 停在 '('
  let pd = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') pd++;
    else if (c === ')') { pd--; if (pd === 0) { i++; break; } }
  }
  // ② 形参表之后第一个 `{` 才是函数体
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return null;
}

async function checkDiscEdgeFade(ROOT) {
  const rel = 'web/js/proc/textures.js';
  let src = null;
  try { src = stripComments(await readFile(path.join(ROOT, rel), 'utf8')); } catch { /* 下面统一报 */ }
  if (src == null) {
    return [mk('textures.disc-edge-fade', 'warn', '读不到盘面贴图模块', `${rel} 读不出来`,
      '确认文件在、编码 UTF-8。文件被移走时这条检查失去意义，所以按 warn 报出来而不是跳过。')];
  }
  /* 不变量收敛成**一份实现** `fadeDiscEdge` + 两个调用点（2026-09-12 重构）。
   * 原来两张贴图各写一份渐隐，而其中一份漏了 —— 所以判据要同时钉住
   * 「那一份实体里有这一步」与「两张贴图都真的调它」。 */
  const bad = [];
  const undecided = [];
  const helper = fnBodyOf(src, FADE_HELPER);
  if (!helper) undecided.push(`${FADE_HELPER}（找不到，或花括号没配上）`);
  else if (new RegExp(`function\\s+\\w+\\s*\\(`).test(helper.replace(/^\s*\{/, ''))) {
    // 函数体里又出现 `function xxx(` ⇒ 配对跑过头了，这次不下结论
    undecided.push(`${FADE_HELPER}（函数体配对跑过头）`);
  } else if (!/destination-in/.test(helper) || !/createRadialGradient/.test(helper)) {
    bad.push(`${FADE_HELPER}（${rel}）里没有 destination-in 的径向渐隐`);
  }
  for (const fn of DISC_TEX_FNS) {
    const body = fnBodyOf(src, fn);
    if (!body) { undecided.push(`${fn}（找不到函数体，或花括号没配上）`); continue; }
    if (!new RegExp(`${FADE_HELPER}\\s*\\(`).test(body)) {
      bad.push(`${fn} 没有调用 ${FADE_HELPER}`);
    }
  }
  if (undecided.length) {
    // 分辨不了就**不许下结论**（判据自己算错方向比判据不响更坏）
    return [mk('textures.disc-edge-fade', 'warn', '盘面贴图外缘渐隐：本次判不了',
      `${undecided.join('；')} —— 源码结构变了，判据没跟上。`,
      `看一眼 ${rel} 里 ${FADE_HELPER} 与这两个函数是否改名/被拆；`
      + '确认后同步更新 selfcheck 里的 DISC_TEX_FNS / FADE_HELPER。'
      + '在有结论之前**不要**把它当成「已通过」。')];
  }
  const names = DISC_TEX_FNS.join(' / ');
  return [mk('textures.disc-edge-fade', bad.length ? 'warn' : 'ok',
    bad.length ? `${bad.length} 处盘面外缘渐隐缺失` : '盘面贴图都有外缘渐隐',
    bad.length
      ? `${bad.join('；')} —— 缺这一步，盘边会是一圈一刀切的硬边。`
      : `${FADE_HELPER} 里有 destination-in 径向渐隐，${names} 两张都调了它。`,
    bad.length
      ? `把 ${FADE_HELPER} 里那一步补回来（g.globalCompositeOperation = 'destination-in' + `
        + 'createRadialGradient 从盘半径 ~0.68 倍渐隐到盘半径），并确认两张贴图都调它。'
        + '⚠️ 判据只认「这一步在不在」；看起来对不对要活页面探针 tools/probe-galaxy-disc.py + 目检。'
      : '无需处理。⚠️ 这条是源码级判据，只证明渐隐这一步在，不证明视觉上的观感。')];
}

/**
 * 有头浏览器探针是否都带了「防遮挡」开关（坑 136 / 坑 149）。
 *
 * ⚠️ **判定逻辑不在本文件里** —— 它来自 `tools/check-occlusion-args.mjs` 的 `runChecks()`，
 * 与命令行 `node tools/check-occlusion-args.mjs` 用的是同一份。
 * 同一个不变量两份实现，必漏一份（坑 131）。
 *
 * 分级口径：这条**不影响程序运行**，只影响开发期跑探针会不会莫名卡住
 * ⇒ 按 `warn` 处理，不报 `error`（把不影响使用的事判成故障，会训练人忽略自检）。
 */
async function checkProbeArgs(ROOT) {
  const ID = 'shell.probe-args';
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'tools', 'check-occlusion-args.mjs')).href);
  } catch (e) {
    // 「判据跑不起来」和「判据跑出来是坏的」不许用同一个标记 —— 否则会把人派去修不存在的故障。
    return [mk(ID, 'warn', '遮挡开关判据跑不起来',
      `import tools/check-occlusion-args.mjs 失败：${e.message}`,
      '这条只管「有头探针会不会卡住」，不影响程序本身。确认 tools/ 目录还在、该文件没被删。')];
  }

  let r;
  try {
    r = mod.runChecks(mod.scanToolsDir(path.join(ROOT, 'tools')));
  } catch (e) {
    return [mk(ID, 'warn', '遮挡开关判据自己出错了',
      `runChecks() 抛异常：${e.message}`,
      `单独跑一次看细节：node tools/check-occlusion-args.mjs --selftest（自证 14 段断言）。`)];
  }

  if (!r.moduleHas) {
    return [mk(ID, 'warn', '遮挡开关的单点定义没了',
      'tools/browser_args.py 不存在，或里面没有 OCCLUSION_ARGS。',
      '这三个开关以前散在各处写死，结果 20 个有头探针只有 3 个真带了（坑 149）。'
      + '补回 tools/browser_args.py，或把这条判据一起改掉 —— 但别让它指着一个不存在的东西。')];
  }

  if (r.bad.length === 0) {
    return [mk(ID, 'ok', '有头浏览器探针都带了防遮挡开关',
      `${r.headed.length} 个有头探针全部走 tools/browser_args.py 的 OCCLUSION_ARGS；`
      + `另有 ${r.headless.length} 个无头探针不在管辖范围（无头没有「窗口被遮挡」这回事）。`,
      '无需处理。')];
  }

  return [mk(ID, 'warn', `${r.bad.length} 个有头探针没带防遮挡开关`,
    `出问题的：${r.bad.map((b) => b.name).join(' · ')}（共 ${r.headed.length} 个有头探针）`,
    '窗口被别的窗口盖住时 Chromium 会判降级（rAF 被节流 / 合成器不再出新帧），'
    + '症状是探针卡在「打开浏览器」之后一动不动、或截图假死，而读数只会偏慢'
    + '⇒ 看起来像「性能变差了」，会把人引去查显卡（坑 136）。'
    + '修法：`from browser_args import OCCLUSION_ARGS`，再把 `args=OCCLUSION_ARGS` 传进 launch。'
    + '这条只影响开发期探针、不影响程序运行，所以是「注意」不是「故障」。')];
}

async function checkSkeleton(ROOT) {
  const out = [];
  const missing = [];
  let worst = 'ok';
  for (const [rel, lv, why] of SKELETON) {
    if (await exists(path.join(ROOT, rel))) continue;
    missing.push(`${rel}（${why}）`);
    if (LEVEL_ORDER[lv] > LEVEL_ORDER[worst]) worst = lv;
  }
  out.push(mk(
    'shell.core-files', missing.length ? worst : 'ok',
    missing.length ? `缺失 ${missing.length} 个核心文件` : '核心文件齐全',
    missing.length ? missing.join('；') : `${SKELETON.length} 个核心文件都在。`,
    missing.length
      ? '从备份或发行包恢复这些文件；若是全新解压的目录，确认解压完整（别只拖了部分文件）。若只缺 package.json 而你是用便携版启动器运行的，可以忽略——但 npm 相关命令会不可用。'
      : '无需处理。',
  ));

  const missV = [];
  for (const [rel, lv, why] of VENDOR) {
    if (!(await exists(path.join(ROOT, rel)))) missV.push(`${rel}（${why}）`);
  }
  const addonDir = await dirCount('web/vendor/three/addons', ROOT);
  out.push(mk(
    'shell.vendor', missV.length ? 'error' : 'ok',
    missV.length ? `第三方前端库缺失 ${missV.length} 项` : '前端依赖库齐全',
    missV.length ? missV.join('；') : `three.js / astronomy-engine 都在${addonDir != null ? `，addons 目录 ${addonDir} 项` : ''}。`,
    missV.length
      ? '在项目根执行 npm install 重新拉依赖，再执行 node tools/package.mjs 把 vendor 目录补齐（vendor 是给免构建前端用的副本，不是 node_modules 软链）。'
      : '无需处理。',
  ));

  // scripts 引用的本地脚本必须真的存在——写错的 npm 命令是最典型的"看着成功其实什么都没做"
  const pkg = await readJson(path.join(ROOT, 'package.json'));
  if (!pkg.ok) {
    // 便携版发行包里**本来就不带** package.json（启动器直接调 runtime/node.exe，不走 npm）。
    // 把它判成 error，用户一解压就看到"故障"，自检自己先学会撒谎了。
    out.push(mk(
      'shell.scripts', pkg.missing ? 'warn' : 'error',
      pkg.missing ? '没有 package.json（便携版发行包正常如此）' : 'package.json 解析失败',
      pkg.missing
        ? 'npm 命令不可用，但这不影响使用——「启动小小宇宙.bat」直接调用包内运行时。'
        : pkg.err,
      pkg.missing
        ? '无需处理。想用 npm 命令的话，从源码仓库取回 package.json。'
        : '检查 package.json 是否被截断或写成非法 JSON。',
    ));
  } else {
    const bad = [];
    for (const [name, cmd] of Object.entries(pkg.data.scripts || {})) {
      const m = /(tools\/[\w.\-]+\.(?:mjs|py|js)|server\/[\w./\-]+\.mjs)/.exec(cmd);
      if (!m) continue;
      if (!(await exists(path.join(ROOT, m[1])))) bad.push(`npm run ${name} → ${m[1]}`);
    }
    out.push(mk(
      'shell.scripts', bad.length ? 'error' : 'ok',
      bad.length ? `package.json 有 ${bad.length} 条命令指向不存在的脚本` : 'npm 命令指向的脚本都存在',
      bad.length ? bad.join('；') : `${Object.keys(pkg.data.scripts || {}).length} 条 npm 命令全部指向真实文件。`,
      bad.length ? '改正 package.json 的 scripts 指向真实脚本文件名，或补写缺失的脚本。指向空气的命令会让你以为跑过了。（本项目的惯犯：verify / shot）' : '无需处理。',
    ));
  }

  out.push(...(await checkPointMaterials(ROOT)));
  out.push(...(await checkAbsPaths(ROOT)));
  out.push(...(await checkBloomKernelWiring(ROOT)));
  out.push(...(await checkOrbitsSwitch(ROOT)));
  out.push(...(await checkDiscEdgeFade(ROOT)));

  return out;
}

/**
 * 点云材质必须给贴图（程序骨架 · 静态约定）。
 *
 * `THREE.PointsMaterial` 不给 `map` 时用的是默认**方形**纹理——每个点被画成硬边方块，
 * 而不是圆点。这个坑在本项目**踩过两次**（`solar.js` 的奥尔特云、`supercluster.js` 的宇宙纤维结构），
 * 两次都是"该柔和的星点/纤维出现一堆方块"。它**不报错、不崩溃**，只是安静地难看，
 * 所以只能靠静态检查兜住，不能指望跑测试发现。
 *
 * 判法：扫 `web/js` 下所有 .js，定位每一处 `PointsMaterial(`，
 * 从实参的左花括号起做配对，取出整个材质对象字面量，再看里面有没有 `map:`。
 * **先剔掉注释再判**——注释里提到 map 不算数，否则会假通过
 * （`solar.js` 就有一行 `// 必须给 map：…` 的注释躺在材质字面量里）。
 * 传的不是对象字面量（例如传变量）时静态判不了，跳过而不误报。
 */
const POINTS_SCAN = 'web/js';

async function checkPointMaterials(ROOT) {
  const bad = [];
  let total = 0;

  async function walk(rel) {
    const entries = await readdir(path.join(ROOT, rel), { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) { await walk(child); continue; }
      if (!e.name.endsWith('.js')) continue;
      const text = await readFile(path.join(ROOT, child), 'utf8').catch(() => null);
      if (text == null) continue;

      const marker = /PointsMaterial\s*\(/g;
      let m;
      while ((m = marker.exec(text)) !== null) {
        const braceAt = text.indexOf('{', m.index + m[0].length);
        if (braceAt < 0) continue;
        let depth = 0;
        let end = -1;
        for (let i = braceAt; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        total++;
        const code = text
          .slice(braceAt, end + 1)
          .replace(/\/\/[^\n]*/g, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        if (/\bmap\s*:/.test(code)) continue;
        bad.push(`${child}:${text.slice(0, m.index).split(/\r?\n/).length}`);
      }
    }
  }
  await walk(POINTS_SCAN);

  return [mk(
    'shell.point-materials', bad.length ? 'error' : 'ok',
    bad.length ? `${bad.length} 处点云材质没给 map` : '点云材质都给了 map',
    bad.length
      ? `${bad.join('；')}——这些点会被渲染成硬边方块，而不是圆点。`
      : `扫过 ${POINTS_SCAN}，${total} 处 PointsMaterial 都传了 map。`,
    bad.length
      ? '给这些 PointsMaterial 补上 map（如 map: makeGlowTexture(...) / makeStarTexture(...)）。缺贴图的点云不会报错，只是安静地画成方块，不看渲染很难发现。'
      : '无需处理。',
  )];
}

/* ============================================================
   程序骨架 · 前端数据模型（在 node 里真跑一遍）
   ============================================================ */

/**
 * 前端数据模型能不能在**没有浏览器**的环境里装配出来，且装配结果自洽。
 *
 * 为什么值得单独一条：目录面板的「包含关系」不是写死的，是**算出来的** ——
 * `dataset.js` 在建完目录树后，用 `TIER_OF` 把 13 个顶层分组归属到六个尺度。
 * 这个映射漏一个分组，界面上的表现只是**多出一节「未归入尺度」**：
 * 不报错、不崩溃、不影响其它功能，只是安静地少了一节。
 * 靠人眼在六节里发现「多出来的一节」很难，所以判据要写进代码：
 * **`catalogUntiered` 必须恒为空**；非空 = `TIER_OF` 漏了分组。
 *
 * 同一个坑在本项目出现过两次（`!DEEP_TYPE_LABEL` vs `!isCataloged`），
 * 两次都是「判定口径不一致导致整类天体静默消失」。所以这里连天体条数与
 * 系外行星的接入（独立天体 / 目录叶子数 / id 不重名 / 带 hostId）一起断言。
 *
 * **为什么走子进程**（这条很重要，别改回 in-process import）：
 * ESM 的 `import()` 按 URL 缓存。同一个进程里第二次跑自检，读到的还是第一次那份旧模块 ——
 * 改了磁盘上的 `dataset.js`，答案是旧的那份，而两边都报「通过」。
 * 这正是「改了磁盘上的代码 ≠ 运行中的进程会生效」。子进程 = 每次新的模块缓存，
 * 从根上免掉这一类假绿。
 *
 * ⚠ 这条检查**只读、不改磁盘**（故障注入在 `model-probe.mjs --selftest` 里，那条绝不后台跑）。
 */
async function checkFrontendModel(ROOT) {
  const probe = path.join(ROOT, 'tools', 'model-probe.mjs');
  if (!(await exists(probe))) {
    return [mk('shell.model', 'warn', '没有前端数据模型探针',
      `找不到 ${path.relative(ROOT, probe)}，跳过「目录树尺度归属」与「系外行星接入」两条断言。`,
      '从备份或发行包恢复 tools/model-probe.mjs。缺了它，目录树少一节、系外行星消失这类静默故障就没人看着了。')];
  }

  // ⚠️ 走 runCapture（落临时文件）而不是 `execFileSync(...,{encoding:'utf8'})`：
  //    后者要建管道，本机不给建 ⇒ EBUSY ⇒ 这条断言长期"跑不起来"（实测 12/12）。
  const cap = runCapture(process.execPath, [probe, '--json'], { cwd: ROOT, timeout: 60000 });
  let obs = salvageJson(cap);
  let err = obs ? null : cap.err;

  if (!obs) {
    return [mk('shell.model', 'error', '前端数据模型探针跑不起来',
      errText(err),
      '手动跑一次 node tools/model-probe.mjs --human 看完整报错。常见原因：web/js/data/*.js 有语法错误或 import 路径写错。')];
  }

  const out = [];
  const modelBad = obs.modelBad || [];
  const exoBad = obs.exoBad || [];
  const scaleIds = obs.scaleIds || [];

  out.push(mk(
    'shell.model', modelBad.length ? 'error' : 'ok',
    modelBad.length ? `目录树的尺度归属有问题（${modelBad.length} 处）` : `目录树 ${obs.treeCount} 个顶层分组全部归入 ${scaleIds.length} 个尺度`,
    modelBad.length ? modelBad.join('；') : `天体 ${obs.bodies} 个；尺度分节 ${(obs.tiers || []).length} 个（应 ${scaleIds.length} 个）。`,
    modelBad.length
      ? '改 web/js/data/dataset.js 里的 TIER_OF：它把每个顶层分组的 id 映射到尺度 id（solar / neighborhood / galaxy / localgroup / supercluster / universe）。新增顶层分组时**必须同时**加一行映射，否则界面上会多出一节「未归入尺度」。改完跑 node tools/model-probe.mjs --human 复核。'
      : '无需处理。',
  ));

  out.push(mk(
    'shell.exo-planets', exoBad.length ? 'error' : 'ok',
    exoBad.length ? `系外行星接入有问题（${exoBad.length} 处）` : `${obs.exo} 颗系外行星已成独立天体，目录里都摸得到`,
    exoBad.length ? exoBad.join('；')
      // ⚠️ 措辞要带上「露出 / 藏起」两个数：目录按系统截断是**有意**的，
      //    只报一个 6332 会让人以为目录里有 6332 行。
      : `${obs.exoHostsCreated} 个宿主恒星由系外行星星表补建（重名 ${obs.exoPlanetDupe} 个）；`
        + `目录露出 ${obs.exoLeaves} 颗，另有 ${obs.exoHidden ?? 0} 颗由「显示全部」/检索兜住。`,
    exoBad.length
      ? '检查 web/js/data/dataset.js 的系外行星球化循环：id 走 slugId（只留 [a-z0-9-]，避免目录选中器语法错）、位置继承宿主星、必须带 hostId 与 hostStar（ExoplanetRenderer 以宿主星名为键，缺了就会「点了没反应」）。'
      : '无需处理。',
  ));

  const colorBad = obs.colorBad || [];
  out.push(mk(
    'shell.color-format', colorBad.length ? 'error' : 'ok',
    colorBad.length ? `${obs.colorBadCount} 个天体的 color 类型/格式不对` : 'color 字段的口径统一',
    colorBad.length ? colorBad.join('；')
      : `有 color 的 ${obs.bodies - obs.colorMissingCount} 个天体全是 #rrggbb；`
        + `另有 ${obs.colorMissingCount} 个未带该字段（恒星/深空/致密等目录型天体，颜色由各自渲染器按光谱型算，正常）。`,
    colorBad.length
      ? 'color 的口径是 #rrggbb。非 hex 字符串（如 rgb(...)）喂进 proc/textures.js 的 hexToRgb() 会被静默解析成 NaN、画出黑贴图；数字/对象则直接崩。改对应的颜色生产者（注意 starColorFromBV / tempToColor 已统一为 hex，别再改回 rgb）。'
      : '无需处理。',
  ));

  /* 目录完整性：截断有没有自证 / 有没有整批天体没进目录。
   *
   * 这条是补上的盲区：原先三条断言（尺度归属 / 系外行星 / color 形态）都只看
   * 「**已经在目录里**的东西对不对」，没有任何一条看「**该在目录里的东西在不在**」。
   * 于是「邻近层只 filter(type==='star')，597 个白矮星 + 62 个脉冲星整批没进目录」
   * 这种故障能一路全绿地活到用户面前（用户的原话：「黑洞之类的其他天体也没做进去」）。
   * 详见 tools/model-probe.mjs 的 (A)(B)(C) 三条判据。 */
  const truncBad = obs.truncBad || [];
  const conservationBad = obs.conservationBad || [];
  const silentBad = obs.silentBad || [];
  /* #4「吸纳率」是**往上游再退一步**的判据：
   *   前三条的舞台都在「数据 → 目录」，只有它管「**数据源 → 数据**」——
   *   系外行星表被抓取器砍到 758/6360 行、深空编目被一道星等门槛丢掉 10,507 条，
   *   这两件事前三条款一条都看不见（那时数据文件里就只有那么多，一切自洽）。
   * 详见 tools/model-probe.mjs 的 (D)。 */
  const ingestBad = obs.ingestBad || [];
  const sizeBad = [...silentBad, ...conservationBad, ...truncBad, ...ingestBad];
  const truncated = (obs.truncGroups || []).filter((g) => g.hidden > 0);
  out.push(mk(
    'shell.catalog-trunc', sizeBad.length ? 'error' : 'ok',
    sizeBad.length
      ? `目录完整性有问题（${sizeBad.length} 处：整批漏 ${silentBad.length} · 数量对不上 ${conservationBad.length}`
        + ` · 截断没说明 ${truncBad.length} · 少收没交代 ${ingestBad.length}）`
      : `目录完整性：数据里的天体要么在目录里，要么被如实标注为「只列前 N 条」（${truncated.length} 个分组被截断）`,
    sizeBad.length
      ? sizeBad.join('；')
      : truncated.map((g) => `${g.name}：列 ${g.shown}/${g.total}`).join('；') || '没有被截断的分组。',
    sizeBad.length
      ? '去 web/js/data/dataset.js：#1「整批漏」= CATALOG_GROUPS 少了一个类型条目（历史上两次：致密天体、galaxy 层的星系）；'
        + '#2「数量对不上」= 分组建表时被 pre-filter 掉了东西；#3「截断没说明」= capped() 的 note 被写空、'
        + '或 allIds 只有它承诺的一部分（「显示全部」点到底也翻不到剩下的）。'
        + '#4「少收没交代」= **数据源抓回的行数与产物落地数对不上**，'
        + '或**产物声明了几条、装配后却没有那么多个天体**：'
        + '去 tools/build-data.mjs（系外行星）、tools/build-deepsky.mjs（OpenNGC）、tools/fetch-compact.mjs（SIMBAD）看吸纳台账，'
        + '产物 meta 必须声明 fetchedRows 与各项 dropped*。'
        + '⚠️ 深空编目的 droppedUnknownType 非零**本身就是线索**：'
        + '那是上游新增了一个 TYPE_MAP 里没有的类型，整批天体正在被静默丢掉（Other/Nova 共 422 条就是这么挖出来的），'
        + '处理办法是在 build-deepsky.mjs 的 TYPE_MAP 里加映射，并在 dataset.js 的 CATALOG_GROUPS 里加承接分组。'
        + '改完跑 node tools/model-probe.mjs --human 复核，再跑 node tools/model-probe.mjs --selftest 确认这四条判据真的会响。'
      : '无需处理。',
  ));

  return out;
}

/**
 * 全局设置的分发范围 —— 回归锁。
 *
 * 2026-09-11 实测（tools/probe-truescale.py 的基线）：
 *   `engine.setOptions()` 把「真实比例」广播给**所有**层，而 `solar.setTrueScale()`
 *   无条件整层重建，于是**在别的尺度上拨这个开关，太阳系被白重建 200–250ms**。
 *   更坏的是 `rebuild()` 结尾那句 `engine._attachControls(this)`：它会把
 *   **全局唯一一份** OrbitControls 重新挂到太阳系相机上并 dispose 掉原来那份 ——
 *   当前层从此拖不动、转的是别的相机，**界面上没有任何报错**。
 *   基线读数：6 层里 5 层中招（只有"当前层就是太阳系"那层是对的）。
 *
 * ⚠️ **这条检查是静态标记，只保证那几处守卫还在，不保证行为正确。**
 *    行为判据在 `tools/probe-truescale.py`（要真浏览器，跑一次约 2 分钟，
 *    不适合塞进自检 —— 没人跑的检查等于没有检查）。
 *    所以这里报「通过」时别理解成「行为已验证」，两件事分开看。
 */
async function checkOptionScope(ROOT) {
  const out = [];
  const solarPath = path.join(ROOT, 'web', 'js', 'levels', 'solar.js');
  const enginePath = path.join(ROOT, 'web', 'js', 'core', 'engine.js');
  const probePath = path.join(ROOT, 'tools', 'probe-truescale.py');

  let solar = null;
  let engine = null;
  try { solar = stripComments(await readFile(solarPath, 'utf8')); } catch { /* 下面统一报 */ }
  try { engine = stripComments(await readFile(enginePath, 'utf8')); } catch { /* 同上 */ }

  if (!solar || !engine) {
    out.push(mk('ui.option-scope', 'error', '读不到层级/引擎源码',
      `${solar ? '' : 'web/js/levels/solar.js '}${engine ? '' : 'web/js/core/engine.js '}读不出来。`,
      '确认文件在工作区里、编码是 UTF-8。文件被移走时这条检查失去意义，所以按 error 处理而不是跳过。'));
    return out;
  }

  /* 四处守卫，各自挡一个具体的旧 bug。缺任何一个都说明这套机制被拆了。 */
  const marks = [
    ['延迟重建机制', /refreshIfStale\s*\(/, solar,
      'solar.js 里没有 refreshIfStale() —— 真实比例改成"只在被看见时重建"的机制没了，'
      + '于是每拨一次开关都会在别的尺度上白重建一遍太阳系（实测 200–250ms）。'],
    ['重建前判当前层', /wasCurrent/, solar,
      'solar.js::rebuild() 里没有 wasCurrent 判断 —— _attachControls 会被无条件调用，'
      + '把全局 OrbitControls 从当前层偷到太阳系相机上（当前层从此拖不动，且无报错）。'],
    ['控制器归属守卫', /if\s*\(\s*wasCurrent\s*\)/, solar,
      'solar.js::rebuild() 里那行 _attachControls 没有用 wasCurrent 守住。'],
    ['引擎侧补重建', /refreshIfStale\?\.\s*\(\)/, engine,
      'engine.js::goTo() 没有调 refreshIfStale?.() —— 欠着的那次重建永远不会补上，'
      + '而 solar.js 又不再立即重建 ⇒ 真实比例开关会**静默失效**（比卡顿更坏）。'],
    ['重建计数器', /this\.rebuilds/, solar,
      'solar.rebuilds 计数器没了 —— tools/probe-truescale.py 的判据 A 靠它读"重建了几次"，'
      + '缺了它探针会判失败退出（它是刻意的 fail-closed：计数器没了，判据会恒等于 0 而假报合规）。'],
  ];

  const missing = marks.filter(([, re, src]) => !re.test(src));
  out.push(mk(
    'ui.option-scope', missing.length ? 'error' : 'ok',
    missing.length
      ? `全局设置的分发守卫缺了 ${missing.length} 处`
      : '全局设置只作用在需要的层上（四处守卫齐全）',
    missing.length
      ? missing.map(([name, , , why]) => `${name}：${why}`).join(' / ')
      : '实测读数（2026-09-11 修复后）：非太阳系层拨「真实比例」耗时 0ms、太阳系重建 0 次、'
        + '控制器始终留在当前层；太阳系层本身重建 2 次（开+关各一次，这是必要的整层重建）。',
    missing.length
      ? '照着 tools/probe-truescale.py 顶部注释里的四处守卫补回来：'
        + '① solar.js::setTrueScale 只在本层是当前层时重建，否则打 _scaleStale；'
        + '② solar.js::refreshIfStale() 在切进本层时补重建（build() 里要清 _scaleStale）；'
        + '③ solar.js::rebuild() 用 wasCurrent 守住 _attachControls；'
        + '④ engine.js::goTo 在 else 分支调 target.refreshIfStale?.()（放 else 里，否则会刚 build 完又 rebuild）。'
        + '补完跑 py -3.13 -X utf8 tools/probe-truescale.py --selftest 复核。'
      : '无需处理。',
  ));

  if (!(await exists(probePath))) {
    out.push(mk('ui.option-scope-probe', 'warn', '没有真实比例探针',
      '找不到 tools/probe-truescale.py。上面那条只是**静态标记**，'
      + '缺了探针就等于这两条真实故障（白重建 / 控制器被偷）没有任何行为判据看着。',
      '从备份或发行包恢复 tools/probe-truescale.py。它自带 --selftest，'
      + '会先确认基线是绿的、再注入故障验证三条判据真的会响。'));
  }

  return out;
}

/**
 * 文档锚点还指得到东西吗？
 *
 * 维修手册的主用法就是「按症状查」，症状索引那一列全是 `[S23](#s23-...)`。
 * 标题改一个字（把「（」换成「(」、把「 / 」改成「/」），链接就断在那里 ——
 * 点下去哪儿也不去，**页面上什么提示都没有**。静默失效的典范。
 *
 * ⚠️ **分级是 warn，不是 error。** 坏锚点不影响任何功能，只影响"手册好不好翻"。
 *    把不影响使用的事判成故障，等于训练用户忽略自检。
 *
 * ⚠️ 这个检查背后那个脚本的第一版**把 11 条正确的链接报成了坏的** ——
 *    它的 slug 口径只剥 ASCII 标点，而 GitHub 的 slugger 连 `「」（）、` 一起剥。
 *    所以那条脚本必须**先自证口径**（已知对照 + 必拒反例），口径不对就直接退出。
 *    这里连 `--selftest` 一起跑，就是为了不让一个口径算反的检查来"报故障"。
 */
async function checkDocAnchors(ROOT) {
  const tool = path.join(ROOT, 'tools', 'check-doc-anchors.mjs');
  if (!(await exists(tool))) {
    return [mk('shell.doc-anchors', 'warn', '没有文档锚点检查脚本',
      '找不到 tools/check-doc-anchors.mjs，手册里的锚点链接没人看着。',
      '从备份或发行包恢复它。跑 node tools/check-doc-anchors.mjs --selftest 复核。')];
  }

  const cap = runCapture(process.execPath, [tool, '--json', '--selftest'], { cwd: ROOT, timeout: 30000 });
  let obs = salvageJson(cap);
  let err = obs ? null : cap.err;

  if (!obs) {
    return [mk('shell.doc-anchors', 'warn', '文档锚点检查跑不起来',
      errText(err),
      '手动跑一次 node tools/check-doc-anchors.mjs --selftest 看完整报错。')];
  }

  const bad = obs.problems || [];
  return [mk(
    'shell.doc-anchors', bad.length ? 'warn' : 'ok',
    bad.length ? `${bad.length} 个文档锚点指不到东西` : `${obs.links} 个文档锚点全部可解析`,
    bad.length ? bad.slice(0, 6).map((p) => `${p.file}：${p.why}`).join('；') : `${obs.files} 个 .md 文件。`,
    bad.length
      ? '改标题就去更新链接，或反过来。⚠️ **别反过来"照判据改链接"**——'
        + '这条检查的脚本第一版就因为 slug 口径算错（只剥 ASCII 标点），'
        + '把 11 条**正确**的链接报成坏的。先跑 node tools/check-doc-anchors.mjs --selftest '
        + '确认口径自证通过，再动手。'
      : '无需处理。',
  )];
}

/**
 * 文档里的指针还指得到东西吗？—— 编号引用（`坑 N` / `第 N 轮`）、
 * 小节结构，**以及链接目标文件**（`](x.md)`）。
 *
 * 锚点检查只管**标题锚点**（`[S25](#s25-...)`），管不了编号引用 —— 于是本项目在**同一天里**
 * 连踩四次「指针指向空气」：坑 21 **有正文没标题**（四处引用全指向不存在的编号）；
 * 坑 71–76 **各有两个正文**（同一个号指两件事）；「见第 20 轮」写在第 20 轮还不存在时；
 * 「第 17 轮」被引用三次而从来没写。**断了的指针页面上什么都不显示。**
 *
 * ⚠️ **分级是 warn，不是 error** —— 和锚点同理：不影响任何功能，只影响"手册翻不翻得动"。
 *    把不影响使用的事判成故障，等于训练用户忽略自检。
 *
 * ⚠️ 脚本必须**先自证口径**（15 个用例含 8 处注入），因为它的第一版就被自己的断言冤枉过：
 *    拿 `ref.endsWith('4')` 去判「坑 2–5 缺 4、5」，而工具正确报的是 `坑 4–5`（以 5 结尾）。
 *    **断言的写法自己也会算错方向**，口径不对就直接退出、绝不下判定。
 *
 * 第四类（链接目标）是 2026-09-26 补的：前三类管的是**页内**指针，管不了 `](x.md)`
 * 指向的那个**文件**。断的时候比锚点还安静 —— `自检维修手册.md` 三处 `../坑与雷点.md`
 * 在文件系统里是 404，而在应用内的 URL 空间里 `..` 到根就停、**看着是好的**，
 * 实测静默 ≥ 3 个月（见 `坑与雷点.md` 坑 160）。
 */
async function checkDocRefs(ROOT) {
  const tool = path.join(ROOT, 'tools', 'check-refs.mjs');
  if (!(await exists(tool))) {
    return [mk('shell.doc-refs', 'warn', '没有编号引用检查脚本',
      '找不到 tools/check-refs.mjs，`坑 N` / `第 N 轮` 这类引用没人看着。',
      '从备份或发行包恢复它。跑 node tools/check-refs.mjs --selftest 复核。')];
  }

  // ⚠️ 第一版这里写过「重试一次」，理由是把它误当成了环境态失败。**那个归因是错的** ——
  //    同一现象连跑 5 次复现后查清了：第二条"注意"来自**内存检查**
  //    （「可用物理内存低于 800 MB」，本机实测 671–771 MB），与本脚本毫无关系。
  //    教训：**自检的"注意"条数不是常量**（随系统可用内存浮动），
  //    所以「27 通过 / 1 注意」这种数字**不能当判据、也不该写死在文档里**。
  //    无根据的重试 = 用更慢的手段盖住一个不存在的病，已经撤掉。
  //
  //    ⚠️⚠️ 2026-09-26 补记：**这次"跑不起来"另有真因，且是必然、不是偶发** ——
  //    原来那行 `execFileSync(...,{encoding:'utf8'})` 会**建管道**，而本机不给子进程建管道
  //    ⇒ 12/12 报 `spawnSync ... EBUSY`。所以它**不是**"环境态偶发失败"，
  //    也不该被"重试"盖 —— 换机制才对，见 server/lib/run-capture.mjs（落临时文件，12/12 正常）。
  const cap = runCapture(process.execPath, [tool, '--json', '--selftest'], { cwd: ROOT, timeout: 30000 });
  /* ⚠️ check-refs 找到悬空引用时是「退出码 1 + stdout 一份**完整可用的 JSON**」。
   *   不加这一段，自检就会把「**找到了 4 处悬空引用**」报成「**跑不起来**」，
   *   把人派去查工具而不是查引用 —— 这正是本项目的规矩：
   *   「服务死了」和「数据坏了」不能用同一个错误标记。
   *   ⇒ `salvageJson` 先抢救 stdout；抢不到（真空了）才算「跑不起来」。 */
  let obs = salvageJson(cap);
  let err = obs ? null : cap.err;

  if (!obs) {
    return [mk('shell.doc-refs', 'warn', '编号引用检查跑不起来',
      errText(err),
      '手动跑一次 node tools/check-refs.mjs --selftest 看完整报错。')];
  }
  if (obs.selftest && obs.selftest.fail > 0) {
    return [mk('shell.doc-refs', 'warn', '编号引用检查的口径自证没过',
      `自证 ${obs.selftest.pass}/${obs.selftest.total} —— 口径不对时它会报出一批假的"悬空"，`
      + '把人派去修不存在的编号（而且数字还极其具体）。',
      '先跑 node tools/check-refs.mjs --selftest 看是哪条断言挂了，修脚本本身，别去改文档。')];
  }
  const r = obs.result || {};
  if (r.refused) {
    return [mk('shell.doc-refs', 'warn', '编号引用检查拒绝判定',
      r.refused, '从备份或发行包恢复定义文件 `坑与雷点.md`（2026-09-26 文档合并后，'
      + '原《对话记录.md》的内容在它的**附录**里），再跑一次。')];
  }

  const bad = r.problems || [];
  return [mk(
    'shell.doc-refs',
    bad.length ? 'warn' : 'ok',
    bad.length
      ? `${bad.length} 处文档指针（编号引用 / 小节结构 / 链接目标）有问题`
      : `${r.refs} 处编号引用 + ${r.links} 处本地链接全部指得到东西`,
    bad.length
      ? bad.slice(0, 6).map((p) => `${p.file}:${p.line} ${p.ref}`).join('；')
      : `${r.files} 个顶层 .md、${r.headings} 个小节；悬空引用 / 重复编号 / 被写坏的标题 /`
        + ` 链接目标不在或越出项目根 各 0 处。`
        + (r.exempted ? `另有 ${r.exempted} 处自己声明了「还没写」，跳过。` : ''),
    bad.length
      ? '优先**补标题**（正文本来就有的话），其次改编号；'
        + '若报的是「链接悬空 / 链接越界」，**改链接**（`../x.md` → `x.md`），别建同名文件迁就它。'
        + '⚠️ 先确认那个编号是真的不存在，'
        + '而不是定义文件的标题格式没被认出来 —— 这条检查的脚本第一版就被自己的断言冤枉过。'
      : '无需处理。',
  )];
}

/* ============================================================
   检查组 3：数据集（现场读 + 登记表拷问）
   ============================================================ */

/** 从各数据集 meta 里取条目数；结构各不相同，做兼容。取不到就 null，不猜。 */
function recordsOf(j) {
  if (!j) return null;
  if (Array.isArray(j)) return j.length;
  const m = j.meta || {};
  for (const k of ['count', 'total']) if (typeof m[k] === 'number') return m[k];
  for (const k of ['objects', 'systems', 'rows', 'findings', 'candidates', 'overrides', 'bodies', 'gallery', 'files']) {
    const v = j[k];
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
  }
  return null;
}

async function checkDatasets(ROOT) {
  const out = [];
  const reg = await readJson(path.join(ROOT, 'data', 'sources.json'));
  if (!reg.ok) {
    out.push(mk('data.registry', 'error', '数据源登记表读不出来', reg.missing ? 'data/sources.json 不存在。' : reg.err,
      '恢复 data/sources.json（可从 dist 发行包或备份里取），或执行 node tools/fetch-assets.mjs 重建。'));
    return out;
  }
  const datasets = reg.data.datasets || [];
  const rawLib = await hasRawLibrary(ROOT);

  /* ---- 3.1 逐数据集：文件在不在 + 能不能解析 + 条目数 ---- */
  const rows = [];
  const broken = [];
  const rawMissing = [];
  const stale = [];
  let totalBytes = 0;

  for (const d of datasets) {
    const files = d.files || [];
    const miss = [];
    const missRaw = [];
    let bytes = 0;
    let latest = null;

    for (const rel of files) {
      // 原始素材库里的文件单独归类 —— 便携版不带它，见 isRawPath 上面的说明。
      const bucket = isRawPath(rel) ? missRaw : miss;
      if (rel.endsWith('/')) {
        const n = await dirCount(rel, ROOT);
        if (n == null || n === 0) bucket.push(`${rel}（目录为空或不存在）`);
        continue;
      }
      const s = await statOf(path.join(ROOT, rel));
      if (!s.exists) { bucket.push(rel); continue; }
      bytes += s.size;
      if (s.mtime && (!latest || s.mtime > latest)) latest = s.mtime;
    }
    totalBytes += bytes;
    if (missRaw.length) rawMissing.push(`${d.label}：${missRaw.length} 项（${missRaw[0]}${missRaw.length > 1 ? ' 等' : ''}）`);

    // 主数据文件必须能 JSON.parse——一个截断的 json 会让整个数据集静默消失
    let records = null;
    if (d.metaFile) {
      const j = await readJson(path.join(ROOT, d.metaFile));
      if (!j.ok) miss.push(`${d.metaFile}（${j.missing ? '不存在' : '解析失败：' + j.err}）`);
      else records = recordsOf(j.data);
    }

    rows.push({ id: d.id, label: d.label, mode: d.mode, cadence: d.cadence, files: files.length, bytes, latest, records });

    if (miss.length) broken.push(`${d.label}：${miss.join('、')}`);

    const cd = cadenceDays(d.cadence);
    if (cd != null && Number.isFinite(cd) && latest) {
      const days = Math.floor((Date.now() - latest.getTime()) / DAY);
      if (days > cd) stale.push(`${d.label}：${days} 天未更新（节奏「${d.cadence}」，阈值 ${cd} 天）`);
    }
  }

  out.push(mk(
    'data.files', broken.length ? 'error' : 'ok',
    broken.length ? `${broken.length} 个数据集的文件有问题` : `${datasets.length} 个数据集的声明文件都在`,
    broken.length ? broken.join('；') : `合计 ${(totalBytes / 1048576).toFixed(1)} MB。`,
    broken.length
      ? '在「数据更新中心」对对应管线点「立即更新」重抓重建；人工维护（curated）的表无法自动重抓，需手工补回 web/js/data/ 下的对应文件。'
      : '无需处理。',
  ));

  /* ---- 3.1b 原始素材库：单独一条，且**最高只 warn** ----
   *
   * 为什么要单列：便携版发行包有意不带 `data/raw/`（体积原因），
   * 而登记表里有两条管线声明的产出就在那儿。原先这两条缺失被算进 `data.files` 的
   * error 里，于是**便携包一装好、第一次跑自检就自报两个故障** ——
   * 正好犯了这个项目自己的忌（「交付物不许一装好就自报故障」）。
   *
   * 分级口径：原始素材缺失只影响「重跑数据管线」，**不影响使用**（成品数据都在包里）。
   * ⇒ 最高 warn。判断依据是现场（目录在不在），不是"我记得包里没有"。
   */
  if (!rawLib) {
    out.push(mk(
      'data.raw-assets', 'ok',
      '原始素材库不在这份安装里（便携版正常如此）',
      rawMissing.length
        ? `登记表里有 ${rawMissing.length} 个数据集声明了 data/raw/ 下的原始文件：${rawMissing.join('；')}。`
        : '登记表里没有声明 data/raw/ 下的文件。',
      '无需处理。原始素材（MBOSS 测光汇编、TIF 原图等，约 280 MB）只在「数据更新中心」重跑管线时用得到，'
      + '便携版有意不带。要重跑管线的话，从源码仓库或另一份完整安装里把 data/raw/ 拷过来即可。',
    ));
  } else if (rawMissing.length) {
    out.push(mk(
      'data.raw-assets', 'warn',
      `原始素材库不全（${rawMissing.length} 个数据集有缺失）`,
      rawMissing.join('；'),
      '这不影响查看与检索（成品数据都在）。只有「重跑对应管线」会失败。'
      + '用 node tools/fetch-assets.mjs 或对应的 fetch-* 脚本重新抓回原始素材。',
    ));
  } else {
    out.push(mk('data.raw-assets', 'ok', '原始素材库齐全', '登记表声明的 data/raw/ 文件都在。', '无需处理。'));
  }

  out.push(mk(
    'data.staleness', stale.length ? 'warn' : 'ok',
    stale.length ? `${stale.length} 个数据集超过自己的更新节奏` : '没有超期的数据集',
    stale.length ? stale.join('；') : '各数据集都在自己声明的节奏之内。',
    stale.length
      ? '这不是错误——数据还能用，只是可能落后于上游。到「数据更新中心」跑对应管线；卫星数与探测器任务状态属高频变动，值得优先。'
      : '无需处理。',
  ));

  /* ---- 3.2 拷问登记表：说的产出到底在不在 ---- */
  const pipes = reg.data.pipelines || [];
  const pipeIds = new Set(pipes.map((p) => p.id));
  const lies = [];
  // 豁免：`data/raw/` 下的产出，在这份安装根本没带原始素材库时不算「说谎」。
  // ⚠️ 豁免要**记数并说出口**（下面 detail 里会写"另 N 项…豁免"），
  //    静默跳过等于把「我不知道」当成「没问题」（见 MEMORY.md 的工程纪律）。
  const rawExempt = [];

  for (const p of pipes) {
    for (const o of p.outputs || []) {
      const p2 = path.join(ROOT, o);
      const okDir = o.endsWith('/') ? (await dirCount(o.replace(/\/$/, ''), ROOT)) : null;
      const ok = o.endsWith('/') ? (okDir != null && okDir > 0) : (await exists(p2));
      if (!ok) {
        if (isRawPath(o) && !rawLib) { rawExempt.push(o); continue; }
        lies.push(`管线「${p.label}」声明产出 ${o}，但盘上${o.endsWith('/') ? '目录为空或不存在' : '找不到'}`);
      }
    }
    for (const st of p.steps || []) {
      if (!st.bin) { lies.push(`管线「${p.label}」有一步没写 bin`); continue; }
      const f = path.join(ROOT, 'tools', `${st.bin}.mjs`);
      if (!(await exists(f))) lies.push(`管线「${p.label}」的步骤 ${st.bin} 找不到 tools/${st.bin}.mjs`);
    }
  }
  for (const d of datasets) {
    if (d.pipeline && !pipeIds.has(d.pipeline)) lies.push(`数据集「${d.label}」声明属于管线 ${d.pipeline}，但登记表里没有这条管线`);
  }

  out.push(mk(
    'data.registry-honesty', lies.length ? 'error' : 'ok',
    lies.length ? `登记表有 ${lies.length} 处与磁盘不符` : '登记表与磁盘一致',
    lies.length
      ? lies.join('；')
      : `核对过 ${pipes.length} 条管线的全部产出与 ${datasets.length} 个数据集的归属，都对得上。`
        + (rawExempt.length
          ? `另有 ${rawExempt.length} 项 data/raw/ 下的产出在这份安装里不存在 —— 原始素材库本来就没带，`
            + `不是登记表说谎（见 data.raw-assets）。`
          : ''),
    lies.length
      ? '改 data/sources.json 让它说实话：产出路径写真实目录（本项目踩过——真实影像库写成了 web/gallery/，实际在 web/images/），步骤名对应 tools/ 下的真实文件名。'
      : '无需处理。',
  ));

  /* ---- 3.4 管线步骤「跑得起来吗」：bin 必须在脚本白名单里 ----
     ⚠️ **「脚本文件存在」不等于「这条管线跑得起来」。**
        `runPipeline()` 执行前会先过一遍 datacenter.mjs 的 BIN_WHITELIST，
        不在表里就整条拒绝（报 BAD_STEP）。

        真实案例：`compact` 管线登记了 `fetch-compact`，tools/ 下的脚本也在，
        但白名单里漏了这个名字 ⇒ **「致密天体 · 星云」这条管线在界面上能点，
        一跑必失败**，黑洞/脉冲星/白矮星永远更新不了。
        而上面 3.2 那条只核对「文件在不在」，两张表就这样静默分叉了几个月。

        ⇒ 这条检查把「登记表」和「白名单」直接对撞。两处都必须真实：
           白名单是安全边界（不许为了过检查就删白名单），登记表是意图。

     ⚠️ 这里用 import() 读**进程内的**白名单，而不是重新读盘：
        这样报出的正是「此刻 runPipeline 真正会用的那一份」。
        CLI（node tools/selfcheck.mjs）本身是新进程，读到的就是磁盘真值。 */
  try {
    const dc = await import('./datacenter.mjs');
    const bins = dc.BIN_WHITELIST;
    if (!(bins instanceof Set)) throw new Error('datacenter.mjs 没有导出 BIN_WHITELIST（或类型不是 Set）');
    const off = [];
    for (const p of pipes) {
      for (const st of p.steps || []) {
        if (st.bin && !bins.has(st.bin)) {
          off.push(`管线「${p.label}」的步骤 ${st.bin} 不在白名单里（该管线一跑就报 BAD_STEP）`);
        }
      }
    }
    out.push(mk(
      'data.pipeline-bins', off.length ? 'error' : 'ok',
      off.length ? `${off.length} 个管线步骤不在脚本白名单里` : `${pipes.length} 条管线的步骤全部在白名单内`,
      off.length ? off.join('；') : `白名单共 ${bins.size} 个脚本。`,
      off.length
        ? '在 server/lib/datacenter.mjs 的 BIN_WHITELIST 里补上该脚本名。⚠️ 不要反过来删白名单项来"修"这条 —— 白名单是安全边界。'
        : '无需处理。',
    ));
  } catch (e) {
    out.push(mk(
      'data.pipeline-bins', 'error', '管线脚本白名单读不出来 —— 这条检查没有在干活',
      `导入 server/lib/datacenter.mjs 失败：${e.message}`,
      '确认 server/lib/datacenter.mjs 存在并导出了 BIN_WHITELIST。读不到白名单时，'
      + '「管线跑不跑得起来」就完全没人管了 —— 这比报一次错更危险。',
    ));
  }

  /* ---- 3.4b 类星体远景背景场：数据层不变式 ----
     为什么有这条：这批数据是「可观测宇宙」层 0.3–27.9 Gly 纵深里**唯一的真实天体**。
     它一旦坏掉，那一层就退回「背景啥也没有」——而它坏掉的方式大多**不报错**：
     坐标缺失会全部堆在原点（看起来像「天体都挤在银河系」），
     距离模型被换成 cz/H0 线性近似会**悄悄**把高红移那批拉近一个量级
     （z=3 上偏 +105%），而界面上一片正常。
     ⇒ 这几条判据要能抓到「不报错的坏」。

     ⚠️ 判据的数据模型要跟着产品口径走：这批天体**故意不进目录**
       （见 `cosmos.js#buildQuasarField` 的说明），所以这里**不**断言它进目录。 */
  try {
    const q = JSON.parse(await readFile(path.join(ROOT, 'data', 'quasars.json'), 'utf8'));
    const rows = Array.isArray(q.objects) ? q.objects : [];
    const meta = q.meta || {};
    const bad = [];
    const soft = [];
    if (!rows.length) bad.push('data/quasars.json 的 objects 是空的 —— 这一层的真实背景场没有了');
    const seen = new Set();
    let dup = 0, nonFinite = 0, outOfRange = 0, rBad = 0, noMag = 0;
    for (const o of rows) {
      if (seen.has(o.id)) dup++;
      seen.add(o.id);
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)
        || !Number.isFinite(o.distMly) || !Number.isFinite(o.redshift)) { nonFinite++; continue; }
      if (!(o.redshift > 0.02) || o.distMly > 45200) outOfRange++;
      const r = Math.hypot(o.x, o.y, o.z);
      if (Math.abs(r - o.distMly) > Math.max(0.01, o.distMly * 1e-6)) rBad++;
      if (!Number.isFinite(o.mag)) noMag++;
    }
    /* z → 距离 必须单调（共动距离是 z 的单调函数）。这是「距离模型被换掉」最便宜的探针。 */
    const sorted = rows.slice().sort((a, b) => a.redshift - b.redshift);
    let mono = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (Number.isFinite(sorted[i].distMly) && Number.isFinite(sorted[i - 1].distMly)
        && sorted[i].distMly < sorted[i - 1].distMly - 1e-6) mono++;
    }
    if (dup) bad.push(`${dup} 个重复 id`);
    if (nonFinite) bad.push(`${nonFinite} 行有非有限的 x/y/z/distMly/redshift`);
    if (outOfRange) bad.push(`${outOfRange} 行越界（z ≤ 0.02 或 distMly > 45200 = CMB 边界）`);
    if (rBad) bad.push(`${rBad} 行的 √(x²+y²+z²) ≠ distMly（坐标与距离不自洽）`);
    if (mono) bad.push(`${mono} 处 z→distMly 非单调（共动距离必须单调 —— 距离模型被换过？）`);
    const model = String(meta.distanceModel || '');
    if (!/ΛCDM|Lambda-CDM/.test(model) || !/Planck/.test(model)) {
      bad.push(`meta.distanceModel 里认不出「Planck 平坦 ΛCDM」：${model.slice(0, 60)}…`
        + '（若真被换成了 cz/H₀ 线性近似，z=3 上会偏 +105%）');
    }
    if (!/4521[0-9]|45\.2 Gly|45200/.test(String(meta.distanceAnchor || ''))) {
      bad.push(`meta.distanceAnchor 里找不到 CMB 锚点（期望 ≈ 45200 Mly）：${meta.distanceAnchor}`);
    }
    /* ⚠️ 分级口径：**只有「可处置的」才配 warn。**
     *    「有 N 行没有星等」是这批数据的**固定属性**（Milliquas 里 R/B 都有缺行的本来就有），
     *    它每次都成立、谁也不用去改 ⇒ 报成 warn 就是**永久噪声**，
     *    而永久噪声会把「自检有没有红」这个信号训练成没人看（本项目的老毛病）。
     *    所以它只出现在 ok 的说明里。
     *    真正该 warn 的是下面那两条：meta 的口径字段不见了 —— 那是**能去修**的。 */
    if (!meta.samplingNote || !meta.query) soft.push('meta 里缺 samplingNote / query —— 取样口径不可复算');
    out.push(mk(
      'data.quasars', bad.length ? 'error' : (soft.length ? 'warn' : 'ok'),
      bad.length ? `类星体背景场有 ${bad.length} 类问题`
        : `${rows.length} 个类星体，坐标/距离/单调性/距离模型全部自洽`,
      (bad.length ? bad.join('；') : `${rows.length} 行全部通过`)
        + (noMag ? `；${noMag} 行没有星等（数据的固定属性，渲染时回退到 16 等）` : '')
        + (soft.length ? `（提示：${soft.join('；')}）` : ''),
      bad.length ? '重跑 `node tools/fetch-quasars.mjs` 重建；不要手改 data/quasars.json。'
        : '无需处理。',
    ));
  } catch (e) {
    out.push(mk(
      'data.quasars', 'warn',
      '类星体背景场读不出来（可能还没抓过）',
      `读 data/quasars.json 失败：${e.message}`,
      '在「数据更新中心」跑一次「可观测宇宙远景背景（类星体）」管线，'
      + '或执行 `node tools/fetch-quasars.mjs`。⚠️ 这只是 warn：这一层没有它也能显示（只是背景变空）。',
    ));
  }

  /* ---- 3.4c 「可观测宇宙」的背景场必须**真的被画** ----
     为什么有这条：这一层曾经 181 个天体「目录里搜得到、场景里看不见」
     ——数据全在、`catalogObjectsOfLevel()` 也取得到，但 `build()` 只遍历了
     7 个手工结构。用户看到的就是「背景太空了啥也没有」。
     这类故障**没有任何运行时错误**：一切正常，只是没人画。
     ⇒ 只能靠静态判据盯住「构建函数里有没有那几次调用」。
     ⚠️ 必须用 `stripComments()` 之后再看：本项目的注释里大量引用这些函数名，
        直接扫原文会把注释当成代码（踩过：正则扫源码误判「呼吸还在」）。 */
  try {
    const lvSrc = stripComments(await readFile(path.join(ROOT, 'web/js/levels/cosmos.js'), 'utf8'));
    const dsSrc = stripComments(await readFile(path.join(ROOT, 'web/js/data/dataset.js'), 'utf8'));
    const miss = [];
    if (!/this\.#buildCosmicWeb\(scene\)/.test(lvSrc)) miss.push('build() 里没有调用 this.#buildCosmicWeb(scene)');
    if (!/this\.#buildGalaxyCloud\(scene\)/.test(lvSrc)) miss.push('build() 里没有调用 this.#buildGalaxyCloud(scene)');
    if (!/this\.#buildQuasarField\(scene\)/.test(lvSrc)) miss.push('build() 里没有调用 this.#buildQuasarField(scene)');
    if (!/#buildQuasarField\(scene\)\s*\{/.test(lvSrc)) miss.push('#buildQuasarField 没有定义');
    if (!/fetch\('\.\/data\/quasars\.json'\)/.test(dsSrc)) miss.push('dataset.js 没有加载 ./data/quasars.json');
    if (!/this\.quasars\s*=/.test(dsSrc)) miss.push('dataset.js 没有把 quasars 挂到实例上（层里读 this.dataset.quasars 会拿到 undefined）');
    out.push(mk(
      'shell.universe-background', miss.length ? 'error' : 'ok',
      miss.length ? `「可观测宇宙」的背景场有 ${miss.length} 处没接上` : '背景场三件套（宇宙网 / 星系点云 / 类星体）都已接上',
      miss.length ? miss.join('；')
        : 'build() 三次调用齐全，dataset 也已加载并挂载 quasars',
      miss.length ? '把缺的那次调用补回 `web/js/levels/cosmos.js` 的 build()（或 dataset.js 的 load()）。'
        + '⚠️ 这类缺陷**不会抛错**，只会让那一层看起来是空的。'
        : '无需处理。',
    ));
  } catch (e) {
    out.push(mk(
      'shell.universe-background', 'error',
      '静态扫描没跑起来 —— 这条检查没有在干活',
      `读 web/js/levels/cosmos.js 或 web/js/data/dataset.js 失败：${e.message}`,
      '确认这两个文件存在。读不到就等于「背景场有没有被画」完全没人管。',
    ));
  }

  /* ---- 3.5 落点守卫：坐标缺失必须显式判掉（静态部分） ---- */
  out.push(...(await checkPlacementGuards(ROOT)));

  return out;
}

/* ============================================================
   落点守卫（静态部分）
   ============================================================ */

/**
 * 「坐标缺失」这一类静默故障的**静态**判据 —— 不起浏览器，所以每次自检都能跑。
 *
 * 背景：太阳曾被渲染成一个硬边大白色方块。真因是别的尺度的天体、外加一批缺坐标的
 * 天体，全被画在**世界原点**上，而世界原点恰好是太阳。这两类在代码里都不抛异常：
 *   · `new THREE.Vector3(undefined,…)` → NaN 向量；
 *   · `(0,0,0)` → **合法**向量。
 * 两者在渲染上都是「堆在原点」，看不出区别。
 *
 * 动态判据在 `tools/probe-placements.py`（要起浏览器、数精灵、还带故障注入），
 * 不适合每次自检都跑。这里补两条**随时可跑**的静态判据，防的是「下次改代码又忘了」：
 *
 *   1 `data.anchor-kinds`     结构锚的取值必须来自 `attrs.js` 的唯一定义源。
 *                             写错一个字母（`hoem`）而照样免检 = 「声明错 = 免检」。
 *   2 `data.curated-coverage` 人工整理的数据不许被全表冲掉（**回归锁**）。
 *                             实测被冲掉过四个本星系群成员：它们的红移是负的或近零，
 *                             哈勃定律不适用，全表里没有距离 —— 一覆写就丢距离、还换了层。
 */
/**
 * 去掉注释再数东西。
 *
 * ⚠️ 这个项目反复栽在同一件事上：**正则的数法决定了计数器的数**。
 *    本次实测：`data.anchor-kinds` 第一次跑出来「home 5 处」，
 *    而真正的声明只有 2 处 —— 另外 3 处是**注释里**举的例子
 *    （形如 `/* \`anchor: 'home'\` —— 我们在它里面… *​/`）。
 *    注释被当成声明有两个后果，一个比一个坏：
 *      · 计数虚高，看的人以为有一堆锚；
 *      · 注释里举反例（写个 `hoem` 讲「这样不行」）会**报出一个不存在的故障** ——
 *        而假警报会训练人忽略自检，那是比漏报更长远的损失。
 *    ⇒ 数之前先把注释剥掉。
 */
function stripComments(src) {
  return src
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
    .map((line) => line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

async function checkPlacementGuards(ROOT) {
  const out = [];
  const dataDir = path.join(ROOT, 'web', 'js', 'data');
  const attrsPath = path.join(dataDir, 'attrs.js');
  const datasetPath = path.join(dataDir, 'dataset.js');
  const deepSkyPath = path.join(dataDir, 'deep-sky.js');
  const deepSkyJson = path.join(ROOT, 'data', 'deep-sky.json');

  /* ---- 1. 结构锚的取值：词表只有 attrs.js 一份 ---- */
  let kinds = [];
  let kindsErr = null;
  try {
    const m = await import(pathToFileURL(attrsPath).href);
    kinds = Object.keys(m.ANCHOR_KINDS || {});
    if (!kinds.length) kindsErr = 'attrs.js 导出了 ANCHOR_KINDS，但它里面一个种类都没有。';
  } catch (e) {
    kindsErr = `import web/js/data/attrs.js 失败：${e.message}`;
  }

  if (kindsErr) {
    out.push(mk(
      'data.anchor-kinds', 'error',
      '结构锚的词表读不出来 —— 这条检查没有在干活',
      kindsErr,
      '确认 web/js/data/attrs.js 存在、语法正确、且导出了 ANCHOR_KINDS。'
      + '读不到词表时，「anchor 取值写错」就完全没人管 —— 而写错的那个取值会让一个天体'
      + '**悄悄免检**：探针把任何 truthy 的 anchor 都当有效豁免跳过。',
    ));
  } else {
    const counts = {};
    const unknown = [];
    let scanned = 0;
    for (const f of [deepSkyPath, datasetPath]) {
      let src = '';
      try { src = await readFile(f, 'utf8'); } catch { continue; }
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      // 先剥注释再数：注释里举的例子不是声明（见 stripComments 的说明）
      for (const hit of stripComments(src).matchAll(/anchor:\s*'([^']*)'/g)) {
        scanned++;
        counts[hit[1]] = (counts[hit[1]] || 0) + 1;
        if (!kinds.includes(hit[1])) unknown.push(`${rel}：anchor:'${hit[1]}'`);
      }
    }
    const tally = Object.entries(counts).map(([k, n]) => `${k} ${n} 处`).join('、');
    if (!scanned) {
      out.push(mk(
        'data.anchor-kinds', 'error', '一处结构锚都没扫到 —— 这条检查可能已经失效',
        '正则 /anchor:\\s*\'…\'/ 在 web/js/data/deep-sky.js 与 dataset.js 里零命中。',
        '要么字段被改名了（本检查的正则要跟着改），要么结构锚机制被整体移除了。'
        + '后一种情况要把本检查和 tools/probe-placements.py 里的对应判据一起删掉 ——'
        + '不要留着一条永远说「没事」的检查。',
      ));
    } else {
      out.push(mk(
        'data.anchor-kinds', unknown.length ? 'error' : 'ok',
        unknown.length
          ? `${unknown.length} 处 anchor 取值不在词表里`
          : `结构锚取值合法（${scanned} 处）`,
        unknown.length ? unknown.join('；') : `词表：${kinds.join(' / ')}。分布：${tally}。`,
        unknown.length
          ? `把取值改成 ${kinds.join(' 或 ')}；若确实是新种类，在 attrs.js 的 ANCHOR_KINDS 里登记，`
            + '并写清它在哪一层成立、位置必须满足什么。'
            + '⚠️ 不要为了过检查就把这个 anchor 删掉 —— 它多半正在豁免一个**真的**在原点或在别的层的天体。'
          : '无需处理。',
      ));
    }
  }

  /* ---- 2. 人工整理的数据不许被全表冲掉（回归锁） ---- */
  let dsSrc = '';
  let datasetSrc = '';
  try { dsSrc = await readFile(deepSkyPath, 'utf8'); } catch { /* 下面按「扫不到」处理 */ }
  try { datasetSrc = await readFile(datasetPath, 'utf8'); } catch { /* 同上 */ }

  const curated = new Set();
  for (const hit of dsSrc.matchAll(/\bG\(\s*'([^']+)'/g)) curated.add(hit[1]);

  /* ⚠️ 这个文件的顶层是 `{ meta, objects: [...] }`，**不是**裸数组。
   *    第一次写这条检查时按裸数组取（`Array.isArray(dj.data)`），
   *    于是 13,372 条记录一条都没读到，检查却报「解析失败：undefined」——
   *    一个把「我读错了结构」说成「文件坏了」的**假诊断**，
   *    而且它长得特别像真的（有大写文件路径、有明确的失败字样）。
   *    ⇒ 三种情况必须分开说：读不出 / 结构不认识 / 正常。 */
  const dj = await readJson(deepSkyJson);
  const payload = dj.ok ? dj.data : null;
  const bulk = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.objects) ? payload.objects : null);
  const atRisk = [];
  if (bulk) {
    const byId = new Map(bulk.map((o) => [o.id, o]));
    for (const id of curated) {
      const row = byId.get(id);
      // 全表里没有距离、而人工表有 —— 覆写就会把它冲掉
      if (row && row.distMly == null) atRisk.push(id);
    }
  }
  const guarded = datasetSrc.includes('curatedMerge');
  const list = atRisk.slice(0, 8).join('、') + (atRisk.length > 8 ? ` 等 ${atRisk.length} 个` : '');

  if (!curated.size) {
    out.push(mk(
      'data.curated-coverage', 'error', '一条人工整理的星系都没扫到 —— 这条检查可能已经失效',
      '正则 /\\bG\\(\\s*\'([^\']+)\'/ 在 web/js/data/deep-sky.js 里零命中。',
      '人工表的构造方式（`G(...)` 工厂）被改名了，本检查的正则要跟着改 —— '
      + '否则它会一直报「没事」，而它本来要看的正是最容易被全表冲掉的那批天体。',
    ));
  } else if (!bulk) {
    const why = !dj.ok
      ? (dj.missing ? 'data/deep-sky.json 不存在。' : `解析失败：${dj.err}`)
      : `文件能解析，但取不到记录数组：顶层是 ${Array.isArray(payload) ? '数组' : `对象（键：${Object.keys(payload || {}).join('、') || '空'}）`}，`
        + '本检查接受数组或 { objects: [...] } 两种形状。';
    out.push(mk(
      'data.curated-coverage', 'warn', '读不到深空编目记录，这条检查只能做一半',
      why,
      !dj.ok
        ? '跑一次深空编目管线重建该文件（数据更新中心 → 深空编目）。'
          + '在此之前，「人工表会不会被全表冲掉」无人核验。'
        : '该文件的顶层结构变了，本检查要跟着改。'
          + '⚠️ 改的时候留意别把它改成「永远读不到、永远说没事」——那样比报错更糟。',
    ));
  } else if (atRisk.length && !guarded) {
    out.push(mk(
      'data.curated-coverage', 'error',
      `${atRisk.length} 个人工整理的星系会被全表冲掉距离`,
      `重名、且全表里没有距离：${list}。`
      + '全表（data/deep-sky.json）多数只有 RA/Dec 与视星等；这几个天体的红移是**负的**或近零，'
      + '哈勃定律不适用，所以全表里 `distMly` 是 null。用全表覆写会让它们丢掉实测距离，'
      + '并被 `deepSkyLevelOf` 重新判到别的尺度层 —— 在原本那一层凭空消失。',
      '恢复 dataset.js「深空编目天体」循环里的合并逻辑：保留已有字段（新行只补它没有的），'
      + '并在合并**之后**重算 level 与 noDistance。参考本次修复引入的 `curatedMerge`。',
    ));
  } else {
    out.push(mk(
      'data.curated-coverage', 'ok',
      `人工整理的星系 ${curated.size} 个 · 需靠人工表补距离的 ${atRisk.length} 个`,
      atRisk.length
        ? `受合并逻辑保护：${list}（全表里没有距离，保留人工值）。`
        : `没有与全表重名又缺距离的条目。合并逻辑在位（curatedMerge）。`,
      '无需处理。',
    ));
  }

  return out;
}

/* ============================================================
   检查组 4：人工覆盖与监测队列的数据合法性
   ============================================================ */

async function checkGovernance(ROOT) {
  const out = [];

  const ov = await readJson(path.join(ROOT, 'data', 'overrides.json'));
  if (!ov.ok) {
    out.push(mk('gov.overrides', 'warn', '人工覆盖表读不出来', ov.missing ? 'data/overrides.json 不存在（这是正常的第一次运行状态）。' : ov.err,
      '不存在无需处理——首次采纳修正时会自动创建。若解析失败，检查文件是否被手工改坏（只支持标量值）。'));
  } else {
    const list = ov.data.overrides || [];
    const bad = [];
    const seen = new Set();
    const rePath = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;
    for (const o of list) {
      if (!o.entityId) bad.push('有一条缺 entityId');
      else if (!rePath.test(String(o.path || ''))) bad.push(`${o.entityId} 的 path「${o.path}」格式非法`);
      else if (seen.has(`${o.entityId}|${o.path}`)) bad.push(`${o.entityId}.${o.path} 重复`);
      else seen.add(`${o.entityId}|${o.path}`);
      if (o.value && typeof o.value === 'object') bad.push(`${o.entityId}.${o.path} 的值不是标量`);
    }
    out.push(mk(
      'gov.overrides', bad.length ? 'error' : 'ok',
      bad.length ? `人工覆盖表有 ${bad.length} 处非法` : `${list.length} 条人工覆盖格式合法`,
      bad.length ? bad.join('；') : '寻址（entityId + path）格式正确、无重复、值均为标量。',
      bad.length ? '打开 data/overrides.json 修正非法项；只能改标量字段值，不能新增/删除天体或改 id。' : '无需处理。',
    ));
  }

  const wq = await readJson(path.join(ROOT, 'data', 'watch-queue.json'));
  if (wq.ok) {
    const cs = wq.data.candidates || [];
    const pending = cs.filter((c) => c.status === 'pending').length;
    out.push(mk(
      'gov.watch-queue', 'ok',
      `待复核线索 ${pending} 条`,
      wq.data.lastScan ? `上次扫描 ${wq.data.lastScan}，队列共 ${cs.length} 条。` : '尚未扫描过。',
      pending ? '到「数据更新中心 → 最新科研监测」逐条判断采纳或忽略。监测器只提供线索，不代替你下结论。' : '无需处理。',
    ));
  }

  return out;
}

/* ============================================================
   检查组 5：服务自身（端口、日志）
   ============================================================ */

async function checkService(ROOT, logger, actualPort) {
  const out = [];

  // 端口残留：data/.port 记录的是「上次跑在哪个端口」，与本次不一致说明有旧实例痕迹
  const pf = path.join(ROOT, 'data', '.port');
  const prev = await readFile(pf, 'utf8').then((s) => Number(s.trim())).catch(() => null);
  if (actualPort == null) {
    out.push(mk('svc.port', 'ok', prev ? `上次运行端口 ${prev}` : '无端口记录', '（离线自检模式，未启动服务）', '无需处理。'));
  } else {
    const drift = prev != null && prev !== actualPort;
    out.push(mk(
      'svc.port', drift ? 'warn' : 'ok',
      `本次监听 ${actualPort}${prev != null ? ` · 记录 ${prev}` : ''}`,
      drift
        ? '端口与上次记录不一致，通常是上次的端口被占用后自动顺延了。前端按地址栏访问，所以功能不受影响。'
        : '端口与记录一致。',
      drift
        ? `若你一直用手敲的固定地址，改用本次的 http://127.0.0.1:${actualPort}；或先关掉占用 ${prev} 端口的程序再重启。`
        : '无需处理。',
    ));
  }

  if (logger) {
    const c = logger.counts();
    const hot = c.error > 0;
    out.push(mk(
      'svc.logs', hot ? 'warn' : 'ok',
      `今日日志：${c.error} 错误 / ${c.warn} 警告 / ${c.info} 信息`,
      logger.writable ? `写入 ${path.relative(ROOT, logger.file)}。` : '日志目录不可写，已降级为仅控制台输出。',
      hot
        ? '看「数据更新中心 → 自检 → 近期日志」定位；错误多半来自上游接口限流或网络中断，重试前先看是不是同一个源一直失败。'
        : '无需处理。',
    ));
  }

  return out;
}

/* ============================================================
   检查组 6：命名一致性（更名遗留）
   ============================================================ */

/**
 * 更名残留检查。
 * 上一轮改名只列了 13 个文件的清单，结果 server/lib 的 UA、package-lock、
 * lss.* schema 前缀全漏了。所以这里**在线也扫一遍**，让"改了一半"这件事无法静默存在。
 * 只扫浅层关键目录，避免全仓库遍历拖慢接口。
 *
 * 豁免机制：不维护中央豁免清单（清单会腐烂，改代码的人不会记得去更新它）。
 * 改成**让源码自己声明**——同一行里如果带着「更名遗留 / legacy / 旧键」这类标记，
 * 就认定是「有意保留的旧名引用」，跳过。这样豁免与被豁免的东西待在一起，不会走散。
 * 例：`const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem('lss.gpu.v1');`
 */
const LEGACY_TOKENS = ['小小太阳系', 'Little Solar System', 'little-solar-system', 'lss.'];
const LEGACY_SCAN = ['server', 'tools', 'web/js', 'data', 'package.json', 'README.md'];
/** 旧名是数据、不是残留的文件：更名工具本体与其报告 */
const LEGACY_SKIP_FILE = /(rename-to-cosmos|rename-pass2|_rename2-report|_rename-report|selfcheck|_rename.*\.out|_probe.*\.out|_after\.out|scale-test\.log)/;
/** 行内自带这些标记 = 有意保留 */
const LEGACY_INTENTIONAL = /更名遗留|legacy|旧键|有意保留|当时原话/i;

async function checkNaming(ROOT) {
  const found = [];
  async function scan(rel) {
    const abs = path.join(ROOT, rel);
    const s = await statOf(abs);
    if (!s.exists) return;
    if (s.size > 0 && rel.includes('.')) {   // 是个文件
      if (LEGACY_SKIP_FILE.test(rel)) return;
      if (s.size > 4 * 1024 * 1024) return;
      const text = await readFile(abs, 'utf8').catch(() => null);
      if (text == null) return;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const t of LEGACY_TOKENS) {
          if (!line.includes(t)) continue;
          if (LEGACY_INTENTIONAL.test(line)) continue;   // 源码自证豁免
          found.push(`${rel}:${i + 1} ← ${t}`);
        }
      }
      return;
    }
    const names = await readdir(abs).catch(() => null);
    if (!names) return;
    for (const n of names) {
      if (['node_modules', '.git', '.trash', 'dist', 'logs'].includes(n)) continue;
      await scan(`${rel}/${n}`);
    }
  }
  for (const r of LEGACY_SCAN) await scan(r);

  const out = [mk(
    'naming.legacy', found.length ? 'warn' : 'ok',
    found.length ? `还有 ${found.length} 处旧项目名残留` : '全量更名干净',
    found.length ? found.slice(0, 12).join('；') + (found.length > 12 ? ` …共 ${found.length} 处` : '') : '关键目录里找不到「小小太阳系 / Little Solar System / little-solar-system / lss.」等旧名。',
    found.length ? '执行 node tools/rename-pass2.mjs --apply 收口（先预演看一遍）。若某处旧名是「有意保留的引用」（比如兼容老配置的读取），在那一行加上「更名遗留 / legacy / 旧键」任一字样即可豁免——本检查认标记，不认豁免清单。' : '无需处理。',
  )];

  /* ── 工作区**目录名**自己（坑 21 的另一半）─────────────────────────
   * `naming.legacy` 扫的是**仓库里面**的文件；而「这个文件夹自己叫什么」
   * 既在仓库里、又不在任何文件里 —— 它挂在 WorkBuddy 的工作区记录上。
   * 所以「更名干净」可以和「桌面文件夹还叫旧名」同时成立，两边都不报错。
   *
   * 判据直接读 `path.basename(ROOT)`。恒为 **warn**：目录名不影响程序能不能用，
   * 只影响「用户每天看见的那个名字」。改名要走 `tools/migrate-workspace-rename.mjs`
   * （必须先关 WorkBuddy，见坑 21），所以这里**只提示、不派活**。
   */
  const base = path.basename(ROOT);
  const dirLegacy = LEGACY_TOKENS.filter((t) => base.includes(t));
  out.push(mk(
    'naming.workspace-dir', dirLegacy.length ? 'warn' : 'ok',
    dirLegacy.length ? '工作区目录名还带着旧项目名' : '工作区目录名干净',
    dirLegacy.length
      ? `当前目录名「${base}」里含旧名（${dirLegacy.join(' / ')}）。注意：**这不是仓库内容的问题** —— 全仓库早已改干净，这个文件夹名挂在 WorkBuddy 的工作区记录上。`
      : `当前目录名「${base}」不含任何旧项目名。`,
    dirLegacy.length
      ? '关掉 WorkBuddy，双击桌面上的「改名到小小宇宙.bat」——它会连同转录目录、进程心跳和 workbuddy.db 里的 cwd 一起搬（见 坑与雷点.md 坑 21）。'
      : '无需处理。',
  ));

  /* ── 持久会话索引里的 cwd 还指着存在的目录吗（4011 的判据）─────────────
   * `naming.legacy` 扫的是**仓库内容**，`naming.workspace-dir` 看的是**文件夹名本身**。
   * 而 WorkBuddy 打开会话时真正校验的是第三份东西：
   *   `~/.workbuddy/workbuddy.db` → `sessions.cwd` 指向的目录**在不在**。
   * 不在就直接拒：`4011 Conversation workspace does not exist or was removed`。
   *
   * 2026-09-11 晚实测：上面两条**都是绿的**、迁移工具自检也 **20/20 全绿**，
   * 而那个会话照样打不开 —— 三张网没一张罩住这一份。
   * **判据没测到的东西，绿得毫无意义**（同族：坑 84 / 坑 85）。
   *
   * 读不到就**不产出这条判据**（连 ok 都不报）：库不存在、Node 太老（< 22.5）、库正被占用，
   * 这些都是**环境**不是故障。只有「会话确实打不开」才判 error。
   */
  try {
    const os = await import('node:os');
    const dbPath = path.join(os.default.homedir(), '.workbuddy', 'workbuddy.db');
    if (await exists(dbPath)) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare('SELECT id, cwd, title FROM sessions').all();
      db.close();
      const dead = [];
      for (const r of rows) {
        if (typeof r.cwd === 'string' && r.cwd && !(await exists(r.cwd))) dead.push(r);
      }
      out.push(mk(
        'naming.session-cwd', dead.length ? 'error' : 'ok',
        dead.length
          ? `${dead.length} 条会话的工作区目录已不存在 —— 打开它们会报 4011`
          : '会话索引里的工作区目录都还在',
        dead.length
          ? dead.slice(0, 6).map((d) => `${String(d.id).slice(0, 8)}「${d.title ?? ''}」→ ${d.cwd}`).join('；')
            + (dead.length > 6 ? ` …共 ${dead.length} 条` : '')
          : `库里 ${rows.length} 条会话的 cwd 都指向存在的目录。WorkBuddy 打开会话时会校验这一份，它失效报的就是 4011。`,
        dead.length
          ? '先跑 node tools/check-workspace-cwd.mjs 体检取证，再照它给出的命令带 --apply 修（会先备份数据库）。'
            + '若是「文件夹刚改完名、还没来得及同步」，用 node tools/migrate-workspace-rename.mjs 预演一遍（见 坑与雷点.md 坑 21）。'
          : '无需处理。以后动工作区文件夹名之前，先跑 node tools/check-workspace-cwd.mjs 记下基线。',
      ));
    }
  } catch { /* 环境拿不到这半边 → 不产出判据，不报假故障 */ }

  return out;
}

/* ============================================================
   检查组 6b：仓库**外面**的引用物（桌面快捷方式）
   ============================================================ */

/**
 * 为什么这条必须存在：
 * 「全仓库更名」的边界是**仓库**，而桌面快捷方式住在仓库**外面**。
 * 于是产品一改名（`启动小小太阳系.bat` → `启动小小宇宙.bat`），
 * 桌面上那个 `.lnk` 还指着旧文件名 —— 双击直接「找不到文件」。
 * 这类东西任何仓库内扫描都发现不了，只能显式去盘上核对。
 *
 * 实现取舍：`.lnk` 是二进制格式，解析它的知识只保留**一份**
 * （tools/install-shortcut.mjs）。这里只调它的 `--check`，不重复实现 ——
 * 两份解析器迟早会各自演化到互相矛盾，那时候自检说"没事"而快捷方式打不开，
 * 就成了最坏的一种：**假绿**。
 *
 * 分级恒为 warn，且以下情况一律 ok（不制造噪声）：
 *   非 Windows / 没有桌面目录 / 没装这个快捷方式 / 校验工具本身不在包里。
 * 理由：快捷方式坏了不影响程序能不能用，它只是"桌面上那个图标是假的"。
 */
async function checkOutsideRefs(ROOT) {
  const ID = 'naming.outside-refs';
  // 先定成绝对路径：下面要把 ROOT 同时当「子进程 cwd」和「拼工具路径的基准」用。
  // 两者一起用相对路径时，子进程会把同一个相对路径**再拼一遍** → 找不到模块 → 假报故障。
  // 本项目最忌讳的就是自检误报（久了用户就学会无视自检），所以这里一次性堵死。
  const rootAbs = path.resolve(ROOT);
  if (process.platform !== 'win32') {
    return [mk(ID, 'ok', '非 Windows，跳过桌面快捷方式检查', `当前平台 ${process.platform}。`, '无需处理。')];
  }
  const tool = path.join(rootAbs, 'tools', 'install-shortcut.mjs');
  if (!(await exists(tool))) {
    return [mk(ID, 'ok', '快捷方式校验工具不在（便携包可能未包含）',
      'tools/install-shortcut.mjs 不存在，跳过这项。',
      '无需处理。想用这个能力就从源码仓库取回该脚本。')];
  }

  let launcher = null;
  try {
    const hits = (await readdir(rootAbs)).filter((n) => /^启动.*\.bat$/i.test(n));
    if (hits.length === 1) launcher = hits[0];
  } catch { /* 读不到就按"没有启动器"处理 */ }
  if (!launcher) {
    return [mk(ID, 'ok', '仓库根没有唯一的「启动*.bat」，跳过', '无法推导产品名，这项检查无从下手。', '无需处理。')];
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  let text = '';
  let code = 0;
  try {
    const r = await promisify(execFile)(process.execPath, [tool, '--check'],
      { cwd: rootAbs, timeout: 15000, windowsHide: true, encoding: 'utf8' });
    text = r.stdout || '';
  } catch (e) {
    code = typeof e.code === 'number' ? e.code : 1;
    text = `${e.stdout || ''}${e.stderr || ''}${e.stdout || e.stderr ? '' : e.message}`;
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const fails = lines.filter((l) => l.includes('✗'));
  const passes = lines.filter((l) => l.includes('✓'));

  // 摘要必须如实反映 --check 到底核对了谁。
  // 便携版 / 多副本场景下，桌面快捷方式指向的是**另一份副本**，那不是故障；
  // 但也**不能**说成"本目录的字段全部核对通过" —— 那是把别人的核对结果记在自己头上。
  const elsewhere = passes.find((l) => l.includes('指向另一份副本'));
  // 从那一行里把实际指向的路径抠出来 —— 摘要只陈述事实，不复述整行（否则同一句话会说两遍）
  const elsewherePath = elsewhere ? ((elsewhere.match(/IDList 指向\s+(.+?)\s+←/) || [])[1] || '') : '';

  return [mk(
    ID, code === 0 ? 'ok' : 'warn',
    code === 0
      ? (elsewhere ? '桌面快捷方式指向另一份副本（正常）' : '桌面快捷方式与产品名一致')
      : `桌面快捷方式有问题（${fails.length || '若干'} 项）`,
    code === 0
      ? (elsewhere
        ? `桌面快捷方式并不指向本目录，而是指向另一份副本${elsewherePath ? `（${elsewherePath}）` : ''}；`
          + '其余字段（工作目录、图标、名称）逐项核对通过。多副本 / 便携版环境下这是正常状态。'
        : `「${launcher}」对应的桌面快捷方式：${passes.length} 项逐字段核对通过。`)
      : (fails.slice(0, 4).join('；')
        // 一条 ✗ 都没有却退出码非 0 —— 那是「校验器根本没跑起来」，不是「判定不一致」。
        // 这两种病得分开说，否则修了半天修的是错的地方。
        || `校验器本身没跑起来（不是判定不一致）：${lines.slice(-1)[0] || '没有任何输出'}`),
    code === 0
      ? '无需处理。'
      : '执行 node tools/install-shortcut.mjs 刷新（会先把旧快捷方式移进 .trash 备份，再按当前产品名重建，并清掉同项目的旧名快捷方式）。',
  )];
}

/* ============================================================
   汇总
   ============================================================ */

/**
 * 跑一遍全部自检。
 * @param {string} ROOT 项目根
 * @param {object} opts { logger, port }
 * @returns {{ ok, generatedAt, elapsedMs, summary, checks, groups }}
 */
/**
 * 显卡与显存：混合显卡笔记本上，「把负载搬到显存」这件事默认**根本没生效**。
 *
 * 为什么值得单列一条 —— 它是一条**静默故障**：
 *   · 核显没有自己的显存，它的「显存」是**从系统内存借的**（UMA 共享内存）。
 *     于是在核显上谈「把负载搬到显存」，等于**搬到系统内存**，与初衷正好相反。
 *   · 而 Windows 默认挑核显省电，界面上**没有任何提示**，用户以为已经在用独显了。
 *   · 实测（本机 2026-09-11，tools/perf-probe.py）：
 *       默认      ANGLE(AMD, Radeon(TM) Graphics)   画质档位自动 = saver
 *       强制高性能 ANGLE(NVIDIA, RTX 3050 Ti)        画质档位自动 = high
 *     独显专用显存 4096 MB，其中只用了 214 MB。
 *
 * 为什么**最高只 warn**：这是用户在「续航 vs 性能」之间的取舍，不是缺陷。
 * 判成 error 会训练用户无视自检（同 checkTrash 的口径）。
 *
 * ⚠ 判定逻辑**不在这里重写**：调 tools/gpu-preference.mjs --json 拿结论。
 *   一处口径写两遍 = 会错两遍（见 坑与雷点.md 坑 65 的原型）。
 */
async function checkPerf(ROOT) {
  const ID = 'perf.gpu-hybrid';
  if (process.platform !== 'win32') {
    return [mk(ID, 'ok', `非 Windows（${process.platform}），跳过显卡偏好检查`,
      '显卡偏好是 Windows 用户级设置，别的平台不适用。', '无需处理。')];
  }
  const tool = path.join(path.resolve(ROOT), 'tools', 'gpu-preference.mjs');
  if (!(await exists(tool))) {
    return [mk(ID, 'warn', '找不到显卡偏好工具，这项检查没跑',
      'tools/gpu-preference.mjs 不在，无法判断浏览器有没有用上独显。',
      '恢复 tools/gpu-preference.mjs（见 自检维修手册.md S22）。')];
  }

  // ⚠️ 走 runCapture（落临时文件）：本机不给子进程建管道，原来的 `{encoding:'utf8'}`
  //    会 12/12 报 EBUSY ⇒ 这条检查长期"没结论"。而**根因还在更下一层** ——
  //    gpu-preference 自己也是用管道调 powershell 的，那边已一并改成 runCapture。
  const cap = runCapture(process.execPath, [tool, '--json'], { timeout: 30000 });
  const obsGpu = salvageJson(cap);
  const s = (obsGpu && obsGpu.summary) || null;

  // 读不到就**如实说读不到**，不许猜一个「正常」出来 ——
  // 那会把「不知道」伪装成「没问题」，正是本项目最忌讳的判据失效方式。
  if (!s || !s.readOk) {
    // ⚠️ 别把原因写死成「PowerShell 不可用 / 注册表读不到」：
    //    2026-09-26 实测这条路走不通的**真因**是建管道被拒（EBUSY），
    //    而写死的原因会把排查引到另一个方向。所以**贴实际报错**。
    const why = (s && s.readError) || (cap.err ? errText(cap.err) : '(工具没给出原因)');
    return [mk(ID, 'warn', '显卡偏好读不到，这项检查没结论',
      `${why} —— 这不代表有问题，也不代表没问题，只是**没测**。`,
      '手动跑：node tools/gpu-preference.mjs（人读输出会打印完整报错）')];
  }
  if (!s.hybrid) {
    const names = (s.adapters || []).map((a) => `${a.kind}:${a.name}`).join(' · ');
    return [mk(ID, 'ok', '单显卡机器，不存在「选错卡」的问题', names || '（读不到适配器列表）', '无需处理。')];
  }

  const browsers = s.browsers || [];
  const onIGpu = browsers.filter((b) => b.found && !b.highPerf);
  const never = browsers.filter((b) => !b.found);
  const onDGpu = browsers.filter((b) => b.highPerf);

  if (onDGpu.length) {
    return [mk(ID, 'ok', `浏览器已指定用高性能显卡（${onDGpu.length} 个）`,
      `混合显卡机器：${(s.adapters || []).map((a) => a.kind + a.name).join(' · ')}。`
      + `\n已设为高性能：${onDGpu.map((b) => b.exe.split('\\').slice(-3).join('/')).join('、')}`
      + (never.length ? `；未设过：${never.map((b) => b.exe.split('\\').slice(-3).join('/')).join('、')}` : ''),
      '无需处理。想还原成「让 Windows 决定」：node tools/gpu-preference.mjs --revert')];
  }

  const detail = `这是一台混合显卡机器（${(s.adapters || []).map((a) => a.kind + a.name).join(' · ')}）。`
    + `\n浏览器**没有**指定用高性能显卡，Windows 会挑核显省电 ——`
    + `而核显的「显存」是从**系统内存**借的，所以此时「把负载搬到显存」实际是搬到系统内存。`
    + `\n未设过：${never.map((b) => b.exe.split('\\').slice(-3).join('/')).join('、') || '（无）'}`
    + (onIGpu.length ? `；明确设为省电：${onIGpu.map((b) => b.exe.split('\\').slice(-3).join('/')).join('、')}` : '');
  return [mk(ID, 'warn', '浏览器用的是核显，「搬到显存」目前没有生效', detail,
    '一次性设置（用户级、随时可还原）：node tools/gpu-preference.mjs --apply'
    + '\n然后**完全退出浏览器**重开。代价：独显常开会更费电。'
    + '\n验证：py -3.13 -X utf8 tools/perf-probe.py → 看「WebGL 后端」那一行')];
}

export async function runSelfCheck(ROOT, { logger = null, port = null } = {}) {
  const t0 = Date.now();

  // 系统可用内存：拿不到就 null，不要编一个数字出来
  let freeMemMB = null;
  try {
    const os = await import('node:os');
    const totalMB = os.totalmem() / 1048576;
    freeMemMB = Math.round(os.freemem() / 1048576);
    if (!Number.isFinite(totalMB)) freeMemMB = null;
  } catch { /* 忽略 */ }

  const env = { freeMemMB };

  const groups = [
    { id: 'runtime', label: '运行环境', checks: [...checkRuntime(env), ...(await checkTrash(ROOT))] },
    { id: 'shell', label: '程序骨架', checks: [...(await checkSkeleton(ROOT)), ...(await checkFrontendModel(ROOT)), ...(await checkOptionScope(ROOT)), ...(await checkProbeArgs(ROOT)), ...(await checkDocAnchors(ROOT)), ...(await checkDocRefs(ROOT))] },
    { id: 'data', label: '数据集与登记表', checks: await checkDatasets(ROOT) },
    { id: 'gov', label: '人工覆盖与监测', checks: await checkGovernance(ROOT) },
    { id: 'service', label: '本地服务', checks: await checkService(ROOT, logger, port) },
    { id: 'perf', label: '性能与显卡', checks: await checkPerf(ROOT) },
    { id: 'naming', label: '命名一致性', checks: [...(await checkNaming(ROOT)), ...(await checkOutsideRefs(ROOT))] },
  ];

  const checks = groups.flatMap((g) => g.checks);
  const summary = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.level] = (summary[c.level] || 0) + 1;

  return {
    ok: summary.error === 0,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    summary,
    groups: groups.map((g) => ({ id: g.id, label: g.label, checks: g.checks })),
    checks,
  };
}

export { LEVEL_ORDER };

#!/usr/bin/env node
/**
 * 自检器自己的自检（故障注入）。
 *
 * 为什么需要这个：**一条永远报绿的检查，比没有检查更糟**——它把「全绿」变成了假信号。
 * 本项目吃过这个亏两次：
 *   · 坑 24 —— `package.json` 的 `verify` / `shot` 指向不存在的脚本，从没人跑过，所以从没报错；
 *   · 坑 1  —— 点云缺 `map` 会渲染成硬边方块，不报错、不崩溃，纯靠肉眼才发现。
 *
 * 做法：在**临时目录**里造一堆假项目（不碰真项目一个字节），逐条注入已知故障，
 * 断言自检**抓得住**；再喂全合法的样本，断言**零误报**。
 * 另外核对自检自身的结构不变量（每条都得有 fix、id 不重复、分组齐全）。
 *
 * 用法：
 *   node tools/check-selfcheck.mjs            # 跑全部
 *   node tools/check-selfcheck.mjs --json     # 机器可读
 *
 * 退出码：0 = 全通过；1 = 有断言失败。
 */
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// 坑 14：中文路径下 new URL(import.meta.url).pathname 不解码，必须用 fileURLToPath
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.slice(2).includes('--json');

const { runSelfCheck } = await import(pathToFileURL(path.join(ROOT, 'server', 'lib', 'selfcheck.mjs')).href);

/* ============================================================
   断言收集
   ============================================================ */

const results = [];
let failed = 0;

function assert(ok, label, extra = '') {
  if (!ok) failed++;
  results.push({ ok, label, extra });
}

/* ============================================================
   临时项目构造
   ============================================================ */

const tmpRoots = [];

/** 在临时目录里造一个最小假项目；files = { 'web/js/a.js': '内容' } */
function makeProject(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'lc-selfcheck-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/** 同上，但**能指定项目目录名** —— 「工作区目录名」这类判据看的就是 basename（见坑 21）。 */
function makeProjectNamed(dirName, files = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'lc-selfcheck-'));
  tmpRoots.push(base);
  const root = path.join(base, dirName);
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/** 跑一次自检，取指定 id 的那条 */
async function checkOf(root, id) {
  const res = await runSelfCheck(root, {});
  return { res, chk: res.checks.find((c) => c.id === id) };
}

/* ============================================================
   故障注入：点云材质必须给 map（坑 1）
   ============================================================ */

const PM_CODE = (body) => `const mat = new THREE.PointsMaterial({\n${body}\n});\n`;

// —— 必须被抓出来的四种漏法 ——
const PM_BAD = {
  'web/js/levels/a-plain.js': PM_CODE("  size: 1, vertexColors: true,"),
  'web/js/levels/b-line-comment.js': PM_CODE("  size: 1,\n  // 必须给 map：不然是方块"),
  'web/js/levels/c-block-comment.js': PM_CODE("  size: 1,\n  /* map: 忘了写 */"),
  'web/js/levels/d-alphaMap.js': PM_CODE("  alphaMap: tex, size: 1,"),
};

// —— 必须放过的合法写法（含最容易误伤的一种：map 在注释里提过但真的也传了）——
const PM_GOOD = {
  'web/js/levels/e-ok.js': PM_CODE("  size: 1,\n  map: makeGlowTexture('#fff', 0.5, 64),"),
  'web/js/levels/f-inline.js':
    "const pts = new THREE.Points(geo, new THREE.PointsMaterial({\n  size: 8,\n  map: makeGlowTexture('#9ec5ff', 0.5, 64), alphaTest: 0.01,\n}));\n",
  'web/js/levels/g-nested-literal.js': PM_CODE("  color: new THREE.Color({ r: 1 }),\n  map: tex,"),
  'web/js/levels/h-comment-but-real-map.js':
    PM_CODE("  // 必须给 map\n  map: tex, size: 1,"),
  'web/js/objects/i-vararg.js': "const mat = new THREE.PointsMaterial(OPTIONS);\n",
};

{
  const root = makeProject(PM_BAD);
  const { chk } = await checkOf(root, 'shell.point-materials');
  assert(chk?.level === 'error', '点云缺 map → 报 error', `实际 ${chk?.level}`);
  const missed = Object.keys(PM_BAD).filter((p) => !(chk?.detail || '').includes(p));
  assert(missed.length === 0, `点云缺 map → 四种漏法全部抓出（${Object.keys(PM_BAD).length} 处）`,
    missed.length ? `漏掉：${missed.join('、')}` : '');
  assert(/补上 map/.test(chk?.fix || ''), '点云缺 map → 给出的 fix 是可照做的（不是"检查一下配置"）',
    /补上 map/.test(chk?.fix || '') ? '' : `fix 不合预期：${chk?.fix}`);
}

{
  const root = makeProject(PM_GOOD);
  const { chk } = await checkOf(root, 'shell.point-materials');
  assert(chk?.level === 'ok', '点云写法合法 → 零误报（含「传变量」「注释里有 map」两种易误伤写法）',
    `实际 ${chk?.level} · ${chk?.detail}`);
  // 光断言"没报错"是不够的：样本文件没落到扫描目录里时，检查同样报 ok。
  // 必须对账扫到的处数，否则这条断言会假绿。
  assert(/扫过 web\/js，4 处/.test(chk?.detail || ''),
    '点云合法样本确实被扫描到了（不是"一处都没扫到"的假绿）',
    `实际 ${chk?.detail}`);
}

/* ============================================================
   故障注入：其它几条老坑
   ============================================================ */

{
  // 坑 24：npm 脚本指向空气
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'x', scripts: { verify: 'node tools/verify.mjs' } }),
  });
  const { chk } = await checkOf(root, 'shell.scripts');
  assert(chk?.level === 'error', 'npm 脚本指向空气 → 报 error（坑 24）', `实际 ${chk?.level}`);
}

{
  // 骨架文件缺失
  const root = makeProject({ 'web/index.html': '<html></html>' });
  const { chk } = await checkOf(root, 'shell.core-files');
  assert(chk?.level === 'error', '核心文件缺失 → 报 error', `实际 ${chk?.level}`);
}

{
  // 更名残留：未标记 → 必须报
  const root = makeProject({ 'server/leftover.mjs': "export const OLD = '小小太阳系';\n" }); // 有意保留：测试夹具，故意放一个旧名等扫描器来抓
  const { chk } = await checkOf(root, 'naming.legacy');
  assert(chk?.level === 'warn', '旧名残留且未标记 → 报 warn', `实际 ${chk?.level}`);
}

{
  // 更名残留：行内自证豁免（「更名遗留」）→ 必须放过
  const root = makeProject({
    'server/leftover.mjs': "export const OLD = '小小太阳系';   // 更名遗留：兼容老配置，有意保留\n",
  });
  const { chk } = await checkOf(root, 'naming.legacy');
  assert(chk?.level === 'ok', '旧名带「更名遗留」标记 → 豁免生效，不报（坑 23 的机制）', `实际 ${chk?.level}`);
}

/* ============================================================
   故障注入：源码里写死绝对路径（坑 93）
   ============================================================ */

{
  // 注入：源码里钉死一个盘符路径 → 必须报 error
  const root = makeProject({
    'tools/pinned.mjs': "const ROOT = 'C:/Users/someone/Desktop/proj';\n",   // 测试向量
  });
  const { chk } = await checkOf(root, 'prog.no-abs-paths');
  assert(chk?.level === 'error', '源码里写死盘符绝对路径 → 报 error（坑 93）',
    `实际 ${chk?.level} · ${chk?.detail}`);
}

{
  // 行内自证豁免 → 必须放过。
  // ⚠️ 这个夹具**抓到过我判据自己的 bug**：豁免标记写在行尾注释里，
  //    而判据为了躲开「注释里举的例子」（坑 91）会先把注释剥掉 ——
  //    于是标记也在判豁免之前就被剥没了，4 处已声明的豁免全被报成故障。
  //    修法是「找字面量看剥完的代码，判豁免看原始行」。这条夹具钉住它。
  const root = makeProject({
    'tools/browser.mjs': "const P = 'C:\\\\Program Files\\\\Edge\\\\msedge.exe';   // 外部路径\n",   // 测试向量
  });
  const { chk } = await checkOf(root, 'prog.no-abs-paths');
  assert(chk?.level === 'ok', '写死的路径带「外部路径」行尾标记 → 豁免生效（注释不许把自己剥掉）',
    `实际 ${chk?.level} · ${chk?.detail}`);
}

{
  // 只在注释里提到 → 剥注释后不许命中（坑 91 的同族：注释不是声明）
  const root = makeProject({
    'tools/note.mjs': "// 别写成 C:/Users/x/y 这样\nconst ROOT = 1;\n",   // 测试向量
  });
  const { chk } = await checkOf(root, 'prog.no-abs-paths');
  assert(chk?.level === 'ok', '盘符路径只出现在注释里 → 不算声明',
    `实际 ${chk?.level} · ${chk?.detail}`);
}

{
  // URL 里的 `s://` 不许被误判成盘符路径
  const root = makeProject({
    'tools/net.mjs': "const u = 'https://example.com/a';\n",
  });
  const { chk } = await checkOf(root, 'prog.no-abs-paths');
  assert(chk?.level === 'ok', 'URL 不被误判成盘符绝对路径',
    `实际 ${chk?.level} · ${chk?.detail}`);
}

/* ============================================================
   故障注入：工作区目录名（坑 21）
   ============================================================ */

{
  const root = makeProjectNamed('小小太阳系-假项目', { 'package.json': '{}' });
  const { chk } = await checkOf(root, 'naming.workspace-dir');
  assert(chk?.level === 'warn',
    '工作区目录名带旧名 → 报 warn（坑 21：仓库里改干净了，文件夹名还挂着旧名）',
    `实际 ${chk?.level} · ${chk?.detail}`);
}

{
  const root = makeProject({ 'package.json': '{}' });
  const { chk } = await checkOf(root, 'naming.workspace-dir');
  assert(chk?.level === 'ok', '工作区目录名干净 → 不报（零误报）',
    `实际 ${chk?.level} · ${chk?.detail}`);
}

/* ============================================================
   结构不变量 + 真实项目
   ============================================================ */

const real = await runSelfCheck(ROOT, {});

assert(real.summary.error === 0, '真实项目跑一遍 → 零故障',
  real.checks.filter((c) => c.level === 'error').map((c) => `${c.id}: ${c.detail}`).join('；'));

const noFix = real.checks.filter((c) => !c.fix || !String(c.fix).trim());
assert(noFix.length === 0, '每条检查都给了可执行的 fix', noFix.length ? `缺 fix：${noFix.map((c) => c.id).join('、')}` : '');

const ids = real.checks.map((c) => c.id);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
assert(dup.length === 0, '检查 id 不重复', dup.length ? `重复：${[...new Set(dup)].join('、')}` : '');

// naming.outside-refs 在「校验工具不在 / 根目录没有唯一启动*.bat」时会自己跳过并报 ok ——
// 那对**便携包**是对的（包内可能没带工具），但在**源码仓库**里就等于这个能力悄悄没了。
// 这正是本项目最怕的「静默降级」：看着全绿，其实那项一次都没跑。在这里钉住它。
const outside = real.checks.find((c) => c.id === 'naming.outside-refs');
assert(!!outside, '仓库自检里有 naming.outside-refs（桌面快捷方式这项不能整项缺失）');
assert(!!outside && !/跳过|不在/.test(`${outside.title || ''}${outside.detail || ''}`),
  'naming.outside-refs 真的执行了（不是"工具不在/没有启动器"的静默跳过）',
  outside ? `${outside.title} · ${outside.detail}` : '');

// 反向再验一次：那个"跳过分支"的措辞**确实能被上面那条过滤认出来**。
// 不然哪天有人改一句文案，静默降级就悄悄回来了 —— 而且不会有任何人知道。
{
  const bare = makeProject({ 'server/index.mjs': '// 空项目：故意不放 tools/install-shortcut.mjs\n' });
  const { chk } = await checkOf(bare, 'naming.outside-refs');
  const words = `${chk?.title || ''}${chk?.detail || ''}`;
  assert(chk?.level === 'ok' && /跳过|不在/.test(words),
    '跳过分支报 ok 且措辞可识别（元断言认得出来，不会把"跳过"误读成"已执行"）',
    `实际 ${chk?.level} · ${chk?.title}`);
}

// 隔离区体积告警：造一个**稀疏**的 1.1 GB 文件（truncate，不真占盘），断言它报 warn。
// 直接造真文件不行（1 GB 写入太慢），稀疏文件 stat 出来的 size 就是 1.1 GB，判据够用。
{
  const root = makeProject({ 'server/index.mjs': '// 空项目\n' });
  const stage = path.join(root, '.trash', 'old-stage-2026-01-01T00-00-00');
  mkdirSync(stage, { recursive: true });
  const sparse = path.join(stage, 'big.bin');
  writeFileSync(sparse, '');           // truncateSync 要求文件先存在
  truncateSync(sparse, 1126 * 1048576);
  const { chk } = await checkOf(root, 'env.trash-size');
  assert(chk?.level === 'warn', '隔离区超过 1 GB → 报 warn（阈值逻辑真的生效）',
    `实际 ${chk?.level} · ${chk?.detail}`);

  const bareOk = makeProject({ 'server/index.mjs': '// 空项目\n' });
  const { chk: chkOk } = await checkOf(bareOk, 'env.trash-size');
  assert(chkOk?.level === 'ok', '没有隔离区 → 报 ok（不制造噪声）', `实际 ${chkOk?.level} · ${chkOk?.detail}`);
}

const REQUIRE_GROUPS = ['运行环境', '程序骨架', '数据集与登记表', '人工覆盖与监测', '本地服务', '性能与显卡', '命名一致性'];
const haveGroups = real.groups.map((g) => g.label);
const missGroups = REQUIRE_GROUPS.filter((g) => !haveGroups.includes(g));
assert(missGroups.length === 0, `全部检查组齐全（${REQUIRE_GROUPS.length} 组：${REQUIRE_GROUPS.join(' / ')}）`,
  missGroups.length ? `缺：${missGroups.join('、')}` : '');

/* ============================================================
   输出
   ============================================================ */

for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });

if (asJson) {
  console.log(JSON.stringify({
    ok: failed === 0,
    total: results.length,
    passed: results.length - failed,
    failed,
    results,
    realChecks: real.checks.length,
  }, null, 2));
} else {
  console.log('');
  console.log('  自检器自己的自检 · 故障注入');
  console.log('  ' + '─'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
    if (r.extra) console.log(`      ${r.extra}`);
  }
  console.log('');
  console.log('  ' + '='.repeat(60));
  console.log(`  通过 ${results.length - failed} / ${results.length}   ·   真实项目自检 ${real.checks.length} 项 · ${real.summary.error} 故障`);
  console.log('  ' + '='.repeat(60));
  console.log('');
}

process.exitCode = failed === 0 ? 0 : 1;

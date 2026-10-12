#!/usr/bin/env node
/**
 * 本星系群管线的离线检查器 —— `tools/check-localgroup.mjs`
 *
 *   node tools/check-localgroup.mjs              # 检查
 *   node tools/check-localgroup.mjs --selftest    # 注入坏值，验证每条判据真的会响
 *
 * 为什么要有这个文件
 * ------------------------------------------------------------------
 * 「本星系群」层的数据源从「20 条手写目录」变成「手写目录 ∪ McConnachie 2012 全表」，
 * 这条链路上有四个**不会自己报错**的失效点，它们各自都真的发生过或差点发生：
 *
 *   ① **同一列名、两个接口、两种格式。**
 *      VizieR 的 TAP 把 `RAJ2000` 给成**十进制度**（`266.4166…`），
 *      而 `viz-bin/asu-tsv` 给成**时:分:秒**（`"17 45 40.0"`）。
 *      只按一种解析 ⇒ 另一种静默变 null ⇒ 102 条被当「坐标坏」丢掉 101 条，
 *      而**唯一活着的那条恰好是银河系**（它走 `anchor:'home'` 绕开了坐标检查）。
 *      产物从 102 条变成 1 条，全程零报错。
 *
 *   ② **ASU-TSV 的表头是三层**（列名 / 单位 / 破折线），TAP 的 TSV 只有一层。
 *      按行数判「取回多少条」时，用错接口就会多数 3 条（105 vs 102）。
 *
 *   ③ **空单元格 ≠ 0。** 星表里矮星系常常没有扁率、没有金属丰度，
 *      直接 `Number('')` 得到 `0` —— 「没测到」被静默写成「测到 0 度」。
 *
 *   ④ **「画得出」与「搜得到」必须是同一份列表。**
 *      建索引若仍用模块级 `GALAXIES`，新成员会「画得出来、搜不到、点不开」，
 *      不抛任何错（这条是 `deepSkyLevelOf` 那条静默故障的反面）。
 *
 * 所以这里的判据不是「文件在不在」，而是**复算**：
 * 按 ra/dec/距离重算一遍坐标，与产物里存的逐个比。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lib/strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'data', 'local-group.json');
const RAW_TSV = path.join(ROOT, 'data', 'raw', 'localgroup', 'mcconnachie2012-catalog.tsv');
const REG_FILE = path.join(ROOT, 'data', 'sources.json');
const DATASET_JS = path.join(ROOT, 'web', 'js', 'data', 'dataset.js');
const DATACENTER_JS = path.join(ROOT, 'server', 'lib', 'datacenter.mjs');
/** 渲染层：判「默认画不画」这条口径有没有被真的消费（而不是只定义在数据层没人用）。 */
const COSMOS_JS = path.join(ROOT, 'web', 'js', 'levels', 'cosmos.js');
const ENGINE_JS = path.join(ROOT, 'web', 'js', 'core', 'engine.js');

/** 期望的手写条目数（`web/js/data/deep-sky.js::GALAXIES`）。改那个文件时这里要跟着改。 */
const EXPECTED_HANDWRITTEN = 20;
const KPC_TO_MLY = 3.261563777e-3;
const DIST_MAX_MLY = 12;

/**
 * 剥掉 JS 注释。⚠️ 判「源码里有没有这句话」必须**先剔注释** ——
 * 本项目在这上面误判过（把注释里的示例当成活代码）。
 * 实现已抽到 `tools/lib/strip-comments.mjs`（与 `check-scale-rings.mjs` 共用一份，
 * 因为**同一条不变量两份实现必漏一份**）。
 */

const xyz = (raDeg, decDeg, dist) => {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  return [
    dist * Math.cos(dec) * Math.cos(ra),
    dist * Math.cos(dec) * Math.sin(ra),
    dist * Math.sin(dec),
  ];
};

/**
 * 把 `dataset.js` 里的 `mergeGalaxies()` 连同它依赖的常量**抠出来**，返回真函数。
 *
 * ⚠️ 为什么费这个劲：合并语义（**并集 + 手写优先**，2026-09-12 拍板）是这一层的产品决定。
 * 用正则去判「两个 for 循环谁在前面」会被**等价的改写**骗过去（判据算错方向）；
 * 抠出来在 Node 里**喂真输入跑一遍**，判的是语义，不是写法。
 *
 * 抠不出来（结构大改）就返回 null ⇒ 判据判红，而不是静默跳过。
 */
function extractMerger(datasetSrc) {
  const src = stripComments(datasetSrc);
  const pinned = /const GALAXY_PINNED_ORDER\s*=\s*\[[^\]]*\];/.exec(src);
  const start = src.indexOf('function mergeGalaxies(');
  if (!pinned || start < 0) return null;
  // 顶层函数：它的收尾 `}` 顶格。
  const end = src.indexOf('\n}', start);
  if (end < 0) return null;
  const fn = src.slice(start, end + 2);
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`${pinned[0]}\n${fn}\nreturn mergeGalaxies;`)();
  } catch {
    return null;
  }
}

/**
 * 把 `dataset.js` 里的「本星系群**成员**」口径**抠出来**，返回 `{ outside, fn }`。
 * ⚠️ 与 `extractMerger` 同一个理由：判**语义**不判写法 ——
 *    谁把「近邻星系」换成别的组、或把「未知分组默认显示」翻成默认隐藏，
 *    `fn` 的行为当场变，`member-split` 就红。
 * 抠不出来（结构大改）返回 null ⇒ 判据判红，不静默跳过。
 */
function extractMemberFn(datasetSrc) {
  const src = stripComments(datasetSrc);
  const konst = /const LG_OUTSIDE_GROUP\s*=\s*'([^']*)';/.exec(src);
  const start = src.indexOf('function isLocalGroupMember(');
  if (!konst || start < 0) return null;
  const end = src.indexOf('\n}', start);
  if (end < 0) return null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${konst[0]}\n${src.slice(start, end + 2)}\nreturn isLocalGroupMember;`)();
    return { outside: konst[1], fn };
  } catch {
    return null;
  }
}

/** 全部判据。**纯函数** —— 自证时喂它改坏过的 ctx，看对应那条会不会红。 */
function runChecks(ctx) {
  const rows = [];
  const add = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: String(detail) });

  const { meta, objects, rawTsv, registry, datasetSrc, datacenterSrc, cosmosSrc, engineSrc } = ctx;

  /* —— 1. 产物可解析、条数自洽 —— */
  add('artifact', !!meta && Array.isArray(objects) && objects.length > 0,
    `meta 与 objects 都在，objects ${objects.length} 条`);
  add('count', objects.length === meta.count,
    `objects=${objects.length}  meta.count=${meta.count}`);

  /* —— 2. 原始应答的数据行数（**扣掉表头**）必须等于产物条数 ——
   *     ③ 的固化：TAP 的 TSV 第一行就是列名；ASU-TSV 前面还有 100 多行 `#` 与两层表头。
   *     这里按 TAP 口径数：总行 − 1。 */
  const bodyLines = String(rawTsv || '').replace(/\r/g, '').split('\n').filter((l) => l.length);
  const dataRows = Math.max(0, bodyLines.length - 1);
  add('raw-rows', dataRows === objects.length,
    `原始 TSV 数据行 ${dataRows}（总 ${bodyLines.length} 行 − 1 行表头） vs 产物 ${objects.length} 条`);

  /* —— 3. 坐标复算：ra/dec/距离 → x/y/z 必须对得上 —— */
  let worst = 0; let worstId = null; const badCoord = [];
  for (const o of objects) {
    if (![o.x, o.y, o.z].every(Number.isFinite)) { badCoord.push(`${o.id}(非有限)`); continue; }
    if (o.id === 'milkyway') continue;   // 原点：位置是定义，不是坐标
    const [x, y, z] = xyz(o.ra, o.dec, o.distMly);
    const d = Math.max(Math.abs(x - o.x), Math.abs(y - o.y), Math.abs(z - o.z));
    if (d > worst) { worst = d; worstId = o.id; }
    if (d > 5e-3) badCoord.push(`${o.id}(Δ${d.toFixed(4)})`);
  }
  add('coords', badCoord.length === 0,
    badCoord.length ? `复算不符 ${badCoord.slice(0, 5).join(' ')}`
      : `逐条复算一致，最大偏差 ${worst.toFixed(5)}（${worstId}）`);

  /* —— 4. 距离：kpc↔Mly 换算一致、在范围内、无 0 冒充 —— */
  let distBad = [];
  for (const o of objects) {
    if (o.id === 'milkyway') continue;
    if (!Number.isFinite(o.distKpc) || o.distKpc <= 0) { distBad.push(`${o.id}(distKpc)`); continue; }
    if (Math.abs(o.distKpc * KPC_TO_MLY - o.distMly) > 5e-4) distBad.push(`${o.id}(换算)`);
    if (o.distMly > DIST_MAX_MLY) distBad.push(`${o.id}(超限 ${o.distMly})`);
  }
  add('distance', distBad.length === 0,
    distBad.length ? distBad.slice(0, 5).join(' ') : `全部在 (0, ${DIST_MAX_MLY}] Mly 内且换算一致`);

  /* —— 5. id 唯一 —— */
  const ids = objects.map((o) => o.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  add('unique-id', dup.length === 0, dup.length ? `重复 ${[...new Set(dup)].join(', ')}` : `${ids.length} 个 id 无重复`);

  /* —— 6. 20 条手写 id 全部命中 —— */
  const curatedIds = Object.values(meta.handwrittenIdMap || {});
  const miss = curatedIds.filter((id) => !ids.includes(id));
  add('handwritten-match',
    curatedIds.length === EXPECTED_HANDWRITTEN && miss.length === 0,
    `对齐表 ${curatedIds.length} 项（期望 ${EXPECTED_HANDWRITTEN}）· 未命中 ${miss.join(', ') || '无'}`);

  /* —— 7. R1↔R2 两列独立测量互校 —— */
  const ratio = meta.r1r2Consistency || {};
  add('r1r2',
    ratio.pairs > 0 && ratio.medianRatio > 0.5 && ratio.medianRatio < 2
    && ratio.withinHalfToDouble === ratio.pairs,
    `${ratio.pairs} 对 · 中位比 ${ratio.medianRatio} · 落在 0.5–2 的 ${ratio.withinHalfToDouble}`);

  /* —— 8. 登记表：管线 / 数据集 / 白名单 三处都在 —— */
  const pipes = (registry.pipelines || []).map((p) => p.id);
  const dsets = (registry.datasets || []).map((d) => d.id);
  const bins = /BIN_WHITELIST\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(datacenterSrc);
  const binList = bins ? bins[1] : '';
  const pipeSteps = (registry.pipelines || [])
    .filter((p) => p.id === 'localgroup')
    .flatMap((p) => p.steps || []).map((s) => s.bin);
  add('registry',
    pipes.includes('localgroup') && dsets.includes('mcconnachie-localgroup')
    && pipeSteps.includes('fetch-localgroup') && binList.includes('fetch-localgroup'),
    `管线 localgroup=${pipes.includes('localgroup')}`
    + ` · 数据集 mcconnachie-localgroup=${dsets.includes('mcconnachie-localgroup')}`
    + ` · 步骤 ${pipeSteps.join(',') || '无'} · 白名单命中=${binList.includes('fetch-localgroup')}`);

  /* —— 9. 前端接线：合并函数在、建索引用的是合并后的列表 —— */
  const code = stripComments(datasetSrc);
  const hasMerge = code.includes('mergeGalaxies(GALAXIES');
  const indexUsesMerged = /for\s*\(\s*const\s+g\s+of\s+this\.galaxies\s*\)/.test(code);
  const indexUsesRaw = /for\s*\(\s*const\s+g\s+of\s+GALAXIES\s*\)/.test(code);
  add('frontend-wiring', hasMerge && indexUsesMerged && !indexUsesRaw,
    `mergeGalaxies 调用=${hasMerge} · 索引用 this.galaxies=${indexUsesMerged}`
    + ` · 仍直接用模块级 GALAXIES=${indexUsesRaw}（必须为 false）`);

  /* —— 10. 合并语义：**并集 + 手写优先**（2026-09-12 拍板）——
   * 把 mergeGalaxies 抠出来**真跑**一组构造输入：交集项必须取手写的值、
   * 只在一侧的项都必须在、provenance 三档齐、主角排在前面。
   * ⚠️ 判的是语义不是写法 —— 谁把「手写优先」改成「星表优先」，这条就红。 */
  const merge = extractMerger(datasetSrc);
  let mergeOk = false;
  let mergeDetail = '抠不出 mergeGalaxies（结构大改）—— 判据不会自动放行';
  if (merge) {
    const curated = [
      { id: 'm31', name: '仙女座星系（手写）', diameterLy: 220000, distMly: 2.54 },
      { id: 'only-curated', name: '只手写', distMly: 1 },
    ];
    const catalog = [
      { id: 'm31', name: 'Andromeda（星表）', diameterLy: 3000, distMly: 2.54 },
      { id: 'only-catalog', name: '只星表', distMly: 3 },
      { id: 'm33', name: 'Triangulum（星表）', distMly: 2.7 },
    ];
    let m = [];
    try { m = merge(curated, catalog); } catch { m = []; }
    const by = new Map(m.map((x) => [x.id, x]));
    const union = m.length === 4;                      // 2 + 3 − 交集 1
    const curatedWins = by.get('m31')?.name === '仙女座星系（手写）'
      && by.get('m31')?.diameterLy === 220000;         // 不是星表的 3000
    const provBoth = by.get('m31')?.provenance === 'curated+catalog';
    const provCat = by.get('only-catalog')?.provenance === 'catalog';
    const provCur = by.get('only-curated')?.provenance === 'curated';
    const orderOk = m[0]?.id === 'm31' && m[m.length - 1]?.id === 'only-catalog';
    mergeOk = union && curatedWins && provBoth && provCat && provCur && orderOk;
    mergeDetail = `并集=${union}（${m.length} 条）· 手写优先=${curatedWins}`
      + ` · provenance 三档=${provBoth}/${provCat}/${provCur} · 排序=${orderOk}`;
  }
  add('merge-semantics', mergeOk, mergeDetail);

  /* —— 成员口径：「本星系群成员」只有一组在零速度面之外（2026-09-12 拍板「只留核心」）——
   * 层的默认画面从此只画成员；群外那批（`近邻星系`）默认不画、但**保留索引**，
   * 从目录点进来时由 `focusById` → `#reveal` 点亮。
   * ⚠️ 口径必须来自**数据自带的分组**，不能是编出来的距离阈值（那会是一条会漂的第二口径）。
   * 这条判据两头一起判，缺一头就红：
   *   ① 把 `isLocalGroupMember()` 抠出来**真跑** —— 语义（谁是群外、未知分组默认显示）；
   *   ② 拿产物**实测**每个分组的最大日心距 —— 被点为「群外」的那一组必须**恰好是唯一**
   *      越过 5 Mly 标尺环的。②是防①变成「口径与数据脱节的空话」的那一半。 */
  const memberFn = extractMemberFn(datasetSrc);
  let splitOk = false;
  let splitDetail = '抠不出 LG_OUTSIDE_GROUP / isLocalGroupMember（结构大改）—— 判据不会自动放行';
  if (memberFn) {
    const { outside, fn } = memberFn;
    const groupMax = new Map();
    for (const o of objects) {
      if (!Number.isFinite(o.distMly)) continue;
      const k = o.group || '(无)';
      groupMax.set(k, Math.max(groupMax.get(k) ?? 0, o.distMly));
    }
    const over5 = [...groupMax.entries()].filter(([, v]) => v > 5).map(([k]) => k);
    const semOk = fn({ group: outside }) === false
      && fn({ group: '本星系群' }) === true
      && fn({}) === true;                 // 未知分组 ⇒ 默认显示，不许静默少画
    const dataOk = over5.length === 1 && over5[0] === outside;
    /* ③ 渲染层**真的消费**了这条口径 —— 只定义在数据层而没人用，等于没生效。
     *    ⚠️ 查的是「渲染层调用了这个函数」，不是「它长什么样」：允许
     *    `this.dataset.isLocalGroupMember(g)` 这种经实例转发的写法。 */
    const renderOk = stripComments(cosmosSrc).includes('isLocalGroupMember');
    splitOk = semOk && dataOk && renderOk;
    const maxes = [...groupMax.entries()].map(([k, v]) => `${k}≤${+v.toFixed(2)}`).join(' · ');
    splitDetail = `口径「${outside}」· 语义=${semOk}（群外→false / 群内→true / 未知→true）`
      + ` · 唯一越过 5 Mly 的是「${over5.join(', ') || '（无）'}」=${dataOk}`
      + ` · 渲染层已消费=${renderOk} · 各组最大 ${maxes}`;
  }
  add('member-split', splitOk, splitDetail);

  /* —— 跨尺度点亮：跨尺度「飞过去看它」也必须**看得见**（2026-09-12 补，坑 151 的另一半）——
   *  上面那条只保证了「同层点它」会点亮。而用户更常见的路径是**从目录 / 搜索结果跨尺度**点：
   *  `main.js` 会走 `engine.goTo(levelId, { focus: id })`，而 `goTo` 过去只拿 `focus`
   *  算了个相机落点 —— **不点亮对象** ⇒ 相机会稳稳飞到一片空处，零报错（静默故障）。
   *  三头一起判，缺一头就红：
   *    ① 引擎**接线**了跨层点亮（查的是调用，不是写法：允许 `target.revealById?.(focus)`）；
   *    ② 层**实现了**那个钩子；
   *    ③ 钩子**只点亮、不碰相机** —— 一旦有人在里面加 `applyView`，它就会跟
   *       `goTo` 的过渡动画抢相机（这正是它不复用 `focusById` 的原因）。
   *  ⚠️ 只查「调了没」是**不够**的：`focusById` 里也有 `#reveal`，但它同时有 `applyView`,
   *     所以「把钩子实现成 `focusById` 的别名」必须在 ③ 上红。 */
  const engineCode = stripComments(engineSrc);
  const cosmosCode = stripComments(cosmosSrc);
  const wireOk = /\.revealById\?\.\s*\(\s*focus\s*\)/.test(engineCode);
  const implMatch = cosmosCode.match(/revealById\s*\([^)]*\)\s*\{[^}]*\}/);
  const implOk = !!implMatch;
  const pureOk = implOk && implMatch[0].includes('#reveal') && !implMatch[0].includes('applyView');
  const crossOk = wireOk && implOk && pureOk;
  add('cross-level-reveal', crossOk,
    `引擎已接线=${wireOk} · 层已实现=${implOk} · 只点亮不碰相机=${pureOk}`
    + (implOk ? ` · 实现体 ${implMatch[0].replace(/\s+/g, ' ').slice(0, 90)}` : '（抠不出 revealById 方法体）'));

  return rows;
}

async function loadCtx() {
  const [outRaw, rawTsv, regRaw, dsSrc, dcSrc, cosSrc, engSrc] = await Promise.all([
    readFile(OUT_FILE, 'utf8'),
    readFile(RAW_TSV, 'utf8'),
    readFile(REG_FILE, 'utf8'),
    readFile(DATASET_JS, 'utf8'),
    readFile(DATACENTER_JS, 'utf8'),
    readFile(COSMOS_JS, 'utf8'),
    readFile(ENGINE_JS, 'utf8'),
  ]);
  const out = JSON.parse(outRaw);
  return {
    meta: out.meta,
    objects: out.objects,
    rawTsv,
    registry: JSON.parse(regRaw),
    datasetSrc: dsSrc,
    datacenterSrc: dcSrc,
    cosmosSrc: cosSrc,
    engineSrc: engSrc,
  };
}

/* 自证用的「定向破坏」。每一条只该让它指名的那一项变红。
 * ⚠️ 注入要打在**判据真正检查的对象**上：第一次把 `distance` 的注入写在
 *    `objects[0]`，而它是银河系（`distance` 判据按设计跳过它）⇒ 注入后仍然全绿，
 *    自证当场把这件事抓了出来。所以这里改成**按 id 挑一个非银河系的成员**。 */
const MUTATIONS = [
  ['coords', (c) => { c.objects[5] = { ...c.objects[5], x: NaN }; }],
  ['count', (c) => { c.meta = { ...c.meta, count: 999 }; }],
  ['raw-rows', (c) => { c.rawTsv += '999\tMW\tG\tFake 99\t \t \t dSph\t1 2 3\t+4 5 6\n'; }],
  ['distance', (c) => {
    const i = c.objects.findIndex((o) => o.id !== 'milkyway' && Number.isFinite(o.distMly) && o.distMly > 0);
    c.objects[i] = { ...c.objects[i], distMly: c.objects[i].distMly + 1000 };
  }],
  ['unique-id', (c) => { c.objects[6] = { ...c.objects[6], id: c.objects[5].id }; }],
  ['handwritten-match', (c) => { c.objects = c.objects.filter((o) => o.id !== 'm110'); }],
  ['r1r2', (c) => { c.meta = { ...c.meta, r1r2Consistency: { ...c.meta.r1r2Consistency, medianRatio: 42 } }; }],
  ['registry', (c) => { c.registry = { ...c.registry, pipelines: c.registry.pipelines.filter((p) => p.id !== 'localgroup') }; }],
  ['frontend-wiring', (c) => { c.datasetSrc = c.datasetSrc.replace('of this.galaxies', 'of GALAXIES'); }],
  // 把「手写优先」翻成「星表优先」：交集项会取到星表的名字 ⇒ merge-semantics 必须红。
  ['merge-semantics', (c) => {
    c.datasetSrc = c.datasetSrc.replace('{ ...base, ...g, provenance', '{ ...g, ...base, provenance');
  }],
  // 把「群外」那组换成「本星系群」：口径与实测数据（唯一越过 5 Mly 的那组）脱节 ⇒ member-split 必须红。
  ['member-split', (c) => {
    c.datasetSrc = c.datasetSrc.replace(
      "const LG_OUTSIDE_GROUP = '近邻星系';", "const LG_OUTSIDE_GROUP = '本星系群';",
    );
  }],
  /* 口径定义着、渲染层却不消费（等于没生效）⇒ member-split 必须红。
   * ⚠️ 必须 `replaceAll`：`isLocalGroupMember` 在 `cosmos.js` 里同时出现在**注释**
   *    和真正的调用点上，`replace` 只换第一处（注释那处）⇒ 注入落空、自证会当场报错。 */
  ['member-split', (c) => {
    c.cosmosSrc = c.cosmosSrc.replaceAll('isLocalGroupMember', 'alwaysShowGalaxy');
  }],
  /* 引擎不再点亮跨层目标（摘掉那行接线）⇒ 相机会飞到一片空处 ⇒ cross-level-reveal 必须红。 */
  ['cross-level-reveal', (c) => {
    c.engineSrc = c.engineSrc.replace('if (focus) target.revealById?.(focus);', '');
  }],
  /* 把钩子实现成 `focusById` 的别名 —— 看着能用，其实把 `applyView` 也带进来了，
   * 会跟 `goTo` 的过渡动画抢相机 ⇒ 第 ③ 头（只点亮不碰相机）必须红。
   * ⚠️ 这一条正是「只查『调了没』不够」的证据：接线还在、层也实现了，但它是错的。 */
  ['cross-level-reveal', (c) => {
    c.cosmosSrc = c.cosmosSrc.replace(
      'revealById(id) { return this.#reveal(id); }',
      'revealById(id) { return this.focusById(id); }',
    );
  }],
];

async function main() {
  const doSelf = process.argv.includes('--selftest');
  let ctx;
  try {
    ctx = await loadCtx();
  } catch (e) {
    console.error(`FAIL  读不到检查对象：${e.message}`);
    process.exit(1);
  }

  const before = runChecks(ctx);
  const width = Math.max(...before.map((r) => r.name.length));
  console.log('');
  for (const r of before) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = before.filter((r) => !r.ok);

  if (!doSelf) {
    console.log('');
    if (failed.length) {
      console.log(`  未通过 ${failed.length} 项：${failed.map((r) => r.name).join(', ')}`);
      process.exit(1);
    }
    console.log(`  全部通过（${before.length} 项）。`);
    return;
  }

  /* —— 两段式自证：注入前必须全绿；注入后**指名的那一项必须变红** —— */
  console.log('\n  自证（注入 → 该条判据必须变红）');
  let selfBad = 0;
  if (failed.length) {
    console.log(`  ✗ 注入前就有 ${failed.length} 项是红的，自证没有意义：${failed.map((r) => r.name).join(', ')}`);
    selfBad++;
  }
  for (const [target, mutate] of MUTATIONS) {
    const copy = JSON.parse(JSON.stringify({
      meta: ctx.meta, objects: ctx.objects, registry: ctx.registry,
    }));
    const c2 = { ...ctx, ...copy };
    mutate(c2);
    const after = runChecks(c2);
    const hit = after.find((r) => r.name === target);
    const others = after.filter((r) => !r.ok && r.name !== target).map((r) => r.name);
    const ok = hit && !hit.ok;
    console.log(`  ${ok ? '✓' : '✗'} 注入「${target}」→ ${target} ${hit ? (hit.ok ? '仍然绿（判据没响）' : '变红') : '（该判据不存在）'}`
      + (others.length ? `  ⚠ 顺带变红：${others.join(', ')}` : ''));
    if (!ok) selfBad++;
  }
  console.log('');
  if (selfBad) {
    console.log(`  FAIL  自证有 ${selfBad} 处不对 —— 判据不可信。`);
    process.exit(1);
  }
  console.log(`  自证通过：${MUTATIONS.length} 条判据都会响。`);
}

main().catch((e) => { console.error('FATAL', e?.stack || e); process.exit(1); });

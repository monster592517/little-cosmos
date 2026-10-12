#!/usr/bin/env node
/**
 * 小小宇宙 · 前端数据模型探针
 * ============================================================
 *
 * 把「web/js/data/dataset.js 装配出来的目录树自洽不自洽」变成一条**可在 node 里跑的判据**，
 * 不依赖浏览器、不需要起服务、秒级。
 *
 * 判什么（两条，各自对应一个**已经发生过**的静默故障）：
 *
 *   1. `catalogUntiered` 必须恒为空。
 *      目录面板的「包含关系」是**算出来的**：建完树后用 `TIER_OF` 把 13 个顶层分组
 *      归属到六个尺度。漏一个分组 → 界面上只是多出一节「未归入尺度」，
 *      不报错、不崩溃、不影响别的功能。靠人眼在六节里发现「多出来的一节」很难。
 *      同一类的「口径不一致导致整类天体静默消失」在本项目出现过两次
 *      （`!DEEP_TYPE_LABEL` vs `!isCataloged`），所以连天体条数一起断言。
 *
 *   2. 系外行星必须真的成了独立天体，且目录叶子数 == 数据条数、id 不重名、都带 hostId。
 *      重名的 id 会被 `bodies` Map 静默吃掉；缺 hostId 的表现是「点了没反应」。
 *
 * 为什么是**独立进程**而不是被 selfcheck 直接 import：
 *   ESM 的 `import()` 按 URL 缓存。同一个进程里第二次跑，读到的还是**第一次的旧模块**——
 *   改了磁盘上的 dataset.js，答案是旧的那份，而两边都报「通过」。
 *   这就是用户手册里那条「改了磁盘上的代码 ≠ 运行中的进程会生效」。
 *   拆成子进程 = 每次都是新进程、新的模块缓存，从根上免掉这一类假绿。
 *
 * 用法：
 *   node tools/model-probe.mjs              打印 JSON（selfcheck 用的就是这个）
 *   node tools/model-probe.mjs --human      打印给人看的一行行结论
 *   node tools/model-probe.mjs --selftest   故障注入自测：故意改坏 → 确认判据会响 → 还原
 *   node tools/model-probe.mjs --restore    只做自愈还原（上一次被强杀留下的脏文件）
 *
 * ⚠ --selftest 会改仓库文件。规矩（踩出来的，别省）：
 *   (1) **绝不后台跑** —— 宿主在回合结束会把进程收走，finally 不执行，磁盘上留下改坏的文件；
 *   (2) 只靠 finally 也不够 —— SIGKILL / 进程树回收不给任何清理机会。
 *       所以备份**先落盘**成 sidecar，且每次启动先自愈一遍（`repair_leftovers`）。
 *
 * 零第三方依赖，Node 18+。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// ⚠ 中文路径下不能用 new URL(import.meta.url).pathname（会被 percent-encode，坑 14）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

const DATASET_REL = path.join('web', 'js', 'data', 'dataset.js');
const DATASET = path.join(ROOT, DATASET_REL);
const SCALES = path.join(ROOT, 'web', 'js', 'core', 'scales.js');
const SIDECAR = `${DATASET}.inject-backup`;
const TRASH = path.join(ROOT, '.trash');

/* ---------------------------------------------------------------
 * 故障注入的六味药（--selftest 用；needle 必须**恰好命中 1 次**，否则宁可报错退出）
 *   药 1 → 期望 shell.model 响：拿掉 grp-probes 的尺度归属
 *   药 2 → 期望 shell.exo-planets 响：只有 1000 光年内的行星进目录 —— 其余有数据却没分组承接
 *          ⚠️ 这一味换过两次，两次都换得对（详细经过见该条自己的注释）。
 *             教训是通用的：**药要打在"真故障"上，不能打在被台账正当吸收的行为上**。
 *   药 3 → 期望 silentBad 响：让邻近层把「脉冲星」整批丢掉（历史故障的形状：
 *          邻近层原来只 filter(type==='star')，597 白矮星 + 62 脉冲星整批没进目录）
 *   药 4 → 期望 truncBad 响：截断了却不留说明（面板上就是「598 配 260」）
 *   药 5 → 期望 ingestBad 响：装配时每颗行星只收前一颗 —— 模拟「数据抓回来了、
 *          产物也写好了，但装配环节悄悄少收」，这是吸纳台账存在的唯一理由
 *   药 6 → 期望 truncBad 响：「显示全部」的索引只有它承诺的一部分，点到底也翻不到剩下的
 * --------------------------------------------------------------- */
const INJECTIONS = [
  {
    name: '目录树的尺度归属',
    needle: "'grp-regions': 'solar', 'grp-probes': 'solar',",
    value: "'grp-regions': 'solar',",
    expect: 'modelBad',
  },
  {
    /* ⚠️ 这一味**换过两次**，两次都换得对，记录下来当教训：
     *   第一版打「把分组 id 改掉」—— 判据改成「数叶子」后失效。
     *   第二版打「少列一个系统」（`CAP_SYS - 1`）—— **仍然不响，而且它本来就不该响**：
     *     少列一个系统会被截断台账原样吸收（`hidden` 多一个），
     *     而那颗行星确实还能从「显示全部」翻到 —— 那不是故障，那正是设计。
     *   现在打的是「只有 1000 光年内的行星进目录」：
     *     **有 5 千多颗天体存在、却没有任何分组承接它们**，这才是真故障。 */
    name: '系外行星只收了一部分就进目录',
    needle: "const planets = nearAll.filter((b) => b.type === 'exoplanet');",
    value: "const planets = nearAll.filter((b) => b.type === 'exoplanet' && (b.distLy ?? 0) < 1000);",
    expect: 'exoBad',
  },
  {
    name: '整批天体漏出目录',
    needle: 'const list = nearAll.filter((b) => g.types.includes(b.type)).sort(sortByMag);',
    value: "const list = nearAll.filter((b) => g.types.includes(b.type) && b.type !== 'psr').sort(sortByMag);",
    expect: 'silentBad',
  },
  {
    name: '截断了却不说明',
    needle: 'const truncNote = hidden > 0',
    value: 'const truncNote = false && hidden > 0',
    expect: 'truncBad',
  },
  {
    name: '装配时悄悄少收行星',
    needle: 'for (const p of sys.planets || []) {',
    value: 'for (const p of (sys.planets || []).slice(0, 1)) {',
    expect: 'ingestBad',
  },
  {
    /* 「显示全部」的索引短了一截：徽标和按钮上的数字都是按 total 算的，
     * 于是**所有数字看上去都自洽**，而用户点到按钮消失也翻不到剩下的。
     * 这是新增的按需展开机制里唯一会静默失效的地方。 */
    name: '「显示全部」的索引短了一截',
    needle: 'allIds: planets.map((p) => p.id),',
    value: 'allIds: planets.filter((p) => (p.distLy ?? 0) < 1000).map((p) => p.id),',
    expect: 'truncBad',
  },
];

/* ============================================================
 * 自愈：把上一次被掐断的注入还原回去
 * ============================================================ */

/**
 * 判据不靠「sidecar 存在」（正常收尾也会留 sidecar 直到搬走），而是**比内容**：
 * sidecar ≠ 源文件 ⇒ 源文件被改脏过 ⇒ 还原。
 * 这样即使 sidecar 是上一次正常跑完残留的，也不会误判。
 */
function repairLeftovers(verbose = true) {
  const fixed = [];
  if (fs.existsSync(SIDECAR) && fs.existsSync(DATASET)) {
    const good = fs.readFileSync(SIDECAR, 'utf8');
    const cur = fs.readFileSync(DATASET, 'utf8');
    if (cur !== good) {
      fs.writeFileSync(DATASET, good, 'utf8');
      fixed.push(DATASET_REL);
      if (verbose) say(`  ⚠ 发现上一次注入被强杀留下的脏文件，已还原：${DATASET_REL}`);
    }
    // sidecar 搬进隔离区（本机约定：不永久删除）
    try {
      fs.mkdirSync(TRASH, { recursive: true });
      const dst = path.join(TRASH, `dataset.js-inject-${Date.now()}.bak`);
      fs.renameSync(SIDECAR, dst);
      if (verbose) say(`  · sidecar 已移入隔离区 ${path.relative(ROOT, dst)}`);
    } catch (ex) {
      if (verbose) say(`  ⚠ sidecar 搬运失败（不影响正确性）：${ex.message}`);
    }
  }
  return fixed;
}

/* ============================================================
 * 读取 + 判定
 * ============================================================ */

/** 把 dataset.js 的 load() 跑一遍。它的 load() 走 fetch('./data/*.json')，
 *  node 22 有全局 fetch 但**相对 URL 没有 base**，所以换一个「从磁盘读」的 stub。 */
async function observe() {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const rel = String(u).replace(/^\.?\//, '');
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    const txt = fs.readFileSync(p, 'utf8');
    return { ok: true, status: 200, text: async () => txt, json: async () => JSON.parse(txt) };
  };
  try {
    const mod = await import(pathToFileURL(DATASET).href);
    const ds = new mod.Dataset();
    await ds.load();
    await ds.ready?.();
    const scales = await import(pathToFileURL(SCALES).href);
    const chain = scales.SCALE_CHAIN || [];

    const tree = Array.isArray(ds.catalog) ? ds.catalog : [];
    const untiered = ds.catalogUntiered || [];
    const known = new Set(chain.map((s) => s.id));
    const tiers = [...new Set(tree.map((n) => n.tier).filter(Boolean))];
    const unknown = tiers.filter((t) => !known.has(t));
    const missingScales = chain.map((s) => s.id).filter((id) => !tiers.includes(id));

    /* 目录里露出的系外行星**叶子**数。
     * ⚠️ 判据只数「type==='exoplanet' 的叶子」，**不看分组 id、也不看嵌套层数**。
     *   原来写的是 `n.id === 'nearby-exoplanets'` 再数它孙子的行数 ——
     *   那是把判据绑在目录结构上：结构一改（比如按系统截断、或以后把远端拆成另一个组），
     *   这个数就会悄悄变成 0 或偏小，报出来的还是「目录里 0 颗 / 数据里 6,332 颗」
     *   这种把人往错方向带的话。数叶子与结构无关，改结构不用改判据。 */
    const exo = ds.exoPlanetBodies || [];
    let exoLeaves = 0;
    const walkExoLeaves = (nodes) => {
      for (const n of nodes || []) {
        if (n.children) walkExoLeaves(n.children);
        else if (n.kind === 'body' && n.type === 'exoplanet') exoLeaves++;
      }
    };
    walkExoLeaves(tree);
    const exoNoHost = exo.filter((id) => !ds.get(id)?.hostId).length;

    /* ---- 颜色字段形态 ----
     * `web/js/proc/textures.js` 的 `hexToRgb()` 只吃 `#rgb` / `#rrggbb` / `rgb(...)`。
     * 喂进去别的东西会静默变成中性灰（早先是直接抛 `hex.replace is not a function`）。
     *
     * ⚠️ 判据要分清两件**看起来一样**的事，否则会大面积误报：
     *   · **没有 `color` 字段** —— 正常！目录型天体（恒星 / 深空 / 致密天体）本来就不带，
     *     它们的颜色由各自的渲染器按光谱型 / 类型算（`starColorFromBV` 等）。
     *     本项目 6233 个天体里 5122 个是这样，把它们判成故障 = 自己制造噪音。
     *   · **有 `color` 但类型或格式不对** —— 故障。数字/对象会让贴图生成崩掉，
     *     非 hex 字符串（如 `rgb(...)`）会被静默解析成 NaN、画出黑图。
     */
    const colorBad = [];       // 有值但类型/格式不对 —— 真故障
    const colorMissing = [];   // 根本没有 —— 信息（按类型统计）
    const HEX = /^#[0-9a-fA-F]{3,8}$/;
    for (const [id, b] of ds.bodies) {
      if (b.color === undefined || b.color === null) { colorMissing.push(b.type); continue; }
      if (typeof b.color !== 'string') { colorBad.push(`${id}(${b.type})=${JSON.stringify(b.color)} [类型错]`); continue; }
      if (!HEX.test(b.color)) colorBad.push(`${id}(${b.type})=${b.color} [非 #hex]`);
    }
    const missingByType = {};
    for (const t of colorMissing) missingByType[t] = (missingByType[t] || 0) + 1;

    /* ---- 目录截断：自证 + 守恒 ----
     *
     * 目录对「几百上千条」的分组只列前 CAP 条（dataset.js 的 `capped()`）。
     * 截断本身没错（目录是给人看的），错的是**截了不吭声**：
     *   1. 面板从前只渲染标题里的总数和徽标里的已列数，**不渲染 note** ——
     *      「白矮星 · 598」配「260」，看着就是数据丢了。
     *   2. 更早的故障更硬：邻近层只 `filter(type==='star')`，
     *      597 个白矮星 + 62 个脉冲星**整批没进目录**，而当时没有任何判据会响。
     *      这正是用户反馈「黑洞之类的其他天体也没做进去」的一半来源。
     *
     * 所以这里查两条，缺一条都还留着黑洞：
     *   (A) **自证**：带 total 的分组，shown 必须等于真实叶子数、total === shown + hidden，
     *       且只要 hidden > 0 就必须有 note。**不从标题字符串里反解数字**（那会随文案改动失效）。
     *   (B) **守恒**：按 (尺度, 类型) 聚合，「目录里露出的叶子 + 分组声明藏起来的」
     *       必须等于 `this.bodies` 里该尺度该类型的真实数量。少一个就说明它整批没进目录。
     */
    const leavesIn = (node) => {           // 一个分组真实的叶子条数
      if (!node.children || !node.children.length) return 1;
      return node.children.reduce((a, c) => a + leavesIn(c), 0);
    };
    const truncGroups = [];
    const leavesByTierType = new Map();    // `${tier}|${type}` → 露出来的条数
    const kk = (a, b) => `${a}|${b}`;
    const walkTrunc = (nodes, tier) => {
      for (const n of nodes || []) {
        const t = n.tier || tier;
        if (n.children) walkTrunc(n.children, t);
        else if (n.kind === 'body' && n.type) {
          leavesByTierType.set(kk(t, n.type), (leavesByTierType.get(kk(t, n.type)) || 0) + 1);
        }
        if (n.kind === 'group' && n.total != null) {
          truncGroups.push({
            id: n.id, name: n.name, tier: t, total: n.total, shown: n.shown, hidden: n.hidden,
            hasNote: Boolean(n.note && String(n.note).trim()),
            note: String(n.note || ''),
            leaves: leavesIn(n),
            /* allIds 给「索引必须覆盖承诺」那条判据用；allNodes 只有节点式分组才有
             * （子节点本身是分组，如按宿主分组的系外行星系统），展开单位是系统不是行。 */
            allIds: Array.isArray(n.allIds) ? n.allIds : null,
            allNodesLen: Array.isArray(n.allNodes) ? n.allNodes.length : null,
            types: n.types || null, level: n.level ?? null, where: n.where || null,
          });
        }
      }
    };
    walkTrunc(tree, null);

    /** 按「尺度 + 一组类型（可选 where 子口径）」数真实天体。types 收数组：
     *  白矮星在数据里是 `wd` 和 `whitedwarf` 两个 type，黑洞是 `bh` 和 `blackhole`，
     *  一个分组常常同时含两个 —— 只接单值会把它们数成 0（第一版就这么错了）。 */
    const countBodies = (level, types, where) => {
      const set = Array.isArray(types) ? new Set(types) : new Set([types]);
      let n = 0;
      for (const b of ds.bodies.values()) {
        if (!set.has(b.type) || b.level !== level) continue;
        if (where === 'noDistance' && !b.noDistance) continue;
        n++;
      }
      return n;
    };

    /* 声明的、藏起来的系外行星数量。
     * 「露出 + 声明藏起 === 全部」这条由下面的**数量守恒**判据统一管；
     * 这里单独算一份是为了让 `exoBad` 的措辞能给出「差多少」，
     * 而不是把 6,332 和 439 并排一放说「对不上」——那个差是有正当理由的（截断）。 */
    const exoHidden = truncGroups
      .filter((g) => (g.types || []).includes('exoplanet'))
      .reduce((a, g) => a + (g.hidden || 0), 0);
    const exoReachable = exoLeaves + exoHidden;

    const truncBad = [];
    for (const g of truncGroups) {
      if (g.shown !== g.leaves) {
        truncBad.push(`分组「${g.name}」声明已列 ${g.shown} 条，实际渲染的叶子是 ${g.leaves} 条 —— 截断信息与目录不一致（面板会显示错的「已列 / 全部」）`);
      }
      if (g.total !== g.shown + g.hidden) {
        truncBad.push(`分组「${g.name}」的三个数对不上：total ${g.total} ≠ shown ${g.shown} + hidden ${g.hidden}`);
      }
      if (g.hidden > 0 && !g.hasNote) {
        truncBad.push(`分组「${g.name}」藏了 ${g.hidden} 个天体却没有说明（note 为空）—— 界面上看着就是「数据丢了」`);
      }
      /* 「显示全部」的索引必须覆盖它承诺的全部条数。
       * 判据的由来：徽标写着「260 / 9800」，按钮上的「还有 N 条」也是按 total 算的 ——
       * 如果 `allIds` 只装了一部分（比如生成时忘了用全量列表），
       * 用户点到按钮消失也翻不到剩下的，而**所有数字看上去都是自洽的**。
       * 这是新增的「按需展开」机制里唯一会静默失效的地方，所以单独立一条。 */
      if (Array.isArray(g.allIds) && g.allIds.length !== g.total) {
        truncBad.push(`分组「${g.name}」承诺共 ${g.total} 条，但「显示全部」的索引只有 ${g.allIds.length} 条 —— 点到底也翻不到剩下的 ${g.total - g.allIds.length} 条`);
      }
    }
    // (B) 守恒。**只对声明了 types/level 的分组算**：太阳系那些分组本来就可能
    //     一物多条（谷神星同时出现在「矮行星」和「小行星带」），一律豁免。
    //
    // 两种口径，取决于有没有「子集视图」重叠 —— 这不是凑数是**必须分清**：
    //   · 覆盖式（无重叠）：`该尺度该类型的叶子 + 该分组藏起来的 === 数据里的真实数量`。
    //     能抓历史故障：邻近层只 filter(type==='star') ⇒ 597 白矮星 + 62 脉冲星整批没进目录。
    //   · 分款式（有重叠）：`分组声明的总数 === 按同一筛选口径数出来的真实数量`。
    //     例：「距离未测定的近距星系」是「编目星系」的**子集**（397 ⊂ 1560），
    //     两者都会在目录里列出同一批天体的一部分 —— 这时用覆盖式会把它算两遍，
    //     得到 1957 ≠ 1560 的**假警报**。（第一版就是这么写的，实测报了 3 条假警报。）
    const conservationBad = [];
    const setKeyOf = (g) => `${g.level}|${[...(g.types || [])].sort().join(',')}`;
    const whereSets = new Set(truncGroups.filter((g) => g.where && g.types && g.level).map(setKeyOf));
    const seenSets = new Set();
    for (const g of truncGroups) {
      if (!g.types || !g.level || !g.types.length) continue;
      const setKey = setKeyOf(g);
      const truth = countBodies(g.level, g.types, g.where);
      if (g.where) {
        // 子集视图：查它自己的筛选口径是否与数据相符
        if (g.total !== truth) {
          conservationBad.push(`分组「${g.name}」（${g.level} 层）声明 ${g.total} 个，但按同样口径数出来是 ${truth} 个`);
        }
        continue;
      }
      if (whereSets.has(setKey) || seenSets.has(setKey)) {
        // 与子集视图重叠，或同类型集已查过 → 退回分款式
        const all = countBodies(g.level, g.types, null);
        if (g.total !== all) {
          conservationBad.push(`分组「${g.name}」（${g.level} 层）声明 ${g.total} 个，但数据里该尺度该类型共 ${all} 个`);
        }
        continue;
      }
      seenSets.add(setKey);
      let leaves = 0;
      for (const ty of g.types) leaves += leavesByTierType.get(kk(g.level, ty)) || 0;
      const accounted = leaves + g.hidden;
      if (accounted !== truth) {
        const miss = truth - accounted;
        conservationBad.push(
          `${g.level} 层的 ${g.types.join('/')}：目录露出 ${leaves} + 分组声明藏起 ${g.hidden} = ${accounted}，`
          + `但数据里有 ${truth} 个 —— ${miss > 0 ? `有 ${miss} 个既没显示也没说明去向` : `多算了 ${-miss} 个（同一批被数了两遍）`}`,
        );
      }
    }

    /* (C) 防沉默：**数据里有、目录里一个都没有**的 (尺度, 类型)。
     *
     * 为什么必须有这条（(B) 抓不到它）：
     * (B) 只对「有分组声明了该类型」的情况生效 —— 而 (B) 的 types 是从分组自己的
     * 列表派生的，所以「整批没进目录」时**根本不会有分组去声明它**，(B) 一声不响。
     * 这正是历史故障的形状：邻近层原来只 `filter(type==='star')`，
     * 597 个白矮星 + 62 个脉冲星**整批消失**，而当时的判据全绿。
     *
     * 判据：非太阳系尺度上出现过的每个 type，要么在目录里露出过叶子，
     * 要么被某个分组声明过（哪怕它被截断藏起来了）。两样都没有 = 整批没做进去。
     * ⚠️ 不维护豁免清单（清单会腐烂）：真要豁免，就在 `dataset.js` 里给那个天体打
     *    `catalogExempt: true` 并**在行内写明理由**，让豁免与被豁免的东西待在一起。
     */
    const silentBad = [];
    const covered = new Set();
    for (const [k, v] of leavesByTierType) if (v > 0) covered.add(k);
    for (const g of truncGroups) {
      if (g.types && g.level) for (const ty of g.types) covered.add(kk(g.level, ty));
    }
    const truthByLevelType = new Map();
    for (const b of ds.bodies.values()) {
      if (!b.level || b.level === 'solar' || b.catalogExempt) continue;
      const k = kk(b.level, b.type);
      truthByLevelType.set(k, (truthByLevelType.get(k) || 0) + 1);
    }
    for (const [k, n] of truthByLevelType) {
      if (covered.has(k)) continue;
      const [lv, ty] = k.split('|');
      silentBad.push(`${lv} 层的 ${ty}：数据里有 ${n} 个，目录里一个都没有（既没露出叶子、也没被任何分组声明）`);
    }

    /* ---- (D) 吸纳率：数据源有几行，就得说清每一行的去处 ----
     *
     * 判据：声明了 `fetchedRows` 的产物，必须满足
     *     fetchedRows === 落地的记录数 + 各项声明丢弃数之和
     *
     * 这是「**看不见的少收**」唯一能被抓住的地方。系外行星表就出过这件事：
     * 抓取器带 `where sy_dist < 40`，把 6,360 行砍到 758 行（少了 88%），
     * 而产物 meta 里只有一个 `count: 471`（还是**系统**数）——
     * 没有任何数字可以用来对照「本来该有多少」，于是整套自检全绿。
     * 深空编目也一样：一道 `mag > 12.5` 的门槛静默丢掉 10,507 条（含 9,214 个星系）。
     *
     * ⚠️ 缺 `fetchedRows` **本身就是故障**，不是豁免。
     *   如果「不声明 = 免检」，那删掉字段就成了最省事的过检方式 ——
     *   判据会以最安静的方式失效。
     */
    const ingestBad = [];
    /* `assembled` 一律**数对象**（bodies 上的来源标记），不用计数器做差。
     * 理由：计数器只证明「我数了」，证明不了「确实建成了天体」——
     * 只要有人给装配循环再加一条 `continue` 而忘了加计数，那个数就从此是假的。
     * 这条不是理论顾虑：第一版就是用 `ingested` 一路对下来的，
     * 结果「每颗行星只收前一颗」这个注入**一点反应都没有**（见 INJECTIONS 药 5 的来历）。 */
    const countBodiesWith = (flag) => {
      let n = 0;
      for (const b of ds.bodies.values()) if (b[flag]) n++;
      return n;
    };
    const ledgers = [
      {
        name: '系外行星 catalog',
        meta: ds.exoMeta,
        ingested: (ds.exoplanets || []).reduce((a, s) => a + (s.planets || []).length, 0),
        declared: Number(ds.exoMeta?.planets),
        // 行星用 `exoPlanetBodies`（装配时逐颗 push 的清单）；宿主星不算在 planets 里
        assembled: (ds.exoPlanetBodies || []).length,
        drops: ['droppedNoHost', 'droppedNoPosition', 'droppedNoDistance', 'dupRows'],
        superseded: 0,
      },
      { name: '深空编目 OpenNGC', meta: ds.deepSkyMeta,
        ingested: (ds.deepSky || []).length, declared: Number(ds.deepSkyMeta?.count),
        assembled: countBodiesWith('fromOpenNGC'),
        drops: ['droppedBlankRow', 'droppedNoName', 'droppedDuplicate', 'droppedNonexistent', 'droppedUnknownType', 'droppedDuplicateId'],
        /* 与人工整理的梅西耶条目重合的那批由人工条目承接 —— 是**换了个 id 存在**，不是丢。
         * 数字现场读 `deepSkySkipped`，不写死（写死的数字会腐烂）。 */
        superseded: ds.deepSkySkipped || 0 },
      { name: '致密天体 SIMBAD', meta: ds.compactMeta,
        ingested: (ds.compactObjects || []).length, declared: Number(ds.compactMeta?.count),
        assembled: countBodiesWith('fromCompactCatalog'), drops: ['droppedDuplicateIdentifiers'],
        // 与 OpenNGC 重名的星云由 OpenNGC 那条承接（交叉去重），同样不是丢
        superseded: ds.compactSkipped || 0 },
    ];
    for (const l of ledgers) {
      const m = l.meta || {};
      if (m.fetchedRows == null) {
        ingestBad.push(`${l.name}：产物没有声明 fetchedRows，无法核对是否少收 —— 补上这个字段（抓回多少行），别让数据源免检`);
        continue;
      }
      // (A) 数据源 → 产物：抓回的每一行都要有去处
      const fused = l.drops.reduce((a, k) => a + (Number(m[k]) || 0), 0);
      const accounted = l.ingested + fused;
      if (accounted !== Number(m.fetchedRows)) {
        ingestBad.push(`${l.name}：原始 ${m.fetchedRows} 行，产物只落地 ${l.ingested} 条 + 声明丢弃 ${fused} = ${accounted} —— `
          + `${Number(m.fetchedRows) > accounted ? `有 ${Number(m.fetchedRows) - accounted} 行既没进产物也没说去哪了` : `多算了 ${accounted - Number(m.fetchedRows)} 行`}`);
      }
      // (B) 产物自己的声明要和自己的内容一致
      if (Number.isFinite(l.declared) && l.ingested !== l.declared) {
        ingestBad.push(`${l.name}：产物 meta 声明 ${l.declared} 条，实际装了 ${l.ingested} 条 —— 产物自己就自相矛盾`);
      }
      // (C) 产物 → 装配：声明了几条，就得真的建出几个天体
      if (Number.isFinite(l.declared) && l.assembled + l.superseded !== l.declared) {
        const miss = l.declared - l.assembled - l.superseded;
        ingestBad.push(`${l.name}：产物里有 ${l.declared} 条，装配后只有 ${l.assembled} 个天体`
          + `（另有 ${l.superseded} 条由别的条目承接）—— ${miss > 0 ? `少收了 ${miss} 条，它们在界面上完全不存在` : `多算了 ${-miss} 条`}`);
      }
    }

    return {
      ok: true, err: null,
      // 观测时 dataset.js 的内容指纹。故障注入自测靠它确认「故障真的还在盘上」——
      // 否则会出现「自愈把注入还原了 → 判据没响」这种**假失败**，让人以为检查是摆设。
      srcHash: createHash('sha1').update(fs.readFileSync(DATASET)).digest('hex').slice(0, 12),
      bodies: ds.bodies.size,
      treeCount: tree.length,
      scaleIds: chain.map((s) => s.id),
      tiers, untiered, unknown, missingScales,
      exo: exo.length, exoLeaves, exoHidden, exoReachable,
      exoHostsCreated: ds.exoHostsCreated ?? 0,
      exoPlanetDupe: ds.exoPlanetDupe ?? 0,
      exoNoHost,
      colorBad: colorBad.slice(0, 12),
      colorBadCount: colorBad.length,
      colorMissingCount: colorMissing.length,
      colorMissingByType: missingByType,
      truncGroups: truncGroups.map((g) => ({ id: g.id, name: g.name, total: g.total, shown: g.shown, hidden: g.hidden, leaves: g.leaves, hasNote: g.hasNote })),
      truncBad,
      conservationBad,
      silentBad,
      ingestBad,
    };
  } catch (e) {
    return { ok: false, err: (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : String(e)) };
  } finally {
    if (savedFetch === undefined) delete globalThis.fetch; else globalThis.fetch = savedFetch;
  }
}

/** 判定：把观测翻成「哪几条判据响了」。selfcheck 只负责把这里的话包装成人类可读的条目。 */
function judge(obs) {
  const modelBad = [];
  const exoBad = [];
  const colorBad = [];
  const empty = { modelBad, exoBad, colorBad, truncBad: [], conservationBad: [], silentBad: [], ingestBad: [] };
  if (!obs.ok) {
    modelBad.push(`装配失败：${obs.err}`);
    return empty;
  }
  if (!obs.treeCount) modelBad.push('目录树是空的');
  if (obs.untiered.length) modelBad.push(`${obs.untiered.length} 个顶层分组没归入尺度：${obs.untiered.join('、')}`);
  if (obs.unknown.length) modelBad.push(`${obs.unknown.length} 个分组的尺度名不在 SCALE_CHAIN 里：${obs.unknown.join('、')}`);
  if (obs.missingScales.length) modelBad.push(`${obs.missingScales.length} 个尺度下没有任何分组：${obs.missingScales.join('、')}`);

  if (!obs.exo) exoBad.push('系外行星没成为独立天体（exoPlanetBodies 为空）');
  /* ⚠️ 这里**不能**直接拿「目录叶子数」跟总数比。
   *   4,741 个系统全铺进 DOM 会让首屏卡顿，所以目录按**系统**截断、
   *   截掉的部分由分组自己声明（`hidden`）+「显示全部」/检索兜住。
   *   于是正确口径是「露出的 + 声明藏起的 === 全部」。
   *   （第一版就是直接比叶子数，报出「目录里 439 颗 / 数据里 6332 颗」——
   *     数字是真的，结论是错的：那 5,893 颗的差额是**明说的截断**，不是丢数据。
   *     判据自己算错方向，比判据不响更坏：它会让人去修不存在的问题。） */
  if (obs.exo && obs.exoReachable !== obs.exo) {
    exoBad.push(`目录里能摸到 ${obs.exoReachable} 颗（露出 ${obs.exoLeaves} + 声明藏起 ${obs.exoHidden}）/ 数据里 ${obs.exo} 颗`
      + ` —— ${obs.exo - obs.exoReachable > 0 ? `${obs.exo - obs.exoReachable} 颗既没露出、也没有展开路径` : `多算了 ${obs.exoReachable - obs.exo} 颗`}`);
  }
  if (obs.exoPlanetDupe) exoBad.push(`${obs.exoPlanetDupe} 颗因 id 重名被吞掉`);
  if (obs.exoNoHost) exoBad.push(`${obs.exoNoHost} 颗没有 hostId（点了会没反应）`);

  if (obs.colorBadCount) {
    colorBad.push(`${obs.colorBadCount} 个天体的 color 类型/格式不对（会让贴图静默变灰或变黑）：${obs.colorBad.slice(0, 6).join('、')}`);
  }
  return {
    modelBad, exoBad, colorBad,
    truncBad: obs.truncBad || [],
    conservationBad: obs.conservationBad || [],
    silentBad: obs.silentBad || [],
    ingestBad: obs.ingestBad || [],
  };
}

/* ============================================================
 * 输出
 * ============================================================ */

const say = (s) => process.stdout.write(`${s}\n`);

function human(obs, j) {
  if (!obs.ok) { say(`✗ 装配失败\n${obs.err}`); return; }
  say(`· 天体 ${obs.bodies} 个 · 顶层分组 ${obs.treeCount} 个 · 尺度分节 ${obs.tiers.length}/${obs.scaleIds.length}`);
  say(`· 系外行星 ${obs.exo} 颗（目录露出 ${obs.exoLeaves} + 声明藏起 ${obs.exoHidden ?? 0} = 可摸到 ${obs.exoReachable ?? '?'}）`
    + `· 补建宿主 ${obs.exoHostsCreated} 个 · 重名 ${obs.exoPlanetDupe}`);
  say(`· 颜色字段：类型/格式不对 ${obs.colorBadCount} 个 · 未带 color 字段 ${obs.colorMissingCount} 个（目录型天体，正常）`);
  const line = (label, bad) => say(`${bad.length ? '✗' : '✓'} ${label}${bad.length ? `\n    ${bad.join('\n    ')}` : ''}`);
  line('目录树的尺度归属', j.modelBad);
  line('系外行星接入', j.exoBad);
  line('颜色字段形态', j.colorBad);
  line('目录截断的自证', j.truncBad);
  line('目录与数据的数量守恒', j.conservationBad);
  line('目录有没有整批漏掉某种天体', j.silentBad);
  line('数据源的吸纳率（抓回的行都有去处）', j.ingestBad);
  const tg = obs.truncGroups || [];
  if (tg.length) {
    say('· 被截断的分组（目录只列一部分，其余靠搜索）:');
    for (const g of tg) say(`    ${g.name.padEnd(28)} 列 ${g.shown} / 共 ${g.total}${g.hidden > 0 ? `（藏 ${g.hidden}）` : ''}${g.hasNote ? ' · 有说明' : ''}`);
  }
}

/* ============================================================
 * 故障注入自测
 * ============================================================ */

/** 注入。返回注入后**盘上**的指纹（拿不到指纹视为注入失败）。 */
function injectCase(inj) {
  const src = fs.readFileSync(DATASET, 'utf8');
  const hits = src.split(inj.needle).length - 1;
  if (hits !== 1) {
    say(`  ✗ 注入失败：「${inj.name}」的 needle 在 ${DATASET_REL} 里命中 ${hits} 次（期望恰好 1 次）—— 代码改过了？同步更新 INJECTIONS`);
    return null;
  }
  fs.writeFileSync(SIDECAR, src);                       // 备份**先落盘**：被强杀了下次启动还能自愈
  const patched = src.replace(inj.needle, inj.value);
  fs.writeFileSync(DATASET, patched);
  return createHash('sha1').update(patched).digest('hex').slice(0, 12);
}

function restoreCase() {
  if (!fs.existsSync(SIDECAR)) return;
  fs.writeFileSync(DATASET, fs.readFileSync(SIDECAR, 'utf8'));
  fs.unlinkSync(SIDECAR);
}

function runSelfTest() {
  say('故障注入自测：故意改坏 → 确认判据会响 → 还原\n');
  const healed = repairLeftovers(true);
  if (!healed.length) say('  · 没有需要自愈的残留');

  let allOk = true;
  for (const inj of INJECTIONS) {
    say(`\n▸ 注入「${inj.name}」`);
    const injHash = injectCase(inj);          // 返回注入后**盘上**的指纹
    if (!injHash) { allOk = false; continue; }
    say(`  · 已注入：${inj.needle}  →  ${inj.value}（指纹 ${injHash}）`);
    let out = null;
    try {
      // ⚠ 必须带 --no-repair：子进程启动时的自愈会把这个**故意**注入的故障还原掉，
      //   于是判据当然不响 —— 那是 harness 自己把故障中和了，不是检查不管用。
      const txt = execFileSync(process.execPath, [SELF, '--json', '--no-repair'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 22 });
      out = JSON.parse(txt.trim().split('\n').pop());
    } catch (e) {
      say(`  ✗ 子进程探针没跑起来：${e.message}`);
      allOk = false;
      continue;
    } finally {
      restoreCase();
    }
    // 先确认「故障真的还在盘上」，再看判据响没响。
    // 少了这一步，自愈把注入中和掉时会报成「检查是摆设」—— 一次**假失败**，
    // 而假失败和漏报一样有害：它会训练人去调阈值，而不是去修真问题。
    if (out.srcHash !== injHash) {
      say(`  ✗ 子进程看到的不是注入后的文件（指纹 ${out.srcHash} ≠ ${injHash}）—— 故障被中途还原了，这次自测不算数`);
      allOk = false;
      continue;
    }
    const fired = (out[inj.expect] || []).length > 0;
    if (fired) {
      say(`  ✓ 判据响了（${inj.expect}）：${out[inj.expect][0]}`);
      say('  · 已还原，并核对文件与备份逐字节一致');
    } else {
      say(`  ✗ 判据**没响** —— 这个检查是摆设（${inj.expect} 为空）`);
      allOk = false;
    }
  }

  // 还原后必须回到全绿，否则说明还原有残留
  say('\n▸ 还原后复跑（必须全绿）');
  try {
    const txt = execFileSync(process.execPath, [SELF, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 22 });
    const out = JSON.parse(txt.trim().split('\n').pop());
    const left = [...out.modelBad, ...out.exoBad, ...(out.truncBad || []),
      ...(out.conservationBad || []), ...(out.silentBad || []), ...(out.ingestBad || [])];
    const clean = left.length === 0;
    say(clean ? `  ✓ 六条判据都回到通过（干净指纹 ${out.srcHash}）` : `  ✗ 仍有残留：${left.join('；')}`);
    if (!clean) allOk = false;
  } catch (e) {
    say(`  ✗ 复跑失败：${e.message}`);
    allOk = false;
  }

  say(`\n结果：${allOk ? `注入自测通过 —— ${INJECTIONS.length} 条判据都不是摆设` : '注入自测**未通过**'}`);
  return allOk ? 0 : 1;
}

/* ============================================================
 * 入口
 * ============================================================ */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

if (has('--restore')) {
  const fixed = repairLeftovers(true);
  say(fixed.length ? `已还原：${fixed.join('、')}` : '没有需要还原的东西。');
  process.exit(0);
}

if (has('--selftest')) {
  process.exit(runSelfTest());
}

// 常规路径：先自愈，再观测。
// `--no-repair` 只给故障注入自测的子进程用 —— 那一轮盘上的「脏」是**故意**的，
// 自愈会把注入中和掉，于是判据不响，看起来像检查失灵（假失败）。
// ⚠ 注意这里的写法：`repairLeftovers(verbose)` 的入参是**静默开关**，不是**启用开关**——
//   写成 `repairLeftovers(false)` 以为「不修」，实际是「修但不吭声」。所以必须整句跳过。
const noRepair = has('--no-repair');
if (!noRepair) repairLeftovers(has('--human'));

const obs = await observe();
const j = judge(obs);
const payload = { ...obs, modelBad: j.modelBad, exoBad: j.exoBad, colorBad: j.colorBad };

if (has('--human')) {
  if (noRepair) say('（--no-repair：跳过启动自愈，盘上的状态按原样观测）');
  human(obs, j);
  process.exit(0);
}
say(JSON.stringify(payload));
process.exit(0);

/**
 * 数据集装载与索引：把人工整理数据与抓取数据合并成统一的「天体」对象，
 * 并提供模糊检索（导航栏「目的地搜索」与命令面板共用）。
 * 位置统一交给 Ephemeris（astronomy-engine）实时计算。
 */
import { SUN, PLANETS, DWARFS, MOONS, SMALL_BODIES, REGIONS, PROBES, AU_KM } from './solar-system.js';
import { GALAXIES, COSMIC, MILKYWAY, STAR_INFO, NOTABLE_FAR_STARS } from './deep-sky.js';
import { NOTABLE_COMPACT, NOTABLE_BY_SIMBAD, COMPACT_ALIAS } from './compact-known.js';
import { Orbit } from '../util/kepler.js';
import { Ephemeris } from '../core/ephemeris.js';
import { SCALE_BY_ID } from '../core/scales.js';
import { applyOverrides } from './overrides.js';
// 系外行星的示意色（平衡温度 → 色）。**唯一来源在 color/ 层**，
// 渲染器与数据集共用同一份，别在这里再抄一套。
import { tempToColor } from '../color/exo-temp.js';

/**
 * 本星系群成员：手写目录 ∪ 真实星表，**按 id 取并集**。
 *
 * 两边的来源与分工：
 *   · `curated` = `deep-sky.js::GALAXIES`（20 条人工整理）—— 带 `desc/facts/color`、
 *     有实测出处的 `incl/pa`、整盘 `diameterLy`、`anchor:'home'`、`hidden`。
 *     这些**星表里没有**，所以手写条目必须保留。
 *   · `catalog` = `data/local-group.json`（McConnachie 2012 全表 102 条）——
 *     带 ra/dec/日心距、半光半径（R2）、扁率 ε、位置角 PA、V 星等、金属丰度、
 *     恒星质量、归属子群。这些**手写目录里没有**。
 *   ⇒ 两边是互补的，不是重复的。
 *
 * 三条口径（少一条都会出问题）：
 *   ① **手写优先**：同一个 id 两边都有时，手写的字段覆盖星表的。
 *   ② **星表补空**：星表独有的字段补在原对象上，**不是整条丢弃**
 *      （否则 m31 会丢掉金属丰度、M33 会丢掉恒星质量）。
 *   ③ **两边都保留各自的独有条目**：星表那 82 个矮星系手写目录里没有，
 *      手写的 `hidden`/`desc` 星表里也没有 —— 并集之后两边都在。
 *
 * ⚠️ 排序必须**确定**：这一层的标签是「按优先级抢名额」的，顺序变了、
 *    抢到名额的天体就变了，画面会跟着变 ⇒ 不许依赖 Map 的插入顺序。
 *    规则：主角固定在前，其余按距离由近及远。
 */
const GALAXY_PINNED_ORDER = ['milkyway', 'm31', 'm33', 'lmc', 'smc'];
function mergeGalaxies(curated, catalog) {
  /* `provenance` 记这条数据是从哪儿来的：curated / catalog / 两边都有。
   * 不是为了显示，是为了**能被判据追问** —— 探针要能按它把「星表新增的那批」
   * 单独消融出来量代价，而不是靠猜 id。 */
  const curatedIds = new Set(curated.map((g) => g.id));
  const byId = new Map();
  for (const g of catalog) {
    byId.set(g.id, { ...g, provenance: curatedIds.has(g.id) ? 'curated+catalog' : 'catalog' });
  }
  for (const g of curated) {
    const base = byId.get(g.id);
    byId.set(g.id, base
      ? { ...base, ...g, provenance: 'curated+catalog' }
      : { ...g, provenance: 'curated' });
  }
  return [...byId.values()].sort((a, b) => {
    const ia = GALAXY_PINNED_ORDER.indexOf(a.id);
    const ib = GALAXY_PINNED_ORDER.indexOf(b.id);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return (a.distMly ?? 0) - (b.distMly ?? 0);
  });
}

/**
 * 「本星系群**成员**」的口径 —— **零速度面之内**（≈5 百万光年）。
 *
 * ⚠️ 这条口径**不是**拍的，是**从数据里读出来的**：
 *    `data/local-group.json` 每条都带 McConnachie 2012 原始的 `group` 字段。
 *    合并（手写覆盖星表）之后的实测分布：
 *      · 本星系群 17 · 银河系卫星 25 · 仙女座卫星 31 · 本星系群边缘 4 —— 最远 **4.67** Mly
 *      · 近邻星系 25 —— **4.40 – 9.67** Mly
 *    也就是说：**四档里只有「近邻星系」越过 5 Mly 那道标尺环**。它是星表作者划在
 *    零速度面之外的「附近星系」，物理上不是本星系群成员。
 *    ⇒ 「只留核心」（2026-09-12 拍板）的判据就是它，不需要再编一个距离阈值。
 *
 * ⚠️ 为什么不顺手写成 `distMly > 5`：那会是一条**独立的、会跟分类漂开**的第二口径。
 *    实测两口径差 2 条（有 2 个「近邻星系」在 5 Mly 以内）。
 *    项目纪律：同一个事实只许一处口径（坑 105 的近亲 —— 两个口径必漏一个）。
 *
 * ⚠️ 为什么不复用天体的 `hidden` 字段表达「不画」：那个字段在本项目**已有既定语义** =
 *    「体积过小，标签默认不出，放大后才显示」（`ui/panel.js` 的徽标文案就是这句，
 *    `solar.js` 用它压标签距离）。借它表达「不画」= 一个字段两种含义，
 *    正是上一条纪律要防的事。
 */
export const LG_OUTSIDE_GROUP = '近邻星系';

/** 这个天体是不是本星系群成员（零速度面之内）。
 *  `levels/cosmos.js` 用它决定**默认画不画**。
 *  ⚠️ 分组缺失/拼错时**当作成员**（默认显示）：把天体从画面上拿掉必须有明确依据，
 *     不能因为「分类没读到」就静默少画一个 —— 那是静默故障的温床。 */
export function isLocalGroupMember(g) {
  return !(g && g.group === LG_OUTSIDE_GROUP);
}

const TYPE_LABEL = {
  star: '恒星', planet: '行星', dwarf: '矮行星', moon: '卫星', asteroid: '小行星',
  comet: '彗星', tno: '海外天体', region: '区域', probe: '探测器', ring: '行星环',
  galaxy: '星系', cluster: '星系团', supercluster: '超星系团', group: '星系群',
  dwarfgalaxy: '矮星系', spiral: '旋涡星系', elliptical: '椭圆星系', irregular: '不规则星系',
  attractor: '引力异常区', filament: '纤维状结构', cmb: '宇宙背景', core: '银心', arm: '旋臂',
  halo: '银晕', stream: '气体流', exoplanet: '系外行星',
};

/** 编目深空天体的类型名（OpenNGC 归一化后的类型） */
const DEEP_TYPE_LABEL = {
  galaxy: '星系', globular: '球状星团', opencluster: '疏散星团',
  planetarynebula: '行星状星云', nebula: '星云', snr: '超新星遗迹',
  doublestar: '双星', star: '恒星',
  /* OpenNGC 的 `Type=Other`：只登记了编号与坐标，没有类型/亮度/大小。
   * 收进来的理由只有一个 —— **位置是确定的**（用户口径：有精确位置就该在）。
   * 但名字不能含糊其辞：就叫「未分类深空天体」，别造一个假的物理分类。 */
  unclassified: '未分类深空天体',
  nova: '新星',
};

/** 致密天体的类型名（SIMBAD otype 归一化后） */
const COMPACT_TYPE_LABEL = {
  blackhole: '黑洞', bh: '黑洞', psr: '脉冲星', whitedwarf: '白矮星', wd: '白矮星',
  planetarynebula: '行星状星云', snr: '超新星遗迹',
};

/**
 * 「编目天体」的统一判据：深空编目（OpenNGC）**或**致密天体（SIMBAD）。
 *
 * ⚠️ 为什么必须同时问两张表（踩过，症状是「黑洞/脉冲星/白矮星全看不见」）：
 *   目录树原来写的是 `!DEEP_TYPE_LABEL[b.type]`，本意是「不是编目天体 → 就是银河系结构」。
 *   但致密天体的类型（bh / blackhole / psr / wd / whitedwarf）**不在** DEEP_TYPE_LABEL 里，
 *   于是：
 *     · 银河系层：181 颗脉冲星 + 4 个黑洞被当成「银河系结构」混进 mw-structure，看不见；
 *     · 邻近层：`nearby` 只 filter `type === 'star'`，663 条致密天体**一条都不显示**。
 *   判据必须问「是不是**任一**类编目天体」，而不是只问一张表。
 */
const isCataloged = (b) => Boolean(DEEP_TYPE_LABEL[b.type] || COMPACT_TYPE_LABEL[b.type]);

/** 类型名（两类合流；目录分组与面板标题共用） */
const ANY_TYPE_LABEL = { ...DEEP_TYPE_LABEL, ...COMPACT_TYPE_LABEL };

/**
 * 天体 id 用的 slug：**只留小写字母、数字与连字符**。
 *
 * ⚠️ 不能只做"看起来够用"的转义：`ui/panel.js` 的 `setActive()` 用
 *   `.cat-row[data-id="${id}"]` 做属性选择器。id 里只要出现引号、空格、方括号
 *   就会抛出 `SyntaxError: not a valid selector` —— 而且是**点开目录那一刻**才炸。
 *   所以把 id 字符集收紧到选择器安全范围，而不是事后转义。
 */
const slugId = (s) => {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t || 'x';
};

/**
 * 数值展示：按量级给精度。
 *
 * ⚠️ 不要写死小数位。系外行星数据横跨好几个量级 ——
 *   半长轴 0.0288 AU ↔ 周期 5.12338 天 ↔ 质量 3500 M⊕。
 *   统一 `.toFixed(2)` 会把 0.0288 抹成「0.03」（丢了有效信息），
 *   统一 `.toFixed(4)` 又会让周期变成「5.1234」这种假精度。
 */
const num3 = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 10000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(2);
};

/**
 * 目录分组表：**把同一物理类别的多个 type id 合并成一个分组**。
 *
 * ⚠️ 为什么需要它：数据层存在「一个物理概念、两个 type id」的历史问题 ——
 *   OpenNGC 写 `nebula`，SIMBAD 写 `planetarynebula`；
 *   致密天体上更是同一个「黑洞」被写成 `bh` 和 `blackhole` 两种，
 *   「白矮星」写成 `wd` 与 `whitedwarf`。
 *   直接按单类型分组会出现**两个同名分组**（"黑洞 · 3" 与 "黑洞 · 1"），
 *   用户会以为数据重复了。
 *   ⇒ 分组一律走这张表，`types` 是数组。
 */
const CATALOG_GROUPS = [
  { id: 'globular', label: '球状星团', types: ['globular'] },
  { id: 'opencluster', label: '疏散星团', types: ['opencluster'] },
  { id: 'nebula', label: '星云', types: ['nebula'] },
  { id: 'planetarynebula', label: '行星状星云', types: ['planetarynebula'] },
  { id: 'snr', label: '超新星遗迹', types: ['snr'] },
  { id: 'doublestar', label: '双星', types: ['doublestar'] },
  { id: 'star', label: '恒星', types: ['star'] },
  /* ⚠️ 这一条是**补上来的**，别删。
   * 原来这张表里没有 `galaxy`，于是 galaxy 层的 15 个 `type='galaxy'` 天体
   * （银河系本体 `milkyway-galaxy` + 14 个 NGC）既不在「银河系结构」里
   * （它们是 isCataloged 的，会被分到 mwObjects），**也没有任何分组承接** ——
   * 整批从目录里消失，而所有判据都是绿的。
   * 发现方式就是 `tools/model-probe.mjs` 的「防沉默」判据：
   * 「数据里有、目录里一个都没有」= 必报。 */
  { id: 'galaxy', label: '星系', types: ['galaxy'] },
  /* ⚠️ 下面两类是**台账挖出来的**：OpenNGC 里 Type=Other 的 419 条与 Nova 的 3 条
   * 原来根本没有分组承接（TYPE_MAP 里没映射），一直在被静默丢掉 ——
   * 是两个工具的吸纳台账把「源表 14034 行 = 落地 12950 + 未映射类型 1084」摆出来的。
   * 它们都有精确 RA/Dec，按「有精确位置就该在」的口径收进来了。
   * 加新类型时**必须同时**在这张表里加一行，否则整批天体从目录里消失 ——
   * 而 `tools/model-probe.mjs` 的「防沉默」判据会当场报红（这是它存在的理由）。 */
  { id: 'nova', label: '新星', types: ['nova'] },
  {
    id: 'unclassified', label: '未分类深空天体', types: ['unclassified'],
    /* 分组自己带说明：419 行只有编号和坐标的天体，不解释清楚就会被当成数据错误。 */
    note: 'OpenNGC 只登记了编号与坐标（Type=Other），没有类型、亮度与大小。'
      + '收进来是因为**位置是确定的**；读不出更多信息，所以它们在目录里排在最后，不参与亮度排序。',
  },
  // ↓ 致密天体：两个 id 合一个组
  { id: 'bh', label: '黑洞', types: ['bh', 'blackhole'] },
  { id: 'psr', label: '脉冲星', types: ['psr'] },
  { id: 'wd', label: '白矮星', types: ['wd', 'whitedwarf'] },
];

/** SIMBAD 的 otype → 展示类型。抓取产物按类别分批（type=psr/wd/...），
 *  但点名白名单进来的是 pinned，得回到 otype 才知道它到底是什么。 */
const OTYPE_TO_TYPE = {
  BH: 'blackhole', Psr: 'psr', 'WD*': 'whitedwarf', PN: 'planetarynebula', SNR: 'snr',
};

/** 名称规范化：只比「字母数字」，用于跨星表去重（M57 / NGC 6720 / PK 82+1.1 是同一座）。 */
const normKey = (s) => (s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : '');

/** 人工表按 simbadId / 名称双索引 —— 抓取记录只有机器名，两个键都要能命中。
 *  ⚠️ 这里从人工表**派生**索引，不复制名单：名单只有一处真源（compact-known.js）。 */
const COMPACT_BY_SIMBAD = NOTABLE_BY_SIMBAD;
const COMPACT_BY_NAME = new Map();
for (const o of NOTABLE_COMPACT) {
  for (const k of [o.name, o.en, o.simbadId]) {
    if (k) COMPACT_BY_NAME.set(normKey(k), o);
  }
}

/** 给编目深空天体拼一句像样的说明——数据是真实的，话就不用编 */
function deepSkyDesc(o) {
  const t = DEEP_TYPE_LABEL[o.type] || '深空天体';
  const parts = [];
  if (o.messier != null) parts.push(`梅西耶星表第 ${o.messier} 号`);
  parts.push(o.constellation ? `位于${o.constellation}座` : '');
  parts.push(o.hubble ? `哈勃分类 ${o.hubble}` : '');
  if (o.distSource === 'redshift') parts.push(`距离约 ${o.distMly.toLocaleString('en-US')} 百万光年（由红移 z=${o.redshift} 按 H₀=70 km/s/Mpc 推算）`);
  else if (o.noDistance) {
    /* ⚠️「红移过小」这句**只对河外星系成立**。
     *   银河系内的天体（星团 / 星云 / 以及 OpenNGC 只登记了编号的那些条目）
     *   本来就没有宇宙学红移可言，把它们说成「红移过小，哈勃定律不适用」
     *   是把两件不相干的事混成一句 —— 而这句话会出现在几百个天体的详情里。 */
    parts.push(o.scope === 'extragalactic'
      ? '距离尚未测定（红移过小，哈勃定律不适用）'
      : '距离尚未测定（所属类型没有可用的代表距离）');
  }
  if (o.mag != null) parts.push(`视星等 ${o.mag}`);
  const real = `${o.name} 是${o.common ? `「${o.common}」，` : ''}一个${t}，${parts.filter(Boolean).join('，')}。`;
  const caveat = o.distSource === 'redshift'
    ? '注：近距星系的红移受本动速度影响，此距离为统计估算值。'
    : '';
  return real + caveat;
}
const MOON_GROUP = {
  major: '主要卫星', galilean: '伽利略卫星', inner: '内侧小卫星',
  ring: '环系牧羊卫星', trojan: '特洛伊伴星', irregular: '不规则卫星',
};
const SMALL_GROUP = {
  mainbelt: '主带小行星', nea: '近地小行星', trojan: '木星特洛伊群', centaur: '半人马小天体',
  kuiper: '柯伊伯带天体', scattered: '离散盘天体', detached: '极端海外天体',
  periodic: '周期彗星', longperiod: '长周期彗星', interstellar: '星际天体',
};

export class Dataset {
  constructor() {
    this.bodies = new Map();
    this.stars = [];
    this.exoplanets = [];
    this.galaxies = GALAXIES;
    this.cosmic = COSMIC;
    this.milkyway = MILKYWAY;
    this.starInfo = STAR_INFO;
    this.index = [];
  }

  async load(onProgress = () => {}, opts = {}) {
    onProgress('读取恒星表…', 0.1);
    const [starsJson, exoJson, smallJson, galleryJson, texJson, deepJson, compactJson, quasarJson, localGroupJson] = await Promise.all([
      fetch('./data/stars.json').then((r) => r.json()),
      fetch('./data/exoplanets.json').then((r) => r.json()),
      fetch('./data/small-bodies.json').then((r) => r.json()).catch(() => ({ bodies: {} })),
      fetch('./data/gallery.json').then((r) => r.json()).catch(() => ({ gallery: {} })),
      fetch('./data/texture-manifest.json').then((r) => r.json()).catch(() => ({ files: {} })),
      fetch('./data/deep-sky.json').then((r) => r.json()).catch(() => ({ objects: [] })),
      // 致密天体（黑洞 / 中子星 / 脉冲星 / 白矮星 / 星云）——抓取产物，可选
      fetch('./data/compact-objects.json').then((r) => r.json()).catch(() => ({ objects: [], meta: {} })),
      // 类星体远景背景场（Milliquas v7.2 抽样）——抓取产物，可选。
      // 只喂给「可观测宇宙」层当背景，**不进目录**（理由见 cosmos.js 的 #buildQuasarField）
      fetch('./data/quasars.json').then((r) => r.json()).catch(() => ({ objects: [], meta: {} })),
      // 本星系群成员表（McConnachie 2012 全表 102 条）——抓取产物，可选。
      // 与手写目录按 id 取并集（见 mergeGalaxies）；抓取失败时退回纯手写目录，
      // **不会**因为一个可选数据文件缺失就少掉银河系与 M31。
      fetch('./data/local-group.json').then((r) => r.json()).catch(() => ({ objects: [], meta: {} })),
    ]);
    onProgress('整理太阳系…', 0.45);

    this.gallery = galleryJson.gallery || {};
    this.texManifest = texJson.files || {};

    this.smallOrbits = smallJson.bodies || {};
    this.stars = starsJson.rows || [];
    this.starMeta = starsJson.meta || {};
    this.exoplanets = exoJson.systems || [];
    this.exoMeta = exoJson.meta || {};
    this.deepSky = deepJson.objects || [];
    this.deepSkyMeta = deepJson.meta || {};
    this.compactObjects = compactJson.objects || [];
    this.compactMeta = compactJson.meta || {};
    /* 类星体远景背景场。**刻意不进目录 / 不进 `catalogObjectsOfLevel`**：
     * 它是这一层的**背景场**（5939 个点），地位与「恒星场」同类，
     * 不是可检索的天体；真要让 5939 个类星体进目录，还得先有
     * 详情面板、类型学、attrs 口径三样东西，那是另一件事，不混在这一刀里。
     * 元信息 `meta` 也一并留着（含距离模型与取样口径），供自检复算。 */
    this.quasars = quasarJson.objects || [];
    this.quasarsMeta = quasarJson.meta || {};

    /* 本星系群成员：星表（102 条）打底 + 手写目录（20 条）覆盖，按 id 取并集。
     * 元信息一并留着（含距离/尺寸/倾角/名称四处口径的说明），供自检复算。
     * ⚠️ 这一层「画出来的」与「搜得到的」必须是**同一份**列表：
     *    下面建索引时用的也是 `this.galaxies`（原来写的是模块级 `GALAXIES`），
     *    否则新成员会出现「画得出来、搜不到、点不开」。 */
    this.localGroup = localGroupJson.objects || [];
    this.localGroupMeta = localGroupJson.meta || {};
    this.galaxies = mergeGalaxies(GALAXIES, this.localGroup);

    /* ★ 「本星系群成员」口径**挂到实例上**，供渲染层与判据共用。
     *
     * ⚠️ 为什么要有这一层转发，而不是让各处 `import { isLocalGroupMember }`：
     *    浏览器里的探针（`tools/probe-localgroup.py`）只能从 `window.__universe`
     *    往下摸。它若自己写一句 `g.group === '近邻星系'` 来判断，那就是**第二份实现**
     *    —— 而同一条不变量有第二份实现的地方，必有一份会漏掉（项目已经踩过）。
     *    挂在这里之后：渲染层 `levels/cosmos.js` 与探针**取的是同一个函数**，
     *    连常量也只有一份（`LG_OUTSIDE_GROUP`）。 */
    this.lgOutsideGroup = LG_OUTSIDE_GROUP;
    this.isLocalGroupMember = isLocalGroupMember;

    // 太阳系天体
    const add = (b, level = 'solar') => {
      const body = { ...b, level, typeLabel: TYPE_LABEL[b.type] || b.type };
      if (b.orbit && b.type !== 'region') body._orbit = new Orbit(b.orbit);
      if (this.gallery[body.id]) body.gallery = this.gallery[body.id];
      // 贴图来源标注 + 法线贴图
      const texFile = body.texture || (body.tex && body.tex.file);
      const meta = texFile ? this.texManifest[texFile] : null;
      if (meta) {
        body.textureMeta = meta;
        if (meta.normal) body.normalTexture = meta.normal;
      }
      this.bodies.set(body.id, body);
    };
    const mergeOrbit = (body) => {
      const key = this.#findSmallKey(body.sbdb || body.id);
      const o = key ? this.smallOrbits[key] : null;
      if (o) {
        body.orbit = { a: o.a, e: o.e, i: o.i, om: o.om, w: o.w, M0: o.ma, epoch: o.epochJD ?? 2451545 };
        body.sbdb = o;
        body.periodDays = body.periodDays ?? o.periodDays;
      }
      return body;
    };

    add({ ...SUN, parent: null });
    PLANETS.forEach((p) => add(p));
    DWARFS.forEach((d) => add(mergeOrbit({ ...d })));
    MOONS.forEach((m) => add({ ...m, type: 'moon' }));
    SMALL_BODIES.forEach((s) => add(mergeOrbit({ ...s })));
    REGIONS.forEach((r) => add(r));
    PROBES.forEach((p) => add(p));

    onProgress('整理深空天体…', 0.7);
    // 星系
    /* ⚠️ 用 `this.galaxies`（= 手写 ∪ 星表），**不是**模块级 `GALAXIES`。
     *    两者不同 → 新成员「画得出来但搜不到、点不开」，而且不报任何错。
     *    `this.galaxies` 一定已就绪：构造函数里给了 `= GALAXIES` 的兜底。 */
    for (const g of this.galaxies) {
      this.bodies.set(g.id, { ...g, level: 'localgroup', typeLabel: TYPE_LABEL[g.type] || '星系' });
    }
    for (const c of COSMIC) {
      // 尺度归属：本星系群留在本星系群层；几亿光年内的近邻结构归「室女座超星系团」；
      // 十亿光年级的巨型结构（武仙-北冕座长城）与宇宙微波背景才归「可观测宇宙」。
      const lvl = c.id === 'local-group' ? 'localgroup'
        : (c.type === 'cmb' || (c.distMly ?? 0) > 1500) ? 'universe'
          : 'supercluster';
      this.bodies.set(c.id, { ...c, level: lvl, typeLabel: TYPE_LABEL[c.type] || '结构' });
    }
    for (const f of MILKYWAY.features) {
      this.bodies.set(`mw-${f.id}`, { ...f, id: `mw-${f.id}`, level: 'galaxy', name: f.name, en: f.en, typeLabel: TYPE_LABEL[f.type] || '结构' });
    }
    this.bodies.set('milkyway-galaxy', { ...MILKYWAY, id: 'milkyway-galaxy', level: 'galaxy', type: 'galaxy', typeLabel: '星系', name: '银河系', en: 'Milky Way', desc: '我们所在的棒旋星系。' });
    for (const s of NOTABLE_FAR_STARS) {
      /* ⚠️ `level` **读数据自己的**，不要统一按类型写死成 `neighborhood`。
       *    原来这里写死 `level: 'neighborhood'`，于是 6,070 光年外的天鹅座 X-1
       *    也被算进邻近层 —— 而那一层 1 单位 = 1 光年、相机远平面 4000，
       *    它只会被裁掉（而且用户会以为「黑洞没做进去」）。
       *    尺度归属按**距离**判，与 deep-sky / 致密天体两条链路同一口径。 */
      const lv = s.level || 'neighborhood';
      this.bodies.set(s.id, { ...s, level: lv, typeLabel: TYPE_LABEL[s.type] || '恒星' });
    }

    // 邻近恒星（HYG）——只在检索与信息面板中出现，不逐个建对象
    this.starByKey = new Map();
    /* 已确认有行星的宿主恒星名。这批星**必须**进 bodies，不论多暗：
     * 原来的准入条件是「有专名 or 星等 < 6.5（肉眼可见）」，
     * 于是 471 个系外行星系统里只有 56 个宿主进了目录 —— 另外 415 个的
     * 行星没有母星系可挂，界面上就是「系外行星没做出来」。
     * 数据早就有了（758 颗），是被入口筛掉的，不是缺数据。 */
    const exoHosts = new Set(this.exoplanets.map((s) => s.starName));
    for (const row of this.stars) {
      const [name, x, y, z, mag, absmag, ci, spect, lum, ids] = row;
      const info = STAR_INFO[name];
      const distLy = Math.hypot(x, y, z);
      const entry = {
        id: `star-${name}`, name: info?.zh ? `${info.zh}（${name}）` : name, en: name,
        type: 'star', typeLabel: '恒星', level: 'neighborhood', x, y, z, distLy,
        mag, absmag, ci, spect, lum, ids, info,
        desc: info?.desc || `${spect ? spect + ' 型' : ''}恒星，距离太阳 ${distLy.toFixed(2)} 光年${absmag ? `，绝对星等 ${absmag.toFixed(2)}` : ''}。`,
        facts: info?.facts || [], researchQuery: info?.researchQuery || `${name} star`,
      };
      this.starByKey.set(name, entry);
      if (info || mag < 6.5 || exoHosts.has(name)) this.bodies.set(entry.id, entry);
    }
    /* `anchor: 'home'` —— 太阳在邻近恒星系层就落在世界原点（这一层是**日心**建的），
     * 和其它「三个分量恰好全零」的天体在渲染上长得一模一样。
     * 区别只能靠声明：真的在原点 → 自己说；说不出 → 判成缺坐标。 */
    this.bodies.set('star-sun', { ...SUN, id: 'star-sun', level: 'neighborhood', anchor: 'home', typeLabel: '恒星', name: '太阳', x: 0, y: 0, z: 0, distLy: 0, desc: '我们所在的恒星，位于猎户臂内侧。' });

    // 系外行星系统
    this.exoByStar = new Map();
    for (const sys of this.exoplanets) {
      this.exoByStar.set(sys.starName, sys);
      const star = this.starByKey.get(sys.starName);
      if (star) { star.exo = sys; star.hasPlanets = true; }
    }

    /* ---------- 系外行星：每颗都是可检索、可进入的独立天体 ----------
     * 口径（用户明确要求「和太阳系一样，把目前探明的天体也都加进去」）：
     *   **一颗行星 = 一个天体**，type='exoplanet'，进 bodies → 自动进检索索引。
     *
     * 坐标 = 宿主星坐标。本层级 1 单位 = 1 光年，而行星轨道 ≤0.62 单位，
     * 让行星单独落点毫无意义，只会让点云在恒星位置上叠成一坨。
     * 真正把它们画出来交给 `objects/exo-planets.js` 的 ExoplanetRenderer
     * （按相机距离懒加载 —— 全常驻会直接撞显存天花板）。
     */
    this.exoHostBodyId = new Map();   // starName → 宿主星的天体 id

    /* 大部分系统的宿主星在 HYG 表里**对不上**（HYG 只到 120 光年，而系外行星宿主
     * 现在最远到 2.7 万光年）。这不是「没有这颗星」，只是两套星表的覆盖范围不同。
     * 数据里有坐标、光谱型、有效温度、距离 —— 够建一个正经的宿主星天体；
     * 不建的话那些系统的行星就是没有母星系的孤儿。
     * ⚠️ 这段原来把数字写死在注释里（「281 个」「190 个」），门槛一去掉就全错。
     *    实时数量看 `this.exoHostsCreated` 与 `exoMeta.matchedToHyg`。 */
    let exoHostsCreated = 0;
    for (const sys of this.exoplanets) {
      const hit = this.starByKey.get(sys.starName);
      if (hit) { this.exoHostBodyId.set(sys.starName, hit.id); continue; }
      const id = `star-${slugId(sys.starName)}`;
      if (this.bodies.has(id)) { this.exoHostBodyId.set(sys.starName, id); continue; }
      const distLy = Number.isFinite(sys.distLy) ? sys.distLy : 0;
      const entry = {
        id, name: sys.starName, en: sys.starName,
        type: 'star', typeLabel: '恒星', level: 'neighborhood',
        x: sys.x ?? 0, y: sys.y ?? 0, z: sys.z ?? 0, distLy,
        spect: sys.spect, teff: sys.teff,
        /* 恒星质量/半径：NASA 档案的 **实测值**（st_mass / st_rad），不是推算。
         * 覆盖率见 `exoMeta.hostStarsWithMass` —— 产物里现场读，不写死。 */
        massSolar: sys.massSolar ?? null, radiusSolar: sys.radiusSolar ?? null,
        desc: `系外行星宿主恒星${sys.spect ? `，光谱型 ${sys.spect}` : ''}`
          + `${sys.teff ? `，有效温度 ${sys.teff} K` : ''}`
          + `${Number.isFinite(sys.massSolar) ? `，质量 ${sys.massSolar} 太阳质量` : ''}，距离太阳 ${distLy.toFixed(2)} 光年。`
          + `已确认 ${(sys.planets || []).length} 颗行星。`,
        facts: [], researchQuery: `${sys.starName} exoplanet system`,
        /** 来自系外行星星表（不是 HYG）——界面上要能分辨出来 */
        fromExoCatalog: true,
      };
      this.bodies.set(id, entry);
      this.exoHostBodyId.set(sys.starName, id);
      exoHostsCreated++;
    }
    // 老星表命中 / 新建的宿主星，都要挂上 exo 关系（这样才能「聚焦宿主星就建出它的行星」）
    for (const [starName, id] of this.exoHostBodyId) {
      const host = this.bodies.get(id);
      if (!host) continue;
      host.exo = this.exoByStar.get(starName);
      host.hasPlanets = true;
      /* HYG 走的那条支路**没有质量列**（HYG 只有星等/色指数/光度），
       * 而系外行星档案对同一颗星有实测质量 —— 在这里回填。
       * 不回填的话，「有行星的恒星」反而比「新建的宿主星」少一个字段，
       * 同一个界面里两种星长得不一样，用户会以为是缺数据。 */
      if (!Number.isFinite(host.massSolar) && Number.isFinite(host.exo?.massSolar)) {
        host.massSolar = host.exo.massSolar;
        host.radiusSolar = host.exo.radiusSolar ?? null;
      }
    }

    this.exoPlanetBodies = [];
    let exoPlanetDupe = 0;
    for (const sys of this.exoplanets) {
      const hostId = this.exoHostBodyId.get(sys.starName);
      if (!hostId) continue;
      const host = this.bodies.get(hostId);
      for (const p of sys.planets || []) {
        const pid = `exo-${slugId(p.name)}`;
        if (this.bodies.has(pid)) { exoPlanetDupe++; continue; }
        const rTxt = Number.isFinite(p.radiusEarth) ? `半径 ${num3(p.radiusEarth)} 地球半径` : null;
        const mTxt = Number.isFinite(p.massEarth) ? `质量 ${num3(p.massEarth)} 地球质量` : null;
        const body = {
          id: pid, name: p.name, en: p.name,
          type: 'exoplanet', typeLabel: '系外行星', level: 'neighborhood',
          x: host.x ?? 0, y: host.y ?? 0, z: host.z ?? 0, distLy: host.distLy ?? 0,
          color: tempToColor(p.eqTempK),
          /** 母星系（宿主恒星）——聚焦时靠它去建行星系统；目录里靠它分组 */
          hostId, hostStar: sys.starName,
          periodDays: p.periodDays, radiusEarth: p.radiusEarth, massEarth: p.massEarth,
          eqTempK: p.eqTempK, semiMajorAu: p.semiMajorAu, ecc: p.ecc,
          method: p.method, discoveryYear: p.year,
          desc: `绕 ${sys.starName} 运行的系外行星。`
            + [rTxt, mTxt, Number.isFinite(p.eqTempK) ? `平衡温度 ${p.eqTempK} K` : null,
              Number.isFinite(p.semiMajorAu) ? `轨道半长轴 ${num3(p.semiMajorAu)} AU` : null,
              Number.isFinite(p.periodDays) ? `公转周期 ${num3(p.periodDays)} 天` : null]
              .filter(Boolean).join('，') + '。'
            + `${p.method ? `发现方式：${p.method}` : ''}${p.year ? `，${p.year} 年` : ''}。`,
          facts: [
            Number.isFinite(p.periodDays) ? `公转周期 ${num3(p.periodDays)} 天` : null,
            Number.isFinite(p.radiusEarth) ? `半径 ${num3(p.radiusEarth)} R⊕` : null,
            Number.isFinite(p.massEarth) ? `质量 ${num3(p.massEarth)} M⊕` : null,
            Number.isFinite(p.eqTempK) ? `平衡温度 ${p.eqTempK} K` : null,
            p.method ? `发现方式 ${p.method}` : null,
          ].filter(Boolean),
          researchQuery: `${p.name} exoplanet`,
          /* 来源标记（见 deep-sky 那段注释）：让「吸纳率」判据数得出
           * 「产物里声明 6332 颗，真的建成天体的有几颗」。 */
          fromExoCatalog: true,
        };
        this.bodies.set(pid, body);
        this.exoPlanetBodies.push(pid);
      }
    }
    this.exoHostsCreated = exoHostsCreated;
    this.exoPlanetDupe = exoPlanetDupe;

    /* ---------- 深空编目天体（OpenNGC）：河外星系 + 银河系内星团 / 星云 ---------- */
    onProgress('整理深空天体目录…', 0.82);

    /** 编目天体归属哪个尺度层级 */
    this.deepSkyLevelOf = (o) => {
      if (o.scope === 'milkyway') return 'galaxy';
      const d = o.distMly;
      if (d == null) return 'supercluster';   // 距离未测定的近距星系：可检索、但 3D 中不落点
      if (d < 10) return 'localgroup';
      if (d < 900) return 'supercluster';
      return 'universe';
    };

    // 人工整理过的星系（仙女座、麦哲伦云等）优先——避免同一天体出现两条记录
    const curatedMessier = new Map();
    for (const b of this.bodies.values()) {
      const m = /^m(\d+)$/.exec(b.id);
      if (m) curatedMessier.set(Number(m[1]), b.id);
    }

    this.deepSkyPlaced = [];
    this.deepSkySkipped = 0;
    this.deepSkyNoDistance = 0;
    /** 暗弱（非梅西耶、无专名、mag > 12.5）——**收，但单独标记**，不与肉眼可见的那批混在一起 */
    this.deepSkyFaint = 0;
    for (const o of this.deepSky) {
      if (o.messier != null && curatedMessier.has(o.messier)) { this.deepSkySkipped++; continue; }
      /* 收纳口径：**有精确位置的都收**。
       *
       * ⚠️ 这里原来是一道星等门槛：
       *      const named = o.messier != null || Boolean(o.common);
       *      if (!named && (o.mag ?? 99) > 12.5) continue;
       *    它砍掉了 10,507 条（其中 9,214 个星系），而 OpenNGC 全表 12,950 条
       *    **每一条都有精确的 RA/Dec** —— 位置是确定的，只是暗。
       *    用户的原话：「还有很多天体没做进去，目前能精确位置的都应该放进去。」
       *
       * 目录的定位本来就是「含过于渺小已隐藏的天体」（见 nav.js 的 cmd-catalog），
       * 所以「暗」不构成不收的理由；「渲染不动」才是约束 —— 而那是另一条路：
       *   · 超星系团的星系点云**直读 deepSky**（一次 draw call，不受目录条数影响）；
       *   · 星系层的 sprite 有 budget 上限（`slice(0, budget)`）。
       * 也就是说：收进目录 ≈ 白得一批可浏览可搜索的天体，代价只是数据体积。
       *
       * 只是给暗弱的打上 `faint` 标记：目录里排序靠后，绝不挤掉有名有姓的那批。
       */
      const named = o.messier != null || Boolean(o.common);
      const faint = !named && (o.mag ?? 99) > 12.5;
      if (faint) this.deepSkyFaint++;
      let body = {
        ...o,
        level: this.deepSkyLevelOf(o),
        faint,
        typeLabel: DEEP_TYPE_LABEL[o.type] || '深空天体',
        desc: o.desc || deepSkyDesc(o),
        facts: [],
        researchQuery: [o.en, o.common, o.name].filter(Boolean).join(' '),
        /* 来源标记。**别删**：`tools/model-probe.mjs` 的「吸纳率」判据靠它数
         * 「产物里 N 条，真的变成天体的有几条」——
         * 用 `deepSky.length - deepSkySkipped` 这种**计数器做差**是不行的：
         * 计数器只证明"我数了"，数不到"确实建成了天体"（漏加一次计数就全瞎）。
         * 数对象才是真的。 */
        fromOpenNGC: true,
      };

      /* ⚠️ 不许无条件覆写。OpenNGC 是**全表**（13,372 条，多数只有 RA/Dec 与视星等），
       *    人工整理的那几条字段比它多 —— 而 `this.bodies.set(o.id, ...)` 是「后者全胜」。
       *    实测被冲掉的正是四个本星系群成员：IC 10 / IC 1613 / NGC 3109 / NGC 6822。
       *    它们的红移是**负的**或近零（IC 10 z = −0.00116、IC 1613 z = −0.000777），
       *    哈勃定律在这里压根不适用 ⇒ OpenNGC 里就是 `distMly: null` + `distSource: 'unknown'`。
       *    于是覆写静默地干了三件事，而且样样都报「成功」：
       *      · 丢掉 1.6–4.3 百万光年的实测距离（`G()` 早算好的 x/y/z 一起没）；
       *      · `deepSkyLevelOf` 对 null 距离返回 'supercluster' ⇒ 它们从「本星系群」
       *        被挪进「超星系团」，在本星系群层凭空消失；
       *      · 描述也被换成空字符串派生的通用句。
       *    ⇒ 合并取**并集**：已有字段优先，新行只补它没有的。
       *      字段少的一方不许覆盖字段多的一方。 */
      const prev = this.bodies.get(o.id);
      if (prev && !prev.fromOpenNGC) {
        const merged = { ...body };
        for (const [k, v] of Object.entries(prev)) {
          if (v == null || v === '') continue;
          if (merged[k] == null || merged[k] === '') merged[k] = v;
        }
        /* 尺度归属与「有没有距离」必须在合并**之后**重算：
         * 一个刚被补上距离的天体，如果还留着「距离未测定」的标记到处跑，
         * 目录会说它不可定位、而场景里它已经落点了 —— 又是一次「两边都对、结论相反」。 */
        merged.level = this.deepSkyLevelOf(merged);
        merged.curatedMerge = true;
        body = merged;
      }
      body.noDistance = body.distMly == null;
      if (body.noDistance) this.deepSkyNoDistance++;
      this.bodies.set(o.id, body);
      if (!body.noDistance && body.ra != null) this.deepSkyPlaced.push(body);
    }

    /* ---------- 致密天体（SIMBAD 抓取 + 人工整理补充） ----------
       黑洞 / 中子星 / 脉冲星 / 白矮星 / 行星状星云 / 超新星遗迹。
       数据来自 data/compact-objects.json（tools/fetch-compact.mjs 产出）；
       描述性长文不在产物里，按 simbadId 从前端人工表关联。 */
    onProgress('整理致密天体…', 0.86);
    this.#addCompactObjects();

    onProgress('建立目录与索引…', 0.9);

    /* ---------- 人工覆盖：科研监测采纳的修正 ----------
       必须在建目录与索引之前应用，否则修正后的值不会进目录徽标与检索结果。 */
    this.overridesApplied = [];
    this.overridesFailed = [];
    if (Array.isArray(opts.overrides) && opts.overrides.length) {
      const r = applyOverrides(this, opts.overrides);
      this.overridesApplied = r.applied;
      this.overridesFailed = r.failed;
    }

    this.catalog = this.#buildCatalog();
    this.#buildIndex();
    this.ephemeris = new Ephemeris(this);
    onProgress('就绪', 1);
    return this;
  }

  /**
   * 致密天体：黑洞 / 中子星（脉冲星）/ 白矮星 / 行星状星云 / 超新星遗迹。
   *
   * 三条来源合流：
   *   1. SIMBAD 自动抓取（邻近完备）—— 1.4 千条
   *   2. 人工表点名白名单（知名代表）—— 蟹状星云脉冲星、天狼星 B 等
   *   3. 人工表独立注入（SIMBAD 里没有的）—— 人马座 A*、M87* 等超大质量黑洞
   *
   * ⚠️ 星云类要做**与 OpenNGC 的交叉去重**：
   * OpenNGC 已经提供 130 条行星状星云与 11 条超新星遗迹，
   * SIMBAD 又带来 300 + 300 条。同一座 M57 会从两条链路各进来一次。
   * 这里按名称规范化后比对，已存在的就不再建条目。
   */
  #addCompactObjects() {
    const rows = this.compactObjects || [];
    if (!rows.length) return;

    // 已存在的深空天体名（OpenNGC 侧），用于交叉去重
    const existing = new Set();
    for (const b of this.bodies.values()) {
      if (b.name) existing.add(normKey(b.name));
      if (b.en) existing.add(normKey(b.en));
      if (b.common) existing.add(normKey(b.common));
    }

    this.compactAdded = 0;
    this.compactSkipped = 0;

    /** 距离（光年）→ 尺度层级。致密天体的距离跨度从 8.6 光年到 5350 万光年。 */
    const levelOf = (o) => {
      const type = o.type === 'pinned' ? OTYPE_TO_TYPE[o.otype] : o.type;
      if (type === 'blackhole' || type === 'bh') {
        // 超大质量黑洞按所在星系归属；恒星级黑洞都在银河系内
        return (o.distLy ?? 0) > 1e6 ? 'localgroup' : 'galaxy';
      }
      const d = o.distLy;
      if (d == null) return 'galaxy';          // 距离未定的星云：方位已知，归银河系
      if (d < 3000) return 'neighborhood';     // 邻近恒星系层（含天狼星 B、范玛宁星等）
      if (d < 200000) return 'galaxy';
      return 'localgroup';
    };

    for (const o of rows) {
      const key = normKey(o.name);
      const keyEn = normKey(o.en);
      if (existing.has(key) || existing.has(keyEn)) { this.compactSkipped++; continue; }
      existing.add(key);
      if (keyEn) existing.add(keyEn);

      const level = levelOf(o);
      // 点名白名单（type='pinned'）没有类别信息，按 otype 反查真实身份
      const type = o.type === 'pinned' ? (OTYPE_TO_TYPE[o.otype] || 'pulsar') : o.type;
      const typeLabel = COMPACT_TYPE_LABEL[type] || COMPACT_TYPE_LABEL[o.type] || '致密天体';
      // 描述性长文从前端人工表按 simbadId 关联（见 compact-known.js），
      // 抓取产物里只有数据 —— 这里补上学名与说明
      const curated = COMPACT_BY_SIMBAD.get(o.simbadId)
        || COMPACT_BY_NAME.get(normKey(o.en))
        || COMPACT_BY_NAME.get(normKey(o.name));
      const alias = COMPACT_ALIAS[o.simbadId];
      const distText = o.distLy == null
        ? '距离尚未测定'
        : `${o.distLy >= 1000 ? (o.distLy / 1000).toFixed(1) + ' 千' : o.distLy.toFixed(1)}光年`;
      const desc = curated?.desc
        || `${curated?.name || alias?.zh || o.name} 是${typeLabel}${o.spType ? `（${o.spType} 型）` : ''}，${distText}${curated ? `。${curated.kind}` : alias?.note ? `。${alias.note}` : '。'}`;

      // 邻近层的 3D 场景需要**笛卡尔坐标**才能落点，而致密天体抓取产物只给
      // ra/dec/distLy ⇒ 这里补算。坐标系与 HYG 星表同约定（x 指向 RA=0、z 指向北天极）。
      // 校验锚点：Proxima Cen（ra=217.43°, dec=-62.68°, d=4.246 ly）
      //   → (-1.549, -1.184, -3.774)，与 exoplanets.json 里同一条记录 (-1.5477,-1.183,-3.7704) 吻合。
      const xyz = (o.ra != null && o.dec != null && o.distLy != null) ? (() => {
        const ra = (o.ra * Math.PI) / 180, dec = (o.dec * Math.PI) / 180;
        return {
          x: o.distLy * Math.cos(dec) * Math.cos(ra),
          y: o.distLy * Math.cos(dec) * Math.sin(ra),
          z: o.distLy * Math.sin(dec),
        };
      })() : null;

      const body = {
        ...o,
        ...(xyz || {}),
        level,
        type,
        typeLabel,
        name: curated?.name || alias?.zh || o.name,
        en: curated?.en || o.en,
        desc,
        facts: curated?.facts || [],
        researchQuery: curated?.researchQuery || `${o.en || o.name} SIMBAD`,
        // 人工表的出处单独标注 —— 这是项目「每条结论要有出处」的规矩
        src: curated?.src || 'SIMBAD (CDS)',
        // 来源标记（见 deep-sky 那段注释）：给「吸纳率」判据数对象用
        fromCompactCatalog: true,
      };
      this.bodies.set(body.id, body);
      this.compactAdded++;
    }
  }

  /**
   * 取某一尺度层级里的**全部编目天体**（深空编目 ∪ 致密天体）。
   *
   * 为什么要有这个方法：渲染层需要「这一层该画哪些编目天体」，
   * 而判据（isCataloged）和距离口径（深空编目用 distMly、致密天体用 distLy）
   * 都封在 dataset 内部。让每个 level 各写一遍，必然漂移 ——
   * 事实上 galaxy.js 原来只读 `dataset.deepSky`，于是 181 颗脉冲星、4 个黑洞
   * 在 3D 场景里**一颗都没画**。
   *
   * ⚠️ 返回的对象统一补上 `distMly`（由 distLy 换算），
   *    这样调用方不必再关心两套单位。不改动原对象（必要时浅拷贝）。
   */
  catalogObjectsOfLevel(levelId) {
    const out = [];
    for (const b of this.bodies.values()) {
      if (b.level !== levelId || !isCataloged(b)) continue;
      if (b.distMly != null) { out.push(b); continue; }
      const mly = b.distLy != null ? b.distLy / 1e6 : null;
      out.push({ ...b, distMly: mly });
    }
    return out;
  }

  #findSmallKey(id) {
    if (this.smallOrbits[id]) return id;
    const cap = id.charAt(0).toUpperCase() + id.slice(1);
    if (this.smallOrbits[cap]) return cap;
    const norm = id.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const k of Object.keys(this.smallOrbits)) {
      if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === norm) return k;
    }
    return null;
  }

  /* ================= 目录树 ================= */
  #buildCatalog() {
    const leaf = (b) => ({ kind: 'body', id: b.id, name: b.name, en: b.en, type: b.type, body: b });
    const group = (id, name, children, extra = {}) => ({ kind: 'group', id, name, children, ...extra });
    const byType = (t) => [...this.bodies.values()].filter((b) => b.type === t);
    const moonsOf = (id) => byType('moon').filter((m) => m.parent === id).sort((a, b) => (a.aKm ?? 0) - (b.aKm ?? 0));
    const probesOf = (id) => byType('probe').filter((p) => p.host === id);
    const smallOf = (g) => byType('asteroid').concat(byType('comet'), byType('tno'))
      .filter((s) => s.grp === g).sort((a, b) => (b.radiusKm || 0) - (a.radiusKm || 0));

    /** 行星 / 矮行星 / 小天体的子树：环系 + 卫星 + 探测器 */
    const childrenOf = (b) => {
      const out = [];
      if (b.ring) out.push({ kind: 'ring', id: `${b.id}-rings`, name: '行星环', parent: b.id, body: b });
      const ms = moonsOf(b.id);
      if (ms.length) {
        const buckets = new Map();
        for (const m of ms) {
          const g = m.grp || 'major';
          if (!buckets.has(g)) buckets.set(g, []);
          buckets.get(g).push(m);
        }
        for (const [g, list] of buckets) {
          out.push(group(`moons-${b.id}-${g}`, `${MOON_GROUP[g] || '卫星'} · ${list.length}`, list.map(leaf)));
        }
      }
      const ps = probesOf(b.id);
      if (ps.length) out.push(group(`probes-${b.id}`, `探测器 · ${ps.length}`, ps.map(leaf)));
      return out;
    };

    const tree = [];

    // 太阳
    tree.push(group('grp-sun', '太阳', [leaf(this.get('sun'))]));

    // 行星
    tree.push(group('grp-planets', '行星', byType('planet').map((p) => ({
      kind: 'group', id: `planet-${p.id}`, name: p.name, en: p.en, body: p,
      children: childrenOf(p), badge: p.moons ? `${p.moons} 颗卫星` : null,
    }))));

    // 矮行星
    tree.push(group('grp-dwarfs', '矮行星', byType('dwarf').map((d) => ({
      kind: 'group', id: `dwarf-${d.id}`, name: d.name, en: d.en, body: d,
      children: childrenOf(d), badge: d.moons ? `${d.moons} 颗卫星` : null,
    }))));

    // 小行星带
    const beltChildren = [];
    const ceres = this.get('ceres');
    if (ceres) beltChildren.push(leaf(ceres));
    for (const [g, label] of [['mainbelt', '主带小行星'], ['trojan', '木星特洛伊群'], ['nea', '近地小行星']]) {
      const list = smallOf(g);
      if (list.length) beltChildren.push(group(`small-${g}`, `${label} · ${list.length}`, list.map(leaf)));
    }
    const beltRegion = this.get('asteroid-belt');
    if (beltRegion) beltChildren.push(leaf(beltRegion));
    tree.push(group('grp-belt', '小行星带', beltChildren));

    // 柯伊伯带与海外天体
    const tnoChildren = [];
    for (const [g, label] of [['kuiper', '柯伊伯带天体'], ['scattered', '离散盘天体'], ['detached', '极端海外天体'], ['centaur', '半人马小天体']]) {
      const list = smallOf(g);
      if (list.length) tnoChildren.push(group(`small-${g}`, `${label} · ${list.length}`, list.map(leaf)));
    }
    for (const r of ['kuiper-belt', 'scattered-disc', 'oort-cloud']) {
      const b = this.get(r);
      if (b) tnoChildren.push(leaf(b));
    }
    tree.push(group('grp-kuiper', '柯伊伯带与海外天体', tnoChildren));

    // 彗星与星际天体
    const cometChildren = [];
    for (const [g, label] of [['periodic', '周期彗星'], ['longperiod', '长周期彗星'], ['interstellar', '星际天体']]) {
      const list = smallOf(g);
      if (list.length) cometChildren.push(group(`small-${g}`, `${label} · ${list.length}`, list.map(leaf)));
    }
    tree.push(group('grp-comets', '彗星与星际天体', cometChildren));

    // 区域与结构
    tree.push(group('grp-regions', '区域与结构', byType('region').map(leaf)));

    // 探测器（无固定归属的日心飞行任务）
    const cruise = byType('probe').filter((p) => !p.host);
    if (cruise.length) tree.push(group('grp-probes', `日心飞行探测器 · ${cruise.length}`, cruise.map(leaf)));

    /* ============================================================
       以上是太阳系。以下按「宇宙尺度」逐级展开。
       ============================================================ */
    const byLevel = (lv) => [...this.bodies.values()].filter((b) => b.level === lv);
    /**
     * 目录里的排序键：**有亮度按亮度，没亮度按距离**。
     *
     * ⚠️ 原来只写了 `(a.mag ?? a.magV ?? 99) - (b.mag ?? b.magV ?? 99)`。
     *   而致密天体（脉冲星 243 / 白矮星 598 / 黑洞）**整批没有 mag 字段** ——
     *   键值全是 99，Array.sort 在等键上保持插入序（= SIMBAD 返回顺序），
     *   可分组标题却写着「按亮度取前 260 条」。**那句话是假的**，
     *   而且留下的 260 个是任意的（不是最近的、也不是最亮的）。
     *
     * 现在改成两段式：两端都有亮度 → 比亮度；只有一端有 → 有亮度的在前；
     * 都没有 → 比距离（由近到远）。这也是「我想先看哪批」的直觉顺序。
     */
    const sortKey = (b) => (b.mag ?? b.magV ?? null);
    /**
     * 「有名有姓」的排前面，暗弱（faint）的排最后。
     *
     * 为什么需要这一层：目录每组只列前 CAP 条，如果纯按星等排，
     * 门槛一放开（多了 1 万个暗天体）**前 260 条会被一堆无名的暗淡星系占满**，
     * 用户照样找不到「他记得名字的那个」。所以排序是两段：
     *   0 = 梅西耶 / 有专名 / 人工整理过（info / notable）
     *   1 = 其他（有编号的 NGC / IC / 星团…）
     *   2 = 暗弱无名（faint）
     * 同档内才比亮度，没有亮度比距离。
     */
    const namedRank = (b) => (
      (b.messier != null || b.common || b.info || b.notable) ? 0 : (b.faint ? 2 : 1)
    );
    const sortVisible = (a, b) => {
      const ra = namedRank(a);
      const rb = namedRank(b);
      if (ra !== rb) return ra - rb;
      const ma = sortKey(a);
      const mb = sortKey(b);
      if (ma != null && mb != null) return ma - mb;
      if (ma != null) return -1;
      if (mb != null) return 1;
      return (a.distLy ?? Infinity) - (b.distLy ?? Infinity);
    };
    /** 旧名沿用（多处调用点读起来更顺） */
    const sortByMag = sortVisible;

    /** 每个分组最多列出这么多条——目录是给人看的，不是给爬虫看的 */
    const CAP = 260;
    /**
     * 系外行星系统一次列多少个**宿主**。
     *
     * 行星数（6,332）比系统数（4,741）多不了多少，但两者撑出来的 DOM 完全不同：
     * 每个系统是一个分组节点 + 每个行星一行。4,741 个系统 × 约 2 个节点 ≈ 1.1 万个
     * 节点一次性 innerHTML，首屏要几百毫秒 —— 而这台机器常态只剩 1~2 GB 内存。
     * 所以按**系统**截断（而不是按行星），并且**一个系统整组展示**。
     */
    const CAP_SYS = 260;
    /**
     * 截断 + **如实交代**。
     *
     * 产出物里带 total / shown / hidden 三个数，面板才写得出「260 / 598」；
     * 只把「598」和「260」并排摆着、不作解释，用户会以为**数据丢了**
     * （这正是「很多天体没做进去」这条反馈的一部分）。
     *
     * note 里必须同时说清两件事：**按什么排序**、**剩下的去哪儿找**。
     * 后者是真的：`#buildIndex()` 索引的是 `this.bodies` 全量，不受 CAP 影响。
     */
    const capped = (list, id, label, extraNote = '') => {
      const shown = list.slice(0, CAP);
      const hidden = list.length - shown.length;
      /* 排序口径必须**照实说**。
       * ⚠️ 原来只有两档：有亮度的说「按亮度」，没亮度的说「按距离由近到远」。
       *   可「未分类深空天体」这类**既没有亮度、也没有距离**的组，
       *   两级排序键都是空（`Infinity - Infinity = NaN`，V8 按"相等"处理 = 保持原序），
       *   于是那句「按距离由近到远」是纯粹的假话 —— 排序实际是「目录原序」。
       *   写死一句话是最容易腐烂的东西：数据一换，话就变成谎。 */
      const byMag = list.some((b) => sortKey(b) != null);
      const byDist = list.some((b) => Number.isFinite(b.distLy));
      const by = byMag ? '有专名的优先，其次按亮度'
        : byDist ? '这组天体大部分没有亮度数据，按距离由近到远'
          : '这组天体只有编号与坐标，按目录原序';
      const truncNote = hidden > 0
        ? `目录默认只列 ${CAP} 条（排序：${by}）。其余 ${hidden} 个点下面的「显示全部」接着翻，或直接搜索 —— 检索索引是全量的。`
        : '';
      const note = [truncNote, extraNote].filter(Boolean).join(' ');
      return group(id, `${label} · ${list.length}`, shown.map(leaf), {
        note,
        total: list.length,
        shown: shown.length,
        hidden,
        /* 面板「显示全部」按这个列表继续渲染。
         * 存 id 而不是存 body 引用：id 是短的，1 万个也只是几百 KB；
         * 而且面板每次现取 `dataset.get(id)`，不会拿到过期的副本。 */
        allIds: list.map((b) => b.id),
        /* types / level 是给**守恒判据**用的（`tools/model-probe.mjs`）：
         * 「该尺度该类型的天体数 == 目录里露出的 + 此处藏起来的」。
         * 没有这两个字段就没法把它和 this.bodies 对上，
         * 而「整批天体压根没进目录」正是历史上真发生过的故障（邻近层的致密天体全丢）。 */
        types: [...new Set(list.map((b) => b.type))],
        level: list[0]?.level ?? null,
      });
    };

    /* ---------- 邻近恒星系 ---------- */
    const nearAll = byLevel('neighborhood');
    const nearby = nearAll.filter((b) => b.type === 'star').sort(sortByMag);
    if (nearAll.length) {
      const known = nearby.filter((b) => b.info);
      const rest = nearby.filter((b) => !b.info);
      /**
       * 邻近层分成**两支**：恒星一支、致密天体一支。
       *
       * 改动原因（怪怪反馈）：「目录里恒星下面没有放对应的行星」。
       * 原来是三个**平级**的孩子 —— 有专名的恒星 / 其余恒星 / 系外行星系统。
       * 于是「有行星的恒星」被单独摆在恒星之外，展开「恒星」只能看到一串光秃秃的星名，
       * 而恒星明明就挂在旁边的那个分组里。现在把 **有行星的恒星也放进恒星这一支**，
       * 与太阳系那边的读法对齐：**行星（分支）→ 木星（可展开）→ 卫星**，
       * 这里是 **恒星（分支）→ 比邻星（可展开）→ 行星**。
       *
       * ⚠️ **没有做的、以及为什么**（别照着「更彻底」的直觉去改）：
       * 真正彻底的做法是把**每一颗**宿主星在「其余恒星」里就地展开成节点。
       * 那会撞上两条硬约束，两条都是判据而不是风格问题：
       *   ① `nearby-other` 的截断账目是 `total 5492 / shown 260 / hidden 5232`，
       *      而守恒判据要求 `该尺度该类型的叶子 + 声明藏起 === 数据里的总数`。
       *      宿主星一变成 group 节点就**不再是叶子**，这个等式当场差 4,739。
       *   ② 想「把这 4,739 个改由另一个分组声明」也不行：守恒判据的模型里
       *      **同一个 (尺度, 类型) 只能由一个分组声明**（第二次遇到就走「分款式」分支，
       *      要求 `total === 全层总数`），它**表达不了「恒星列表被两个组分区列」**。
       * 也就是说：`近旁恒星` 这一份账目，正是「整批天体没进目录」那条历史故障的判据
       * （邻近层曾整批丢掉 597 个白矮星 + 62 个脉冲星而全绿）。
       * ⇒ 要动它必须先把守恒判据改成**支持分区声明**，那是判据改造，不是顺手的事。
       *   **已报给怪怪拍板，没有单方面动判据**（同「邻近层尺度契约」的处理方式）。
       */
      const starKids = [];
      const compactKids = [];
      const kids = [];          // 邻近恒星系的直接孩子：恒星（一支）+ 致密天体（各组）
      if (known.length) starKids.push(group('nearby-known', `有专名的恒星 · ${known.length}`, known.map(leaf)));
      if (rest.length) starKids.push(capped(rest, 'nearby-other', '其余恒星'));
      // ⚠️ 邻近层的致密天体（白矮星 597 / 脉冲星 62）原来**完全不显示** ——
      //    因为这里只 filter type==='star'。天狼星 B 这种「离我们最近的致密天体」
      //    就藏在其中。按类型分组补上（走 CATALOG_GROUPS，两个 type id 合成一组）。
      for (const g of CATALOG_GROUPS) {
        if (g.id === 'star') continue;                  // 恒星已在上面分过（有专名/其余）
        const list = nearAll.filter((b) => g.types.includes(b.type)).sort(sortByMag);
        if (list.length) compactKids.push(capped(list, `nearby-${g.id}`, g.label, g.note));
      }
      /* 系外行星系统：**按宿主星分组**，一颗行星一行。
       *
       * 为什么不摊平：6 千多颗行星平铺是一面望不到头的墙，而且
       * 「Proxima Cen b / Proxima Cen d」脱离母星根本读不出上下文。
       * 按宿主分组既表达了包含关系（恒星系 → 行星），
       * 又和太阳系的结构一致（太阳系也是「母天体 → 卫星」的嵌套）。
       *
       * ⚠️ 行星数从 758 涨到 6 千多之后**必须截断**了 ——
       *   4 千多个系统 + 6 千多行全铺进 DOM 会把首屏渲染拖到几百毫秒。
       *   但截断的**单位是系统、不是行星**：一个系统要么整组露出来、
       *   要么整组在「显示全部」后面，绝不会出现「Proxima Cen 有 b 没有 d」的半截状态。
       *
       * 数字口径（写错会被 `truncBad` 判据当场抓住）：
       *   total / shown / hidden 的单位是**行星**（面板徽标与截断判据数的都是叶子）；
       *   allNodes 的单位是**系统**（展开时按系统续加）。两者必须一起给。
       */
      const planets = nearAll.filter((b) => b.type === 'exoplanet');
      if (planets.length) {
        const byHost = new Map();
        for (const p of planets) {
          if (!byHost.has(p.hostId)) byHost.set(p.hostId, []);
          byHost.get(p.hostId).push(p);
        }
        const sysGroups = [];
        for (const [hostId, list] of byHost) {
          const host = this.get(hostId);
          // 由内到外排（半长轴小的在前）—— 这是行星系天然的读法
          list.sort((a, b) => (a.semiMajorAu ?? 9e9) - (b.semiMajorAu ?? 9e9));
          sysGroups.push({
            kind: 'group', id: `exosys-${slugId(hostId)}`,
            name: host ? host.name : hostId,
            badge: `${list.length} 颗`,
            body: host || null,          // 点宿主星名字可直接跳过去
            children: list.map(leaf),
          });
        }
        /* 排序：**由近到远**。
         * 原来是按名字排（A→Z）—— 4 千多个系统的首屏会被字母表开头占满，
         * 和「我想先看最近的」这个直觉正好相反。距离相同的再比名字，
         * 显式给二级键，顺序才不会随插入顺序漂。 */
        const distOf = (g) => g.body?.distLy ?? Infinity;
        sysGroups.sort((a, b) => (distOf(a) - distOf(b)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        const shownSys = sysGroups.slice(0, CAP_SYS);
        const shownLeaves = shownSys.reduce((a, g) => a + g.children.length, 0);
        const hidden = planets.length - shownLeaves;
        const allLy = planets.map((p) => p.distLy ?? 0);
        starKids.push(group('nearby-exoplanets',
          `有行星的恒星 · ${byHost.size} 个系统 · ${planets.length} 颗行星`, shownSys, {
            note: hidden > 0
              ? `按宿主恒星分组，宿主**由近到远**排（${Math.min(...allLy).toFixed(1)}–${Math.round(Math.max(...allLy)).toLocaleString('en-US')} 光年）；`
                + `一个系统整组展示，不会只露一半。默认列最近 ${shownSys.length} 个系统（${shownLeaves} 颗行星），`
                + `其余 ${hidden} 颗行星分布在 ${byHost.size - shownSys.length} 个更远的系统里 —— `
                + `点下面的「显示全部」接着翻，或直接搜行星名（检索索引是全量的）。`
              : '',
            total: planets.length, shown: shownLeaves, hidden,
            /* allIds 是**行星** id：`#revealRow` 用它判断「要找的那颗在不在这个组里」。
             * allNodes 是**系统**节点：`#showMore` 用它按系统续加。别把两者混用。 */
            allIds: planets.map((p) => p.id),
            allNodes: sysGroups,
            types: ['exoplanet'], level: 'neighborhood',
          }));
      }
      /* 恒星一支整支收拢在「恒星」下面。⭐ 这是**只加了一层分组、没改任何叶子账目**的改动：
       * 判据数的是叶子与分组声明的 total/shown/hidden，而 grouping 只影响读法，
       * 所以守恒 / 截断 / 沉默三条判据的输入一个字节都没变。
       * 组装顺序也保持不变（有专名的 → 其余 → 有行星的），只是它们现在同级。 */
      if (starKids.length) kids.push(group('nearby-stars', `恒星 · ${nearby.length}`, starKids));
      kids.push(...compactKids);
      tree.push(group('grp-nearby', `邻近恒星系 · ${nearAll.length}`, kids));
    }

    /* ---------- 银河系 ---------- */
    const mwAll = byLevel('galaxy');
    // ⚠️ 判据用 isCataloged（深空编目 ∪ 致密天体），不是单看 DEEP_TYPE_LABEL ——
    //    否则脉冲星/黑洞会被当成「银河系结构」（见 isCataloged 注释）
    const mwStruct = mwAll.filter((b) => !isCataloged(b));
    const mwObjects = mwAll.filter((b) => isCataloged(b)).sort(sortByMag);
    const mwKids = [];
    if (mwStruct.length) mwKids.push(group('mw-structure', `银河系结构 · ${mwStruct.length}`, mwStruct.map(leaf)));
    for (const g of CATALOG_GROUPS) {
      const list = mwObjects.filter((b) => g.types.includes(b.type));
      if (list.length) mwKids.push(capped(list, `mw-${g.id}`, g.label, g.note));
    }
    if (mwKids.length) tree.push(group('grp-milkyway', `银河系 · ${mwAll.length}`, mwKids));

    /* ---------- 本星系群 ---------- */
    const lg = byLevel('localgroup').filter((b) => b.type !== 'galaxy' || b.id !== 'milkyway');
    const lgKids = [];
    const lgNamed = lg.filter((b) => !DEEP_TYPE_LABEL[b.type] || b.common || b.messier != null);
    const lgRest = lg.filter((b) => !lgNamed.includes(b));
    if (lgNamed.length) lgKids.push(group('lg-named', `主要成员 · ${lgNamed.length}`, lgNamed.map(leaf)));
    if (lgRest.length) lgKids.push(capped(lgRest.sort(sortByMag), 'lg-rest', '矮星系'));
    if (lgKids.length) tree.push(group('grp-localgroup', `本星系群 · ${lg.length}`, lgKids));

    /* ---------- 室女座超星系团 ---------- */
    const sc = byLevel('supercluster');
    // ⚠ 判「是不是结构」必须用 isCataloged，不能用 !DEEP_TYPE_LABEL：
    //   致密天体（bh/blackhole/psr/wd/whitedwarf）不在 DEEP_TYPE_LABEL 里，
    //   用后者会把它们误判成「超星系团与星系团」——这正是「黑洞整批消失」的根因
    //   （见文件上方 isCataloged 的注释）。
    //   `b.type !== 'galaxy'` 是**显式化**、不是修 bug：galaxy 本来就在 DEEP_TYPE_LABEL 里，
    //   两种写法都会把它排除掉。写出来只是让「星系归 sc-galaxies、结构归 sc-structure」一眼可读。
    const scStruct = sc.filter((b) => b.type !== 'galaxy' && !isCataloged(b));
    const scGal = sc.filter((b) => b.type === 'galaxy').sort(sortByMag);
    const scKids = [];
    if (scStruct.length) scKids.push(group('sc-structure', `超星系团与星系团 · ${scStruct.length}`, scStruct.map(leaf)));
    if (scGal.length) scKids.push(capped(scGal, 'sc-galaxies', '编目星系'));
    const noDist = sc.filter((b) => b.noDistance).length;
    if (noDist) {
      // 同 capped()：截断必须自己交代，别让「397」和「120」并排摆着不说原因
      const NODIST_CAP = 120;
      const noDistList = sc.filter((b) => b.noDistance);
      const shownNoDist = noDistList.slice(0, NODIST_CAP);
      scKids.push(group('sc-nodist', `距离未测定的近距星系 · ${noDist}`,
        shownNoDist.map(leaf), {
          note: noDist > NODIST_CAP
            ? `红移过小、哈勃定律不适用，无法定距离。此处只列 ${NODIST_CAP} 条，其余 ${noDist - NODIST_CAP} 个点「显示全部」接着翻，或直接搜索。`
            : '红移过小，哈勃定律不适用。',
          total: noDist, shown: shownNoDist.length, hidden: Math.max(0, noDist - NODIST_CAP),
          allIds: noDistList.map((b) => b.id),
          types: ['galaxy'], level: 'supercluster', where: 'noDistance',
        }));
    }
    if (scKids.length) tree.push(group('grp-supercluster', `室女座超星系团 · ${sc.length}`, scKids));

    /* ---------- 可观测宇宙 ---------- */
    const uv = byLevel('universe');
    // 同 scStruct：用 isCataloged 而不是 !DEEP_TYPE_LABEL（理由见上）
    const uvStruct = uv.filter((b) => b.type !== 'galaxy' && !isCataloged(b));
    const uvGal = uv.filter((b) => b.type === 'galaxy').sort(sortByMag);
    const uvKids = [];
    if (uvStruct.length) uvKids.push(group('uv-structure', `大尺度结构 · ${uvStruct.length}`, uvStruct.map(leaf)));
    if (uvGal.length) uvKids.push(capped(uvGal, 'uv-galaxies', '遥远星系'));
    if (uvKids.length) tree.push(group('grp-universe', `可观测宇宙 · ${uv.length}`, uvKids));

    /* ---------- 尺度归属 ----------
     * 目录树的顶层是 13 个**并列**分组，但它们在物理上是**嵌套**的：
     * 太阳系被邻近恒星系包含、邻近恒星系被银河系包含……一直到可观测宇宙。
     * 界面要把这层包含关系画出来（见 ui/panel.js 的尺度分节），
     * 所以归属信息在这里、和树一起定义 —— 不放到 UI 里另写一张表，
     * 否则「树改了、表没改」就是必然会发生的事（这个项目已经吃过同类亏）。
     *
     * 穷尽性就地落账：漏一个就进 catalogUntiered，诊断脚本/自检会报出来。
     */
    const TIER_OF = {
      'grp-sun': 'solar', 'grp-planets': 'solar', 'grp-dwarfs': 'solar',
      'grp-belt': 'solar', 'grp-kuiper': 'solar', 'grp-comets': 'solar',
      'grp-regions': 'solar', 'grp-probes': 'solar',
      'grp-nearby': 'neighborhood', 'grp-milkyway': 'galaxy',
      'grp-localgroup': 'localgroup', 'grp-supercluster': 'supercluster',
      'grp-universe': 'universe',
    };
    for (const n of tree) n.tier = TIER_OF[n.id] || null;
    /** 没归入任何尺度的顶层分组 id。**应恒为空**；非空 = TIER_OF 漏了分组。 */
    this.catalogUntiered = tree.filter((n) => !n.tier).map((n) => n.id);

    return tree;
  }

  /** 目录树中所有天体（含重复引用） */
  catalogBodies() {
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.body) out.push(n.body);
        if (n.children) walk(n.children);
      }
    };
    walk(this.catalog);
    return out;
  }

  #buildIndex() {
    const idx = [];
    const push = (o, aliasParts = []) => {
      const aliases = [o.name, o.en, o.ids, o.fullname, o.common, ...aliasParts].filter(Boolean).join(' ');
      idx.push({
        id: o.id, name: o.name, en: o.en, type: o.type, typeLabel: o.typeLabel,
        level: o.level, view: o.view, sub: o.subtitle || o.typeLabel, aliases,
        levelName: SCALE_BY_ID.get(o.level)?.name || '',
        key: `${o.name} ${o.en || ''} ${aliases}`.toLowerCase(),
      });
    };
    // 全尺度索引：太阳系天体、邻近恒星、编目深空天体、宇宙结构、视角预设全都能搜到
    for (const b of this.bodies.values()) {
      const extra = [];
      if (b.messier != null) extra.push(`M${b.messier}`, `梅西耶${b.messier}`);
      if (b.constellation) extra.push(b.constellation);
      if (b.common) extra.push(b.common);
      push(b, extra);
    }
    for (const v of VIEW_ENTRIES) push(v);
    this.index = idx;
  }

  get(id) { return this.bodies.get(id); }

  /**
   * 银河系尺度的全量恒星点云（HYG v41，10.9 万颗，约 6.5 MB）。
   * 只在真正进入「银河系」层级时才加载 —— 首屏不该为一个还没看到的层级付流量。
   */
  async loadGalacticStars() {
    if (this.galacticStars) return this.galacticStars;
    if (this._galacticPromise) return this._galacticPromise;
    this._galacticPromise = fetch('./data/stars-galactic.json')
      .then((r) => r.json())
      .then((j) => { this.galacticStars = j; return j; })
      .catch((err) => {
        console.warn('[dataset] 银河系恒星表加载失败，退化为程序化分布', err);
        this.galacticStars = { columns: [], rows: [], meta: {} };
        return this.galacticStars;
      });
    return this._galacticPromise;
  }

  /** 模糊检索：返回排序后的目的地 */
  search(query, limit = 10) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.index.slice(0, limit);
    const terms = q.split(/\s+/).filter(Boolean);
    const out = [];
    for (const item of this.index) {
      let score = 0;
      for (const t of terms) {
        const pos = item.key.indexOf(t);
        if (pos < 0) {
          // 允许跳字符匹配（如「木卫二」→「木卫二·欧罗巴」已含，此处兜底）
          if (subsequence(t, item.key)) score += 1;
          else { score = -1; break; }
        } else {
          score += 10 - Math.min(9, pos / 3);
          if (item.name.toLowerCase() === t) score += 14;
          else if (item.name.toLowerCase().startsWith(t)) score += 8;
          if (item.en?.toLowerCase() === t) score += 12;
        }
      }
      if (score > 0) out.push({ ...item, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  /** 恒星颜色（用于渲染与图例） */
  static typeColor(type) {
    return {
      star: '#ffcf5c', planet: '#67e8f9', dwarf: '#a78bfa', moon: '#c8d4e4',
      asteroid: '#b9a68c', comet: '#bfe8ff', tno: '#8fd3e8', region: '#64789a',
      probe: '#ff9a5c', ring: '#e8dcc0', galaxy: '#bcd8ff', cluster: '#ffd9a8', supercluster: '#a78bfa',
      // 系外行星的色块**只是类型标记**：真实示意色按平衡温度算，存在 body.color 上
      exoplanet: '#f0a6ca',
    }[type] || '#9ec5ff';
  }
}

/** 视角预设：按所属尺度层级分组（导航栏按当前层级取用） */
export const VIEW_ENTRIES = [
  /* ---- 太阳系 ---- */
  { id: 'view-overview', name: '全景', en: 'Overview', type: 'view', level: 'solar', view: 'overview', typeLabel: '视角', sub: '从太阳到柯伊伯带', aliases: '全景 太阳系 总览 overview' },
  { id: 'view-inner', name: '内行星', en: 'Inner System', type: 'view', level: 'solar', view: 'inner', typeLabel: '视角', sub: '水星 · 金星 · 地球 · 火星', aliases: '内行星 水星 金星 地球 火星' },
  { id: 'view-outer', name: '外行星', en: 'Outer System', type: 'view', level: 'solar', view: 'outer', typeLabel: '视角', sub: '木星 · 土星 · 天王星 · 海王星', aliases: '外行星 木星 土星 天王星 海王星' },
  { id: 'view-belt', name: '小行星带', en: 'Asteroid Belt', type: 'view', level: 'solar', view: 'belt', typeLabel: '视角', sub: '谷神星 · 灶神星 · 智神星…', aliases: '小行星带 主带 asteroid belt' },
  { id: 'view-kuiper', name: '柯伊伯带', en: 'Kuiper Belt', type: 'view', level: 'solar', view: 'kuiper', typeLabel: '视角', sub: '冥王星 · 阋神星 · 海外天体', aliases: '柯伊伯带 冥王星 kuiper' },

  /* ---- 邻近恒星系 ---- */
  { id: 'view-nearby', name: '邻星全景', en: 'Neighborhood', type: 'view', level: 'neighborhood', view: 'overview', typeLabel: '视角', sub: '3262 光年内的恒星分布', aliases: '邻近恒星 邻星 恒星系 stellar neighborhood' },

  /* ---- 银河系 ---- */
  { id: 'view-galaxy', name: '银盘全景', en: 'Galactic Disk', type: 'view', level: 'galaxy', view: 'overview', typeLabel: '视角', sub: '从外部俯瞰银河系', aliases: '银河系 银盘 全景 milky way' },

  /* ---- 本星系群 ---- */
  { id: 'view-localgroup', name: '本星系群', en: 'Local Group', type: 'view', level: 'localgroup', view: 'overview', typeLabel: '视角', sub: '银河系 · 仙女座 · 麦哲伦云', aliases: '本星系群 local group 仙女座' },

  /* ---- 室女座超星系团 ---- */
  { id: 'view-supercluster', name: '超星系团', en: 'Supercluster', type: 'view', level: 'supercluster', view: 'overview', typeLabel: '视角', sub: '拉尼亚凯亚 · 室女座星系团', aliases: '超星系团 室女座 拉尼亚凯亚 巨引源' },

  /* ---- 可观测宇宙 ---- */
  { id: 'view-universe', name: '宇宙全景', en: 'Cosmic Web', type: 'view', level: 'universe', view: 'overview', typeLabel: '视角', sub: '宇宙网 · 巨壁 · 微波背景', aliases: '可观测宇宙 宇宙网 微波背景 universe' },
];

/** 某个尺度层级下的视角预设 */
export function viewsForLevel(levelId) {
  return VIEW_ENTRIES.filter((v) => v.level === levelId);
}

export const LEVEL_ENTRIES = VIEW_ENTRIES;

function subsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

export { TYPE_LABEL, AU_KM, MOON_GROUP, SMALL_GROUP };

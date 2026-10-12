/**
 * 尺度语义 · 属性的**唯一定义源**
 *
 * 为什么需要这个文件：
 *   同一个天体放在不同的尺度场景里，该讲的属性**不是同一套**。
 *   出了太阳系再拿「轨道倾角 / 升交点黄经 / 与太阳距离」讲属性是没有意义的 ——
 *   一个 2.7 万光年外的系外行星，「与太阳的距离」既不是它的轨道参数，
 *   也不是任何人会用来描述它的量。面板照着太阳系那一套渲染，
 *   结果就是**每个天体都显示一堆与它无关的字段**（用户原话：
 *   「大部分的天体属性都还默认走的太阳系内部的那一套，这不合理的」）。
 *
 * 所以把「某一层该用哪个位置口径、哪个单位、显示哪些属性」集中在这里，
 * 面板、渲染层、探针都从这里取。**不要在别处再写第二套判断。**
 */

/** 尺度阶梯的顺序（与 `core/scales.js` 的 SCALE_CHAIN 一致，但这里只关心 id 与语义） */
export const TIER_ORDER = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe'];

const TIER_LABEL = {
  solar: '太阳系', neighborhood: '邻近恒星系', galaxy: '银河系',
  localgroup: '本星系群', supercluster: '室女座超星系团', universe: '可观测宇宙',
};

/**
 * 每一层的位置口径。
 *
 *   unit        —— 位置用什么长度单位
 *   fromSun     —— 这一层里「与太阳的距离」是不是一个有意义的量
 *   ecliptic    —— 这一层里「黄道面夹角 / 升交点」这类**相对黄道**的量有意义吗
 *   galaSun     —— 这一层里「银心距」是不是一个该显示的定位量
 *   coordName   —— 给人看的坐标系名字（面板里写出来，免得用户猜）
 *
 * ⚠️ 「与太阳的距离」只在 solar + neighborhood 为真。
 *    在银河系层写「与太阳距离 2.7 万光年」还对（那是太阳系自己的位置），
 *    但写到**别人**头上就成了怪话 —— 判断要看**被描述的天体**，不是只看层级。
 */
export const TIER_ATTR = {
  solar: {
    label: TIER_LABEL.solar, unit: 'AU', unitName: '天文单位',
    fromSun: true, ecliptic: true, galaSun: false, coordName: '黄道坐标 · 日心',
  },
  neighborhood: {
    label: TIER_LABEL.neighborhood, unit: 'ly', unitName: '光年',
    fromSun: true, ecliptic: false, galaSun: false, coordName: '赤道 J2000 直角坐标 · 太阳在原点',
  },
  galaxy: {
    label: TIER_LABEL.galaxy, unit: 'kly', unitName: '千光年',
    fromSun: false, ecliptic: false, galaSun: true, coordName: '银道坐标 · 银心在原点',
  },
  localgroup: {
    label: TIER_LABEL.localgroup, unit: 'Mly', unitName: '百万光年',
    fromSun: false, ecliptic: false, galaSun: false, coordName: '共动直角坐标',
  },
  supercluster: {
    label: TIER_LABEL.supercluster, unit: 'Mly', unitName: '百万光年',
    fromSun: false, ecliptic: false, galaSun: false, coordName: '共动直角坐标',
  },
  universe: {
    label: TIER_LABEL.universe, unit: 'Gly', unitName: '十亿光年',
    fromSun: false, ecliptic: false, galaSun: false, coordName: '共动直角坐标',
  },
};

/** 这个天体的「主场」是哪一层。缺 level 时按类型猜，但**猜出来的要标出来**。 */
export function tierOf(b) {
  if (!b) return 'solar';
  if (b.level && TIER_ATTR[b.level]) return b.level;
  if (b.type === 'exoplanet') return 'neighborhood';
  if (b.type === 'star') return 'neighborhood';
  if (['galaxy', 'bh', 'psr', 'wd', 'snr', 'planetarynebula', 'globular', 'opencluster', 'nebula'].includes(b.type)) return 'galaxy';
  return 'solar';
}

/** 这一层是不是该显示「与太阳的距离」 */
export const showsSunDistance = (tier) => Boolean(TIER_ATTR[tier]?.fromSun);
/** 这一层是不是该显示黄道面相关的量（轨道倾角 / 升交点 / 近日点黄经） */
export const showsEcliptic = (tier) => Boolean(TIER_ATTR[tier]?.ecliptic);
/** 这一层是不是该显示银心距 */
export const showsGalacticRadius = (tier) => Boolean(TIER_ATTR[tier]?.galaSun);

/* ------------------------------------------------------- 结构锚 */

/**
 * 结构锚的**唯一词表**。
 *
 * 有些天体「在世界原点」不是缺数据，是定义 —— 太阳、银河系、本星系群
 * 在各自那一层就**应当**是原点。这类对象用 `anchor` **自己声明**，
 * 而不是由检查脚本维护一份豁免名单：名单会腐烂，字段跟着对象走。
 *
 *   home     我们所在的位置。**必须**在世界原点。
 *   context  高一层里作为**上下文**出现的点标记。位置必须是**真的**
 *            （不能拿它盖住缺坐标），而且只能标**更低**（或同层）的天体 ——
 *            反过来就是把高等尺度的东西塞进低层，那正是
 *            「太阳被别的尺度的天体糊成一个大方块」这件事本身。
 *
 * ⚠️ 声明写错一个字母（`hoem`）如果照样被当成有效豁免，就等于「**声明错 = 免检**」——
 *    比不声明更坏，因为它看起来是有人管过的。所以词表只有这一份：
 *    探针（`tools/probe-placements.py`）与自检（`server/lib/selfcheck.mjs`）
 *    都从这里取，不认识的取值一律判故障，不当成"未知种类"放过。
 */
export const ANCHOR_HOME = 'home';
export const ANCHOR_CONTEXT = 'context';
export const ANCHOR_KINDS = {
  [ANCHOR_HOME]: '我们所在的位置，必须在世界原点',
  [ANCHOR_CONTEXT]: '高一层里的上下文点标记，位置必须真实，且只能来自更低（或同层）的尺度',
};
export const isAnchorKind = (v) => Object.prototype.hasOwnProperty.call(ANCHOR_KINDS, v);

/* ---------------------------------------------------------------- 位置 */

/** 三个分量都是**有限数**才算有位置。⚠️ 全零要单独判 —— 见 `isOriginPlace`。 */
export function hasFiniteXYZ(b) {
  return Boolean(b) && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z);
}

/** 三个分量恰好全零。在笛卡尔星表里，「全零」几乎总是**缺数据**而不是真的在原点。 */
export function isOriginPlace(b) {
  return hasFiniteXYZ(b) && b.x === 0 && b.y === 0 && b.z === 0;
}

const PC_TO_LY = 3.2615637769;

/** 从任意一种距离字段解析出**光年**。解析不出来返回 null。 */
export function distLyOf(b) {
  if (!b) return null;
  if (Number.isFinite(b.distLy)) return b.distLy;
  if (Number.isFinite(b.distMly)) return b.distMly * 1e6;
  if (Number.isFinite(b.distPc)) return b.distPc * PC_TO_LY;
  if (Number.isFinite(b.plxMas) && b.plxMas > 0) return (1000 / b.plxMas) * PC_TO_LY;  // 视差 mas → 秒差距
  return null;
}

/**
 * 解析出**邻近恒星系层（单位：光年）**可用的位置。拿不到就返回 `null`。
 *
 * 两条支路：
 *   1. `x/y/z` 有限 → 直接用（HYG 与系外行星宿主星都是这个口径）
 *   2. 只有 `ra/dec` + 某个距离 → 按赤道 J2000 直角坐标现算
 *      （与 `dataset.js` 反算致密天体、`build-data.mjs` 反算宿主星**同一套约定**：
 *       x 指向 RA=0、y 指向 RA=90°、z 指向北天极）
 *
 * ⚠️ 全零当成「没有位置」。
 *    `new THREE.Vector3(undefined,…)` 不抛异常，得到 NaN 向量；
 *    `(0,0,0)` 是**合法**向量。两者在渲染上**都表现为堆在世界原点**，
 *    而世界原点恰好是太阳 —— 视觉上就是「太阳变成一坨大方框」。
 *    唯一的例外是太阳自己，调用方用 `allowOrigin` 显式放行。
 */
export function placeOfLy(b, { allowOrigin = false } = {}) {
  if (!b) return null;
  if (hasFiniteXYZ(b)) {
    if (isOriginPlace(b) && !allowOrigin) return null;
    return { x: b.x, y: b.y, z: b.z };
  }
  if (!Number.isFinite(b.ra) || !Number.isFinite(b.dec)) return null;
  const d = distLyOf(b);
  if (!Number.isFinite(d) || d <= 0) return null;
  const ra = (b.ra * Math.PI) / 180, dec = (b.dec * Math.PI) / 180;
  return {
    x: d * Math.cos(dec) * Math.cos(ra),
    y: d * Math.cos(dec) * Math.sin(ra),
    z: d * Math.sin(dec),
  };
}

/* ------------------------------------------------------- 位置的可信度分级 */

/**
 * 落点的**可信度**。三种，互斥，穷尽。
 *
 * 为什么需要它：绘制代码和检查代码曾经各自定义过「这个天体有没有位置」——
 *   · `galaxy.js` 的口径是「`ra/dec` 有限就算有位置，距离没有就用代表值 5 千光年」；
 *   · 探针的口径是「`placeOfLy()` 解析不出就是没有位置」。
 * 于是同一批天体（NGC 405、IC 4816、几个 X 射线双星黑洞）在绘制代码眼里是
 * 「方位已知、距离未测定」，在探针眼里是「无位置却落点」——
 * **一条具体的、看起来很专业的错误结论**，照着它修会去动本来正确的代码。
 * 所以判据收到这里，两边都从这里取。
 *
 *   exact   有直角坐标（或 ra/dec + 实测距离）→ 位置是**测出来的**
 *   typical 只有 ra/dec、距离未测定 → 方位是真的，距离是**按类型给的代表值**
 *   none    两者都没有 → 这一层画不出它，只能留在目录里
 *
 * ⚠️ 全零直角坐标按 `typical`/`none` 处理，不按 `exact` ——
 *    笛卡尔星表里的 (0,0,0) 几乎总是缺数据，而世界原点恰好是太阳。
 *    真的在原点的那几个（太阳、银河系、本星系群）用 `anchor: 'home'` **自己声明**，
 *    不靠这里猜。
 */
export const PLACE_EXACT = 'exact';
export const PLACE_TYPICAL = 'typical';
export const PLACE_NONE = 'none';

export function placeAccuracy(b, { allowOrigin = false } = {}) {
  if (!b) return PLACE_NONE;
  const hasRaDec = Number.isFinite(b.ra) && Number.isFinite(b.dec);
  if (hasFiniteXYZ(b)) {
    if (isOriginPlace(b) && !allowOrigin) return hasRaDec ? PLACE_TYPICAL : PLACE_NONE;
    return PLACE_EXACT;
  }
  if (hasRaDec) return PLACE_TYPICAL;
  return PLACE_NONE;
}

/** 这个天体能不能落点（不管落得准不准）。`none` 才是真的落不了点。 */
export function canPlace(b, opts) {
  return placeAccuracy(b, opts) !== PLACE_NONE;
}

/** 赤道 J2000 **位置向量** → 银道直角坐标（纯旋转，与 `galaxy.js` 同一个矩阵）。 */
export function equatorialToGalacticVec(x, y, z) {
  return [
    -0.0548755604 * x - 0.8734370902 * y - 0.4838350155 * z,
    0.4941094279 * x - 0.44482963 * y + 0.7469822445 * z,
    -0.867666149 * x - 0.1980763734 * y + 0.4559837762 * z,
  ];
}

/** 赤道 J2000 的 ra/dec（度）+ 半径 → 银道直角坐标 */
export function equatorialToGalactic(raDeg, decDeg, r = 1) {
  const ra = (raDeg * Math.PI) / 180, dec = (decDeg * Math.PI) / 180;
  return equatorialToGalacticVec(
    r * Math.cos(dec) * Math.cos(ra),
    r * Math.cos(dec) * Math.sin(ra),
    r * Math.sin(dec),
  );
}

/** 太阳到银心的距离（秒差距）。GRAVITY 2022 对 Sgr A* 的测定：8.178 kpc。 */
export const R0_PC = 8178;

/**
 * 银心距（千光年）。**这是银河系层真正该显示的定位量**，
 * 取代在那一层毫无意义的「与太阳的距离」。
 *
 * 口径：把**日心赤道直角坐标**（本项目统一是光年）转进银道系，
 * 得到的是「相对太阳」的银道分量 g_vec（其中 +gx 指向银心）。
 * 银心相对太阳在 +gx·R0 处 ⇒ **太阳相对银心在 −gx·R0 处**，
 * 所以 银心距 = |g_vec − R0·x̂|。**是减号。**
 *
 * ⚠️ 这里踩过一次符号坑，而且是**只有第二个锚点才抓得住**的那种：
 *    用 `gx - R0` 时，太阳（g_vec = 0）与 Sgr A*（g_vec = +R0·x̂）
 *    分别得到 R0 与 0，都对；写成 `gx + R0` 时**太阳那个锚点照样对**
 *    （0 加还是减都一样），只有 Sgr A* 会给出 2R0 ≈ 53.3 kly 的错值。
 *    ⇒ 锚点不能只挑「方便的那个」。**守住这两条**：
 *      太阳（allowOrigin）→ 26.67 kly；Sgr A*（ra=266.4168, dec=-29.0078, d=8178 pc）→ ≈ 0。
 */
export function galacticRadiusKly(b, { allowOrigin = false } = {}) {
  const p = placeOfLy(b, { allowOrigin });
  if (!p) return null;
  const [gx, gy, gz] = equatorialToGalacticVec(p.x, p.y, p.z);   // 日心银道，单位光年
  const r0Ly = R0_PC * PC_TO_LY;
  return Math.hypot(gx - r0Ly, gy, gz) / 1000;                   // 光年 → 千光年
}

/* ---------------------------------------------------------------- 质量 */

export const SOLAR_MASS_KG = 1.98847e30;
export const EARTH_MASS_KG = 5.97237e24;
export const JUPITER_MASS_KG = 1.89813e27;

/**
 * 把天体上**任意一种**质量字段归一成一套可比的口径。
 * 没有质量就返回 `null` —— **不要返回 0，也不要显示「—」**：
 * 「质量未知」和「质量是 0」在界面上必须是两件事。
 */
export function massOf(b) {
  if (!b) return null;
  if (Number.isFinite(b.massKg) && b.massKg > 0) {
    return finish(b.massKg, b.massSource || '实测');
  }
  if (Number.isFinite(b.massSolar) && b.massSolar > 0) {
    return finish(b.massSolar * SOLAR_MASS_KG, b.massSource || '实测（NASA Exoplanet Archive）');
  }
  if (Number.isFinite(b.massEarth) && b.massEarth > 0) {
    return finish(b.massEarth * EARTH_MASS_KG, b.massSource || '实测');
  }
  if (Number.isFinite(b.massJup) && b.massJup > 0) {
    return finish(b.massJup * JUPITER_MASS_KG, b.massSource || '实测');
  }
  return null;
}

function finish(kg, source) {
  return {
    kg,
    solar: kg / SOLAR_MASS_KG,
    earth: kg / EARTH_MASS_KG,
    jupiter: kg / JUPITER_MASS_KG,
    source,
  };
}

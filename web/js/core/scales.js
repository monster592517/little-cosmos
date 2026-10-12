/**
 * 宇宙尺度阶梯
 *
 *  本项目由若干个彼此独立的「层级」组成。每个层级有自己的场景、相机与长度单位——
 *  这是必须的：1 AU 与 1 Gly 相差 20 个数量级，塞进同一个场景会让浮点精度彻底崩溃。
 *
 *  这份定义是**唯一的排序来源**：引擎的「拉远/拉近」、导航栏的尺度条、目录树的分组
 *  都从这里读，避免出现三处各写一套顺序、改一处忘两处的情况。
 *
 *  单位约定（每层内部自洽）：
 *    太阳系    1 = 1 AU
 *    邻近恒星  1 = 1 光年
 *    银河系    1 = 1 千光年（kly）
 *    本星系群  1 = 1 百万光年（Mly）
 *    超星系团  1 = 100 百万光年
 *    可观测宇宙 1 = 10 亿光年（Gly）
 */

export const SCALE_CHAIN = [
  {
    id: 'solar',
    order: 0,
    name: '太阳系',
    en: 'Solar System',
    subtitle: '行星 · 卫星 · 小行星 · 彗星 · 探测器',
    unit: 'AU',
    unitNote: '1 单位 = 1 天文单位（约 1.496 亿公里）',
    /** 本层级「我们的位置」在天体表里的 id，跨尺度跳转时用作锚点 */
    homeId: 'sun',
    homeName: '太阳',
  },
  {
    id: 'neighborhood',
    order: 1,
    name: '邻近恒星系',
    en: 'Stellar Neighborhood',
    subtitle: '3262 光年内的恒星与系外行星系统',
    unit: 'ly',
    unitNote: '1 单位 = 1 光年',
    homeId: 'star-sun',
    homeName: '太阳',
  },
  {
    id: 'galaxy',
    order: 2,
    name: '银河系',
    en: 'Milky Way',
    subtitle: '旋臂 · 银心 · 球状星团 · 星云',
    unit: 'kly',
    unitNote: '1 单位 = 1 千光年',
    homeId: 'mw-sun',
    homeName: '太阳系位置',
  },
  {
    id: 'localgroup',
    order: 3,
    name: '本星系群',
    en: 'Local Group',
    subtitle: '银河系 · 仙女座 · 三角座 · 麦哲伦云',
    unit: 'Mly',
    unitNote: '1 单位 = 1 百万光年',
    homeId: 'milkyway',
    homeName: '银河系',
  },
  {
    id: 'supercluster',
    order: 4,
    name: '室女座超星系团',
    en: 'Virgo Supercluster',
    subtitle: '拉尼亚凯亚 · 室女座星系团 · 巨引源',
    unit: '100 Mly',
    unitNote: '1 单位 = 1 亿光年',
    homeId: 'local-group',
    homeName: '本星系群',
  },
  {
    id: 'universe',
    order: 5,
    name: '可观测宇宙',
    en: 'Observable Universe',
    subtitle: '宇宙网 · 巨壁 · 宇宙微波背景',
    unit: 'Gly',
    unitNote: '1 单位 = 10 亿光年',
    homeId: 'milkyway',
    homeName: '银河系',
  },
];

export const SCALE_BY_ID = new Map(SCALE_CHAIN.map((s) => [s.id, s]));

/** 某个层级的尺度次序，未知层级返回 -1 */
export function scaleOrder(levelId) {
  return SCALE_BY_ID.get(levelId)?.order ?? -1;
}

/** 比给定层级更大的下一层；没有则返回 null */
export function nextBigger(levelId) {
  const i = scaleOrder(levelId);
  return i >= 0 && i < SCALE_CHAIN.length - 1 ? SCALE_CHAIN[i + 1] : null;
}

/** 比给定层级更小的下一层；没有则返回 null */
export function nextSmaller(levelId) {
  const i = scaleOrder(levelId);
  return i > 0 ? SCALE_CHAIN[i - 1] : null;
}

/** 把「1 单位」换算成光年的通用因子，用于标签上的尺度提示 */
export const UNIT_IN_LY = {
  solar: 1.495978707e-5,
  neighborhood: 1,
  galaxy: 1000,
  localgroup: 1e6,
  supercluster: 1e8,
  universe: 1e9,
};

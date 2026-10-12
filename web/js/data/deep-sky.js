/**
 * 深空数据集：邻近恒星专名与资料、本星系群星系、超星系团尺度结构、银河系结构。
 *
 *  星系坐标 = 由真实赤经/赤纬 + 距离换算出的赤道直角坐标（单位：百万光年）。
 *  银河系结构参数取自 Gaia DR3 / GRAVITY 对银心距离的测定（26.7 千光年）。
 */

/** 赤经(度)、赤纬(度)、距离(Mly) → 直角坐标 */
function xyz(raDeg, decDeg, dist) {
  const ra = (raDeg * Math.PI) / 180, dec = (decDeg * Math.PI) / 180;
  return [
    +(dist * Math.cos(dec) * Math.cos(ra)).toFixed(4),
    +(dist * Math.cos(dec) * Math.sin(ra)).toFixed(4),
    +(dist * Math.sin(dec)).toFixed(4),
  ];
}

const G = (id, name, en, type, ra, dec, distMly, extra = {}) => {
  const [x, y, z] = xyz(ra, dec, distMly);
  return { id, name, en, type, x, y, z, distMly, ra, dec, ...extra };
};

/** 本星系群及近邻星系（距离 ≤ 10 Mly）
 *
 * ## 盘面朝向：`incl` / `pa` / `pole`（2026-09-12 新增）
 *
 * 星系是**盘**，不是贴纸 —— 盘必须有固定朝向，否则转过去看不到侧视。
 * 朝向参数口径（与 `builders.js::galaxyDiscQuaternion` 一一对应）：
 *   · `incl` 盘面倾角，0° = 正对我们、90° = 侧对我们
 *   · `pa`   位置角，长轴在天空上的方向，**从北向东量**（文献里 PA 的标准口径）
 *   · `pole` 直接给盘面法线的赤经/赤纬 —— 给「我们在它里面」的银河系用
 *
 * ⚠️ **只写有实测出处的，不许凭印象填。** 目前有据可查的：
 *   · 银河系 —— 银道面方向是精确常数，用 `pole`（银北极 ICRS）
 *   · M31 —— i=77°、PA=38°（Walterbos & Kennicutt 1988 / 1987）
 *   · M33 —— i=49°、PA=21°（Corbelli & Schneider 1997）
 *   · LMC —— i=35°、PA=123°（van der Marel & Cioni 2001）
 *     以上三颗的取值口径见 MNRAS 418, 2014（Lee 2011 形式）那张汇总表。
 *   · **其余成员没有可靠倾角**（不规则矮星系的「盘」是否存在本身有争议）
 *     ⇒ 不填，由 `galaxyDiscQuaternion` 按 id 派生一个**确定性**角度，
 *       代码里明确标注为**示意、不是实测**。
 */
export const GALAXIES = [
  G('milkyway', '银河系', 'Milky Way', 'spiral', 0, 0, 0, {
    /* `anchor: 'home'` —— 我们在它里面，所以它在世界原点是**定义**而不是缺数据。
     * 判据「这一层画了别的层的东西」「无位置却落点」都要认这份声明，
     * 否则会把正确行为报成故障。 */
    anchor: 'home',
    /* 我们在银河系**里面**，「它对我们倾斜多少度」是没有定义的量；
     * 有定义的是**银道面本身的方向** —— 银北极（ICRS）是天文常数，
     * 用它当盘面法线，银河系的盘就被摆到了真实位置上。 */
    pole: [192.85948, 27.12825],
    color: '#bcd8ff', diameterLy: 105700, mass: '1.5 万亿太阳质量', group: '本星系群',
    desc: '我们所在的棒旋星系，直径约 10 万光年，包含 1000–4000 亿颗恒星。太阳位于猎户臂内侧，距银心约 2.67 万光年。',
    facts: ['中心是质量约 430 万太阳质量的超大质量黑洞 Sgr A*。', '银河系正以约 630 km/s 向巨引源方向运动。', '盖亚卫星已精确测量约 18 亿颗恒星的位置与运动。'],
    researchQuery: 'Milky Way Gaia structure',
  }),
  G('lmc', '大麦哲伦云', 'Large Magellanic Cloud', 'irregular', 80.894, -69.756, 0.163, {
    incl: 35, pa: 123,       // van der Marel & Cioni 2001（它被当作有盘处理）
    color: '#a8d0ff', diameterLy: 32200, mass: '约 100 亿太阳质量', group: '本星系群',
    desc: '银河系最大的卫星星系，在南半球肉眼可见。它是活跃的恒星形成区，1987A 超新星就爆发于此。',
    facts: ['正在被银河系潮汐拉伸，形成麦哲伦桥与麦哲伦流。', '含有著名的蜘蛛星云（30 Doradus）。'],
    researchQuery: 'Large Magellanic Cloud star formation',
  }),
  G('smc', '小麦哲伦云', 'Small Magellanic Cloud', 'irregular', 13.158, -72.829, 0.200, {
    color: '#b8d8ff', diameterLy: 18900, group: '本星系群',
    desc: '银河系第二大卫星星系，金属含量低，是研究早期宇宙恒星形成的重要样本。',
    facts: ['与大麦哲伦云之间有物质桥相连。'],
    researchQuery: 'Small Magellanic Cloud',
  }),
  G('m31', '仙女座星系', 'Andromeda Galaxy (M31)', 'spiral', 10.685, 41.269, 2.537, {
    incl: 77, pa: 38,        // Walterbos & Kennicutt 1988 / 1987（近侧视）
    color: '#cfe0ff', diameterLy: 220000, mass: '约 1.5 万亿太阳质量', group: '本星系群',
    desc: '距离最近的大型螺旋星系，直径约 22 万光年，是银河系质量的约 1.5 倍。它以 110 km/s 的速度接近我们。',
    facts: ['约 45 亿年后将与银河系合并，形成「仙女-银河星系」。', '哈勃望远镜在紫外波段观测到其双核结构与大量年轻星团。', '拥有约 1 万亿颗恒星。'],
    researchQuery: 'Andromeda M31 collision Milky Way',
  }),
  G('m33', '三角座星系', 'Triangulum Galaxy (M33)', 'spiral', 23.462, 30.660, 2.730, {
    incl: 49, pa: 21,        // Corbelli & Schneider 1997（中等倾角）
    color: '#c8dcff', diameterLy: 60000, group: '本星系群',
    desc: '本星系群第三大星系，正面朝向我们的旋涡星系，恒星形成率很高。',
    facts: ['可能是仙女座星系的卫星星系。', '肉眼可见，是肉眼能看到的最远天体之一。'],
    researchQuery: 'Triangulum M33',
  }),
  G('m32', 'M32', 'M32', 'elliptical', 10.674, 40.865, 2.490, {
    color: '#ffd9a8', diameterLy: 6500, group: '仙女座卫星',
    desc: '仙女座星系的致密椭圆卫星星系，可能是被剥离了外围恒星的螺旋星系核。',
    facts: ['中心黑洞质量约 250 万太阳质量。'],
    researchQuery: 'M32 galaxy',
  }),
  G('m110', 'M110', 'M110 (NGC 205)', 'elliptical', 10.092, 41.685, 2.690, {
    color: '#ffe0b8', diameterLy: 17000, group: '仙女座卫星',
    desc: '仙女座星系的第二个大卫星星系，属于矮椭圆星系。',
    facts: ['存在年轻的蓝色星团，说明近期仍有恒星形成。'],
    researchQuery: 'NGC 205 M110',
  }),
  G('ngc6822', '巴纳德星系', "Barnard's Galaxy (NGC 6822)", 'irregular', 296.24, -14.803, 1.630, {
    color: '#a8c8ff', diameterLy: 7000, group: '本星系群',
    desc: '本星系群中的不规则矮星系，1925 年由哈勃首次测定距离，证明了河外星系的存在。',
    facts: ['含有大量 H II 区与年轻星团。'],
    researchQuery: 'NGC 6822 Barnard galaxy',
  }),
  G('ic1613', 'IC 1613', 'IC 1613', 'irregular', 16.22, 2.13, 2.380, {
    color: '#b0d0ff', diameterLy: 10000, group: '本星系群',
    desc: '本星系群中金属含量最低的矮不规则星系之一，是测量宇宙距离的重要标尺。',
    facts: ['几乎没有尘埃，是研究造父变星的理想实验室。'],
    researchQuery: 'IC 1613 dwarf galaxy',
  }),
  G('wlm', '沃尔夫-伦德马克-梅洛特星系', 'WLM', 'irregular', 0.49, -15.46, 3.040, {
    color: '#a8c0ff', diameterLy: 8000, group: '本星系群',
    desc: '位于本星系群边缘的孤立矮星系，距离约 300 万光年。',
    facts: ['可能从未与其它星系发生引力相互作用。'],
    researchQuery: 'WLM galaxy isolated dwarf',
  }),
  G('ic10', 'IC 10', 'IC 10', 'irregular', 5.07, 59.30, 2.200, {
    color: '#ffb8a8', diameterLy: 5000, group: '本星系群',
    desc: '本星系群中唯一的星暴星系，正在剧烈地形成新恒星。',
    facts: ['含有大量沃尔夫-拉叶星与一个隐藏的活跃黑洞。'],
    researchQuery: 'IC 10 starburst',
  }),
  G('sagittarius-dwarf', '人马座矮椭圆星系', 'Sagittarius Dwarf', 'dwarfgalaxy', 283.75, -30.50, 0.078, {
    color: '#ffe0a0', diameterLy: 10000, group: '银河系卫星',
    desc: '距离最近的银河系卫星星系，正在被潮汐力撕碎，其恒星已环绕银河系形成一条长长的星流。',
    facts: ['1994 年才被发现，位于银盘之后。'],
    researchQuery: 'Sagittarius dwarf tidal stream',
  }),
  G('sculptor-dwarf', '玉夫座矮星系', 'Sculptor Dwarf', 'dwarfgalaxy', 15.04, -33.71, 0.290, {
    color: '#ffe8b0', diameterLy: 5000, group: '银河系卫星',
    desc: '银河系的一个矮椭球星系，几乎不含气体，恒星形成早已停止。',
    facts: ['是研究暗物质分布的经典目标。'],
    researchQuery: 'Sculptor dwarf spheroidal dark matter',
  }),
  G('fornax-dwarf', '天炉座矮星系', 'Fornax Dwarf', 'dwarfgalaxy', 39.997, -34.45, 0.460, {
    color: '#ffe8b0', diameterLy: 6000, group: '银河系卫星',
    desc: '含有多个球状星团的银河系卫星星系。',
    facts: ['拥有 6 个球状星团，这在矮星系中很罕见。'],
    researchQuery: 'Fornax dwarf globular clusters',
  }),
  G('draco-dwarf', '天龙座矮星系', 'Draco Dwarf', 'dwarfgalaxy', 260.05, 57.92, 0.260, {
    color: '#ffe8b0', diameterLy: 3000, group: '银河系卫星', hidden: true,
    desc: '极暗的矮椭球星系，恒星数量少而古老。',
    facts: ['质光比极高，是暗物质主导的典型天体。'],
    researchQuery: 'Draco dwarf spheroidal',
  }),
  G('leo1', '狮子座 I', 'Leo I', 'dwarfgalaxy', 152.11, 12.31, 0.820, {
    color: '#ffe8b0', diameterLy: 4000, group: '银河系卫星', hidden: true,
    desc: '银河系卫星星系中最远的一个，可能正在被剥离。',
    facts: ['距银河系约 82 万光年。'],
    researchQuery: 'Leo I dwarf galaxy',
  }),
  G('ngc3109', 'NGC 3109', 'NGC 3109', 'irregular', 150.78, -26.16, 4.300, {
    color: '#a8c8ff', diameterLy: 25000, group: '本星系群边缘', hidden: true,
    desc: '本星系群边缘的大型矮不规则星系，可能是本星系群与室女座星系团之间的过渡天体。',
    facts: ['距离约 430 万光年。'],
    researchQuery: 'NGC 3109',
  }),
  G('sextans-a', '六分仪座 A', 'Sextans A', 'irregular', 152.77, -4.69, 4.400, {
    color: '#a8c8ff', diameterLy: 5000, group: '本星系群边缘', hidden: true,
    desc: '一个正在形成恒星的矮不规则星系。',
    facts: ['形状呈方形，是研究低金属环境下恒星形成的样本。'],
    researchQuery: 'Sextans A dwarf galaxy',
  }),
  G('phoenix-dwarf', '凤凰座矮星系', 'Phoenix Dwarf', 'dwarfgalaxy', 27.78, -44.45, 1.440, {
    color: '#ffe8b0', diameterLy: 2400, group: '本星系群边缘', hidden: true,
    desc: '过渡型矮星系，兼具矮椭球与矮不规则星系特征。',
    facts: ['2016 年观测到其中心有恒星形成活动。'],
    researchQuery: 'Phoenix dwarf galaxy',
  }),
  G('tucana-dwarf', '杜鹃座矮星系', 'Tucana Dwarf', 'dwarfgalaxy', 340.45, -64.41, 2.870, {
    color: '#ffe8b0', diameterLy: 2000, group: '本星系群边缘', hidden: true,
    desc: '孤立的矮椭球星系，恒星极为古老。',
    facts: ['可能是本星系群中最早形成的星系之一。'],
    researchQuery: 'Tucana dwarf galaxy',
  }),
];

/**
 * 超星系团尺度与宇宙大尺度结构（单位：百万光年）
 *
 * `anchor` 是**结构自己声明**的一份豁免，只有两个取值，各对应一种「在这里落点是对的」：
 *   'home'    我们所在的位置。它**必须**在世界原点 —— 因为这几层是「以我们为球心」建的，
 *             本星系群/银河系在原点不是缺数据，是定义。
 *   'context' 高一层里作为**上下文**出现的点标记。位置是真实的，只是它属于更低的层
 *             （例：在「可观测宇宙」层标出巨引源，那里正是本星系群运动的引力中心）。
 * 为什么要有这个字段：判据「这一层画了别的层的东西」如果不认这份声明，
 * 就会把**正确的**行为报成故障 —— 而一条具体的、看起来很专业的错误结论，
 * 比报不出故障更坏（会把人派去修不存在的问题）。豁免写在数据里，不写在检查脚本的名单里：
 * 名单会腐烂，而这个字段跟着对象走。
 */
export const COSMIC = [
  {
    id: 'local-group', name: '本星系群', en: 'Local Group', type: 'group',
    distMly: 0, radiusMly: 5, color: '#9ec5ff', anchor: 'home',
    desc: '银河系、仙女座星系与约 80 个矮星系组成的引力束缚系统，直径约 1000 万光年。',
    facts: ['主要成员是银河系与仙女座星系两个大螺旋星系。', '整个本星系群正以约 300 km/s 向室女座星系团方向运动。'],
    researchQuery: 'Local Group galaxies dynamics',
  },
  {
    id: 'virgo-cluster', name: '室女座星系团', en: 'Virgo Cluster', type: 'cluster',
    distMly: 53.8, radiusMly: 7.2, color: '#ffd9a8', ra: 186.75, dec: 12.72, anchor: 'context',
    desc: '离我们最近的富星系团，包含约 1300–2000 个星系，是本超星系团的核心。中心是巨型椭圆星系 M87。',
    facts: ['M87* 是首张被拍摄到照片的黑洞（2019 年 EHT）。', '它的引力主导了本星系群的宏观运动。'],
    researchQuery: 'Virgo Cluster M87 black hole',
  },
  {
    id: 'great-attractor', name: '巨引源', en: 'Great Attractor', type: 'attractor',
    distMly: 250, radiusMly: 100, color: '#ff9ec5', ra: 243.75, dec: -60.9, anchor: 'context',
    desc: '位于矩尺座星系团方向的巨大引力异常区，正把本星系群及周边数百万个星系拉向它。它被银河系盘面遮挡，被称为「隐匿带」之后的结构。',
    facts: ['中心是矩尺座星系团（Abell 3627）。', '本星系群相对它的运动速度约 600 km/s。'],
    researchQuery: 'Great Attractor Norma cluster',
  },
  {
    id: 'laniakea', name: '拉尼亚凯亚超星系团', en: 'Laniakea Supercluster', type: 'supercluster',
    /* ⚠️ 坐标是**必须**的。原来这里没有 ra/dec：`supercluster.js` / `cosmos.js` 的落点
     *    判断要 ra/dec + distMly 三者齐全，缺 ra/dec 时 `p` 留在 (0,0,0) ——
     *    于是一个 2.5 亿光年外的超星系团被画在**世界原点**上，
     *    和当初「太阳变成一个大方框」是同一个病：缺坐标与 NaN 在渲染上都表现为堆在原点。
     *
     * 取值口径：本结构的定义就是「以巨引源为中心的速度流域」（Tully et al. 2014），
     * 所以中心取巨引源/矩尺座星系团的位置（16h15m = 243.75°, −60.9°），
     * 与上面 `great-attractor` 同一处 —— 两个环同心，正好是「巨引源在拉尼亚凯亚之内」。
     * ⚠️ 另有一处口径冲突，**没有藏起来**：维基百科 Laniakea 条目信息框给的是
     *    RA 10h32m / Dec −46°00′。两边都标着「(Great Attractor)」却相差很大，
     *    无法从公开资料内判定谁对，故按**定义**取矩尺座方向，并把冲突写进 facts。 */
    distMly: 250, radiusMly: 260, color: '#a78bfa', ra: 243.75, dec: -60.9, anchor: 'context',
    desc: '包含约 10 万个星系、跨度 5.2 亿光年的超星系团，本星系群与室女座星系团都属于它。「Laniakea」在夏威夷语中意为「无尽的天堂」。',
    facts: [
      '2014 年由 Tully 团队通过星系速度流场划分定义。',
      '总质量约 1e17 太阳质量。',
      '中心取巨引源方向；公开资料对中心位置有两套说法（另说 RA 10h32m / Dec −46°），尚未统一。',
    ],
    researchQuery: 'Laniakea supercluster velocity flow',
  },
  {
    id: 'perseus-pisces', name: '英仙-双鱼超星系团', en: 'Perseus-Pisces Supercluster', type: 'supercluster',
    distMly: 250, radiusMly: 130, color: '#8fd3e8', ra: 49.95, dec: 41.51, anchor: 'context',
    desc: '天空中最大的结构之一，与拉尼亚凯亚之间隔着本星系群的「排斥区」。',
    facts: ['包含英仙座星系团（Abell 426）。'],
    researchQuery: 'Perseus-Pisces supercluster',
  },
  {
    id: 'coma-cluster', name: '后发座星系团', en: 'Coma Cluster', type: 'cluster',
    distMly: 321, radiusMly: 10, color: '#ffd9a8', ra: 194.95, dec: 27.98, anchor: 'context',
    desc: '后发座超星系团的核心，包含 1000 多个星系，是研究暗物质与星系团动力学的重要目标。',
    facts: ['1933 年兹威基通过其星系速度首次推断出暗物质的存在。'],
    researchQuery: 'Coma Cluster dark matter',
  },
  {
    id: 'shapley', name: '夏普力超星系团', en: 'Shapley Supercluster', type: 'supercluster',
    distMly: 650, radiusMly: 100, color: '#c4b5fd', ra: 196, dec: -31, anchor: 'context',
    desc: '本星系群所在区域附近最大的质量集中区，包含 8000 多个星系。',
    facts: ['它的引力影响着包括拉尼亚凯亚在内的周边结构。'],
    researchQuery: 'Shapley supercluster',
  },
  {
    id: 'hercules-wall', name: '武仙-北冕座长城', en: 'Hercules-Corona Borealis Great Wall', type: 'filament',
    /* ⚠️ 距两处修正，都是「原来那个数不是这个意思」：
     *  1. 缺 ra/dec → 同样被画在世界原点（10 亿光年外的东西落在我们头上）。
     *     坐标取 Horváth et al.（2014 发现论文）给出的位置：RA 263.9°, Dec +35.4°
     *     —— 与维基信息框的 17h00m/+27°45′ 大致同一天区（武仙-北冕座一带）。
     *  2. `distMly: 10000` 是**光行距**（9.612–10.538 Gly），而本项目这几层用的是
     *     **共动距离**（本层的宇宙微波背景就写在 45.2 Gly，正是共动半径）。
     *     两者在这条红移（z≈1.85）上差了一半还多 —— 混用会让相对位置凭空错一位。
     *     共动距离 15.049–17.675 Gly，取中值 16.4。 */
    distMly: 16400, radiusMly: 5000, color: '#67e8f9', ra: 263.9, dec: 35.4,
    desc: '已知宇宙中最大的结构之一，由伽马射线暴分布推断出的星系长城，跨度约 100 亿光年。',
    facts: [
      '2013 年通过伽马射线暴的聚集发现（红移 1.6–2.1）。',
      '其尺度对宇宙学原理提出了挑战。',
      '距离用的是共动距离（约 164 亿光年）；光行距只有约 100 亿光年，两者不是一回事。',
    ],
    researchQuery: 'Hercules Corona Borealis Great Wall',
  },
  {
    id: 'cmb', name: '宇宙微波背景', en: 'Cosmic Microwave Background', type: 'cmb',
    distMly: 45200, radiusMly: 45200, color: '#ffcf5c',
    desc: '大爆炸后约 38 万年留下的辐射，是宇宙最古老的光，温度 2.725 K。它的微小温度涨落是今日所有结构的种子。',
    facts: ['普朗克卫星测得其温度各向异性为十万分之一量级。', '可观测宇宙的共动半径约 465 亿光年。'],
    researchQuery: 'cosmic microwave background Planck',
  },
];

/** 银河系结构 */
export const MILKYWAY = {
  id: 'milkyway',
  name: '银河系', en: 'Milky Way',
  diameterLy: 105700, thicknessLy: 1000, sunDistanceLy: 26700,
  barLengthLy: 25000, arms: 4,
  blackHole: { name: '人马座 A*', en: 'Sagittarius A*', mass: '4.3 百万太阳质量', distanceLy: 26700, researchQuery: 'Sagittarius A* black hole Event Horizon Telescope' },
  features: [
    { id: 'sgr-a', name: '银心 · 人马座 A*', en: 'Galactic Center', type: 'core', pos: [0, 0, 0], color: '#ffcf5c', desc: '银河系中心，超大质量黑洞 Sgr A* 所在。2022 年事件视界望远镜公布了它的首张照片。', facts: ['周围恒星以每秒数千公里速度绕行，是黑洞存在的直接证据。'], researchQuery: 'Sagittarius A* black hole' },
    { id: 'orion-arm', name: '猎户臂（猎户-天鹅臂）', en: 'Orion Arm', type: 'arm', pos: [0, 0, 26700], color: '#9ec5ff', desc: '太阳所在的次级旋臂，位于人马臂与英仙臂之间，长约 1 万光年。', facts: ['太阳系位于这条旋臂的内缘。'], researchQuery: 'Orion arm local spur' },
    { id: 'perseus-arm', name: '英仙臂', en: 'Perseus Arm', type: 'arm', pos: [-8000, 0, 34000], color: '#c4b5fd', desc: '银河系两条主要旋臂之一，位于太阳轨道外侧。', facts: ['包含大量年轻星团与 H II 区。'], researchQuery: 'Perseus arm Milky Way' },
    { id: 'sagittarius-arm', name: '人马臂', en: 'Sagittarius Arm', type: 'arm', pos: [6000, 0, 14000], color: '#8fd3e8', desc: '位于太阳轨道内侧的主要旋臂之一。', facts: ['包含礁湖星云、鹰状星云等著名天体。'], researchQuery: 'Sagittarius arm Milky Way' },
    { id: 'scutum-arm', name: '盾牌-半人马臂', en: 'Scutum-Centaurus Arm', type: 'arm', pos: [4000, 0, 8000], color: '#ffb8a8', desc: '银河系两条主要旋臂之一，从棒结构两端延伸。', facts: ['恒星密度最高的旋臂之一。'], researchQuery: 'Scutum-Centaurus arm' },
    { id: 'norma-arm', name: '矩尺臂', en: 'Norma Arm', type: 'arm', pos: [1500, 0, 4000], color: '#ff9ec5', desc: '紧贴银棒的最内侧旋臂。', facts: ['与银棒相连，结构仍在研究中。'], researchQuery: 'Norma arm Milky Way' },
    { id: 'outer-arm', name: '外缘臂', en: 'Outer Arm', type: 'arm', pos: [-12000, 0, 45000], color: '#7dd3fc', desc: '银河系最外侧的旋臂，结构相对松散。', facts: ['主要由中性氢观测勾勒。'], researchQuery: 'outer arm Milky Way' },
    { id: 'halo', name: '银晕与球状星团', en: 'Galactic Halo', type: 'halo', pos: [0, 0, 0], color: '#64789a', desc: '包裹银盘的球形区域，包含约 150 个球状星团与大量老年恒星，以及暗物质晕。', facts: ['最古老的球状星团年龄超过 130 亿年。'], researchQuery: 'galactic halo globular clusters Gaia' },
    { id: 'magellanic-stream', name: '麦哲伦流', en: 'Magellanic Stream', type: 'stream', pos: [0, 0, 100000], color: '#67e8f9', desc: '从麦哲伦云延伸出的气体流，环绕银河系超过 20 万光年。', facts: ['是银河系正在吞噬卫星星系的直接证据。'], researchQuery: 'Magellanic Stream' },
  ],
};

/** 邻近恒星专名与资料（键名与 HYG 星表 name 字段一致） */
export const STAR_INFO = {
  'Proxima Centauri': { zh: '比邻星', desc: '距离太阳最近的恒星（4.24 光年），是一颗红矮星，也是半人马座 α 三合星系统的第三颗成员。它拥有至少 3 颗行星。', facts: ['比邻星 b 位于宜居带内，质量约 1.1 地球质量。', '是一颗耀星，会爆发强烈耀斑，对行星大气不利。'], researchQuery: 'Proxima Centauri b flare habitability' },
  'Rigil Kentaurus': { zh: '南门二（半人马座 α A）', desc: '半人马座 α 系统的主星，G2V 型恒星，与太阳非常相似。', facts: ['与比邻星共同组成距离太阳最近的恒星系统。'], researchQuery: 'Alpha Centauri A' },
  'Toliman': { zh: '半人马座 α B', desc: '半人马座 α 系统的 K1V 型成员。', facts: ['与 A 星以 79.9 年为周期互绕。'], researchQuery: 'Alpha Centauri B' },
  "Barnard's Star": { zh: '巴纳德星', desc: '第二近的恒星系统（5.96 光年），是一颗高速运动的红矮星。', facts: ['2024–2025 年确认至少 4 颗亚地球质量行星。', '约 1 万年后将成为距太阳最近的恒星。'], researchQuery: "Barnard's Star planets" },
  'Wolf 359': { zh: '沃夫 359', desc: '一颗极暗的红矮星，距离 7.86 光年。', facts: ['是《星际迷航》中著名战役的命名来源。'], researchQuery: 'Wolf 359 red dwarf' },
  'Lalande 21185': { zh: '拉朗德 21185', desc: '距离 8.31 光年的红矮星，拥有至少 2 颗行星。', facts: ['是北天最亮的红矮星之一。'], researchQuery: 'Lalande 21185 planets' },
  'Sirius': { zh: '天狼星', desc: '夜空中最亮的恒星（8.60 光年），A1V 型，伴星是一颗白矮星。', facts: ['天狼星 B 是人类发现的第一颗白矮星。', '古埃及人用它的偕日升标记尼罗河泛滥。'], researchQuery: 'Sirius A B white dwarf' },
  'Epsilon Eridani': { zh: '天苑四', desc: '距离 10.5 光年的年轻 K2V 型恒星，拥有尘埃盘与至少 1 颗行星。', facts: ['年龄仅约 8 亿年，是研究行星系统演化的天然实验室。'], researchQuery: 'Epsilon Eridani debris disk planet' },
  'Procyon': { zh: '南河三', desc: '距离 11.46 光年的 F5IV-V 型恒星，伴星为白矮星。', facts: ['是冬季大三角的成员之一。'], researchQuery: 'Procyon white dwarf' },
  '61 Cygni': { zh: '天津增二十九（61 天鹅）', desc: '第一颗被测定距离的恒星（1838 年贝塞尔）。', facts: ['是一对 K 型双星，距离 11.4 光年。'], researchQuery: '61 Cygni' },
  'Epsilon Indi': { zh: '波斯星（印第安座 ε）', desc: '距离 11.87 光年的 K5V 恒星，拥有两颗棕矮星伴星。', facts: ['是研究棕矮星的经典系统。'], researchQuery: 'Epsilon Indi brown dwarfs' },
  'Tau Ceti': { zh: '天仓五', desc: '距离 11.9 光年的 G8V 恒星，拥有尘埃盘与至少 4 颗行星。', facts: ['是最早被搜寻地外文明的恒星之一。', '恒星活动相对平静，被视为宜居候选。'], researchQuery: 'Tau Ceti planets debris disk' },
  'Gliese 1061': { zh: '格利泽 1061', desc: '距离 12.0 光年的红矮星，拥有 3 颗行星。', facts: ['其中 GJ 1061 d 位于宜居带边缘。'], researchQuery: 'Gliese 1061 planets' },
  'YZ Ceti': { zh: '鲸鱼座 YZ', desc: '距离 12.1 光年的红矮星，拥有 3 颗短周期行星。', facts: ['行星轨道周期均在 2–5 天之间。'], researchQuery: 'YZ Ceti planets' },
  "Luyten's Star": { zh: '路易滕星', desc: '距离 12.36 光年的红矮星，拥有 4 颗行星。', facts: ['其中 GJ 273 b 位于宜居带内。'], researchQuery: "Luyten's Star planets" },
  "Teegarden's Star": { zh: '蒂加登星', desc: '距离 12.5 光年的极暗红矮星，2003 年才被发现。', facts: ['拥有 3 颗行星，其中两颗位于宜居带。'], researchQuery: "Teegarden's Star planets" },
  "Kapteyn's Star": { zh: '卡普坦星', desc: '距离 12.8 光年的高速晕星，是银河系厚盘或球状星团的残骸。', facts: ['拥有至少 2 颗行星。'], researchQuery: "Kapteyn's Star planets" },
  'Wolf 1061': { zh: '沃夫 1061', desc: '距离 13.8 光年的红矮星，拥有 3 颗行星。', facts: ['Wolf 1061 c 位于宜居带边缘。'], researchQuery: 'Wolf 1061 planets' },
  'Gliese 687': { zh: '格利泽 687', desc: '距离 14.8 光年的红矮星，拥有 2 颗行星。', facts: ['是研究红矮星行星系统的常用目标。'], researchQuery: 'Gliese 687 planets' },
  'Vega': { zh: '织女星', desc: '距离 25 光年的 A0V 型恒星，曾是天文测光的标准零点。', facts: ['拥有尘埃盘，是第一颗被拍到尘埃盘的恒星。', '约 1.2 万年后将成为北极星。'], researchQuery: 'Vega debris disk' },
  'Altair': { zh: '河鼓二（牛郎星）', desc: '距离 16.7 光年的 A7V 型恒星，自转极快导致明显扁球形状。', facts: ['与织女星、天津四组成夏季大三角。'], researchQuery: 'Altair rapid rotation' },
  'Fomalhaut': { zh: '北落师门', desc: '距离 25 光年的 A3V 型恒星，拥有著名的尘埃环。', facts: ['尘埃环曾被误认为是行星「北落师门 b」，2023 年确认为碰撞碎屑云。'], researchQuery: 'Fomalhaut debris disk JWST' },
  'TRAPPIST-1': { zh: 'TRAPPIST-1', desc: '距离 40.7 光年的超冷红矮星，拥有 7 颗类地行星，其中 3–4 颗位于宜居带。', facts: ['是研究行星大气的最佳目标之一。', '韦布望远镜已系统观测其行星大气：2025 年 MIRI 数据显示 TRAPPIST-1 b 几乎不存在实质大气，b、c 的厚氢大气已被排除。'], researchQuery: 'TRAPPIST-1 planets atmosphere JWST' },
  '51 Pegasi': { zh: '飞马座 51', desc: '距离 50.9 光年，1995 年发现第一颗围绕类太阳恒星的系外行星。', facts: ['该发现获得 2019 年诺贝尔物理学奖。'], researchQuery: '51 Pegasi b exoplanet' },
  'HD 209458': { zh: 'HD 209458', desc: '距离 157 光年，其行星 HD 209458 b（奥西里斯）是第一颗被观测到凌星与大气蒸发的系外行星。', facts: ['开创了系外行星大气研究领域。'], researchQuery: 'HD 209458 b atmosphere' },
};

/**
 * 特殊天体（超出 120 光年星表，但值得单独列出）
 *
 * ⚠️ 这三条原来**只有 `distLy`、没有 `ra/dec`** —— 于是 `placeOfLy()` 拿不到位置，
 *    它们在 3D 里**从来没被画出来过**（旧代码靠 `new THREE.Vector3(undefined,…)`
 *    得到 NaN 向量，同样看不见，只是没人发现）。坐标位置是确定的，缺的只是把它写下来。
 *    ra/dec 取自 SIMBAD 的 ICRS 坐标（Betelgeuse / Sirius / Cygnus X-1）。
 *
 * ⚠️ `level` **逐条给**，不是统一给 `neighborhood`：
 *    「邻近恒星系」层 1 单位 = 1 光年、相机远平面 4000，
 *    而天鹅座 X-1 在 6,070 光年外 —— 挂在邻近层只会被远平面裁掉，
 *    它真正的归属是银河系层。**尺度归属要按距离判，不能按「它是不是恒星」判。**
 *
 * 质量只写**测出来的**：
 *    · 天狼星 B 的质量来自双星轨道动力学解算（1.018 M☉ 量级）；
 *    · 天鹅座 X-1 的黑洞质量来自射电视差 + 轨道解算。
 *    参宿四的质量至今没有一致的测定值（不同模型给 11–21 M☉），
 *    所以**不写进 `massSolar`**，只在 facts 里说明区间与出处 ——
 *    把有争议的值塞进数值字段，就等于把它伪装成实测。
 */
export const NOTABLE_FAR_STARS = [
  {
    id: 'betelgeuse', name: '参宿四', en: 'Betelgeuse', type: 'star',
    ra: 88.79294, dec: 7.40706, distLy: 548, level: 'neighborhood',
    color: '#ff7a4d',
    desc: '猎户座肩部的红超巨星，半径约为太阳的 640 倍，已进入生命末期，将在未来十万年内超新星爆发。',
    facts: [
      '2019–2020 年的「大暗淡」由尘埃抛射造成。',
      '2023 年观测显示其自转周期可能实为脉动。',
      '质量没有公认值：不同演化模型给出约 11–21 太阳质量，因此本条目不给数值质量。',
    ],
    researchQuery: 'Betelgeuse dimming supernova',
  },
  {
    id: 'sirius-b', name: '天狼星 B', en: 'Sirius B', type: 'star',
    ra: 101.2875, dec: -16.716, distLy: 8.6, level: 'neighborhood',
    color: '#dce8ff',
    massSolar: 1.018,
    desc: '人类发现的第一颗白矮星，质量与太阳相当却只有地球大小。',
    facts: ['表面重力约为地球的 40 万倍。', '质量 1.018 太阳质量，由双星轨道动力学解算得到（不是估算）。'],
    researchQuery: 'Sirius B white dwarf',
  },
  {
    id: 'cygnus-x1', name: '天鹅座 X-1', en: 'Cygnus X-1', type: 'star',
    ra: 299.5903, dec: 35.20161, distLy: 6070, level: 'galaxy',
    color: '#a78bfa',
    massSolar: 21.2,
    desc: '第一个被广泛承认的黑洞候选者，由蓝超巨星与黑洞组成的双星系统。',
    facts: ['霍金与索恩曾为此打赌。', '黑洞质量约 21.2 太阳质量，由射电视差与轨道解算得到。'],
    researchQuery: 'Cygnus X-1 black hole',
  },
];

export const DEEP_SKY = { GALAXIES, COSMIC, MILKYWAY, STAR_INFO, NOTABLE_FAR_STARS };

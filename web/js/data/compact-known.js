/**
 * 著名致密天体与特殊天体（人工整理）
 *
 * ── 为什么需要这张表 ────────────────────────────────────────
 * 自动抓取（SIMBAD）解决的是「邻近完备」：谁离太阳近，谁进表。
 * 但它解决不了「知名代表」——这是 2026-09-11 实测出来的：
 *
 *   蟹状星云脉冲星 PSR B0531+21 —— SIMBAD 里没挂专名，且距离 6500 光年
 *   船帆座脉冲星 PSR B0833-45  —— 同样没专名，距离 950 光年
 *   Geminga PSR B0633+17        —— 同样没专名
 *
 *   按 `ORDER BY plx_value DESC`（视差最大 = 最近）排序时，这三颗
 *   **永远排不进前列**，在 3981 颗脉冲星里被静默丢掉。
 *   然而它们恰恰是用户唯一叫得出名字的那几颗。
 *
 * 教训一：**排序规则会悄悄决定数据内容**。筛选条件看着合理，
 * 实际把最该被看见的天体全滤掉了 —— 而且过程完全静默、不报任何错。
 * 因此自动表之外必须有一张人工表兜底，且人工表优先级更高。
 *
 * ⚠️ 教训二：上面那三个 SIMBAD 编号其实是**错的**（2026-09-11 二次踩坑）。
 * 本表初稿里的 simbadId 一半凭印象写，核对后发现全不对：
 *   蟹状星云脉冲星：以为 `PSR B0531+21`，实为 `V* CM Tau`（变星命名！）
 *   船帆座脉冲星：  以为 `PSR B0833-45`，实为 `NAME Vela Pulsar`
 *   Geminga：      以为 `PSR B0633+17`，实为 `PSR J0633+1746`（J2000 坐标命名）
 *   PSR J0437-4715：以为 `PSR J0437-4715`，实为 `PSR J0437-47`（后缀只两位）
 * 追根因：凭记忆写星表编号 = 凭记忆写数据库主键，**必须查出来再写**。
 * 兜底机制：fetch-compact.mjs 逐个核对白名单 ID，查不到的打 WARN 并列出 ——
 * 正是这条警告把这 5 个错误兜住，否则它们会静默消失而日志全绿。
 *
 * ── 收录标准 ────────────────────────────────────────────────
 * 只收「有专名 / 有观测实据 / 教科书级」的天体。每条必须给：
 *   · distLy    距离（光年）—— 必须来自独立测量，不得由本表推算
 *   · simbadId  SIMBAD 主键 —— **必须实际查过 SIMBAD 再写**，不得凭印象
 *   · src       出处（论文 / 官方页面）—— 「凭记忆写」不算出处
 * 拿不准的宁可先不收（放进 watchlist）。
 */

/* ============================================================
   常用名映射：SIMBAD 机器名 → 中文名
   ============================================================
   自动抓取的记录带 SIMBAD 的 en（机器名），这里补中文与专名。
   键必须与 SIMBAD 的 main_id 完全一致（大小写、空格都算）。
*/
export const COMPACT_ALIAS = {
  '* alf CMa B': { zh: '天狼星 B', note: '人类发现的第一颗白矮星' },
  'V* CM Tau': { zh: '蟹状星云脉冲星' },
  'NAME Vela Pulsar': { zh: '船帆座脉冲星' },
  'PSR J0633+1746': { zh: 'Geminga 脉冲星' },
  'PSR J0437-47': { zh: 'PSR J0437-4715' },
  'PSR B1919+21': { zh: 'PSR B1919+21' },
  'PSR J0030+0451': { zh: 'PSR J0030+0451' },
  '* alf CMi B': { zh: '南河三 B' },
  '* omi02 Eri B': { zh: '波江座 40 B' },
  'Wolf   28': { zh: '范玛宁星' },
};

/**
 * 重叠修正：有些著名天体在 SIMBAD 里是「复合对象」，
 * 主记录挂在双星系统上而非致密天体本身。
 * 这张表用来把自动抓取的记录指向正确的展示名。
 */
export const COMPACT_OVERRIDE = {
  '* alf CMa B': { properName: '天狼星 B', distLy: 8.6 },
};

/* ============================================================
   著名黑洞
   ============================================================
   SIMBAD 的 BH 分类只收动力学确认者（全表 3 条），远远不够。
   这里的名单来自各天体被确认的里程碑观测。
*/
export const NOTABLE_BLACK_HOLES = [
  {
    id: 'sgr-a-star', name: '人马座 A*', en: 'Sagittarius A*', type: 'blackhole',
    distLy: 26996, massSolar: 4300000, ra: 266.41683, dec: -29.00781,
    kind: '超大质量黑洞', activity: '低辐射（偶发耀发）',
    desc: '银河系中心的超大质量黑洞，质量约 430 万倍太阳。2022 年事件视界望远镜（EHT）公布首张影像，2025 年 EHT 公布其偏振光图像。',
    facts: [
      '绕它运行的恒星 S2 轨道周期仅 16 年，近日点速度达光速的 2.5%，是引力红移的直接证据。',
      '2020 年诺贝尔物理学奖表彰了对其中心致密天体的观测。',
      '2022 年 EHT 首张图像显示一个直径约 50 微角秒的环状阴影。',
    ],
    src: 'GRAVITY Collaboration 2022, A&A；EHT Collaboration 2022, ApJL 930, L12',
    researchQuery: 'Sagittarius A* event horizon telescope',
  },
  {
    id: 'm87-star', name: 'M87*', en: 'Messier 87*', type: 'blackhole',
    distLy: 53500000, massSolar: 6500000000, ra: 187.70593, dec: 12.39112,
    kind: '超大质量黑洞', activity: '强射电喷流',
    desc: '室女座星系团中心星系 M87 的超大质量黑洞。2019 年 EHT 公布人类历史上第一张黑洞照片。',
    facts: [
      '首张黑洞影像于 2019 年 4 月 10 日公布，阴影直径约 42 微角秒。',
      '2021 年 EHT 进一步测量其偏振结构，确认磁场在喷流形成中的作用。',
      '喷流长达约 5000 光年，是第一个被拍摄到的河外喷流（1918 年 Heber Curtis）。',
    ],
    src: 'EHT Collaboration 2019, ApJL 875, L1；EHT Collaboration 2021, ApJL 910, L12',
    researchQuery: 'M87 black hole event horizon telescope',
  },
  {
    id: 'cygnus-x-1-bh', name: '天鹅座 X-1', en: 'Cygnus X-1', type: 'blackhole',
    distLy: 6070, massSolar: 21, ra: 299.59033, dec: 35.20162,
    kind: '恒星级黑洞', activity: 'X 射线双星',
    desc: '第一个被广泛接受的黑洞候选者，由蓝超巨星 HDE 226868 与黑洞组成的 X 射线双星。',
    facts: [
      '霍金与索恩 1974 年为它是否是黑洞打赌，霍金 1990 年认输。',
      '1964 年火箭观测发现其 X 射线，1965 年成为首批恒星级黑洞候选。',
      '黑洞质量约 21 倍太阳，自转接近极限（2021 年测量）。',
    ],
    src: 'Miller-Jones et al. 2021, Science 371, 1046；Bolton 1972, Nature 235, 271',
    researchQuery: 'Cygnus X-1 black hole mass',
  },
  {
    id: 'v616-monocerotis', name: '麒麟座 V616', en: 'V616 Monocerotis', type: 'blackhole',
    distLy: 3380, massSolar: 6.6, ra: 100.40958, dec: -6.63583,
    kind: '恒星级黑洞', activity: 'X 射线双星（A0620-00）',
    desc: '编号 A0620-00，是已知离太阳最近的恒星级黑洞候选之一，1975 年爆发成为当时最亮的 X 射线源。',
    facts: ['黑洞质量约 6.6 倍太阳，伴星为 K 型矮星。'],
    src: 'Cantrell et al. 2010, ApJ 710, 1127',
    researchQuery: 'A0620-00 black hole',
  },
  {
    id: 'sco-x-1', name: '天蝎座 X-1', en: 'Scorpius X-1', type: 'blackhole',
    distLy: 9080, massSolar: 2.2, ra: 244.97950, dec: -15.64022,
    kind: '中子星（非黑洞）', activity: 'X 射线双星',
    caveat: '常被误列为黑洞，实为**中子星**吸积双星 —— 收录于此是为了纠正这一常见错误。',
    desc: '第一个被发现的宇宙 X 射线源（1962 年），实为中子星吸积双星，不是黑洞。',
    facts: ['1962 年 Giacconi 团队的火箭观测开启了 X 射线天文学，获 2002 年诺贝尔物理学奖。'],
    src: 'Giacconi et al. 1962, PRL 9, 439；Steeghs & Casares 2002, ApJ 568, 273',
    researchQuery: 'Scorpius X-1 neutron star',
  },
];

/* ============================================================
   著名中子星 / 脉冲星
   ============================================================ */
export const NOTABLE_PULSARS = [
  {
    id: 'crab-pulsar', name: '蟹状星云脉冲星', en: 'Crab Pulsar', simbadId: 'V* CM Tau',
    type: 'pulsar', distLy: 6520, ra: 83.63308, dec: 22.01450,
    periodS: 0.033392, kind: '射电/光学/X 射线脉冲星',
    desc: '1054 年超新星（SN 1054）留下的中子星，位于蟹状星云中心，几乎在全电磁波段脉冲。',
    facts: [
      '自转周期约 33.4 毫秒，每秒自转约 30 圈。',
      '1968 年发现，是历史上第一颗被确认的脉冲星之一，也是首个被观测到光学脉冲的脉冲星（1969 年）。',
      '它驱动着蟹状星云的全部辐射，脉冲星风云是研究等离子体物理的标杆。',
    ],
    src: 'Hester 2008, ARA&A 46, 127；Manchester et al. 2005 (ATNF)',
    researchQuery: 'Crab pulsar neutron star',
  },
  {
    id: 'vela-pulsar', name: '船帆座脉冲星', en: 'Vela Pulsar', simbadId: 'NAME Vela Pulsar',
    type: 'pulsar', distLy: 956, ra: 128.83610, dec: -45.17642,
    periodS: 0.0893, kind: '射电/X 射线/伽马射线脉冲星',
    desc: '船帆座超新星遗迹（约 1.1 万年前爆发）留下的中子星，是天空中最亮的射电脉冲星之一。',
    facts: [
      '自转周期约 89 毫秒，是研究脉冲星自转突变（glitch）的经典目标 —— 2016 年发生了一次大型突变。',
      '其脉冲星风云被 Chandra 与 HST 详细成像，可见喷流与环形结构。',
    ],
    src: 'Dodson et al. 2003, ApJ 596, 1137；Palfreyman et al. 2018, Nature 556, 219',
    researchQuery: 'Vela pulsar glitch',
  },
  {
    id: 'geminga', name: 'Geminga', en: 'Geminga', simbadId: 'PSR J0633+1746',
    type: 'pulsar', distLy: 815, ra: 98.47963, dec: 17.77025,
    periodS: 0.237, kind: '伽马射线脉冲星（射电弱）',
    desc: '「双子座中的伽马射线源」，是首颗被发现只辐射伽马射线、射电信号极弱的中子星，迫使天文学界重新认识脉冲星族群。',
    facts: [
      '名字来自米兰方言「gh’è minga」，意为「它不在那里」——因为长期找不到射电对应体。',
      '距离约 250 秒差距，是离太阳最近的中子星之一。',
      '周围有巨大的伽马射线晕，是宇宙线电子在星际介质中扩散的实验室。',
    ],
    src: 'Caraveo et al. 2003, Science 301, 1345；Abdo et al. 2009, ApJ 700, L127',
    researchQuery: 'Geminga pulsar gamma ray',
  },
  {
    id: 'psr-j0437', name: 'PSR J0437-4715', en: 'PSR J0437-4715', simbadId: 'PSR J0437-47',
    type: 'pulsar', distLy: 509, ra: 69.31654, dec: -47.25239,
    periodS: 0.005757, kind: '毫秒脉冲星',
    desc: '离太阳最近的毫秒脉冲星之一，自转周期仅 5.76 毫秒，是脉冲星计时阵列（PTA）探测引力波的关键成员。',
    facts: [
      '与天狼星 B 类似，是少数能以极高精度测量距离（视差）的脉冲星。',
      '被 NANOGrav 与 PPTA 用于纳赫兹引力波背景的搜寻 —— 2023 年该背景被确认存在。',
    ],
    src: 'Reardon et al. 2016, MNRAS 455, 1751；NANOGrav 2023, ApJL 951, L8',
    researchQuery: 'PSR J0437-4715 pulsar timing array',
  },
  {
    id: 'psr-b1919', name: 'PSR B1919+21', en: 'PSR B1919+21',
    type: 'pulsar', distLy: 2283, ra: 290.18333, dec: 21.88333, periodS: 1.337,
    simbadId: 'PSR B1919+21',
    desc: '人类发现的第一颗脉冲星（1967 年，Jocelyn Bell Burnell），最初被戏称为「小绿人」（LGM-1）。',
    facts: [
      '周期 1.337 秒，是长周期脉冲星。',
      '它的发现开启了中子星观测的天文学分支，1974 年诺贝尔物理学奖授予 Hewish（Bell Burnell 未获）。',
      '脉冲星图形被 Joy Division 用作 1979 年专辑《Unknown Pleasures》封面，成为流行文化符号。',
    ],
    src: 'Hewish et al. 1968, Nature 217, 709',
    researchQuery: 'PSR B1919+21 first pulsar discovery',
  },
  {
    id: 'psr-j0030', name: 'PSR J0030+0451', en: 'PSR J0030+0451',
    type: 'pulsar', distLy: 1058, ra: 7.61416, dec: 4.86389, periodS: 0.004865,
    simbadId: 'PSR J0030+0451',
    desc: '毫秒脉冲星。2019 年 NICER 探测器首次精确测绘出它的表面热斑分布，直接约束了中子星的半径与状态方程。',
    facts: [
      'NICER 测得半径约 13 公里、质量约 1.4 倍太阳。',
      '热斑分布出乎意料地不对称（三到四个斑），与传统「双极帽」模型不符，改写了中子星磁层理论。',
    ],
    src: 'Riley et al. 2019, ApJL 887, L21；Miller et al. 2019, ApJL 887, L24',
    researchQuery: 'PSR J0030+0451 NICER neutron star radius',
  },
];

/* ============================================================
   著名白矮星
   ============================================================ */
export const NOTABLE_WHITE_DWARFS = [
  {
    id: 'sirius-b-wd', name: '天狼星 B', en: 'Sirius B', simbadId: '* alf CMa B',
    type: 'whitedwarf', distLy: 8.6, ra: 101.28715, dec: -16.71612,
    massSolar: 1.018, radiusEarth: 0.92, kind: 'DA 型白矮星',
    desc: '人类发现的第一颗白矮星（1915 年），质量与太阳相当而体积仅地球大小，密度高达每立方厘米一吨量级。',
    facts: [
      '由 1844 年 Bessel 从主星自行摆动推断存在，1862 年 Clark 用望远镜首次看到。',
      '它与天狼星 A 组成双星，轨道周期约 50 年，是测定恒星质量最精确的系统之一。',
      '表面重力约为地球的 40 万倍，谱线因引力红移而显著偏移 —— 这是广义相对论的经典验证。',
    ],
    src: 'Barstow et al. 2005, MNRAS 362, 1134；Bond et al. 2017, ApJ 840, 70',
    researchQuery: 'Sirius B white dwarf mass radius',
  },
  {
    id: 'van-maanen-star', name: '范玛宁星', en: "Van Maanen's Star", simbadId: 'Wolf   28',
    type: 'whitedwarf', distLy: 14.07, ra: 12.28512, dec: 5.39394,
    kind: 'DZ 型白矮星',
    desc: '离太阳最近的孤立白矮星（不含双星伴星），1917 年由范玛宁发现，是继天狼星 B 之后第二颗被确认的白矮星。',
    facts: [
      '光谱中只有重元素（钙、铁），没有氢和氦 —— 这曾令 1920 年代的天文学界困惑多年。',
      '它的距离常在科幻作品中出现（如《星际迷航》）。',
    ],
    src: 'Gaia Collaboration 2021, A&A 649, A6（距离）；Van Maanen 1917, PASP 29, 258',
    researchQuery: "Van Maanen's Star white dwarf",
  },
  {
    id: 'procyon-b', name: '南河三 B', en: 'Procyon B', simbadId: '* alf CMi B',
    type: 'whitedwarf', distLy: 11.46, ra: 114.82550, dec: 5.22499,
    massSolar: 0.6, kind: 'DQZ 型白矮星',
    desc: '小犬座 α（南河三）的伴星，第二颗被发现的近距离白矮星，1896 年由 Schaeberle 观测到。',
    facts: ['与天狼星 B 一样由双星自行推断存在，是白矮星天文学的奠基对象之一。'],
    src: 'Provencal et al. 2002, ApJ 568, 324',
    researchQuery: 'Procyon B white dwarf',
  },
  {
    id: '40-eri-b', name: '波江座 40 B', en: '40 Eridani B', simbadId: '* omi02 Eri B',
    type: 'whitedwarf', distLy: 16.33, ra: 63.81799, dec: -7.65287,
    massSolar: 0.573, kind: 'DA4 型白矮星',
    desc: '波江座 40 三合星系统成员，是第三颗被发现的白矮星（1914 年），也是最早被测定质量的白矮星之一。',
    facts: ['在《星际迷航》中，瓦肯人的母星就设定在这个系统 —— 因为它在剧中被描述为「离地球约 16 光年」。'],
    src: 'Shipman et al. 1997, ApJ 488, L43',
    researchQuery: '40 Eridani B white dwarf',
  },
  {
    id: 'lp-40-365', name: 'LP 40-365', en: 'LP 40-365',
    // simbadId 暂缺：在 SIMBAD 的 main_id 与 WD* 分类里都没查到（2026-09-11）。
    // 按项目规矩「拿不准的不硬写」—— 宁可不进点名白名单，也不塞一个查不到的键。
    // 它仍可被前端按名字检索到（如果后续自动抓取命中）。放进 watchlist。
    type: 'whitedwarf', distLy: 1700, ra: 220.30417, dec: 37.31472,
    kind: '超高速白矮星（Ia 型超新星幸存者）',
    desc: '一颗以约 850 km/s 飞行的「超高速」白矮星碎片，2025 年由 HST 与 Chandra 确认它是部分爆发的 Ia 型超新星残骸。',
    facts: [
      '它是已知最极端的不完全超新星爆发幸存者，为「Ia 型超新星如何爆炸」这一悬案提供了直接样本。',
      '其大气成分异常：氢氦几乎不存在，只有铁、镍等重元素。',
    ],
    src: 'Vennes et al. 2017, Science 357, 680；Chandra 2025 观测公告',
    researchQuery: 'LP 40-365 white dwarf supernova survivor',
    watchlist: 'simbadId 未核实，暂不参与自动点名抓取',
  },
];

/* ============================================================
   汇总导出
   ============================================================ */
export const NOTABLE_COMPACT = [
  ...NOTABLE_BLACK_HOLES,
  ...NOTABLE_PULSARS,
  ...NOTABLE_WHITE_DWARFS,
];

/** 按 simbadId 索引，便于与自动抓取结果合并去重 */
export const NOTABLE_BY_SIMBAD = new Map(
  NOTABLE_COMPACT.filter((o) => o.simbadId).map((o) => [o.simbadId, o]),
);

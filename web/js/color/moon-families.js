/**
 * 不规则卫星的**动力学族**分类 + 族级颜色来源
 * ══════════════════════════════════════════════════════════════
 * 这个文件解决什么问题
 * ══════════════════════════════════════════════════════════════
 * 项目里 82 颗不规则卫星原来全挤在 3 个手写 hex 上
 * （`#6a5c54` × 30、`#6a6258` × 22、`#8a8a86` × 14）。
 * 真实的不规则卫星**不是同一个颜色** —— 它们按**动力学族**分化，
 * 同族成员颜色高度同质（说明来自同一个母体的碎裂），族与族之间差别明显。
 *
 * 用户选定的方案：「**按动力学族 + 颜色指数**」生成。
 *
 * ══════════════════════════════════════════════════════════════
 * 数据来源（一手，不要凭印象改）
 * ══════════════════════════════════════════════════════════════
 * 1. **Grav, Holman, Gladman & Aksnes 2003, Icarus 166, 33**
 *    "Photometric Survey of the Irregular Satellites" (astro-ph/0301016)
 *    —— BVRI 实测色指数。本文件里的每个色指数都来自它的 Table 2
 *    （已用 tools/_parse-grav 系列脚本从 PDF 原始数据解析，未经过二手转述）。
 *    关键结论：
 *      · 全部不规则卫星分两类：**grey**（近 C 型）与 **light red**（近 P/D 型）。
 *      · **多数动力学族颜色同质** → 单个同质母体碎裂。
 *      · 木星 prograde 28° 族：加权平均 B−V=0.66±0.02, V−R=0.36±0.01（grey, C 型）。
 *      · 木星 Carme 族：light red，D 型母体（可能来自 Hilda/特洛伊）。
 *      · 木星 149° 区（Pasiphae + Ananke）：**严重异质**，加权平均 B−V=0.75±0.04, V−R=0.41±0.08。
 *      · 木星 Ananke 本星：B−V=0.90±0.06, V−R=0.38±0.04 —— **灰/淡红边界**。
 *      · 木星 Pasiphae 本星：grey（B−V=0.74, V−R=0.38）。
 *      · 木星 Sinope：**红**，倾角 158.1° 与族不同 → 可能是独立捕获。
 *      · **Kalyke**：V−R=0.96±0.16，**明显比同族红**（近 Centaur/TNO），登记为例外。
 *      · 土星 34° 族：light red，B−V=0.91±0.05, V−R=0.48±0.01。
 *      · 土星 46° 族：light red，B−V=0.79±0.01, V−R=0.51±0.02。
 *      · 土星 **Phoebe 中性/灰**（B−V=0.63, V−R=0.35），而 S/2000 S1 **淡红** →
 *        Phoebe 区实为**两个**族。土星不规则整体比木星的**略红**。
 *      · 天王星：Caliban 与 Sycorax 都 light red，但动力学上**分为两群**
 *        （分别以 Caliban、Sycorax 为中心）。
 *      · 海王星 Nereid、Halimede：grey。
 * 2. **分类学反照率档**（同文引用的小行星分类）：
 *      C 3–8%、P 2–6%、D 2–5%、M 10–18%、A 13–35%、E 25–60%。
 *    → 这决定了族级谱的整体**亮度**（形状由色指数定，亮度由反照率定）。
 * 3. **族边界**（半长轴 / 倾角 / 偏心率）取自公开汇总，并与本项目
 *    `moons.js` 的 a/e/i **逐条核对过**（见 tools 里的核对输出）。
 *    ⚠️ 边界只作为**兜底**；本项目已有 a/e/i，族归属由**数据**判定，
 *       不靠我背下来的数字（坑 33 / 坑 39 同族：别拿记忆当权威）。
 */

/* ==============================================================
   1. 族定义
   ============================================================== */

/**
 * 每个族：
 *   albedo      —— 族级视觉几何反照率（取自分类学档的**中值**）
 *   albedoRange —— 该分类学档的**实测区间** [min, max]
 *                  C 3–8%、P 2–6%、D 2–5%（Grav 2003 引用的分类学值）
 *   className   —— C / P / D 等，仅作说明
 *   bv, vr      —— 实测 B−V / V−R（Grav 2003），用于推导谱**形状**
 *   src         —— 出处
 *   note        —— 口径说明
 *
 * ⚠️ `bv`/`vr` 是**色指数**，不是反射率。见 `indicesToSpectrum()`。
 *
 * ⚠️ 为什么同时要 albedo 和 albedoRange：
 *    反照率档是**区间**不是点。同族成员大小不同、表面成熟度不同，
 *    真实反照率在档内分布。只用中值会让同族 18 颗算出**同一个亮度**，
 *    在 8 位 sRGB 下进一步塌成同一个 hex —— 这是"看起来有数据、
 *    实际全一样"的静默退化。用区间做逐星微扰，才是物理上正确的做法。
 */
export const FAMILIES = Object.freeze({
  /* ---------- 木星 ---------- */
  jup_himalia: {
    zh: '希马利亚群', parent: 'jupiter', className: 'C', albedo: 0.055,
    bv: 0.66, vr: 0.36, colorClass: 'grey',
    src: 'Grav et al. 2003 Icarus 166,33 §5.1（加权平均 B−V=0.66±0.02, V−R=0.36±0.01）',
    note: 'prograde 28° 族，中性灰、近 C 型小行星。同族 8 颗颜色高度一致 → 同一母体碎裂。',
  },
  jup_carme: {
    zh: '卡尔墨群', parent: 'jupiter', className: 'D', albedo: 0.035,
    bv: 0.76, vr: 0.47, colorClass: 'light red',
    src: 'Grav et al. 2003 Table 2（Carme B−V=0.76±0.02, V−R=0.47±0.02）+ §5.3',
    note: '最紧密的动力学族。淡红、D 型母体（可能来自 Hilda 或木星特洛伊）。同族同色。',
  },
  jup_ananke: {
    zh: '阿南刻群', parent: 'jupiter', className: 'P', albedo: 0.040,
    bv: 0.77, vr: 0.42, colorClass: 'grey~light red',
    src: 'Grav et al. 2003 §5.2（Ananke 本星 B−V=0.90±0.06, V−R=0.38±0.04；成员 Harpalyke/Praxidike/Iocaste 为灰）',
    note: '⚠️ 本族**异质**。Ananke 本星落在灰/淡红**边界**，成员多为灰。取族均值偏向灰。',
  },
  jup_pasiphae: {
    zh: '帕西法厄群', parent: 'jupiter', className: 'P', albedo: 0.040,
    bv: 0.74, vr: 0.40, colorClass: 'grey',
    src: 'Grav et al. 2003 §5.2（Pasiphae 本星 B−V=0.74±0.01, V−R=0.38±0.01，grey；成员 Callirrhoe/Megaclite 淡红）',
    note: '⚠️ 本族**弥散且异质**，可能是多次碰撞的混合。Pasiphae 本星灰，部分成员淡红。',
  },
  jup_themisto: {
    zh: '忒弥斯托（未归类）', parent: 'jupiter', className: 'P', albedo: 0.040,
    bv: 0.83, vr: 0.46, colorClass: 'light red',
    src: 'Grav et al. 2003 Table 2（Themisto B−V=0.83±0.02, V−R=0.46±0.01）',
    note: '不属任何族（a=7.39 Mkm，夹在伽利略卫星与 Himalia 群之间）。实测偏淡红。',
  },
  jup_carpo: {
    zh: '卡尔波（未归类）', parent: 'jupiter', className: 'D', albedo: 0.035,
    bv: 0.78, vr: 0.45, colorClass: 'light red',
    src: '类比同倾角（>50°）prograde 群；无 Grav 2003 实测',
    note: '⚠️ **无实测色指数**。倾角 51.4° 的孤立 prograde 天体，按 D 型类比取淡红、置信度低。',
  },
  jup_sinope: {
    zh: '西诺珀（独立捕获）', parent: 'jupiter', className: 'D', albedo: 0.035,
    bv: 0.84, vr: 0.46, colorClass: 'red',
    src: 'Grav et al. 2003 Table 2（Sinope B−V=0.84±0.03, V−R=0.46±0.03）+ §5.2',
    note: '⚠️ 倾角 158.1° 与 Pasiphae 群不同 → **可能独立捕获**。原文称其 "very red"，单列。',
  },
  jup_kalyke: {
    zh: '卡吕刻（族内例外）', parent: 'jupiter', className: 'D', albedo: 0.035,
    bv: 0.72, vr: 0.96, colorClass: 'red (TNO-like)',
    src: 'Grav et al. 2003 Table 2（Kalyke V−R=0.96±0.16）+ §5.3',
    note: '⚠️ **全样本唯一**明显偏红的天体（V−R 0.96 vs 同族 0.47），接近 Centaur/TNO。'
        + '可能不是 Carme 母体碎片，而是撞击者残骸或独立捕获。**必须单独着色**。',
  },

  /* ---------- 土星 ---------- */
  sat_gallic: {
    zh: '高卢群', parent: 'saturn', className: 'D', albedo: 0.035,
    bv: 0.91, vr: 0.48, colorClass: 'light red',
    src: 'Grav et al. 2003 §5.4（34° 族加权平均 B−V=0.91±0.05, V−R=0.48±0.01）',
    note: 'prograde 34° 族，物理同质、淡红（D 型）。土星不规则整体比木星的略红。',
  },
  sat_inuit: {
    zh: '因纽特群', parent: 'saturn', className: 'D', albedo: 0.035,
    bv: 0.79, vr: 0.51, colorClass: 'light red',
    src: 'Grav et al. 2003 §5.4（46° 族加权平均 B−V=0.79±0.01, V−R=0.51±0.02）',
    note: 'prograde 46° 族，物理同质、淡红。',
  },
  sat_phoebe: {
    zh: '福柏群（中性）', parent: 'saturn', className: 'C', albedo: 0.060,
    bv: 0.63, vr: 0.35, colorClass: 'grey',
    src: 'Grav et al. 2003 Table 2（Phoebe B−V=0.63±0.01, V−R=0.35±0.01）+ §5.5',
    note: '⚠️ 174° 区实为**两个**族：以 Phoebe 为中心的**中性灰**群，与以 S/2000 S1 为中心的淡红群。'
        + 'Phoebe 本星灰，且有水冰证据。',
  },
  sat_norse: {
    zh: '北欧群', parent: 'saturn', className: 'P', albedo: 0.040,
    bv: 0.77, vr: 0.48, colorClass: 'light red~grey',
    src: 'Grav et al. 2003 §5.5（174° 区异质）+ 174° 淡红成员',
    note: '⚠️ 北欧群**极度弥散**（常被当作"剩下的都归这里"）。'
        + '174° 区两个族中，本族按淡红（S/2000 S1 型）处理。',
  },

  /* ---------- 天王星 ---------- */
  ura_caliban: {
    zh: '卡利班群', parent: 'uranus', className: 'P', albedo: 0.040,
    bv: 0.78, vr: 0.45, colorClass: 'light red',
    src: 'Grav et al. 2003 §5.6 + Maris et al. 2001 / Romon et al. 2001（Caliban 与 Sycorax 均淡红）',
    note: '以 Caliban 为中心的一群（含 Stephano）。两族颜色相近但动力学可分。',
  },
  ura_sycorax: {
    zh: '西科拉克斯群', parent: 'uranus', className: 'P', albedo: 0.040,
    bv: 0.79, vr: 0.46, colorClass: 'light red',
    src: 'Grav et al. 2003 §5.6（Prospero、Setebos 归入 Sycorax 群）',
    note: '⚠️ 原文指出 Prospero/Setebos 颜色**偏灰**（较小成员为灰），'
        + '但动力学上属 Sycorax 群。本表按族取淡红，另给小成员灰偏移。',
  },
  ura_margaret: {
    zh: '玛格丽特（未归类）', parent: 'uranus', className: 'P', albedo: 0.040,
    bv: 0.79, vr: 0.46, colorClass: 'light red',
    src: '无实测；倾角 56.6° prograde，唯一 prograde 天王星不规则卫星',
    note: '⚠️ **无实测色指数**，且是天王星唯一天然 prograde 不规则卫星，不属两族。'
        + '按浅红外推，置信度低。',
  },

  /* ---------- 海王星 ---------- */
  nep_halimede: {
    zh: '哈利墨得群', parent: 'neptune', className: 'C', albedo: 0.055,
    bv: 0.72, vr: 0.40, colorClass: 'grey',
    src: 'Grav et al. 2003 §（Nereid、Halimede 为 grey）+ 通用引用',
    note: '⚠️ Neptune 不规则卫星实测极少。Halimede 可能与 Nereid 同源（都灰）。',
  },
  nep_nereid: {
    zh: '涅瑞伊德', parent: 'neptune', className: 'C', albedo: 0.155,
    bv: 0.70, vr: 0.39, colorClass: 'grey',
    src: 'Grav et al. 2003（grey）+ Schaefer & Schaefer 2000 Icarus 146,541 + Thomas et al. 1991',
    note: '⚠️ Nereid 反照率明显**高于**其它不规则卫星（约 0.155，实测），且有水冰迹象。'
        + 'e=0.75 是太阳系卫星最偏心轨道之一，疑与 Triton 捕获有关。',
  },
  nep_sao: {
    zh: '萨俄群（prograde）', parent: 'neptune', className: 'P', albedo: 0.040,
    bv: 0.76, vr: 0.44, colorClass: 'light red',
    src: '无实测；与 Sao/Laomedeia 同倾角（~48°）prograde 群',
    note: '⚠️ **无实测色指数**。按同族类比取淡红。',
  },
  nep_psamathe: {
    zh: '普萨玛忒群（retrograde）', parent: 'neptune', className: 'P', albedo: 0.040,
    bv: 0.76, vr: 0.44, colorClass: 'light red',
    src: '无实测；与 Psamathe/Neso 同倾角（~127°）retrograde 群',
    note: '⚠️ **无实测色指数**。按同族类比取淡红。',
  },
});

/* ==============================================================
   2. 逐星 → 族 的映射
   ==============================================================
   ⚠️ 这份映射是**按项目自带 a/e/i 判定的结果**（见 tools 核对输出），
      不是照抄记忆里的名单。判定规则（优先级从上到下）：
        1. 个别天体有**明确文献结论**（Sinope 独立、Kalyke 例外、
           Phoebe 中性、Prospero/Setebos 偏灰）→ 直接指定。
        2. 否则：倾角落在该族区间 ∩ 半长轴落在该族区间 → 归入。
        3. 都不满足 → 归入"未归类"，按最接近的族处理并降置信度。
   ============================================================== */
export const FAMILY_OF = Object.freeze({
  /* 木星 39 颗 */
  themisto: 'jup_themisto',     // i=45.7 孤立
  leda: 'jup_himalia', himalia: 'jup_himalia', ersa: 'jup_himalia',
  pandia: 'jup_himalia', lysithea: 'jup_himalia', elara: 'jup_himalia',
  dia: 'jup_himalia',
  carpo: 'jup_carpo',           // i=51.4 孤立 prograde
  /* 149° 区：Ananke 族（i約145–155） */
  euporie: 'jup_ananke', eupheme: 'jup_ananke', orthosie: 'jup_ananke',
  euanthe: 'jup_ananke', praxidike: 'jup_ananke', helike: 'jup_ananke',
  thyone: 'jup_ananke', iocaste: 'jup_ananke', ananke: 'jup_ananke',
  harpalyke: 'jup_ananke', philophrosyne: 'jup_ananke', eurydome: 'jup_ananke',
  /* 165° 区：Carme 族 */
  aitne: 'jup_carme', kale: 'jup_carme', taygete: 'jup_carme',
  chaldene: 'jup_carme', erinome: 'jup_carme', isonoe: 'jup_carme',
  eirene: 'jup_carme',
  kalyke: 'jup_kalyke',         // ⚠️ 文献明确：明显偏红的例外
  /* Pasiphae 族（弥散，i約151–158，a 23.5–24.1） */
  autonoe: 'jup_pasiphae', aoede: 'jup_pasiphae', sponde: 'jup_pasiphae',
  megaclite: 'jup_pasiphae', pasiphae: 'jup_pasiphae', hegemone: 'jup_pasiphae',
  cyllene: 'jup_pasiphae', kore: 'jup_pasiphae', callirrhoe: 'jup_pasiphae',
  sinope: 'jup_sinope',         // ⚠️ 文献明确：红、可能独立捕获

  /* 土星 28 颗 */
  kiviuq: 'sat_inuit', ijiraq: 'sat_inuit', paaliaq: 'sat_inuit',
  tarqeq: 'sat_inuit', siarnaq: 'sat_inuit',          // i≈46（因纽特）
  albiorix: 'sat_gallic', bebhionn: 'sat_gallic', erriapus: 'sat_gallic',
  tarvos: 'sat_gallic',                                // i≈34（高卢）
  phoebe: 'sat_phoebe',                                // ⚠️ 中性灰
  skathi: 'sat_norse', greip: 'sat_norse', hyrrokkin: 'sat_norse',
  mundilfari: 'sat_norse', narvi: 'sat_norse', bergelmir: 'sat_norse',
  jarnsaxa: 'sat_norse', suttungr: 'sat_norse', hati: 'sat_norse',
  farbauti: 'sat_norse', bestla: 'sat_norse', thrymr: 'sat_norse',
  aegir: 'sat_norse', fenrir: 'sat_norse', surtur: 'sat_norse',
  ymir: 'sat_norse', loge: 'sat_norse', fornjot: 'sat_norse',

  /* 天王星 9 颗 */
  francisco: 'ura_caliban', caliban: 'ura_caliban', stephano: 'ura_caliban',
  trinculo: 'ura_caliban',
  sycorax: 'ura_sycorax', prospero: 'ura_sycorax', setebos: 'ura_sycorax',
  ferdinand: 'ura_sycorax',
  margaret: 'ura_margaret',                            // prograde，孤立

  /* 海王星 6 颗 */
  nereid: 'nep_nereid',
  halimede: 'nep_halimede',
  sao: 'nep_sao', laomedeia: 'nep_sao',
  psamathe: 'nep_psamathe', neso: 'nep_psamathe',
});

/**
 * 族内**逐星微扰**（确定性，不用随机数 —— 随机数会让每次运行结果不同，
 * 既不可复现也无法写进测试）。做法：用 id 的字符哈希产生 -1..+1 的偏移，
 * 幅度按族内实测离散度给（多数族同质 → 幅度小；异质族 → 幅度大）。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠️ 幅度**不能**纯粹按"异质程度"随手给 —— 有一条硬约束（踩过）：
 * ══════════════════════════════════════════════════════════════
 * 「族内离散」与「族间差异」是两件事。Grav 说某些族**异质**，
 * 指的是**族内**成员在灰↔淡红这条带子上散得开；但这**不意味着**
 * 族内成员可以散到**邻居族的颜色区间里去**。
 *
 * 我第一版把异质族的 spread 给到 0.45–0.50（Pasiphae 0.50、Ananke 0.45），
 * 结果 ±0.06 mag 的抖动**大于与邻族 0.02–0.03 mag 的间距**，
 * 于是 Pasiphae 的成员渲染出来比 Ananke 的还红、Ananke 的比 Carme 的还红
 * —— 文献里明确的「灰 → 淡红」顺序被**抖翻**了。
 *
 * ⇒ 硬约束：**抖动上限 = 到最近邻族距离的一半**。
 *    这样两端各自最多吃掉一半间距，永远不可能越过中点碰头。
 *    该上限由文献数值**自动导出**（见 `FAMILY_SPREAD_CAP`），
 *    不是手调的魔数。
 *    「异质」只体现在"用满这个上限"，而不是"突破它"。
 */
export const FAMILY_SPREAD = Object.freeze({
  jup_himalia: 0.10,   // 同质
  jup_carme: 0.08,     // 最紧密
  jup_ananke: 0.45,    // ⚠️ 异质（实际会被 CAP 压到上限内）
  jup_pasiphae: 0.50,  // ⚠️ 最异质（实际会被 CAP 压到上限内）
  // ⚠️ themisto 0.03 / sinope 0.03 不是"拍脑袋调小"：
  //    Grav 2003 实测 Themisto B−V=0.83±0.02 与 Sinope B−V=0.84±0.03 **几乎并列**，
  //    但原文只称 Sinope 为 "very red"（倾角 158.1° 与族不同 → 独立捕获）。
  //    ⇒ 两者是**文档化的近并列**，逐星抖动（±0.12×spread）必须小于
  //      两者 Δ(B−V) 的差（0.01 mag），否则会**把文献顺序抖翻** —— 静默错误，
  //      因为它看起来只是"每颗都不一样"，而检查器只能靠顺序发现。
  //    0.03 × 0.12 = 0.0036 mag < 0.01 ✅（留 2.8× 余量）
  jup_themisto: 0.03, jup_carpo: 0.15, jup_sinope: 0.03, jup_kalyke: 0.05,
  sat_gallic: 0.10, sat_inuit: 0.10,
  sat_phoebe: 0.20, sat_norse: 0.40,   // ⚠️ 北欧群弥散
  ura_caliban: 0.20, ura_sycorax: 0.25, ura_margaret: 0.15,
  nep_halimede: 0.15, nep_nereid: 0.10, nep_sao: 0.20, nep_psamathe: 0.20,
});

/** 单次扰动把 spread 映射到实际 mag 偏移的系数（见 `perturbIndices`） */
const SPREAD_TO_MAG = 0.12;

/**
 * ⚠️ **抖动上限** —— 由该族到最近邻族的**归一化色距**导出。
 *
 * 语义：`effectiveSpread(f)` ≤ `FAMILY_SPREAD_CAP[f]`。
 * 「异质」只能把 spread 顶到这个上限，不能超过。
 *
 * ⚠️ 为什么**不能**只用 Δ(B−V) 定上限（第一版就是这么错的）：
 *    有大量族在 B−V 上**恰好并列**（carme 0.76 / sao 0.76 / psamathe 0.76、
 *    ananke 0.77 / norse 0.77、carpo 0.78 / caliban 0.78 …）。
 *    只用 B−V 时这些族的"最近邻距离"= 0 → CAP = 0 →
 *    **整族抖动被压成零，族内所有成员渲染成同一个颜色** ——
 *    这正是 D2 之前抓到的"抹平"回归，换个原因又犯一次。
 *    「在 B−V 上并列」不等于「必须是同一个颜色」：它们 V−R 不同
 *    （carme 0.47 vs sao 0.44）、反照率档也不同。并列只是**一个投影上的并列**。
 *
 * ⇒ 用**二维色距**：Δ(B−V) 与 Δ(V−R) 构成色平面上的两点，
 *    取欧氏距离。这样 B−V 并列但 V−R 有差的族仍有可用空间。
 *    两个分量按 grav 的不确定度量级加权（B−V ±0.02、V−R ±0.02 ⇒ 等权）。
 *
 * ⚠️ 仍然要**留下限**：即便二维上也并列（如同族参数的镜像族），
 *    CAP 也必须给一个非零的小值，否则回到"抹平"。
 *    下限 0.05 的依据：它对应 ±0.006 mag —— 小于 Grav 单星测量误差
 *    （±0.02 mag），即"这个幅度小到无论如何都不会被误读成族间差异"。
 */
export const FAMILY_SPREAD_CAP = (() => {
  const solarBV = 0.67, solarVR = 0.37;   // = indices-to-spectrum.SOLAR_INDICES
  /* 1. 族在「相对太阳」色平面上的坐标 (Δ(B−V), Δ(V−R)) */
  const pos = {};
  for (const [k, f] of Object.entries(FAMILIES)) {
    pos[k] = [f.bv - solarBV, f.vr - solarVR];
  }

  /* 2. 每族到最近邻族的二维色距的一半 → 抖动上限 */
  const keys = Object.keys(pos);
  const FLOOR = 0.05;                     // 见上：不设下限会退回"抹平"
  const cap = {};
  for (const k of keys) {
    let nearest = Infinity;
    for (const o of keys) {
      if (o === k) continue;
      const dx = pos[o][0] - pos[k][0];
      const dy = pos[o][1] - pos[k][1];
      const d = Math.hypot(dx, dy);
      if (d < nearest) nearest = d;
    }
    const half = nearest === Infinity ? 1 : nearest / 2;
    cap[k] = Math.max(FLOOR, half / SPREAD_TO_MAG);
  }
  return Object.freeze(cap);
})();

/**
 * 取某族**实际生效**的抖动幅度 = min(声明值, CAP)。
 * 调用方（生成器 / 检查器）一律用这个，不要直接用 FAMILY_SPREAD，
 * 否则会绕开上限、再现跨族抖翻。
 */
export function effectiveSpread(famId) {
  const declared = FAMILY_SPREAD[famId] ?? 0.15;
  const cap = FAMILY_SPREAD_CAP[famId];
  return cap === undefined ? declared : Math.min(declared, cap);
}

/** 取某颗卫星的族 id（非不规则卫星返回 null） */
export function familyOfMoon(id) {
  return FAMILY_OF[id] || null;
}

/* ==============================================================
   2b. 分类学反照率档的**区间**
   ==============================================================
   来源：Grav et al. 2003 引用的小行星分类学反照率（同文 §1 讨论母体类型）：
        C 3–8%、P 2–6%、D 2–5%、M 10–18%、A 13–35%、E 25–60%
   族级反照率取该档**中值**作为基准，区间用于逐星微扰。
   ============================================================== */
export const ALBEDO_CLASS = Object.freeze({
  C: [0.030, 0.080],
  P: [0.020, 0.060],
  D: [0.020, 0.050],
  M: [0.100, 0.180],
  A: [0.130, 0.350],
  E: [0.250, 0.600],
});

/**
 * 取某颗卫星的**逐星反照率**：在族分类学档的区间内做确定性分布。
 *
 * ⚠️ 为什么需要这一步（实测教训）：
 *    只用族级中值时，同族 18 颗算出**完全相同的 Y**（如 sat_norse
 *    全是 0.040），经 sRGB 8 位编码后塌成 1–3 个 hex。
 *    检查器会报「17 颗共用一个 hex」——但那不是复制粘贴，
 *    是**模型丢了维度**。补上反照率维度后，同族成员亮度各异，
 *    这才与"同族颜色同质但非同一"的观测事实相符。
 *
 * @param {string} id  卫星 id
 * @param {object} fam 族定义
 * @returns {number} 反照率
 */
export function albedoOf(id, fam) {
  const range = ALBEDO_CLASS[fam.className] || [fam.albedo * 0.7, fam.albedo * 1.3];
  const [lo, hi] = range;
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  // 用另一个哈希种子，避免与颜色扰动共线
  return mid + hashUnit('alb:' + id) * half * 0.85;   // ×0.85 留边，不贴到档边界
}

/** 取族定义；无族返回 null */
export function familyDef(id) {
  const f = FAMILY_OF[id];
  return f ? FAMILIES[f] : null;
}

/**
 * 确定性扰动：把 id 映射到 [-1, 1]。
 * 用 FNV-1a 的简化版 —— 只要稳定、分布均匀即可，不需要密码学强度。
 */
export function hashUnit(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 2001) / 1000 - 1;   // [-1, 1]，步长 0.001
}

/* ==============================================================
   3. 非单斜率天体的显式光谱 —— Kalyke
   ==============================================================
   ⚠️ 为什么它不能走通用「色指数 → 单斜率」路径：
      Grav 2003 实测 Kalyke 的 Δ(B−V)=+0.05（几乎与太阳同色）
      但 Δ(V−R)=+0.59（极红）。一个幂律斜率**不可能**同时满足
      这两点 —— 数学上无解（实测 |Δk|≈3.0）。
      原文亦言其"V−R 红得异常、V−I 却中等"，分类 unsecure。

   ⇒ 忠实还原数据形状：**蓝-绿端平缓（近太阳色）+ 绿-红端陡升**。
      用一条分段线性反射率谱表达，而不是硬凑一个斜率。
      这不是"为了好看编的"—— 两个拐点分别锚在 Grav 的 B、V、R
      三个通带等效波长（436/545/641 nm）上，形状由数据决定。
   ============================================================== */
export const KALYKE_SPECTRUM = Object.freeze([
  // 港：B 通带(436) 附近保持近中性（Δ(B−V)≈+0.05）
  [380, 0.90], [436, 1.00], [500, 1.05],
  // 拐点后红端陡升，使 V−R 达到 +0.59 的观测值
  [545, 1.10], [600, 1.35], [641, 1.55], [700, 1.72], [780, 1.85],
]);

/** Kalyke 的实测色指数（Grav 2003 Table 2），供文档与校验引用 */
export const KALYKE_INDICES = Object.freeze({
  bv: 0.72, vr: 0.96, src: 'Grav et al. 2003 Icarus 166,33 Table 2',
});

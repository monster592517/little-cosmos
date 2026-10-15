/**
 * 由 **UBVRI 色指数** 反推反射率谱，再算真彩
 * ══════════════════════════════════════════════════════════════
 * 为什么需要这一步
 * ══════════════════════════════════════════════════════════════
 * 不规则卫星**没有逐波长反照率谱**（它们太暗太小，测不到光谱），
 * 但有大量 **BVRI 宽带测光**。Grav et al. 2003 就给了 21 颗的
 * B−V / V−R / V−I 及其误差。
 *
 * 所以正确的做法不是"我猜它偏红"，而是：
 *   **把色指数当作对反射率谱形状的约束**，构造一条满足该约束的谱。
 *
 * ══════════════════════════════════════════════════════════════
 * 方法（可审计，不是拟合玄学）
 * ══════════════════════════════════════════════════════════════
 * 1. 色指数定义：B−V = −2.5·log10(F_B / F_V)，其中 F 是**通带加权流量**。
 *    对反射体，F_band ∝ ∫ S(λ)·T_band(λ)·λ dλ（S = 反射率，T = 滤光片+CCD 响应）。
 *    （能量型通带，多一个 λ 因子 —— 这是天文测光的标准做法，不能省。）
 *
 * 2. 设反射率谱为「线性 log 斜率」形式：S(λ) = S0·(λ/550)^k
 *    —— 即单参数（斜率 k）家族。这是小天体反射谱的一阶近似
 *    （文献里常直接报 "spectral slope %/1000Å"，本身就是这个 k）。
 *
 * 3. 用 B−V 与 V−R **两个约束**定 k。两者会给出一致的 k（自洽性检查），
 *    若明显不一致（>2σ）则说明该天体谱不满足单斜率假设 → 降置信度。
 *
 * 4. 亮度不由色指数定（色指数是比值，丢掉绝对亮度）→ 单独锚到
 *    **族级分类学反照率**（C 3–8% / P 2–6% / D 2–5% 的中值）。
 *    这与 spectra.js 的 `normalizeToGeo()` 是同一套思路：
 *    **形状来自观测（此处是色指数）、亮度来自权威表（反照率档）**。
 *
 * ⚠️ 为什么不能直接把 B−V 当"红蓝比"线性用：
 *    B−V 是**星等差**，是对数。0.7 的 B−V 对应流量比 10^(-0.7/2.5) ≈ 0.52，
 *    不是 0.7。把星等当线性量用会让所有颜色系统性偏淡。
 */

import {
  SPEC_LAMBDA_MIN, SPEC_LAMBDA_STEP, SPEC_LAMBDA_MAX,
} from './spectra.js';

/* ==============================================================
   1. UBVRI 通带响应（Bessell 1990 有效波长 + FWHM 的高斯近似）
   ==============================================================
   ⚠️ 这里是**近似**，不是 Bessell 原表的逐 nm 复刻。误差对
      「B−V → 斜率」这个用途足够（斜率是宽泛量），但不足以做
      精密测光合成。已在 `note` 里声明，且置信度按此打折。

   ⚠️ 通带参数**必须用 FWHM 换算 σ，不能随手填"宽度"**。
      我第一版把 σ 填成 49/44/55（凭印象），结果 B 通带太窄，
      k 需要到 4.5 以上才能凑出 B−V=0.91，二分直接顶到上界，
      所有族被"钳"在同一个 k=3.000 —— 一个**看起来跑通了、其实全部
      失效**的假绿。改按 σ = FWHM/2.3548 后范围正常（见下）。
   ============================================================== */
const BANDS = Object.freeze({
  B: { lam: 436, fwhm: 89 },    // Bessell 1990: λeff=436nm, FWHM=89nm
  V: { lam: 545, fwhm: 84 },    // Bessell 1990: λeff=545nm, FWHM=84nm
  R: { lam: 641, fwhm: 158 },   // Bessell 1990: λeff=641nm, FWHM=158nm
});

/**
 * ⚠️ **太阳色指数**（Grav et al. 2003 §4 引用 Hartmann et al. 1982）：
 *      B−V = 0.67,  V−R = 0.37
 *
 * 这是整个模块**最容易搞错**的一步。Grav 把不规则卫星分两类时用的原话是：
 *   · grey class —— "the objects have **sun-like colors**"
 *   · light red class —— 比太阳红
 *
 * 也就是说：**色指数是相对太阳测的**。一颗**平反射率**的天体
 * （S(λ)=常数，即"中性灰"）测出来是 B−V≈0.67，不是 0！
 * 因为它反射的是太阳的光 —— 太阳本身 B−V=0.67。
 *
 * ⇒ 所以必须先把目标色指数**减去太阳值**，得到"相对太阳的红度" Δ，
 *   再用平谱（k=0，Δ=0）去拟合 Δ。
 *
 * 踩过的坑：我第一版直接把 B−V=0.76 当目标去拟合，于是 Carme 被算成
 * k=2.7（相当红），渲染出 #423324 深棕 —— 而它真实只是"淡红"。
 * 数值上"能跑通"（往返一致），物理上**完全错向**。
 */
export const SOLAR_INDICES = Object.freeze({ bv: 0.67, vr: 0.37 });

/**
 * 通带加权流量：F_band = ∫ S(λ)·T(λ)·λ dλ / ∫ T(λ)·λ dλ
 * （归一化掉通带自身，使 F 等于"等效单色流量"）
 */
function bandFlux(spectrum, band) {
  const { lam: c, fwhm } = BANDS[band];
  const s = fwhm / 2.3548;              // FWHM → σ
  let num = 0, den = 0;
  for (let i = 0; i < spectrum.length; i++) {
    const lam = SPEC_LAMBDA_MIN + i * SPEC_LAMBDA_STEP;
    const t = Math.exp(-0.5 * ((lam - c) / s) ** 2);
    const w = t * lam;             // 能量型通带权重
    num += spectrum[i] * w;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** 由 (B−V, V−R) 合成实测色指数（用于反向校验） */
export function synthIndices(spectrum) {
  const fB = bandFlux(spectrum, 'B'), fV = bandFlux(spectrum, 'V'), fR = bandFlux(spectrum, 'R');
  return {
    bv: -2.5 * Math.log10(fB / fV),
    vr: -2.5 * Math.log10(fV / fR),
  };
}

/** 生成单斜率幂律谱 S(λ) = (λ/550)^k */
function powerLawSpectrum(k) {
  const n = Math.round((SPEC_LAMBDA_MAX - SPEC_LAMBDA_MIN) / SPEC_LAMBDA_STEP) + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lam = SPEC_LAMBDA_MIN + i * SPEC_LAMBDA_STEP;
    out[i] = Math.pow(lam / 550, k);
  }
  return out;
}

/**
 * 二分求 k，使该**反射率谱**的色指数相对**平谱**的偏移等于目标 Δ。
 *
 * ⚠️ 注意是「相对平谱」而不是「相对太阳」：这里算的是**反射率谱自身**
 *    代入通带积分后的色指数（等价于用等能白照射）。平谱给 0，
 *    正 k 给正值。太阳的影响已经在调用方用 SOLAR_INDICES 扣掉了 ——
 *    两者是同一件事的两种说法，扣一次、且只扣一次（见 indicesToSpectrum）。
 */
function solveSlope(delta, which) {
  // 上界放到 12：实测 B−V=0.91 只需 k≈4，留足余量。
  // （第一版上界 3 导致全体被钳在 3.000 —— 静默失效，见文件头注释。）
  let lo = -6, hi = 12;
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2;
    const got = synthIndices(powerLawSpectrum(mid))[which];
    if (got < delta) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 由色指数构造反射率谱。
 *
 * 口径链（三步，缺一不可）：
 *   1. 目标色指数**减去太阳色指数** → Δ，即"比太阳红多少"。
 *      平反射率天体 Δ=0（它看起来就是太阳的颜色）。
 *   2. 用单斜率幂律谱 S(λ)=(λ/550)^k 拟合 Δ，得到 k。
 *      B−V 与 V−R 各给一个 k，取平均；两者之差作为**自洽性指标**。
 *   3. 亮度**不由色指数决定**（色指数是比值，丢掉绝对亮度），
 *      单独锚到族级**分类学反照率**（C 3–8% / P 2–6% / D 2–5%）。
 *      ⇒ 「形状来自测光、亮度来自反照率档」，与 spectra.js 的
 *        normalizeToGeo() 同一套思路。
 *
 * @param {number} bv  B−V 色指数（**观测值，含太阳色**）
 * @param {number} vr  V−R 色指数（同上）
 * @param {number} geoAlbedo 目标视觉几何反照率（族级）
 * @returns {{grid: Float64Array, k: number, kFromBV: number, kFromVR: number,
 *            agree: number, achieved: {bv:number,vr:number}, geoAlbedo: number}}
 */
export function indicesToSpectrum(bv, vr, geoAlbedo) {
  const dbv = bv - SOLAR_INDICES.bv;
  const dvr = vr - SOLAR_INDICES.vr;
  const kBV = solveSlope(dbv, 'bv');
  const kVR = solveSlope(dvr, 'vr');
  const k = (kBV + kVR) / 2;
  const raw = powerLawSpectrum(k);
  // 锚定亮度：用 V 通带作为亮度参考（与"几何反照率 @0.55μm"同口径）
  const fV = bandFlux(raw, 'V');
  const grid = new Float64Array(raw.length);
  const scale = fV > 0 ? geoAlbedo / fV : 0;
  for (let i = 0; i < raw.length; i++) grid[i] = raw[i] * scale;
  // 复现值：把 Δ 加回太阳色指数，才是可与观测直接对比的量
  const rawIdx = synthIndices(grid);
  const achieved = {
    bv: rawIdx.bv + SOLAR_INDICES.bv,
    vr: rawIdx.vr + SOLAR_INDICES.vr,
  };
  return {
    grid, k, kFromBV: kBV, kFromVR: kVR,
    agree: Math.abs(kBV - kVR),          // 两约束的不一致度（越小越自洽）
    achieved, geoAlbedo,
    delta: { bv: dbv, vr: dvr },
  };
}

/**
 * 把色指数扰动成另一个色指数对（族内逐星微扰用）。
 * 扰动方向：同时抬/降 B−V 与 V−R，保持"红度"是单一变量 ——
 * 物理上同族成员的差异主要来自表面成熟度/覆盖物，应整体变红或变灰。
 */
export function perturbIndices(bv, vr, amount) {
  // amount ∈ [-1,1]，映射到 ±0.12 mag 的色指数偏移（实测族内离散量级）
  const d = amount * 0.12;
  return { bv: bv + d, vr: vr + d * 0.55 };
}

/* ==============================================================
   3. 单斜率假设的例外 —— 必须显式处理，不能静默吞掉
   ==============================================================
   `agree`（两个约束推出的 k 之差）是**自洽性诊断**。
   当 |Δk| 很大时，说明该天体的反射谱**不是单斜率**，
   照着平均 k 去渲染会系统性出错。

   实测（见 tools 的校验输出）：
     绝大多数族 |Δk| < 0.45  → 单斜率可用。
     **Kalyke 的 |Δk| = 2.998** → 完全不可用。
       原因：原文给出 Δ(B−V)=+0.05 但 Δ(V−R)=+0.59。
       即蓝-绿端几乎与太阳同色，而绿-红端极红 —— 一个纯斜率做不到。
       原文自己也说它"V−R 红得异常、V−I 却中等"，并称其分类 unsecure。
     ⇒ 处理：**Kalyke 单列**，不走通用拟合，直接给它一条
        "绿-红端陡升"的谱（分段：410–550 平缓，550–780 陡红）。
       这是对原文数据形状的忠实还原，而不是为了好看编的。

   ⚠️ 判据门限 0.5 是**有依据的**：实测除 Kalyke 外最大 0.425
      （sat_gallic，其 B−V 不确定度 ±0.05 也大）。留一点余量到 0.5。
   ============================================================== */
export const SINGLE_SLOPE_MAX_AGREE = 0.5;

/**
 * 给"非单斜率"天体的降级路径：返回谱 + 是否可信。
 * 调用方应据此降低置信度、并在 UI/数据里标注。
 */
export function spectrumWithQuality(bv, vr, geoAlbedo) {
  const r = indicesToSpectrum(bv, vr, geoAlbedo);
  const ok = r.agree <= SINGLE_SLOPE_MAX_AGREE;
  return { ...r, singleSlopeOk: ok, confidence: ok ? 0.75 : 0.35 };
}

/* ==============================================================
   4. 约束不全时的通用入口（实测数据的覆盖度是不整齐的）
   ==============================================================
   为什么需要它：真实的外太阳系测光汇编里，**不是每个天体都同时有 B−V 和 V−R**。
   实测（`data/raw/mboss2.dat`，Hainaut et al. 2012 冻结版）：

     · 谷神星 Ceres —— 只有 V−R（Ciarniello 2017 Dawn/VIR），B−V 无人报
     · 鸟神星 Makemake —— 只有 B−V = 0.828，V−R 那一列是 "------"（仅 1 个观测历元）
     · 绝大多数 TNO/Centaur —— 有 B−V、V−R，**外加** MBOSS 自己算好的谱斜率 Grt

   如果强行要求「必须两个色指数齐全」，上面这两颗就只能继续留着手写近似色 ——
   而它们恰恰是观测最充分的矮行星里最不该缺的。
   ⇒ 正确做法：**有几条约束用几条**，并把「用了几条」当成置信度的一部分报出来。

   ──────────────────────────────────────────────────────────────
   ★ 第三条约束：谱斜率 Grt（%/100 nm）→ 幂律指数 k
   ──────────────────────────────────────────────────────────────
   MBOSS 表的 Grt 列是作者**从色指数反解出的可见光反射率斜率**，
   单位和文献里常报的一致（如 67P 的 20 %/kÅ、Ceres 的 1.1 %/kÅ）。
   它已经是"谱的形状"本身，所以比色指数更直接 —— 但仍然要换算到本模块的 k。

   换算（这一步必须写下来，否则下一个人会随手除个 100 就完事）：
     · 线性斜率模型：S(λ) = S₅₅₀·[1 + s·(λ−550)/100]，s 是分数/100 nm
       ⇒ d(ln S)/dλ = s/100   （每 nm）
     · 幂律模型：S(λ) = S₅₅₀·(λ/550)^k
       ⇒ d(ln S)/dλ = k/λ，在 550 nm 处为 k/550
     · 两式在 550 nm 处相等： k/550 = s/100  ⇒  **k = 5.5·s**
     · 代入 s = Grt/100（因 Grt 是百分数）⇒ **k = 0.055·Grt**

   ⚠️ 别把 Grt 直接当 k 用：Grt=4 直接当 k 会把斜率放大 18 倍。
      也不会报错 —— 只会让所有天体红得离谱，且"看着像是数据问题"。
   ============================================================== */

/** 线性谱斜率（%/100 nm）→ 幂律指数 k。见上方推导。 */
export const K_PER_SLOPE_PCT = 5.5 / 100;

/** Grt（%/100 nm）→ 幂律指数 k */
export function slopeToK(grtPctPerKA) {
  return K_PER_SLOPE_PCT * grtPctPerKA;
}

/**
 * 通用入口：**有几条约束用几条**。
 *
 * @param {object} c
 * @param {number} [c.bv]          B−V 观测值（含太阳色）
 * @param {number} [c.vr]          V−R 观测值（含太阳色）
 * @param {number} [c.grtPctPerKA] MBOSS 谱斜率（%/100 nm）
 * @param {number} c.geoAlbedo     视觉几何反照率（**必填**，亮度不由色指数决定）
 * @param {string} [c.id]          仅用于报错信息
 * @returns {{grid: Float64Array, k: number, kFrom: object, n: number,
 *            agree: number, achieved: {bv:number,vr:number}, geoAlbedo: number}}
 *
 * `agree` = 各约束推出的 k 的**极差**（max−min）。n=1 时恒为 0 ——
 * 调用方**必须**根据 n 而不是 agree 判置信度，否则单约束会被误判成"完美自洽"。
 * （这正是把一个 `agree<=0.5` 的旧门限照搬过来会踩的坑。）
 *
 * ⚠️ n=2 且只给 bv+vr 时，本函数与 `indicesToSpectrum()` **逐位等价**：
 *    k 取两者均值、agree 取两者之差，同一套二分内核。
 *    这一点由 `tools/check-spectra.mjs` 断言，防止两条路悄悄分叉。
 */
export function spectrumFromConstraints(c) {
  const { bv, vr, grtPctPerKA, geoAlbedo, id = '' } = c || {};
  if (!Number.isFinite(geoAlbedo) || geoAlbedo <= 0) {
    throw new Error(`spectrumFromConstraints(${id}): geoAlbedo 必须为正数（亮度只能由反照率定）`);
  }

  const kFrom = {};
  const ks = [];
  const delta = {};

  // ⚠️ 太阳色指数**扣一次、且只扣一次**（坑 43）。
  if (Number.isFinite(bv)) {
    delta.bv = bv - SOLAR_INDICES.bv;
    kFrom.bv = solveSlope(delta.bv, 'bv');
    ks.push(kFrom.bv);
  }
  if (Number.isFinite(vr)) {
    delta.vr = vr - SOLAR_INDICES.vr;
    kFrom.vr = solveSlope(delta.vr, 'vr');
    ks.push(kFrom.vr);
  }
  if (Number.isFinite(grtPctPerKA)) {
    kFrom.grt = slopeToK(grtPctPerKA);   // 已是斜率本身，**不再减太阳值**
    ks.push(kFrom.grt);
  }
  if (!ks.length) {
    throw new Error(`spectrumFromConstraints(${id}): 至少需要 bv / vr / grtPctPerKA 之一`);
  }

  const k = ks.reduce((a, b) => a + b, 0) / ks.length;
  const agree = ks.length > 1 ? Math.max(...ks) - Math.min(...ks) : 0;

  const raw = powerLawSpectrum(k);
  const fV = bandFlux(raw, 'V');
  const grid = new Float64Array(raw.length);
  const scale = fV > 0 ? geoAlbedo / fV : 0;
  for (let i = 0; i < raw.length; i++) grid[i] = raw[i] * scale;

  const rawIdx = synthIndices(grid);
  return {
    grid, k, kFrom, n: ks.length, agree,
    achieved: { bv: rawIdx.bv + SOLAR_INDICES.bv, vr: rawIdx.vr + SOLAR_INDICES.vr },
    geoAlbedo,
    delta,
  };
}

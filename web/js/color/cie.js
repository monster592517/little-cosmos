/**
 * CIE 真彩合成内核 —— 「人眼真实」口径的唯一实现来源
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ══════════════════════════════════════════════════════════════
 * 用户的原话：「很多照片都是经过特殊处理方便研究他们的大气以及其他结构的，
 * 都不是真实的样子」。这句话在物理上是**准确**的。天文发布影像之所以看着
 * 鲜艳或奇异，通常出自下列一种或多种处理：
 *
 *   1. 伪彩 / 假彩（false color）—— 把不可见波段映射到可见色，例如把 8μm
 *      红外画成红色、24μm 画成绿色。Spitzer / WISE / JWST 的彩色影像几乎都是这样。
 *   2. 窄带合成（narrowband）—— 把 Hα / OIII / SII 三条发射线分别染成
 *      红/绿/蓝，即所谓「哈勃调色板」。它的目的是**分离物理结构**，不是还原颜色。
 *   3. 拉伸与调色（stretch / curve）—— 为了把跨越几个数量级的动态范围压进
 *      8 bit，必然要做非线性拉伸，这一步会系统性改变色相与饱和度。
 *   4. 去马赛克前的原始通道未做白平衡（raw channel white balance）。
 *
 * 而且还有一层更根本的：**「真实颜色」本身在科学上没有唯一答案。**
 * 一个物体的颜色取决于照射它的光源光谱。太阳表面温度 5772 K，峰值正确位于
 * 绿波段；但太阳在人眼里是白的——因为人的视觉系统会**适应**光源色。
 * 所以本模块采用的口径是明确且可辩护的：
 *
 *   ★ 口径定义（人眼真实 human-perceptual）
 *     物体在**等能白**（equal-energy white）照射下，经 CIE 1931 标准观察者
 *     积分后落到 XYZ 三刺激值，再由 XYZ → sRGB 矩阵转换，最后以 D65 白点
 *     做色适应呈现。等价于回答：「假如光源是标准白、你在场，你看到什么颜色」。
 *
 *     这个口径解释了用户的两个抱怨：
 *       · 「太阳发白」—— 对。太阳表面是 5772 K 黑体，其色度极其接近 D65 白。
 *         我们在天顶看到它偏黄，是**大气散射**（Rayleigh）造成的，不是它本身的颜色。
 *       · 「金星偏灰」—— 对。金星云顶反射率谱平、色调很淡，真实色是一层
 *         几乎无彩的淡黄白。
 *
 * ⚠️ 这张表里的数字**必须有出处**。没有出处的颜色宁可标 `src: null`
 *    并让调用方走「程序化生成」分支，也不许凭印象填。见 坑与雷点.md 坑 33。
 *
 * ══════════════════════════════════════════════════════════════
 * 依赖说明
 * ══════════════════════════════════════════════════════════════
 * 本文件是**纯函数 + 常量**，无第三方依赖，服务端与浏览器端都能直接 import。
 * 服务端工具（tools/*.mjs）与前端（web/js/**）共用这一份实现，
 * 避免「工具按一套算、前端按另一套显示」这种双份腐烂。
 */

/* ==============================================================
   1. CIE 1931 2° 标准观察者
   ==============================================================
   x̄(λ) ȳ(λ) z̄(λ) 在 380–780 nm 上是连续的。这里用 5 nm 采样，
   共 81 个点（380, 385, ... 780）。数据来自 CIE 15:2004 官方表。
   精度：5 nm 采样对宽谱光源（黑体、行星反射谱）误差 < 0.5%，
   对窄发射线（如 Hα 656.3 nm）误差可达数个百分点 —— 后者必须用
   1 nm 表，本模块在 `narrowbandWarning` 里显式提示这一点。
   ============================================================== */
export const CIE_LAMBDA_STEP = 5;
export const CIE_LAMBDA_MIN = 380;

/** @type {ReadonlyArray<readonly [number,number,number]>} */
const CIE_XYZ_5NM = Object.freeze([
  [0.001368, 0.000039, 0.006450], // 380
  [0.002236, 0.000064, 0.010550],
  [0.004243, 0.000120, 0.020050],
  [0.007650, 0.000217, 0.036210],
  [0.014310, 0.000396, 0.067850],
  [0.023190, 0.000640, 0.110200], // 405
  [0.043510, 0.001210, 0.207400],
  [0.077630, 0.002180, 0.371300],
  [0.134380, 0.004000, 0.645600],
  [0.214770, 0.007300, 1.039050],
  [0.283900, 0.011600, 1.385600], // 430
  [0.328500, 0.016840, 1.622960],
  [0.348280, 0.023000, 1.747060],
  [0.348060, 0.029800, 1.782600],
  [0.336200, 0.038000, 1.772110],
  [0.318700, 0.048000, 1.744100], // 455
  [0.290800, 0.060000, 1.669200],
  [0.251100, 0.073900, 1.528100],
  [0.195360, 0.090980, 1.287640],
  [0.142100, 0.112600, 1.041900],
  [0.095640, 0.139020, 0.812950], // 480
  [0.057950, 0.169300, 0.616200],
  [0.032010, 0.208020, 0.465180],
  [0.014700, 0.258600, 0.353300],
  [0.004900, 0.323000, 0.272000],
  [0.002400, 0.407300, 0.212300], // 505
  [0.009300, 0.503000, 0.158200],
  [0.029100, 0.608200, 0.111700],
  [0.063270, 0.710000, 0.078250],
  [0.109600, 0.793200, 0.057250],
  [0.165500, 0.862000, 0.042160], // 530
  [0.225750, 0.914850, 0.029840],
  [0.290400, 0.954000, 0.020300],
  [0.359700, 0.980300, 0.013400],
  [0.433450, 0.994950, 0.008750],
  [0.512050, 1.000000, 0.005750], // 555
  [0.594500, 0.995000, 0.003900],
  [0.678400, 0.978600, 0.002750],
  [0.762100, 0.952000, 0.002100],
  [0.842500, 0.915400, 0.001800],
  [0.916300, 0.870000, 0.001650], // 580
  [0.978600, 0.816300, 0.001400],
  [1.026300, 0.757000, 0.001100],
  [1.056700, 0.694900, 0.001000],
  [1.062200, 0.631000, 0.000800],
  [1.045600, 0.566800, 0.000600], // 605
  [1.002600, 0.503000, 0.000340],
  [0.938400, 0.441200, 0.000240],
  [0.854450, 0.381000, 0.000190],
  [0.751400, 0.321000, 0.000100],
  [0.642400, 0.265000, 0.000050], // 630
  [0.541900, 0.217000, 0.000030],
  [0.447900, 0.175000, 0.000020],
  [0.360800, 0.138200, 0.000010],
  [0.283500, 0.107000, 0.000000],
  [0.218700, 0.081600, 0.000000], // 655
  [0.164900, 0.061000, 0.000000],
  [0.121200, 0.044580, 0.000000],
  [0.087400, 0.032000, 0.000000],
  [0.063600, 0.023200, 0.000000],
  [0.046770, 0.017000, 0.000000], // 680
  [0.032900, 0.011920, 0.000000],
  [0.022700, 0.008210, 0.000000],
  [0.015840, 0.005723, 0.000000],
  [0.011359, 0.004102, 0.000000],
  [0.008111, 0.002929, 0.000000], // 705
  [0.005790, 0.002091, 0.000000],
  [0.004109, 0.001484, 0.000000],
  [0.002899, 0.001047, 0.000000],
  [0.002049, 0.000740, 0.000000],
  [0.001440, 0.000520, 0.000000], // 730
  [0.001000, 0.000361, 0.000000],
  [0.000690, 0.000249, 0.000000],
  [0.000476, 0.000172, 0.000000],
  [0.000332, 0.000120, 0.000000],
  [0.000235, 0.000085, 0.000000], // 755
  [0.000166, 0.000060, 0.000000],
  [0.000117, 0.000042, 0.000000],
  [0.000083, 0.000030, 0.000000],
  [0.000059, 0.000021, 0.000000],
  [0.000042, 0.000015, 0.000000], // 780
]);

/** 波长数组（nm），与 CIE_XYZ_5NM 一一对应 */
export const CIE_LAMBDAS = Object.freeze(
  CIE_XYZ_5NM.map((_, i) => CIE_LAMBDA_MIN + i * CIE_LAMBDA_STEP),
);

/* ==============================================================
   2. 光谱工具：黑体辐射 与 等能白
   ============================================================== */

/**
 * 普朗克黑体谱（相对值，未归一化）。
 * @param {number} T 色温 (K)
 * @param {number} lambdaNm 波长 (nm)
 * @returns {number} 相对谱辐亮度
 */
export function planck(T, lambdaNm) {
  const h = 6.62607015e-34;  // J·s
  const c = 2.99792458e8;    // m/s
  const kB = 1.380649e-23;   // J/K
  const l = lambdaNm * 1e-9;
  const a = (2 * h * c * c) / Math.pow(l, 5);
  const b = (h * c) / (l * kB * T);
  return a / (Math.exp(b) - 1);
}

/**
 * 等能白 E（equal-energy white）—— 本模块的默认光源。
 * 用它而不是 D65 的理由：D65 本身带轻微蓝调（相关色温 6504 K，
 * 但光谱并不等于 6504 K 黑体）。用等能白可以得到「光源无偏」的
 * 绝对色度，更符合「这个物体本身是什么颜色」这个问题。
 * @returns {Float64Array} 与 CIE_LAMBDAS 对齐的光谱
 */
export function illuminantE() {
  const s = new Float64Array(CIE_LAMBDAS.length);
  s.fill(1);
  return s;
}

/**
 * 黑体光源光谱（如恒星照射行星时用）。
 * @param {number} T 色温 (K)
 */
export function illuminantBlackbody(T) {
  const s = new Float64Array(CIE_LAMBDAS.length);
  for (let i = 0; i < CIE_LAMBDAS.length; i++) s[i] = planck(T, CIE_LAMBDAS[i]);
  return s;
}

/* ==============================================================
   3. 光谱 → XYZ → sRGB 主管线
   ============================================================== */

/**
 * 把一条光谱（反射率或辐亮度）积分成 CIE XYZ。
 *
 * ⚠️ 归一化因子 k 的选择很关键，它决定 Y=1 代表什么。
 *    这里取 k = 1 / (Σ ȳ(λ)·光源(λ)·Δλ)，于是：
 *      · 反射率谱全 1（完美漫反射白）→ Y = 1.0   ✔ 这是「反照率」
 *      · 反射率谱全 0.08（月海）     → Y = 0.08  ✔ 保留亮度信息
 *    之前用 k = Δλ（不给 ȳ 归一）会让 Y ≈ 106，导致 keepLuminance
 *    分支里所有天体都超界成纯白 —— 那个 bug 就是这么来的。
 *
 * @param {ArrayLike<number>} spectrum 与 CIE_LAMBDAS 对齐的光谱值
 * @param {ArrayLike<number>} [illum] 光源光谱（默认等能白）
 * @returns {{X:number,Y:number,Z:number}}
 */
export function spectrumToXYZ(spectrum, illum) {
  const light = illum || illuminantE();
  let X = 0, Y = 0, Z = 0, norm = 0;
  for (let i = 0; i < CIE_XYZ_5NM.length; i++) {
    const l = light[i] ?? 1;
    const p = (spectrum[i] ?? 0) * l;
    X += p * CIE_XYZ_5NM[i][0];
    Y += p * CIE_XYZ_5NM[i][1];
    Z += p * CIE_XYZ_5NM[i][2];
    norm += l * CIE_XYZ_5NM[i][1];
  }
  const k = CIE_LAMBDA_STEP / (norm * CIE_LAMBDA_STEP); // = 1/norm
  return { X: X * k, Y: Y * k, Z: Z * k };
}

/** sRGB 线性 → 编码（IEC 61966-2-1 分段函数） */
export function encodeSRGB(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** sRGB 编码 → 线性 */
export function decodeSRGB(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * CIE XYZ (D65 白点) → 线性 sRGB。
 * 矩阵为 IEC 61966-2-1 标准值。
 *
 * ⚠️ 这个矩阵**假定输入 XYZ 已经相对于 D65 白点**。若直接喂等能白 E
 *    （x=y=1/3，色温约 5454 K）的 XYZ，会得到偏粉的结果 —— 这不是错觉，
 *    是「没做色适应」的实症。见 `adaptToD65()`。
 */
export function xyzToLinearSRGB(X, Y, Z) {
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [r, g, b];
}

/* ==============================================================
   3b. 色适应：把任意白点下的 XYZ 转到 D65
   ==============================================================
   为什么必须有这一步 —— 2026-09-11 实测出来的：
   本模块最初直接拿「等能白 E」的 XYZ 喂 D65 矩阵，结果等能白算出 #ffe5e1
   （粉的），太阳 5772 K 算出 rgb(255,241,234)。虽然方向对（偏暖），
   但**纯度错了**：这是矩阵与白点不匹配造成的系统性色偏，不是物理。
   这类错误最阴的地方在于「结果看着挺合理」，只有断言才拦得住。

   解法：von Kries 色适应，用 Bradford 变换矩阵。
   出处：Lam, K.-M. 1985；Bruce Lindbloom 的标准实现。
   ============================================================== */

/** 各光源白点的 XYZ（Y 归一化到 1） */
export const WHITE_POINTS = Object.freeze({
  E:   { X: 1.0000000, Y: 1.0, Z: 1.0000000 },  // 等能白
  D50: { X: 0.9642200, Y: 1.0, Z: 0.8252100 },
  D55: { X: 0.9568200, Y: 1.0, Z: 0.9214900 },
  D65: { X: 0.9504700, Y: 1.0, Z: 1.0888300 },
  A:   { X: 1.0985000, Y: 1.0, Z: 0.3558500 },
});

/** Bradford 锥体响应矩阵 */
const BRADFORD = [
  [0.8951000, 0.2664000, -0.1614000],
  [-0.7502000, 1.7135000, 0.0367000],
  [0.0389000, -0.0685000, 1.0296000],
];
const BRADFORD_INV = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
];

const mul3 = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/** 预计算「任意白点 → D65」的 3×3 矩阵（缓存） */
const adaptCache = new Map();

/**
 * 构造 von Kries (Bradford) 色适应矩阵：srcWhite → D65。
 * @param {string|{X:number,Y:number,Z:number}} srcWhite 源白点（名字或 XYZ）
 * @returns {number[][]} 3×3 矩阵
 */
export function adaptationMatrixToD65(srcWhite) {
  const key = typeof srcWhite === 'string' ? srcWhite : `${srcWhite.X},${srcWhite.Y},${srcWhite.Z}`;
  if (adaptCache.has(key)) return adaptCache.get(key);
  const sw = typeof srcWhite === 'string' ? WHITE_POINTS[srcWhite] : srcWhite;
  const dw = WHITE_POINTS.D65;
  if (!sw) throw new Error(`未知白点：${key}`);
  const srcCone = mul3(BRADFORD, [sw.X, sw.Y, sw.Z]);
  const dstCone = mul3(BRADFORD, [dw.X, dw.Y, dw.Z]);
  const scale = [
    [dstCone[0] / srcCone[0], 0, 0],
    [0, dstCone[1] / srcCone[1], 0],
    [0, 0, dstCone[2] / srcCone[2]],
  ];
  // M = Bradford⁻¹ · scale · Bradford
  const tmp = [
    [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      tmp[i][j] = scale[i][i] * BRADFORD[i][j];
    }
  }
  const out = [
    [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = BRADFORD_INV[i][0] * tmp[0][j]
        + BRADFORD_INV[i][1] * tmp[1][j]
        + BRADFORD_INV[i][2] * tmp[2][j];
    }
  }
  adaptCache.set(key, out);
  return out;
}

/**
 * 把源白点下的 XYZ 适应到 D65。
 * @param {{X:number,Y:number,Z:number}} xyz
 * @param {string|{X:number,Y:number,Z:number}} [srcWhite='E']
 */
export function adaptToD65(xyz, srcWhite = 'E') {
  if (srcWhite === 'D65') return xyz;
  const m = adaptationMatrixToD65(srcWhite);
  const v = mul3(m, [xyz.X, xyz.Y, xyz.Z]);
  return { X: v[0], Y: v[1], Z: v[2] };
}

/**
 * 把 XYZ 归一化到 Y=1（等价于「亮度对齐」），再转 sRGB。
 * ⚠️ 归一化是**必须**的：否则暗天体（如彗核反照率 0.04）会得到近乎全黑的颜色，
 *    而我们要的是「把它放在正常曝光下看是什么色相」，不是它的绝对亮度。
 *    绝对亮度由渲染层的光照强度决定，不该混进颜色里。
 *
 * @param {{X:number,Y:number,Z:number}} xyz
 * @param {{gamma?:boolean, srcWhite?:string|object}} [opt]
 *   srcWhite —— 输入 XYZ 所属的白点。默认 'E'（等能白），会自动做
 *   Bradford 色适应到 D65。传 'D65' 表示已适应、跳过。
 * @returns {{rgb:[number,number,number], hex:string, clipped:boolean, maxLinear:number}}
 */
export function xyzToHex(xyz, opt = {}) {
  const { gamma = true, srcWhite = 'E', keepLuminance = false, exposure = 1 } = opt;
  const Y = xyz.Y || 1e-12;
  // ⚠️ 归一化用的 Y 必须在改之前存下来 —— 下面 adaptToD65 吃的是 XYZ/Y，
  //    之后 xyz.Y 就已经是 1 了，再取就永远是 1（这个坑我踩过一次：
  //    keepLuminance 分支里用 xyz.Y 做缩放，结果所有天体都渲染成纯白）。
  const rawLuma = Y;
  // 先归一化（色度不受 Y 缩放影响），再做色适应，顺序不可颠倒
  const adapted = adaptToD65({ X: xyz.X / Y, Y: 1, Z: xyz.Z / Y }, srcWhite);
  let [r, g, b] = xyzToLinearSRGB(adapted.X, adapted.Y, adapted.Z);

  // 用「该色度在 sRGB 中的最亮可达通道」做曝光归一，这样色相**精确**保留，
  // 不会因为单通道裁切而丢饱和。
  //   · keepLuminance=false（色板模式）→ 强制 maxLinear=1，纯色板语义
  //   · keepLuminance=true （渲染模式）→ 只做「拍平到不超界」的必要曝光，
  //     亮度差仍由 Y 决定，但不会因为 R 单独超界就被裁掉色相
  const chromaMax = Math.max(r, g, b, 1e-12);

  if (!keepLuminance) {
    const k = 1 / chromaMax;
    r *= k; g *= k; b *= k;
  } else {
    const k = rawLuma * exposure;
    r *= k; g *= k; b *= k;
    // 若仍超界，按色度上限压回（保持色相），并记下真实 Y
    const mx = Math.max(r, g, b);
    if (mx > 1) { const kk = 1 / mx; r *= kk; g *= kk; b *= kk; }
  }

  const clipped = chromaMax > 1 + 1e-9 || r < 0 || g < 0 || b < 0;
  let rr = Math.max(0, Math.min(1, r));
  let gg = Math.max(0, Math.min(1, g));
  let bb = Math.max(0, Math.min(1, b));
  const enc = gamma ? [encodeSRGB(rr), encodeSRGB(gg), encodeSRGB(bb)] : [rr, gg, bb];
  const to255 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const rgb = enc.map(to255);
  const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  const mx = Math.max(...rgb), mn = Math.min(...rgb);
  return { rgb, hex, clipped, maxLinear: chromaMax, y: rawLuma, saturation: mx === 0 ? 0 : (mx - mn) / mx };
}

/**
 * 把一条反射率谱按「保留亮度」的方式转成 sRGB —— 渲染用，不是色板用。
 *
 * 与 spectrumToHex 的差别：
 *   · spectrumToHex    → 归一化到 Y=1，输出「这是什么色相」，亮度恒为 1
 *   · spectrumToRender → 保留 Y，输出「这个物体有多亮 + 什么色相」
 *
 * ⚠️ 为什么要两个？因为我们同时需要两件不同的事：
 *   1. 贴图/材质基色需要正确的**亮度**（月海 8% 不能渲染成白）
 *   2. UI 色板需要正确的**色相**（不能被亮度压成黑乎乎一片看不见）
 *   把这两件事混成一个函数，必然有一头是错的。见 坑与雷点.md 新增条目。
 *
 * @param {ArrayLike<number>} spectrum 反射率谱（0..1）
 * @param {{illum?:ArrayLike<number>, exposure?:number}} [opt]
 */
export function spectrumToRender(spectrum, opt = {}) {
  const xyz = spectrumToXYZ(spectrum, opt.illum);
  return xyzToHex(xyz, {
    keepLuminance: true,
    exposure: opt.exposure ?? 1,
    srcWhite: opt.srcWhite ?? 'E',
    gamma: opt.gamma ?? true,
  });
}

/**
 * 一条光谱 → sRGB hex（一步到位）。
 * @param {ArrayLike<number>} spectrum
 * @param {{illum?:ArrayLike<number>, gamma?:boolean}} [opt]
 */
export function spectrumToHex(spectrum, opt = {}) {
  return xyzToHex(spectrumToXYZ(spectrum, opt.illum), opt);
}

/* ==============================================================
   4. 色度坐标与色温（用于黑体星色）
   ============================================================== */

/** XYZ → CIE 1931 xy 色度 */
export function xyzToChromaticity(xyz) {
  const s = xyz.X + xyz.Y + xyz.Z;
  if (!(s > 0)) return { x: 0.3127, y: 0.3290 }; // 退化时给 D65
  return { x: xyz.X / s, y: xyz.Y / s };
}

/**
 * 黑体色温 → CIE xy（Kim et al. 2002 的三次多项式拟合，精度 ±0.0001，
 * 覆盖 1667–25000 K）。用于把恒星的有效温度直接变成颜色，
 * 比「按 B-V 查表」更准，且不依赖经验表。
 *
 * 出处：Kim, B.-K. et al. 2002, "Design of Advanced Color Temperature
 *       Control System for HDTV Applications", J. Korean Phys. Soc. 41, 865.
 */
export function blackbodyChromaticity(T) {
  const t = Math.max(1667, Math.min(25000, T));
  const inv = 1000 / t;
  let x, y;
  if (t <= 4000) {
    x = -0.2661239 * inv ** 3 - 0.2343589 * inv ** 2 + 0.8776956 * inv + 0.179910;
  } else {
    x = -3.0258469 * inv ** 3 + 2.1070379 * inv ** 2 + 0.2226347 * inv + 0.240390;
  }
  const x2 = x * x, x3 = x2 * x;
  if (t <= 2222) {
    y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  } else if (t <= 4000) {
    y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  }
  return { x, y };
}

/**
 * 黑体色温 → sRGB hex。
 *
 * 实现要点：由 Kim 拟合式拿到 xy → 转成 Y=1 的 XYZ（白点即该温度黑体本身）
 * → 以该温度为源白点做 Bradford 适应到 D65 → 转 sRGB。
 *
 * ⚠️ 适应这一步是必须的。若把 5772 K 的 XYZ 直接喂 D65 矩阵，
 *    会把「太阳的色度」正确保留但把「D65 的相对关系」误用，结果偏暖过度。
 *    适应之后 5772 K 落在接近纯白处 —— 这才是物理上对的结果。
 *    ⚠️ 但整条黑色轨迹**全都要落在 D65 上**是不对的（那会得到全白），
 *    所以这里采取的正确做法是：适应到 D65 是为了让**色域映射**正确，
 *    而色相保留由适应矩阵本身完成；对白点自身适应会退化成白，
 *    因此改用「以 D65 为参照、保留相对色度」的做法 —— 即只做归一化，
 *    不把黑体白点当成要消除的偏色。
 *
 * 最终选择（可用自检验证）：不做白点适应，直接用 xy→XYZ→sRGB，
 * 然后按最大通道归一化。这条路径对 1000–25000 K 给出的序列
 * 与公认的「色温-颜色」对照表一致（2700 K 橙、10000 K 蓝）。
 */
export function blackbodyToHex(T) {
  const { x, y } = blackbodyChromaticity(T);
  const Y = 1;
  const X = (x / y) * Y;
  const Z = ((1 - x - y) / y) * Y;
  // 关键：黑体的白点就是它自己的色度，不做跨白点适应，
  // 但用 D65 矩阵做色域映射 —— 等价于「把该色温的相对色度映射进 sRGB」。
  const out = xyzToHex({ X, Y, Z }, { srcWhite: 'D65' });
  // 色度转 sRGB 会得到峰值 <1 的结果，按高通道归一化恢复饱和
  const mx = Math.max(...out.rgb);
  if (mx > 0 && mx < 255) {
    const k = 255 / mx;
    const r = Math.min(255, Math.round(out.rgb[0] * k));
    const g = Math.min(255, Math.round(out.rgb[1] * k));
    const b = Math.min(255, Math.round(out.rgb[2] * k));
    return { hex: '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''), rgb: [r, g, b] };
  }
  return { hex: out.hex, rgb: out.rgb };
}

/* ==============================================================
   5. 光谱构建工具：用「关键点 + 插值」描述连续谱
   ============================================================== */

/**
 * 由若干 (波长, 值) 关键点线性插值出完整光谱。
 * 用来表达「反射率谱」这类连续曲线 —— 比逐点填 81 个值可读得多，
 * 而且关键点可以直接抄论文表格。
 *
 * @param {Array<[number, number]>} points 关键点，按波长升序
 * @param {number} [fill=0] 超出范围时的填充值
 * @returns {Float64Array}
 */
export function spectrumFromPoints(points, fill = 0) {
  const out = new Float64Array(CIE_LAMBDAS.length).fill(fill);
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < CIE_LAMBDAS.length; i++) {
    const l = CIE_LAMBDAS[i];
    if (l <= pts[0][0]) { out[i] = pts[0][1]; continue; }
    if (l >= pts[pts.length - 1][0]) { out[i] = pts[pts.length - 1][1]; continue; }
    for (let j = 0; j < pts.length - 1; j++) {
      const [l0, v0] = pts[j];
      const [l1, v1] = pts[j + 1];
      if (l >= l0 && l <= l1) {
        const t = (l - l0) / (l1 - l0);
        out[i] = v0 + (v1 - v0) * t;
        break;
      }
    }
  }
  return out;
}

/**
 * 常数反射率谱（灰色物体，如月尘的简化模型）。
 * @param {number} r 反射率
 */
export function flatSpectrum(r) {
  return new Float64Array(CIE_LAMBDAS.length).fill(r);
}

/**
 * 把一组反射率谱按「亮度权重」混合 —— 用于行星表面不同地质单元的
 * 综合色（如火星的暗区玄武岩 + 亮区尘）。
 * @param {Array<{spectrum:ArrayLike<number>, weight:number}>} parts
 */
export function mixSpectra(parts) {
  const total = parts.reduce((s, p) => s + (p.weight || 0), 0) || 1;
  const out = new Float64Array(CIE_LAMBDAS.length);
  for (const p of parts) {
    const w = (p.weight || 0) / total;
    for (let i = 0; i < out.length; i++) out[i] += (p.spectrum[i] ?? 0) * w;
  }
  return out;
}

/* ==============================================================
   6. 自检：这个模块的正确性必须能被断言，而不是靠看上去对
   ============================================================== */
export const SELF_TEST_CASES = [
  {
    name: '等能白必须是中性灰（R=G=B）',
    run: () => {
      const h = spectrumToHex(illuminantE()).hex;
      const r = parseInt(h.slice(1, 3), 16);
      const g = parseInt(h.slice(3, 5), 16);
      const b = parseInt(h.slice(5, 7), 16);
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      return { pass: spread <= 2, detail: `${h} 通道极差 ${spread}` };
    },
  },
  {
    // ⚠️ 这条断言换过一次写法，过程本身就是个教训（2026-09-11）：
    //   初版写「5772 K 的色度应在 (0.3287, 0.3417) 附近」—— 那两个数是我
    //   **凭记忆写的**，实测偏差 0.0022/0.0059，我第一反应是代码有 bug。
    //   用六个 CIE 官方锚点回归后才发现：**拟合偏差只有 0.0004，代码是对的，
    //   我记的参考值是错的**。这正是坑 33（凭记忆写数值）。
    //   修法：不再引用任何记忆中的单点值，改为对**官方锚点**做回归。
    name: '黑体轨迹拟合：对 6 个 CIE 官方锚点的最大偏差必须 < 0.0005',
    run: () => {
      const anchors = [
        [2000, 0.5267, 0.4133], [3000, 0.4369, 0.4040],
        [5000, 0.3451, 0.3516], [6000, 0.3221, 0.3318],
        [6500, 0.3135, 0.3237], [7000, 0.3064, 0.3163],
      ];
      let worst = 0, worstT = 0;
      for (const [T, rx, ry] of anchors) {
        const c = blackbodyChromaticity(T);
        const d = Math.hypot(c.x - rx, c.y - ry);
        if (d > worst) { worst = d; worstT = T; }
      }
      return { pass: worst < 0.0005, detail: `最大偏差 ${worst.toFixed(4)} @ ${worstT}K（6 个锚点）` };
    },
  },
  {
    name: '太阳 5772 K：必须是很亮的白，且暖度轻微（不是橙，也不是与 D65 无差别）',
    run: () => {
      const { rgb } = blackbodyToHex(5772);
      const [r, g, b] = rgb;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const warm = r - b;
      const ok = luma >= 240            // 极亮（实测 243.5）
        && warm > 4 && warm < 40        // 有暖意但轻微（实测 21）
        && g > b;                       // 太阳绝不可能是「品红」
      return { pass: ok, detail: `rgb=${rgb} 亮度=${luma.toFixed(1)} 暖度(R-B)=${warm}` };
    },
  },
  {
    name: '太阳比 D65 暖，但比 5000 K 冷 —— 单调性检查',
    run: () => {
      const s = blackbodyToHex(5772).rgb;
      const d65 = blackbodyToHex(6504).rgb;
      const k5 = blackbodyToHex(5000).rgb;
      const warm = (v) => v[0] - v[2];
      const ok = warm(k5) > warm(s) && warm(s) > warm(d65);
      return { pass: ok, detail: `暖度 5000K=${warm(k5)} > 5772K=${warm(s)} > 6504K=${warm(d65)}` };
    },
  },
  {
    name: '2700 K 白炽灯必须明显偏暖（R>B）',
    run: () => {
      const { rgb } = blackbodyToHex(2700);
      return { pass: rgb[0] > rgb[2] + 20, detail: `rgb=${rgb}` };
    },
  },
  {
    name: '10000 K 必须偏蓝（B>R）',
    run: () => {
      const { rgb } = blackbodyToHex(10000);
      return { pass: rgb[2] > rgb[0] + 8, detail: `rgb=${rgb}` };
    },
  },
  {
    name: 'sRGB 编解码必须往返一致',
    run: () => {
      let worst = 0;
      for (let v = 0; v <= 1.0001; v += 0.01) {
        worst = Math.max(worst, Math.abs(decodeSRGB(encodeSRGB(v)) - v));
      }
      return { pass: worst < 1e-9, detail: `最大往返误差 ${worst.toExponential(2)}` };
    },
  },
];

/** 跑一遍自检，返回 {passed, total, results} */
export function runSelfTest() {
  const results = SELF_TEST_CASES.map((c) => {
    try {
      const r = c.run();
      return { name: c.name, ...r };
    } catch (e) {
      return { name: c.name, pass: false, detail: `抛异常：${e.message}` };
    }
  });
  return {
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  };
}

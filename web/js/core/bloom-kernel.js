/**
 * 泛光模糊链的「核整备」 —— ★ 本项目里**唯一**允许动泛光核的地方
 * =====================================================================
 *
 * ── 治的是什么病（坑 118）─────────────────────────────────────────────
 * 用户报的「太阳在上面是个大光球很难看」「银河系假爆了」，在渲染侧的
 * 一大部分是同一块**方斑**：太阳的光晕不是圆的，是**圆角方**。
 *
 * 根因在随包的 `three/addons/postprocessing/UnrealBloomPass.js:376-382`：
 *
 *     coefficients.push( 0.39894 * Math.exp( -0.5 * i * i / ( kernelRadius * kernelRadius ) ) / kernelRadius );
 *
 * 抽头落在 `x = 0, ±1, … ±(K−1)` 个 **texel** 上，权重是 **σ = K** 的高斯
 * **截断在 ±(K−1)**。σ 与截断深度同量级 ⇒ 高斯还没衰减就被砍断了。
 * 活页面读回来的实测（不是从源码抄的）：
 *
 *     级  K  最外抽/中心   σ_eff    截断深度
 *     0   3    0.801       1.359     1.47σ
 *     1   5    0.726       2.451     1.63σ
 *     2   7    0.693       3.534     1.70σ   ← 方斑来源
 *     3   9    0.674       4.616     1.73σ   ← 方斑来源
 *     4  11    0.662       5.696     1.76σ
 *
 * 最外那一抽还带着 66–80% 的权重 ⇒ **这不是高斯，是一块近似平的方框核**。
 * 而「可分离的方框核 ⊛ 一个点 = 轴对齐的正方形」——
 * 只有「核宽 ≈ 源宽」的那两级才显形，也就是 mip2 / mip3（已用**独热隔离**
 * 到像素级：mip0/1/4 全换纯方框，与只换 mip2/3 的像素差 2321，
 * 而噪声地板 2324 ⇒ 那三级在画面上**不起作用**）。
 *
 * ── 为什么是「保 σ、只加抽头数」这一条（坑 118 的第 26 轮结论）──────
 * 三条候选都实测过，只有这一条同时过两条线：
 *
 *   甲「把核磨陡」（截断深度 1.70σ → 3.40σ）
 *       形状过了（对角比落到圆律上），但光从大光晕被挪进紧核
 *       ⇒ 全屏均值 **−22%**，外接框 316→234。**赔本。**
 *   乙「真高斯、宽度配平」（σ = σ_eff）
 *       代价只有 −4.5%，但对角比 **1.046–1.066**，而两轮复现的抖动是 ±0.02
 *       ⇒ **贴线，不许当结论**。
 *   丙「σ 保持、抽头数加到 ⌈3σ_eff⌉+1」★
 *       mip2 K **7→12**、mip3 K **9→15** ⇒ 又宽又圆：
 *       外接框 314×312（只缩 1.3%）、面积占比 0.784、对角比 **0.991**，
 *       全屏均值 **−5.1%**（甲的四分之一）。**本模块就是它。**
 *
 * ── 代价与已知残余（如实写下来，别当没有）──────────────────────────
 * · **取样次数 +9.7%**（只占模糊链；实测每次泛光渲染 5,056,074 → 5,548,122 次）。
 *   性能已实测：泛光链只占一帧的 **0.8%（galaxy）/ 1.3%（solar）**，
 *   所以「Δ帧 ≤ 9.7% × 泛光链绝对耗时」的**结构性上界 = 一帧的 0.08% / 0.12%**；
 *   即便泛光链绝对读数低估 10 倍，上界也只有 1.25%，远低于「不赔本」的 5%。
 *   见 `tools/probe-bloom-kernel-perf.py`、日志 `shots/_bloom-kernel-perf.log`。
 * · **残余 −5.1% 全屏均值**：宽度配平后仍比出厂窄一点（出厂核的尾巴更重）。
 *   想补回来就得抬 σ，**那是调参** —— 先定判据再动，本轮不动。
 * · σ_eff 会**系统性偏低 0.6–0.9%**（截断在 3.03–3.11σ，砍掉的那段尾巴
 *   在 x² 加权里权重最大）：mip2 3.5342→3.5117、mip3 4.6157→4.5744。
 *   这与外接框读数（缩 1.3%）**独立吻合**，量级一致 ⇒ 不是偶然。
 *
 * ── 红线 ─────────────────────────────────────────────────────────────
 * ⚠️ **不要靠调 `radius` / `threshold` / `bloomFactors` 治方斑。**
 *    三条都量过：`radius` 0.60→0.15 只让外接框缩 44 px，方度纹丝不动。
 *    要治就治核本身 —— 也就是只在这个文件里治。
 * ⚠️ **`defines['KERNEL_RADIUS']` 是编译期常量**，shader 里写的是
 *    `uniform float gaussianCoefficients[KERNEL_RADIUS]`。
 *    改 define 必须**同时**给出**等长**的系数并 `needsUpdate = true`，
 *    否则数组越界读 —— 那种错不报异常，只是画面慢慢变得莫名其妙。
 * ⚠️ 本文件**不 import three**：核数学是纯函数，要在 Node 里能直接自证
 *    （`tools/probe-bloom-kernel-perf.py` 的离线自证段走的就是同一套公式）。
 */

/**
 * 截断深度：抽头数取到 `depth · σ`。
 *
 * 3.0 不是挑出来的：第 26 轮做过**剂量曲线**（1.70σ → 2.26σ → 3.00σ → 3.40σ），
 * 方度**单调**下降，到 3σ 时逐行宽度落在圆律上
 * （12.5/25/37.5% 处 0.658/0.863/0.966，圆律 0.661/0.871/0.971，最大偏差 0.008）。
 * 再往上加只是继续花取样次数，形状不再改善。
 */
export const TRUNCATION_DEPTH = 3.0;

/**
 * 要整定的级。
 *
 * **只动 mip2 / mip3**，理由是被测量出来的、不是估的：
 *   「核宽 ≈ 源宽」的级才显方 —— `box-all` 与 `box-23` 的像素差 2321，
 *   而噪声地板是 2324 ⇒ 另外三级的核在画面上**不起作用**，
 *   整定它们等于白花取样次数（`wide-all` 的取样量 +105.5%，形状收益是 0）。
 *
 * ⚠️ 这组下标是**绑定在出厂配置**（`nMips=5` · `kernelSizeArray=[3,5,7,9,11]`）上的。
 *    谁要是改了 `nMips` 或那一组 K，**必须重新做一次独热隔离**，不能照抄这里。
 *    所以 `retuneBloomKernel()` 会检查级数，对不上就**拒绝动手并说明**。
 */
export const RETUNE_MIPS = [2, 3];

/**
 * σ 的相对容差。
 *
 * 2% 相对差：丙的实测偏差是 0.64% / 0.90%（见文件头），留一倍余量；
 * 而「磨陡」那条路线的偏差是 25–50% ⇒ 容差比它紧 25 倍，
 * 不会把「换了口径」误当成「保住了 σ」。
 */
export const SIGMA_TOLERANCE = 0.02;

/**
 * 核的二阶矩等效 σ：`sqrt( Σ wᵢxᵢ² / Σ wᵢ )`，x = 抽头序号 = texel 距离。
 *
 * 为什么用二阶矩而不用名义 K：**名义 K 根本不是 σ** —— 出厂核的名义 σ 是 K
 * 但截断把它压小了一半（K=7 的 σ_eff 只有 3.53）。要「保住宽度」，
 * 保的必须是**实际展宽**。用二阶矩读，就不需要信任任何注释或常量。
 */
export function sigmaEff(coeffs) {
  if (!coeffs || coeffs.length === 0) return NaN;
  let s0 = coeffs[0];
  let s2 = 0;
  for (let i = 1; i < coeffs.length; i++) {
    s0 += 2 * coeffs[i];
    s2 += 2 * i * i * coeffs[i];
  }
  return Math.sqrt(s2 / s0);
}

/**
 * 抽头数：`K = ⌈depth · σ⌉ + 1`。
 *
 * `+1` 是**定义**不是保险：抽头序号是 `0 … K−1`，
 * 要覆盖到 `±depth·σ` 就得有 `⌈depth·σ⌉+1` 个下标。
 * 少 1 就正好把最外那一对砍掉 —— 而那正是「截断深度不够」本身。
 */
export function tapsFor(sigma, depth = TRUNCATION_DEPTH) {
  if (!Number.isFinite(sigma) || sigma <= 0) return NaN;
  return Math.ceil(depth * sigma) + 1;
}

/**
 * 与出厂**同一个构造式**，只把 σ 从 K 的位置解放出来：
 *
 *     出厂： 0.39894 · exp(−0.5 i²/K²) / K
 *     这里： 0.39894 · exp(−0.5 i²/σ²) / σ
 *
 * ⚠️ shader 里会现算 `weightSum` 再归一化，所以那个 `0.39894/σ` 常数因子
 *    在渲染上不起作用。**仍然照抄它的原因**是可读性与口径一致 ——
 *    万一哪天有人把 shader 的运行时归一化去掉，这里的行为要和出厂一样。
 */
export function gaussianCoefficients(K, sigma) {
  if (!Number.isInteger(K) || K < 1) throw new RangeError(`gaussianCoefficients: K 必须是正整数，收到 ${K}`);
  if (!Number.isFinite(sigma) || sigma <= 0) throw new RangeError(`gaussianCoefficients: σ 必须为正，收到 ${sigma}`);
  const out = new Array(K);
  for (let i = 0; i < K; i++) {
    out[i] = (0.39894 * Math.exp((-0.5 * i * i) / (sigma * sigma))) / sigma;
  }
  return out;
}

/** 出厂系数（σ 就取 K）—— 复位与 A/B 对照要用它 */
export function stockCoefficients(K) {
  if (!Number.isInteger(K) || K < 1) throw new RangeError(`stockCoefficients: K 必须是正整数，收到 ${K}`);
  const out = new Array(K);
  for (let i = 0; i < K; i++) {
    out[i] = (0.39894 * Math.exp((-0.5 * i * i) / (K * K))) / K;
  }
  return out;
}

/** 从材质上把（活页面里的）系数读出来 —— 不从源码抄 */
function readCoeffs(mat) {
  const v = mat?.uniforms?.gaussianCoefficients?.value;
  return v ? Array.from(v) : null;
}

function readK(mat) {
  const d = mat?.defines?.KERNEL_RADIUS;
  return Number.isFinite(d) ? d : null;
}

/**
 * 把 `bloomPass` 的核整定成「σ 取自出厂实际展宽、抽头数加到 depth·σ」。
 *
 * @param {object} bloomPass  `engine.bloomPass`（UnrealBloomPass）
 * @param {{depth?:number, levels?:number[]}} [opts]
 * @returns {{
 *   ok:boolean, why?:string, depth:number, levels:Array<object>, taps:{before:number, after:number},
 *   fetchCost:{before:number, after:number} | null,
 * }}
 *
 * 幂等：源 σ 只在**第一次**调用时从活材质上反解并记住（`bloomPass.__kernelSource`），
 * 之后再调也只从记住的值算 —— 否则第二次会把「已经加宽过的核」的 σ_eff
 * （比源低 0.6–0.9%）当成源，K 就会慢慢漂。**判据的输入必须钉住。**
 */
export function retuneBloomKernel(bloomPass, { depth = TRUNCATION_DEPTH, levels = RETUNE_MIPS } = {}) {
  const mats = bloomPass?.separableBlurMaterials;
  if (!Array.isArray(mats) || mats.length === 0) {
    return { ok: false, why: 'bloomPass.separableBlurMaterials 拿不到 —— 泛光通道还没构造完？', depth, levels: [] };
  }

  // ── 源 σ：第一次读活材质，之后用记下来的 ──
  if (!bloomPass.__kernelSource) {
    const sigma = mats.map((m) => sigmaEff(readCoeffs(m) || []));
    const K0 = mats.map((m) => readK(m));
    bloomPass.__kernelSource = { depth, sigma, K0 };
  }
  const src = bloomPass.__kernelSource;

  // ── 级数对不上就拒绝动手（RETUNE_MIPS 绑定在出厂配置上，见常量注释）──
  if (mats.length !== 5) {
    return {
      ok: false,
      why: `泛光级数是 ${mats.length}，本模块的下标 [${RETUNE_MIPS}] 是按出厂 5 级`
        + `（kernelSizeArray=[3,5,7,9,11]）的**独热隔离结果**定的。改了级数必须重做隔离，不能照抄。`,
      depth, levels: [],
    };
  }

  const report = [];
  let tapsBefore = 0;
  let tapsAfter = 0;
  for (const i of levels) {
    const m = mats[i];
    if (!m) { report.push({ i, err: '没有这一级' }); continue; }
    const sigma = src.sigma[i];
    if (!Number.isFinite(sigma) || sigma <= 0) { report.push({ i, err: `σ_eff 读不出来（${sigma}）` }); continue; }

    const K0 = readK(m);
    const K = tapsFor(sigma, depth);
    if (!Number.isInteger(K) || K < 1) { report.push({ i, err: `K 算不出来（${K}）` }); continue; }

    // 等长：shader 的数组长度是编译期常量，长度不符 = 越界读（不报异常）
    const coeffs = gaussianCoefficients(K, sigma);
    if (coeffs.length !== K) { report.push({ i, err: `系数长度 ${coeffs.length} != K ${K}` }); continue; }

    if (K0 !== K) {
      m.defines['KERNEL_RADIUS'] = K;
      m.needsUpdate = true;          // define 变了必须重编译，否则 uniform 布局还是旧的
    }
    m.uniforms.gaussianCoefficients.value = coeffs;

    const dSigma = Math.abs(sigmaEff(coeffs) - sigma) / sigma;
    report.push({
      i, K0, K, sigma: +sigma.toFixed(4),
      sigmaAfter: +sigmaEff(coeffs).toFixed(4),
      dSigma: +dSigma.toFixed(5),
      truncation: +(K - 1) / sigma,       // 实际截断深度（应 ≥ depth）
      withinTolerance: dSigma <= SIGMA_TOLERANCE,
      untouched: K0 === K,                // 该级本来就不用改（K 相同）
    });
    if (Number.isFinite(K0)) tapsBefore += 2 * K0 - 1;
    tapsAfter += 2 * K - 1;
  }

  const out = {
    ok: report.every((r) => !r.err),
    depth, levels: report,
    taps: { before: tapsBefore, after: tapsAfter },
    fetchCost: null,   // 与具体 RT 尺寸有关，由探针拿 renderTargetsVertical 现场算
  };
  bloomPass.__kernelReport = out;
  return out;
}

/**
 * 复位成出厂核（σ = K）。
 *
 * 存在的理由有两条，都很实际：
 *   ① **A/B 对照要能一键做** —— 探针必须能在同一个进程里切回出厂，
 *      否则「丙 vs 出厂」就得跨进程比，那是两套环境；
 *   ② 万一丙在某个场景里不好看，**一行就能退回去**，不用改代码再刷新。
 */
export function restoreStockKernel(bloomPass) {
  const mats = bloomPass?.separableBlurMaterials;
  if (!Array.isArray(mats) || mats.length === 0) return { ok: false, why: '拿不到 separableBlurMaterials' };
  const src = bloomPass.__kernelSource;
  const K0s = src?.K0 || mats.map((m) => readK(m));
  const done = [];
  for (let i = 0; i < mats.length; i++) {
    const K0 = K0s[i];
    if (!Number.isInteger(K0)) { done.push({ i, err: '出厂 K 不知道' }); continue; }
    const m = mats[i];
    if (readK(m) !== K0) { m.defines['KERNEL_RADIUS'] = K0; m.needsUpdate = true; }
    m.uniforms.gaussianCoefficients.value = stockCoefficients(K0);
    done.push({ i, K: K0, sigma: +sigmaEff(stockCoefficients(K0)).toFixed(4) });
  }
  bloomPass.__kernelReport = { ok: true, depth: src?.depth ?? null, levels: done, restored: true };
  return bloomPass.__kernelReport;
}

/**
 * 给探针 / 自检读的实况 —— **读活材质，不读记忆**。
 * 记忆（`__kernelSource`）只用来算「改了没有」，实况必须以材质为准。
 */
export function bloomKernelReport(bloomPass) {
  const mats = bloomPass?.separableBlurMaterials;
  if (!Array.isArray(mats)) return { ok: false, why: '拿不到 separableBlurMaterials' };
  const src = bloomPass.__kernelSource;
  return {
    ok: true,
    depth: src?.depth ?? null,
    levels: mats.map((m, i) => {
      const coeffs = readCoeffs(m) || [];
      return {
        i,
        K: readK(m),
        K0: src?.K0?.[i] ?? null,
        len: coeffs.length,
        sigmaEff: +sigmaEff(coeffs).toFixed(4),
        sigmaSource: src?.sigma?.[i] != null ? +src.sigma[i].toFixed(4) : null,
        edgeToCenter: coeffs.length > 1 ? +(coeffs[coeffs.length - 1] / coeffs[0]).toFixed(4) : null,
        // 一致性：define 说的 K、系数数组长度、都要对得上（长度不符 = 越界读）
        consistent: readK(m) === coeffs.length,
      };
    }),
  };
}

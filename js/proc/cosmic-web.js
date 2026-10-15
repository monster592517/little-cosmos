/**
 * 宇宙网密度场（可观测宇宙层的「大尺度结构」底噪）
 *
 * ## 为什么单独一个文件
 * 这个场既要在页面上跑，又要在**离线**工具里被量（见 `tools/probe-cosmos-web.mjs`）。
 * 如果两边各写一份参数，就会出现「工具量的是 A、页面画的是 B」——
 * 本项目已经吃过同类亏（坑 131：同一个不变式两份实现、其中一份漏了改动，
 * 评审时两份代码各自看都很正常）。所以**场只有这一份**，工具 import 它。
 *
 * ## 两条硬约束（都是量出来的，不是调出来的）
 *
 * ### ① 统计同质性 —— 最大尺度必须远小于取样半径
 * 原来用 `fbm3(x*0.062, …)`：value noise 的格距 = 1/0.062 ≈ **16 Gly**，
 * 而取样球半径 40 Gly ⇒ 球里只装得下 2.5 个基频格。
 * 后果是**每单位体积的点数随半径剧烈起伏**（实测：最内层 333×10⁻³、
 * 16–18 Gly 处 8.7×10⁻³，相差 38 倍）—— 这违反宇宙学原理
 * （大尺度上应当统计均匀），画面上表现为「中间空、外圈糊」。
 * ⇒ 基频要取到让最大尺度 ≈ 0.2 R 左右；具体值由工具的实测量选定。
 *
 * ### ② 空洞体积占比要有出处，不能靠「看着顺眼」
 * 阈值**不写死**，由已知的定量特征反解：把「空洞」定义为场值低于阈值，
 * 则阈值处对应的**体积占比**就是空洞占比。取 Cautun et al. 2014
 * (NEXUS/MMF, MNRAS 441, 2923) 在 z=0 的测定：**空洞占体积 77%**
 * （同源的 GIMIC 给的是 63.7%，两者口径不同，本文件取 77%）。
 * 实现方式是**分位数反解**：先实测场值的经验分布，取 23% 分位当阈值 ——
 * 这样阈值以下**恰好**是 77% 的体积，不依赖「场是正态的」这个假设。
 *
 * ### ③ 阈值以上按密度分级采样
 * 过了阈值就等概率撒点的话，纤维会变成一层「壳」。所以阈值以上
 * 再按 `(v − t) / (v_node − t)` 的概率保留 —— 纤维内部也有疏密，
 * 最后落到节点（最高的约 2.3% 体积）才是满采样。
 */
import { fbm3, mulberry } from './textures.js';

/** 本层长度单位 = 1 Gly，所以这些数就是「十亿光年」 */
export const WEB_CONFIG = {
  /** 取样球半径。宇宙微波背景边界在 45.2 ⇒ 结构要一直铺到边界，
   *  原来写 40，留下 5.2 Gly 的空档（实测：41.4–46 Gly 的壳层里 0 个点）。 */
  radius: 44,
  /** 基频。格距 = 1/freq（Gly）。
   *  取值由同质性判据选定（见文件头 ① 与 `tools/probe-cosmos-web.mjs --sweep`）：
   *    freq 0.062（旧值）⇒ 格距 16.13 Gly ⇒ 各壳层接受率 max/min = 54.9 倍（不合格）
   *    freq 0.200        ⇒ 格距  5.00 Gly ⇒ 11.1 倍
   *    freq 0.400（现值）⇒ 格距  2.50 Gly ⇒ **3.65 倍**（合格线 ≤4）
   *  同时 2.50 Gly 这个最大尺度本身也落在真实结构的量程里：
   *  超星系团 0.1–0.65 Gly、宇宙长城 1–10 Gly、最细一层 0.31 Gly ⇒ 覆盖 0.31–2.5 Gly。
   *  ⚠️ 不追求 max/min → 1：真实宇宙在大尺度上**本来就**不均匀
   *     （KBC 空洞跨约 2 Gly，我们正住在里面），一条完全平直的密度线才是不真实的。 */
  freq: 0.40,
  octaves: 3,
  seed: 7,
  /** 细结构层的频率 / 基频之比。
   *  ⚠️ **必须跟着基频一起缩放**。原来的写法是两层频率各自写死（0.062 与 0.19），
   *     于是扫基频的时候细层留在原地 —— 基频扫到 0.63 时细层（0.28）反而更「粗」，
   *     两层的主次颠倒，量出来的同质性**非单调**（0.40 处突然变好、0.63 又变差）。
   *     那是参数耦合造成的假极值，不是场本身的性质。 */
  edgeRatio: 2.6,
  edgeWeight: 0.22,
  /** 空洞体积占比（Cautun+2014, z=0） */
  voidFraction: 0.77,
  /** 节点体积占比（同上：节点约 6%，本文件取更严的 2.3% 当「满采样区」） */
  nodeFraction: 0.023,
  /** 标定用的确定性样本数 */
  calibSamples: 8192,
  /** 同质性判据：分几个壳层量、每层多少样本 */
  shells: 20,
  shellSamples: 4000,
};

/** 球内均匀取点（用给定的 PRNG，返回值数组）。 */
function sampleInBall(rnd, R) {
  let x, y, z, d;
  do {
    x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1;
    d = Math.sqrt(x * x + y * y + z * z);
  } while (d > 1);
  return [x * R, y * R, z * R];
}

/** 场值：把主频与细结构按权重合成，归一化到 ≈[0,1]（与原实现同口径）。 */
function fieldAt(b, x, y, z) {
  const ef = b.freq * b.edgeRatio;
  const a = fbm3(x * b.freq, y * b.freq, z * b.freq, b.octaves, b.seed);
  const e = fbm3(x * ef, y * ef, z * ef, b.octaves, b.seed + 14);
  return a * (1 - b.edgeWeight) + e * b.edgeWeight;
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1,
  Math.max(0, Math.floor(p * sorted.length)))];

/** 在给定半径壳层内均匀取一点（半径 pdf ∝ r²，否则会往内圈堆） */
function sampleInShell(rnd, r1, r2) {
  const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  const r = Math.cbrt(r1 ** 3 + rnd() * (r2 ** 3 - r1 ** 3));
  return [Math.cos(th) * s * r, u * r, Math.sin(th) * s * r];
}

/**
 * 标定：实测场值的经验分布，反解出阈值与节点线。
 *
 * ⚠️ 标定用的是**独立**的 PRNG（seed 派生），不消耗主循环的随机流 ——
 *    否则「改一下样本数」就会把整片点云重排，画面变了却找不到原因。
 *
 * ⚠️ **同质性必须用「各壳层的接受率」来量，不能用「各壳层的点数」。**
 *    数点数是错的：内层体积本来就小，点少是应该的；反过来，
 *    某一层少几个点就会被算成「密度低 38 倍」—— 那是**散粒噪声**，不是场的问题。
 *    接受率是按**体积**归一的量，且每层都用同样多的样本 ⇒ 噪声地板固定，
 *    场是不是均匀一眼可辨。本项目在别处吃过「数对象 vs 数计数」的亏（坑 84 一带）。
 */
export function calibrateWeb(b = WEB_CONFIG) {
  const rnd = mulberry(b.seed * 7919 + 13);
  const vals = new Array(b.calibSamples);
  for (let i = 0; i < b.calibSamples; i++) {
    const [x, y, z] = sampleInBall(rnd, b.radius);
    vals[i] = fieldAt(b, x, y, z);
  }
  const sorted = vals.slice().sort((p, q) => p - q);
  /* ⚠️ 分位数的方向踩过一次：`voidFraction` 是**空洞**占的体积比（0.77），
   *    所以阈值要取 **77% 分位**（77% 的样本低于它）；写成 `1 - 0.77` 会得到
   *    23% 分位 ⇒ 77% 的体积在阈值以上 ⇒ 接受率 33% 而不是 11%，
   *    而且**不会报错**，只是画面糊成一片。 */
  const t = quantile(sorted, b.voidFraction);
  const node = quantile(sorted, 1 - b.nodeFraction);    // 2.3% 分位 ⇒ 节点
  let mean = 0;
  for (const v of vals) mean += v;
  mean /= vals.length;
  let sd = 0;
  for (const v of vals) sd += (v - mean) * (v - mean);
  sd = Math.sqrt(sd / vals.length);

  // 逐壳层接受率（每层固定样本数 ⇒ 噪声地板恒定）
  const NB = b.shells;
  const K = b.shellSamples;
  const span = Math.max(1e-6, node - t);
  const shellAccept = [];
  for (let k = 0; k < NB; k++) {
    const r1 = (k / NB) * b.radius, r2 = ((k + 1) / NB) * b.radius;
    let acc = 0;
    for (let i = 0; i < K; i++) {
      const [x, y, z] = sampleInShell(rnd, r1, r2);
      const v = fieldAt(b, x, y, z);
      if (v < t) continue;
      acc += v >= node ? 1 : (v - t) / span;
    }
    shellAccept.push(acc / K);
  }
  const inner = shellAccept.slice(0, NB - 1);           // 最外一层是半球壳，特征不同，排除
  const nz = inner.filter((d) => d > 0);
  /* 阈值分位是「反解」出来的 ⇒ 要有一次**回读**证明它真的落在 77% 上。
   * 只写不读的标定等于没标定（本项目的老毛病）。 */
  let below = 0;
  for (const v of vals) if (v < t) below++;
  return {
    threshold: t, nodeLine: node, mean, sd, shellAccept,
    voidMeasured: below / vals.length,
    spread: nz.length ? Math.max(...nz) / Math.min(...nz) : null,
  };
}

/** 标定结果按参数缓存 —— 同一份参数只标一次 */
const calibCache = new Map();
export function webCalibration(b = WEB_CONFIG) {
  /* ⚠️ 缓存键必须**逐个列出所有会改变结果的参数**，一个都不能漏。
   *    这里原来写的是 `b.edgeFreq` —— 而 `edgeFreq` 在引入 `edgeRatio`
   *    那次重构里已经没了（见 WEB_CONFIG 里那段说明），于是这个键里
   *    永远是字面量 `undefined`。后果：**两份只在 `edgeRatio` 上不同的参数
   *    会命中同一条缓存**，第二份拿到的还是第一份的标定值 ——
   *    阈值/节点线/接受率全是别人的，而且**不报错**。
   *    这正是本项目反复吃亏的那一类：判据（这里是缓存）自己算错了方向，
   *    比判据不响更坏。改参数的人会看到「扫了一整轮没变化」，然后去怀疑场。
   *    同类教训见坑 131（同一个不变式两份实现）与坑 129（标尺钉了活值）。 */
  const key = `${b.radius}|${b.freq}|${b.octaves}|${b.seed}|${b.edgeRatio}|${b.edgeWeight}`
    + `|${b.voidFraction}|${b.nodeFraction}|${b.shells}|${b.shellSamples}|${b.calibSamples}`;
  if (!calibCache.has(key)) calibCache.set(key, calibrateWeb(b));
  return calibCache.get(key);
}

/**
 * 生成宇宙网点云。
 *
 * @param {number} wanted 期望点数（真能拿到的数量由接受率决定）
 * @param {object} b     场参数（默认 WEB_CONFIG）
 * @returns {{pos:number[], col:number[], stats:object}} pos/col 是扁平数组；
 *          stats 里有「用掉了多少候选 / 接受率 / 每单位体积密度」等实测量，
 *          供离线工具与自检复算 —— **页面和工具拿到的是同一批数字**。
 */
export function buildCosmicWeb(wanted = 40000, b = WEB_CONFIG) {
  const cal = webCalibration(b);
  const span = Math.max(1e-6, cal.nodeLine - cal.threshold);
  const rnd = mulberry(b.seed);
  const maxCand = Math.max(2000, wanted * 30);
  const pos = [];
  const col = [];
  let cand = 0;
  while (pos.length / 3 < wanted && cand < maxCand) {
    cand++;
    const [x, y, z] = sampleInBall(rnd, b.radius);
    const v = fieldAt(b, x, y, z);
    if (v < cal.threshold) continue;                       // 空洞：不撒点
    const p = v >= cal.nodeLine ? 1 : (v - cal.threshold) / span;
    if (rnd() > p) continue;
    pos.push(x, y, z);
    /* 颜色 = 密度分级的**曝光**，不是物理量：节点（最高 2.3% 体积）暖黄，
     * 纤维 / 片状冷蓝。色相沿用原口径（节点 0.11 / 纤维 0.58）。
     *
     * ⚠️ 关键在**亮度差**，这一点原来做错了：旧式的 l 分别是
     *    节点 0.60、纤维 0.46–0.62 —— **两档几乎一样亮**。
     *    于是「按密度分级采样」这件事在画面上被完全抹平：
     *    三维体积投影到一屏二维画面时，亮的节点与暗的纤维不可区分，
     *    70k 个点读成一片**均匀的星点**——恰好复现了本层刚删掉的那个
     *    语义错的恒星场的观感（实拍 `shots/_uvc-universe-a.png`）。
     *
     * ⚠️ 但**压过头也会坏**，而且坏得看不出来：第一版把纤维压到 0.22–0.34，
     *    单项隔离实测「只留宇宙网」的屏均值只有 **3.157/255**，而「几何全藏」
     *    是 2.929/255 ⇒ 这 70k 个点的**净贡献只有 0.23/255**，等于没画。
     *    ⇒ 现在的取值要求**同时**满足两条：
     *      ① 节点 / 纤维的亮度比 ≥ 2×（结构要显形）；
     *      ② 单项隔离的净贡献 ≥ 1.0/255（要看得见）。
     *    判据与读数都在 `tools/probe-universe-perf.py`（第 ④ 节），
     *    **不是靠看着顺眼定的**。 */
    const u = Math.min(1, Math.max(0, (v - cal.threshold) / span));
    const warm = v >= cal.nodeLine;
    col.push(...hsl(warm ? 0.11 : 0.58,
      warm ? 0.55 : 0.34 + u * 0.20,
      warm ? 0.80 : 0.34 + u * 0.18));
  }
  return {
    pos, col,
    stats: {
      wanted, candidates: cand, accepted: pos.length / 3,
      acceptRate: cand ? (pos.length / 3) / cand : 0,
      threshold: cal.threshold, nodeLine: cal.nodeLine,
      fieldMean: cal.mean, fieldSd: cal.sd,
      /* 同质性用**逐壳层接受率**表达（见 calibrateWeb 的说明）：
       * 每层按体积归一、样本数相同 ⇒ 场均匀时这条线是平的。 */
      shellAccept: cal.shellAccept, spread: cal.spread,
      /* 空洞体积占比的**回读值**（标定目标见 WEB_CONFIG.voidFraction） */
      voidMeasured: cal.voidMeasured, voidTarget: b.voidFraction,
      radius: b.radius, freq: b.freq, gridGly: 1 / b.freq,
    },
  };
}

/* HSL → [r,g,b]（0–1）。就地写，避免为一个颜色引入 THREE 依赖，
 * 这样 Node 侧（离线工具）也能直接 import 本文件。 */
function hsl(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

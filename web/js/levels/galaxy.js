/**
 * 层级 · 银河系（单位：1 = 1 千光年）
 *  外部视角的棒旋星系：指数盘 + 4 条对数螺旋臂 + 核球 + 银晕球状星团。
 *  参数取自 Gaia DR3 与 GRAVITY 对银心距离的测定（26.7 千光年）。
 */
import * as THREE from 'three';
import { Level } from '../core/engine.js';
import { makeSprite, makeGalaxySprite, makeStarfield, spiralArmPoints } from '../objects/builders.js';
import { makeGlowTexture, makeStarTexture, makeMilkyWayDiskTexture, mulberry, starColorFromBV,
  MW_R, MW_SUN_R, MW_BAR_HALF, MW_BAR_ANG, MW_BAR_AZ, KPC2KLY, MW_ARMS, armPoint,
  armTForArea } from '../proc/textures.js';
import { equatorialToGalactic } from '../data/attrs.js';

/* 银河系结构参数 —— **唯一权威在 `proc/textures.js`**，这里只做别名。
 *
 * 为什么不在这里自己存一份：同一套参数还要用来画那张铺满银盘的**盘面贴图**
 * （`makeMilkyWayDiskTexture`）。两边各留一份副本 ⇒ 迟早漂开 ⇒
 * 贴图画的臂和粒子撒的臂交叉成网，就是用户说的「四不像」。
 *   R_GAL    = 52.8 kly（D25 直径 87.4 kly ⇒ 半径 43.7；盘无锐边，
 *                         ESO 取「星盘半径约 50 kly」，52.8 含外缘）
 *   SUN_R    = 26.7 kly（26.8 ± 0.5 kly / 8.3 kpc）
 *   BAR_HALF = 10 kly，BAR_ANG = 44°±10°，b = tan(12°) ≈ 0.21266
 * ⚠️ 别再在本文件里写第二套螺旋公式或常量（坑 97：曾经两处一起把 cot 当成了 tan）。 */
const R_GAL = MW_R, SUN_R = MW_SUN_R, BAR_HALF = MW_BAR_HALF, BAR_ANG = MW_BAR_ANG;
/** 旋臂权重之和（`MW_ARMS[i].w` 的总和），撒点时用它归一抽签。 */
const ARM_W_SUM = MW_ARMS.reduce((s, a) => s + a.w, 0);

/* =========================================================================
 * 银河系「结构特征」的锚点（单位 kly）—— **唯一一份**
 * -------------------------------------------------------------------------
 * ⚠️ 2026-09-11 第 21 轮：这批坐标原来在本文件里被**抄了三份** ——
 *    ① 标签位置（`#addFeatureLabels`）② 点击拾取（`pick`）③ 飞入视角（`viewFor`）。
 *    三份立刻就不一致，而且是**同时生效的**：标签那份把 5 个标签压在银核上
 *    （r < 16 kly，141 千光年视角下只有约 70 px），另外两份还在用同一批内圈坐标。
 *    **改一处、漏两处 = 你点到的和你看到的不是一个地方。**
 *
 * 规则：**能由几何算出来的就不要手写。** 4 条主臂的位置一律走 `armPoint()`；
 * 只有本模型里没有几何的特征（银心 / 银晕 / 麦哲伦流 / 猎户臂）才用手写字面量，
 * 并且必须显式列在这里 —— 没列出来的返回 `null`，调用方自己决定怎么处理，
 * **不要用 `[0,0,0]` 兜底**（那会把「没定义」画成「就在银心」）。
 * ========================================================================= */
const FEATURE_FALLBACK_KLY = {
  'sgr-a': [0, 0, 0],              // 银心就是原点，这条是**定义**不是兜底
  'orion-arm': [0, 0, MW_SUN_R],   // 猎户臂 = 太阳所在处（它不是 MW_ARMS 里的 4 条主臂）
  halo: [0, 26, 0],                // 银晕：抬到盘面上方，否则和银心标签叠在一起
  /* 矩尺臂：本模型的 4 条主臂里没有它（我们只画了 Reid 2019 的四条主臂），
   * 但它是**真实存在**的、而且资料面板里有它，不留锚点等于把它从界面上删掉。
   * 半径取 Reid 2019 的锚定半径 Rk = 4.46 kpc = **14.5 kly**（观测值）；
   * ⚠️ **方位角 90° 是构造值** —— 把 Reid 的 β 口径换算到本场景的方位角还没做，
   *    所以先摆在一条明确的方位上并在此声明，而不是假装它精确。 */
  'norma-arm': [0, 0, 14.5],
  'magellanic-stream': [0, -12, 96],
};
/** 特征 id（去掉 `-arm`）→ `MW_ARMS` 里那条臂。 */
const ARM_BY_KEY = new Map(MW_ARMS.map((a) => [a.name.toLowerCase().split('-')[0], a]));
/** 结构标签与银心的最小水平距离（kly）—— 防止任何标签再压到核球上。
 *  取 15：核球（棒半长 10 kly）在默认视角下约 33 px，15 kly 约 50 px，够离开它；
 *  同时矩尺臂的**实测** 14.5 kly 不会被这条下限顶掉。 */
const LABEL_R_MIN = 15;

/**
 * 取某个结构特征在场景中的锚点（kly）。**标签 / 拾取 / 视角三处共用这一个。**
 * @param {string} id 特征 id，带不带 `mw-` 前缀都行
 * @returns {THREE.Vector3|null} 未定义的特征返回 null
 */
function mwFeaturePoint(id) {
  const key = String(id).replace(/^mw-/, '');
  const arm = ARM_BY_KEY.get(key.replace(/-arm$/, ''));
  if (arm) {
    // 沿臂取中段，径向外推 8% —— 让标签**贴着臂但离开银核**。
    // ⚠️ `t` 逐臂错开：倾角相近的两条臂在同一个 t 上会给出**同一个半径**
    //    （r 只取决于 t·φ·tanψ = ln(R/R0)·t），标签就又挤成一堆。
    //    这是**构造值**（只为排版），所以要写明。
    const p = armPoint(arm, 0.34 + 0.16 * MW_ARMS.indexOf(arm));
    const rr = p.r * 1.08;
    return new THREE.Vector3(Math.cos(p.a) * rr, 0, Math.sin(p.a) * rr);
  }
  const fb = FEATURE_FALLBACK_KLY[key];
  if (!fb) return null;
  const v = new THREE.Vector3(fb[0], fb[1], fb[2]);
  const rxz = Math.hypot(v.x, v.z);
  if (rxz > 0 && rxz < LABEL_R_MIN) {          // 沿原方位推离银心（方向不变，只改半径）
    const k = LABEL_R_MIN / rxz;
    v.set(v.x * k, v.y, v.z * k);
  }
  return v;
}

/** 银河系内深空天体的示意配色 */
const DEEP_COLOR = {
  globular: '#ffe8c0', opencluster: '#bcd8ff', nebula: '#ff9ec5',
  planetarynebula: '#8fd3e8', snr: '#ffb8a8', doublestar: '#dce8ff', star: '#dce8ff',
  // 致密天体。⚠️ 这些是**标记色，不是天文真彩** ——
  //   黑洞本身不发光（真彩是「什么都没有」），脉冲星/白矮星的可见光也极弱。
  //   这里给的是「让人一眼分辨类型」的符号色，与太阳系里那套 CIE 真彩不是一回事。
  bh: '#e879f9', blackhole: '#e879f9',
  psr: '#a5f3fc', wd: '#e8f4ff', whitedwarf: '#e8f4ff',
};

/** 「致密天体」的 type 集合 —— 它们多数没有视星等，不能按 mag 过滤 */
const COMPACT_TYPES = new Set(['bh', 'blackhole', 'psr', 'wd', 'whitedwarf']);

// 赤道 J2000 → 银道的旋转矩阵**只有一处定义**，在 `data/attrs.js`。
// 这里原来自己抄了一份等价实现 —— 两份都「对」的时候看不出来，
// 一旦有人改了其中一份的符号，本层与面板的银心距就会给出互相矛盾的位置。

export class GalaxyLevel extends Level {
  constructor(ctx, dataset) {
    super(ctx);
    this.id = 'galaxy';
    this.name = '银河系';
    this.subtitle = '外部视角 · 旋臂 · 银心';
    this.dataset = dataset;
    /* ⚠️ 银河系层的标签纪律（2026-09-11 第 21 轮补上）：
     * 这一层的深空天体**最多 600 个**，每个都建了标签。原来一个 `maxDist` 都没给，
     * ⇒ 默认视角下 40 多个 NGC/PSR 编号叠在银核上，**把星系本身埋了**。
     * `solar.js` 早就做对了（小天体 `maxDist: 6 / 12`，注释「避免全景图堆满文字」），
     * 这里是漏做。现在两层保险：
     *   ① 每个深空标签带分级 `maxDist`（见 #addDeepSkyObjects）—— 控制**什么时候**出现；
     *   ② `maxLabels` 硬上限 —— 控制**一次最多几个**。
     * 默认视角相机在 `[0,78,118]` ⇒ 距银心 ≈141 千光年，下面是按这个数配的。 */
    this.labelOptions = { maxDistance: 900, maxLabels: 20, gapX: 62, gapY: 19 };
    this.controlsConfig = { minDistance: 0.08, maxDistance: 900, rotateSpeed: 0.5, zoomSpeed: 1.05, panSpeed: 0.6 };
    /** 从本星系群拉近进来时落在太阳系位置；往回拉远也从这里走 */
    this.enterFocus = 'mw-sun';
    this.exitFocus = null;
    /** 主点云的四个群体对象（build() 里填），`update()` 每帧转它们 */
    this.diskParts = [];
  }

  build() {
    const { scene, camera } = this;
    // 重建时（例如换了 GPU）要重新放一遍真实恒星与深空天体
    this.realStars = null;
    this.deepGroup = null;
    camera.near = 0.02;
    camera.far = 20000;
    camera.updateProjectionMatrix();
    // ⚠️ 灯也要有名字。第 23 轮实测：探针的场景清单里冒出
    //    `[ 0] (无名) AmbientLight` —— 同一个「幽灵对象」的坑换了个类型又来一遍，
    //    因为我下面那条自查只查 Points/Mesh/Sprite，**灯光被静默漏掉**。
    //    （名字在哪儿给：就在创建它的这一行。）
    const ambient = new THREE.AmbientLight(0xffffff, 1.1);
    ambient.name = 'mw-ambient';
    scene.add(ambient);

    const starfield = makeStarfield({ count: Math.round(5000 * this.fieldScale), radius: 6000, innerRadius: 0.7, size: 22, seed: 71 });
    starfield.name = 'mw-starfield';
    scene.add(starfield);

    /* --- 星系盘粒子 ---
     *
     * ⚠️ 原来是「核球 + 旋臂」两层，没有**弥散盘**。后果用户一眼就看出来了：
     *    「银河系有一个庞大的盘，你这个就是几条曲线」。
     *    原因在旧代码这一行：`theta = spiral + scatter`，scatter 只有 0.1~0.16 弧度 ——
     *    **84% 的点全被强制贴到 4 条旋臂上，臂间完全是空的**，于是只剩几条丝带。
     *
     *    真实的银河系，旋臂只是**密度波增强区**；盘面上到处都有星，臂间也有，只是更暗。
     *    所以分三层撒点：核球(16%) / 旋臂(44%) / **弥散盘(40%)**。
     *    弥散盘的 θ 均匀随机、r 走指数盘分布、颜色更暗更暖 —— 它负责「庞大的盘」，
     *    旋臂负责「结构」，两者叠起来才像星系。
     */
    const rnd = mulberry(20240601);
    // 盘点数：210k 时实测帧时间中位 14.4ms、p95 17.7ms（**已经越过 16.7ms = 60fps 那条线**），
    // 回落到 180k。「盘」的连续感现在主要靠下面那层圆盘底光撑着，盘点数不再那么敏感。
    //
    // ⚠️ 2026-09-11 第 23 轮：**180k → 160k**。删掉的正是那个重复核球的 11%，
    //    其余三个群体的**绝对点数按比例保持不变**（棒 16.0k / 臂 54.4k / 盘 89.6k，
    //    与原来 16.2k / 54.0k / 90.0k 对齐）——
    //    第一版我把腾出来的 11% 直接并给了弥散盘，**这是错的**：
    //    探针立刻回报核区饱和占比 52.6% → 67.2%，盘多出来的点照样往中心堆。
    //    「删掉一个群体的份额」就该是「总预算下降」，不该变成「别的群体偷偷长胖」。
    const N = this.budget(160000);
    /* ⚠️ 2026-09-11 第 23 轮：**四个群体各成一个 Points 对象**，不再挤在一个里。
     *
     * 为什么必须拆：中央那团糊掉的白斑一开始只能靠「读代码猜是核球」——
     * 因为探针的消融表一次只能隐藏一个**顶层对象**，四合一 ⇒ 归属不可测。
     * 拆开之后 `③c 核区归属` 才能把「谁把中心烧白」变成一行数字
     * （坑 86：瓶颈要测不要猜；本项目的第 N 次「先让故障可测」）。
     * 代价是 4 个 draw call，同材质同规模，相对 180k 点是噪声。 */
    const POP_KEYS = ['mw-points-bar', 'mw-points-arm', 'mw-points-disk'];
    const pop = {};
    for (const k of POP_KEYS) pop[k] = { pos: [], col: [] };
    const c = new THREE.Color();
    const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 0.7071;

    /* ★ 弥散盘的**径向律**：指数盘 I(r) ∝ exp(−r/h)，h = 2.6 kpc = 8.5 kly。
     *
     * ⚠️ 2026-09-12 第 33 轮换掉了 `r = R_GAL * pow(rnd(), 1.35)`：
     *    那个幂律**不是任何一个测出来的量**（1.35 是当年调出来的），
     *    实测后果是**外盘点数偏多** —— 于是整个盘看起来像一碗均匀的沙，
     *    而真实银盘的光 90% 集中在 2~3 个标长以内。
     *    换法本身也有出处：银盘的表面亮度剖面是**指数律**（这是外盘测光里拟合得最稳的一条），
     *    所以直接对它做**逆变换采样**，投影出来的剖面按构造就是指数盘，
     *    不依赖「撒得够多自然就像了」。
     *    h 的取值：Bland-Hawthorn & Gerhard 2016 汇总给 2.5~2.6 kpc（本文件 `H_KLY` 同值）。
     *    形参用的是 `R_GAL`（不是 h）——与 `armTForArea` 一样按**面积**取样（环带权重 2πr·I(r)），
     *    所以 r 的分布是 r·exp(−r/h) 而不是 exp(−r/h)。 */
    const DISC_H = 8.5;                       // kly
    const DISC_CDF = (() => {
      const M = 512;
      const rr = new Float64Array(M + 1), cc = new Float64Array(M + 1);
      let acc = 0;
      for (let k = 0; k <= M; k++) {
        rr[k] = k / M * R_GAL;
        if (k > 0) {
          const mid = 0.5 * (rr[k - 1] + rr[k]);
          acc += 2 * Math.PI * mid * Math.exp(-mid / DISC_H) * (rr[k] - rr[k - 1]);
        }
        cc[k] = acc;
      }
      for (let k = 0; k <= M; k++) cc[k] /= acc;
      return { rr, cc, M };
    })();
    const discRForU = (u) => {
      const { rr, cc, M } = DISC_CDF;
      let lo = 0, hi = M;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cc[mid] < u) lo = mid + 1; else hi = mid; }
      return rr[lo];
    };

    for (let i = 0; i < N; i++) {
      const kind = rnd();
      let r, theta, z, armW = 1;
      let isDust = false;
    /* 群体配比（占 N=160k）：棒 10% / 旋臂 40% / 弥散盘 50%。
     *
     * ⚠️ 2026-09-11 第 23 轮：**这里原来还有一个 11% 的「核球」分支，已删除。**
     *    核球被画了两遍 —— 一遍在这里（`r = pow(u,1.9)*3.2`，19,847 个点），
     *    另一遍是下面那个专门的核球对象（9,000 个点）。两边**径向律还不一样**：
     *      这里：Σ(r) ∝ r^(1/1.9−1) = r^−1.47  ⇒ **中心发散**，是「中央糊成一团白」的头号来源
     *      那边：体积均匀球壳投影        ⇒ 中心平，边缘归零
     *    同一个天体两套公式，正是用户说的「四不像」。
     *    现在只保留**下面那一个**核球，用 Sérsic 律（见核球那段）。
     *
     * ⚠️ 2026-09-12 第 33 轮：比例从 10/34/56 调成 **10/40/50**。
     *    理由不是「看着顺眼」，是**分工变了**：盘面的连续感现在由贴图那张**平滑指数盘**
     *    承担（旧贴图是 9 万个点，自己也是颗粒），点云退回「颗粒与深度」的角色。
     *    颗粒越多、越密，结构越容易被淹 —— 用户原话「实在难看」的主因之一。
     *    旋臂那 40% 是**结构**（它必须压在颗粒之上才看得见），盘那 50% 只负责质感。
     *    两边的**绝对点数**：棒 16.0k / 臂 64.0k / 盘 80.0k。 */
      const isBar = kind < 0.10;
      const isArm = !isBar && kind < 0.50;
      if (isBar) {
        // ★ 棒。银河系是**棒旋星系**（SB(rs)bc），棒是内区最显著的结构 ——
        //   之前完全没画（旧代码里那个 `bar` 变量只是让点「散开」的因子，不是拉长）。
        //   口径：半长 10 kly（ESA）、长轴相对「太阳–银心连线」44°、花生状轴比约 0.35。
        //   在棒自己的坐标系 (u=长轴, v=短轴) 里取点，再旋回银道面。
        const u = (rnd() * 2 - 1) * BAR_HALF;
        const v = gauss() * 3.4;
        // ⚠️ 这里换过一次口径：棒的方位角是 `MW_BAR_AZ = 90° − BAR_ANG = 46°`。
        //    写成 `bx = u·sin(44°), bz = u·cos(44°)` 也对（两者等价），
        //    但那个写法读不出「棒指向 46°」这件事，容易和旋臂的 β 口径对错 90°。
        const ca = Math.cos(MW_BAR_AZ), sa = Math.sin(MW_BAR_AZ);
        const bx = u * ca - v * sa;
        const bz = u * sa + v * ca;
        r = Math.hypot(bx, bz);
        theta = Math.atan2(bz, bx);
        z = gauss() * 0.9;
      } else if (isArm) {
        // 抽一条主臂（逐臂实测权重），再沿臂取一个 t。**不再有「远侧镜像」**——
        // 每条臂自己就扫一整圈方位角（见 textures.js 的 ρ 判据）。
        let armRow = MW_ARMS[MW_ARMS.length - 1], acc = rnd() * ARM_W_SUM;
        for (const A of MW_ARMS) { acc -= A.w; if (acc <= 0) { armRow = A; break; } }
        // ★ t 必须按**面积权重**取（`armTForArea`），**不能直接 `rnd()`**。
        //   对数螺旋的 r 随 t 指数增长 ⇒ t 均匀 = r 对数均匀 ⇒ 点全堆在棒端，
        //   外半盘一条臂都没有 ⇒ 画面成了「核外面套几圈同心环」（坑 100）。
        const p0 = armPoint(armRow, armTForArea(armRow, rnd()));
        r = p0.r; theta = p0.a;
        armW = p0.w;                       // 亮度权重 = 臂权重 × 两端渐隐 × 外缘渐暗 × 团块因子
        // ⚠️ 臂宽必须按**物理宽度**给、再换算成方位角（Δθ = w / r）。写成一个固定弧度值
        //    是最常见的错：那样内圈的点会被甩出好几倍臂宽、外圈又细成头发丝。
        //    （`proc/textures.js` 里画盘面贴图用的是同一条规则 —— 别只改一边。）
        const wKly = armRow.wArm * KPC2KLY;          // Reid 2019 的 width 列（0.30~0.50 kpc）
        // ★ 两级散布 = 团块感。真实旋臂不是一条均匀的亮线，而是「一串结 + 一片晕」
        //   （结 = OB 星协/HII 区，晕 = 被拉散的场星）。60% 贴紧、40% 散开。
        const tight = rnd() < 0.6;
        theta += (gauss() * (tight ? wKly : wKly * 3.0)) / r;
        r += gauss() * wKly * 0.8;          // 径向厚度：臂不是一条数学线
        z = gauss() * (0.22 + 0.16 * (r / R_GAL));
        // ★ 尘埃带：真实银河系最抢眼的特征就是暗尘埃**切开**银盘。
        //   additive 混合下「不给颜色的点」= 不发光 = 视觉上就是一个**缺口**，
        //   正好把旋臂打断成一段一段的团块 —— 这是让它「像照片」最省力的一招。
        isDust = rnd() < 0.22;
      } else {
        // ★ 弥散盘：臂间的星。θ 完全随机，r 走**指数盘**（见上面的 `discRForU`）。
        r = discRForU(rnd());
        theta = rnd() * Math.PI * 2;
        z = gauss() * (0.26 + 0.2 * (r / R_GAL));
      }
      // 先记成局部量，颜色算完再一起投进所属群体的桶里（**rnd() 的调用顺序不许变**，
      // 一变全部 18 万颗星的随机序列就整体错位 —— 画面会变、判据也会跟着漂）
      const px = Math.cos(theta) * r, py = z, pz = Math.sin(theta) * r;

      // 颜色：核球偏黄，旋臂偏蓝白并点缀 HII 区，弥散盘更暗更暖（**不能盖过旋臂**，
      // 否则结构就被糊平了 —— 承重点是「暗」，不是「多」）
      const r2 = rnd();
      // ⚠️⚠️ 2026-09-11：这里原来是「低饱和 + 高明度」（s 0.2~0.48、L 0.44~0.9）。
      //   实测像素后发现问题：**additive 叠加会把颜色冲顶**。几千个点叠在同一个像素上时
      //   R/G/B 全部撞到 255 ⇒ 整片银河系的 RGB 均值是 (186,179,167)、(99,95,90) ——
      //   **R≈G≈B，一坨灰斑**。形状再对也看不出是星系。
      //   ⇒ 两处一起改：① 提高饱和度、压低明度（本段）；② 整体降 opacity 防冲顶（材质那行）。
      //   目标对比：**核球偏黄（老星）／旋臂偏蓝（年轻星）** —— 这是螺旋星系最标志性的颜色特征。
      if (isBar) c.setHSL(0.045 + rnd() * 0.05, 0.52, 0.52 + rnd() * 0.18);      // 棒：以老红星为主
      else if (isDust) c.setRGB(0, 0, 0);                                       // 尘埃：不发光（画面上的缺口）
      else if (isArm && r2 < 0.07) c.setHSL(0.94, 0.78, 0.50 + rnd() * 0.16);   // HII 区：粉红
      else if (isArm && r2 < 0.16) c.setHSL(0.09, 0.55, 0.52 + rnd() * 0.16);   // 臂里的黄星
      else if (isArm) c.setHSL(0.57 + rnd() * 0.05, 0.58 + rnd() * 0.28, 0.40 + rnd() * 0.22);
      // 弥散盘：**偏暖的黄白**（老星），和蓝旋臂拉开色相差 —— 色相差是「看得出旋臂」的关键
      // ⚠️ 2026-09-12 第 33 轮：明度上限从 0.66 压到 **0.52**。
      //    分工变了：连续感由贴图的平滑指数盘承担，点云只剩「颗粒」。
      //    颗粒一旦和旋臂一样亮，两者就互相抵消 —— 画面重新变成一碗均匀的沙。
      else c.setHSL(0.085 + rnd() * 0.05, 0.42 + rnd() * 0.26, 0.36 + rnd() * 0.16);
      // ★ 亮度权重：两端渐隐、外缘渐暗、团块空隙都体现在这里 ——
      //   臂自然断成一串结、末端不封口，不用另外写分支。
      if (isArm && !isDust && armW < 1) c.multiplyScalar(armW);
      // 按「这个点属于谁」分发，而不是按「i 是多少」—— 桶的顺序无所谓，
      // 因为 additive 混合可交换，拆桶不会改变任何像素（只有拆错了才会）。
      const bucket = isBar ? pop['mw-points-bar']
        : isArm ? pop['mw-points-arm']
          : pop['mw-points-disk'];
      bucket.pos.push(px, py, pz);
      bucket.col.push(c.r, c.g, c.b);
    }
    /* 每个群体一个材质实例（同参数）——**故意的**：以后要单独调某一个群体的
     * 亮度/不透明度时，不必再回来拆代码。四个材质实例的开销可以忽略。 */
    const diskMat = () => new THREE.PointsMaterial({
      // 点尺寸从 0.42 提到 0.52：加了弥散盘后单层点数变少，靠尺寸补上「连续感」
      size: 0.52, sizeAttenuation: true, vertexColors: true, transparent: true,
      // ⚠️ 这一项改过两次（0.95 → 0.45 → 0.70），**注释里的数字要对得上代码**：
      //    0.95 时每条臂上叠了约 8 倍的点，R/G/B 全部冲顶到 255，于是
      //    「蓝旋臂 + 黄核球」被抹平成中性灰（实测 RGB 比 R:G:B ≈ 1:0.96:0.90）。
      //    0.70 是配合「盘面贴图承担结构、点云只负责颗粒感」定下来的。
      //    ⚠️ additive 混合下，**不透明度是唯一能压住累积冲顶的旋钮** ——
      //    因为 three 的色调映射是在**每个片元、混合之前**做的（见 core/engine.js
      //    的 ACESFilmicToneMapping），它对「几百个片元往同一个像素上叠」完全无能为力。
      opacity: 0.70, depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', 0.5, 64), alphaTest: 0.01,
    });
    this.diskParts = [];
    for (const k of POP_KEYS) {
      const b = pop[k];
      if (!b.pos.length) continue;                       // 预算被砍到很小的时候可能为空
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(b.pos), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(b.col), 3));
      const pts = new THREE.Points(geo, diskMat());
      pts.name = k;
      pts.frustumCulled = false;
      scene.add(pts);
      this.diskParts.push(pts);
    }

    /* --- 弥散盘底光：一个平躺在银道面上的发光圆盘 ---
     *
     * 用户的第二句原话：「银河系有一个庞大的盘，你这个就是几条曲线」。
     * 光加弥散盘粒子还不够 —— **additive 混合下暗点几乎不可见**，点云再密也有颗粒感，
     * 托不住「庞大」两个字。所以再叠一层真实的几何圆盘：
     *
     *   · 用 `Mesh` 而不是 `Sprite`。精灵永远正对相机、只能画成正圆；
     *     而这个是**平躺在银道面上的真实几何** —— 俯视是圆、侧视退化成一条线，
     *     两个角度都对（核球那个 bug 的教训，见上面银心核球那段）。
     *   · 亮度靠径向渐变纹理从中心衰减到边缘（`makeGlowTexture` 内部就是 `pow(1-r, exp)`，
     *     正好是这个形状），所以不会有硬边。
     *   · opacity 压得很低（0.38）：它只负责把盘面「托住」，**结构仍然由旋臂的点表达** ——
     *     再亮一点就会把旋臂糊平，那就从「几条曲线」变成「一坨光」，另一个极端。
     */
    const diskGlow = new THREE.Mesh(
      // CircleGeometry 的 UV 正好把内切圆映射到纹理的中心圆 ⇒ 「银河系俯视纹理」直接对上
      new THREE.CircleGeometry(R_GAL * 0.98, 128),
      new THREE.MeshBasicMaterial({
        // ★ 盘面的**结构**完全交给这张程序化纹理：旋臂、尘埃带、团块、颜色分层都在里面。
        //   之前试过「均匀撒点 + 一张径向渐变圆盘」两轮 —— 均匀分布画不出结构，
        //   永远是一坨光（用户原话：「不真实且丑」）。结构必须来自有结构的纹理。
        //   opacity 0.9 而不是 0.33：纹理本身是暗的（大量半透明小点），叠太淡会看不见。
        map: makeMilkyWayDiskTexture({ size: 1024 }),
        transparent: true, opacity: 0.9, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    diskGlow.rotation.x = -Math.PI / 2;      // 平躺到银道面（XZ 平面）上
    diskGlow.frustumCulled = false;
    scene.add(diskGlow);
    // ⚠️ 2026-10-11：之前只在这里挂场景、不存引用，`update()` 只转点云不转它 ⇒
    //    点云的臂和贴图的臂**慢慢错开**（0.0035 rad/s ≈ 30 分钟一圈，注释自己
    //    承认过但一直没修）。现在存引用，`update()` 里两份表达一起转。
    this.diskGlowMesh = diskGlow;

    /* --- 银心核球：**全层唯一一份**，点云，按 Sérsic 律撒点 ---
     *
     * ⚠️ 这里原来是一对发光 sprite（`size 16 / softness 0.32` + `size 5.2 / softness 0.2`，
     *    中途缩到过 6 + 2.6）。用户的原话：「银河系这边还有个球是个什么鬼」。
     *    探针把屏幕正中那个 `size=16 / NDC[0.001, -0.000]`、位置 [0,0,0] 的 Sprite 揪了出来。
     *
     *    **把尺寸调小治不了这个病，因为病在原理上**：`THREE.Sprite` 永远正对相机 ⇒
     *    它只能画成**正圆**。而核球是个**扁椭球**（轴比约 0.6）—— 侧视时必须扁、
     *    俯视时才接近圆。一个永远正圆的精灵做不到这件事，参数怎么调都还是个"球"。
     *    所以改用点云。
     *
     * ★ 2026-09-11 第 23 轮两处修正：
     *
     *   ① **核球原先被画了两遍**：盘点云里还挂着一个 11% 的核球分支
     *      （`r = pow(u,1.9)*3.2` ⇒ Σ(r) ∝ r^−1.47，**中心发散**），
     *      实测它是「中央糊成一团白」的头号贡献者（核区亮度 197、饱和占比 51%）。
     *      那个分支已删（见上面盘粒子的群体配比），核球只剩这一处。
     *
     *   ② **径向律换成 Sérsic** —— 这是本层级的权威口径：
     *
     *          I(R) = I_e · exp{ −b_n [ (R/R_e)^(1/n) − 1 ] }
     *
     *      为什么是它：核球唯一能观测的东西就是那条**表面亮度剖面**，而文献里
     *      这条剖面都是拿 Sérsic 拟合的。反过来「先撒点，看看像不像，再调调」是
     *      试参数试出来的 —— 正是用户明令禁止的那条路（「尽量参考真实的别自己瞎搞」）。
     *
     *      取值与出处（本层一律写清「实测 / 构造」）：
     *        · n = 2              实测区间 n ≈ 2~4（n=4 即 de Vaucouleurs）。取 2，
     *                             因为**棒**在本层单独画（`mw-points-bar`），
     *                             内区陡度不该再叠一层。
     *        · R_e = 1 kpc        实测区间 0.9~1.5 kpc，取中值 ⇒ 3.26 kly。
     *        · 截断 8 kly ≈ 2.5R_e   构造值：再往外核球的光已被盘吞掉。
     *        · 点数 30,000 ⇒ 核球占全部点数 **1/7 ≈ 14%（= B/T）**。
     *          依据：银河系 K 波段 B/T 约 0.15~0.25，取下沿 —— 因为按分解惯例
     *          **棒算盘成分**（本层单独画了 16k 点），不能重复计进核球。
     *
     *   ③ **采样办法：对「投影半径」做逆变换采样**，而不是「在三维球里撒点再投影」。
     *      要匹配的观测量就是投影后的剖面，那就直接按它采样 ——
     *      这样投影剖面**按构造**就是 Sérsic，不依赖「撒得够多自然就像了」。
     *
     *      **可复算的自检**（换 SERSIC_N / BULGE_RE / BULGE_RMAX 之后要重算）：
     *        b_n = 3.6716
     *        点数占比：R<1 kly 18.0%（旧的发散律是 54.0%）· R<2 kly 39.4%
     *                  R<R_e=3.26 kly **60.6%** · R<5 kly 80.6%
     *        ⚠️ 无截断的 Sérsic n=2 严格是「R_e 内含 50% 光」，这里量到 60.6%
     *           是 **8 kly 截断**造成的（2.5 R_e 处丢掉约 12% 的光）。
     *           不是采样错了 —— 这个差值写在这儿，免得下次有人当成 bug 去「修」。
     */
    const bulgeRnd = mulberry(20260911);
    const BULGE_N = 30000;
    const SERSIC_N = 2.0;
    const BULGE_RE = 3.2616;                 // kly（1 kpc）
    const BULGE_RMAX = 8.0;                  // kly，截断半径
    // b_n 的渐近展开（Ciotti & Bertin 1999）：b_n ≈ 2n − 1/3 + 4/(405n)
    const BULGE_BN = 2 * SERSIC_N - 1 / 3 + 4 / (405 * SERSIC_N);
    /** Sérsic 投影半径的 CDF 表（确定性，一次建好）—— 逆变换采样用 */
    const BULGE_CDF = (() => {
      const M = 512;
      const rr = new Float64Array(M + 1), cc = new Float64Array(M + 1);
      let acc = 0;
      for (let k = 0; k <= M; k++) {
        rr[k] = k / M * BULGE_RMAX;
        if (k > 0) {
          // 环带权重 = 2πR·dR·I(R)；取环带中点求值，R→0 处权重自然趋 0
          const mid = 0.5 * (rr[k - 1] + rr[k]);
          const I = Math.exp(-BULGE_BN * (Math.pow(mid / BULGE_RE, 1 / SERSIC_N) - 1));
          acc += 2 * Math.PI * mid * I * (rr[k] - rr[k - 1]);
        }
        cc[k] = acc;
      }
      for (let k = 0; k <= M; k++) cc[k] /= acc;
      return { rr, cc, M };
    })();
    const bulgeRForU = (u) => {
      const { rr, cc, M } = BULGE_CDF;
      let lo = 0, hi = M;                    // CDF 单调 ⇒ 二分
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cc[mid] < u) lo = mid + 1; else hi = mid; }
      return rr[lo];
    };
    const bulgePos = new Float32Array(BULGE_N * 3);
    const bulgeCol = new Float32Array(BULGE_N * 3);
    const bc = new THREE.Color();
    for (let i = 0; i < BULGE_N; i++) {
      const R = bulgeRForU(bulgeRnd());                 // 银道面内的投影半径
      const ph = bulgeRnd() * Math.PI * 2;
      bulgePos[i * 3] = Math.cos(ph) * R;
      // 垂直方向：近似高斯，σ_z ≈ 0.4 kly —— 核球比盘厚得多，但它是个**扁椭球**不是球
      bulgePos[i * 3 + 1] = (bulgeRnd() + bulgeRnd() + bulgeRnd() - 1.5) * 0.8;
      bulgePos[i * 3 + 2] = Math.sin(ph) * R;
      const t = bulgeRnd();
      // ⚠️ 明度上限从 **0.92**（原文 `0.6 + rnd*0.32`）压到 **0.64**（`0.42 + rnd*0.22`）。
      //    0.92 已接近纯白，additive 叠起来更快撞到 255 —— 冲顶后**色相直接丢失**，
      //    画面上就是一坨白斑，而不是「偏黄的核球」。压明度、保色相，
      //    与上面盘粒子那段（提高饱和度、压低明度）是同一个口径。
      //    ⚠️ `bulgeRnd()` 的**调用次数不许变**（这行仍是 1 次）：它喂的是确定性随机序列，
      //    次数一变整片核球的分布就整体错位，画面会变、判据也跟着漂。
      bc.setHSL(0.095 + t * 0.045, 0.5 - t * 0.25, 0.42 + bulgeRnd() * 0.22);
      bulgeCol[i * 3] = bc.r; bulgeCol[i * 3 + 1] = bc.g; bulgeCol[i * 3 + 2] = bc.b;
    }
    const bulgeGeo = new THREE.BufferGeometry();
    bulgeGeo.setAttribute('position', new THREE.BufferAttribute(bulgePos, 3));
    bulgeGeo.setAttribute('color', new THREE.BufferAttribute(bulgeCol, 3));
    const bulge = new THREE.Points(bulgeGeo, new THREE.PointsMaterial({
      size: 0.55, sizeAttenuation: true, vertexColors: true, transparent: true,
      // ⚠️ 0.9 → **0.45**（2026-09-11 第 23 轮，中央过曝）。
      //    依据不是眼睛，是探针的**逐对象消融**（泛光关闭口径，核区线性值）：
      //      `mw-bulge` **7.3504 / 总计 9.73 ⇒ 单独占 75%**，
      //      盘 0.7301(7.5%) + 盘面贴图 0.5641(5.8%) + 棒 0.1244(1.3%)，残差 9.9%。
      //    而且「整层删光」只把总值降到 2.38 —— 仍是目标 0.556 的 **4.3 倍**
      //    ⇒ **只动核球不够**，这一刀是起点不是终点（盘/泛光还得跟着降）。
      //    ⚠️ additive 下**不透明度是唯一能压住累积冲顶的旋钮**，
      //    因为 three 的色调映射在**每个片元、混合之前**做，对「几百个片元叠同一像素」无能为力。
      //    这条数值有观测约束兜着：`R_e` **不许动** —— 要它单独把核区压到位，
      //    `R_e` 得变成 3.2616·√20.48 ≈ **14.8 kly**，早已超出银河系核球的实测尺寸。
      //    ⇒ **该降的是流量份额与不透明度，不是半径。**
      //    ⚠️ 2026-09-12 第 33 轮：0.45 → **0.34**。同一次复查发现核区还叠着三份光：
      //       核球点云（这一层）+ 中心精灵 + **贴图里的暖核**。贴图那一份已经从
      //       峰值 α 0.78 降到 0.30（重画过，见 `makeMilkyWayDiskTexture`），
      //       所以这里跟着再收一档，三层合起来才是「一团柔和的暖黄光」而不是白斑。
      //    ★ 同一天再收 0.34 → **0.24**（这一刀有尺子，不是看着顺眼）：新量具
      //       `tools/analyze-galaxy-profile.py` 用「饱和核等效半径 / 5% 等照度线半径」
      //       这个**无量纲**的量，把我们的渲染和真实照片放在同一把尺子上：
      //         参照 NGC 6744 = 8.78% ／ 另一张真实星系 = 11.69%
      //         本层 before = 13.92%，after1（贴图过曝那版）= **28.17%**
      //       核区三份光（点云 + 中心精灵 + 贴图暖核）一起收，才把比数压回真实量级。
      opacity: 0.24, depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', 0.5, 64), alphaTest: 0.01,
    }));
    bulge.frustumCulled = false;
    scene.add(bulge);
    this.coreSprite = bulge;          // 名字沿用：TOP_NAMES 用它把点云命名成 `mw-bulge`
    // 中心再压一个小小的亮核，表达「银心最亮处」。这里仍然用精灵，但只有 1.4 单位 ——
    // 在这个尺寸上「圆」和「扁」的差别已经看不出来了。
    // ⚠️ opacity 0.85 → **0.30**（2026-09-11 第 23 轮，中央过曝）：
    //    它是**第二份**中心亮核 —— Sérsic 点云已经画了一遍，这一层再叠一遍，
    //    在 1.0 单位的面积上就是「白心压白心」。实测核区 `>250` 占比 59.4%（带标签 87.0%），
    //    饱和半径 6.0% of rmax ⇒ 保留「最亮处」的存在感即可，不需要它再贡献亮度。
    const core2 = makeSprite({ texture: makeGlowTexture('#fff6e2', 0.62, 128), size: 0.7, color: '#fff6e2', opacity: 0.20 });
    scene.add(core2);

    /* --- 旋臂参考线（可开关）：直接画 `MW_ARMS` 的 4 条主臂 --- */
    this.armGroup = new THREE.Group();
    for (const armRow of MW_ARMS) {
      const pts = spiralArmPoints({ arm: armRow, samples: 240 });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const m = new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.11, depthWrite: false });
      this.armGroup.add(new THREE.Line(g, m));
    }
    this.armGroup.visible = false;
    scene.add(this.armGroup);

    /* --- 银晕球状星团 ---
     * ⚠️ 2026-09-12 第 33 轮：**尺寸砍到 1/3**（1.5~3.1 → 0.45~0.95 单位）。
     *    旧值在默认视角下每颗是 **10~20 px 的模糊亮球**，180 颗铺满整幅画面 ——
     *    用户看到的「一堆黄白色糊球」就是它们，而**真实的球状星团从外部看是小点**。
     *    （点大小是**世界单位**：`sizeAttenuation: true` ⇒ px ≈ size·(h/2)/(距离·tan(fov/2))。）
     *    ⇒ 这不是「不好看」的问题，是**尺寸口径错了**：把「看到一个星团」画成了「看到一团光」。 */
    const haloRnd = mulberry(4242);
    this.globulars = new THREE.Group();
    for (let i = 0; i < 180; i++) {
      const u = haloRnd() * 2 - 1, th = haloRnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = 6 + Math.pow(haloRnd(), 0.7) * 110;
      const p = new THREE.Vector3(Math.cos(th) * s * r, u * r * 0.82, Math.sin(th) * s * r);
      const spr = makeSprite({ texture: makeGlowTexture('#ffe8c0', 0.4, 64), size: 0.45 + haloRnd() * 0.5, color: '#ffe8c0', opacity: 0.55 });
      spr.position.copy(p);
      this.globulars.add(spr);
    }
    scene.add(this.globulars);

    /* --- 太阳位置标记 ---
     *
     * ⚠️ 这里原来还画一个 `RingGeometry(3.2, 3.6, 48)` 的环套在太阳上。
     *    在 1 kly 单位下那是**半径 3.4 千光年**的一圈 —— 比银河系旋臂间距还宽，
     *    看上去就像「银河系里套着太阳系的轨道圆盘」。用户的原话：
     *    「银河系里面太阳系还加着圆盘有点不合理了而且也不美观，
     *      这个尺度下应该就留一个太阳本体」。
     *
     *    口径：**尺度越大，「我们在这里」的表达越退化**。
     *      太阳系    → 整颗恒星 + 轨道 + 圆盘（那才是本体）
     *      邻近恒星系 → 一个光点
     *      银河系    → 一个光点 + 名字（**本体就是一个点**，不带任何结构）
     *      更高层    → 同上，越往上越只剩一个标记点
     *    环是「结构」的信号，而在这个尺度上太阳系**没有结构可言**。
     *    要表达「这里有个位置」用标签就够了 —— 标签不会和旋臂抢视觉。
     */
    this.sunPos = new THREE.Vector3(0, 0.02, SUN_R);
    /* ⚠️ 2026-09-12 第 33 轮：尺寸 2.2 → **0.85**、不透明度 1 → 0.8。
     *    旧值在默认视角下是**半径 14 px 的白球 + 泛光**，看上去就是银河系的
     *    **第二个核**（实测：面朝视角下它在 r = 26.7 kly 处，离核约 165 px，
     *    两个白斑并列 —— 这正是用户说「实在难看」里最刺眼的一处）。
     *    口径与上面那段一致：这个尺度上太阳系**没有结构**，它是个**标记点**，
     *    本体就该是一个点，不是一团光。
     *
     * ★ 2026-09-12 第 37 轮：**「0.85 个世界单位的柔光团」这条口径本身还是错的**。
     *   用户原话：「都这个尺度下了，你太阳系画个点不行吗」。
     *   0.85 单位在默认视角（141.4 kly）下只有 ~6 px，而且是**软边渐隐**的 ——
     *   它落在 362 px 宽、还加了泛光的银盘点云上，**对比度为零**。
     *   病根不是「不够亮」，是**两个量纲都用错了**：
     *     ① 尺寸用了**世界单位** ⇒ 相机一拉近它就长成一团大光球。
     *        第 33 轮那个「第二个核」不是别的东西，**就是这个病的远房形态**；
     *     ② 形状只有一个**柔光团** ⇒ 柔光是「这里有结构」的视觉语言，
     *        而标记点要的恰恰是**明确的边界**。
     *   ⇒ 改成**屏幕尺寸恒定**的标记（`sizeAttenuation: false`、`depthTest: false`）：
     *     · 主体 = 实心点 + 十字星芒（`makeStarTexture`）—— 天文可视化里标位置的
     *       标准画法，读作「这颗星被标出来了」，不会被读成天体结构；
     *     · 外层 = 一圈很淡的光晕（additive）—— 只为在亮盘面上「抬一档对比」，
     *       它不是主体，`opacity` 压到 0.3；
     *     · `depthTest: false` + 抬高 `renderOrder` ⇒ 银盘点云**挡不住**它
     *       （「我们在这里」的标记被自己家的盘挡住就没有意义了）。
     *   屏幕恒定尺寸**顺带根治**了「第二个核」：拉近不会让它变大，
     *   它只是更清楚地停在银盘上那个位置。
     *
     * ⚠️ 不要调回 `sizeAttenuation: true`。`size` 的两种量纲（世界单位 /
     *   视口高度比例）见 `objects/builders.js::makeSprite` 的注释。
     * ⚠️ 两个 sprite 的 `size` 是**视口高度比例**，与视口大小无关地保持像素尺寸：
     *   本工程相机 fov=52° ⇒ 屏幕总宽 px ≈ size × 1.025 × 视口高度。
     *   当前值（核心 0.020 / 光晕 0.042）在 940 px 高的视口下约 19 / 40 px。
     *   改这两个数请用 `tools/probe-sun-mark.py` 量，别靠眼睛。 */
    /* ★ 2026-10-12 第 38 轮：用户对着默认视角的原话——
     *   「这个银河系上太阳系直接是个圈，实际上根本看不见太阳系，就是个小到看不见的点」。
     *   消融实测（`sun_ring_ablation/` A/B 截图）定位：环是 **`mw-sun-glow`**
     *   （0.042 视口比 ≈ 40px 的橙色柔光 + 泛光）画的 —— 数学上 `makeGlowTexture`
     *   单调不产生环，但「小白核 + 大范围橙衰减」过 `UnrealBloomPass` 后
     *   阈值把衰减带切出一个亮环（A 图环状 / B 图隐藏两个标记后环消失）。
     *   而 HYG 点云里太阳本体的那颗白点（B 图仍在）才是用户认的「点」。
     *   ⇒ 口径再次收紧（第 37 轮是「画个点」→ 给了 19px 星芒 + 40px 光晕；
     *      本轮是「就是个小到看不见的点」）：
     *     · `mw-sun-glow` **删除** —— 它在亮盘上的唯一作用（抬对比）由标签承担；
     *     · `mw-sun-mark` 缩到 ~9px、换 `makeGlowTexture` 紧凑白点
     *       （星芒是「标记」语言，但在这个尺度上它读作结构，一并去掉）。
     *   ⚠️ 名字 `mw-sun-mark` 必须保持（四个历史探针按它找，见下）。
     *   ⚠️ 不要调回 `sizeAttenuation: true` / 世界单位 —— 量纲教训见第 33/37 轮注释。 */
    this.sunPos = new THREE.Vector3(0, 0.02, SUN_R);
    const sunCore = makeSprite({
      texture: makeGlowTexture('#ffffff', 0.18, 64), size: 0.010, color: '#ffffff', opacity: 0.9,
      additive: true, sizeAttenuation: false, depthTest: false, renderOrder: 12,
    });
    sunCore.position.copy(this.sunPos);
    /* ⚠️ 名字**必须**保持 `mw-sun-mark` —— 四个历史探针按这个名字找它
     *   （`probe-sun-blob.py` / `probe-square-origin.py` / `probe-bloom-sweep.py` /
     *    `probe-galaxy-visual.py`）。改名会让它们**静默跳过**（找不到就 continue），
     *    于是「探针跑过了」和「探针什么都没测」外表一样。 */
    sunCore.name = 'mw-sun-mark';
    scene.add(sunCore);
    /* `mw-sun-glow` 已于第 38 轮删除（名字留着防止有人往回找）：它是那道
     * 「太阳系是个圈」的环元凶 —— 40px 柔光过泛光后读作环，见上面第 38 轮注释。 */
    /* `this.sunMark` 这个名字留给**核心**（外部只关心「那个标记还在不在」）。 */
    this.sunMark = sunCore;
    this.labels.add('mw-sun', {
      text: '太阳系', sub: '距银心 2.67 万光年', position: this.sunPos,
      className: 'major', onClick: () => this.ctx.onSelect?.('milkyway-galaxy'), priority: 100,
    });

    /* 银盘/银晕示意圈（10 / 25 / 40 / 52.8 千光年四圈）：**第 37 轮删除**。
     *
     * 理由与 `cosmos.js::LocalGroupLevel.build()` 里那段相同：底栏的视距读数
     *（`Level.scaleLabel` ⇒「视距 ≈ X 千光年」）已经更准地表达了同一件事，
     * 而环在画面里是**噪声** —— 它会横穿银盘、与 HYG 真实恒星点云压叠，
     * 在用户眼里就是「银河系上套了几个圈」。怪怪的原话：「恒星上也有，都去了」。
     *
     * ⚠️ 与它们一起消失的还有每个环的 `mw-ring-*` 标签（priority 80）。
     *    那四条标签当初是**特意压过 Messier（50）**才抢到名额的 ——
     *    这正是「为一个已经该删的东西专门调过优先级」的典型：
     *    调优先级的功夫花在了「怎么让噪声更好看」上。删掉之后，
     *    那 4 个标签名额自动回到深空天体，**不用再改任何优先级**。 */

    /* --- 结构标签 ---
     * 位置走 `mwFeaturePoint()`（文件头的唯一权威），**不要在这里手写坐标。**
     * ⚠️ 旧版是一张手写表，五个标签（银心 / 银晕 / 盾牌-半人马臂 / 矩尺臂 / 人马臂）
     *    全落在 r<16 kly 内 ⇒ 叠成一坨压在银核上，把星系埋了。 */
    for (const f of this.dataset.milkyway.features) {
      if (f.id === 'orion-arm') continue;      // 猎户臂 = 太阳所在处，那里已经有「太阳系」标签
      const v = mwFeaturePoint(f.id);
      if (!v) continue;                        // 没有锚点就**不画标签**，不要兜底到原点
      this.labels.add(`mw-${f.id}`, {
        text: f.name, position: v, className: 'dim',
        onClick: () => this.ctx.onSelect?.(`mw-${f.id}`),
        // 银心必须赢过所有臂标签 —— 它就在原点，和核球抢同一块屏幕像素。
        priority: f.id === 'sgr-a' ? 96 : 90,
      });
    }

    /* --- 远景星系 ---
     * ⚠️ 这里**有意保留 billboard**（`makeGalaxySprite`）：它们是远处背景点缀，
     *    不是银河系附近那些有真实盘朝向的星系（那一批在 `cosmos.js` 用 `makeGalaxyDisc`）。
     *    另外原来这里有一句 `spr.lookAt(0,0,0)` —— 在 `THREE.Sprite` 上**完全是死代码**
     *    （Sprite 的朝向由相机决定），删掉以免它误导后来人以为朝向已经设过了。 */
    const farRnd = mulberry(777);
    this.far = new THREE.Group();
    for (let i = 0; i < 46; i++) {
      const u = farRnd() * 2 - 1, th = farRnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = 900 + farRnd() * 2600;
      const spr = makeGalaxySprite({
        type: farRnd() < 0.6 ? 'spiral' : farRnd() < 0.5 ? 'elliptical' : 'irregular',
        color: '#cfe0ff', size: 26 + farRnd() * 60, seed: i + 1, opacity: 0.4,
      });
      spr.position.set(Math.cos(th) * s * r, u * r, Math.sin(th) * s * r);
      this.far.add(spr);
    }
    scene.add(this.far);

    /* --- 银河系内的编目天体：球状星团 / 疏散星团 / 星云 / 超新星遗迹 --- */
    this.#addDeepSkyObjects();

    /* --- 太阳附近 3262 光年内的真实恒星（HYG v41，10.9 万颗实测） --- */
    this.#addRealStars();

    /* =====================================================================
     * 给这一层的顶层对象起名 —— **不是为了好看，是为了能被诊断**
     * ---------------------------------------------------------------------
     * ⚠️ 2026-09-11 第 22 轮：消融探针打出来的表是六行 `(无名)` ——
     *    也就是「我知道有个东西在发光，但不知道是哪个」。
     *    三处 `scene.add` 里只有一个（starfield）有名字。
     *    给对象起名是本项目**最便宜的一笔可观测性投资**：一行赋值，
     *    换回来的是日志、探针、控制台里直接能读出对象身份。
     *    （同族问题：`engine._texture()` 加载失败不报错、HUD 混进像素统计 ——
     *      「看不出来是谁干的」这一类故障的共同解药就是**先留名字**。）
     * ===================================================================== */
    const TOP_NAMES = [
      // 主点云已拆成 3 个对象（`mw-points-bar/arm/disk`），名字在创建时就赋了，
      // 这里不再重复 —— 两处都写会漂开，而「名字对不上」正是消融表最怕的故障。
      // 核球不在这里：它由下面的 `mw-bulge` 承担，**全层只有一份**。
      [this.coreSprite, 'mw-bulge'],       // 核球点云（`this.coreSprite` 这个名字是历史遗留）
      [this.globulars, 'mw-globulars'],
      [this.armGroup, 'mw-guide-lines'],
      [this.far, 'mw-far-galaxies'],
      // ⚠️ **`this.realStars` 不在这里** —— 它是 `async #addRealStars()` 里创建的，
      //    而那个方法带 `await`、这里又没有 await 它 ⇒ 执行到这一行时它还不存在，
      //    清单里写着也会被 `if (o)` 静默跳过（实测就是它一直是「(无名)」）。
      //    它现在**在创建处命名**（`mw-hyg-stars`）。这就是「出生地点命名」这条规矩的由来：
      //    **跨函数的命名清单，会被任何一个 `await` 打断，而且不报错。**
      [this.deepGroup, 'mw-deep-sky'],
      [diskGlow, 'mw-disk-glow'],          // 盘面程序化贴图的平躺平面
      [core2, 'mw-core-sprite'],           // 银心那点亮核（1.0 单位）
      // ⚠️ 第 37 轮：太阳标记改成**两个** sprite（核心 + 光晕）之后**不在这里列** ——
      //    名字在**创建它们的行**就给了（`mw-sun-core` / `mw-sun-glow`）。
      //    原因正是上面这段：跨函数的命名清单会被 `await` 静默打断。
    ];
    for (const [o, n] of TOP_NAMES) if (o) o.name = n;

    /* ★ 命名之后**自查一遍**：顶层还有没有没名字的对象。
     *   「未命名 = 在探针清单里等于不存在」，这是排查时最贵的一类静默故障
     *   （我自己就为 `mw-hyg-stars` 花掉过一轮）。所以判据要自己证明会响：
     *   只要有人再往场景里加一个没名字的东西，这一条就会报出来。
     *   ⚠️ 类型过滤**别收窄**：第一版只查 Points/Mesh/Sprite，
     *   于是 `AmbientLight` 以「(无名)」的样子留在了清单里 —— 同一个坑换个类型又犯一次。
     *   现在改成「除了 Group/Scene 这种纯容器，都必须有名字」。 */
    const CONTAINER = new Set(['Group', 'Scene', 'Object3D']);
    this.unnamedTop = [];
    for (const o of this.scene.children) {
      if (o.name) continue;
      if (CONTAINER.has(o.type)) continue;
      this.unnamedTop.push(o.type);
      console.warn(`[galaxy] 顶层有一个没名字的 ${o.type}：消融/清单里会显示成「(无名)」，`
        + `排查时认不出它是谁。请在**创建它的那一行**补上 name。`);
    }

    this.applyView(this.defaultView());
  }

  /**
   * 把 HYG 星表里太阳附近 3262 光年内的真实恒星放进银河系。
   *
   *  坐标要转两次：(1) 赤道 J2000 → 银道；(2) 把银心方向对到本层级的 -Z 轴，
   *  因为本层级把太阳放在 (0,0,26.7)、银心放在原点。
   *  于是这团星云会正确地贴在「太阳系」那个位置上，而不是糊在银心。
   */
  async #addRealStars() {
    if (this.realStars) return;
    let json;
    try {
      json = await this.dataset.loadGalacticStars();
    } catch { return; }
    const rows = json?.rows || [];
    if (!rows.length) return;

    const budget = this.budget(110000);
    const step = Math.max(1, Math.floor(rows.length / budget));
    const n = Math.ceil(rows.length / step);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    const S = this.sunPos;
    let k = 0;
    for (let i = 0; i < rows.length && k < n; i += step, k++) {
      const [x, y, z, , , ci] = rows[i];
      // 赤道 J2000 → 银道（标准旋转矩阵），gx 指向银心、gz 指向北银极
      const gx = -0.0548755604 * x - 0.8734370902 * y - 0.4838350155 * z;
      const gy = 0.4941094279 * x - 0.44482963 * y + 0.7469822445 * z;
      const gz = -0.867666149 * x - 0.1980763734 * y + 0.4559837762 * z;
      pos[k * 3] = S.x + gy / 1000;          // 单位：ly → kly
      pos[k * 3 + 1] = S.y + gz / 1000;
      pos[k * 3 + 2] = S.z - gx / 1000;      // 银心在 -Z，所以 gx 取负
      c.set(starColorFromBV(ci));
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.055, sizeAttenuation: true, vertexColors: true, transparent: true,
      // ⚠️ 这里的 opacity 只是初值：**每帧由 `update()` 里的距离 LOD 覆盖**
      //    （20 kly 外归零 / 6 kly 内到 0.8）。别在别处再改它，会被那一行盖掉。
      opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', 0.5, 32), alphaTest: 0.02,
    });
    this.realStars = new THREE.Points(geo, mat);
    // ⚠️ 名字必须**在这里给**，不能指望后面那张 `TOP_NAMES` 清单 ——
    //    这是 `async` 方法（上面有 `await loadGalacticStars()`），
    //    而 `build()` 调用它时**没有 await** ⇒ 命名块跑的时候本对象还不存在，
    //    清单里那一行被 `if (o)` 静默跳过。实测后果：探针清单里它是
    //      「[14] (无名) Points 109400 点」—— 我为此怀疑过场景里有幽灵对象。
    //    规矩：**对象在哪儿出生，名字就在哪儿给**；跨函数的手写清单会被 `await` 打断。
    this.realStars.name = 'mw-hyg-stars';
    this.realStars.frustumCulled = false;
    this.scene.add(this.realStars);
    this.realStarCount = k;
    this.labels.add('mw-hyg', {
      text: '太阳附近 · 实测恒星',
      sub: `HYG 星表 ${k.toLocaleString('en-US')} 颗（≤3262 光年）`,
      position: this.sunPos.clone().add(new THREE.Vector3(0, 0.8, 0)),
      className: 'dim', priority: 70,
      onClick: () => this.ctx.onSelect?.('mw-sun'),
    });
  }

  /** 银河系内的编目天体（球状星团、疏散星团、星云、超新星遗迹 **+ 致密天体**） */
  #addDeepSkyObjects() {
    // ⚠️ 数据源走 dataset.catalogObjectsOfLevel('galaxy')，**不再直接读 dataset.deepSky**。
    //    后者只含 OpenNGC，而致密天体（黑洞 / 脉冲星 / 白矮星）在另一条链路（SIMBAD）里，
    //    于是它们在 3D 场景中**一颗都没画** —— 用户看到的就是「黑洞没做进去」。
    //    该方法内部已把两套距离口径（distMly / distLy）归一成 distMly。
    // ⚠️ 只收**坐标有限**的。`o.ra != null` 挡不住 `NaN` ——
    //    而 `NaN` 与缺坐标在渲染上是**同一个症状**：堆在世界原点（这里是银心）。
    const rows = this.dataset.catalogObjectsOfLevel('galaxy')
      .filter((o) => Number.isFinite(o.ra) && Number.isFinite(o.dec));
    if (!rows.length) return;
    this.deepGroup = new THREE.Group();
    const budget = this.budget(600);
    // 亮天体逐个画成精灵，其余的并进点云
    // ⚠️ 致密天体**多数没有视星等**（辐射集中在不可见波段），
    //    按 `mag < 9` 过滤会把它们整批滤掉。它们必须无条件入选，不参与星等竞争。
    const bright = rows
      .filter((o) => COMPACT_TYPES.has(o.type) || (o.mag ?? 99) < 9)
      .slice(0, budget);
    for (const o of bright) {
      // 银道坐标：用 l、b 定位，径向距离按类型给的代表值
      const [gx, gy, gz] = equatorialToGalactic(o.ra, o.dec, 1);
      /* ⚠️ `?? 0.005` 挡不住 `NaN`（`??` 只认 null/undefined）。
       *    5 千光年这个兜底值是给「距离未测定但方位已知」的天体用的，
       *    不是给「距离算坏了」的天体用的 —— 后者必须显式判掉。 */
      const d = Number.isFinite(o.distMly) ? o.distMly : 0.005;   // Mly → kly 需要 ×1000
      const r = d * 1000;
      const p = new THREE.Vector3(
        this.sunPos.x + gy * r,
        this.sunPos.y + gz * r,
        this.sunPos.z - gx * r,
      );
      const isCompact = COMPACT_TYPES.has(o.type);
      const spr = makeSprite({
        texture: makeGlowTexture(DEEP_COLOR[o.type] || '#cfe0ff', 0.3, 64),
        // 致密天体是**点源**（几公里到几十公里），比星团/星云小得多 —— 给更小的尺寸
        size: isCompact ? 0.26 : (o.type === 'snr' || o.type === 'nebula' ? 0.5 : 0.3),
        color: '#ffffff', opacity: isCompact ? 0.95 : 0.9,
      });
      spr.position.copy(p);
      spr.userData.bodyId = o.id;
      this.deepGroup.add(spr);
      const major = o.messier != null;
      if (major) {
        const sp = makeSprite({
          texture: makeGlowTexture(DEEP_COLOR[o.type] || '#cfe0ff', 0.36, 128),
          size: 0.55, color: '#ffffff', opacity: 0.95,
        });
        sp.position.copy(p);
        sp.userData.bodyId = o.id;
        this.deepGroup.add(sp);
      }
      /* 分级 `maxDist`（单位 = 千光年，本层的长度单位）。
       * ⚠️ `labels.js` 对 `priority > 0` 的标签有 **2.2 倍距离宽容**（PRIORITY_SLACK），
       *    所以下面的「生效距离」= 这里写的数 × 2.2，别照字面理解。
       *    Messier   70 × 2.2 ≈ 154 → 默认视角（≈141）可见
       *    致密天体  30 × 2.2 ≈  66 → 要往里推一步才出名字（它们是点源，挤不进全景）
       *    其余 NGC  26 × 2.2 ≈  57 → 最靠里，避免 NGC/IC 编号糊满盘面
       * 优先级低于尺度圈(80)与结构(90)：**全景图只讲结构，细节留给拉近**。 */
      const tierDist = major ? 70 : (isCompact ? 30 : 26);
      this.labels.add(o.id, {
        text: o.name, sub: o.common || '',
        position: p, className: major ? 'major' : 'dim',
        onClick: () => this.ctx.onSelect?.(o.id),
        priority: major ? 50 : 30, maxDist: tierDist,
      });
    }
    this.scene.add(this.deepGroup);
    this.deepSkyCount = bright.length;
  }

  update(dt) {
    /* ★ 2026-10-11：盘面贴图与点云**一起转**（同一角速度 0.0035 rad/s）。
     *    原来只有点云在转、贴图静止 —— 注释里挂了半个月的已知漂移
     *    （0.0035 rad/s ≈ 30 分钟点云领先贴图一圈）。
     *    贴图平躺在银道面（rotation.x = −π/2）上，绕**盘面法线**转 = 动本地 z。
     *    方向核对过：粒子 `rotation.y += α` 把 (1,0,0) 转向 (0,0,−1)，
     *    贴图 `rotation.z += α`（本地 y → 世界 −z）同样把 (1,0,0) 转向 (0,0,−1) ——
     *    两份表达不会错开。 */
    for (const p of this.diskParts) p.rotation.y += dt * 0.0035;
    if (this.diskGlowMesh) this.diskGlowMesh.rotation.z += dt * 0.0035;

    /* ★ 2026-09-12 第 33 轮：**HYG 星云按相机距离做 LOD**（治「银河系有两个核」）。
     *
     * 病：`mw-hyg-stars` 是 HYG v41 星表里**太阳附近 ≤3262 光年**的 10.9 万颗真实恒星。
     * 本层 1 单位 = 1 千光年 ⇒ 这 10.9 万颗**全部落在太阳周围 3.26 单位以内**，
     * 在俯视图上叠成一团饱和的白光 —— 位置正是「离银心 0.5R（= 太阳）」，
     * 读起来就是**第二个银核**。实测：把这个对象单独关掉，那块白斑**整块消失**
     * （`shots/mwabl-abl1-off-mw-hyg-stars.png`；它单独贡献了 23.5% 的变化像素，
     * 排在全场景第 2，仅次于盘面贴图）。我一开始把它误判成太阳标记的辉光精灵，
     * 算了一下 size 0.85 在默认视距下只有约 4 px 半径，对不上 90 px 的白斑 —— **归因抢跑**。
     *
     * 这不是参数问题：**在这个尺度上「一颗一颗的恒星」本来就不该被看见**
     * （银河系有上千亿颗恒星，5 万光年宽的盘上不可能分辨出单颗）。所以正确做法是
     * **能分辨时才画** —— 这也是真实观测的做法（肉眼看不见的暗星，仪器凑近了才出来）。
     *
     * ⚠️ 判据用**相机到太阳的距离**，不用时间。时间驱动的显隐＝会呼吸的装饰，
     *    会让同一视角的两次测量不可复现（`update()` 下面那段核球呼吸的教训同源）。
     * ⚠️ 淡出时必须同时 `visible = false`：opacity 归零仍然要走一遍绘制，
     *    109k 个 additve 打底的填充率不便宜。 */
    if (this.realStars) {
      const d = this.camera.position.distanceTo(this.sunPos);
      const t = Math.max(0, Math.min(1, (20 - d) / 14));    // 20 kly → 0，6 kly → 1
      const near = t * t * (3 - 2 * t);                     // smoothstep，避免硬闪
      this.realStars.visible = near > 0.01;
      this.realStars.material.opacity = 0.8 * near;
    }
    /* ⚠️ 这里原来有一句核球亮度呼吸：
     *      this.coreSprite.material.opacity = 0.86 + Math.sin(performance.now() * 0.0008) * 0.05;
     *    第 23 轮删掉了，两个理由，都不是审美问题：
     *      ① **没有观测依据**。核球的亮度不周期脉动，这是纯装饰；
     *         而项目的规矩是「程序生成的也必须先有参考，不能靠调参试出顺眼」。
     *      ② **它让所有测量不可复现**。同一曝光连拍两张，核区读数也会差 5%（线性）。
     *         探针为此不得不先花两拍去量「噪声地板」；更坏的是，
     *         它让「单独显示核球」和「全开」两次测量**根本不是同一个东西**
     *         —— 一度造出「单独显示比全开还亮」这种不可能的读数（见坑 106）。
     *    ⇒ 会呼吸的装饰 = 每次测量都自带一个不可控变量。想让它亮，就把它设亮，别让它动。 */
    this.scaleLabel = (() => {
      const d = this.camera.position.distanceTo(this.controls?.target || new THREE.Vector3());
      if (d < 1) return `${(d * 1000).toFixed(0)} 光年`;
      if (d < 1000) return `${d.toFixed(d < 20 ? 1 : 0)} 千光年`;
      return `${(d / 1000).toFixed(1)} 百万光年`;
    })();
  }

  get scaleLabelText() { return this.scaleLabel || ''; }

  pick(ndc, raycaster) {
    const { w, h } = this.ctx.engine.size;
    const v = new THREE.Vector3();
    let best = null, bestD = 40;
    // ⚠️ 锚点走 `mwFeaturePoint()`（文件头唯一权威）。旧版这里手抄了第三份坐标表，
    //    于是「点到的位置」和「标签画的位置」可以不一样 —— 两份都会「成功」。
    const candidates = [['milkyway-galaxy', this.sunPos],
      ...this.dataset.milkyway.features.map((f) => {
        const p = mwFeaturePoint(f.id);
        return p ? [`mw-${f.id}`, p] : null;
      }).filter(Boolean)];
    for (const [id, p] of candidates) {
      v.copy(p).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - (ndc.x * 0.5 + 0.5) * w, sy - (-ndc.y * 0.5 + 0.5) * h);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best ? { id: best } : null;
  }

  defaultView() { return { position: [0, 78, 118], target: [0, 0, 0] }; }

  viewFor(id) {
    if (id === 'mw-sgr-a' || id === 'milkyway-galaxy') return { position: [0, 26, 52], target: [0, 0, 0] };
    // ⚠️ 第三处手抄坐标表也取消了，统一走 `mwFeaturePoint()`。
    //    没锚点的特征退回原点**并且改看原点**（`d` 由 t.length()=0 得到 12），行为明确。
    const t = mwFeaturePoint(id) || new THREE.Vector3();
    const d = Math.max(12, t.length() * 0.5 + 10);
    return { position: [t.x + d, t.y + d * 0.7, t.z + d], target: [t.x, t.y, t.z] };
  }

  focusById(id) { this.applyView(this.viewFor(id), { instant: false }); return true; }
  setOrbitsVisible(v) { if (this.armGroup) this.armGroup.visible = v; }
  dispose() {}
}

/**
 * 层级 · 本星系群（1 = 100 万光年） 与 层级 · 可观测宇宙（1 = 10 亿光年）
 */
import * as THREE from 'three';
import { Level } from '../core/engine.js';
import { makeSprite, makeGalaxySprite, makeGalaxyDisc, makeStarfield } from '../objects/builders.js';
import { PRIORITY_SLACK } from '../ui/labels.js';
import { makeGlowTexture, makeGalaxyTexture, makeMilkyWayDiskTexture, mulberry, fbm3 } from '../proc/textures.js';
import { buildCosmicWeb } from '../proc/cosmic-web.js';

/** 本层级长度单位：1 单位 = 1 Gly = 1000 Mly（与 `scales.js` 的层级阶梯一致）。
 *  深空编目里 `x/y/z` 的单位是 **Mly**，所以落点前要除这个数。 */
const MLY_PER_GLY = 1000;

/* ============================================================
   本星系群
   ============================================================ */
/**
 * 星表新成员的标签**什么时候允许出现**（单位 = 百万光年，本层的长度单位）。
 *
 * ⚠️ 这条口径是**由数据推出来的**，不是拍的：
 *    一个成员只有在**相机拉得比它更近**时才值得报名字 —— 宽视角下这 82 个矮星系
 *    本来就只有亚像素大（最小的 `diameterLy` 只有 1,057 光年），但标签是 DOM、
 *    不吃曝光也不受尺寸限制 ⇒ 会把中心糊满文字。
 *    **实测见 `shots/lg-after-all.png`**：仙女座那一片十几个标签直接叠在一起。
 *    尺子取该成员自己的日心距：`wantEffective = max(3, 1.5 × distMly)`。
 *
 * ⚠️ `labels.js` 对 `priority > 0` 的标签有 `PRIORITY_SLACK` 倍距离宽容，
 *    所以写进去的 `maxDist` 要**除掉**这个系数，否则生效上限会大 2.2 倍 ——
 *    那正是「明明写了 maxDist、全景还是堆满文字」的成因。
 *    系数从 `ui/labels.js` **引入**，不在这里抄第二份（抄了就会跟着漂）。
 */
function lgLabelMaxDist(distMly) {
  const wantEffective = Math.max(3, 1.5 * (distMly || 0));
  return wantEffective / PRIORITY_SLACK;
}

/** 直径缺失时的兜底（光年）。
 *
 * 依据 = **同一份星表自己的统计量**：McConnachie 2012 那 93 条带 `2xR2` 的成员，
 * 直径中位数 = **2,988 光年**。取整 3,000。
 * ⚠️ 它是**估算**，不是观测值：缺直径的 4 条（大犬座矮星系 / 牧夫座 III /
 *    HIZSS 3(A) / HIZSS 3B）在表里 `R2` 一栏为空。旧代码给的是 `?? 30000`
 *    —— 那是**巨星系**量级，对这 4 个矮星系高估了 10 倍（而且 30000 这个数
 *    在整个数据文件里查不到出处，是个孤儿常量）。 */
export const LG_DIAM_FALLBACK_LY = 3000;

/** 成员星系盘的**视觉尺寸**映射（世界单位 = 百万光年，返回值是**直径**）。
 *
 * ── 为什么需要映射，而不是按真实比例 ──
 *   本层 1 单位 = 1 百万光年。3,000 光年的矮星系 = 0.003 单位 ——
 *   默认视角（相机距 5.04 Mly、视口高 940 px、fov 52°）下是 **0.57 px**，
 *   亚像素。102 个盘里 93 个都在这个量级 ⇒ 按真实比例就是「几乎什么都不画」。
 *   真实比例与「看得见」在这里**不可兼得**，本层的用途是看结构 ⇒ 取后者。
 *
 * ── 旧口径错在哪（2026-09-12 用户报的症状）──
 *   旧式 `Math.max(0.14, diamMly * 3.4)` 的门槛落在 **41,200 光年**：
 *   实测 **102 个盘里 99 个撞在同一档 0.14 上**，不同的 size 取值一共只有 4 种
 *  （M31 0.748 / 银河系 0.359 / M33 0.204 / 其余全部 0.14）。
 *   用户说「没命名的星系全和别的星系圈重叠在一起」—— 真因不是没名字（标签是
 *   另一条线：`lgLabelMaxDist` 按距离分级），而是**等大**：一堆同款白斑
 *   在屏幕上看起来就是一片。
 *   量具：`py -3.13 -X utf8 tools/diag-lg-disc-size.py`。
 *
 * ── 现在的口径：幂律，两个锚点都可复算 ──
 *   `size = K · diameterLy^k`，K = 0.00624、k = 0.379，由这两点解出：
 *     ① `diameterLy = 163`（本表最小的矮星系，Segue I/II 一档）
 *        ⇒ size 0.043 ⇒ 默认视角 **8.2 px**（屏幕可辨下限）
 *     ② `diameterLy = 105700`（银河系 D25，见 `deep-sky.js`）
 *        ⇒ size 0.500 ⇒ 默认视角 **95.6 px**
 *   `k = ln(0.500/0.043) / ln(105700/163) = 0.379`
 *   `K = 0.043 / 163^0.379 = 0.00624`
 *   直径因此跨 3.13 个数量级（163 → 220,000），视觉尺寸跨 1.06 个
 *   （8.2 px → 127 px）—— 压缩了但**严格单调**。
 *   实测分档：最小 8 px · 矮星系中位 25 px · LMC 62 px · 银河系 96 px · M31 127 px。
 *
 * ⚠️ 映射**必须单调**。任何「给某个星系手调大小」的补丁都会悄悄切断
 *    「盘的大小反映真实直径」这条不变式，而**断掉之后没有任何判据能发现它**
 *    （屏幕上照样是一堆大小不一的盘，看着还挺好）。要调就调 K 和 k。
 * ⚠️ `size` 是 `PlaneGeometry(size, size)` 的**边长 = 直径**，
 *    见 `objects/builders.js::makeGalaxyDisc` —— 别把它当半径用。
 *
 * @param {number|null|undefined} diameterLy 真实直径（光年）；缺失时用同一份星表的中位数
 * @returns {number} 盘直径（世界单位 = 百万光年）
 */
export function lgDiscSize(diameterLy) {
  const d = (typeof diameterLy === 'number' && Number.isFinite(diameterLy) && diameterLy > 0)
    ? diameterLy
    : LG_DIAM_FALLBACK_LY;
  return 0.00624 * Math.pow(d, 0.379);
}

export class LocalGroupLevel extends Level {
  constructor(ctx, dataset) {
    super(ctx);
    this.id = 'localgroup';
    this.name = '本星系群';
    this.subtitle = '仙女座 · 三角座 · 麦哲伦云';
    this.dataset = dataset;
    /* ⚠️ `maxLabels` 必须有。原来这一层只有一个 `maxDistance`，
     *    那在「只有 14 个标签」的年代够用；成员涨到 102 之后，
     *    没有硬上限 = 全部上屏 = 全景图堆满文字。
     *    取值 20：与 `galaxy.js` 同一量级、同一用途（那一层管 600 个深空天体）。
     *    配合下面星表成员的分级 `maxDist`，效果是「全景只讲结构，细节留给拉近」。 */
    this.labelOptions = { maxDistance: 60, maxLabels: 20 };
    this.controlsConfig = { minDistance: 0.06, maxDistance: 60, rotateSpeed: 0.5, zoomSpeed: 1.05, panSpeed: 0.6 };
    this.sprites = new Map();
    /** 从银河系拉远上来、或从超星系团拉近下来，都先落在银河系 */
    this.enterFocus = 'milkyway';
    this.exitFocus = 'milkyway';
  }

  build() {
    const { scene, camera } = this;
    camera.near = 0.01;
    camera.far = 3000;
    camera.updateProjectionMatrix();
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    scene.add(makeStarfield({ count: Math.round(3000 * this.fieldScale), radius: 900, innerRadius: 0.6, size: 3, seed: 91 }));

    /* ★ 银河系在本产品里出现两次：galaxy 层的俯视银盘、和这一层里的成员之一。
     *   两处**必须画同一条旋臂几何**（同一份 `armPoint()` 调用），否则同一个天体
     *   有两副长相（俯视是棒旋、这里是两条臂的小风车）—— 那正是「四不像」。
     *   ⚠️ 2026-10-11：贴图**亮度配比**在这里给一个变体（armBoost 2.2 / coreDamp 0.55），
     *      臂的**几何**一字不变（`armPoint` 同参）。为什么必须变体：galaxy 层贴着盘看，
     *      结构由点云承担、贴图的臂刻意压得很淡（第 33/37 轮按 NGC 6744 标定）；
     *      而本层默认视角下银河系只有 ~100px，点云没有 —— 只有贴图。于是
     *      「为贴着看标定的淡臂」在这个距离上被亮核盖住，银河系读成一团黄斑
     *      （修复前实拍 `shots/opt-before/L-localgroup.png`，M31 的臂清晰、银河系是糊的）。
     *      ⇒ 这就是原来那条「动态范围没有统一标定」的已知缺口，本轮闭合：
     *        臂 ×2.2 让结构在这个距离显形，核 ×0.55 压住过早饱和。
     *      缓存按参数分开（键里含 armBoost/coreDamp），两个变体互不污染。 */
    const mwTex = makeMilkyWayDiskTexture({ size: 1024, armBoost: 2.2, coreDamp: 0.55 });
    for (const g of this.dataset.galaxies) {
      /* ⚠️ 位置必须**有限**才落点。缺坐标与 `NaN` 在渲染上是同一个症状
       *    （堆在原点 = 银河系位置），所以这里用 `Number.isFinite` 而不是 `!= null`。
       *    目录里仍然可检索 —— 只是这一层看不到它，这是「可检索、无位置」的既定口径。 */
      if (!Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.z)) continue;
      /* 盘直径 = 真实直径的视觉映射。口径与两个锚点全在 `lgDiscSize()` 的注释里
       *（**唯一来源**，这里不再写第二份公式 —— 两处各留一份迟早漂开）。 */
      const size = lgDiscSize(g.diameterLy);
      /* 星系是**盘**，必须给固定朝向 —— 用 `makeGalaxyDisc`（Mesh + 平面），
       * **不要**用 `makeGalaxySprite`。后者的 `THREE.Sprite` 天生是 billboard：
       * 朝向完全由相机决定，`lookAt()` 挂在 Sprite 上没有任何效果
       * （这里原来就有一句 `spr.lookAt(0,0,0)`，是**死代码**），
       * 表现为「转动的时候他始终面向屏幕」。朝向依据见 `deep-sky.js` 的 `incl/pa/pole`。 */
      /* ★ 2026-10-12：**形态判定改按「直径 + 类型」双口径**。
       *    旧写法只认 `g.type` 的四个字面值，而星表（OpenNGC/hyperleda 合并后）
       *    里成员的 type 几乎全是 `'galaxy'`（实测 10792 条无一 `dwarfgalaxy`）
       *    ⇒ 全部 fallback 成 `'spiral'`：仙女座 XI/XIII/XXVI 这类直径千光年级的
       *    矮星系全被画成「小旋涡」，十几个同款螺旋糊在一起 ——
       *    用户原话「本星系群建模也超级粗糙需要修改」。
       *    `makeGalaxyTexture` 的 `'dwarf'` 分支（模糊光斑+亮核）本来就是
       *    矮星系的正确形态，只是从来没被走到过。
       *    判据：直径 < 12,000 光年（LMC 3.2 万走 irregular、M33 6 万走 spiral，
       *    都不落进矮星系档）或类型名含 dwarf ⇒ `'dwarf'`。 */
      const diam = Number.isFinite(g.diameterLy) ? g.diameterLy : null;
      const discType = g.type === 'irregular' ? 'irregular'
        : /dwarf/i.test(String(g.type)) || (diam != null && diam < 12000) ? 'dwarf'
        : g.type === 'elliptical' ? 'elliptical'
        : 'spiral';
      const disc = makeGalaxyDisc({
        type: discType,
        color: g.color || '#cfe0ff', size, seed: g.id.length * 13 + 3, opacity: 0.95,
        /* ⚠️ **不要**给银河系单独压暗 —— 试过，已撤回（2026-09-12，本轮第二次归因抢跑）。
         *    当时看到 `mwlook-after4-2-localgroup-mw-closeup.png` 里它比 M31 刺眼，
         *    就把它从 0.95 压到 0.60。**但那张图是我自己随手摆的一个特写机位**
         *    （1.24 百万光年），而默认视角是 5.00 百万光年 —— 压暗之后探针的
         *    `2-localgroup-default` 里银河系反而**暗到几乎看不见**（它是这一层的两个
         *    主角之一）。一张我挑出来的图不能当判据。
         *    ⇒ 恢复成与邻居**同一个 0.95**（口径统一优先）。
         *    ★ 2026-10-11：上面那条「动态范围没有统一标定」的已知缺口**已在贴图侧闭合**
         *      —— 本层的银河系贴图变体（armBoost 2.2 / coreDamp 0.55，见 build() 里那段）
         *      把「核比邻居更早饱和、臂被核盖住」两端一起处理了，opacity 保持 0.95 不动。 */
        position: [g.x, g.y, g.z],
        inclDeg: g.incl ?? null, paDeg: g.pa ?? null, pole: g.pole ?? null,
        texture: g.id === 'milkyway' ? mwTex : null,
      });
      disc.userData.bodyId = g.id;
      /* ★ 「只留核心」（2026-09-12 拍板）：**默认只画本星系群成员**。
       *   口径 `dataset.isLocalGroupMember()` —— 定义在数据层（`data/dataset.js`），
       *   并且**挂在 Dataset 实例上**：渲染层与浏览器探针取的是同一个函数，
       *   探针不需要自己重写一遍 `group === '近邻星系'`（那会是第二份实现）。
       *   ⚠️ 群外那批**仍然建对象、仍然进 `sprites` 索引**，只是 `visible = false`：
       *      ① 索引缺了它们 ⇒ 搜索 / 详情 / `focusById` 全部落空，
       *         那是「画得出、搜不到」的反面，同样**不抛任何错**；
       *      ② 「飞过去看它」必须看得见 —— 由 `focusById()` 负责点亮（见那一处）。 */
      const member = this.dataset.isLocalGroupMember(g);
      disc.visible = member;
      scene.add(disc);
      this.sprites.set(g.id, disc);
      if (member && !g.hidden) {
        /* ⚠️ `hidden` 是**另一件事**：面板文案写着「体积过小 · 放大后可见」，
         *    它管的是**标签默认出不出现**，与「画不画」无关。两件事分开判 ——
         *    把「默认折叠」塞进 `hidden` 会让一个字段有两种含义（这条差点踩上）。 */
        this.labels.add(g.id, this.#labelFor(g, disc));
      }
    }

    /* ⚠️ 2026-09-12 第 37 轮：**距离标尺环已删除**（这里原有 1/2/5 百万光年的三个同心圆）。
     *
     * 怪怪的原话：「这些超大天体集合体下的这个圈啥情况，恒星上也有，都去了」。
     * 它们对用户是**噪声**：一圈暗蓝细线横穿画面，与星系盘、与相邻的环、与标签互相压叠，
     * 而他看到的正是「没命名的小星系全和别的星系圈重叠在一起」。
     *
     * 为什么可以删（信息没有丢）：环想表达的「这有多大」在**底栏的视距读数**里
     * 已经有一份更准、且不占画面的表达（`Level.scaleLabel` ⇒「视距 ≈ X 百万光年」）。
     * ⇒ 同一个信息两份表达时，删掉**占画面**的那份。
     *
     * ⚠️ **不要尝试把它改成「更淡一点」** —— 那只是把噪声调小，仍然是噪声；
     *    也别把它挂到某个开关后面：用户要的是别画，不是「多一个开关要关」。
     * ⚠️ 四层的标尺环在同一轮全部清掉（`lg-` / `mw-` / `sc-` / `uv-` 前缀均已不在场），
     *    理由与这里相同；各自位置留了同样的注释。
     * 判据：`node tools/check-scale-rings.mjs --selftest`（离线，注入回来必须变红）。 */

    // 背景远景星系：自称"远景"就该是暗小的一片，别长到 15 单位（120 单位处 ≈ 128px）
    /* ⚠️ 这一批**有意保留 billboard**（`makeGalaxySprite`），不是漏改：
     *   · 它们**不是本星系群成员**，只是铺在 120–520 百万光年处的背景填充；
     *   · 尺寸只有几像素、透明度 0.24 —— 给它一个固定朝向，多数视角下会薄到看不见，
     *     反而连「背景里有星系」这个信息都丢了；
     *   · 而真实成员的盘朝向**必须**是固定的（见上面那段）。两者口径不同是**设计**，
     *     不是不一致。 */
    const rnd = mulberry(555);
    for (let i = 0; i < 60; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const r = 120 + rnd() * 400;
      const spr = makeGalaxySprite({
        type: rnd() < 0.65 ? 'spiral' : 'elliptical', color: '#cfe0ff',
        size: 1.5 + rnd() * 5, seed: 100 + i, opacity: 0.24,
      });
      spr.position.set(Math.cos(th) * s * r, u * r, Math.sin(th) * s * r);
      scene.add(spr);
    }

    this.applyView(this.defaultView());
  }

  update() {
    this.scaleLabel = (() => {
      const d = this.camera.position.distanceTo(this.controls?.target || new THREE.Vector3());
      if (d < 0.05) return `${(d * 1e6).toFixed(0)} 光年`;
      return `${d.toFixed(d < 3 ? 2 : 1)} 百万光年`;
    })();
  }

  get scaleLabelText() { return this.scaleLabel || ''; }

  /** 星表 / 手写成员**共用一份**标签构造。
   *  ⚠️ `build()` 与 `#reveal()` 都调它 —— 两处各写一份必然漂开
   *     （项目已踩过：同一个不变量两份实现必漏一份）。 */
  #labelFor(g, disc) {
    /* 手写条目（`provenance === 'curated+catalog'`，带 desc / 实测朝向的那 20 条）
     * 保持原样：不设距离上限。星表新成员走分级 `maxDist`（见 `lgLabelMaxDist`），
     * 于是宽视角下中心只有主角，拉近才逐个报名字。 */
    const curated = g.provenance === 'curated+catalog';
    return {
      text: g.name, sub: g.distMly < 0.001 ? '我们的星系' : `${g.distMly.toFixed(2)} 百万光年`,
      position: disc.position, className: g.id === 'milkyway' || g.id === 'm31' ? 'major' : 'dim',
      onClick: () => this.ctx.onSelect?.(g.id),
      priority: g.id === 'milkyway' ? 12 : g.id === 'm31' ? 11 : (curated ? 3 : 2),
      maxDist: curated ? null : lgLabelMaxDist(g.distMly),
    };
  }

  /** 把某个**默认不画**的天体显式点亮（含标签）。
   *
   *  ⚠️ 这是「只留核心」的**必要配套**，不是可选优化：群外那批默认 `visible = false`，
   *    用户从目录里点进来时若画面上什么都没有，「目录里搜得到、场景里看不见」
   *    这条静默故障就换了个方向回来 —— 这次连报错都不会有。
   *  ⚠️ 点亮之后**保持可见**：这是用户动作造成的**确定**状态，不是自动漂移的装饰
   *    （项目删掉过「会呼吸」的装饰，理由是它让每次测量自带一个不可控变量）。
   *  判据：`tools/probe-localgroup.py` 的「飞过去看得见」（两段式：调用前该盘不可见 /
   *    调用后可见）· `tools/check-localgroup.mjs` 的 `member-split`（口径本身）。 */
  #reveal(id) {
    const disc = this.sprites.get(id);
    if (!disc || disc.visible) return false;
    const g = this.dataset.get(id);
    if (!g) return false;
    disc.visible = true;
    if (!g.hidden) this.labels.add(id, this.#labelFor(g, disc));
    return true;
  }

  pick(ndc) {
    const { w, h } = this.ctx.engine.size;
    const v = new THREE.Vector3();
    let best = null, bestD = 40;
    for (const [id, spr] of this.sprites) {
      /* ⚠️ 默认不画的那批**不参与拾取** —— 否则在空处点一下会选中一个看不见的天体。 */
      if (!spr.visible) continue;
      v.copy(spr.position).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - (ndc.x * 0.5 + 0.5) * w, sy - (-ndc.y * 0.5 + 0.5) * h);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best ? { id: best } : null;
  }

  defaultView() { return { position: [2.2, 1.7, 4.2], target: [0, 0, 0] }; }

  viewFor(id) {
    const g = this.dataset.get(id);
    if (!g) return this.defaultView();
    const p = new THREE.Vector3(g.x ?? 0, g.y ?? 0, g.z ?? 0);
    const d = Math.max(0.32, p.length() * 0.45 + 0.18);
    return { position: [p.x + d, p.y + d * 0.55, p.z + d * 0.85], target: [p.x, p.y, p.z] };
  }

  focusById(id) {
    /* ★ 「只留核心」的**代价**在这里补回来：群外成员默认不画，
     *   但从目录里点进来必须看得见（见 `#reveal` 的说明）。 */
    this.#reveal(id);
    this.applyView(this.viewFor(id), { instant: false });
    return true;
  }

  /** 跨尺度进入本层时由 `engine.goTo()` 调（见 `engine.js` 那处说明）：
   *  只**点亮**目标、不碰相机 —— 相机落点由 `goTo` 自己算。
   *  与 `focusById` 共用同一份 `#reveal`，因此**幂等**（已可见时立即返回，不重复加标签）。
   *  ⚠️ 只点亮不建立「记住」：本层被 `_releaseLevel()` 释放后重建会按成员资格重算，
   *     即「飞过去点亮 → 走远两跳 → 回来」会重新变暗。**已知、已量、未闭合**。 */
  revealById(id) { return this.#reveal(id); }
  /* 「轨道」开关在这里没有对应物：本星系群 / 可观测宇宙尺度上**本层没有轨道**，
     保持无操作是**有意**的（坑 130 的行内自证豁免 —— 空实现必须自己写出理由）。 */
  setOrbitsVisible() {}
  /* 本层同样没有**需要自己清**的东西，空实现是**有意**的（同样按坑 130 自证）：
     盘 / 星点 / 标尺全部挂在 `this.scene` 下（`scene.add()`），而引擎的
     `_releaseLevel()` 会遍历那棵旧场景树逐个 `dispose()` 几何、材质与贴图，
     再把 `lv.scene` 换成新 Scene。
     ⚠️ 前提是**贴图不能是模块级共享缓存**：`build()` 里的 `mwTex` 是**局部**
     `makeMilkyWayDiskTexture()` 产物，被释放后重建会重新生成 —— 若哪天它被改成
     跨层 memo，这里就必须显式接管自己的生命周期，否则重建会拿到已 dispose 的死纹理。
     （2026-09-12 实测：`goTo('neighborhood')` 离开本层 ⇒ 被释放，跳回来 ⇒ 重建后
     `sprites` 里是**新造**的盘，读数见 `tools/probe-localgroup.py` 的跨层判据。） */
  dispose() {}
}

/* ============================================================
   可观测宇宙
   ============================================================ */
export class UniverseLevel extends Level {
  constructor(ctx, dataset) {
    super(ctx);
    this.id = 'universe';
    this.name = '可观测宇宙';
    this.subtitle = '拉尼亚凯亚 · 巨引源 · 宇宙微波背景';
    this.dataset = dataset;
    this.labelOptions = { maxDistance: 400 };
    this.controlsConfig = { minDistance: 0.02, maxDistance: 400, rotateSpeed: 0.5, zoomSpeed: 1.05, panSpeed: 0.6 };
    this.nodes = new Map();
    /** 从超星系团继续拉远进来时，镜头先找我们这个位置 */
    this.enterFocus = 'milkyway';
    this.exitFocus = 'laniakea';
  }

  build() {
    const { scene, camera } = this;
    camera.near = 0.005;
    camera.far = 4000;
    camera.updateProjectionMatrix();
    scene.add(new THREE.AmbientLight(0xffffff, 1.3));
    /* ⚠️ 这一层**不许**放恒星场。
     *    原来这里有一句 `makeStarfield({ radius: 900, innerRadius: 0.6, … })` ——
     *    900 是**世界单位**，而本层 1 单位 = 1 Gly ⇒ 那 2600 颗「恒星」被摆在
     *    540–900 Gly 处，而可观测宇宙的共动半径只有 **46.5 Gly**
     *    （本层的宇宙微波背景就写在 45.2）——跑到边界外面 20 倍去了。
     *    可观测宇宙的背景该由**星系 / 类星体**承担，不是恒星。
     *    它同时还是不可见的：消融实测关掉它整屏均值只变 −0.03/255。 */

    this.#buildCosmicWeb(scene);
    this.#buildGalaxyCloud(scene);
    this.#buildQuasarField(scene);

    /* --- 已知结构 --- */
    for (const s of this.dataset.cosmic) {
      if (s.type === 'cmb') continue;
      /* ⚠️ `s.distMly / 1000` 在缺字段时是 `NaN`，而 `?? 0` 挡不住它
       *    （`??` 只认 null/undefined，`undefined ?? 0` 才有效）——
       *    但这里的写法是除法，所以必须显式判有限性。 */
      if (!Number.isFinite(s.distMly)) continue;
      const dist = s.distMly / 1000; // → Gly
      const p = new THREE.Vector3(0, 0, 0);
      if (Number.isFinite(s.ra) && Number.isFinite(s.dec)) {
        const ra = (s.ra * Math.PI) / 180, dec = (s.dec * Math.PI) / 180;
        p.set(dist * Math.cos(dec) * Math.cos(ra), dist * Math.sin(dec), dist * Math.cos(dec) * Math.sin(ra));
      }
      /* 结构光晕只作提示，真实边界交给标识环。
       * 原来 size 上限 6 单位（≈874px！）且 softness 0.34 ⇒ 近半是死白，
       * 拉尼亚凯亚一个就把整屏洗白。 */
      const size = Math.max(0.10, Math.min(1.1, ((s.radiusMly ?? 50) / 1000) * 0.7));
      const spr = makeSprite({
        texture: makeGlowTexture(s.color || '#cfe0ff', 0.9, 128),
        size, color: s.color || '#cfe0ff', opacity: 0.34,
      });
      spr.position.copy(p);
      spr.userData.bodyId = s.id;
      scene.add(spr);
      this.nodes.set(s.id, spr);
      /* ★ 2026-10-12：**结构边界环已删除**。用户原话：
       *   「可观测宇宙里面别给宏观结构加莫名其妙的圈」。
       *   第 37 轮删的是**距离标尺环**（`lg-/mw-/sc-/uv-ring-` 四族，见
       *   `tools/check-scale-rings.mjs`）；这一族是「结构真实半径」的边界环，
       *   当时的判据说它不是刻度、该留 —— 但用户看着它仍然是「莫名其妙的圈」：
       *   超星系团的半径信息在标签副行（「2.50 亿光年」）与天体面板里都有，
       *   环在画面上与宇宙网点云、与相邻结构的环互相压叠，读不出边界只读出噪声。
       *   ⇒ 判据 `structure-rings-kept` 已同步收窄为**只守超星系团层**
       *      （那一层的环用户没有点名，维持原状）。
       *   ⚠️ 不要往回加：要表达「结构有多大」，把数字写进标签副行，别画线。 */
      this.labels.add(s.id, {
        text: s.name, sub: s.distMly >= 1000 ? `${(s.distMly / 1000).toFixed(1)} 十亿光年` : `${s.distMly} 百万光年`,
        position: p, className: s.id === 'laniakea' ? 'major' : 'dim',
        onClick: () => this.ctx.onSelect?.(s.id), priority: s.id === 'laniakea' ? 10 : 4,
      });
    }

    /* --- 我们所在位置 ---
     * 1.5 单位 ≈ 218px 的死白盘；压到 0.30（≈44px）并收窄白核。 */
    const home = makeSprite({
      texture: makeGlowTexture('#ffcf5c', 0.7, 128), size: 0.30, color: '#ffcf5c', opacity: 0.95,
    });
    scene.add(home);
    this.home = home;
    this.labels.add('home', {
      text: '银河系（我们在这里）', position: home.position, className: 'major',
      onClick: () => this.ctx.onSelect?.('milkyway'), priority: 12,
    });

    /* --- 宇宙微波背景（可观测宇宙边界） ---
     * 相机在 R=45.2 的球**内部**，所以这张全天贴图**必然铺满整个视口** ——
     * 它只能是「一层很淡的底」，不能是画面主体。
     *
     * 原来写 0.22（加法混合），消融实测：**整屏亮度 89% 来自这一个球**
     * （关掉它，均值从 36.12 掉到 3.97、近黑像素从 0.07% 升到 92.55%）。
     * 后果是背景成了一片蓝红雾，而这一层**真正的**内容（星系、宇宙网）
     * 全被淹在里面 —— 用户的原话「背景太空了啥也没有」。
     * 现取值使 CMB 的贡献落在**泛光阈值（engine.js:393 的 0.45）以下**，
     * 不再被泛光二次放大成满屏雾。 */
    const cmbR = 45.2;
    const cmbTex = this.#makeCmbTexture();
    const cmb = new THREE.Mesh(
      new THREE.SphereGeometry(cmbR, 64, 32),
      new THREE.MeshBasicMaterial({
        map: cmbTex, side: THREE.BackSide, transparent: true, opacity: 0.045,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    cmb.name = 'cmb';
    scene.add(cmb);
    this.cmb = cmb;
    /* ⚠️ 这里原来还有一个 `wireframe: true` 的 R=45.2 球壳（不透明度 0.05）。
     *    它是个**没有物理含义的装饰**：全天球网格在视口里就是一张罩住整屏的
     *    「纱窗」，把空间切成分格。边界这件事 45.2 那道距离环 + 标签已经说了，
     *    所以删掉。留证：消融实测它的亮度贡献只有 0.81/255 —— 删它不是因为它亮，
     *    是因为它把画面读成了一格一格。 */
    this.labels.add('cmb', {
      text: '宇宙微波背景', sub: '可观测宇宙边界 · 465 亿光年', position: new THREE.Vector3(0, cmbR * 0.98, 0),
      className: 'dim', onClick: () => this.ctx.onSelect?.('cmb'), priority: 6,
    });

    /* 距离标尺环：**第 37 轮删除**，理由见 `LocalGroupLevel.build()` 里那段
     *（同一个口径：底栏视距读数已经在表达这件事）。原来这里是 0.1 / 1 / 10 / 45.2 十亿光年四圈。 */

    this.applyView(this.defaultView());
  }

  /** 宇宙网：纤维 / 片状结构 / 节点，按密度分级采样
   *
   * 场与阈值都在 `proc/cosmic-web.js`（**唯一真源**），这里只负责变成 Points。
   * 两个数字有出处，不是调出来的：
   *   · 阈值取自「空洞占体积 77%」（Cautun+2014, NEXUS/MMF）的分位反解；
   *   · 场的基频取自**同质性判据**（各壳层接受率 max/min ≤4；旧值 55 倍）——
   *     旧参数格距 16 Gly 而取样球只有 40 Gly，球里装不下 3 个基频格，
   *     于是密度随半径起伏 55 倍，画面上就是「中间空、外圈糊」。
   * 判据可复算：`node tools/probe-cosmos-web.mjs`（离线，与这里用的是同一份代码）。
   *
   * 点尺寸口径沿用原来的说明：本层默认视距 7.6 单位 ⇒ 1 单位 ≈ 145px，
   * 0.05 单位 ≈ 7px；亮度压在泛光阈值以下避免二次起雾。
   *
   * ⚠️ `size` / `opacity` 这两个数与颜色是**一起**被单项隔离判据定的：
   *    判据 = 「只留宇宙网」的屏均值 − 「几何全藏」的屏均值 ≥ **1.0/255**。
   *    第一版（size 0.035 / opacity 0.62 + 颜色压暗）实测净贡献只有 **0.23/255**
   *    ⇒ 等于没画。读数见 `tools/probe-universe-perf.py` 第 ④ 节。 */
  #buildCosmicWeb(scene) {
    const wanted = Math.max(8000, Math.round(70000 * this.fieldScale));
    const { pos, col, stats } = buildCosmicWeb(wanted);
    if (pos.length < 3) return;
    this.webStats = stats;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.web = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.05, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', 0.7, 64), alphaTest: 0.01,
    }));
    this.web.frustumCulled = false;
    scene.add(this.web);
  }

  /** 本层的**真实河外星系**（179 个，`distMly >= 900`）
   *
   * ⚠️ 这批天体一直躺在数据集里没人画：`dataset.js:442` 的 `deepSkyLevelOf()`
   *    把它们判给 `universe` 层，`catalogObjectsOfLevel('universe')` 也取得到，
   *    但这一层的 `build()` 只遍历了 `dataset.cosmic` 那 7 个手工结构 ——
   *    于是「目录里搜得到、场景里看不见」。这正是用户报的「背景啥也没有」
   *    的第一号成因（消融实测：场景里带 bodyId 的对象 8 个，属于本层的只有 1 个）。
   *    （顺带一提，`supercluster.js` 的点云是**越层**把全表 scope=extragalactic
   *     的都铺了，所以这 179 个在超星系团层「名义上」被画了 —— 但那一层
   *     1 单位 = 100 Mly，它们在 9–26.8 单位处，而该层 maxDistance 只有 22，
   *     等于甩在取景范围之外，两头都看不见。）
   *
   * 位置单位是 Mly ⇒ 除以 1000 换成 Gly；轴向映射 `(x, z, -y)` 与
   * `supercluster.js#buildGalaxyCloud` 保持一致（同一条坐标约定，不许有第二套）。 */
  #buildGalaxyCloud(scene) {
    const rows = this.dataset.catalogObjectsOfLevel('universe')
      .filter((o) => o.type === 'galaxy'
        && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z));
    this.universeGalaxyCount = rows.length;
    if (!rows.length) return;
    const pos = [];
    const col = [];
    const c = new THREE.Color();
    for (const o of rows) {
      pos.push(o.x / MLY_PER_GLY, o.z / MLY_PER_GLY, -o.y / MLY_PER_GLY);
      /* 亮度按星等分层，与超星系团层同一口径：亮的偏黄白、暗的偏蓝。
       * 亮度上限压在泛光阈值以下（engine.js:393 的 0.45），否则整片起雾。 */
      const m = o.mag ?? 16;
      const t = Math.max(0, Math.min(1, (m - 12) / 8));
      c.setHSL(t < 0.5 ? 0.11 : 0.58, t < 0.5 ? 0.45 : 0.30, 0.70 - t * 0.22);
      col.push(c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.galaxies = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.06, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', 0.7, 64), alphaTest: 0.01,
    }));
    this.galaxies.frustumCulled = false;
    scene.add(this.galaxies);
  }

  /** 类星体远景背景场（Milliquas v7.2 抽样，5939 个）
   *
   * 这是「背景太空了」的**第二号成因**：本层此前只有程序化宇宙网 + 7 个手工结构，
   * 0.3–27.9 Gly 这段纵深里**一个真实天体都没有**。类星体是唯一能填这段的真实源
   * ——它们本身就是宇宙里最亮、最远、数量也够的示踪物。
   *
   * ⚠️ 口径与出处（`data/raw/quasars/_query-meta.json` 与 `data/quasars.json`
   *    的 `meta` 里存着同一份，页面不重复声明，只引用）：
   *   · 源 = VizieR `VII/290`（Milliquas v7.2, Flesch 2021），z > 0.02 的
   *     1,480,301 行按 `MOD(recno, 250) = 0` **确定性等间隔**稀释 ——
   *     不按 RA 排序取 TOP N、不重加权，保留星表实测的天空各向异性与红移分布；
   *   · 距离 = 平坦 ΛCDM（Planck 2018）的**共动距离积分**，不是 `cz/H₀` 近似
   *     （线性近似在 z=1 上偏 +31%、z=2 偏 +68%、z=3 偏 +105%）；
   *   · 坐标口径与 `deep-sky.js:xyz()` 完全相同：
   *     x=d·cosδ·cosα, y=d·cosδ·sinα, z=d·sinδ，单位 Mly ⇒ 这里除 1000 换 Gly。
   *   实测分布：z 0.02–6.31（中位 1.38）、距离 0.317–27.88 Gly（中位 13.87）、
   *   R 波段星等中位 19.91。
   *
   * ⚠️ 颜色是**示意色不是测光色**：这批数据只有 R 波段星等（5937/5939 行），
   *    没有 B−R，做不出真实色指数 ⇒ **不能**走 `cie.js` 那条真彩还原链
   *    （那条链要的是光谱或色指数）。所以沿用同层星系点云的「示意色」口径：
   *    只按红移给出「红移越大、观测到的光学颜色越红」这个**定性趋势**
   *    （Lyman 系吸收 + 连续谱红移）。地位与那 271 个无贴图天体的手写 color 相同
   *    ——是示意，不是观测结论。
   *
   * ⚠️ 这批天体**故意不进目录**（`catalogObjectsOfLevel` 里取不到它们）：
   *    它是这一层的**背景场**，不是可检索天体。同理点云不带 `userData.bodyId`
   *    —— `Points` 不支持逐点拾取，所以判据「目录里搜得到、场景里看不见」在这里
   *    **不适用**（那条判据针对的是有 bodyId 的天体对象）。要让 5939 个类星体
   *    进目录，得先有类型学 / 详情面板 / attrs 口径三样东西，那是另一件事。 */
  #buildQuasarField(scene) {
    const rows = (this.dataset.quasars || [])
      .filter((o) => Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z));
    this.quasarCount = rows.length;
    if (!rows.length) return;
    const pos = [];
    const col = [];
    const c = new THREE.Color();
    for (const o of rows) {
      pos.push(o.x / MLY_PER_GLY, o.z / MLY_PER_GLY, -o.y / MLY_PER_GLY);
      /* 红移 → 色相：z≈0.3 蓝白 → z≳4 偏红偏暗。与星系点云同一套「示意色」口径。 */
      const tz = Math.max(0, Math.min(1, ((o.redshift ?? 0) - 0.3) / 3.7));
      c.setHSL(0.58 - tz * 0.56, 0.30 + tz * 0.15, 0.74 - tz * 0.26);
      col.push(c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    /* 点尺寸口径同星系点云：本层默认视距 7.6 单位 ⇒ 1 单位 ≈ 100px，
     * 0.08 单位 ≈ 8px（近距离的），落在 20 Gly 外时 ≈2px。这正是要的：
     * 近的类星体是个点，远的那批汇成一层淡雾。
     * ⚠️ size / opacity / 亮度同样由**单项隔离判据**定（净贡献 ≥ 1.0/255），
     *    与宇宙网一起在 `tools/probe-universe-perf.py` 第 ④ 节读数。 */
    this.quasars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.08, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', 0.7, 64), alphaTest: 0.01,
    }));
    this.quasars.frustumCulled = false;
    scene.add(this.quasars);
  }

  /** 宇宙微波背景（可观测宇宙边界）的贴图 —— Planck 风格冷热图。
   *
   * ⚠️ 2026-10-11 重画：旧实现 fbm 基频 3.2 + 硬阈值映射 `(n−0.42)·2.4`，出的图
   *    是几大块红绿霉斑（实拍 shots/opt-before/L-universe.png）——
   *    真实 CMB 各向异性的角尺度是**度级**的，满屏应该是细密的冷暖斑点，
   *    不是十几个大色块。现在的口径：
   *      · 基频 3.2 → **8.5**（8×8 度级斑点），加细层后更像 Planck 的图；
   *      · t 走**平滑映射**（以 0.5 为中心的软饱和），不再硬切；
   *      · 色带 = Planck 可视化的标准冷暖梯度（深蓝 → 灰蓝 → 白 → 琥珀 → 深红），
   *        旧版中间那条绿带（G 通道独立算的）是它「霉斑感」的直接来源。
   *    材质侧 opacity 0.045 的口径**不动**（那是按泛光阈值 0.45 标定的，见 build()）。 */
  #makeCmbTexture() {
    const W = 1024, H = 512;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    /* Planck 风格色带（t: 0 冷 → 1 热）。
     * ⚠️ 中性点（t=0.5）取**蓝灰**而不是白：真实 CMB 图的底色读起来是蓝的，
     *    暖斑只是涨落端 —— 中心放白会让半张天图落进琥珀带，整层偏「熔岩」。 */
    const STOPS = [
      [0.00, [10, 16, 62]], [0.22, [28, 56, 138]], [0.44, [88, 122, 172]],
      [0.55, [150, 168, 196]], [0.66, [214, 200, 168]], [0.80, [196, 90, 46]], [1.00, [126, 26, 30]],
    ];
    const lerp = (a, b, t) => a + (b - a) * t;
    const cmap = (x) => {
      const t = Math.max(0, Math.min(1, x));
      for (let i = 0; i < STOPS.length - 1; i++) {
        const [p0, c0] = STOPS[i], [p1, c1] = STOPS[i + 1];
        if (t >= p0 && t <= p1) {
          const u = (t - p0) / (p1 - p0 || 1);
          return [lerp(c0[0], c1[0], u), lerp(c0[1], c1[1], u), lerp(c0[2], c1[2], u)];
        }
      }
      return STOPS[STOPS.length - 1][1];
    };
    const smooth01 = (x) => Math.max(0, Math.min(1, x * x * (3 - 2 * x)));
    for (let y = 0; y < H; y++) {
      const lat = (y / (H - 1) - 0.5) * Math.PI;
      const cy = Math.sin(lat), r = Math.cos(lat);
      for (let x = 0; x < W; x++) {
        const lon = (x / W) * Math.PI * 2;
        const n = fbm3(Math.cos(lon) * r * 8.5, cy * 8.5, Math.sin(lon) * r * 8.5, 4, 13);
        // 以 0.5 为中心的软饱和：n≈0.5 → t=0.5（近白），偏离越远越冷/越热
        const t = smooth01(0.5 + (n - 0.5) * 3.2);
        const [cr, cg, cb] = cmap(t);
        const i = (y * W + x) * 4;
        d[i] = cr; d[i + 1] = cg; d[i + 2] = cb;
        d[i + 3] = 190;
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  update(dt) {
    /* ⚠️ 这里原来有 `this.cmb.rotation.y += dt * 0.004` —— 一个**会转的全屏贴图**。
     *    两个后果，都实测过：
     *      ① 视觉上：整幅背景在缓慢流动，静不下来；
     *      ② 测量上：连拍两张有 **58.8% 的像素在变**（噪声地板完全不可用），
     *         「会动的装饰 = 每次测量自带一个不可控变量」—— 这条教训本项目
     *         已经吃过一次（见 galaxy.js 里删掉呼吸装饰的那段）。
     *    CMB 是**天球上的固定图样**，相对我们本来就不转，转它没有任何依据。 */
    this.scaleLabel = (() => {
      const d = this.camera.position.distanceTo(this.controls?.target || new THREE.Vector3());
      if (d < 0.05) return `${(d * 1000).toFixed(0)} 百万光年`;
      return `${d.toFixed(d < 10 ? 2 : 1)} 十亿光年`;
    })();
  }

  get scaleLabelText() { return this.scaleLabel || ''; }

  pick(ndc) {
    const { w, h } = this.ctx.engine.size;
    const v = new THREE.Vector3();
    let best = null, bestD = 40;
    const cands = [...this.nodes.entries()].map(([id, s]) => [id, s.position]);
    cands.push(['milkyway', new THREE.Vector3(0, 0, 0)]);
    for (const [id, p] of cands) {
      v.copy(p).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - (ndc.x * 0.5 + 0.5) * w, sy - (-ndc.y * 0.5 + 0.5) * h);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best ? { id: best } : null;
  }

  defaultView() { return { position: [0, 3.4, 6.8], target: [0, 0, 0] }; }

  viewFor(id) {
    if (id === 'cmb') return { position: [0, 30, 95], target: [0, 0, 0] };
    const s = this.nodes.get(id);
    if (!s) return { position: [0, 12, 26], target: [0, 0, 0] };
    const p = s.position;
    const d = Math.max(1.2, p.length() * 0.6 + 1.2);
    return { position: [p.x + d, p.y + d * 0.6, p.z + d], target: [p.x, p.y, p.z] };
  }

  focusById(id) { this.applyView(this.viewFor(id), { instant: false }); return true; }
  /* 「轨道」开关在这里没有对应物：本星系群 / 可观测宇宙尺度上**本层没有轨道**，
     保持无操作是**有意**的（坑 130 的行内自证豁免 —— 空实现必须自己写出理由）。 */
  setOrbitsVisible() {}
  dispose() {}
}

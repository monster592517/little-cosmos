/**
 * 层级 · 室女座超星系团（单位：1 = 1 亿光年 / 100 Mly）
 *
 *  这一层是「银河系」与「可观测宇宙」之间的关键过渡：
 *    · 上方是可观测宇宙（要把 465 亿光年塞进一屏，只能看大尺度结构）；
 *    · 下方是本星系群（百万光年量级，星系是个体）。
 *  在 1 亿光年的尺度上，星系开始退化成点，但**超星系团的结构**才刚看得清：
 *  室女座星系团、拉尼亚凯亚的纤维、巨引源、以及连接它们的星系桥。
 *
 *  数据来源：
 *    · 河外星系位置 = OpenNGC 编目天体的实测赤经赤纬 + 红移距离（哈勃定律，H0=70）
 *    · 结构边界 = Tully 团队 2014 年用星系速度流场划分的拉尼亚凯亚定义
 */
import * as THREE from 'three';
import { Level } from '../core/engine.js';
import { makeSprite, makeGalaxySprite, makeStarfield, makeRingMarker } from '../objects/builders.js';
import { makeGlowTexture, mulberry } from '../proc/textures.js';

/** 本层级长度单位：1 单位 = 100 Mly */
const MLY_PER_UNIT = 100;

/* ---------------------------------------------------------------
 * 点尺寸口径（这一层「光斑太大」的根因与修法，别随手改回去）
 *
 *  默认取景：视距 ≈ 7.86 单位，fov 52° ⇒ 视高 ≈ 7.67 单位。
 *  于是世界尺寸 s 占屏幕高度 ≈ s / 7.67，1080p（~1000px 画布）下
 *     屏幕像素高度 ≈ s × 141
 *
 *  真实尺度对照：一个星系直径 ≈ 0.1 Mly = **0.001 单位**（亚像素）。
 *  所以本层级的点天然就是「标记」，不是等比模型——问题只在于标记取多大。
 *  曾经的取值把整张图糊成白斑，三条一起犯：
 *    · 星系点 0.26 单位 = 26 百万光年 = 37px/点，9000 点加法混合 → 白雾；
 *    · 结构光晕 2.6 单位 = 260 百万光年 = **366px**；
 *    · 光晕贴图 softness=0.34 ⇒ 半径 58% 是**纯白**（见下），366px 里 212px 是死白；
 *    · 泛光阈值 0.7，这些点亮度 0.82 全部超标 → 再糊一层。
 *
 *  现在的取值是「看得见的最小值」：
 *    星系点 0.030 单位 = 3 百万光年 ≈ 屏幕 4px
 *    纤维点 0.022 单位 = 2.2 百万光年 ≈ 屏幕 3px
 * --------------------------------------------------------------- */
const GALAXY_DOT = 0.030;
const FILAMENT_DOT = 0.022;

/* 光晕贴图的 softness 口径（makeGlowTexture 的实际行为）：
 *    exp  = max(1.5, 3.8 - softness*3.0)      ← 越小，晕越宽
 *    core = max(0.1, 1 - softness*1.5)        ← r < core 的区域被混向**纯白**
 *  所以 softness 小 = 「一个大白盘 + 一圈暗晕」。
 *    softness 0.28（默认）⇒ core 0.58，半径近六成是死白
 *    softness 0.34         ⇒ core 0.49
 *    softness 0.70         ⇒ core 0.10，小亮核 + 中等晕  → 点云用
 *    softness 0.90         ⇒ core 0.10，小核 + 很宽的暗晕 → 区域光晕用
 *  大尺度结构是「一片空域」，不是灯泡，所以必须走 0.9 + 低不透明度。 */
const DOT_SOFT = 0.7;
const HALO_SOFT = 0.9;

export class SuperclusterLevel extends Level {
  constructor(ctx, dataset) {
    super(ctx);
    this.id = 'supercluster';
    this.name = '室女座超星系团';
    this.subtitle = '拉尼亚凯亚 · 室女座星系团 · 巨引源';
    this.dataset = dataset;
    this.labelOptions = { maxDistance: 14 };
    this.controlsConfig = { minDistance: 0.06, maxDistance: 22, rotateSpeed: 0.5, zoomSpeed: 1.05, panSpeed: 0.6 };
    this.nodes = new Map();
    /** 从本星系群拉远进来时，镜头落在「我们」身上 */
    this.enterFocus = 'laniakea';
    this.exitFocus = null;
  }

  build() {
    const { scene, camera } = this;
    camera.near = 0.004;
    camera.far = 4000;
    camera.updateProjectionMatrix();
    scene.add(new THREE.AmbientLight(0xffffff, 1.25));

    scene.add(makeStarfield({
      count: Math.round(3200 * this.fieldScale),
      radius: 900, innerRadius: 0.6, size: 2.6, seed: 613,
    }));

    /* ---------- 1. 真实河外星系点云（OpenNGC → 红移距离） ---------- */
    this.#buildGalaxyCloud(scene);

    /* ---------- 2. 宇宙网的纤维背景 ---------- */
    this.#buildFilaments(scene);

    /* ---------- 3. 已知结构：超星系团 / 星系团 / 巨引源 ---------- */
    for (const s of this.dataset.cosmic) {
      if (s.type === 'cmb') continue;                       // 宇宙微波背景属于「可观测宇宙」层
      if ((s.distMly ?? 0) > 12000) continue;               // 太远的巨型结构留给上一层
      const p = new THREE.Vector3(0, 0, 0);
      /* `s.distMly` 的**真值**判断挡不住 `NaN`（NaN 是 falsy，会走 else 留在原点 ——
       * 那正好是「有结构但堆在原点」的假象）。要判就判有限性。 */
      if (Number.isFinite(s.ra) && Number.isFinite(s.dec) && Number.isFinite(s.distMly)) {
        const ra = (s.ra * Math.PI) / 180;
        const dec = (s.dec * Math.PI) / 180;
        const d = s.distMly / MLY_PER_UNIT;
        p.set(d * Math.cos(dec) * Math.cos(ra), d * Math.sin(dec), d * Math.cos(dec) * Math.sin(ra));
      }
      /* 结构光晕：只作「这一片空域里有东西」的提示，**边界交给下面的标识环**。
       * 拉尼亚凯亚半径 240 Mly → 0.43 单位 ≈ 60px（原来是 2.6 单位 ≈ 366px 的死白盘）。 */
      const size = Math.max(0.06, Math.min(0.55, ((s.radiusMly ?? 50) / MLY_PER_UNIT) * 0.18));
      const spr = makeSprite({
        texture: makeGlowTexture(s.color || '#cfe0ff', HALO_SOFT, 128),
        size, color: s.color || '#cfe0ff', opacity: 0.34,
      });
      spr.position.copy(p);
      spr.userData.bodyId = s.id;
      scene.add(spr);
      this.nodes.set(s.id, spr);

      // 超星系团这种「区域」性质的结构，用一圈标识环表示它的边界比一个光点更准确
      if (s.type === 'supercluster' || s.type === 'group' || s.type === 'attractor') {
        const ring = makeRingMarker({
          // 下限定在 0.12 单位（12 Mly）纯为「看得见」：室女座星系团真实半径 7.5 Mly
          // = 0.075 单位 = 11px 的圆，画出来等于没有。环是细线，放大一点不产生光斑。
          // ⚠️ 2026-10-11：opacity 0.26 → **0.12**。默认视角下拉尼亚凯亚的环是
          //    ~440px 的椭圆，0.26 的亮度让它读成「两只空蛋壳」压在整幅画面上
          //    （实拍 shots/opt-before/L-supercluster.png）。环只是边界提示，
          //    亮度必须低到「看见了不抢戏」；真实范围感由环的**尺寸**表达，不靠亮度。
          radius: Math.max(0.12, (s.radiusMly ?? 50) / MLY_PER_UNIT),
          color: s.color || '#9ec5ff', opacity: 0.12, segments: 64,
        });
        ring.position.copy(p);
        // 赤经赤纬缺失时 p 还在原点，lookAt(0,0,0) 是退化朝向（零向量）→ 会算出 NaN 变换
        if (p.lengthSq() > 1e-12) ring.lookAt(0, 0, 0);
        scene.add(ring);
      }

      const isMajor = s.id === 'laniakea' || s.id === 'local-group' || s.id === 'virgo-cluster';
      this.labels.add(s.id, {
        text: s.name,
        sub: s.distMly ? `${s.distMly.toLocaleString('en-US')} 百万光年` : '',
        position: p, className: isMajor ? 'major' : 'dim',
        onClick: () => this.ctx.onSelect?.(s.id),
        priority: isMajor ? 10 : 4,
      });
    }

    /* ---------- 4. 「我们在这里」 ----------
     * 只放**一个亮点**（与 galaxy 层同一口径：尺度越大，「我们在这里」的表达越退化）。
     * 原来是 0.5 单位 ≈ 70px 且 softness 0.25 ⇒ 半径六成是死白，视口正中糊一大团白。
     * 后来改成 0.13 + 小核，但还配了一个 `radius: 0.32` 的定位环 —— 那是
     * **32 百万光年**的一圈，比本星系群本身还大，看上去就是个「圆盘」。
     * 用户口径：这个尺度下只留一个点，结构交给标签说。 */
    const home = makeSprite({
      texture: makeGlowTexture('#ffcf5c', DOT_SOFT, 128), size: 0.13, color: '#ffcf5c', opacity: 0.95,
    });
    scene.add(home);
    this.home = home;
    this.labels.add('sc-home', {
      text: '本星系群（我们在这里）', position: home.position, className: 'major',
      onClick: () => this.ctx.onSelect?.('local-group'), priority: 12,
    });

    /* ---------- 5. 距离标尺环：**第 37 轮删除**（原有 100 / 300 / 600 百万光年三圈） ----------
     * 理由见 `cosmos.js::LocalGroupLevel.build()` 里那段：底栏的视距读数已经表达了同一件事，
     * 而同心暗蓝细线在画面里是噪声，用户的原话是「这些超大天体集合体下的这个圈…都去了」。
     * ⚠️ 本层还有**另一种环**并且**保留**：`makeRingMarker()` 给超星系团/星系群/引力源
     *    画的**边界环**（上面第 4 段）。那不是"距离刻度"，而是"这个结构的真实范围"，
     *    删了就没有替代物。两者看起来都是圈，但一个是刻度、一个是对象本身的大小 ——
     *    这一轮删的只是**刻度**那一种。 */

    /* ---------- 6. 远景星系（本层之外的宇宙） ----------
     * 它们自称「远景」，却长到 1.2–5.2 单位（在 24 单位处 ≈ 12°，128px），
     * 比真前景还抢眼。压到 0.5–2.1 单位并降透明度，退回背景。 */
    const rnd = mulberry(9091);
    this.far = new THREE.Group();
    for (let i = 0; i < Math.round(40 * this.fieldScale); i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const r = 24 + rnd() * 160;
      /* ⚠️ 有意保留 billboard —— 背景点缀，不是有真实盘朝向的成员星系。
       *    原来那句 `spr.lookAt(0,0,0)` 在 Sprite 上是**死代码**，已删。 */
      const spr = makeGalaxySprite({
        type: rnd() < 0.65 ? 'spiral' : 'elliptical', color: '#cfe0ff',
        size: 0.5 + rnd() * 1.6, seed: 300 + i, opacity: 0.18,
      });
      spr.position.set(Math.cos(th) * s * r, u * r, Math.sin(th) * s * r);
      this.far.add(spr);
    }
    scene.add(this.far);

    this.applyView(this.defaultView());
  }

  /** 用 OpenNGC 的真实河外星系铺出结构——比纯程序化生成的纤维更有说服力 */
  #buildGalaxyCloud(scene) {
    const all = this.dataset.deepSky || [];
    /* ⚠️ `!= null` 挡不住 `NaN`。这是本类故障的共同形状：
     *    判据只检查「字段在不在」，而真故障是「字段在、值坏了」——
     *    两者在渲染上给出**同一个症状**（堆在原点），但只有后者该被拦下。
     *    `Number.isFinite` 才是那句话的正确写法。 */
    const rows = all.filter((o) => o.scope === 'extragalactic'
      && Number.isFinite(o.distMly) && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z));
    if (!rows.length) return;
    const budget = this.budget(9000);
    const step = Math.max(1, Math.floor(rows.length / budget));

    const pos = [];
    const col = [];
    const c = new THREE.Color();
    for (let i = 0; i < rows.length; i += step) {
      const o = rows[i];
      pos.push(o.x / MLY_PER_UNIT, o.z / MLY_PER_UNIT, -o.y / MLY_PER_UNIT);
      // 亮度按星等分层：亮的偏黄白，暗的偏蓝。
      // 亮度上限压在 0.66 以下：泛光阈值是 0.7，超过就会整片起雾。
      const m = o.mag ?? 14;
      const t = Math.max(0, Math.min(1, (m - 6) / 12));
      c.setHSL(t < 0.5 ? 0.11 : 0.58, t < 0.5 ? 0.42 : 0.28, 0.66 - t * 0.24);
      col.push(c.r, c.g, c.b);
    }
    if (pos.length < 3) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      // ⚠️ 2026-10-11：opacity 0.72 → **0.85**（亮度从 Opacity 通道给，不碰 GALAXY_DOT
      //    —— 那行被 `check-macro.py` 的注入自检按字面钉着）。这层的病是「空」：
      //    OpenNGC 铺出来的 9000 点是全层唯一的真实内容，太暗就只剩两只边界环。
      size: GALAXY_DOT, sizeAttenuation: true, vertexColors: true, transparent: true,
      opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', DOT_SOFT, 64), alphaTest: 0.01,
    });
    this.galaxies = new THREE.Points(geo, mat);
    this.galaxies.frustumCulled = false;
    scene.add(this.galaxies);
    this.galaxyCount = Math.ceil(rows.length / step);
  }

  /** 大尺度纤维的底噪：低频 fBm 阈值化，密度跟着画质档位走 */
  #buildFilaments(scene) {
    const rnd = mulberry(2718);
    const R = 8;   // 800 Mly 视野内的纤维
    const wanted = this.budget(16000);
    const pos = [];
    const col = [];
    const c = new THREE.Color();
    let guard = 0;
    while (pos.length / 3 < wanted && guard < wanted * 12) {
      guard++;
      let x, y, z, d;
      do {
        x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1;
        d = Math.sqrt(x * x + y * y + z * z);
      } while (d > 1);
      // 纤维感：把点往「薄壳/丝状」上收
      const shell = Math.abs(d - 0.62) > 0.2 && Math.abs(d - 0.31) > 0.12;
      const strand = Math.abs(Math.sin(x * 4.1) * Math.cos(z * 3.7) - y * 1.8) < 0.12;
      if (!shell && !strand) continue;
      pos.push(x * R, y * R, z * R);
      c.setHSL(0.58, 0.3, 0.44 + rnd() * 0.20);
      col.push(c.r, c.g, c.b);
    }
    if (pos.length < 3) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    // 注意：PointsMaterial 必须给 map，否则点会被画成硬边方块（不是圆点）
    // ⚠️ 2026-10-11：opacity 0.30 → **0.42**。纤维是这层「大尺度结构」语义的承担者，
    //    0.30 时它们在默认视角下几乎沉进黑底，画面只剩离散点。
    this.filaments = new THREE.Points(geo, new THREE.PointsMaterial({
      size: FILAMENT_DOT, sizeAttenuation: true, vertexColors: true, transparent: true,
      opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', DOT_SOFT, 64), alphaTest: 0.01,
    }));
    this.filaments.frustumCulled = false;
    scene.add(this.filaments);
  }

  update(dt) {
    if (this.filaments) this.filaments.rotation.y += dt * 0.0006;
    this.scaleLabel = (() => {
      const d = this.camera.position.distanceTo(this.controls?.target || new THREE.Vector3());
      const mly = d * MLY_PER_UNIT;
      if (mly < 1) return `${(mly * 1000).toFixed(0)} 千光年`;
      if (mly < 1000) return `${mly.toFixed(mly < 20 ? 1 : 0)} 百万光年`;
      return `${(mly / 1000).toFixed(2)} 十亿光年`;
    })();
  }

  get scaleLabelText() { return this.scaleLabel || ''; }

  pick(ndc) {
    const { w, h } = this.ctx.engine.size;
    const v = new THREE.Vector3();
    let best = null, bestD = 34;
    const cands = [...this.nodes.entries()].map(([id, s]) => [id, s.position]);
    cands.push(['local-group', this.home.position]);
    for (const [id, p] of cands) {
      v.copy(p).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - (ndc.x * 0.5 + 0.5) * w, sy - (-ndc.y * 0.5 + 0.5) * h);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best ? { id: best } : null;
  }

  defaultView() { return { position: [3.6, 2.8, 6.4], target: [0, 0, 0] }; }

  viewFor(id) {
    const s = this.nodes.get(id);
    if (!s) return { position: [1.6, 1.3, 2.8], target: [0, 0, 0] };
    const p = s.position;
    const d = Math.max(0.5, p.length() * 0.55 + 0.4);
    return { position: [p.x + d, p.y + d * 0.6, p.z + d], target: [p.x, p.y, p.z] };
  }

  focusById(id) { this.applyView(this.viewFor(id), { instant: false }); return true; }
  /* 「轨道」开关在这里没有对应物：超星系团尺度上**本层没有轨道**可言，
     保持无操作是**有意**的（坑 130 的行内自证豁免 —— 空实现必须自己写出理由）。 */
  setOrbitsVisible() {}
}

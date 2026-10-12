/**
 * 层级 · 邻近恒星系（单位：1 = 1 光年）
 *  数据：HYG v41 星表（120 光年内 5258 颗恒星）+ NASA 系外行星档案（471 个系统）
 */
import * as THREE from 'three';
import { Level } from '../core/engine.js';
import { makeSprite, makeStarfield } from '../objects/builders.js';
import { makeStarTexture, makeGlowTexture, starColorFromBV } from '../proc/textures.js';
import { blackbodyToHex } from '../color/cie.js';
import { placeOfLy } from '../data/attrs.js';
import { ExoplanetRenderer, HOLD_LY, auToOrbitRadius } from '../objects/exo-planets.js';

/**
 * 恒星色的解析（真彩还原链的第一档：**恒星 = 自身黑体辐射**）。
 *
 *   有 B−V 色指数 → 走色指数（实测口径）
 *   只有有效温度 T_eff → 走黑体谱（这是更本源的口径，两者同源）
 *   都没有 → 保持原有兜底
 *
 * 为什么需要温度这条支路：`exoplanets.json` 的 281 个宿主星在 HYG 表里对不上，
 * 它们没有 `ci`，但有 `teff`。不接这条支路的话这批星会全部退化成同一个默认色 ——
 * 那正是本项目最反感的「一大批同色」。
 *
 * ⚠️ **本函数必须返回 `#rrggbb` 字符串**，三个分支都是。
 *   踩过的坑：`cie.blackbodyToHex()` 返回的是一个**对象** `{hex, rgb}`（不是字符串！），
 *   直接把它 `return` 出去，下游 `makeGlowTexture(color)` → `hexToRgb(对象)`
 *   → `hex.replace is not a function`，整个邻近恒星系层级 build 失败，
 *   页面刷 25 条 PAGEERROR、WebGL 上下文跟着丢。
 *   所以这里取 `.hex`；改这个函数前先看一眼 `cie.js:494` 的返回值形态。
 */
const starColorOf = (star) => {
  if (star.ci != null && Number.isFinite(star.ci)) return starColorFromBV(star.ci);
  if (Number.isFinite(star.teff) && star.teff > 800) return blackbodyToHex(star.teff).hex;
  return starColorFromBV(star.ci);
};

const STAR_VERT = `
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (560.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }`;
const STAR_FRAG = `
  uniform sampler2D map;
  varying vec3 vColor;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    if (t.a < 0.06) discard;
    gl_FragColor = vec4(vColor * t.rgb, t.a);
  }`;

export class NeighborhoodLevel extends Level {
  constructor(ctx, dataset) {
    super(ctx);
    this.id = 'neighborhood';
    this.name = '邻近恒星系';
    this.subtitle = '120 光年内的恒星与系外行星系统';
    this.dataset = dataset;
    /* ⚠️ 2026-10-11：加 `maxLabels: 26`。原来只有 `maxDistance: 260` 没有硬上限 ——
     *    本层给具名恒星/系外宿主/亮星全都 add 标签，默认视角（视距 ~59 光年）下
     *    **300+ 个标签糊满全屏**，把恒星点云本身埋了（实拍
     *    `shots/opt-before/L-neighborhood.png`）。其余各层全是 `maxLabels: 20`
     *    （「全景只讲结构，细节留给拉近」，galaxy.js 那段是这套纪律的出处），
     *    这层是唯一漏网。取 26：比别的层松一档（这层的「内容」就是恒星本身），
     *    但上限必须存在 —— 优先级低的标签会被贪心占位算法自动让位。 */
    this.labelOptions = { maxDistance: 260, maxLabels: 26 };
    this.controlsConfig = { minDistance: 0.35, maxDistance: 320, rotateSpeed: 0.5, zoomSpeed: 1.1, panSpeed: 0.7 };
    this.named = [];
    /* ⚠️ `exoSprites`（「有行星」的光环标记数组）已于第 37 轮删除 —— 见 `build()` 里的说明。 */
    /* 「轨道」开关在本层的现状。默认 true；真实初值在 `build()` 里从引擎配置取。
     * ⚠️ 它必须**存在实例上**，不能只在 setOrbitsVisible 里用一下就算 ——
     *   `update()` 每帧都会重写 `ring.visible`，没有这份状态的话开关一关就被覆盖。 */
    this.orbitsVisible = true;
    /** 从太阳系拉远上来时镜头先落在太阳上；往回拉近时也从太阳走 */
    this.enterFocus = 'star-sun';
    this.exitFocus = 'star-sun';
  }

  build() {
    const { scene, camera } = this;
    camera.near = 0.004;
    camera.far = 4000;
    camera.updateProjectionMatrix();
    // 重新构建时清空累计状态，避免恒星精灵被重复添加
    this.named = [];
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));

    scene.add(makeStarfield({ count: Math.round(9000 * this.fieldScale), radius: 1200, innerRadius: 0.55, size: 5, seed: 33 }));

    /* --- 全部恒星（点云，按色指数着色） --- */
    const rows = this.dataset.stars;
    const n = rows.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const [name, x, y, z, mag, absmag, ci, spect, lum] = rows[i];
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      c.set(starColorFromBV(ci));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      const l = Number.isFinite(lum) && lum > 0
        ? Math.log10(lum + 1)
        : Math.max(0, (5.2 - (absmag ?? 6)) * 0.28);
      size[i] = Math.min(2.1, Math.max(0.55, 0.6 + l * 1.25));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: makeStarTexture('#ffffff') } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    /* --- 有专名 / 有行星的恒星：单独精灵 + 标签 ---
     *
     * ⚠️ 这里原来只有一句 `if (star.type !== 'star') continue;` —— 两道锁全开着，
     *    结果是「太阳变成一个硬边大白色方块」（用户报的「大方框太阳」）。两道锁分别是：
     *
     *   ① **没看 `level`。** `dataset.bodies` 里 `type === 'star'` 的不止邻近层的恒星：
     *      2,158 个 `scope: 'milkyway'` 的深空天体（OpenNGC 的 doublestar/star 等）
     *      也被映射成 `star`，而它们的 `level` **本来就是 `galaxy`** ——
     *      字段早就算对了，只是这个循环没读。更糟的是它们的 `x/y/z` 单位是**百万光年**，
     *      在本层（单位 = 光年）被原样当成光年用，取值 0.0005–0.02
     *      ⇒ 全部叠在太阳身上。
     *   ② **没判坐标。** `new THREE.Vector3(undefined,…)` 不抛异常，得到 NaN 向量；
     *      坐标全零同样通过。两者在渲染上都表现为**堆在世界原点**，
     *      而世界原点恰好是太阳。叠加型发光精灵一饱和就是硬边方块。
     *
     *    还有第三处顺序问题：星等门槛写在坐标判据**之前**时，
     *    `mag === undefined` 会让 `undefined > 4.2 === false` 成立而**蒙混过关** ——
     *    「缺字段 = 免检」的又一例。所以坐标判据必须排在前面。
     */
    let skippedOffTier = 0;
    let skippedNoPlace = 0;
    for (const star of this.dataset.bodies.values()) {
      if (star.type !== 'star') continue;
      // ① 只收本层的。别的尺度层的天体有自己的场景，不在这里落点。
      const tier = star.level || 'solar';
      if (tier !== 'neighborhood') { skippedOffTier++; continue; }
      // ② 拿得到位置才画。太阳是唯一「真的在原点」的天体，显式放行。
      const place = placeOfLy(star, { allowOrigin: star.id === 'star-sun' });
      if (!place) { skippedNoPlace++; continue; }
      const info = star.info;
      const hasExo = Boolean(star.exo);
      // ③ 星等门槛（写在坐标之后，缺 mag 的才算「不够亮」而不是「免检」）
      if (!info && !hasExo && !(Number.isFinite(star.mag) && star.mag <= 4.2)) continue;
      const dist = Math.max(0.2, Number.isFinite(star.distLy) ? star.distLy : 0);
      const p = new THREE.Vector3(place.x, place.y, place.z);
      const spr = makeSprite({
        texture: makeGlowTexture(starColorOf(star), 0.22, 128),
        size: 0.42 + (info ? 0.28 : 0) + (hasExo ? 0.12 : 0),
        color: '#ffffff', opacity: 0.95,
      });
      spr.position.copy(p);
      spr.userData.bodyId = star.id;
      scene.add(spr);
      this.named.push({ id: star.id, star, position: p, sprite: spr });

      /* ★ 2026-09-12 第 37 轮：**「有行星」的光环标记已按怪怪要求移除。**
       *   原话：「这些超大天体集合体下的这个圈啥情况，**恒星上也有，都去了**」。
       *   为什么它必须走（第 36 轮试过的三条折中都不成立）：
       *     ① 它套在恒星上，在天文图里天然被读成「轨道」—— 而它不是轨道；
       *     ② 半径 0.42 与精灵方片半宽 0.41 **几乎重合**，看着像光晕的毛边不像记号；
       *     ③ 全层实测 **4745 个**（`Boolean(star.exo)` ⇒ 每颗有确认行星的恒星一个），
       *        密集到成为噪声，且每个都是一个独立 `Line` = draw call 负担；
       *     ④ 上一轮的处置是「接到『轨道』开关上、关得掉」—— 那是**把问题推给用户去关**，
       *        而用户要的是**别画**。
       *   它也不是「看不清」的问题，而是**不该用结构去表达一个属性**：
       *   `hasExo` 已经体现在精灵尺寸（+0.12）、标签优先级（6 vs 3）与天体面板里，信息没丢。
       *   ⚠️ 不要再把它加回来。 */

      this.labels.add(star.id, {
        text: info?.zh ? `${info.zh}` : star.name,
        sub: `${star.en && info?.zh ? star.en + ' · ' : ''}${dist.toFixed(1)} 光年`,
        position: p,
        className: info ? 'major' : 'dim',
        onClick: () => this.ctx.onSelect?.(star.id),
        priority: info ? 8 : hasExo ? 6 : 3,
      });
    }
    /* 这两个数字进 `stat`，供探针与自检读取。
     * 不写进界面文案 —— 界面上「本该有多少颗」是数据自身的属性，不该被文案写死。 */
    this.skippedOffTier = skippedOffTier;
    this.skippedNoPlace = skippedNoPlace;

    /* --- 邻近的致密天体（白矮星 / 脉冲星 / 黑洞） --- */
    this.#buildCompactNearby(scene);

    /* --- 太阳 --- */
    const sunSprite = makeSprite({ texture: makeGlowTexture('#ffcf5c', 0.3, 256), size: 3.4, color: '#ffcf5c', opacity: 1 });
    sunSprite.position.set(0, 0, 0);
    sunSprite.userData.bodyId = 'star-sun';
    scene.add(sunSprite);
    this.sunSprite = sunSprite;
    this.labels.add('star-sun', {
      text: '太阳', sub: '我们所在的位置', position: sunSprite.position,
      className: 'major', onClick: () => this.ctx.onSelect?.('star-sun'), priority: 10,
    });

    /* 距离标尺球壳（10 / 25 / 50 / 100 光年的正交圆）：**第 37 轮删除**。
     *
     * 它与另外四层的平面标尺环是同一族东西、同一个处置（理由见
     * `cosmos.js::LocalGroupLevel.build()` 里那段：底栏视距读数已经在表达这件事，
     * 而画面里的圈是噪声）。之所以在这里是**球壳**而不是圆环：
     * 本层是 3D 恒星邻域，只画一个平面圆会被误读成"盘面"。
     *
     * ⚠️ 一起消失的还有 `shell-${r}` 四个「N 光年」标签（priority 1，本来就抢不到名额）。
     * ⚠️ 注意与它**不是**一回事的两样东西，都保留：
     *   · 点云里恒星的分布本身（没有人为结构）；
     *   · 「轨道」开关管的系外行星轨道线（那是真实对象，不是刻度）。 */

    /* --- 系外行星系统（按相机距离懒加载） --- */
    // 几千个系统一次全建会把标签页跑崩（本机显存 4 GB / 可用内存 1–2 GB）。
    // ExoplanetRenderer 只在相机进入 3 光年时构建、离开 6 光年时释放。
    this.exoRenderer = new ExoplanetRenderer(scene, this.dataset.exoplanets || []);
    this.exoCount = (this.dataset.exoplanets || []).length;
    /* 「轨道」开关的**初始状态**取自引擎配置 —— 与 `solar.js` 同一口径，
     * 不另造一套判断：用户可能在别的层把它关掉了，切回本层要保持一致。 */
    this.setOrbitsVisible(this.ctx.engine?.options.orbits ?? true);

    this.applyView(this.defaultView());
  }

  /**
   * 邻近层的致密天体：白矮星 / 脉冲星 / 黑洞。
   *
   * 为什么用点云而不是逐个 Sprite：
   *   邻近层有 600+ 颗白矮星（SIMBAD 按视差取「最近的」那一批），
   *   逐个建 Sprite = 600+ 次 draw call，帧率必掉；而它们在视觉上只是些小点。
   *   ⇒ 全部并入一个 Points（一次 draw call）；
   *     只有人工表点名的著名天体（notable）才单独给 sprite + 标签 ——
   *     否则用户根本点不到「天狼星 B」这种东西。
   */
  #buildCompactNearby(scene) {
    // 类型 → 标记色。⚠️ 这是**标记色，不是天文真彩**：
    //    黑洞本身不发光（真彩是「什么都没有」），白矮星/脉冲星的可见光也极弱。
    //    这里给的是「一眼分辨类型」的符号色，与太阳系那套 CIE 真彩不是一个体系。
    const COLOR = {
      bh: '#e879f9', blackhole: '#e879f9', psr: '#a5f3fc',
      wd: '#e8f4ff', whitedwarf: '#e8f4ff',
    };
    const rows = this.dataset.catalogObjectsOfLevel('neighborhood')
      .filter((b) => COLOR[b.type] && Number.isFinite(b.x));
    if (!rows.length) return;

    const pos = new Float32Array(rows.length * 3);
    const col = new Float32Array(rows.length * 3);
    const c = new THREE.Color();
    rows.forEach((b, i) => {
      pos[i * 3] = b.x; pos[i * 3 + 1] = b.y; pos[i * 3 + 2] = b.z;
      c.set(COLOR[b.type]);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // ⚠️ PointsMaterial 必须给 map，否则渲染成硬边方块（坑 1）
    this.compactPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.1, sizeAttenuation: true, vertexColors: true, transparent: true,
      opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
      map: makeGlowTexture('#ffffff', 0.3, 64), alphaTest: 0.01,
    }));
    this.compactPoints.frustumCulled = false;
    scene.add(this.compactPoints);
    this.compactCount = rows.length;

    /* 著名的单独 sprite + 标签 —— 点云里的点没有名字，用户点不到 */
    let notable = 0;
    for (const b of rows) {
      if (!b.notable) continue;
      const p = new THREE.Vector3(b.x, b.y, b.z);
      const spr = makeSprite({
        texture: makeGlowTexture(COLOR[b.type], 0.24, 128), size: 0.6, color: '#ffffff', opacity: 1,
      });
      spr.position.copy(p);
      spr.userData.bodyId = b.id;
      scene.add(spr);
      const d = Number.isFinite(b.distLy) ? `${b.distLy.toFixed(1)} 光年` : '距离未知';
      this.labels.add(b.id, {
        text: b.name, sub: `${b.typeLabel} · ${d}`,
        position: p, className: 'major',
        onClick: () => this.ctx.onSelect?.(b.id), priority: 7,
      });
      notable++;
    }
    this.compactNotable = notable;
  }

  update(_dt, _clock) {
    // 太阳与恒星本身不动；标签位置固定
    /* ⚠️ 这里原来有一个「每帧写 `ring.visible`」的循环（`exoSprites` 的「有行星」光环）。
     *   第 37 轮那个光环被整体删除，循环随之去掉 —— 连带的那个老毛病
     *   （「副作用型 setXxx 被每帧循环覆盖」，坑 84 / 108）也就不存在了。
     *   留这段注释是为了说明：**删掉一个可视化元素时，要把它在每帧循环里的那扇门一起拆掉**，
     *   否则下次有人加回对象就会继承一个「开关管不住」的空壳。 */
    // 系外行星：按相机距离懒加载 / 释放（内置迟滞带，避免边界反复建删）
    this.exoRenderer?.update(_dt || 0, this.camera);
    this.scaleLabel = (() => {
      const d = this.camera.position.distanceTo(this.controls?.target || new THREE.Vector3());
      return d < 10 ? `${(d * 63241).toFixed(0)} AU` : `${d.toFixed(d < 100 ? 1 : 0)} 光年`;
    })();
  }

  get scaleLabelText() { return this.scaleLabel || ''; }

  pick(ndc, raycaster) {
    // 点云拾取：投影所有具名恒星，取屏幕最近者
    const { w, h } = this.ctx.engine.size;
    const cam = this.camera;
    const v = new THREE.Vector3();
    let best = null, bestD = 26;
    for (const item of this.named) {
      v.copy(item.position).project(cam);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - (ndc.x * 0.5 + 0.5) * w, sy - (-ndc.y * 0.5 + 0.5) * h);
      if (d < bestD) { bestD = d; best = item; }
    }
    if (best) return { id: best.id, point: best.position.clone() };
    const hits = raycaster.intersectObjects([this.points], false);
    if (hits.length) {
      const i = hits[0].index;
      const row = this.dataset.stars[i];
      if (row) return { id: `star-${row[0]}`, point: hits[0].point };
    }
    return null;
  }

  defaultView() { return { position: [26, 20, 50], target: [0, 0, 0] }; }

  viewFor(id) {
    const b = this.dataset.get(id);
    if (!b) return this.defaultView();
    if (b.level === 'solar' && id === 'sun') return { position: [8, 6, 14], target: [0, 0, 0] };

    /* 系外行星（以及它的宿主星）：**必须贴到近处**，不能沿用恒星通用取景。
     * 通用取景的相机距离是 max(7, |p|·0.75) 光年，而系外行星系统的轨道半径
     * 只有 0.055–0.62 光年 —— 从 7 光年外看，整个行星系小得只有恒星光晕那么大，
     * 用户点「Proxima Cen b」会觉得"点了没反应"。 */
    if (b.type === 'exoplanet' || b.exo) {
      const host = b.type === 'exoplanet' ? (this.dataset.get(b.hostId) || b) : b;
      const p = new THREE.Vector3(host.x ?? 0, host.y ?? 0, host.z ?? 0);
      const aMax = Math.max(0.18, ...(((host.exo || {}).planets) || []).map((q) => auToOrbitRadius(q.semiMajorAu)));
      const d = aMax * 3.0;   // 最外轨道占视高的约 1/3，整圈进画面
      return { position: [p.x + d, p.y + d * 0.55, p.z + d], target: [p.x, p.y, p.z] };
    }

    const p = new THREE.Vector3(b.x ?? 0, b.y ?? 0, b.z ?? 0);
    const d = Math.max(7, Math.hypot(p.x, p.y, p.z) * 0.75);
    return { position: [p.x + d, p.y + d * 0.6, p.z + d], target: [p.x, p.y, p.z] };
  }

  focusById(id) {
    this.applyView(this.viewFor(id), { instant: false });
    // 聚焦到有行星的恒星时立刻建出它的行星系统 —— 用户点进来就是要看行星，
    // 不该等到下一帧的懒加载扫描（虽然只差一帧，但观感上是「点了没反应」）
    const b = this.dataset.get(id);
    // ⚠ 系外行星天体自己没有 starName：ExoplanetRenderer 是以**宿主星名**为键的，
    //   用 b.name（如「Proxima Cen d」）去查必然查不到，行星就建不出来。
    const starName = b?.type === 'exoplanet' ? b.hostStar : (b?.exo?.starName || b?.name);
    if (starName) this.exoRenderer?.ensure(starName);
    return true;
  }
  /**
   * 「轨道」开关在本层的实现。
   *
   * 它现在只管**一样**东西：系外行星的**轨道线**（`ExoplanetRenderer` 里按相机距离懒加载的那些）。
   * ⚠️ 第 36 轮以前它还管第二样 —— 「有行星」的**光环标记**（`exoSprites`，实测 4745 个）。
   *    那时把光环交给这个开关节制，是「用户想关掉它时开关是哑的」那个问题的最小修法；
   *    但第 37 轮用户对它的判词是「**恒星上也有，都去了**」⇒ 光环被整体删除，
   *    这个开关也就不再需要管它（**把用户要求删掉的东西留在开关后面，等于没删**）。
   */
  setOrbitsVisible(v) {
    const on = v !== false;
    this.orbitsVisible = on;
    this.exoRenderer?.setOrbitsVisible(on);
  }
  dispose() {
    this.exoRenderer?.dispose();
    this.exoRenderer = null;
  }
}

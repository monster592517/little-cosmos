/**
 * 层级 · 太阳系（单位：1 = 1 AU）
 *
 *  位置：全部由 Ephemeris（astronomy-engine / VSOP87 / ELP2000 / 木卫模型）实时计算，
 *        行星、月球、木卫、小行星在同一黄道 J2000 坐标系内，位置与真实天象对应。
 *        轨道线直接用真实位置采样一圈，因此天体永远落在自己画出的轨道上。
 *
 *  尺寸：默认「视觉增强」把半径按 r^0.45 压缩（否则行星是亚像素的点），
 *        卫星半径限制在母星半径的 34% 以内、轨道按比例放大，底栏可切回「真实比例」。
 */
import * as THREE from 'three';
import { Level } from '../core/engine.js';
import {
  makeStarBody, makePlanetBody, makeRingMesh, makeOrbitLine, makeStarfield,
  makeParticleBelt, makeSprite, disposeObject,
  makeEarthMaterial, makeSunMaterial, makeCloudMaterial, makeAsteroidGeometry,
} from '../objects/builders.js';
import { makeSpacecraftModel } from '../objects/spacecraft.js';
import { makeGlowTexture, makePlanetTexture, makePinTexture, mulberry,
  makeSaturnRingTexture, makeJupiterRingTexture, makeUranusRingTexture, makeNeptuneRingTexture,
} from '../proc/textures.js';
import { AU_KM } from '../data/solar-system.js';
import { julianDate } from '../util/kepler.js';

const R_EARTH = 6371;
const VISUAL = { base: 0.0145, exp: 0.45, moonCap: 0.42, moonBase: 0.0068 };
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/** 黄道坐标 → 场景坐标（three 的 Y 轴向上） */
function toScene(p, out = new THREE.Vector3()) {
  return out.set(p.x, p.z, -p.y);
}

export class SolarLevel extends Level {
  constructor(ctx, dataset) {
    super(ctx);
    this.id = 'solar';
    this.name = '太阳系';
    this.subtitle = '真实星历 · 八大行星 · 卫星 · 小行星带 · 柯伊伯带';
    this.dataset = dataset;
    this.eph = dataset.ephemeris;
    this.entries = new Map();        // id → { group, spin, r, kind, planet, marker }
    this.moonPivots = [];
    this.orbitLines = [];
    this.probeOrbits = [];
    this.probeTrails = [];
    this.trueScale = false;
    // 「这个层被整个重建了几次」——只给探针读，不参与渲染逻辑。
    // 为什么必须数它：切换真实比例曾经无条件触发一次全区重建，无论在不在这一层。
    // 而「重建了几次」是**结构事实**，比「花了多少毫秒」稳 —— 毫秒在软件渲染、
    // 内存吃紧的本机上抖得厉害，拿它当判据会时红时绿，最后没人再跑这个检查。
    this.rebuilds = 0;
    // trueScale 已经改了、但场景还没跟上（本层不是当前层时故意拖后重建）
    this._scaleStale = false;
    this.labelOptions = { maxDistance: 140 };
    this.controlsConfig = { minDistance: 0.0004, maxDistance: 320, rotateSpeed: 0.55, zoomSpeed: 1.2, panSpeed: 0.6 };
    this.follow = null;
    this._pathDate = 0;
  }

  /* ---------- 尺寸映射 ---------- */
  bodyRadius(km, isMoon = false, parentR = 0) {
    if (this.trueScale) return km / AU_KM;
    if (isMoon) {
      const raw = VISUAL.moonBase * Math.pow(km / 1737.4, 0.5);
      return Math.min(raw, parentR * VISUAL.moonCap, parentR * 0.9);
    }
    return VISUAL.base * Math.pow(km / R_EARTH, VISUAL.exp);
  }

  /** 卫星轨道显示半径（视觉模式按对数压缩，真实模式还原） */
  moonDisplayDist(moon, parentR, rank, list) {
    if (this.trueScale) return (moon.aKm ?? moon.orbitRadiusKm) / AU_KM;
    const a = Math.max(1, moon.aKm ?? moon.orbitRadiusKm ?? 1);
    const listA = (list || []).map((m) => Math.max(1, m.aKm ?? m.orbitRadiusKm ?? 1));
    const amin = Math.log(Math.min(...listA, a));
    const amax = Math.log(Math.max(...listA, a));
    const t = amax > amin ? (Math.log(a) - amin) / (amax - amin) : 0;
    return parentR * (2.4 + 3.4 * t);
  }

  /* ---------- 构建 ---------- */
  build() {
    const { scene, camera, ctx } = this;
    camera.near = 1e-5;
    camera.far = 2e6;
    camera.updateProjectionMatrix();

    // 场景重建（换 GPU / 从显存中卸载后重新进入）时，这些累计状态必须清空，
    // 否则天体、轨道线、卫星枢轴会被重复构建一遍
    this.entries = new Map();
    this.moonPivots = [];
    this.orbitLines = [];
    this.probeOrbits = [];
    this.probeTrails = [];
    this.clouds = [];
    // 这次 build 用的就是当前的 trueScale ⇒ 「口径已变、场景没跟上」这件事到此清零。
    // 忘了清的话，紧接着的 refreshIfStale() 会判定"还脏"，于是刚 build 完立刻又 rebuild 一遍。
    this._scaleStale = false;

    scene.add(new THREE.AmbientLight(0x44506a, 0.9));
    const sunLight = new THREE.PointLight(0xfff2dd, 3.4, 0, 0);
    scene.add(sunLight);
    this.sunLight = sunLight;

    this.starfield = makeStarfield({ count: 6000, radius: 30000, innerRadius: 0.6, size: 180, seed: 17 });
    scene.add(this.starfield);

    /* --- 太阳 --- */
    const sun = this.dataset.get('sun');
    const sunR = this.bodyRadius(sun.radiusKm);
    const sunObj = makeStarBody({ radius: sunR, texture: null, color: '#ffd76a', glowScale: 14, glowOpacity: 1 });
    const sunMesh = sunObj.getObjectByName('body');
    sunMesh.material.dispose();
    sunMesh.material = makeSunMaterial({ texture: ctx.texture(sun.texture) });
    sunObj.userData.bodyId = 'sun';
    scene.add(sunObj);
    this.sunObject = sunObj;
    this.sunR = sunR;
    // ⚠️ 必须显式带上 spinHours。消费端（update() 里那句 `e.spinHours ?? … ? 12 : 24`）
    //    漏掉它，太阳就会按**24 小时**自转 —— 而真实值是 609.12 小时（25.4 天），差 25 倍。
    //    太阳是这一批里错得最离谱的一个：它是唯一一个既没有 `planet` 也没有 `small` 的 entry，
    //    两条兜底路径都接不住它。
    this.entries.set('sun', { group: sunObj, spin: sunMesh, r: sunR, kind: 'star', spinHours: sun.rotationHours });
    this.labels.add('sun', {
      text: '太阳', sub: 'Sun', position: sunObj.position,
      className: 'major', onClick: () => this.ctx.onSelect?.('sun'), priority: 9,
    });

    /* --- 行星与矮行星 --- */
    for (const planet of [...this.#ofType('planet'), ...this.#ofType('dwarf')]) this.#buildPlanet(planet);

    /* --- 小天体 --- */
    for (const b of [...this.#ofType('asteroid'), ...this.#ofType('comet'), ...this.#ofType('tno')]) {
      this.#buildSmallBody(b);   // 全部建模；没有轨道数据的仍可查看模型
    }

    /* --- 探测器 --- */
    this.#buildProbes();

    /* --- 粒子带 --- */
    this.belt = makeParticleBelt({ count: 3200, inner: 2.06, outer: 3.32, thickness: 0.05, color: '#a89880', size: 0.006, seed: 5, tiltJitter: 0.14 });
    this.belt.userData.bodyId = 'asteroid-belt';
    scene.add(this.belt);
    this.kuiper = makeParticleBelt({ count: 7000, inner: 30, outer: 50, thickness: 0.045, color: '#7fa0c8', size: 0.05, seed: 9, tiltJitter: 0.9 });
    this.kuiper.userData.bodyId = 'kuiper-belt';
    scene.add(this.kuiper);
    this.trojans = makeParticleBelt({ count: 900, inner: 5.2, outer: 5.25, thickness: 0.02, color: '#a89478', size: 0.01, seed: 21, tiltJitter: 0.5 });
    this.trojans.userData.bodyId = 'trojan-jupiter';
    scene.add(this.trojans);

    this.oort = this.#makeOortShell();
    scene.add(this.oort);
    // 注：日球层顶与探测器体积远小于一个像素，按用户要求只在「目录」里列出，不在场景中绘制

    this.applyView(this.defaultView());
  }

  #ofType(t) { return [...this.dataset.bodies.values()].filter((b) => b.type === t); }
  #moonsOf(id) {
    return [...this.dataset.bodies.values()]
      .filter((b) => b.type === 'moon' && b.parent === id)
      .sort((a, b) => (a.aKm ?? 0) - (b.aKm ?? 0));
  }

  #buildPlanet(planet) {
    const { scene, ctx } = this;
    const r = this.bodyRadius(planet.radiusKm);
    const group = new THREE.Group();        // 只承载位置
    group.userData.bodyId = planet.id;
    const tilt = new THREE.Group();         // 自转轴姿态
    const spin = new THREE.Group();         // 自转相位
    group.add(tilt);
    tilt.add(spin);
    const moonsGroup = new THREE.Group();   // 卫星：不随行星自转，只随行星平移
    group.add(moonsGroup);

    let body;
    if (planet.id === 'earth') {
      const mat = makeEarthMaterial({
        day: ctx.texture(planet.texture),
        night: ctx.texture(planet.nightTexture),
        specular: ctx.texture(planet.specularTexture),
      });
      body = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 96, 48), mat);
      mesh.name = 'body';
      body.add(mesh);
      const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(r * 1.012, 72, 36),
        makeCloudMaterial({ texture: ctx.texture(planet.cloudsTexture), opacity: 0.55 }),
      );
      clouds.name = 'clouds';
      body.add(clouds);
      this.clouds = this.clouds || [];
      this.clouds.push(clouds);
      body.add(this.#atmosphereShell(r, '#5aa9ff', 1.06, 0.9));
    } else {
      body = makePlanetBody({
        radius: r,
        texture: planet.texture ? ctx.texture(planet.texture) : null,
        normal: planet.normalTexture ? ctx.texture(planet.normalTexture) : null,
        color: planet.color || '#9a9a9a',
        segments: 96,
        bump: planet.texture ? ctx.texture(planet.texture) : null,
        roughness: 0.92,
        atmosphere: planet.id === 'uranus' || planet.id === 'neptune' ? '#8fd0ff' : null,
        atmosphereIntensity: 0.30,
        atmospherePower: 4.2,
        tint: planet.id === 'neptune' ? '#9dc0e8' : null,
      });
    }
    body.userData.bodyId = planet.id;
    spin.add(body);

    if (planet.ring) {
      const scale = this.trueScale ? 1 : r / (planet.radiusKm / AU_KM);
      const inner = Math.max((planet.ring.innerKm / AU_KM) * scale, r * 1.25);
      const outer = (planet.ring.outerKm / AU_KM) * scale;
      /* ⚠️ 2026-10-11 视觉重做：环的**结构**按行星各画各的（四套真实结构纹理，
       *    见 `proc/textures.js` 那段总注释）。旧口径「土星一张图、其余全用
       *    通用程序环 + opacity 0.45」把天王星/海王星画成了土星级大亮环——
       *    而它们的环现实中暗到 1977 年才被发现。这里的 opacity 是**材质乘数**，
       *    各纹理自身的绝对亮度已经按实测反照率画好，这一层只做微调。 */
      const RING_STYLE = {
        saturn: { make: makeSaturnRingTexture, opacity: 0.96 },
        jupiter: { make: makeJupiterRingTexture, opacity: 0.35 },
        uranus: { make: makeUranusRingTexture, opacity: 0.72 },
        neptune: { make: makeNeptuneRingTexture, opacity: 0.55 },
      };
      const style = RING_STYLE[planet.id];
      spin.add(makeRingMesh({
        innerR: inner, outerR: outer,
        texture: style ? style.make() : (planet.ringTexture ? ctx.texture(planet.ringTexture) : null),
        color: planet.id === 'saturn' ? '#e8dcc0' : '#9fd3e8',
        opacity: style ? style.opacity : 0.45,
      }));
    }

    // 所有卫星都建模（全景 3D）；过小的只在凑近时才会被看到，标签按距离自动隐藏
    this.#buildMoons(planet.id, r, moonsGroup);

    scene.add(group);
    this.entries.set(planet.id, { group, tilt, spin, r, kind: planet.type, planet, phase: Math.random() * 6.28 });

    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(planet.color || '#b9a68c', 0.36, 64), color: planet.color || '#b9a68c', transparent: true,
      opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    marker.userData.minPx = planet.type === 'dwarf' ? 8 : 11;
    group.add(marker);
    this.entries.get(planet.id).marker = marker;

    const line = makeOrbitLine(this.eph.path(planet.id, new Date(), 320), { color: planet.color, opacity: 0.38 });
    line.userData.orbitOf = planet.id;
    this.orbitLines.push(line);
    scene.add(line);
    this._pathDate = julianDate(new Date());

    this.labels.add(planet.id, {
      text: planet.name, sub: planet.en, position: group.position,
      className: 'major', onClick: () => this.ctx.onSelect?.(planet.id), priority: 5,
    });
  }

  /** 给任意母天体建卫星（行星、矮行星、小天体通用） */
  #buildMoons(parentId, parentR, moonsGroup) {
    const moons = this.#moonsOf(parentId);
    moons.forEach((m, i) => {
      const mr = this.bodyRadius(m.radiusKm, true, parentR);
      const dist = this.moonDisplayDist(m, parentR, i, moons);
      const realA = (m.aKm ?? m.orbitRadiusKm) / AU_KM;
      const holder = new THREE.Group();
      holder.add(this.#buildMoonMesh(m, mr));
      moonsGroup.add(holder);
      // 标签/拾取用世界坐标（与 holder 的局部坐标分开，避免互相覆盖）
      const world = new THREE.Vector3();
      this.moonPivots.push({ moon: m, holder, dist, scale: dist / realA, world });
      this.labels.add(m.id, {
        text: m.name.split(' · ')[0], position: world, className: 'dim',
        onClick: () => this.ctx.onSelect?.(m.id), priority: 2,
        maxDist: m.hidden ? 0.35 : null,   // 过小的卫星只在贴近时显示名字
      });
    });
  }

  #buildMoonMesh(m, mr) {
    const { ctx } = this;
    const preset = m.tex || {};
    const mode = preset.mode || 'cratered';
    const tex = m.texture
      ? ctx.texture(m.texture)
      : makePlanetTexture({
        base: preset.base || m.color || '#9a9a9a',
        accent: preset.accent || '#6a6a6a',
        mode,
        seed: (m.id.charCodeAt(0) * 37 + m.id.length * 11) % 9973,
        size: [256, 128], scale: 3.4, octaves: 5,
      });
    const normal = m.normalTexture ? ctx.texture(m.normalTexture) : null;
    // LOD：越小的天体用越少的面，保证全部建模后依然流畅
    // ⚠️ 2026-10-11：与 #buildSmallBody 同步提档（下限 2、中档 3）——
    //    detail 1 的 80 面骰子观感在小卫星上同样存在。
    const seg = mr > 0.004 ? 48 : mr > 0.0012 ? 24 : 12;
    const geo = m.shape
      ? makeAsteroidGeometry({ radius: mr, shape: m.shape, seed: m.id.length * 13 + 7, detail: mr > 0.002 ? 3 : 2 })
      : new THREE.SphereGeometry(mr, seg, seg / 2);
    const matOpts = {
      map: tex, roughness: 0.95, metalness: 0.0, bumpMap: tex, bumpScale: 0.5,
    };
    if (normal) { matOpts.normalMap = normal; matOpts.normalScale = new THREE.Vector2(0.85, 0.85); }
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(matOpts));
    mesh.name = 'body';
    mesh.userData.bodyId = m.id;
    return mesh;
  }

  #atmosphereShell(r, color, scale, intensity) {
    return new THREE.Mesh(
      new THREE.SphereGeometry(r * scale, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: { glowColor: { value: new THREE.Color(color) }, intensity: { value: intensity } },
        vertexShader: `varying vec3 vNormal; varying vec3 vPos;
          void main(){ vNormal = normalize(normalMatrix * normal); vPos = (modelViewMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 glowColor; uniform float intensity; varying vec3 vNormal; varying vec3 vPos;
          void main(){ vec3 viewDir = normalize(-vPos); float rim = 1.0 - max(dot(viewDir, vNormal), 0.0);
            gl_FragColor = vec4(glowColor, pow(rim, 2.6) * intensity); }`,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
  }

  #buildSmallBody(b) {
    const { scene } = this;
    const group = new THREE.Group();          // 探测器可挂靠、聚焦可用
    group.userData.bodyId = b.id;
    scene.add(group);

    const major = (b.radiusKm ?? 0) >= 100;   // 较大的才画轨道线 / 常驻标签
    const r = this.trueScale ? b.radiusKm / AU_KM : Math.max(0.0016, 0.004 * Math.pow(b.radiusKm / 100, 0.4));
    /* ⚠️ 2026-10-11：detail 下限 1 → **2**、特写档 3 → **4**。
     *    旧口径下哈雷（r≈0.0016）落到 detail 1 = **80 面**，画面上就是个 d20 骰子
     *    （实拍 shots/opt-before/B-halley.png，轮廓多边形肉眼可见）。
     *    ★ 首轮验收后再提一档：detail 2（320 面）在强位移 fbm 下仍有棱面感，
     *      小天体下限统一 **3**（1280 面）—— 全场景 ~90 个小天体也就 ~12 万面，不心疼。
     *      detail 4 留给 r > 0.003 的特写档。 */
    const detail = r > 0.003 ? 4 : 3;
    const geo = makeAsteroidGeometry({ radius: r, shape: b.shape || 'irregular', seed: b.id.length * 31 + 5, detail });
    const tex = b.texture ? this.ctx.texture(b.texture) : makePlanetTexture({
      base: b.color || '#9a8f80', accent: '#5a5048', mode: b.type === 'comet' ? 'sponge' : 'cratered',
      size: [256, 128], scale: 5, seed: b.id.length * 37 + 5,
    });
    const normal = b.normalTexture ? this.ctx.texture(b.normalTexture) : null;
    /* ⚠️ 2026-10-11：彗核材质乘色压到半亮。彗核是太阳系最暗的天体之一
     *    （哈雷反照率 **0.04**，数据面板自己写着），但场景里 PointLight 强度 3.4
     *    会把中灰贴图整体洗亮一档 —— 乘 0.5 补回「黑如煤炭」的实测观感。
     *    小行星/半人马小行星不压：它们的反照率（0.1–0.4）本来就比彗核高。 */
    const smallOpts = { map: tex, roughness: 0.96, bumpMap: tex, bumpScale: 0.6,
      color: b.type === 'comet' ? 0x8c8c8c : 0xffffff };
    if (normal) { smallOpts.normalMap = normal; smallOpts.normalScale = new THREE.Vector2(1.0, 1.0); }
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(smallOpts));
    mesh.name = 'body';
    mesh.userData.bodyId = b.id;
    group.add(mesh);

    /* --- 彗星活动结构：彗发 + 尘埃尾 + 离子尾（2026-10-11 补） ---
     *
     * 为什么必须补：彗星在现实里不是一块石头——接近太阳时挥发物形成彗发，
     * 尘埃尾（弯、暖白）与离子尾（直、蓝）**永远背向太阳**（太阳风/辐射压吹的，
     * 不是沿轨道向后）。数据面板自己都印着「无活动彗发表面，参考下方影像」——
     * 模型只有核，正是用户报的「与现实不符」最直的一处。
     *
     * 口径：
     *   · 活性 ∝ 1/r²（挥发通量的物理标度），**r₀ = 5 AU 截断**——
     *     彗星显著活动的实测上界量级（哈雷在 ~5 AU 外就是惰性脏雪球）。
     *     现在哈雷在 35 AU ⇒ act≈0.02，彗发/尾几乎不可见 —— **这是对的**，
     *     想看尾巴把时间推到近日点（面板里有日期）。
     *   · 尾长 = 核视觉半径的 ~20–26 倍：真实尾巴能拖 0.5 AU+，但那样聚焦核时
     *     整个画面都是尾 —— 取「聚焦时占画面大半」的折中。
     *   · 尾轴 = +Z，`update()` 每帧把 +Z 对准「核 → 背向太阳」方向。
     */
    let coma = null, tail = null, dustMat = null, ionMat = null;
    if (b.type === 'comet') {
      /* ⚠️ 彗发直径必须 **小于取景距离**（#frameDistance = r·3.7）：首版给了 r·6 起、
       *    活性满档 r·12.6 —— 相机被包进光晕里，整个画面糊成一片蓝灰
       *    （实拍 shots/verify-halley-perihelion.png 首版）。压到满档 ≈2.6r 直径。 */
      coma = makeSprite({
        texture: makeGlowTexture('#cfe8ff', 0.55, 128), size: r * 1.6,
        color: '#dff0ff', opacity: 0,
      });
      group.add(coma);
      tail = new THREE.Group();
      const cRnd = mulberry(b.id.length * 17 + 3);
      /* ⚠️ 坐标单位 = **核视觉半径 r**（不是 AU！）。首版忘了乘 r，粒子撒在
       *    0–20 AU 处 —— 全在取景框外几十亿公里外，画面上一根毛都看不见。 */
      // 尘埃尾：扇形 + 沿程弯曲（滞后）。⚠️ 粒子要**小而密、束要窄**：
      //    首版大而少（r·1.6×240）= 一串棉花球；二版 r·0.55 仍偏肥。
      //    现口径 r·0.26 × N=560、半角收窄 —— 读成连续的尾流，不是一坨坨泡。
      const ND = 700;
      const dpos = new Float32Array(ND * 3);
      for (let i = 0; i < ND; i++) {
        /* ⚠️ s 分布：指数 >1 = **近端密、远端疏**（尘埃在彗发处最浓，向外稀释）。
         *    首版 0.75 的指数把密度倒过来 ⇒ 近 nucleus 段只有稀疏几个大泡，
         *    读成「珠串」。 */
        const s = Math.pow(cRnd(), 1.5);
        const lat = (cRnd() - 0.5) * (0.24 + 1.3 * s) * r;
        const lat2 = (cRnd() - 0.5) * (0.24 + 1.3 * s) * r;
        dpos[i * 3] = lat + 2.6 * s * s * r;       // +X 弯曲 = 滞后
        dpos[i * 3 + 1] = lat2;
        dpos[i * 3 + 2] = s * 20 * r;              // 轴向长度 ~20 r
      }
      const dgeo = new THREE.BufferGeometry();
      dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
      dustMat = new THREE.PointsMaterial({
        size: r * 0.26, sizeAttenuation: true, color: '#f2e6c8', transparent: true,
        opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
        map: makeGlowTexture('#ffffff', 0.5, 64), alphaTest: 0.01,   // 必须给 map（坑 1）
      });
      const dust = new THREE.Points(dgeo, dustMat);
      dust.frustumCulled = false;
      tail.add(dust);
      // 离子尾：直、细、蓝（N=340、r·0.18、束更窄 —— 同「小而密」口径）
      const NI = 420;
      const ipos = new Float32Array(NI * 3);
      for (let i = 0; i < NI; i++) {
        const s = Math.pow(cRnd(), 1.4);           // 同尘埃尾：近端密远端疏
        const lat = (cRnd() - 0.5) * (0.08 + 0.5 * s) * r;
        const lat2 = (cRnd() - 0.5) * (0.08 + 0.5 * s) * r;
        ipos[i * 3] = lat;
        ipos[i * 3 + 1] = lat2;
        ipos[i * 3 + 2] = s * 26 * r;
      }
      const igeo = new THREE.BufferGeometry();
      igeo.setAttribute('position', new THREE.BufferAttribute(ipos, 3));
      ionMat = new THREE.PointsMaterial({
        size: r * 0.18, sizeAttenuation: true, color: '#8fb8ff', transparent: true,
        opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
        map: makeGlowTexture('#ffffff', 0.5, 64), alphaTest: 0.01,
      });
      const ion = new THREE.Points(igeo, ionMat);
      ion.frustumCulled = false;
      tail.add(ion);
      group.add(tail);
    }
    // ⚠️ 同样必须带上 spinHours。`small-bodies.js` 里躺着 **86 个真实自转周期**
    //    （灶神星 5.342h、Mathilde 417.7h、哈雷彗星 52.8h…），只要不带，
    //    它们全部按兜底的 12 小时转 —— 数据在，但没人读。
    this.entries.set(b.id, { group, spin: mesh, r, kind: b.type, small: true, spinHours: b.rotationHours,
      coma, tail, dustMat, ionMat });

    // 小天体也有卫星（创卫一、亡卫一、萨卫一…）
    const moonsGroup = new THREE.Group();
    group.add(moonsGroup);
    this.#buildMoons(b.id, r, moonsGroup);

    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(b.color || '#b9a68c', 0.34, 64), color: b.color || '#b9a68c',
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    marker.userData.minPx = 6;
    group.add(marker);
    this.entries.get(b.id).marker = marker;

    if (major && b._orbit) {
      const line = makeOrbitLine(b._orbit.sample(512), { color: b.color || '#8fd3e8', opacity: 0.09 });
      line.userData.orbitOf = b.id;
      this.orbitLines.push(line);
      scene.add(line);
    }

    this.labels.add(b.id, {
      text: b.name.split('（')[0], position: group.position, className: 'dim',
      onClick: () => this.ctx.onSelect?.(b.id),
      priority: (b.radiusKm ?? 0) >= 300 ? 0 : -1,
      maxDist: (b.radiusKm ?? 0) >= 300 ? 12 : 6,   // 小天体只在凑近时显示标签，避免全景图堆满文字
    });
  }

  /* ---------- 探测器 ---------- */
  /** 探测器在场景中挂在哪个父对象下 */
  #probeParent(p) {
    if (!p.host) return null;
    const host = this.dataset.get(p.host);
    if (!host) return null;
    if (host.type === 'moon') {
      const mp = this.moonPivots.find((m) => m.moon.id === host.id);
      return mp ? mp.holder : null;
    }
    const e = this.entries.get(host.id);
    return e ? e.group : null;
  }

  /** 母天体在场景中的视觉半径 */
  #visualRadius(id) {
    const e = this.entries.get(id);
    if (e) return e.r;
    const mp = this.moonPivots.find((m) => m.moon.id === id);
    if (mp) return this.bodyRadius(mp.moon.radiusKm, true, this.entries.get(mp.moon.parent)?.r || 0.02);
    const b = this.dataset.get(id);
    return b ? Math.max(1e-4, this.bodyRadius(b.radiusKm)) : 1e-3;
  }

  #probeMarker(color) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(color, 0.42, 64), color,
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    s.userData.minPx = 5;   // 2026-10-17：7 → 5，远景十几个探测器光点重叠时不至于糊成一片
    return s;
  }

  #buildProbes() {
    const { scene } = this;
    const probes = [...this.dataset.bodies.values()].filter((b) => b.type === 'probe');
    for (const p of probes) {
      const parent = this.#probeParent(p);
      if (p.mode === 'heliocentric' || !parent) { this.#buildHeliocentricProbe(p); continue; }

      const color = p.color || '#ff9a5c';
      const group = new THREE.Group();
      group.userData.bodyId = p.id;
      const marker = this.#probeMarker(color);
      group.add(marker);
      parent.add(group);

      const host = this.dataset.get(p.host);
      const realR = (host.radiusKm ?? 1000) / AU_KM;
      let displayScale = 1;
      let pin = null;
      if (p.mode === 'landed') {
        displayScale = this.#visualRadius(host.id) / realR;
        // 着陆点标记：始终朝向相机的十字准星（不写深度，保证在球面上可见）
        pin = new THREE.Sprite(new THREE.SpriteMaterial({
          map: makePinTexture(color, 128), color: '#ffffff',
          transparent: true, opacity: 0.95, depthWrite: false, depthTest: false,
        }));
        pin.userData.minPx = 11;   // 2026-10-18：16 → 11（火星 6 个着陆器里好奇/洞察只差 9.2°，16px 十字必重叠）
        group.add(pin);
      } else if (p.mode === 'orbit') {
        const aKm = p.orbitKm?.aKm || 1e6;
        const k = Math.min(1, Math.max(0, Math.log10(aKm / 1e5) / 2.5));
        const hr = this.#visualRadius(host.id);
        const dist = hr * (1.9 + 3.6 * k);
        displayScale = dist / (aKm / AU_KM);
        p._displayDist = dist;
        // 轨道线（跟随母天体）
        const e = Math.min(0.9, p.orbitKm?.e ?? 0);
        const pts = new Float32Array(193 * 3);
        for (let i = 0; i <= 192; i++) {
          const t = (i / 192) * Math.PI * 2;
          const rr = dist * (1 - e * Math.cos(t));
          pts[i * 3] = Math.cos(t) * rr;
          pts[i * 3 + 1] = 0;
          pts[i * 3 + 2] = Math.sin(t) * rr;
        }
        const line = makeOrbitLine(pts, { color, opacity: 0.34 });
        parent.add(line);
        this.probeOrbits.push(line);
      } else if (p.mode === 'ended') {
        /* ⚠️ 任务结束的探测器不能停在母天体中心：update() 的 local 分支给它算出的
         *    偏移恒为零（`probeHelio('ended')` 直接返回母天体位置），而母天体中心
         *    正好是行星模型内部——模型放进去等于看不见。给它一个**纪念轨道**偏移：
         *    按 id 稳定的方位角停在 2×母星视觉半径处（确定性，不随帧漂）。 */
        const hr = this.#visualRadius(host.id);
        const ang = ((p.id.charCodeAt(0) * 7 + p.id.length * 13) % 360) * Math.PI / 180;
        p._parkOffset = new THREE.Vector3(Math.cos(ang) * hr * 2.0, hr * 0.35, Math.sin(ang) * hr * 2.0);
      }

      /* --- 三维构型建模（2026-10-11）：按真实构型参数化拼装 ---
       * 尺寸口径：host 类探测器 = 母星视觉半径 × 0.04（2026-10-17 从 0.11 下调：
       * 0.11 时模型相当于母星半径的 11%，远景一堆探测器把内太阳系糊成一团；
       * 0.04 仍保证「凑近看得清」，同时远景噪点大幅减少。形状因子与构型出自
       * `objects/spacecraft.js` 的 PRESETS（唯一真源）。 */
      const hrAll = this.#visualRadius(p.host);
      const modelSize = Math.min(6e-3, Math.max(8e-4, hrAll * 0.04));
      const model = makeSpacecraftModel({ preset: p.model || 'orbiter', color, size: modelSize });
      model.name = `probe-${p.id}`;
      group.add(model);

      p._displayScale = displayScale;
      p._modelSize = modelSize;
      const world = new THREE.Vector3();
      this.entries.set(p.id, { group, r: 0, kind: 'probe', probe: p, marker, pin, model, modelSize, local: true, world });
      this.labels.add(p.id, {
        text: p.name, sub: p.mode === 'landed' ? '着陆点' : '',
        position: world, className: 'dim',
        onClick: () => this.ctx.onSelect?.(p.id),
        /* 2026-10-17：探测器标签只在近景显示。
         * 默认视野 16 AU 时内太阳系（0.4–1.7 AU 的帕克/贝皮/SOHO/JUICE…）在屏幕上
         * 只占 ~30 px，十几个探测器标签叠成一团 → 观感像「探测器全贴在太阳上」。
         * 位置数据本身是对的（旅行者 173 AU 就在视野外）；这是呈现层的取舍：
         * 视距 > 4.5 场景单位时不显示探测器名，只剩小光点；放大到内太阳系再出现。
         * priority 归 0 让它在远景排序中天然让位给行星标签（PRIORITY_SLACK 不再放大距离）。 */
        priority: 0, maxDist: 4.5,
      });
    }
  }

  /** 日心飞行探测器：真实位置 + 飞行轨迹 + 构型建模 */
  #buildHeliocentricProbe(p) {
    const { scene, ctx } = this;
    const color = p.color || '#ff9a5c';
    const group = new THREE.Group();
    group.userData.bodyId = p.id;
    const marker = this.#probeMarker(color);
    marker.userData.minPx = 9;
    group.add(marker);
    /* 构型建模（2026-10-11）：日心探测器没有母星可借比例，取固定 0.004 AU
     * （≈ 60 万公里——被夸张了三个数量级，但这是「看得见」与「不喧宾夺主」
     * 之间的既定折中，与行星的视觉增强口径一致）。 */
    const model = makeSpacecraftModel({ preset: p.model || 'observatory', color, size: 0.004 });
    model.name = `probe-${p.id}`;
    group.add(model);
    scene.add(group);
    const world = new THREE.Vector3();
    this.entries.set(p.id, { group, r: 0, kind: 'probe', probe: p, marker, model, world });
    this.labels.add(p.id, {
      text: p.name, position: world, className: 'dim',
      onClick: () => this.ctx.onSelect?.(p.id),
      /* 2026-10-17：内太阳系的日心探测器（帕克/SOHO/SDO/贝皮…）与 host 探测器同病：
       * 16 AU 视野下挤在太阳 30px 内，标签糊成一团。视距 > 4.5 时不显示，
       * 放大到内太阳系再出现。远日探测器（旅行者 172 AU / 新视野 66 AU）例外——
       * 它们天然分散，拉远视野找它们时正需要名字。 */
      priority: (p.helio?.au ?? 0) > 10 ? 1 : 0,
      maxDist: (p.helio?.au ?? 0) > 10 ? null : 4.5,
    });

    // 轨迹：发射 → 各次引力弹弓/飞掠 → 当前位置
    const wp = (p.waypoints || []).map((w) => ({ body: w.body, date: new Date(w.date) }));
    const date = ctx.clock?.date || new Date();
    wp.push({ probe: true, date });
    if (wp.length < 2) return;
    const pts = [];
    for (const w of wp) {
      const pos = w.probe ? this.eph.helio(p.id, w.date) : this.eph.helio(w.body, w.date);
      if (!pos) continue;
      const v = toScene(pos, new THREE.Vector3());
      if (pts.length && v.distanceTo(pts[pts.length - 1]) < 1e-6) continue;
      pts.push(v);
    }
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
    const sampled = curve.getPoints(240);
    const flat = new Float32Array(sampled.length * 3);
    sampled.forEach((v, i) => { flat[i * 3] = v.x; flat[i * 3 + 1] = v.y; flat[i * 3 + 2] = v.z; });
    const line = makeOrbitLine(flat, { color, opacity: 0.42 });
    line.userData.probeTrail = p.id;
    scene.add(line);
    this.probeTrails.push(line);
  }

  #makeOortShell() {
    const count = 6000;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = 2000 + Math.pow(Math.random(), 0.6) * 6000;
      pos[i * 3] = Math.cos(th) * s * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = Math.sin(th) * s * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 8, color: 0x9ec5ff, transparent: true, opacity: 0.35, sizeAttenuation: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
      // 必须给 map：没有贴图的点会被画成硬边方块
      map: makeGlowTexture('#9ec5ff', 0.5, 64), alphaTest: 0.01,
    }));
    pts.userData.bodyId = 'oort-cloud';
    return pts;
  }

  /* ---------- 每帧：真实位置 ---------- */
  worldPerPixel(dist) {
    const h = this.ctx.engine.size.h || 900;
    return (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
  }

  update(dt, clock) {
    if (!clock) return;
    const date = clock.date;
    const jd = clock.jd;
    const now = performance.now() / 1000;

    if (this.sunObject) {
      const sm = this.sunObject.getObjectByName('body');
      sm.rotation.y = ((jd - 2451545) * 2 * Math.PI) / 25.38;
      if (sm.material.uniforms) sm.material.uniforms.time.value = now;
      // 太阳辉光随相机距离收缩：否则凑近内行星时整屏都是太阳的光晕，把天体挡住
      const sunDist = this.camera.position.length();
      const k = Math.min(1, Math.max(0.1, sunDist / 14));
      const halo = this.sunObject.getObjectByName('glow');
      const outer = this.sunObject.getObjectByName('glow-outer');
      if (halo && this.sunR) halo.scale.setScalar(this.sunR * 14 * k);
      if (outer && this.sunR) outer.scale.setScalar(this.sunR * 39.2 * k);
    }

    // 背景星空极缓慢漂移 + 轻微明暗呼吸，让画面不再呆板
    if (this.starfield) {
      this.starfield.rotation.y += dt * 0.0009;
      this.starfield.material.opacity = 0.82 + Math.sin(now * 0.5) * 0.08;
    }

    for (const [id, e] of this.entries) {
      if (id === 'sun') continue;
      let pos;
      if (e.local && e.probe?.host) {
        const realHost = toScene(this.eph.helio(e.probe.host, date), _v.clone());
        const realProbe = toScene(this.eph.helio(id, date), _v2.clone());
        let local = realProbe.sub(realHost).multiplyScalar(e.probe._displayScale || 1);
        /* orbit 探测器：**把位置压到它自己的轨道线上**。
         * 2026-10-18 修：原实现用「真实偏移 × _displayScale」，而轨道线半径是
         * `dist = hr(1.9+3.6k)` 压缩值 ⇒ 两者不同步：朱诺号远木点时被放飞到木星
         * 视觉半径的 ~69 倍处（轨道线只有 4.6 倍），近木点才回到线上 —— 观感就是
         * 「探测器脱离了轨道、贴着木星/远在天边」。现在保留方向、统一用 dist 定长。 */
        if (e.probe.mode === 'orbit' && e.probe._displayDist && local.lengthSq() > 1e-18) {
          local = local.clone().normalize().multiplyScalar(e.probe._displayDist);
        }
        // 任务结束：星历给到的偏移恒为零（会停在行星中心），覆盖成纪念轨道偏移
        if (e.probe._parkOffset) local.copy(e.probe._parkOffset);
        e.group.position.copy(local);
        /* 着陆探测器：**先沿法线抬出半个模型高，再立起来**。
         * 2026-10-17 修：原实现把模型中心放在 1.02R 球面上，而模型尺寸曾是母星
         * 视觉半径的 11% ⇒ 模型一半以上嵌在球体内部，看上去「探测器和星体贴在一起」。
         * 现在 local 长度 = 表面距离 + 0.55×模型尺寸，模型底沿正好落在表面外侧。 */
        if (e.model && e.probe.mode === 'landed' && local.lengthSq() > 1e-18) {
          const len = local.length();
          const lift = (e.modelSize || 0.001) * 0.55;
          local.multiplyScalar((len + lift) / len);
          e.group.position.copy(local);
          e.model.quaternion.setFromUnitVectors(UP, local.clone().normalize());
        }
        /* 着陆点十字标记：**只在近景显示**。
         * 2026-10-18：远景时火星上的 6 个着陆器（好奇/洞察只差 9.2°）的 11px 十字会
         * 叠成一坨 —— 相机离该探测器的距离超过母星视觉半径的 25 倍就隐藏，
         * 放大到行星附近才出现（位置、标签仍正常）。 */
        if (e.pin && e.probe.mode === 'landed') {
          const hostR = this.#visualRadius(e.probe.host);
          const camD = this.camera.position.distanceTo(this.#hostWorld(e.probe.host).add(local));
          e.pin.visible = camD < hostR * 25;
        }
        pos = this.#hostWorld(e.probe.host).add(local);
      } else {
        pos = toScene(this.eph.helio(id, date), _v.clone());
        e.group.position.copy(pos);
      }

      // 自转周期优先级：显式 spinHours（太阳 / 小天体）→ 行星数据对象 → 兜底。
      // ⚠️ 兜底那两个数（12 / 24）是**编的**，只该在真的没有观测数据时兜一下；
      //    本轮修 bug 的原因就是它们被当成了主力 —— 见上面两处 entries.set 的注释。
      const rotHours = e.spinHours ?? e.planet?.rotationHours ?? (e.small ? 12 : 24);
      if (e.spin && rotHours) e.spin.rotation.y = ((jd - 2451545) * 24 * 2 * Math.PI) / rotHours;
      if (e.planet && e.tilt) {
        const pole = this.eph.poleOf(id, date);
        _q.setFromUnitVectors(UP, _v.set(pole.x, pole.z, -pole.y).normalize());
        e.tilt.quaternion.copy(_q);
      }

      /* 彗星活动结构（口径见 #buildSmallBody 那段）：尾轴永远背向太阳，
       * 亮度/长度按 1/r² 活性缩放，r₀ = 5 AU 截断。太阳在本场景的原点。 */
      if (e.tail) {
        _qt.setFromUnitVectors(AXIS_Z, _v2.copy(e.group.position).normalize());
        e.tail.quaternion.copy(_qt);
        const rr = Math.max(1e-6, e.group.position.length());
        const act = Math.min(1, Math.pow(5 / rr, 2));
        e.tail.scale.set(1, 1, 0.5 + 2.5 * act);
        if (e.dustMat) e.dustMat.opacity = 0.50 * act;
        if (e.ionMat) e.ionMat.opacity = 0.38 * act;
        if (e.coma) {
          e.coma.material.opacity = 0.75 * act;
          e.coma.scale.setScalar(e.r * 1.6 * (0.5 + 1.1 * act));
        }
      }

      const el = this.labels.get(id);
      if (el) el._data.position.copy(pos);

      if (e.marker) {
        const d = this.camera.position.distanceTo(pos);
        const wpp = this.worldPerPixel(Math.max(d, 1e-6));
        const pulse = 1 + Math.sin(now * 1.6 + (e.phase ?? 0)) * 0.07;
        e.marker.scale.setScalar(Math.max(e.r * 1.25, e.marker.userData.minPx * 2 * wpp) * pulse);
        e.marker.material.opacity = d > 0.5 ? 0.75 + Math.sin(now * 1.6 + (e.phase ?? 0)) * 0.2 : 0.3;
      }
      if (e.pin) {
        const d = this.camera.position.distanceTo(pos);
        const wpp = this.worldPerPixel(Math.max(d, 1e-6));
        e.pin.scale.setScalar(e.pin.userData.minPx * 2 * wpp);
      }
    }

    for (const m of this.moonPivots) {
      const off = this.eph.satelliteOffset(m.moon, date);
      toScene(off, _v).multiplyScalar(m.scale);   // 相对母星的显示偏移
      m.holder.position.copy(_v);
      const parent = this.entries.get(m.moon.parent);
      if (parent) _v.add(parent.group.position);
      m.world.copy(_v);                            // 世界坐标（标签/拾取）
    }

    for (const c of this.clouds || []) c.rotation.y += dt * 0.01;

    // 相机动画：视角切换 / 聚焦天体时的平滑过渡
    // ⚠️ 推进 `_tween` 的那段循环**已搬进 `Level.tickTween()`**，由 `Engine._frame()`
    //    每帧调用 —— 原因见那边：六个子类**没有一个**调 `super.update()`，
    //    过渡推进留在子类里就等于「只有太阳系这一层有视角过渡」，其余五层点了没反应。
    //    这里只保留原来那条语义：**过渡进行中不跟随天体**。
    if (!this._tween && this.follow && this.controls) {
      // 跟随：把相机与目标一起平移，保持取景不变（时间加速时目标移动很快，
      // 单纯 lerp 目标会让天体跑出画面）
      const fe = this.entries.get(this.follow);
      const fp = fe?.probe;
      // 着陆/坠毁的探测器：跟的是母天体中心（否则天体会被挤到画面外），着陆点由标记标出
      const t = (fp && fp.host && (fp.mode === 'landed' || fp.mode === 'ended')) ? this.#hostWorld(fp.host)
        : fp ? this.#probeWorld(fp, date)
          : fe ? fe.group.position
            : this.moonPivots.find((m) => m.moon.id === this.follow)?.world;
      if (t) {
        if (!this._followPrev) this._followPrev = t.clone();
        _v3.copy(t).sub(this._followPrev);
        this.camera.position.add(_v3);
        this.controls.target.add(_v3);
        this._followPrev.copy(t);
      }
    }

    if (Math.abs(jd - this._pathDate) > 400) this.refreshPaths(date);

    this.scaleLabel = this.#scaleLabel();
  }

  /** 用真实位置重新采样行星轨道线（保证天体永远落在线上） */
  refreshPaths(date = new Date()) {
    this._pathDate = julianDate(date);
    for (const line of this.orbitLines) {
      const id = line.userData.orbitOf;
      const b = this.dataset.get(id);
      if (!b || b.type === 'moon') continue;
      const pts = this.eph.path(id, date, 320);
      if (!pts?.length) continue;
      line.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      line.geometry.computeBoundingSphere();
    }
  }

  #scaleLabel() {
    const d = this.camera.position.distanceTo(this.controls?.target || new THREE.Vector3());
    if (d < 0.002) return `${(d * AU_KM).toFixed(0)} km`;
    if (d < 0.4) return `${((d * AU_KM) / 1e4).toFixed(0)} 万 km`;
    if (d < 400) return `${d.toFixed(d < 10 ? 2 : 1)} AU`;
    return `${(d / 63241).toFixed(3)} 光年`;
  }

  get scaleLabelText() { return this.scaleLabel || ''; }

  /* ---------- 拾取：屏幕空间最近天体（小到看不见也能点中） ---------- */
  pick(ndc, raycaster) {
    const { w, h } = this.ctx.engine.size;
    const cam = this.camera;
    const mx = (ndc.x * 0.5 + 0.5) * w;
    const my = (-ndc.y * 0.5 + 0.5) * h;
    const v = new THREE.Vector3();
    let best = null, bestScore = Infinity;

    const consider = (id, pos, radiusWorld) => {
      v.copy(pos).project(cam);
      if (v.z > 1 || v.z < -1) return;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const dpx = Math.hypot(sx - mx, sy - my);
      const dist = cam.position.distanceTo(pos);
      const appPx = radiusWorld / this.worldPerPixel(Math.max(dist, 1e-6));
      const threshold = Math.max(18, appPx * 1.6 + 6);
      if (dpx > threshold) return;
      const score = dpx / threshold - Math.min(0.45, appPx / 60);
      if (score < bestScore) { bestScore = score; best = { id, point: pos.clone() }; }
    };

    for (const [id, e] of this.entries) {
      const pos = (e.local && e.probe) ? this.#probeWorld(e.probe, this.ctx.clock?.date || new Date()) : e.group.position;
      consider(id, pos, e.r);
    }
    for (const m of this.moonPivots) if (m.world) consider(m.moon.id, m.world, 0.01);

    if (!best) {
      for (const [id, mesh] of [['asteroid-belt', this.belt], ['kuiper-belt', this.kuiper], ['trojan-jupiter', this.trojans], ['oort-cloud', this.oort]]) {
        const hit = raycaster.intersectObject(mesh, false);
        if (hit.length) { best = { id, point: hit[0].point }; break; }
      }
    }
    return best;
  }

  /* ---------- 视角 ---------- */
  defaultView() { return { position: [0, 6.5, 15], target: [0, 0, 0] }; }

  viewPreset(name) {
    const jup = this.entries.get('jupiter')?.group.position;
    const earth = this.entries.get('earth')?.group.position;
    switch (name) {
      case 'inner': return { position: [0, 2.2, 4.6], target: [0, 0, 0] };
      case 'outer': return { position: [0, 22, 52], target: [0, 0, 0] };
      case 'belt': return { position: [0, 2.2, 4.8], target: [0, 0, 0] };
      case 'kuiper': return { position: [0, 26, 60], target: [0, 0, 0] };
      case 'earth': return earth ? { position: [earth.x + 0.075, earth.y + 0.045, earth.z + 0.1], target: [earth.x, earth.y, earth.z] } : this.defaultView();
      case 'jupiter': return jup ? { position: [jup.x + 1.0, jup.y + 0.55, jup.z + 1.3], target: [jup.x, jup.y, jup.z] } : this.defaultView();
      default: return this.defaultView();
    }
  }

  /**
   * 平滑移动相机到指定视角 —— **实现在基类**（`Level.tweenTo`）。
   *
   * ⚠️ 这里原先有一份自己的实现。删掉的原因是它引出了一个跨 5 个层级的静默故障：
   *    这个方法只存在于本文件，而 `main.js::setView()` 对**所有层级**都调
   *    `lv.tweenTo(view)` ⇒ 太阳系之外的每一层，视角按钮一按就抛
   *    `TypeError: lv.tweenTo is not a function`，被浏览器吞掉，界面表现为
   *    「按钮点了没反应」（用户原话：「宇宙全景貌似点不了了」）。
   *    **同一件事只能有一处实现** —— 散在子类里的「可选方法」就是这类故障的温床。
   *    判据：`grep -rn "tweenTo" web/js` 只该命中基类与调用方。
   */

  /** 让天体「全貌」刚好占据画面的取景距离（fov 50° 时约 60% 画面高） */
  #frameDistance(radius, id = '') {
    const base = Math.max(radius * 3.7, 1e-5);
    if (id === 'sun') return Math.max(base, 1.0);   // 太阳带辉光，稍微拉远
    return base;
  }

  /**
   * 取景方向：优先从「向阳面」看，并稍微偏一点侧面/上方
   * （否则天体可能整片落在夜面，看起来又暗又糊）
   */
  #lookAt(p, d) {
    const dist = Math.hypot(p.x, p.y, p.z);
    let dir;
    if (dist > 1e-6) {
      // 指向太阳的方向
      const sx = -p.x / dist, sy = -p.y / dist, sz = -p.z / dist;
      // 侧面方向 = sun × (0,1,0) = (-sz, 0, sx)
      let ux = -sz, uy = 0, uz = sx;
      const ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; } else { ux /= ul; uy /= ul; uz /= ul; }
      const dx = sx + ux * 0.30, dy = sy + 0.20, dz = sz + uz * 0.30;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dir = { x: dx / dl, y: dy / dl, z: dz / dl };
    } else {
      dir = { x: 0.62, y: 0.34, z: 0.7 };
    }
    return {
      position: [p.x + dir.x * d, p.y + dir.y * d, p.z + dir.z * d],
      target: [p.x, p.y, p.z],
    };
  }

  viewFor(id) {
    const b = this.dataset.get(id);
    if (!b) return this.defaultView();
    if (b.type === 'region') {
      const outer = b.outerAu ?? 50;
      return { position: [0, outer * 0.7, outer * 1.25], target: [0, 0, 0] };
    }

    if (b.type === 'probe') {
      // 已着陆：**贴近着陆点看模型**（2026-10-11 起探测器有构型模型——
      // 旧口径取母天体全貌，模型缩成一个点）。取景距离 = 模型展幅的 ~6.5 倍，
      // 地平线作背景；夜面修正保留（保证着陆点被照亮）。
      if (b.host && b.mode === 'landed') {
        const hostPos = this.#hostWorld(b.host);
        const modelSize = Math.min(6e-3, Math.max(8e-4, this.#visualRadius(b.host) * 0.11));
        const d = modelSize * 6.5;
        const site = this.#probeWorld(b, this.ctx.clock?.date || new Date());
        const dir = site.clone().sub(hostPos);
        if (dir.lengthSq() < 1e-20) return this.viewFor(b.host);
        dir.normalize();
        // 着陆点若在夜面，把镜头往向阳面偏一点，保证既看得清又不丢失着陆点
        const sunDir = hostPos.clone().negate().normalize();
        if (dir.dot(sunDir) < 0.25) dir.lerp(sunDir, 0.55).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const side = new THREE.Vector3().crossVectors(dir, up);
        if (side.lengthSq() < 1e-12) side.set(1, 0, 0);
        side.normalize();
        const camPos = hostPos.clone()
          .add(dir.multiplyScalar(d))
          .add(side.multiplyScalar(d * 0.14))
          .add(up.clone().multiplyScalar(d * 0.09));
        return { position: camPos.toArray(), target: site.toArray() };
      }
      // 已坠毁 / 任务结束：取景停在纪念轨道上的模型 + 母天体（不再只看母天体——
      // 2026-10-11 起 ended 探测器有实体模型，停在母星旁 2R 处，取景要把它框进来）
      if (b.host && b.mode === 'ended') {
        if (b._parkOffset) {
          const t = this.#hostWorld(b.host).add(b._parkOffset);
          const hr = this.#visualRadius(b.host);
          return this.#lookAt(t, Math.max(hr * 2.6, 1e-5));
        }
        return this.viewFor(b.host);
      }
      // 在轨环绕：**贴近探测器看模型**（母天体当背景）。
      // 旧口径取母天体全貌——模型缩成一个点，「点了没反应」。
      // ⚠️ 不要给 d 加「displayDist×系数」的下限：朱诺的显示轨道半径是木星
      //    视觉半径的 4.6 倍，那个下限会把相机顶回千万公里外，模型又成亚像素点。
      if (b.host && b.mode === 'orbit') {
        const hr = this.#visualRadius(b.host);
        const modelSize = Math.min(6e-3, Math.max(8e-4, hr * 0.11));
        const p = this.#probeWorld(b, this.ctx.clock?.date || new Date());
        return this.#lookAt(p, Math.max(modelSize * 7, hr * 1.3, 4e-4));
      }
      // 日心飞行：取景探测器本身（同时能看到飞行轨迹）
      // ⚠️ 2026-10-11：两处修正——
      //   ① 距离不再按 |p|·0.075 缩放：旅行者在 172 AU ⇒ 相机被推到 12.9 AU 外，
      //      0.004 AU 的模型缩成一个亚像素点。现在固定近景 0.02 AU（模型占 ~11°）；
      //   ② #lookAt 的向阳面偏移保留——保证机身被照亮而不是剪影。
      const p = this.#probeWorld(b, this.ctx.clock?.date || new Date());
      return this.#lookAt(p, 0.02);
    }

    const e = this.entries.get(id);
    if (e) {
      const p = e.group.position.clone();
      const d = this.#frameDistance(e.r, id);
      /* ⚠️ 彗星**侧向取景**（2026-10-11）：尾巴永远背向太阳，而 `#lookAt` 的默认
       *    口径是「优先从向阳面看」—— 从正阳面看，尾全被核挡住
       *    （verify-halley-perihelion.png 首版就是这个视角）。彗星改从「太阳侧面
       *    偏上」看：尾的走向与视线近似垂直，彗发 + 双尾一次看全。 */
      if (e.tail) {
        const sunDir = p.clone().normalize().negate();     // 指向太阳
        const side = new THREE.Vector3().crossVectors(sunDir, UP).normalize();
        const dir = sunDir.multiplyScalar(0.35).add(side.multiplyScalar(0.85))
          .add(new THREE.Vector3(0, 0.35, 0)).normalize();
        return { position: [p.x + dir.x * d, p.y + dir.y * d, p.z + dir.z * d], target: [p.x, p.y, p.z] };
      }
      return this.#lookAt(p, d);
    }

    // 卫星：用它的世界坐标 + 自身视觉半径取景
    const mp = this.moonPivots.find((m) => m.moon.id === id);
    if (mp) {
      const p = (mp.world || mp.holder.position).clone();
      return this.#lookAt(p, this.#frameDistance(this.#visualRadius(id)));
    }

    // 未在场景中渲染的卫星：退回母天体视角（目录里仍可查看资料）
    if (b.type === 'moon') return this.viewFor(b.parent);

    const p = this.#staticPos(id);
    return this.#lookAt(p, 0.05);
  }

  /** 母天体在场景中的世界坐标（卫星用的是放大后的视觉位置，不能直接用星历真值） */
  #hostWorld(id) {
    const e = this.entries.get(id);
    if (e) return e.group.position.clone();
    const mp = this.moonPivots.find((m) => m.moon.id === id);
    if (mp) return mp.world.clone();
    return toScene(this.eph.helio(id, this.ctx.clock?.date || new Date()), new THREE.Vector3());
  }

  /** 探测器在场景中的世界坐标 */
  #probeWorld(p, date) {
    if (p.mode === 'heliocentric' || !p.host) return toScene(this.eph.helio(p.id, date), new THREE.Vector3());
    const hostPos = this.#hostWorld(p.host);
    const realHost = toScene(this.eph.helio(p.host, date), new THREE.Vector3());
    const realProbe = toScene(this.eph.helio(p.id, date), new THREE.Vector3());
    // 任务结束：与 update() 的 local 分支同口径——停在纪念轨道偏移上
    if (p.mode === 'ended' && p._parkOffset) return hostPos.add(p._parkOffset);
    return realProbe.sub(realHost).multiplyScalar(p._displayScale || 1).add(hostPos);
  }

  #staticPos(id) {
    const b = this.dataset.get(id);
    if (!b) return new THREE.Vector3();
    if (b._orbit && this.ctx.clock) return toScene(b._orbit.positionAt(this.ctx.clock.jd), new THREE.Vector3());
    return new THREE.Vector3();
  }

  focusById(id) {
    this.follow = id;
    this._followPrev = null;
    this.tweenTo(this.viewFor(id), 1.15);
    return true;
  }

  stopFollow() { this.follow = null; this._followPrev = null; }

  setOrbitsVisible(v) { for (const l of this.orbitLines) l.visible = v; }

  /**
   * 切换真实比例。
   *
   * ⚠️ **故意不在非当前层重建。**
   * `engine.setOptions()` 把这项设置广播给所有层，而在邻近恒星系上拨这个开关时，
   * 太阳系层并没有被释放（`_trimLevels` 只释放 ±1 层以外的东西），于是它「存在」——
   * 但 **存在不等于要被看见**。旧写法在这里无条件 `rebuild()`，实测每拨一次白付
   * 200–250ms（整层重来：几何、贴图、标签、轨道线），而用户根本看不到太阳系。
   * 现在：本层才立刻重建，别的层只打脏标记，等它真被切进来时补一次（`refreshIfStale`）。
   */
  setTrueScale(v) {
    if (this.trueScale === v) return;
    this.trueScale = v;
    this._scaleStale = true;
    const e = this.ctx.engine;
    // 「正在被看」有两种：已经是当前层，或者过渡动画正把它推上来
    // （`engine.current` 要到 `_finishTransition()` 才切换，所以过渡目标必须单独认一下，
    //  否则在这一秒里拨开关，脏标记会挂到没人来补 —— 用户会看到旧口径的太阳系一直留在那儿）。
    if (e?.current === this || e?.transition?.to === this) this.refreshIfStale();
  }

  /**
   * 口径变过、场景还没跟上时，补上这一次重建。
   * 由引擎在**切进本层**时调用（见 `engine.js::goTo`）——
   * 也就是说，这次重建的钱只在真的要被看见的时候付。
   */
  refreshIfStale() {
    if (!this._scaleStale) return;
    this._scaleStale = false;
    // 还没建过就不用重建：build() 会直接读到新的 trueScale
    if (this.built) this.rebuild();
  }

  /** 彻底重建场景（真实比例切换、WebGL 上下文恢复时用） */
  rebuild() {
    this.rebuilds++;
    // ⚠️ `_attachControls` 会把 **engine.controls**（全局唯一一份）重新挂到本层相机上，
    //    并 dispose 掉原来那份。在**非当前层**调用它 = 悄悄把轨道控制器偷走：
    //    当前那一层从此拖不动、转的是别的相机，而且界面上**没有任何报错**。
    //    实测（tools/probe-truescale.py）：在 galaxy / universe 等层拨一次真实比例，
    //    控制器就跑到 solar 头上了，而其它的层一律如此。
    const wasCurrent = this.ctx.engine?.current === this;
    const follow = this.follow;
    this.dispose();
    this.built = false;
    this.labels.clear();
    this.entries.clear();
    this.moonPivots = [];
    this.orbitLines = [];
    this.probeOrbits = [];
    this.probeTrails = [];
    this.clouds = [];
    this.follow = null;
    this._followPrev = null;
    this._tween = null;
    this.ensureBuilt();
    if (wasCurrent) this.ctx.engine._attachControls(this);
    this.setOrbitsVisible(this.ctx.engine?.options.orbits ?? true);
    if (follow) this.focusById(follow);
  }

  dispose() {
    for (const child of [...this.scene.children]) {
      this.scene.remove(child);
      if (child !== this.sunLight) disposeObject(child);
    }
    this.labels.clear();
    // 注意：entries / moonPivots 等索引必须由调用方（rebuild）一并清空，
    // 否则重建时会重复累积（曾导致天体数量翻倍）
    this.entries.clear();
    this.moonPivots = [];
    this.orbitLines = [];
    this.probeOrbits = [];
    this.probeTrails = [];
    this.clouds = [];
  }
}

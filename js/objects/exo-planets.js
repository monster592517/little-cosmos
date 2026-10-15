/**
 * 系外行星系统渲染器
 *
 * ── 为什么需要单独一个模块 ─────────────────────────────────
 * exoplanets.json 里有几千个系统、几千颗行星，数据（周期、半径、质量、
 * 温度、半长轴、离心率）**早就齐了**，缺的只是把它们画出来。
 *
 * ⚠️ 这里**不写死数量**。这个模块原来写着「471 个系统」——
 *   那是 `where sy_dist < 40` 时代的数字；门槛一去掉就变成 4,741 个系统，
 *   于是同一份说明从"精确"变成"骗人"，而没人会回来改它。
 *   要数量就现场读 `this.systems.length`（`stats.total` 里就有）。
 *
 * 但不能一次全建。本机显存 4 GB、可用内存 1–2 GB，
 * 几千个系统 × 每个 1–7 颗行星 = 几千个球体 + 几千条轨道线，
 * 一次性塞进场景会直接把标签页跑崩（项目已实测过六层全常驻导致 `Target crashed`）。
 *
 * 对策：**按相机距离懒加载 + 滞后释放**。
 *   · 相机进入 HOLD_LY（3 光年）→ 构建该系统
 *   · 相机离开 FREE_LY（6 光年）→ 释放
 *   · 两个阈值之间是「迟滞带」——只有一个阈值会让相机停在边界时
 *     每帧反复建/删，帧率骤降且显存碎片化。
 *
 * ── 尺寸口径 ───────────────────────────────────────────────
 * 系外行星的真实半径（0.3–2 地球半径，热木星可达 1.4 木星半径）在「1 单位 = 1 光年」
 * 的尺度下是 1e-9 量级，比浮点噪声还小。因此**球体尺寸是夸张过的**，
 * 但夸张倍率对所有行星一致，读者仍能看出「谁大谁小」。
 * 轨道半长轴同理做了非线性压缩 —— 否则 0.005 AU 的水星式轨道与 5 AU 的木星式轨道
 * 在同一个系统里会完全重叠成一团。
 *
 * ⚠️ 「夸张过」这件事必须在界面上讲清楚，不能让人误以为行星真有那么大。
 */
import * as THREE from 'three';
import { makeGlowTexture, makePlanetTexture, mulberry } from '../proc/textures.js';
// 「平衡温度 → 示意色」的唯一来源在 color/ 层：数据集建天体对象时也要用它，
// 抄一份到这里会让「渲染出来的颜色」和「目录里的色块」慢慢漂开。
import { tempToColor } from '../color/exo-temp.js';

export { tempToColor } from '../color/exo-temp.js';

/** 进入这个距离（光年）才构建该系统 */
export const HOLD_LY = 3.0;
/** 离开这个距离（光年）才释放 —— 与 HOLD_LY 的差值就是迟滞带 */
export const FREE_LY = 6.0;
/** 单个系统最多画几颗行星（有的系统 7 颗以上，全画会糊成一团） */
const MAX_PLANETS = 6;

/**
 * 行星半径（地球半径）→ 渲染尺寸（光年单位）。
 *
 * 用对数压缩：真实比例差 10 倍的行星，屏幕上差约 1.6 倍 ——
 * 既保序（大的看起来确实大），又不会让地球大的行星看不见、木星大的挡住整个系统。
 */
export function radiusToSize(radiusEarth) {
  const r = Number.isFinite(radiusEarth) && radiusEarth > 0 ? radiusEarth : 1;
  // 0.3 地球半径 → 1.1e-3；1 → 1.5e-3；11（木星级）→ 2.6e-3
  return 1.0e-3 * Math.pow(r, 0.42) * 1.5;
}

/**
 * 半长轴（AU）→ 渲染轨道半径（光年单位）。
 *
 * 同样对数压缩。1 AU ≈ 1.58e-5 光年，若按真实比例，
 * 整颗行星系统的尺寸会远小于一颗恒星的光晕（本层级恒星精灵半径约 0.4 光年），
 * 画出来就是「一圈看不见的线套在恒星里」。
 * 这里映射到 0.055–0.62 光年，让轨道刚好浮在恒星光晕外侧。
 */
export function auToOrbitRadius(au) {
  const a = Number.isFinite(au) && au > 0 ? au : 0.1;
  const t = Math.log10(Math.max(0.003, a) / 0.003) / Math.log10(30 / 0.003); // 0.003–30 AU → 0..1
  return 0.055 + Math.max(0, Math.min(1, t)) * 0.565;
}

/**
 * 轨道线：按离心率画真实形状。
 * 椭圆用极坐标 r = a(1−e²)/(1+e·cosθ) 采样，
 * 焦点在恒星上（这正是开普勒第一定律）。
 */
function makeOrbitEllipse(a, e, { color = '#67e8f9', opacity = 0.3, segments = 96 } = {}) {
  const pts = new Float32Array((segments + 1) * 3);
  const ecc = Math.max(0, Math.min(0.85, Number.isFinite(e) ? e : 0));
  const b = a * Math.sqrt(1 - ecc * ecc);         // 半短轴
  const c = a * ecc;                              // 焦距偏移
  for (let i = 0; i <= segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    // 相对焦点的极坐标
    const r = (a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(th));
    const x = Math.cos(th) * r - c;               // 把焦点挪到原点
    const y = Math.sin(th) * r;
    pts[i * 3] = x;
    pts[i * 3 + 1] = 0;
    pts[i * 3 + 2] = y;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
  }));
}

/**
 * 一个系外行星系统的可视化对象。
 *
 * 生命周期由 ExoplanetRenderer 管理：够近就 new，走远就 dispose。
 */
export class ExoSystemView extends THREE.Group {
  /**
   * @param {object} sys  exoplanets.json 里的一条系统记录
   * @param {object} opts
   *   opts.scale  整体系数（让不同恒星光度下的系统观感一致）
   */
  constructor(sys, { scale = 1 } = {}) {
    super();
    this.userData.sys = sys;
    this.planets = [];
    this.orbitLines = [];
    const planets = (sys.planets || []).slice(0, MAX_PLANETS);
    const rnd = mulberry(Math.round((sys.distLy ?? 1) * 9973) % 99991 + 7);

    // 让每颗行星有稳定的初始相位（同一系统每次构建都长一样）
    const phase0 = rnd() * Math.PI * 2;

    planets.forEach((p, i) => {
      const a = auToOrbitRadius(p.semiMajorAu) * scale;
      const e = Number.isFinite(p.ecc) ? Math.min(0.85, Math.max(0, p.ecc)) : 0;
      const size = radiusToSize(p.radiusEarth) * scale;

      // --- 轨道线 ---
      const orbit = makeOrbitEllipse(a, e, {
        color: p.eqTempK != null && p.eqTempK > 700 ? '#ffb08a' : '#67e8f9',
        opacity: 0.26,
      });
      // 轨道倾角给一点点随机，避免所有系统都是完美共面（真实系统也有相互倾角）
      orbit.rotation.x = (rnd() - 0.5) * 0.22;
      orbit.userData.bodyId = `${sys.starName}#orbit${i}`;
      this.add(orbit);
      this.orbitLines.push(orbit);

      // --- 行星本体 ---
      const color = tempToColor(p.eqTempK);
      const geo = new THREE.SphereGeometry(1, 20, 12);
      const tex = makePlanetTexture({
        base: color, seed: Math.round((p.radiusEarth || 1) * 811 + i * 37) % 9999 + 3,
        mode: p.radiusEarth != null && p.radiusEarth > 3 ? 'gas' : 'rocky',
        size: [128, 64],
      });
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(size);
      mesh.userData.bodyId = sys.starName;
      mesh.userData.planet = p;
      this.add(mesh);

      this.planets.push({
        mesh, orbit, p, a, e,
        phase: phase0 + (i / planets.length) * Math.PI * 2,
        // 用周期决定角速度：真数据，不编
        omega: p.periodDays > 0 ? (Math.PI * 2) / (p.periodDays * 86400) : 0.02,
      });
    });
  }

  /**
   * 每帧更新行星位置（真实开普勒运动）。
   * @param {number} t 累积时间（秒，已含压缩）
   */
  update(t) {
    for (const it of this.planets) {
      const th = it.phase + t * it.omega;
      const ecc = it.e;
      // 相对恒星（焦点在原点）的极坐标位置
      const r = (it.a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(th));
      const c = it.a * ecc;
      const x = Math.cos(th) * r - c;
      const y = Math.sin(th) * r;
      // 轨道有轻微倾角，行星要跟着倾斜
      const tilt = it.orbit.rotation.x;
      it.mesh.position.set(x, -y * Math.sin(tilt), y * Math.cos(tilt));
    }
  }

  /**
   * 轨道线的显隐。行星本体**不**受影响 —— 「轨道」开关关的是线，不是行星。
   * @param {boolean} v
   */
  setOrbitsVisible(v) {
    const on = v !== false;
    for (const l of this.orbitLines) l.visible = on;
  }

  dispose() {
    this.traverse((o) => {
      o.geometry?.dispose?.();
      // 贴图走全局缓存，不在这里释放（跨系统共享）
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
    });
    this.planets.length = 0;
    this.orbitLines.length = 0;
  }
}

/**
 * 台账：按相机距离懒加载 / 释放系外行星系统。
 */
export class ExoplanetRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {Array} systems  exoplanets.json 的 systems 数组
   * @param {number} budget  最多同时存在的系统数（护栏，防止极端视角下爆显存）
   */
  constructor(scene, systems, { budget = 14 } = {}) {
    this.scene = scene;
    this.systems = systems || [];
    this.budget = budget;
    this.active = new Map();   // starName → ExoSystemView
    this.t = 0;
    /* 位置**算一次就存下来**。
     *
     * ⚠️ 原来是每帧现算：`#posOf(sys)` 内部 `new THREE.Vector3(...)`，
     *   而 update() 只要没建满预算就会把 4,741 个系统全部遍历一遍 ——
     *   也就是**每帧 4,741 个临时对象**。471 个系统时这点垃圾无所谓，
     *   涨到 4,741 就是每帧几百 KB，GC 一忙帧率就开始抖。
     *   （这正是「性能优化是硬指标」那条：数据量涨 8 倍，
     *    原来"够用"的写法会变成主要开销。）
     * 距离比较也改成**平方距离** —— 省掉 4,741 次开方，且不需要新阈值常量。 */
    this._pos = this.systems.map((s) => new THREE.Vector3(s.x ?? 0, s.y ?? 0, s.z ?? 0));
    /** 上一帧统计，供 HUD / 自检读取 */
    this.stats = { active: 0, total: this.systems.length, lastBuild: 0 };
    /* ★ 「轨道」开关的**现状**。必须由渲染器自己记着（不能只存在调用方）——
     *   因为系统是**按距离懒构建**的：关了开关之后用户又走到别的恒星附近，
     *   新构建的视图如果不继承这个状态，就会**自己冒出一圈轨道线**。
     *   这正是「延迟重建＝开始记账，记账必须有人补」（坑 84）。 */
    this.orbitsVisible = true;
  }

  /** 索引 → 位置（算好的那个），别再 new */
  #posAt(i) { return this._pos[i]; }

  update(dt, camera) {
    // 时间压缩：真实周期从 0.2 天到数千年，不压缩的话内行星会闪成一片
    this.t += dt * 24;   // 约 24 倍速

    const cam = camera.position;
    const FREE2 = FREE_LY * FREE_LY;
    const HOLD2 = HOLD_LY * HOLD_LY;

    /* ---- 释放：走远的先清掉 ---- */
    for (const [key, view] of this.active) {
      if (cam.distanceToSquared(view.position) > FREE2) {
        this.scene.remove(view);
        view.dispose();
        this.active.delete(key);
      }
    }

    /* ---- 构建：把进入 HOLD_LY 的系统按距离排序，依次建到预算上限 ---- */
    if (this.active.size < this.budget) {
      const near = [];
      for (let i = 0; i < this.systems.length; i++) {
        const sys = this.systems[i];
        if (this.active.has(sys.starName)) continue;
        const d2 = cam.distanceToSquared(this.#posAt(i));
        if (d2 <= HOLD2) near.push([d2, i, sys]);
      }
      near.sort((a, b) => a[0] - b[0]);     // 近的优先
      let built = 0;
      for (const [, i, sys] of near) {
        if (this.active.size >= this.budget) break;
        this.active.set(sys.starName, this.#spawn(i));
        built++;
      }
      this.stats.lastBuild = built;
    }

    /* ---- 更新已在场的行星位置 ---- */
    for (const view of this.active.values()) view.update(this.t);
    this.stats.active = this.active.size;
  }

  /**
   * **唯一的构建出口**。视图一律从这里出，为的是新系统必然继承「轨道」开关的现状。
   * ⚠️ 别在别处再 `new ExoSystemView(...)` —— 那样会漏掉 `setOrbitsVisible`，
   *   于是关掉开关之后，走近新恒星还是会冒出一圈轨道线，而且**不报错**。
   */
  #spawn(i) {
    const view = new ExoSystemView(this.systems[i]);
    view.setOrbitsVisible(this.orbitsVisible);
    view.position.copy(this.#posAt(i));
    this.scene.add(view);
    return view;
  }

  /** 「轨道」开关：记下现状 + 立刻作用到已经在场的系统 */
  setOrbitsVisible(v) {
    this.orbitsVisible = v !== false;
    for (const view of this.active.values()) view.setOrbitsVisible(this.orbitsVisible);
  }

  /** 强制为某个系统建出视图（聚焦时用，不受 HOLD_LY 限制） */
  ensure(starName) {
    if (this.active.has(starName)) return this.active.get(starName);
    const i = this.systems.findIndex((s) => s.starName === starName);
    if (i < 0) return null;
    const view = this.#spawn(i);
    this.active.set(starName, view);
    return view;
  }

  /** 全部释放（离开本层级时调用） */
  dispose() {
    for (const view of this.active.values()) {
      this.scene.remove(view);
      view.dispose();
    }
    this.active.clear();
  }
}

/**
 * 渲染引擎：层级（Level）管理 + 相机过渡 + 双渲染目标交叉溶解
 *
 * 设计要点
 *  · 每个尺度层级独立场景与相机，各自使用最合适的单位（AU / 光年 / 千光年 / 百万光年），
 *    避免单一场景里 1e-5 与 1e6 的动态范围导致精度崩溃；
 *  · 层级切换用双 RT 交叉溶解 + 相机推近，视觉上是连续缩放而非硬切；
 *  · 对数深度缓冲 + 动态近远平面，保证从行星表面到柯伊伯带都能正确遮挡。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LabelLayer } from '../ui/labels.js';
import { TIERS } from './gpu.js';
import { retuneBloomKernel } from './bloom-kernel.js';
import { nextBigger, nextSmaller, scaleOrder } from './scales.js';

const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** `tickTween` 的临时目标点（避免每帧 new 一个 Vector3） */
const _tweenTgt = new THREE.Vector3();

export class Level {
  constructor(ctx) {
    this.ctx = ctx;
    this.id = 'level';
    this.name = '层级';
    this.subtitle = '';
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 1e-5, 1e7);
    this.labels = ctx.makeLabels();
    this.built = false;
    this.scaleLabel = '';
    /** 跨尺度跳转时的锚点天体 id：从更大/更小层级进入本层级时镜头落在它身上 */
    this.enterFocus = null;
    this.exitFocus = null;
    this.controlsConfig = { minDistance: 0.01, maxDistance: 1e5, rotateSpeed: 0.8, zoomSpeed: 1.1 };
  }

  ensureBuilt() { if (!this.built) { this.build(); this.built = true; } return this; }

  /** 当前画质档位允许的粒子预算——层级构建大规模点云时必须读它，而不是写死数量 */
  get pointBudget() { return this.ctx.engine?.tier?.pointBudget ?? 200000; }

  /** 星空 / 背景粒子数量的倍率（省电档会明显调低） */
  get fieldScale() { return this.ctx.engine?.tier?.fieldScale ?? 1; }

  /** 按当前预算把期望数量压到允许范围内 */
  budget(wanted) { return Math.max(64, Math.round(Math.min(wanted, this.pointBudget))); }

  build() {}
  update(_dt, _clock) {}
  dispose() {}
  pick(_ndc, _raycaster) { return null; }
  focusById(_id) { return false; }
  defaultView() { return { position: [0, 2, 6], target: [0, 0, 0] }; }
  get scaleLabelText() { return this.scaleLabel || ''; }

  /** 常用工具：把相机放到指定位姿 */
  applyView(view, { instant = true } = {}) {
    const { position, target } = view;
    this.camera.position.set(...position);
    this.camera.lookAt(...target);
    if (this.controls) { this.controls.target.set(...target); this.controls.update(); }
    if (instant) this.camera.updateProjectionMatrix();
  }

  /**
   * 视角平滑过渡：把相机从当前位置推到 `view`（`applyView` 是它的「瞬间版」）。
   *
   * ⚠️ 这个方法**必须待在基类里**。第 25 轮之前它只定义在 `solar.js`，
   *    而 `main.js::setView()` 对**所有层级**都调 `lv.tweenTo(view)` ——
   *    于是另外 5 个层级的**每一个视角按钮**都在 DOM 事件处理器里抛
   *    `TypeError: lv.tweenTo is not a function`。异常被浏览器吞掉，界面上只表现为
   *    「按钮点了没反应」：镜头不动、连高亮都不会变（`setActiveView` 在下一行，永远跑不到）。
   *    用户看到的原话是**「宇宙全景貌似点不了了」**（`view-universe` 就叫「宇宙全景」，
   *    而「可观测宇宙」这一层只有这一个视角按钮，一点一个准）。
   *
   *    同一个函数的上一行 `lv.stopFollow?.()` 加了 `?.`、下一行没加 ——
   *    「一行防了、下一行忘了」正是**可选方法散落在各个子类里**才会长出来的味道。
   *    ⇒ 判据不该是「记得加 `?.`」，而是**让方法根本不存在于子类**。
   *
   * @returns {boolean} 是否真的排上了一次过渡
   */
  tweenTo(view, duration = 1.1) {
    if (!view || !Array.isArray(view.position) || !Array.isArray(view.target)) return false;
    if (this.controls) this.controls.enabled = false;
    this._tween = {
      from: { pos: this.camera.position.clone(), target: (this.controls?.target || new THREE.Vector3()).clone() },
      to: { pos: new THREE.Vector3(...view.position), target: new THREE.Vector3(...view.target) },
      t: 0, dur: Math.max(0.01, duration),
    };
    return true;
  }

  /**
   * 推进 `tweenTo` 排下的那一次过渡。**由 `Engine._frame()` 调用**，不是由 `update()`。
   *
   * ⚠️ 为什么不放在 `update()` 里：**六个子类没有一个调 `super.update()`**
   *    （个个都整个覆盖了）。所以基类的 `update` 永远不会被执行 ——
   *    把过渡推进写在那里，会是一条「看着很对、其实一次都不跑」的判据。
   *    引擎每帧只认 `current`，从引擎侧调用又少一层「子类记不记得」的依赖。
   */
  tickTween(dt) {
    const tw = this._tween;
    if (!tw) return;
    tw.t += dt / tw.dur;
    const p = Math.min(1, tw.t);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    this.camera.position.lerpVectors(tw.from.pos, tw.to.pos, e);
    _tweenTgt.copy(tw.from.target).lerp(tw.to.target, e);
    this.camera.lookAt(_tweenTgt);
    if (this.controls) this.controls.target.copy(_tweenTgt);
    if (p >= 1) {
      this._tween = null;
      if (this.controls) { this.controls.enabled = true; this.controls.update(); }
    }
  }
}

export class Engine extends EventTarget {
  constructor({ canvas, labelsEl, gpu }) {
    super();
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    // 显卡配置：决定用哪类 GPU（powerPreference）以及画质档位
    this.gpu = gpu;
    this.tier = gpu?.tier ?? null;
    this.levels = new Map();
    this.current = null;
    this.transition = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points = { threshold: 1 };
    this._clock = new THREE.Clock();
    this._fps = { frames: 0, last: performance.now(), value: 0 };
    this._pointer = { down: null, moved: false };
    /** 页面隐藏时是否完全停帧（释放显卡，避免后台空转抢资源） */
    this._paused = false;
    this._lastFrameAt = 0;
    this.forceRT = new URLSearchParams(location.search).has('forceRT');
    this.options = {
      orbits: true, labels: true, trueScale: false,
      bloom: this.tier ? this.tier.bloom : true, autoRotate: true,
    };

    this._createRenderer();

    this.ctx = {
      engine: this,
      renderer: this.renderer,
      canvas,
      makeLabels: () => this._makeLabels(),
      texture: (name) => this._texture(name),
    };

    this._texCache = new Map();
    // WebGL 上下文丢失 / 恢复：显存吃紧时浏览器会回收上下文，这里优雅恢复而不是"崩溃"
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      console.warn('[engine] WebGL 上下文丢失，等待恢复…');
      this.dispatchEvent(new CustomEvent('contextlost'));
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[engine] WebGL 上下文已恢复，重建场景');
      this._contextLost = false;
      this._texCache.clear();
      try {
        if (this.current?.rebuild) this.current.rebuild();
        else {
          this.current?.dispose?.();
          if (this.current) { this.current.built = false; this.current.ensureBuilt(); }
          this._attachControls(this.current);
        }
        this.dispatchEvent(new CustomEvent('contextrestored'));
      } catch (err) { console.error('[engine] 重建失败', err); }
    }, false);
    this._rtA = this._makeRT();
    this._rtB = this._makeRT();
    this._blendScene = new THREE.Scene();
    this._blendCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._blendMat = new THREE.ShaderMaterial({
      uniforms: {
        tFrom: { value: null }, tTo: { value: null },
        progress: { value: 0 }, center: { value: new THREE.Vector2(0.5, 0.5) },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        uniform sampler2D tFrom; uniform sampler2D tTo; uniform float progress; uniform vec2 center;
        varying vec2 vUv;
        void main(){
          float p = clamp(progress, 0.0, 1.0);
          float e = p * p * (3.0 - 2.0 * p);
          float k = 1.0 - 0.12 * sin(p * 3.14159265);
          vec2 uv = (vUv - center) * k + center;
          vec3 a = texture2D(tFrom, clamp(uv, 0.0, 1.0)).rgb;
          vec3 b = texture2D(tTo, clamp(uv, 0.0, 1.0)).rgb;
          vec3 c = mix(a, b, e) + vec3(0.05) * sin(p * 3.14159265);
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this._blendScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._blendMat));

    /* ---- 后期处理：泛光（让恒星、行星辉光、城市灯光"发光"） ---- */
    this._createComposer();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // 页面切到后台时完全停帧：既省电，也不和前台程序抢显卡
    this._onVisibility = () => {
      this._paused = Boolean(document.hidden) && (this.gpu ? this.gpu.pauseWhenHidden : false);
      // 丢掉切换期间累积的时间差，回到前台时不会「瞬移」
      this._clock.getDelta();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    this.resize();

    canvas.addEventListener('pointerdown', (e) => { this._pointer.down = { x: e.clientX, y: e.clientY }; this._pointer.moved = false; });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._pointer.down) return;
      if (Math.hypot(e.clientX - this._pointer.down.x, e.clientY - this._pointer.down.y) > 5) this._pointer.moved = true;
    });
    canvas.addEventListener('pointerup', (e) => {
      const wasDown = this._pointer.down;
      this._pointer.down = null;
      if (!wasDown || this._pointer.moved || e.button !== 0 || this.transition) return;
      this._click(e);
    });

    // 跨尺度缩放阶梯：滚轮顶到当前层级的缩放边界后继续滚，就切到上一层/下一层
    this._ladder = { out: 0, in: 0 };
    canvas.addEventListener('wheel', (e) => this._onLadderWheel(e), { passive: true });
  }

  /**
   * 滚轮触发的跨尺度缩放。
   * 只在镜头**已经顶到当前层级的缩放上下限**时才累计，避免刚滚两下就误切层级。
   */
  _onLadderWheel(e) {
    if (this.transition || !this.controls || this._paused) { this._ladder.out = this._ladder.in = 0; return; }
    const c = this.controls;
    const d = c.getDistance();
    const max = Number.isFinite(c.maxDistance) ? c.maxDistance : Infinity;
    const min = Number.isFinite(c.minDistance) ? c.minDistance : 0;
    const OUT_EDGE = d >= max * 0.975;
    const IN_EDGE = d <= min * 1.06;

    if (e.deltaY > 0 && OUT_EDGE) {
      this._ladder.out += e.deltaY;
      this._ladder.in = 0;
    } else if (e.deltaY < 0 && IN_EDGE) {
      this._ladder.in += -e.deltaY;
      this._ladder.out = 0;
    } else {
      this._ladder.out = this._ladder.in = 0;
      return;
    }
    if (this._ladder.out > 260) { this._ladder.out = 0; this.zoomOut(); }
    else if (this._ladder.in > 260) { this._ladder.in = 0; this.zoomIn(); }
  }

  /** 拉远：切到尺度阶梯上的更大层级 */
  async zoomOut() {
    const nxt = nextBigger(this.current?.id);
    if (!nxt) {
      this.dispatchEvent(new CustomEvent('scalelimit', { detail: { end: 'max' } }));
      return false;
    }
    if (!this.levels.has(nxt.id)) {
      this.dispatchEvent(new CustomEvent('scalemissing', { detail: nxt }));
      return false;
    }
    const ok = await this.goTo(nxt.id, { focus: nxt.id === 'solar' ? null : this.current?.exitFocus });
    if (ok) this.dispatchEvent(new CustomEvent('scale', { detail: { ...nxt, direction: 'out' } }));
    return ok;
  }

  /** 拉近：切到尺度阶梯上的更小层级 */
  async zoomIn() {
    const prv = nextSmaller(this.current?.id);
    if (!prv) {
      this.dispatchEvent(new CustomEvent('scalelimit', { detail: { end: 'min' } }));
      return false;
    }
    if (!this.levels.has(prv.id)) {
      this.dispatchEvent(new CustomEvent('scalemissing', { detail: prv }));
      return false;
    }
    const target = this.levels.get(prv.id);
    const ok = await this.goTo(prv.id, { focus: target?.enterFocus ?? null });
    if (ok) this.dispatchEvent(new CustomEvent('scale', { detail: { ...prv, direction: 'in' } }));
    return ok;
  }

  /** 是否有更大 / 更小的层级可去（用于界面按钮的禁用态） */
  get canZoomOut() {
    if (!this.current) return false;
    const n = nextBigger(this.current.id);
    return Boolean(n && this.levels.has(n.id));
  }

  get canZoomIn() {
    if (!this.current) return false;
    const p = nextSmaller(this.current.id);
    return Boolean(p && this.levels.has(p.id));
  }

  /**
   * 创建 WebGL 渲染器。
   * `powerPreference` 只在创建时有效，所以切换「核显/独显」偏好必须走重建（见 setGpuPreferences）。
   * 抗锯齿、像素比、各向异性都跟着画质档位走。
   */
  _createRenderer() {
    const t = this.tier;
    const { canvas } = this;
    const opts = {
      canvas,
      antialias: t ? t.antialias : true,
      powerPreference: this.gpu ? this.gpu.powerPreference : 'default',
      logarithmicDepthBuffer: true, alpha: false, stencil: false,
      failIfMajorPerformanceCaveat: false,
    };
    try {
      this.renderer = new THREE.WebGLRenderer(opts);
    } catch (err) {
      // 极老旧的设备可能连带抗锯齿的上下文都拿不到，退一步再试
      console.warn('[engine] 渲染器创建失败，降级重试', err);
      this.renderer = new THREE.WebGLRenderer({ ...opts, antialias: false });
    }
    this.renderer.setPixelRatio(this._targetPixelRatio());
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.autoClear = true;
    return this.renderer;
  }

  /** 目标像素比：既受画质档上限约束，也不超过屏幕本身 */
  _targetPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    const cap = this.tier ? this.tier.maxPixelRatio : 2;
    return Math.max(0.5, Math.min(dpr, cap));
  }

  /* =========================================================================
   * 后期链：**累积在线性 HDR 里做，色调曲线只在最后做一次**
   * -------------------------------------------------------------------------
   * 这一节是第 23 轮为了修「银河系中央糊成一团白」改的，理由全在实测数字里：
   *
   * 探针把银河系的 18 万点云按群体拆开、逐层显示，量「核区亮度 / 核区>250%」：
   *
   *     mw-points-bulge  197.1 / 50.7%      mw-bulge      163.5 / 33.3%
   *     mw-points-disk   195.6 / 28.6%      mw-points-bar 144.1 / 10.3%
   *     mw-disk-glow     102.8 /  3.3%      基线(全开)    244.9 / 60.3%
   *
   * 五层**各自**都摸到 144~197，而 additive 是**相加**的 ⇒ 基线那 244.9 是被削平的
   * 和。也就是说：**删掉任何一层都救不回来**，剩下的四层照样把中心烧白。
   * 更糟的是盘面本身已经**偏暗**（中盘亮度 ~72）—— 想让中心不白就得整体压暗，
   * 那盘面会更暗。**两条要求方向相反 ⇒ 线性增益怎么调都无解，
   * 必须上一条非线性传输曲线。** 这不是口味问题，是算术。
   *
   * 曲线必须加在**累积之后**。three 只在渲染到默认帧缓冲（`renderTarget === null`）
   * 时才给材质注入色调映射（vendor/three/three.module.js:6942 与 :17041 两处，
   * 规则一致）⇒ 走 composer 的帧里，材质着色器这一层**拿不到**色调映射；
   * 就算拿到，那也是**逐片元、在相加之前**施加的，压不住几百个片元往同一个像素上叠。
   *
   * ⚠️ 已知的不一致（别当成已知结论）：管线探针实测「把 renderer.toneMapping
   *    从 ACES 改成 NoToneMapping，核区亮度从 233 掉到 185」—— 比噪声地板大 171 倍。
   *    也就是说**当前帧确实受了色调映射影响**，与上面那条源码规则对不上。
   *    机制没查清（待办：记录一帧里 `setRenderTarget` 的调用序列，看有没有谁
   *    把场景渲染到 null）。**这条不改设计** —— 因为不管机制是什么，
   *    「曲线在累积之前」这个位置都是错的，而下面这套把曲线钉死在最后。
   * ===================================================================== */
  _createComposer() {
    this.composer = new EffectComposer(this.renderer);
    // ★ 线性 HDR 缓冲：材质写入**线性**光，加法累积才有物理意义。
    //   原来标的是 SRGBColorSpace ⇒ 材质各自先编码成 sRGB 再相加 ——
    //   两个 sRGB 0.5 相加等于满格（编码值 1.0），而对应的线性光只有 0.42，
    //   **越叠越亮是假的**，中心就是这么被顶穿的。
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    }
    this.renderPass = new RenderPass(null, null);
    this.composer.addPass(this.renderPass);
    // ★ 泛光阈值要跟着换单位：原来 0.7 是**在 sRGB 编码上比**的，
    //   换到线性空间后等价阈值是 0.7^2.2 ≈ 0.45 —— 保住「同一批像素发光」，
    //   不是随手改的数。
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.72, 0.6, 0.45);
    /* ★ 泛光核整备（坑 118 · 丙）：出厂核在 mip2/mip3 **近似一块方框**
     *   （σ 被截断在 1.70σ / 1.73σ，最外那一抽还带着 69% / 67% 的权重）
     *   ⇒ 可分离方框 ⊛ 一个点 = 轴对齐的正方形 ⇒ 用户看到的「大光球是方的」。
     *   这里把 σ 与抽头数**解耦**：σ 取自出厂实际展宽（二阶矩），
     *   K 加到 ⌈3σ⌉+1（mip2 7→12、mip3 9→15）⇒ 形状落到圆律上（对角比 0.991）。
     *
     *   只动 mip2/mip3 是有依据的：另外三级的核在画面上**不起作用**
     *   （独热隔离到像素级，差异 = 噪声地板）。
     *
     *   必须在 **addPass 之前/之后都行，但必须在这里**：`_createComposer()` 在
     *   「切换 GPU 偏好」时会被再调一次（旧的 composer 已 dispose、bloomPass 全新）
     *   —— 接线写在别处的话，换一次显卡偏好这个修复就悄悄没了。
     *
     *   ⚠️ 这类「改了不报错的修复」最怕被无声撤掉，所以判据不在代码里、在测试里：
     *      `node tools/check-bloom-kernel.mjs`（离线 9 条 + 自证 6 条）。
     */
    this.bloomKernel = retuneBloomKernel(this.bloomPass);
    if (!this.bloomKernel.ok) {
      // 不抛异常：核没整定成功只是「方斑还在」，不该让整个渲染链起不来
      console.warn('[engine] 泛光核整定没成功，方斑会保留：', this.bloomKernel.why);
    } else {
      const lv = this.bloomKernel.levels
        .map((l) => `第${l.i}级 K ${l.K0}→${l.K} · σ_eff ${l.sigma}→${l.sigmaAfter}（${(l.dSigma * 100).toFixed(2)}%）· 截断 ${l.truncation.toFixed(2)}σ`)
        .join(' | ');
      console.info(`[engine] 泛光核已整定（坑 118 · 丙）：${lv}`);
    }
    this.composer.addPass(this.bloomPass);
    // ★ 末级 = OutputPass：它按 `renderer.toneMapping` / `toneMappingExposure` /
    //   `outputColorSpace` 做**色调映射 + 线性→sRGB**，而且它渲染到默认帧缓冲，
    //   所以那两行 ACES 配置**到这里才第一次真正生效**。
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  /**
   * 换画质档位——**立即生效**，不需要刷新页面。
   * 能实时改的：像素比、泛光、抗锯齿（抗锯齿无法改，需重建时生效）、粒子预算（下次构建生效）。
   */
  applyTier(tierId) {
    const t = TIERS[tierId];
    if (!t || !this.gpu) return false;
    this.tier = t;
    this.gpu.tierId = t.id;
    this._advisedSlow = false;   // 换了档位就重新给一次「帧率偏低」的提示机会

    this.options.bloom = t.bloom;
    this.renderer.setPixelRatio(this._targetPixelRatio());
    this.resize();
    this.dispatchEvent(new CustomEvent('tier', { detail: t }));
    return true;
  }

  /**
   * 切换 GPU 偏好。`powerPreference` 在上下文创建后无法更改，
   * 因此这里重建渲染器 + 后期处理链，并重建各层级的 GPU 资源。
   * 失败时返回 false，由调用方提示用户手动刷新。
   */
  setGpuPreferences(gpu) {
    const old = this.renderer;
    try {
      this.gpu = gpu;
      this.tier = gpu.tier;

      // 1) 丢弃旧的后期处理链与纹理缓存（都绑在旧上下文上）
      this.composer?.dispose?.();
      this._texCache?.clear();

      // 2) 重建渲染器
      this._createRenderer();

      // 3) 重建后期处理链与过渡用的渲染目标
      this._rtA?.dispose?.();
      this._rtB?.dispose?.();
      this._rtA = this._makeRT();
      this._rtB = this._makeRT();
      this._createComposer();

      // 4) 各层级场景里的 GPU 资源全部失效，逐个彻底释放
      for (const lv of this.levels.values()) this._releaseLevel(lv);
      const cur = this.current;
      if (cur) {
        cur.ensureBuilt();
        this._attachControls(cur);
        this._setLabels(cur);
      }
      try { old?.dispose?.(); } catch { /* 旧上下文可能已不可用 */ }
      this.options.bloom = this.tier.bloom;
      this.options.labels = this.options.labels;
      this.resize();
      this.dispatchEvent(new CustomEvent('tier', { detail: this.tier }));
      return true;
    } catch (err) {
      console.error('[engine] 切换 GPU 偏好失败，需要刷新页面', err);
      return false;
    }
  }

  /** 当前画质档位 */
  get tierId() { return this.tier?.id || 'balanced'; }

  /**
   * 彻底释放一个层级的 GPU 资源。
   * 几何体、材质、材质上的贴图都要显式 dispose —— 光把 scene 丢掉，
   * GPU 侧的显存不会回收，低配机器会一路涨到上下文丢失。
   */
  _releaseLevel(lv) {
    if (!lv) return;
    try { lv.dispose?.(); } catch { /* 层级自定义清理失败不影响后续 */ }
    try {
      lv.scene.traverse((o) => {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of mats) {
          for (const k of ['map', 'normalMap', 'specularMap', 'alphaMap', 'emissiveMap', 'roughnessMap', 'metalnessMap']) {
            m[k]?.dispose?.();
          }
          m.dispose?.();
        }
      });
    } catch (err) { console.warn('[engine] 释放层级资源失败', lv.id, err); }
    try { lv.labels.clear(); } catch { /* ignore */ }
    lv.scene = new THREE.Scene();
    lv.built = false;
  }

  /**
   * 只保留当前层级与尺度阶梯上相邻的 ±1 层，其余的释放掉。
   *
   *  为什么必须这么做：每层都是独立场景（银河系十几万粒子、宇宙网几万粒子），
   *  六层全常驻会吃掉大量显存。用户走到「可观测宇宙」时，早就不再需要
   *  「太阳系」那一堆 4K 贴图了——留着只会和别的程序抢显卡，
   *  正是这个项目要避免的事。需要时再 build 一次即可（各层构建都在秒级）。
   */
  _trimLevels() {
    const cur = this.current;
    if (!cur) return;
    const center = scaleOrder(cur.id);
    if (center < 0) return;   // 不在尺度阶梯上的层级（不该发生）就都不动
    for (const lv of this.levels.values()) {
      if (lv === cur || !lv.built) continue;
      if (this.transition && (lv === this.transition.from || lv === this.transition.to)) continue;
      const o = scaleOrder(lv.id);
      if (o < 0) continue;
      if (Math.abs(o - center) > 1) this._releaseLevel(lv);
    }
  }

  _makeLabels() {
    const el = document.createElement('div');
    el.className = 'label-layer';
    this.labelsEl.appendChild(el);
    return new LabelLayer(el);
  }

  _makeRT() {
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.renderer.capabilities.isWebGL2 ? 4 : 0,
      depthBuffer: true,
    });
    // ★ 线性（不再标 sRGB）：过渡快照要存的是**线性光**，跟主链的累积空间保持一致。
    //   原来标 SRGBColorSpace ⇒ 快照存的是编码值，而 `_blendMat` 是原样拷贝、
    //   末级再按线性去色调映射，等于**解码了一次不该解码的东西**。
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    rt.texture.minFilter = THREE.LinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    return rt;
  }

  /** 占位贴图（2×2 中灰），贴图真正加载完成前避免天体变黑 */
  _placeholderImage() {
    if (!this._phImg) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 2;
      const g = cv.getContext('2d');
      g.fillStyle = '#7c8288';
      g.fillRect(0, 0, 2, 2);
      this._phImg = cv;
    }
    return this._phImg;
  }

  /**
   * 纹理加载（带缓存）。直接交给 TextureLoader，保证拿到正确贴图；
   * 并发压力由贴图体积预算控制（见 tools/build-textures.py 的 WIDTH_OVERRIDE）。
   */
  _texture(name) {
    if (this._texCache.has(name)) return this._texCache.get(name);
    const tex = new THREE.TextureLoader().load(
      `./textures/${name}`,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        t.needsUpdate = true;
      },
      undefined,
      () => {
        tex.image = this._placeholderImage();
        tex.needsUpdate = true;
        console.warn('[engine] 贴图加载失败，已用占位色:', name);
      },
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this._texCache.set(name, tex);
    return tex;
  }

  register(level) {
    this.levels.set(level.id, level);
    this.dispatchEvent(new CustomEvent('registered', { detail: level }));
    // 关键：注册后立刻按当前视口校正相机宽高比，否则球体会被拉成椭圆
    this.resize();
    return level;
  }

  get size() { return { w: this.canvas.clientWidth || window.innerWidth, h: this.canvas.clientHeight || window.innerHeight }; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const dpr = this.renderer.getPixelRatio();
    this._rtA.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
    this._rtB.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer.setSize(buf.x, buf.y);
    for (const lv of this.levels.values()) {
      lv.camera.aspect = w / h;
      lv.camera.updateProjectionMatrix();
      lv.resize?.(w, h);
    }
    this.dispatchEvent(new CustomEvent('resize', { detail: { w, h } }));
  }

  /** 切换层级（含相机推近 + 交叉溶解） */
  async goTo(id, { focus = null, duration = 1.05, instant = false } = {}) {
    const target = this.levels.get(id);
    if (!target) return false;

    // 连续点击时只保留最后一次导航，避免过渡叠加
    const seq = (this._navSeq = (this._navSeq || 0) + 1);

    if (this.current === target && !instant) {
      if (focus) target.focusById(focus);
      return true;
    }

    if (!target.built) {
      // 首次进入某个层级需要构建场景（银河系有 15 万粒子），先让界面把提示画出来
      this.dispatchEvent(new CustomEvent('building', { detail: target }));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (seq !== this._navSeq) return false;
      target.ensureBuilt();
      this.dispatchEvent(new CustomEvent('built', { detail: target }));
      if (seq !== this._navSeq) return false;
    } else {
      // 这一层早就建好了，但某些「全局设置」改过而它当时不是当前层 ——
      // 那种设置（目前是真实比例）只在要被看见时重建才划算，代价由这一层自己欠着。
      // 放在 `else` 里是必须的：`build()` 已经用上了新口径并把脏标记清掉了，
      // 若不分流，就会出现「刚 build 完立刻又 rebuild 一遍」。
      target.refreshIfStale?.();
    }

    /* ★ 跨尺度「飞过去看它」也必须**看得见**它（坑 151）。
     *   有些层默认不画一部分对象（目前只有本星系群层的「群外近邻星系」，
     *   见 `cosmos.js#revealById` 与 `dataset.isLocalGroupMember`）：它们
     *   **仍然建对象、仍然进索引、仍然能被搜到**，只是 `visible = false`。
     *   · 同层时由上一条分支的 `focusById()` 点亮；
     *   · **跨层时不能调 `focusById()`** —— 它内部会 `applyView()`
     *     （`solar` 更是自己起 `tweenTo`），会跟这里的过渡动画抢相机。
     *     所以另给一个**只负责「让它可见」、不碰相机**的可选钩子。
     *   没实现它的层 = 没有「默认不画」的对象，空转是**对的**。
     *   ⚠️ 不调它的后果是**静默的**：相机会稳稳飞到一片空处，零报错。 */
    if (focus) target.revealById?.(focus);

    const view = focus ? (target.viewFor?.(focus) || target.defaultView()) : target.defaultView();

    if (!this.current || instant) {
      this.current = target;
      target.applyView(view);
      this._attachControls(target);
      this._setLabels(target);
      this._trimLevels();
      this.dispatchEvent(new CustomEvent('level', { detail: target }));
      return true;
    }

    // 新层级相机从更远处推近，形成连续缩放的错觉
    if (this.transition) this._finishTransition();   // 上一次过渡未结束时立即收尾
    const base = target.defaultView().position;
    const start = view.position.map((v, i) => v * 2.2 + base[i] * 0.6);
    target.camera.position.set(...(focus ? start : start));
    target.camera.lookAt(...view.target);
    if (target.controls) { target.controls.target.set(...view.target); target.controls.update(); }

    this.transition = {
      from: this.current, to: target, t: 0, duration,
      camFrom: { pos: target.camera.position.clone(), target: new THREE.Vector3(...view.target) },
      camTo: { pos: new THREE.Vector3(...view.position), target: new THREE.Vector3(...view.target) },
    };
    if (this.controls) this.controls.enabled = false;
    this.current.labels.setVisible(false);
    this._snapshot(this.current);   // 冻结旧场景，过渡期间只需渲染新场景
    this.dispatchEvent(new CustomEvent('transitionstart', { detail: { from: this.current, to: target } }));
    return true;
  }

  _finishTransition() {
    const { to } = this.transition;
    this.transition = null;
    this.current = to;
    // 兜底：某些「只在被看见时才重建」的设置（目前是真实比例）欠着一次重建，
    // 而它可能是在过渡动画途中被拨动的（那时 `current` 还不是 `to`）。
    // `solar.setTrueScale()` 已经认了「过渡目标」这一种"正在被看"，所以正常路径下这里是空转；
    // 留着是因为**漏补的代价是「显示着旧口径还一直不更新」**，而它不会有任何报错。
    to.refreshIfStale?.();
    this._attachControls(to);
    this._setLabels(to);
    this._trimLevels();          // 走得够远的层级在这里被释放
    this.dispatchEvent(new CustomEvent('level', { detail: to }));
  }

  _attachControls(level) {
    if (this.controls) this.controls.dispose();
    const cfg = { enableDamping: true, dampingFactor: 0.075, ...level.controlsConfig };
    const controls = new OrbitControls(level.camera, this.canvas);
    Object.assign(controls, cfg);
    controls.autoRotate = this.options.autoRotate !== false;
    controls.autoRotateSpeed = 0.32;
    controls.target.copy(level.controlsTarget ? level.controlsTarget() : new THREE.Vector3(0, 0, 0));
    controls.update();
    this.controls = controls;
    level.controls = controls;
  }

  _setLabels(level) {
    for (const lv of this.levels.values()) lv.labels.setVisible(lv === level && this.options.labels);
  }

  _click(e) {
    if (!this.current) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.current.camera);
    const hit = this.current.pick(ndc, this.raycaster);
    this.dispatchEvent(new CustomEvent('pick', { detail: hit }));
  }

  setOptions(opts) {
    Object.assign(this.options, opts);
    if ('labels' in opts) for (const lv of this.levels.values()) lv.labels.setVisible(lv === this.current && opts.labels);
    if ('orbits' in opts) for (const lv of this.levels.values()) lv.setOrbitsVisible?.(opts.orbits);
    if ('trueScale' in opts) for (const lv of this.levels.values()) lv.setTrueScale?.(opts.trueScale);
    if ('autoRotate' in opts && this.controls) this.controls.autoRotate = opts.autoRotate;
  }

  start() {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      if (this._paused) return;              // 后台停帧
      const cap = this.gpu?.frameCap || 0;   // 可选帧率上限
      if (cap > 0) {
        const now = performance.now();
        if (now - this._lastFrameAt < 1000 / cap - 0.5) return;
        this._lastFrameAt = now;
      }
      this._frame();
    };
    this._clock.start();
    loop();
  }

  _frame() {
    const dt = Math.min(0.1, this._clock.getDelta());
    const { w, h } = this.size;

    if (this.transition) {
      const tr = this.transition;
      tr.t += dt / tr.duration;
      const p = Math.min(1, tr.t);
      const e = EASE(p);
      tr.to.camera.position.lerpVectors(tr.camFrom.pos, tr.camTo.pos, e);
      tr.to.camera.lookAt(tr.camTo.target);
      if (tr.to.controls) { tr.to.controls.target.copy(tr.camTo.target); }
      tr.to.update(dt, this.ctx.clock);
      // 旧场景在过渡开始时已冻结成一张快照（rtA），这里只渲染新场景 → 每帧只画一遍
      this._renderToRT(tr.to, this._rtB);
      this._blend(p);
      if (p >= 1) this._finishTransition();
    } else if (this.current) {
      // 视角过渡由**引擎**推进，不放在层级自己的 `update()` 里 —— 六个子类没有一个
      // 调 `super.update()`，写在那里等于永远不跑（见 `Level.tickTween` 的注释）。
      this.current.tickTween?.(dt);
      this.current.update(dt, this.ctx.clock);
      if (this.forceRT) this._renderPair(this.current, this.current, 1);
      else {
        /* ★ 统一走 composer，**删掉了原来的直出分支**。
         *
         * 原来：`options.bloom !== false` → composer；否则 → `renderer.render(scene, cam)`
         * 直接渲染到默认帧缓冲。而 three 只在**渲染到默认帧缓冲**时注入色调映射
         * （见 _createComposer 上面那段），于是：
         *   · 均衡/高性能档（bloom 开）→ 走 composer → 没有末级色调映射；
         *   · **省电档（bloom 关）→ 直出 → 色调映射逐片元生效**。
         * 同一台机器上换个画质档，**画面的传输曲线就变了一套** ——
         * 而用户在界面上只看到「省电 / 均衡 / 高性能」三个字，根本不会想到
         * 它顺带改了影调。这是典型的静默不一致：**降级逻辑改了，别处的口径没跟上。**
         *
         * 现在 bloom 只作为一个 pass 开关，链子（线性累积 → 泛光 → 末级曲线）
         * 在每一档上都一样。省电档少的就是泛光本身。 */
        this.bloomPass.enabled = this.options.bloom !== false;
        this.renderPass.scene = this.current.scene;
        this.renderPass.camera = this.current.camera;
        this.composer.render(dt);
      }
    }

    if (this.controls && this.controls.enabled) this.controls.update();

    // 宽高比守卫：任何时刻相机宽高比都必须与视口一致（否则球体变椭圆）
    const active0 = this.transition ? this.transition.to : this.current;
    if (active0 && Math.abs(active0.camera.aspect - w / h) > 1e-4) {
      active0.camera.aspect = w / h;
      active0.camera.updateProjectionMatrix();
    }

    // 标签
    const active = this.transition ? this.transition.to : this.current;
    if (active && this.options.labels) {
      // 可见范围随取景距离自适应：近距离特写时自动隐藏远处无关标签
      const opts = { ...(active.labelOptions || {}) };
      const ctrl = active.controls?.target;
      if (ctrl) {
        const focus = active.camera.position.distanceTo(ctrl);
        if (focus > 0) opts.maxDistance = Math.min(opts.maxDistance ?? Infinity, Math.max(0.02, focus * 26));
      }
      active.labels.update(active.camera, w, h, opts);
    }

    // FPS
    this._fps.frames++;
    const now = performance.now();
    if (now - this._fps.last > 500) {
      this._fps.value = Math.round((this._fps.frames * 1000) / (now - this._fps.last));
      this._fps.frames = 0;
      this._fps.last = now;
      this.dispatchEvent(new CustomEvent('fps', { detail: this._fps.value }));
      // 自适应画质：持续低帧时逐级降档（像素比 → 关泛光 → 降星空密度），避免卡死
      if (this._fps.value > 0 && this._fps.value < 22) this._slow = (this._slow || 0) + 1;
      else this._slow = 0;
      if (this._slow >= 6) {
        this._slow = 0;
        // 用户手动锁定过档位就不擅自改——只在旁边提示一句，选择权还给用户
        if (this.gpu?.tierPinned) {
          if (!this._advisedSlow) {
            this._advisedSlow = true;
            this.dispatchEvent(new CustomEvent('quality', {
              detail: { step: 'advice', fps: this._fps.value, tier: this.tierId },
            }));
          }
        } else {
          // 逐级降档：高性能 → 均衡 → 省电；到省电仍卡就继续压像素比
          const order = ['high', 'balanced', 'saver'];
          const i = order.indexOf(this.tierId);
          if (i >= 0 && i < order.length - 1) {
            this.applyTier(order[i + 1]);
            this.dispatchEvent(new CustomEvent('quality', { detail: { step: 'tier', tier: order[i + 1] } }));
          } else if (this.renderer.getPixelRatio() > 0.75) {
            this.renderer.setPixelRatio(Math.max(0.75, this.renderer.getPixelRatio() - 0.25));
            this.resize();
            this.dispatchEvent(new CustomEvent('quality', { detail: { step: 'pixelRatio' } }));
          }
        }
      }
    }
    this.dispatchEvent(new CustomEvent('frame', { detail: { dt } }));
  }

  _renderToRT(level, rt) {
    this.renderer.setRenderTarget(rt);
    this.renderer.clear();
    this.renderer.render(level.scene, level.camera);
    this.renderer.setRenderTarget(null);
  }

  /** 把当前场景冻结成一张快照（过渡期间作为淡出的底图） */
  _snapshot(level) {
    if (!level) return;
    this._renderToRT(level, this._rtA);
  }

  _blend(progress) {
    this._blendMat.uniforms.tFrom.value = this._rtA.texture;
    this._blendMat.uniforms.tTo.value = this._rtB.texture;
    this._blendMat.uniforms.progress.value = progress;
    /* ★ 过渡合成也走同一条链（原来是把 `_blendScene` 直出到屏幕）。
     * 为什么必须改：`_rtA/_rtB` 现在存的是**线性 HDR**，而这句原来是
     * `renderer.render(_blendScene, ...)` 渲染到 null —— 逐片元色调映射会生效、
     * 但拷贝出来的线性值没有做「线性→sRGB」的编码。
     * 结果是**过渡中的每一帧和落定后的那一帧走两套传输曲线**，
     * 交界处会出现一次可见的跳变（这类「同一画面两条口径」的账，
     * 本项目已经记过好几次了）。
     * 现在统一：`_blendScene` 当普通场景喂给 RenderPass → 泛光 → 末级曲线。 */
    this.bloomPass.enabled = this.options.bloom !== false;
    this.renderPass.scene = this._blendScene;
    this.renderPass.camera = this._blendCamera;
    this.composer.render(0);
  }

  _renderPair(from, to, progress) {
    this._renderToRT(from, this._rtA);
    this._renderToRT(to, this._rtB);
    this._blend(progress);
  }
}

export { OrbitControls };

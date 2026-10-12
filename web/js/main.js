/**
 * 小小宇宙 · 入口
 *
 *  项目范围：从太阳系一路到可观测宇宙，共六个尺度层级：
 *    太阳系 → 邻近恒星系 → 银河系 → 本星系群 → 室女座超星系团 → 可观测宇宙
 *  每层独立场景与长度单位，靠 Engine 的「拉远/拉近」在尺度阶梯上连续切换。
 *
 *  显卡：启动时探测 GPU，自动选一套不抢资源的画质档位（见 core/gpu.js）。
 */
import { Engine } from './core/engine.js';
import { SimClock } from './core/time.js';
import { GpuConfig } from './core/gpu.js';
import { SCALE_CHAIN, SCALE_BY_ID } from './core/scales.js';
import { Dataset } from './data/dataset.js';
import { loadOverrides } from './data/overrides.js';
import { SolarLevel } from './levels/solar.js';
import { NeighborhoodLevel } from './levels/neighborhood.js';
import { GalaxyLevel } from './levels/galaxy.js';
import { LocalGroupLevel, UniverseLevel } from './levels/cosmos.js';
import { SuperclusterLevel } from './levels/supercluster.js';
import { Nav } from './ui/nav.js';
import { Panel, InfoPanel, Catalog } from './ui/panel.js';
import { Research } from './ui/research.js';
import { Hud } from './ui/hud.js';
import { DataCenter } from './ui/datacenter.js';

const bootEl = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const bootBar = document.getElementById('boot-progress');
const DIAG = new URLSearchParams(location.search).has('diag');
const diag = (msg) => {
  if (DIAG) { try { navigator.sendBeacon(`/api/diag?m=${encodeURIComponent(msg)}`); } catch { /* ignore */ } }
  console.log('[boot]', msg);
};
const setBoot = (msg, p) => { bootStatus.textContent = msg; bootBar.style.width = `${Math.round(p * 100)}%`; diag(msg); };

const app = {
  engine: null, dataset: null, clock: null, gpu: null, ui: {},
  view: 'overview',
  toast(msg, type = '') {
    const box = document.getElementById('toast');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 3200);
    setTimeout(() => el.remove(), 3700);
  },
  /** 切换当前层级的视角预设 */
  setView(name) {
    const lv = app.engine.current;
    if (!lv) return;
    app.view = name === 'overview' ? 'overview' : name;
    lv.stopFollow?.();
    const view = name === 'overview' || !lv.viewPreset ? lv.defaultView() : lv.viewPreset(name);
    if (!view) return;
    /* ⚠️ 这里不能写成裸的 `lv.tweenTo(view)`。
     *
     * 上一轮的真实故障就是这一行：`tweenTo` 当时只定义在 `solar.js`，
     * 其余 5 层在这里抛 `TypeError`，**异常被浏览器吞掉**，界面上只表现为
     * 「按钮点了没反应」—— 镜头不动、连下一行的 `setActiveView` 都跑不到，
     * 按钮连高亮都没有。用户把它描述成「宇宙全景貌似点不了了」。
     *
     * 修法分两层：① 方法搬进基类（`Level.tweenTo`），**让缺失不再可能**；
     *            ② 万一以后又有谁漏了，这里**吵一声再降级**，不静默变摆设。
     * 只做 ② 不做 ① 是治标：用户仍然会觉得「按钮坏了但没人说」。
     */
    if (typeof lv.tweenTo === 'function') {
      lv.tweenTo(view);
    } else {
      console.error(`[nav] 层级 ${lv.id} 没有 tweenTo()，退化为瞬间切换`);
      lv.applyView?.(view);
    }
    app.ui.nav.setActiveView(app.view);
  },
  /** 跳到某个尺度层级（不聚焦具体天体） */
  async gotoScale(levelId) {
    if (!app.engine.levels.has(levelId)) {
      app.toast('该尺度层级尚未装载', 'err');
      diag(`[nav] gotoScale(${levelId})：层级未注册`);
      return false;
    }
    const ok = await app.engine.goTo(levelId);
    if (!ok) {
      /* `goTo()` 返回 false 有两条路，**两条都不报错、界面上都是「点了没反应」**：
       *   · 层级没注册（上面已挡掉）；
       *   · 这次导航被更晚的一次点击顶掉（`engine._navSeq` 变了）。
       * 第二条是设计使然（连点两次时前一次本就该放弃），所以**不弹 toast 打扰用户**，
       * 但必须留一行证据 —— 否则以后真出故障时，这里什么都查不到。 */
      diag(`[nav] goTo(${levelId}) 返回 false：多半是被更晚的一次点击顶掉了`);
      return false;
    }
    app.view = 'overview';
    const s = SCALE_BY_ID.get(levelId);
    app.ui.nav?.setActiveView('overview');
    app.ui.nav?.setCrumb(s?.name || levelId, s?.subtitle || '');
    return true;
  },
  /** 选中天体（只开资料面板，不移动镜头） */
  select(id, { focus = false } = {}) {
    const b = app.dataset.get(id);
    if (!b) return;
    app.ui.info.show(id);
    app.ui.catalog?.setActive?.(id);
    if (focus) app.engine.current?.focusById?.(id);
  },
  /**
   * 前往任意尺度的目的地：如果目标天体不在当前层级，先切层级再聚焦。
   * 这是「跨尺度导航」的核心——从太阳系直接搜到仙女座星系也能一步到位。
   */
  async gotoDestination(id) {
    const b = app.dataset.get(id);
    if (!b) { app.toast('没有找到该目的地', 'err'); return; }

    // 视角预设
    if (b.type === 'view') {
      await app.gotoScale(b.level);
      app.setView(b.view);
      app.ui.nav.setCrumb(b.name, b.sub);
      return;
    }

    const levelId = b.level || 'solar';
    const cur = app.engine.current?.id;
    if (app.engine.levels.has(levelId) && cur !== levelId) {
      await app.engine.goTo(levelId, { focus: id });
    } else {
      app.engine.current?.focusById?.(id);
    }
    app.ui.info.show(id);
    app.ui.nav.setCrumb(b.name, b.typeLabel || '');
    app.ui.catalog?.setActive?.(id);
  },
};
window.__universe = app;

async function boot() {
  try {
    setBoot('探测显卡与画质档位…', 0.04);
    const gpu = new GpuConfig();
    app.gpu = gpu;
    diag(`GPU: ${gpu.gpuShort} | 类型=${gpu.gpu.kind} | 偏好=${gpu.preference} | 档位=${gpu.tierId}`);
    if (gpu.gpu.kind === 'software') app._softwareGl = true;

    setBoot('初始化渲染引擎…', 0.08);
    const canvas = document.getElementById('scene');
    const engine = new Engine({ canvas, labelsEl: document.getElementById('labels'), gpu });
    app.engine = engine;
    app.clock = new SimClock();
    engine.ctx.clock = app.clock;
    engine.ctx.onSelect = (id) => app.select(id);

    setBoot('装载星历与天体数据…', 0.25);
    // 人工覆盖表先读进来，交给 Dataset 在建目录与索引之前应用
    const ov = await loadOverrides();
    app.overrides = ov;
    if (ov.error) diag(`覆盖表读取失败（已忽略）：${ov.error}`);
    else diag(`覆盖表：${ov.overrides.length} 条`);
    app.dataset = await new Dataset().load((msg, p) => setBoot(msg, 0.25 + p * 0.5), { overrides: ov.overrides });
    const oa = app.dataset.overridesApplied?.length || 0;
    const of_ = app.dataset.overridesFailed?.length || 0;
    if (oa || of_) diag(`已应用人工修正 ${oa} 条${of_ ? `，失败 ${of_} 条` : ''}`);
    if (of_) {
      for (const f of app.dataset.overridesFailed) console.warn('[overrides] 未应用：', f.entityId, f.path, f.reason);
    }

    setBoot('构建宇宙尺度层级…', 0.8);
    engine.register(new SolarLevel(engine.ctx, app.dataset));
    engine.register(new NeighborhoodLevel(engine.ctx, app.dataset));
    engine.register(new GalaxyLevel(engine.ctx, app.dataset));
    engine.register(new LocalGroupLevel(engine.ctx, app.dataset));
    engine.register(new SuperclusterLevel(engine.ctx, app.dataset));
    engine.register(new UniverseLevel(engine.ctx, app.dataset));
    diag(`已注册层级：${[...engine.levels.keys()].join(' / ')}`);

    setBoot('初始化界面…', 0.93);
    app.ui.panel = new Panel(app);
    app.ui.info = new InfoPanel(app);
    app.ui.catalog = new Catalog(app);
    app.ui.research = new Research(app);
    app.ui.nav = new Nav(app);
    app.ui.hud = new Hud(app);
    app.ui.datacenter = new DataCenter(app);
    app.ui.research.checkHealth();

    engine.addEventListener('pick', (e) => { if (e.detail?.id) app.select(e.detail.id); });
    engine.addEventListener('fps', (e) => app.ui.hud.setFps(e.detail));
    engine.addEventListener('tier', (e) => {
      app.ui.nav?.syncScaleBar?.();
      app.ui.hud?.syncTier?.();
    });
    engine.addEventListener('level', (e) => {
      app.ui.nav.onLevel(e.detail);
      // 目录面板里高亮「我现在在哪一层」——只切 class，不重建 DOM
      app.ui.catalog?.syncScale?.(e.detail.id);
    });
    engine.addEventListener('building', (e) => app.ui.hud.setBusy(`正在构建「${e.detail.name}」场景…`));
    engine.addEventListener('built', () => app.ui.hud.setBusy(null));
    engine.addEventListener('scale', (e) => {
      app.view = 'overview';
      app.ui.nav?.setCrumb(e.detail.name, e.detail.subtitle);
      app.ui.nav?.syncScaleBar?.();
      app.ui.hud?.syncTier?.();
      app.toast(`${e.detail.direction === 'out' ? '拉远' : '拉近'}到「${e.detail.name}」 · ${e.detail.unitNote}`);
    });
    engine.addEventListener('scalelimit', (e) => {
      app.toast(e.detail.end === 'max' ? '已经到可观测宇宙了——再往外是宇宙微波背景' : '已经到太阳系了——这里是我们的家', 'err');
    });
    engine.addEventListener('scalemissing', (e) => app.toast(`「${e.detail.name}」层级未装载`, 'err'));
    engine.addEventListener('quality', (e) => {
      const d = e.detail || {};
      if (d.step === 'advice') {
        app.toast(`当前档位下帧率偏低（${d.fps} FPS）。你手动锁定过档位，我不会擅自替你改——可在「设置 → 显卡与性能」里自行降档。`);
      } else if (d.step === 'tier') {
        app.toast(`检测到帧率偏低，已自动降到「${d.tier === 'saver' ? '省电' : '均衡'}」档`);
      } else {
        app.toast('检测到帧率偏低，已自动降低渲染分辨率');
      }
      app.ui.hud?.syncTier?.();
    });
    engine.addEventListener('contextlost', () => app.toast('显卡资源紧张，正在恢复渲染…（请稍候，不要刷新页面）', 'err'));
    engine.addEventListener('contextrestored', () => app.toast('渲染已恢复'));

    document.getElementById('btn-catalog').addEventListener('click', () => app.ui.catalog.toggle());
    document.getElementById('btn-research').addEventListener('click', () => app.ui.research.open());
    document.getElementById('zoom-out').addEventListener('click', () => engine.zoomOut());
    document.getElementById('zoom-in').addEventListener('click', () => engine.zoomIn());

    // 键盘：数字键切当前层级的视角，PageUp/PageDown 跨尺度，空格暂停，F 跟随
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (/^[1-9]$/.test(e.key)) {
        const views = app.ui.nav.currentViews();
        const v = views[Number(e.key) - 1];
        if (v) app.setView(v.view);
      } else if (e.key === 'PageUp') { e.preventDefault(); app.engine.zoomOut(); }
      else if (e.key === 'PageDown') { e.preventDefault(); app.engine.zoomIn(); }
      else if (e.key === ' ') { e.preventDefault(); app.ui.hud.togglePlay(); }
      else if (e.key.toLowerCase() === 'f' && app.ui.info.current) app.engine.current?.focusById?.(app.ui.info.current);
    });

    setBoot('渲染第一帧…', 0.98);
    await engine.goTo('solar', { instant: true });
    app.ui.nav.onLevel(engine.current);
    diag('太阳系场景已构建');
    engine.start();
    diag('渲染循环已启动');
    setInterval(() => app.ui.hud.tick(), 250);

    setTimeout(() => {
      bootEl.classList.add('done');
      setTimeout(() => { bootEl.style.display = 'none'; }, 800);
      const tip = gpu.gpu.kind === 'software'
        ? '未检测到硬件加速，已自动进入省电档；可在「设置 → 显卡与性能」中查看。'
        : `显卡：${gpu.gpuShort} · 画质档位：${gpu.tier.label}。滚轮拉到底可跨尺度切换到银河系与更远方。`;
      app.toast(tip);
    }, 260);
    diag('启动完成');
  } catch (err) {
    console.error(err);
    bootStatus.innerHTML = `<span style="color:#ffb4b4">启动失败：${err.message}</span><br><small>请使用 Chrome / Edge 等支持 WebGL2 的浏览器，并通过 <code>npm start</code> 启动本地服务后访问。</small>`;
    bootBar.style.width = '100%';
    bootBar.style.background = '#ff6b6b';
  }
}

boot();

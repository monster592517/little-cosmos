/**
 * 显卡与画质管理
 *
 *  这个项目要在「核显机器」和「独显机器」上都能跑，而且不能和别的程序抢显卡。
 *  浏览器给我们的控制权其实很有限，先把边界说清楚：
 *
 *   1. WebGL 只能通过 `powerPreference` **建议**用哪一类 GPU
 *      （'default' / 'low-power' / 'high-performance'），**不能指定具体某一颗**。
 *      真正的选择权在浏览器/驱动手里，我们只能影响它的倾向。
 *   2. 上下文一旦创建，`powerPreference` 就不能改 —— 换档必须重建 WebGLRenderer。
 *   3. 剩下的全部靠我们自己控制：像素比、粒子预算、后期处理、纹理各向异性、帧率。
 *
 *  所以策略是：
 *   · 「自动」模式下用 `powerPreference: 'default'`，把选择权交还浏览器 ——
 *     混合显卡笔记本上通常走核显，台式机上走独显，天然不抢资源；
 *   · 用户可以手动锁定「核显优先」（'low-power'）或「独显优先」（'high-performance'）；
 *   · 无论走哪颗 GPU，画质档位（省电/均衡/高性能）都独立可调，且**立即生效**。
 */

const LS_KEY = 'lc.gpu.v1';
/** 更名遗留：旧版本存画质偏好用的键。只读兼容一次，读到就迁到新键并清掉，避免老用户偏好丢失。 */
const LEGACY_LS_KEY = 'lss.gpu.v1';

/** 画质档位：档位的每一项都是引擎真正会读的参数 */
export const TIERS = {
  saver: {
    id: 'saver',
    label: '省电',
    desc: '限制渲染分辨率与粒子数量、关闭泛光与抗锯齿。显卡占用最低，适合核显、笔记本电池模式，或需要把显卡让给其它程序时。',
    pixelRatio: 1.0,
    maxPixelRatio: 1.0,
    antialias: false,
    bloom: false,
    /** 星空 / 点云粒子数倍率 */
    fieldScale: 0.3,
    /** 银河系盘、宇宙网这类大规模点云的上限 */
    pointBudget: 60000,
    /** 同时可见的文字标签上限 */
    labelBudget: 70,
    aniso: 2,
    /** 过渡期间是否渲染双场景 */
    doubleBuffer: false,
  },
  balanced: {
    id: 'balanced',
    label: '均衡',
    desc: '兼顾画质与占用：渲染分辨率适中，保留泛光，粒子数量减半。适合大多数核显与轻薄本。',
    pixelRatio: 1.25,
    maxPixelRatio: 1.5,
    antialias: true,
    bloom: true,
    fieldScale: 0.65,
    pointBudget: 140000,
    labelBudget: 150,
    aniso: 4,
    doubleBuffer: true,
  },
  high: {
    id: 'high',
    label: '高性能',
    desc: '完整画质：高分辨率渲染、全量粒子、泛光与抗锯齿全开。适合独显，或你想要最佳视觉效果时。',
    pixelRatio: 2,
    maxPixelRatio: 2,
    antialias: true,
    bloom: true,
    fieldScale: 1,
    pointBudget: 420000,
    labelBudget: 320,
    aniso: 8,
    doubleBuffer: true,
  },
};

export const TIER_ORDER = ['saver', 'balanced', 'high'];

/** GPU 使用偏好 */
export const PREFERENCES = {
  auto: {
    id: 'auto',
    label: '自动',
    desc: '由浏览器决定用哪颗 GPU。混合显卡笔记本上通常走核显，台式机上走独显——不会主动抢独显。',
    powerPreference: 'default',
  },
  igpu: {
    id: 'igpu',
    label: '核显优先',
    desc: '明确请求低功耗 GPU（集成显卡）。独显完全让给其它程序，适合后台挂着跑、边玩游戏边看。',
    powerPreference: 'low-power',
  },
  dgpu: {
    id: 'dgpu',
    label: '独显优先',
    desc: '明确请求高性能 GPU（独立显卡）。画质上限最高，但会与其它程序争抢独显资源。',
    powerPreference: 'high-performance',
  },
};

/* ============================================================
   显卡探测
   ============================================================ */

const SOFTWARE_HINTS = ['swiftshader', 'llvmpipe', 'basic render', 'software', 'microsoft basic'];
// Intel Arc 是独立显卡；其余 Intel 集显占绝大多数
const INTEL_DISCRETE_HINTS = ['arc a', 'arc b', 'arc pro'];
// AMD 独立显卡
const AMD_DISCRETE_HINTS = ['radeon rx', 'radeon pro', 'radeon vii', 'instinct', 'firepro'];

/**
 * 读取真实 GPU 型号。
 * 用一次性的独立 canvas，避免影响主渲染器的上下文。
 */
export function detectGpu() {
  const out = {
    vendor: '—', renderer: '未知',
    family: 'unknown',          // intel | amd | nvidia | apple | qualcomm | microsoft | unknown
    kind: 'unknown',            // discrete | integrated | software | unknown
    unmasked: false,
    webgl2: false,
    maxTextureSize: 0,
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: navigator.deviceMemory || 0,
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
  };

  let gl = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    gl = cv.getContext('webgl2', { failIfMajorPerformanceCaveat: false })
      || cv.getContext('webgl');
    if (!gl) return out;
    out.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      out.vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '—');
      out.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '未知');
      out.unmasked = true;
    } else {
      out.vendor = String(gl.getParameter(gl.VENDOR) || '—');
      out.renderer = String(gl.getParameter(gl.RENDERER) || '未知');
    }
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext?.();
  } catch {
    return out;
  }

  const r = out.renderer.toLowerCase();
  const v = out.vendor.toLowerCase();
  const hay = `${r} ${v}`;

  if (SOFTWARE_HINTS.some((h) => hay.includes(h))) {
    out.family = 'software';
    out.kind = 'software';
    return out;
  }
  if (hay.includes('nvidia') || hay.includes('geforce') || hay.includes('quadro')) {
    out.family = 'nvidia';
    out.kind = hay.includes('tegra') ? 'integrated' : 'discrete';
    return out;
  }
  if (hay.includes('apple')) {
    out.family = 'apple';
    out.kind = 'integrated';   // 统一内存架构，功耗特征接近集显
    return out;
  }
  if (hay.includes('intel')) {
    out.family = 'intel';
    out.kind = INTEL_DISCRETE_HINTS.some((h) => hay.includes(h)) ? 'discrete' : 'integrated';
    return out;
  }
  if (hay.includes('amd') || hay.includes('radeon') || hay.includes('ati ') || hay.includes('advanced micro')) {
    out.family = 'amd';
    if (AMD_DISCRETE_HINTS.some((h) => hay.includes(h))) out.kind = 'discrete';
    // "Radeon Graphics" / "Radeon Vega 8" / "Radeon 780M" / "Radeon(TM) Graphics" 都是 APU 集显
    else if (/radeon.*\b(vega|graphics|\d{3}m)\b/.test(r) || r.includes('radeon graphics')) out.kind = 'integrated';
    else out.kind = 'unknown';
    return out;
  }
  if (hay.includes('qualcomm') || hay.includes('adreno') || hay.includes('mali') || hay.includes('powervr')) {
    out.family = 'qualcomm';
    out.kind = 'integrated';
    return out;
  }
  return out;
}

/** 根据探测结果推断一个合理的起始画质档位 */
export function recommendTier(gpu) {
  if (gpu.kind === 'software') return 'saver';
  if (gpu.kind === 'integrated') {
    // 核显里也分三六九等：Apple 统一内存与 Intel Arc 核显能扛住均衡档
    const strong = /apple m\d|arc|iris xe|radeon 7\d0m|radeon 8\d0m/i.test(gpu.renderer);
    return strong ? 'balanced' : 'saver';
  }
  if (gpu.kind === 'discrete') {
    // 老独显 + 低内存 + 移动端 → 不要直接拉到最高
    const weak = gpu.mobile && (gpu.memoryGb && gpu.memoryGb <= 4) && gpu.cores && gpu.cores <= 4;
    return weak ? 'balanced' : 'high';
  }
  return 'balanced';
}

/* ============================================================
   配置读写
   ============================================================ */

function readStored() {
  try {
    const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem(LEGACY_LS_KEY);
    if (raw) { try { localStorage.setItem(LS_KEY, raw); localStorage.removeItem(LEGACY_LS_KEY); } catch { /* ignore */ } }
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch { return null; }
}

function writeStored(cfg) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* 隐私模式下忽略 */ }
}

/**
 * 显卡配置。构造时读取本地偏好，没有就按探测结果给一套合理默认值。
 */
export class GpuConfig {
  constructor() {
    this.gpu = detectGpu();
    const stored = readStored();

    const recommended = recommendTier(this.gpu);
    this.recommendedTier = recommended;

    /** 是否由用户显式设置过（用于提示「已自动适配」还是「已按你的设置」） */
    this.userSet = Boolean(stored);
    this.preference = PREFERENCES[stored?.preference] ? stored.preference : 'auto';
    this.tierId = TIERS[stored?.tierId] ? stored.tierId : recommended;
    /** 用户是否手动锁死档位（false = 档位跟随偏好自动推导） */
    this.tierPinned = stored?.tierPinned === true;
    /** 是否在页面隐藏时暂停渲染以彻底释放 GPU */
    this.pauseWhenHidden = stored?.pauseWhenHidden !== false;
    /** 帧率上限（0 = 不限） */
    this.frameCap = Number.isFinite(stored?.frameCap) ? stored.frameCap : 0;
  }

  get tier() { return TIERS[this.tierId]; }
  get pref() { return PREFERENCES[this.preference]; }

  /** 是否处于「自动适配」状态（用户没动过任何设置） */
  get isAuto() { return !this.userSet; }

  /** GPU 的 human-readable 描述 */
  get gpuLabel() {
    const k = { discrete: '独立显卡', integrated: '集成显卡', software: '软件渲染', unknown: '未知类型' }[this.gpu.kind];
    return `${this.gpu.renderer}（${k}）`;
  }

  /** 把 renderer 字符串洗一下，太长的话给出简称 */
  get gpuShort() {
    const r = this.gpu.renderer
      .replace(/ANGLE \((.*)\)$/, '$1')
      .replace(/Direct3D\d+ vs_\d_\d ps_\d_\d,?\s*/i, '')
      .replace(/\(0x[0-9A-Fa-f]+\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return r.length > 58 ? `${r.slice(0, 55)}…` : r;
  }

  save() {
    writeStored({
      preference: this.preference,
      tierId: this.tierId,
      tierPinned: this.tierPinned,
      pauseWhenHidden: this.pauseWhenHidden,
      frameCap: this.frameCap,
    });
    this.userSet = true;
  }

  setPreference(id) {
    if (!PREFERENCES[id]) return false;
    const changed = this.preference !== id;
    this.preference = id;
    // 除非用户手动锁过档位，否则档位跟着偏好走
    if (!this.tierPinned) {
      if (id === 'igpu') this.tierId = 'saver';
      else if (id === 'dgpu') this.tierId = 'high';
      else this.tierId = this.recommendedTier;
    }
    this.save();
    return changed;
  }

  setTier(id) {
    if (!TIERS[id]) return false;
    const changed = this.tierId !== id;
    this.tierId = id;
    this.tierPinned = true;
    this.save();
    return changed;
  }

  /** 恢复成按硬件自动适配 */
  resetAuto() {
    this.preference = 'auto';
    this.tierId = this.recommendedTier;
    this.tierPinned = false;
    this.userSet = false;
    this.pauseWhenHidden = true;
    this.frameCap = 0;
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  }

  /** 覆盖帧率上限 / 失焦暂停这类细项（不影响档位是否被锁定） */
  setFine(patch) {
    if ('pauseWhenHidden' in patch) this.pauseWhenHidden = Boolean(patch.pauseWhenHidden);
    if ('frameCap' in patch) this.frameCap = Number(patch.frameCap) || 0;
    this.save();
  }

  /** 给渲染器用的 powerPreference */
  get powerPreference() { return this.pref.powerPreference; }

  /** 一次性描述当前处于什么状态，用于界面文案 */
  describe() {
    const lines = [];
    lines.push(`检测到的显卡：${this.gpuLabel}`);
    if (this.gpu.kind === 'software') {
      lines.push('⚠️ 当前是软件渲染（没有可用的硬件加速）。程序会自动进入省电档，画面会明显简化，但仍可运行。');
    } else if (this.gpu.kind === 'integrated') {
      lines.push('这是集成显卡。推荐「省电」或「均衡」档；独显机器可以手动切「独显优先」+「高性能」。');
    } else if (this.gpu.kind === 'discrete') {
      lines.push('这是独立显卡。若需要把显卡让给其它程序，可切到「核显优先」或「省电」档。');
    }
    if (this.gpu.mobile) lines.push('检测到移动端设备，已按移动端标准保守取值。');
    return lines;
  }
}

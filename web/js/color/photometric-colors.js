/**
 * 有测光、无逐波长光谱的天体 —— 颜色由**色指数 / 谱斜率**反推
 * ══════════════════════════════════════════════════════════════
 * 这个文件解决什么问题
 * ══════════════════════════════════════════════════════════════
 * `spectra.js` 里放的是**实测逐波长反射率谱**（最高一档证据）。
 * 但很多天体测不到谱 —— 它们太小太暗，或只有宽带测光。
 * 这些天体以前只有一条出路：手写一个"看着差不多"的 hex。
 * 本项目已经证明那是错的（坑 40：14 个手写色全错，且**没人能复核**）。
 *
 * 本文件给它们第二条出路，也是**可审计**的：
 *
 *     宽带测光（B−V / V−R / 谱斜率 Grt）+ 权威几何反照率
 *        → indices-to-spectrum.spectrumFromConstraints()
 *        → 一条满足这些约束的反射率谱
 *        → cie.spectrumToRender()   ← 按 等能白E → CIE1931 2° → D65 → sRGB
 *        → `#rrggbb`
 *
 * ⇒ 颜色**是算出来的**，不是写的。任何人拿同样的输入都能复现同一个 hex。
 *
 * ══════════════════════════════════════════════════════════════
 * 可信度分档（界面必须标出来，不许四舍五入成"高"）
 * ══════════════════════════════════════════════════════════════
 *   高  = 实测逐波长光谱/反照率谱      → spectra.js
 *   中  = 色指数反推，≥2 条约束且自洽   → 本文件
 *   中偏低 = 色指数反推，但约束少或不够自洽（甲烷吸收带落在可见光区、
 *           单斜率模型本身就描述不了的冰质天体都归这里）
 *   低  = 属性生成·纯示意              → 兜底
 *
 * ⚠️ **为什么单约束必须单独降级，不能只看 agree**：
 *    `agree` 是各约束推出的 k 的极差。只有 1 条约束时极差恒为 0 ——
 *    等于"自己跟自己一致"，毫无信息量。若照搬 `agree<=0.5 ⇒ 可信`，
 *    单约束天体反而会被判成**最可信**的一档。所以分档必须先看 `n`。
 *    （这是本项目最容易犯的那类错：**判据看起来能用，方向却是反的**。）
 *
 * ══════════════════════════════════════════════════════════════
 * 数据来源
 * ══════════════════════════════════════════════════════════════
 * 外太阳系测光汇编的权威版本（下称 MBOSS-2）：
 *   O. R. Hainaut, H. Boehnhardt & S. Protopapa (2012), A&A 546, A115,
 *   "Colours of minor bodies in the outer solar system II"
 *   冻结版 ASCII 存在本地：`data/raw/mboss2.dat`（723 个天体 / 2662 历元）
 *   · 只合并**同时测量**（<1 小时）的数据，避免自转导致的假颜色
 *   · B−V / V−R / R−I / V−J / J−H / H−K 全部带 σ 与离散度
 *   · `Grt` 列 = 作者从色指数反解出的可见光反射率斜率（%/100 nm）
 *
 * 谷神星不在 MBOSS 覆盖范围（它是内太阳系天体），单独用：
 *   M. Ciarniello et al. (2017), A&A 598, A130 —— Dawn/VIR 圆面测光。
 */

import {
  spectrumFromConstraints, SINGLE_SLOPE_MAX_AGREE,
} from './indices-to-spectrum.js';
import { spectrumToHex, spectrumToRender } from './cie.js';

/* ==============================================================
   登记表
   ==============================================================
   每一条都必须是**可核对的观测值**，不许填"大概"。字段：
     · geoAlbedo     视觉**几何**反照率（不是 Bond，见 spectra.js 口径）
     · bv / vr       B−V / V−R 观测值（**含太阳色**，本模块负责扣一次）
     · grtPctPerKA   MBOSS 的 Grt（%/100 nm = %/kÅ）
     · epochs        纳入平均的观测历元数（MBOSS 的 Epo 列；null = 圆面测光）
     · src           出处
     · note          口径说明 / 与别的天体为什么不同
   ============================================================== */
export const PHOTOMETRY = Object.freeze({
  ceres: {
    zh: '谷神星', en: 'Ceres',
    notInMboss: 'Ceres 是主带小行星（内太阳系），MBOSS 只收录外太阳系天体，故表里根本没有它。'
      + '数值全部取自 Dawn/VIR 论文本身，无法与 data/photometry.json 机器对账 —— '
      + '由 tools/check-photometry.mjs 断言这条豁免理由存在，并要求手抄值逐位对上论文。',
    geoAlbedo: 0.094,
    vr: 0.38,
    grtPctPerKA: 1.1,
    epochs: null,
    src: 'Ciarniello et al. 2017, A&A 598, A130（Dawn/VIR，Hapke 模型圆面测光）',
    note: 'V−R = 0.38±0.01、几何反照率 0.094±0.007、VIS 谱斜率 1.1 %/kÅ。'
      + '三者指向一条**近乎中性、极淡偏红**的谱 —— 谷神星确实是暗灰的。'
      + '⚠️ 没有 B−V：MBOSS 不覆盖内太阳系天体，故只有 2 条约束。',
  },
  eris: {
    zh: '阋神星', en: 'Eris',
    mbossKey: '136199-Eris',
    geoAlbedo: 0.96,
    bv: 0.805, vr: 0.389, grtPctPerKA: 3.866,
    epochs: 64,
    src: 'MBOSS-2 冻结表（64 历元）· 反照率 Sicardy et al. 2011 / Brown',
    note: '⚠️ 三条约束推的 k 是 0.589 / 0.109 / 0.213，极差 0.481 —— 贴着单斜率门限 0.5。'
      + '原因清楚：阋神星表面是甲烷冰，CH4 吸收带落在 620–730 nm，'
      + '正好在可见光窗口内，**任何单斜率谱都描述不了**。'
      + '所幸它反照率 0.96，明暗这一维很确定，色相偏差在视觉上可忽略。',
  },
  haumea: {
    zh: '妊神星', en: 'Haumea',
    mbossKey: '136108-Haumea',
    geoAlbedo: 0.51,
    bv: 0.631, vr: 0.370, grtPctPerKA: -0.010,
    epochs: 3,
    src: 'MBOSS-2 冻结表（3 历元）· 反照率 Ortiz et al. 2017',
    note: '三条约束高度一致（|Δk| = 0.17），k ≈ −0.06 ⇒ **中性略偏冷**。'
      + '与"表面是结晶水冰"完全吻合 —— 妊神星本来就不该是暖色的。'
      + '⚠️ 旧手写值 #d8d2c8 是暖灰，方向就错了。',
  },
  makemake: {
    zh: '鸟神星', en: 'Makemake',
    mbossKey: '136472-Makemake',
    geoAlbedo: 0.81,
    bv: 0.828, grtPctPerKA: 4.693,
    epochs: 1,
    src: 'MBOSS-2 冻结表（1 历元）· 反照率 Ortiz et al. 2012',
    note: '⚠️ MBOSS 里 V−R 那列是 "------"（只有 1 个历元，凑不出同时测量），'
      + '所以只有 2 条约束，且极差 0.432 —— 同样是 CH4 冰导致的非单斜率。'
      + '仅 1 个历元 ⇒ 自转相位可能污染，置信度再降一档，**并在界面标注**。',
  },
});

/**
 * 可信度分档。**先看 n，再看 agree** —— 顺序不能反（见文件头注释）。
 * @returns {{tier: string, conf: number, reason: string}}
 */
export function tierOf(n, agree) {
  if (!(n >= 1)) return { tier: '低', conf: 0.30, reason: '没有可用约束，应走属性生成' };
  if (n === 1) {
    return { tier: '中偏低', conf: 0.55, reason: '只有 1 条约束（极差恒为 0，不代表自洽）' };
  }
  if (agree <= 0.25) return { tier: '中', conf: 0.75, reason: `${n} 条约束，极差 ${agree.toFixed(3)}，自洽` };
  if (agree <= SINGLE_SLOPE_MAX_AGREE) {
    return { tier: '中偏低', conf: 0.55, reason: `${n} 条约束，极差 ${agree.toFixed(3)} 贴近单斜率门限` };
  }
  return { tier: '低', conf: 0.30, reason: `${n} 条约束极差 ${agree.toFixed(3)} 超门限，单斜率假设不成立` };
}

/** 该天体有没有测光可用来反推颜色 */
export function hasPhotometry(id) {
  return Object.prototype.hasOwnProperty.call(PHOTOMETRY, id);
}

/**
 * 由测光算颜色。返回**两种语义**，调用方按用途选，不许混用：
 *   · `render` —— 保留亮度。网格 / 材质 / 发光 / `color` 字段用这个。
 *   · `swatch` —— Y 归一化，只保证色相对。UI 色板 / 图例用这个。
 *
 * @throws 该天体不在登记表里 / 约束不足 / 反照率非法
 */
export function photometryColor(id) {
  const e = PHOTOMETRY[id];
  if (!e) throw new Error(`photometryColor: ${id} 不在 PHOTOMETRY 登记表里（不许即兴生成）`);

  const r = spectrumFromConstraints({
    bv: e.bv, vr: e.vr, grtPctPerKA: e.grtPctPerKA, geoAlbedo: e.geoAlbedo, id,
  });
  const { tier, conf, reason } = tierOf(r.n, r.agree);

  return {
    id, zh: e.zh, en: e.en,
    render: spectrumToRender(r.grid, { srcWhite: 'E' }).hex,
    swatch: spectrumToHex(r.grid, { srcWhite: 'E' }).hex,
    k: r.k, kFrom: r.kFrom, n: r.n, agree: r.agree,
    geoAlbedo: e.geoAlbedo, epochs: e.epochs,
    tier, conf, reason,
    src: e.src, note: e.note,
  };
}

/** 全部登记天体的颜色（供检查工具与界面遍历） */
export function allPhotometryColors() {
  return Object.keys(PHOTOMETRY).map((id) => {
    try { return photometryColor(id); }
    catch (err) { return { id, error: String(err && err.message || err) }; }
  });
}

export default PHOTOMETRY;

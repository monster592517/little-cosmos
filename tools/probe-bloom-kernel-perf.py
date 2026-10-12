#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""丙（wide-23）的**性能账** —— 抽头数 7→12 / 9→15 到底花不花钱。

## 为什么必须单独量这一次

`probe-bloom-kernel.py` 已经把「方斑」的机制定死了，处方 **丙** 也验过形状：
**σ 保持原值、把抽头数 K 加够到 3σ 截断**（mip2 7→12、mip3 9→15），
结果是**又宽又圆**（对角比 0.991、外接框只缩 1.3%、全屏均值 −5.1%）。

但那条路线的代价落在**模糊着色器的取样次数**上，而**取样次数是性能**。
怪怪的硬指标写在那儿：**帧时间中位数 < 16.7 ms，用户体验不能卡顿**。
⇒ **没量过性能就上丙，等于拿一条硬指标去赌一个猜测。**

## 两个量具（互相独立，理由不同）

| 量具 | 量什么 | 为什么需要它 |
|---|---|---|
| **A. rAF 帧时间** | 真实一整帧（scene + 泛光 + 合成 + 标签） | 这是**用户看到的东西**，硬指标就定义在它上面 |
| **B. 隔离计时泛光通道** | 只跑 `bloomPass.render()`，`gl.finish()` 前后夹 | ① 不受 vsync 封顶；② 与场景无关，**能看见 A 看不见的机制** |

⚠️ **A 有一个已知的失明条件**：如果帧时间被 vsync 钉在 16.7 ms 上（60 Hz 显示器），
那么**无论负载怎么变，中位数都是 16.7** —— 量具饱和 ⇒ A 看不见任何差别。
所以 A **必须**同时报 `min`：`min ≈ 16.6` 就是「被 vsync 封顶了」的读数，
这时 A 的差别列**一整列作废**（不是「丙便宜」）。B 不受此限（它不经过 rAF）。

⚠️ **量具必须先自证**（坑 104/106）：所以第一档 `ctrl-b` 是**同状态再走一遍全流程**，
`ctrl` 与 `ctrl-b` 之差 = **噪声地板**。任何小于地板的差别**不许当结论**。

## 档位与**先写死的预测**（不是事后挑的）

抽头数：着色器循环 `for(i=0; i<K; i++)` 里 i=0 抽 1 次、i≥1 每轮抽 2 次
⇒ 每次 pass 抽 `2K−1` 次；每级有 X/Y 两趟 ⇒ 每级 `2·(2K−1)·W·H` 次纹理取样。

| 档 | 动什么 | 抽头数变化 | 预测（相对 ctrl） |
|---|---|---|---|
| `ctrl` | 出厂 | — | 锚点，必须复现基线 |
| `ctrl-b` | 同状态跑第二遍 | 0 | **就是噪声地板** |
| `box-23` | mip2/3 系数→纯方框，**K 不变** | **0** | 只换系数值 ⇒ 应在地板内（≈0） |
| `thin-all` | 五级 K→2（σ 保持） | **−52.5% 取样** | 应明显更快（负向对照） |
| `wide-23` | **丙**：mip2/3 → K=⌈3σ⌉+1 | **+9.7% 取样**（仅那两级） | 约 **+2.4%** 帧时间 |
| `huge-0` | 只第0级 → K=41（σ 保持） | **+900% 取样** | **量具 B 的灵敏度哨兵**：必须显著变慢 |
| `wide-all` | 五级全部 → K=⌈3σ⌉+1 | **+105.5% 取样** | 约 **+26%** 帧时间 |

（第二列是 `tools/_perf-math-check.py` 按**活页面 RT 尺寸**算出来的代理量，不是手估；
第三列按「泛光链占一帧约 25%」折算 —— **这个 25% 的假设本身也被这次测量检验**：
量具 B 给出泛光通道的绝对毫秒，除以量具 A 的帧时间就是泛光链的真实占比。）

## 判据：**主承载者是「结构上界」，不是两个量具的差值**

⚠️ 这一版是**被实测逼出来的**（第一次跑出来：A 的地板 1.20 ms / 12.9%，
B 的地板 0.05 ms / 42% —— **两个量具的地板都比效应大**，
`thin-all` 取样少了 52% 反而读成「更慢」）。所以：

1. **量具 A 只承担绝对线**：帧时间中位数 **< 16.7 ms**。**不拿它的差值做比较。**
2. **量具 B 先过灵敏度哨兵**：`huge-0`（取样 +900%）必须显著变慢。
   它不动 ⇒ **B 受取样次数以外的东西支配**（pass 开销 / 带宽）⇒ B 的差值分辨率不够，
   点估不可用于比较 —— **明说，不硬凑**。
3. **结构上界（硬，与量具灵敏度无关）**：
   丙 只改 mip2/mip3 的抽头数 = 模糊链取样量 **+9.7%**。
   与取样次数成正比的代价分量**最多**涨 9.7%；与取样无关的分量（pass 开销）**一点都不变**
   ⇒ **整条泛光链的涨幅 ≤ 9.7%**。于是

       Δ帧时间 ≤ 9.7% × 泛光链耗时

   实测泛光链 ≈ 0.12 ms / 帧 9.3 ms ⇒ **上界 ≈ 0.012 ms ≈ 一帧的 0.12%**。
   ⚠️ 这个上界**不依赖量具能否分辨**，只依赖「泛光链占一帧多少」这一个读数 ——
   而 0.12 ms（≈1.3%）本身就是合理量级（全屏后处理不该占一帧的大头）。
4. 判「过」的条件：**① 帧中位 < 16.7 ms** 且 **③ 结构上界 ≤ 5%**。
   上界超过 5% 才是否决。

**判「过」的条件（完整的，在下面「判据」一节里展开）**：
① `galaxy` 层帧时间中位数 **< 16.7 ms**（项目硬指标）；
② 结构上界 **≤ 5%**（丙 只动 mip2/mip3 ⇒ 泛光链涨幅 ≤ 9.7% ⇒ 对帧时间的影响有硬上界）。
⚠️ **不用两个量具的差值直接判「便宜」** —— 实测它们的地板都比效应大，
拿差值当结论就是编数（这一版的判据是被实测逼出来的，见下）。

## 手段自证（不是「测了就算」）

1. **覆盖真的进 GPU 了吗**：`sens-*` 式的画面哨兵在性能探针里没用（画面变化 ≠ 抽头数变了）。
   这里改成**程序计数**：`defines.KERNEL_RADIUS` 改了 + `needsUpdate` ⇒ three 要**重编译**，
   `renderer.info.programs.length` 应当**增长**。不增长 ⇒ 警告（不是静默）。
   （实测：15 → 16 → 18 → 20 → 22，**确实增长**。）
2. **回读断言**：每次覆盖后回读 `defines.KERNEL_RADIUS` 与 `coefficients.length`，与意图逐项相等。
3. **设计自证**：Python 侧算出每个档的 σ_eff 与 K，断言
   **丙 与 ctrl 的 σ 逐级相等而 K 不等** —— 「宽度保持、只动抽头数」这句话本身要被验。
4. **灵敏度哨兵 `huge-0`**：取样 +900% 的那一档必须把量具 B 顶起来。
   **顶不动 ⇒ 明说「B 分辨不出取样次数」**，不许把「测不出来」讲成「不花钱」。
5. **离线自证**：`tools/_perf-math-check.py`（不开浏览器，2 秒）
   会用**假的页面响应**驱动**和这里完全相同**的整理路径 —— 把「dict / list 传错」
   挡在开浏览器之前（那种错在浏览器路径里会被驱动拆解吞掉，见 `_LoudSession`）。

用法：
    py -3.13 -X utf8 **-u** tools/probe-bloom-kernel-perf.py              # 有头（要真 GPU）
    py -3.13 -X utf8 -u tools/probe-bloom-kernel-perf.py --headed=false
    py -3.13 -X utf8 -u tools/probe-bloom-kernel-perf.py --levels=galaxy

⚠️ **一定加 `-u`**：`> shots/x.log` 时 stdout 是块缓冲，而这个脚本的进度行全是 `print`。
   不加 `-u` 的后果是**日志停在半行不动、进程却好好地在跑 —— 看着像挂住**（实测踩过）。
   （脚本内已把 `print` 换成强制 flush 的包装，`-u` 是第二道。）

⚠️ **有头模式请让那个浏览器窗口保持在前台、别最小化**：被遮挡时 Chromium 会**挂起 rAF**，
   而 `gotoScale()` 的收尾靠 rAF ⇒ `page.evaluate` 会**永久挂住**（无声无息）。
   脚本已用 `page.bring_to_front()` + 页面内 `Promise.race` 超时两道保险，
   但把窗口留在前台最省事。

产出：只有结论落盘（无截图）；日志由外层重定向到 `shots/_bloom-kernel-perf.log`
退出码：0 = 全部档位跑完；1 = 页面没起来 / 拿不到句柄 / 哨兵失败。
"""
import asyncio
import builtins
import math
import os
import sys
import threading
import time
import traceback

from playwright.async_api import async_playwright
from browser_args import OCCLUSION_ARGS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')


def print(*a, **k):          # noqa: A001 —— 有意遮蔽内建
    """**强制 flush** 的 print。

    为什么必须 —— `python ... > shots/x.log` 时 stdout 是**块缓冲**，
    而本脚本的进度行全是 `print`、只有 `emit()`（`serve_for_checks` 里那个）会 flush。
    后果：**日志停在某一行的中间不动，进程却好好地在跑 —— 看起来像挂住了。**
    这跟坑 125 是同一类病（「看着成功/看着卡死」都不是真状态），所以在这里一刀切掉：
    模块内所有 `print` 都走这个包装，逐行落盘。
    （用 `line_buffering=True` 重建 stdout 在这台机器上**没能生效**，实测过：
     日志 1799 字节、6 秒不涨，进程仍在。）
    """
    k['flush'] = True
    return builtins.print(*a, **k)


for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(line_buffering=True)     # 能生效更好；不生效也有上面的 wrapper 兜着
    except Exception:
        pass


def arm_hard_exit(seconds, code=0):
    """看门狗：到点无条件 os._exit。

    为什么需要它 —— 这个项目的浏览器关闭**总是超时**（`TimeoutError`），
    只有看门狗能兜住收尾。**先落盘、再看门狗**，顺序不能反。
    """
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t


HEADED = True          # 帧时间必须配真 GPU 才有意义（软件渲染 198 ms vs 真 GPU 7.9 ms，差 25 倍）
PIN_TIER = 'high'      # 钉住画质档：档位决定 pixelRatio 与泛光开关 ⇒ 不钉就没法 A/B
FRAME_N = 80           # 每次 rAF 取样多少帧（实测噪声地板在 40 帧下就有 13% ⇒ 得加量）
FRAME_BUDGET_MS = 25000    # 量具 A 的**硬预算**：超了就让页面自己报错，绝不允许静默挂住
SETTLE_BUDGET_MS = 15000   # settle 的预算，同理
REPS = 4               # 每个档重复几轮，取中位数（压一次性抖动）
BLOOM_N = 40           # 每次泛光隔离计时跑多少次
LEVELS = ['galaxy', 'solar']   # galaxy = 用户抱怨的那一层；solar = 轻场景锚点
TIMEOUT_S = 420        # 看门狗：整轮上限。**别设太大** —— 设 15 分钟那次，一次静默卡死就白烧 15 分钟
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--tier='):
        PIN_TIER = a.split('=', 1)[1]
    elif a.startswith('--levels='):
        LEVELS = [x for x in a.split('=', 1)[1].split(',') if x]
    elif a.startswith('--frames='):
        FRAME_N = int(a.split('=', 1)[1])
    elif a.startswith('--reps='):
        REPS = int(a.split('=', 1)[1])


# ---------------------------------------------------------------------------
# 页面内：画质档钉住 + 渲染状态回读
# ---------------------------------------------------------------------------
# ⚠️ 必须在**进 galaxy 之前**钉档：点数预算是在 `level.build()` 那一刻按
#    `engine.tier.pointBudget` 定死的，而 `applyTier()` 只改得动渲染设置
#    （泛光 / 像素比 / 色调映射），**改不动已经建好的几何**。
#    顺序反了不报错，只是几何留在自动探测的那一档 —— 差 2.67 倍的场景，报告里看不出来。
PIN_JS = r"""
(tier) => {
  const e = window.__universe.engine;
  if (e.gpu) e.gpu.tierPinned = true;
  if (tier && tier !== 'none' && e.applyTier) e.applyTier(tier);
  return {
    tier: e.tierId,
    pinned: !!(e.gpu && e.gpu.tierPinned),
    bloom: e.options && e.options.bloom,
    pixelRatio: e.renderer.getPixelRatio(),
    pointBudget: e.tier ? e.tier.pointBudget : null,
    levelBuilt: !!(e.current && e.current.scene),
    rendererSize: [e.renderer.domElement.width, e.renderer.domElement.height],
  };
}
"""

# ---------------------------------------------------------------------------
# 页面内：渲染后端（**帧时间的读数必须配上它**）
# ---------------------------------------------------------------------------
BACKEND_JS = r"""
() => {
  const r = window.__universe && window.__universe.engine && window.__universe.engine.renderer;
  if (!r) return { ok: false, renderer: '(拿不到 renderer)', software: null };
  const gl = r.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const unmasked = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  return {
    ok: true,
    renderer: unmasked || '(扩展不可用)',
    software: /swiftshader|llvmpipe|software|basic render/i.test(unmasked || ''),
  };
}
"""

# ---------------------------------------------------------------------------
# 页面内：读回活页面里的核 + 程序数（**读回来的，不是从源码抄的**）
# ---------------------------------------------------------------------------
READ_KERNELS_JS = r"""
() => {
  const e = window.__universe.engine;
  const p = e.bloomPass;
  if (!p || !p.separableBlurMaterials) return { err: 'no separableBlurMaterials' };
  const info = e.renderer.info || {};
  return {
    nMips: p.nMips,
    strength: p.strength, radius: p.radius, threshold: p.threshold,
    bloom: !!(e.options && e.options.bloom),
    programs: info.programs ? info.programs.length : null,
    calls: info.render ? info.render.calls : null,
    triangles: info.render ? info.render.triangles : null,
    levels: p.separableBlurMaterials.map((m, i) => ({
      i,
      K: (m.defines && m.defines['KERNEL_RADIUS']) || null,
      len: m.uniforms['gaussianCoefficients'].value.length,
      coeffs: Array.from(m.uniforms['gaussianCoefficients'].value),
      rtWH: [p.renderTargetsVertical[i].width, p.renderTargetsVertical[i].height],
    })),
  };
}
"""

# 只换系数值（长度必须逐级保持 —— shader 里 `uniform float gaussianCoefficients[KERNEL_RADIUS]`
# 的 KERNEL_RADIUS 是**编译期常量**，长度不符 = 越界读）。
SET_COEFFS_JS = r"""
([i, coeffs]) => {
  const p = window.__universe.engine.bloomPass;
  const m = p.separableBlurMaterials[i];
  const cur = m.uniforms['gaussianCoefficients'].value;
  if (coeffs.length !== cur.length) {
    return { err: '长度不符（只换值不许改长度）', want: cur.length, got: coeffs.length };
  }
  m.uniforms['gaussianCoefficients'].value = coeffs.slice();
  return { i, K: cur.length };
}
"""

# **连抽头数一起改**：defines 变了必须 needsUpdate 触发重编译，
# 而新程序的 uniform 数组长度就是 K ⇒ 必须**同时**给出等长系数。
SET_K_JS = r"""
([i, K, coeffs]) => {
  const p = window.__universe.engine.bloomPass;
  const m = p.separableBlurMaterials[i];
  if (coeffs.length !== K) return { err: '系数长度 != K', K, got: coeffs.length };
  const before = (m.defines && m.defines['KERNEL_RADIUS']) || null;
  m.defines['KERNEL_RADIUS'] = K;
  m.needsUpdate = true;
  m.uniforms['gaussianCoefficients'].value = coeffs.slice();
  return {
    i, before, K,
    def: m.defines['KERNEL_RADIUS'],
    len: m.uniforms['gaussianCoefficients'].value.length,
  };
}
"""

# ---------------------------------------------------------------------------
# 页面内：量具 A —— rAF 帧时间
# ---------------------------------------------------------------------------
# ⚠️ 报 `min` 不是装饰：**min ≈ 16.6 就说明被 vsync 封顶了**，这时中位数的差别列作废。
#
# ⚠️⚠️ **必须包一层 `Promise.race` 超时**（实测事故）：headed 模式下如果那个窗口
#   **被别的窗口遮住或最小化**，Chromium 会**挂起 rAF** ⇒ 这个 Promise 永远不 resolve
#   ⇒ 进程既不报错也不产出，只是安静地卡死（实测卡了 5 分钟，日志一个字节不涨）。
#   这不是被测对象的结论，是**量具失明**——所以要**大声说出来**。
#   （另一半解药是 `page.bring_to_front()`，见 `run()`。）
FRAME_JS = r"""
([n, budgetMs]) => Promise.race([
  new Promise(res => {
    const times = [];
    let last = performance.now();
    let i = 0;
    const tick = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (++i < n) requestAnimationFrame(tick);
      else {
        const s = times.slice(3).sort((a, b) => a - b);
        res({
          n: s.length,
          min: +s[0].toFixed(2),
          median: +s[Math.floor(s.length / 2)].toFixed(2),
          p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
          max: +s[s.length - 1].toFixed(2),
        });
      }
    };
    requestAnimationFrame(tick);
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error(
    'rAF 在 ' + budgetMs + ' ms 内没跑完 ' + n + ' 帧 —— 窗口被遮挡/最小化时浏览器会挂起 rAF')),
    budgetMs)),
])
"""

# ---------------------------------------------------------------------------
# 页面内：量具 B —— 隔离计时泛光通道
# ---------------------------------------------------------------------------
# 为什么能隔离：
#   · `bloomPass.render(renderer, writeBuffer, readBuffer)` 读 `readBuffer`（RenderPass 写的那个）；
#   · 整个 `page.evaluate` 是**同步**的 ⇒ rAF 回调插不进来，测量期间不会被主循环污染；
#   · `gl.finish()` 是**必须的** —— 不加它量到的只是「命令提交耗时」，
#     不是 GPU 真的干完活的耗时（WebGL 是异步队列，这是最经典的假读）。
# ⚠️ 直接调它会在 readBuffer 里留下合成结果 —— 无害，下一帧 composer 会重画。
#    所以顺序是：**先量 A（rAF），再量 B**，别让 B 的残渣进 A。
BLOOM_TIME_JS = r"""
([N, reps]) => {
  const e = window.__universe.engine;
  const p = e.bloomPass, r = e.renderer, c = e.composer, rp = e.renderPass;
  if (!p || !r || !c) return { ok: false, why: '拿不到 bloomPass / renderer / composer' };
  if (!rp || !rp.scene || !rp.camera) {
    return { ok: false, why: 'engine.renderPass.scene/camera 还没被主循环赋值（先让它跑一帧）' };
  }
  if (p.enabled === false) return { ok: false, why: 'bloomPass.enabled=false —— 这一档泛光关掉了' };
  const gl = r.getContext();
  try {
    rp.render(r, c.writeBuffer, c.readBuffer);   // 场景写进 readBuffer（bloom 的输入）
  } catch (err) {
    return { ok: false, why: 'RenderPass 调用失败：' + err.message };
  }
  const out = [];
  for (let rep = 0; rep < reps; rep++) {
    for (let k = 0; k < 3; k++) p.render(r, c.writeBuffer, c.readBuffer);
    gl.finish();
    const t0 = performance.now();
    for (let k = 0; k < N; k++) p.render(r, c.writeBuffer, c.readBuffer);
    gl.finish();
    out.push((performance.now() - t0) / N);
  }
  out.sort((a, b) => a - b);
  return {
    ok: true, N, reps,
    perCall: out.map(x => +x.toFixed(4)),
    median: +out[Math.floor(out.length / 2)].toFixed(4),
    min: +out[0].toFixed(4), max: +out[out.length - 1].toFixed(4),
  };
}
"""

SETTLE_JS = r"""
([frames, minMs, budgetMs]) => Promise.race([
  new Promise(res => {
    let i = 0;
    const t0 = performance.now();
    const tick = () => {
      if (++i >= frames && performance.now() - t0 >= minMs) res(i);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }),
  new Promise((_, rej) => setTimeout(
    () => rej(new Error('settle 在 ' + budgetMs + ' ms 内没等到 rAF')), budgetMs)),
])
"""


# ---------------------------------------------------------------------------
# Python 侧：核数学（与 `probe-bloom-kernel.py` 同口径，别再定第二套）
# ---------------------------------------------------------------------------
def sigma_eff(coeffs):
    """核的二阶矩等效 σ：sqrt( Σ w_i x_i² / Σ w_i )（x = 抽头序号 = texel 距离）。"""
    s0 = coeffs[0] + 2.0 * sum(coeffs[1:])
    s2 = 2.0 * sum((i * i) * coeffs[i] for i in range(1, len(coeffs)))
    return math.sqrt(s2 / s0)


def gauss(K, sigma):
    """出厂同样的构造式，但 σ 独立给 —— 这就是「把 σ 与 K 解耦」。"""
    return [math.exp(-0.5 * (i * i) / (sigma * sigma)) for i in range(K)]


def box(K):
    return [1.0] * K


# ⚠️⚠️ 2026-09-12 起，活页面里的核**不再是出厂核**：生产环境默认套用了「丙」
#   （σ 与 K 解耦，`web/js/core/bloom-kernel.js`，mip2 7→12、mip3 9→15）。
#   ⇒ 这个探针的**标尺必须钉在出厂**，否则 `ctrl` 会静默变成丙：
#     · `ctrl`（历史基线 6.90 ms / 取样 5,056,074）会对不上；
#     · `box-23` 会变成「在 K=12/15 上盖方框」，不再等价于「出厂核本就近方框」；
#     · 而 `wide-23` 会与 `ctrl` 逐位相同 ⇒ 一档白测。
#   「标尺自己得说清自己量的是什么」——所以 `prepare()` 一律按出厂口径整理，
#   现场打印的 K 表会明写「出厂 K / 活页面 K」两列。
FACTORY_K = [3, 5, 7, 9, 11]


def factory(K):
    """出厂构造式：σ 就取 K（`UnrealBloomPass.js:376-382` 逐字复刻）"""
    return [0.39894 * math.exp(-0.5 * (i * i) / (K * K)) / K for i in range(K)]


def factory_levels(n=None):
    """出厂口径的「levels」列表，形状与 `READ_KERNELS_JS` 的 `levels` 兼容。

    给 `design_selfproof()` / `plan_for()` 用 —— 它们**必须**在出厂口径上判，
    否则「丙 的 K 必须比 ctrl 大」这条断言会拿丙自己去比丙。
    """
    Ks = list(FACTORY_K if n is None else FACTORY_K[:n])
    return [{'i': i, 'len': K, 'coeffs': factory(K), 'rtWH': (0, 0)} for i, K in enumerate(Ks)]


def k_for(sigma, depth):
    """抽头数取到 `depth·σ` 截断：K = ⌈depth·σ⌉ + 1。"""
    return int(math.ceil(depth * sigma)) + 1


def fetch_proxy(k_list, rt_list):
    """每次泛光渲染、模糊链的纹理取样次数（**代理量，不是时间**）。

    每次 pass 抽 `2K−1` 次（i=0 抽 1 次、i≥1 每轮 2 次），每级 X/Y 两趟。
    这是**上界代理**：RT 很小、片元着色开销不为零 ⇒ 比值只能当量级指示，
    真正算不算数由量具 B 的实测说话。
    """
    tot = 0
    for K, (w, h) in zip(k_list, rt_list):
        tot += 2 * (2 * K - 1) * w * h
    return tot


def prepare(stock_resp):
    """把页面响应整理成测量要用的一切。**这里是「dict / list 传错」的唯一关口。**

    ⚠️ 为什么单独抽成函数（实测事故的固化）——
    `run()` 里曾经把**整个页面 dict** 直接喂给 `plan_for()`，而 `plan_for` 里是
    `for lv in stock` ⇒ 遍历到的是**键名字符串** ⇒ `lv['coeffs']` 抛 `TypeError`。
    那个异常又被 `async_playwright().__aexit__` 的驱动拆解**吞掉**（本机拆解会挂）
    ⇒ 表现是「无声卡死五分钟、日志一字节不涨」。
    抽成函数之后，**离线自证可以用假的页面响应驱动同一条路径**，
    不必等到开浏览器（那时异常会被吞）。这就是「判据要在便宜的地方就能响」。
    """
    if not isinstance(stock_resp, dict) or not isinstance(stock_resp.get('levels'), list):
        raise TypeError('prepare 要的是页面 READ_KERNELS_JS 的原始响应（dict 且含 levels 列表）')
    levels = stock_resp['levels']
    # ★ 标尺 = **出厂核**，不是活页面现状（见 FACTORY_K 上面那段）。
    #   活页面 K 另存成 `liveK`，只用于打印与「整定生效了吗」的判定。
    k0 = list(FACTORY_K[:len(levels)])
    rt = [lv['rtWH'] for lv in levels]
    return {
        'levels': levels,
        'k0': k0,
        'liveK': [lv['len'] for lv in levels],
        'rt': rt,
        'sig': [sigma_eff(factory(K)) for K in k0],
        'fetch': fetch_proxy(k0, rt),
    }


# 档位定义：(tag, 说明, 动哪几级)
CONFIGS = [
    ('ctrl',     '出厂核（原样）',                                  'none'),
    ('ctrl-b',   '同状态跑第二遍 —— **噪声地板**',                  'none'),
    ('box-23',   'mip2/3 系数→纯方框（**K 不变**）',                'box23'),
    ('thin-all', '五级 K→2（σ 保持）—— **负向对照**',               'thin-all'),
    ('wide-23',  '**丙**：mip2/3 → K=⌈3σ⌉+1（σ 保持）',             'wide23'),
    ('huge-0',   '只第0级 → K=41 —— **量具 B 的灵敏度哨兵**（取样 +900%）', 'huge0'),
    ('wide-all', '五级全部 → K=⌈3σ⌉+1 —— **强正向对照**',           'wide-all'),
    # ★ **顺序漂移哨兵**：与 ctrl 完全相同，只是排在最后一个。
    #   为什么必须有（实测）：第一次全量跑出来，每层**最后一个**档位（wide-all）
    #   帧时间 +4.10 ms / +58.6%，而泛光时间纹丝不动 —— 泛光链整体才 0.06 ms，
    #   **+4.10 ms 是它全部成本的 68 倍，物理上不可能**。它同时是耗时最长（4.0s vs 2.7s）
    #   的那一档。⇒ 那是**跑到最后变慢**，不是那个档位的代价。
    #   没有这个哨兵，我就会把漂移当成 wide-all 的代价报出去。
    ('ctrl-z',   '**与 ctrl 完全相同**，只是排在最后 —— **顺序漂移哨兵**', 'none'),
]


def plan_for(kind, stock):
    """把档位算成「逐级要写什么」——**先在本地算清、再下发给页面**。

    返回 `(k_list, coeffs_list, note)`；`k_list` 是意图抽头数，`coeffs_list[i] is None` = 不动该级。
    """
    # ★ 硬断言：**「错传整个 dict」这件事必须大声说**。传 dict 时 `for lv in stock`
    #   遍历的是**键名字符串**，`lv['coeffs']` 抛 TypeError —— 而那个异常在本机
    #   会被驱动拆解吞掉（见 `_LoudSession` 的 docstring），表现成「无声卡死」。
    #   别依赖那条路径，在这里直接把话说清楚。
    if not isinstance(stock, (list, tuple)):
        raise TypeError(
            'plan_for 要的是 stock["levels"]（列表），不是页面返回的整个 dict'
            '（传错会退化成遍历键名，症状是一个被吞掉的 TypeError）')
    # ★ 标尺一律取**出厂核**（见 FACTORY_K 上面那段），不取传进来的 K。
    #   传进来的 `stock` 现在可能是「丙」（K=12/15），照它算的话：
    #   `wide-23` 会算出 K=12 而「不变」，`thin-all` 的 K→2 也不是同一个对照。
    n = len(stock)
    if n != len(FACTORY_K):
        raise ValueError(
            f'活页面泛光级数是 {n}，本探针的标尺绑在出厂 {len(FACTORY_K)} 级（{FACTORY_K}）上。'
            '级数变了必须重新做一次独热隔离，不能照抄这套档位。')
    k0 = list(FACTORY_K)
    sig = [sigma_eff(factory(K)) for K in k0]
    coefs = [None] * n
    note = ''

    if kind == 'none':
        # 「不动」在这里**不是「什么都不写」**：活页面现状是「丙」，
        # 不显式写回出厂核的话 ctrl 就不是 ctrl（锚点会静默失效）。
        return k0, [factory(K) for K in k0], '写回出厂核'

    if kind == 'box23':
        for i in (2, 3):
            coefs[i] = box(k0[i])
        return k0, coefs, '只换系数值'

    if kind == 'thin-all':
        ks = [2] * len(stock)
        for i in range(len(stock)):
            coefs[i] = gauss(ks[i], sig[i])
        return ks, coefs, '五级 K→2'

    if kind == 'wide23':
        ks = list(k0)
        for i in (2, 3):
            ks[i] = k_for(sig[i], 3.0)
            coefs[i] = gauss(ks[i], sig[i])
        note = f'第2级 K {k0[2]}→{ks[2]}、第3级 K {k0[3]}→{ks[3]}'
        return ks, coefs, note

    if kind == 'huge0':
        # 灵敏度哨兵：只把第0级抽头拉到 41（取样量 +900% 量级）。
        # 量具 B 若能看见「取样次数」，这一档**必须**明显变慢；看不见 ⇒ B 的分辨率作废。
        ks = list(k0)
        ks[0] = 41
        coefs[0] = gauss(41, sig[0])
        return ks, coefs, f'第0级 K {k0[0]}→41（σ 保持）'

    if kind == 'wide-all':
        ks = [k_for(sig[i], 3.0) for i in range(len(stock))]
        for i in range(len(stock)):
            coefs[i] = gauss(ks[i], sig[i])
        note = '五级 K → ' + '/'.join(map(str, ks))
        return ks, coefs, note

    raise ValueError(kind)


SIG_TOL = 0.02         # σ 的「保持不变」按**相对**容差判：2%


def design_selfproof(stock):
    """设计自证：**「宽度保持、只动抽头数」这句话本身要被验**（坑 121 的口径）。

    · 丙 与 ctrl 的 σ_eff 必须**基本**相等（否则就不是「只动抽头数」）；
    · 丙 的 K 必须**真的更大**（否则这一档什么也没测）；
    · thin-all 的 K 必须**真的更小**（否则负向对照是哑的）。

    ⚠️ **为什么容差是 2% 而不是 1e-9**（离线自证 `tools/_perf-math-check.py` 抓出来的）：
    `sigma_eff` 算的是**离散截断集**上的二阶矩。丙 的核取 `gauss(K, σ_eff(出厂))`，
    而 `K = ⌈3σ⌉+1` ⇒ 截断落在 **3.0–3.2σ** ⇒ **尾部被切掉一小截**，
    那截尾巴恰恰带着最大的 x² 权 ⇒ **σ_eff 系统性偏低 0.6–0.9%**：

        第2级 σ 3.5342 → 3.5117（相对差 0.64%）· 第3级 4.6157 → 4.5744（0.90%）

    这个数**不是巧合**：上一轮量到的 丙 外接框 **314×312** 比 ctrl **316×316** 小 **0.6%**
    —— 两个独立读数（二阶矩 / 外接框）指向同一个低 0.6–0.9%。**互证成立。**
    2% 的容差仍足以判别「保持」（≈1%）与「磨陡」（gD75 差 25%、gD50 差 50%），
    差 25 倍。⚠️ 若要 σ_eff **严格**相等，得反解 σ_param —— 那会改掉上一轮形状已验的那个核，
    属**另一次决定**，这一轮不做。
    """
    if not isinstance(stock, (list, tuple)):
        raise TypeError('design_selfproof 要的是 stock["levels"]（列表），不是整个 dict')
    sig = [sigma_eff(lv['coeffs']) for lv in stock]
    k0 = [lv['len'] for lv in stock]
    ok = True

    _, c23, _ = plan_for('wide23', stock)
    for i in (2, 3):
        s_new = sigma_eff(c23[i])
        rel = abs(s_new - sig[i]) / sig[i]
        kn = len(c23[i])
        good = rel < SIG_TOL and kn > k0[i]
        ok &= good
        emit(f'  · 丙 第{i}级：σ {sig[i]:.4f} → {s_new:.4f}'
             f'（相对差 {rel * 100:.4f}% < {SIG_TOL * 100:.1f}% = {rel < SIG_TOL}）'
             f' · K {k0[i]} → {kn}（更大={kn > k0[i]}）'
             f' · 截断 {(kn - 1) / sig[i]:.2f}σ（≥3σ，由 ⌈3σ⌉+1 保证）')
    _, cbox, _ = plan_for('box23', stock)
    for i in (2, 3):
        same = len(cbox[i]) == k0[i] and cbox[i][0] == cbox[i][-1]
        ok &= same
        emit(f'  · box-23 第{i}级：K 保持 {k0[i]}（{len(cbox[i]) == k0[i]}）'
             f' · 平顶（最外/中心={cbox[i][-1] / cbox[i][0]:.2f}）')
    kt, ct, _ = plan_for('thin-all', stock)
    cnt = sum(1 for i in range(len(stock)) if kt[i] < k0[i])
    ok &= cnt >= 3
    emit(f'  · thin-all：{cnt}/{len(stock)} 级 K 真的变小（要求 ≥3）')
    return ok


async def settle(page, frames=3, min_ms=400, budget_ms=None):
    """等若干帧。

    ⚠️ **每次都先把窗口提到前台**：headed 模式下窗口被别的窗口遮住 / 最小化时，
    Chromium 会**挂起 rAF**，而 `gotoScale()` 的收尾（`_finishTransition()`）是靠 rAF 推进的
    ⇒ `page.evaluate("gotoScale(...)")` 那个 Promise **永远不 resolve** ⇒
    进程既不报错也不产出，只是安静地卡死（实测卡满 5 分钟、日志一个字节不涨）。
    `bring_to_front()` 把窗口拉回前台，rAF 恢复；`budget_ms` 是第二道保险：
    即便还是不来，页面会**自己抛错**，卡死变成一条能读的消息。
    """
    await page.bring_to_front()
    await page.evaluate(SETTLE_JS, [frames, min_ms, budget_ms or SETTLE_BUDGET_MS])


def fmt_ms(v):
    return '—' if v is None else f'{v:.2f}'


class _LoudSession:
    """把 `async_playwright()` 包一层：**任何异常都先就地打印出来，再交给它去拆。**

    为什么必须（实测事故）——
    `async with async_playwright() as pw:` 里的异常，**会先送到 `__aexit__` 去拆驱动**，
    而这台机器上**关浏览器本来就永远超时**（`TimeoutError`，文档里早有记录）⇒
    拆解**挂住** ⇒ **traceback 永远打不出来、进程也不退出**。
    现象是一个**立刻就能定位的 `TypeError`** 伪装成「无声卡死五分钟、日志一字节不涨」。

    这与本项目反复踩的那条同源：**「看着卡死 / 看着成功」都不是真状态，
    而收尾路径本身就是最会吃掉异常的地方**（坑 125 也是这个形状）。
    所以：**先把异常喊出来，再让它去拆；拆挂住了也有看门狗兜 20 秒。**
    """

    def __init__(self, cm):
        self._cm = cm

    async def __aenter__(self):
        return await self._cm.__aenter__()

    async def __aexit__(self, et, ev, tb):
        if et is not None:
            print('\n' + '!' * 104)
            print('  ✗✗ **真正的异常在这里**（不是「卡住」——异常被驱动拆解吞掉了）：')
            traceback.print_exception(et, ev, tb, file=sys.stdout)
            print('  ⇒ 驱动拆解可能挂住（本机「关浏览器总超时」是已知问题），'
                  '20 秒后由看门狗收尾。')
            print('!' * 104)
            sys.stdout.flush()
            arm_hard_exit(20, 1)
        return await self._cm.__aexit__(et, ev, tb)


async def run(base, srv):
    """⚠️ `srv` 是**参数传进来**的，不是去读 `main()` 的局部变量。

    `probe-bloom-kernel.py` 一族的收尾就是在这里栽的（坑 125）：
    `run()` 里写 `srv.stop()`、而 `srv` 是 `main()` 的局部 ⇒ `NameError`
    ⇒ 它之后的「停服务 / 武装看门狗 / 关浏览器」**一步都不执行**
    ⇒ 每跑一次漏一个浏览器进程，而日志看着像成功。**新脚本不要抄那个形状。**
    """
    console_errors = []

    # ⚠️ 用 `_LoudSession` 而不是裸的 `async_playwright()` —— 理由见那个类的 docstring：
    #    异常会先进驱动拆解，而拆解在本机会挂住 ⇒ traceback 永远见不到光。
    async with _LoudSession(async_playwright()) as pw:
        # 后端必须记下来：同一份画面、同样 headless，软件渲染 198.3 ms，
        # 真 GPU 7.9 ms —— 差 25 倍，而两个数都「是量出来的」。
        backend = 'msedge'
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=OCCLUSION_ARGS)
        except Exception as e:
            backend = f'bundled-chromium（msedge 起不来：{type(e).__name__}）'
            browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)

        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('console', lambda m: m.type == 'error' and console_errors.append(m.text[:200]))
        # ⚠️ 把窗口提到前台：headed 且被遮挡 ⇒ Chromium 挂起 rAF ⇒
        #    `gotoScale()` 的收尾（靠 rAF）永远不完成 ⇒ `page.evaluate` 永久挂住。
        #    实测过：整轮卡 5 分钟、日志一字节不涨、无异常无输出。
        await page.bring_to_front()

        emit(f'\n打开 {base}/ …（浏览器={backend} 有头={HEADED}）')
        await page.goto(base + '/', wait_until='load')
        try:
            await page.wait_for_function(
                'window.__universe && window.__universe.engine && window.__universe.dataset',
                timeout=45000)
        except Exception:
            emit('  ✗ 45 秒内没等到 window.__universe.dataset —— 页面没起来')
            return 1
        await page.wait_for_timeout(2500)

        # ---- 先钉档，再进场景（顺序不能反，反了不报错）------------------
        st = await page.evaluate(PIN_JS, PIN_TIER)
        emit(f'  画质档已钉住（进场景之前）：{st}')

        gp = await page.evaluate(BACKEND_JS)
        emit(f'  渲染后端：{backend} · WebGL={gp.get("renderer")} · 软件渲染={gp.get("software")}')

        stock = await page.evaluate(READ_KERNELS_JS)
        if stock.get('err'):
            emit(f'  ✗ {stock["err"]}')
            return 1
        emit(f'  泛光实况 nMips={stock["nMips"]} strength={stock["strength"]} '
             f'radius={stock["radius"]} threshold={stock["threshold"]} '
             f'bloom={stock["bloom"]} programs={stock["programs"]}')

        # ★ 一切「页面响应 → 测量参数」的整理都走 `prepare()` 这一个关口。
        #   曾经的错法：把**整个 dict** 直接喂给 `plan_for()` ⇒ `for lv in stock` 遍历到
        #   **键名字符串** ⇒ `lv['coeffs']` 抛 `TypeError` ⇒ 异常又被驱动拆解吞掉
        #   ⇒ **一个立刻能定位的错伪装成「无声卡死五分钟」**。
        #   `_perf-math-check.py` 会用**假的页面响应**驱动同一条路径，把这类错挡在开浏览器之前。
        P = prepare(stock)
        levels = P['levels']
        rt = P['rt']
        k_stock = P['k0']
        base_fetch = P['fetch']

        print('\n' + '=' * 104)
        print('  ★ 生产现状（活页面读回来的 —— 用户实际看到的就是这个）')
        print('-' * 104)
        print(f'  {"级":<4}{"活页面 K":<10}{"出厂 K":<8}{"σ_eff(活)":<11}'
              f'{"σ_eff(出厂)":<12}{"σ 相对差":<11}{"截断":<9}判定')
        prod_ok = True
        for lv in levels:
            i, K, c = lv['i'], lv['len'], lv['coeffs']
            se = sigma_eff(c)
            Kf = FACTORY_K[i] if i < len(FACTORY_K) else None
            sef = sigma_eff(factory(Kf)) if Kf else float('nan')
            d = abs(se - sef) / sef if Kf else float('nan')
            # 分母用**源 σ（= 出厂 σ_eff）**：判据是「K−1 ≥ 3·σ」里的那个 σ，
            # 拿 σ_eff(活) 当分母会系统性高估 0.6–0.9%（同一个量只许一处口径）。
            trunc = (K - 1) / sef if sef else float('nan')
            touched = Kf is not None and K != Kf
            verdict = '—（出厂）'
            if touched:
                good = d <= SIG_TOL and trunc >= 3.0 - 1e-9
                prod_ok = prod_ok and good
                verdict = '✓ 丙（保 σ + 加抽头）' if good else '✗ 越线'
            print(f'  {i:<4}{K:<10}{Kf if Kf else "—":<8}{se:<11.4f}{sef:<12.4f}'
                  f'{d:<11.5f}{trunc:<9.3f}{verdict}')
        if prod_ok:
            print('  ⇒ 生产环境确实在做「保 σ、加抽头数」⇒ 下面的宽档 `wide-23` 就是**上线配置**。')
        else:
            print('  ⚠ 活页面 K 与出厂一致（或越线）⇒ `retuneBloomKernel()` 可能没被调用。')
            print('    先查 `engine.js._createComposer()` 的接线，**别去改核**。')
        print('  ⚠️ 本探针的标尺**一律钉在出厂**（见 FACTORY_K 上面那段）——'
              '下面每一档（含 ctrl）都是相对出厂核解释的。')
        print('=' * 104)

        print('\n' + '=' * 104)
        print('  活页面读回来的核（**读回来的，不是从源码抄的**）')
        print('-' * 104)
        print('  级  K   RT 尺寸      出厂核 σ_eff   截断深度   最外抽/中心')
        for lv in levels:
            i, K = lv['i'], lv['len']
            c = factory(FACTORY_K[i]) if i < len(FACTORY_K) else lv['coeffs']
            print(f'  {i}   {FACTORY_K[i] if i < len(FACTORY_K) else K:<3}'
                  f' {lv["rtWH"][0]:>4}x{lv["rtWH"][1]:<4}   '
                  f'{sigma_eff(c):>8.3f}   {(FACTORY_K[i] - 1) / sigma_eff(c):>7.2f}σ   '
                  f'{c[-1] / c[0]:>9.3f}')
        print(f'  ⇒ 模糊链纹理取样（代理量）= {base_fetch:,} 次/每次泛光渲染（**按出厂 K 算的**）')

        print('-' * 104)
        print('  **先写死的预测**（相对 ctrl；把「泛光链占一帧约 25%」当假设，假设本身也被这次检验）')
        print('    抽头数：每次 pass 抽 2K−1 次 × 每级 X/Y 两趟')
        print(f'    {"档":<9} {"取样代理":>12} {"占比":>8}   {"预测帧时间":>10}   动什么')
        for tag, _desc, kind in CONFIGS:
            ks, _cs, note = plan_for(kind, levels)
            f = fetch_proxy(ks, rt)
            d = (f - base_fetch) / base_fetch * 100
            print(f'    {tag:<9} {f:>12,} {d:>+7.1f}%   {0.25 * d:>+9.1f}%   {note}')

        print('-' * 104)
        print('  **验收线**：① galaxy 层帧时间中位数 **< 16.7 ms**（量具 A，只承担这一条）；')
        print('            ② 结构上界 **≤ 5%**（丙 只动 mip2/mip3 ⇒ 泛光链涨幅 ≤ 9.7% ⇒ 帧影响有硬上界）；')
        print('            ③ 灵敏度哨兵：huge-0（取样 +900%）必须把量具 B **顶起来**；')
        print('               顶不动 ⇒ 明说「B 分辨不出取样次数」，**不把「测不出来」讲成「不花钱」**。')
        print('            ⚠️ 两个量具的地板实测都比效应大（A 1.2 ms / 12.9%、B 0.05 ms / 42%）')
        print('               ⇒ **不用它们的差值直接判「便宜」**，那等于编数。')
        print('-' * 104)
        print('  [设计自证] 「σ 保持、只动抽头数」这句话本身要被验：')
        # ⚠️ 必须喂**出厂口径**的 levels：活页面现状是丙，拿它去判
        #    「丙 的 K 比 ctrl 大」等于拿丙比丙，断言会必红（而那不是代码坏了）。
        sp_ok = design_selfproof(factory_levels(len(levels)))
        print(f'  [设计自证] {"✓ 全部成立" if sp_ok else "✗ 有断言不成立 —— 下面的读数不可用"}')
        print('=' * 104)

        results = {}
        prog_seen = {stock['programs']}
        for lv in LEVELS:
            print(f'\n  → 切到 {lv} …')
            await page.bring_to_front()
            await page.evaluate(f"window.__universe.gotoScale('{lv}')")
            try:
                await page.wait_for_function(
                    f"window.__universe.engine.current?.id === '{lv}'", timeout=45000)
            except Exception:
                emit(f'  ⚠ 切到 {lv} 超时，跳过这一层')
                continue
            await page.wait_for_timeout(1500)

            st2 = await page.evaluate(PIN_JS, 'none')
            if st2.get('levelBuilt') and st2.get('pointBudget') != st.get('pointBudget'):
                emit(f'  ⚠ 建完场景后 pointBudget 变了：{st.get("pointBudget")} → '
                     f'{st2.get("pointBudget")} ⇒ 自动降档在建场景之后动过手，这一层读数要打折')

            print('\n' + '=' * 104)
            print(f'  层 = {lv}   档位 = {st2.get("tier")} · pixelRatio={st2.get("pixelRatio")} '
                  f'· 缓冲 {st2.get("rendererSize")} · 泛光={st2.get("bloom")}')
            print('-' * 104)
            print(f'  {"档":<9} {"帧中位":>8} {"p95":>8} {"min":>8} | '
                  f'{"泛光ms":>9} {"泛光%":>7} | {"抽头代理":>12} {"程序":>5} 说明')
            draws = set()
            # ★★ 写路径的判据必须看**当前页面状态**，不能看开局那张快照。
            #    这个 bug 是本探针自己的，由「丙 落地」那一轮把它暴露出来：
            #      `levels` 是**开局**读的（K=12/15），而 `thin-all` 会把五级 K 全改成 2；
            #      再轮到 `wide-23` 时拿开局快照去比（12 == 12）⇒ 走「只换值」路径，
            #      而此时页面里的数组长度其实是 2 ⇒
            #      `长度不符（只换值不许改长度）` ⇒ **整轮中止**。
            #    以前没暴露是因为 `none` 档「什么都不写」，正好绕开了那条路径。
            #    ⇒ **凡是「A 之后轮到 B」的编排，判据都必须重新读一次，不许复用快照**
            #      （同族：坑 119 的「回读慢一帧」）。
            curK = [v['len'] for v in (await page.evaluate(READ_KERNELS_JS))['levels']]
            for tag, desc, kind in CONFIGS:
                ks, coeffs, note = plan_for(kind, levels)

                # ---- 下发覆盖 -------------------------------------------------
                # ⚠️ 判据是「这一档有没有要写的东西」，**不是「kind 是不是 none」**：
                #    `none` 现在也要显式写回出厂核（活页面现状是丙），
                #    照旧写法跳过的话，ctrl / ctrl-b / ctrl-z 三档会直接跑在丙上。
                applied = '不动'
                if any(c is not None for c in coeffs):
                    applied = []
                    for i, cs in enumerate(coeffs):
                        if cs is None:
                            continue
                        if ks[i] != curK[i]:
                            r = await page.evaluate(SET_K_JS, [i, ks[i], cs])
                        else:
                            r = await page.evaluate(SET_COEFFS_JS, [i, cs])
                        if r.get('err'):
                            emit(f'    ✗ {tag} 第{i}级覆盖失败：{r}'
                                 f'（当前页面 K={curK[i]}，意图 K={ks[i]}）')
                            return 1
                        applied.append(f'{i}:K={r.get("def", r.get("K"))}')
                    applied = ' '.join(applied)

                # ---- 回读断言：意图 == 现实 ------------------------------------
                chk = await page.evaluate(READ_KERNELS_JS)
                # 顺手把「当前页面 K」刷新掉 —— 下一档的写路径靠它（见上面那段说明）
                curK = [v['len'] for v in chk['levels']]
                bad = []
                for i, cs in enumerate(coeffs):
                    if cs is None:
                        continue
                    got_k = chk['levels'][i]['len']
                    got_def = chk['levels'][i]['K']
                    if got_k != ks[i] or got_def != ks[i]:
                        bad.append(f'第{i}级 意图 K={ks[i]} 实到 len={got_k} def={got_def}')
                if bad:
                    emit(f'    ✗✗ {tag} **回读断言失败**：{bad}')
                    emit('        ⇒ 这一档什么也没测到，中止（不是被测对象的结论）。')
                    return 1
                if chk['programs'] not in prog_seen:
                    prog_seen.add(chk['programs'])

                # ---- 量具 A：rAF 帧时间（**先 A 后 B**）------------------------
                t0 = time.monotonic()
                try:
                    await settle(page)
                    fr_s = [await page.evaluate(FRAME_JS, [FRAME_N, FRAME_BUDGET_MS])
                            for _ in range(REPS)]
                    med = sorted(x['median'] for x in fr_s)[len(fr_s) // 2]
                    p95 = sorted(x['p95'] for x in fr_s)[len(fr_s) // 2]
                    mn = sorted(x['min'] for x in fr_s)[len(fr_s) // 2]
                    a_err = None
                except Exception as e:
                    med = p95 = mn = None
                    a_err = f'{type(e).__name__}: {str(e)[:160]}'
                    emit(f'  ✗✗ {tag} 量具 A 失败：{a_err}')
                    emit('      ⇒ **量具失明 ⇒ 这一档没有读数**（不是「丙不花钱」的结论）。')

                # ---- 量具 B：隔离计时泛光（gl.finish 前后夹）--------------------
                bt = {'median': None}
                if med is not None:
                    try:
                        bt = await page.evaluate(BLOOM_TIME_JS, [BLOOM_N, REPS])
                    except Exception as e:
                        emit(f'    ⚠ {tag} 量具 B 抛出：{type(e).__name__}: {str(e)[:140]}')
                        bt = {'ok': False, 'why': 'evaluate 抛异常'}
                    if not bt.get('ok'):
                        emit(f'    ⚠ {tag} 泛光隔离计时失败（{bt.get("why")}）'
                             f' —— 这一档只看量具 A')
                        bt = {'median': None}
                elapsed = time.monotonic() - t0

                f = fetch_proxy(ks, rt)
                share = '' if bt.get('median') is None or med is None \
                    else f'{bt["median"] / med * 100:.1f}%'
                results[(lv, tag)] = {
                    'med': med, 'p95': p95, 'min': mn, 'a_err': a_err,
                    'bloom': bt.get('median'), 'fetch': f,
                    'calls': chk.get('calls'), 'tris': chk.get('triangles'),
                    'note': note, 'applied': applied, 'elapsed': elapsed,
                }
                print(f'  {tag:<9} {fmt_ms(med):>8} {fmt_ms(p95):>8} {fmt_ms(mn):>8} | '
                      f'{fmt_ms(bt.get("median")):>9} {share:>7} | {f:>12,} '
                      f'{chk.get("programs"):>5} {note}  [{elapsed:.1f}s]')
                draws.add((chk.get('calls'), chk.get('triangles')))

            # 场景恒定性：这一轮**只该动泛光**。draw calls / triangles 在档位之间
            # 变了就说明有别的东西跟着变 ⇒ 那样的 A/B 不是单变量（坑 105 的口径）。
            if len(draws) == 1:
                c0, t0 = next(iter(draws))
                print(f'  ✓ 各档位 draw calls={c0} / triangles={t0} **恒定** '
                      f'⇒ 场景没被改动，变的是泛光')
            else:
                print(f'  ⚠ draw calls/triangles 在档位之间变了：{sorted(draws)} '
                      f'⇒ 场景被动过，这一层的 A/B 不是单变量，读数要打折')

            # 这一层跑完，把核写回**标尺（出厂）**——下一层的 ctrl 也就从同一状态起步，
            # 少一个「层间状态不同」的自由度。（不改也行：`ctrl` 那一档本来就会写回出厂。）
            for i, K in enumerate(FACTORY_K):
                await page.evaluate(SET_K_JS, [i, K, factory(K)])

        # ---- 汇总 ---------------------------------------------------------
        print('\n' + '=' * 104)
        print('  汇总：相对 ctrl 的变化（同层内比较，跨层不可比）')
        print('-' * 104)
        verdict = True
        for lv in LEVELS:
            if (lv, 'ctrl') not in results:
                continue
            c = results[(lv, 'ctrl')]
            if c.get('med') is None:
                print(f'  层 {lv}：**锚点 ctrl 没有读数**（{c.get("a_err")}）'
                      f' ⇒ 这一层全部作废，不参与比较')
                verdict = False
                continue
            b = results.get((lv, 'ctrl-b'))
            floor = None if (b is None or b.get('med') is None) else abs(b['med'] - c['med'])
            print(f'  层 {lv}：ctrl 帧中位 {c["med"]:.2f} ms · 泛光 {fmt_ms(c["bloom"])} ms'
                  f' · 噪声地板 |ctrl − ctrl-b| = '
                  f'{"—" if floor is None else f"{floor:.2f} ms"}')
            print(f'    {"档":<9} {"Δ帧时间":>10} {"Δ%":>8} {"Δ泛光ms":>10} {"Δ泛光%":>9}  判读')
            for tag, _desc, _kind in CONFIGS:
                if tag in ('ctrl', 'ctrl-b') or (lv, tag) not in results:
                    continue
                r = results[(lv, tag)]
                if r.get('med') is None:
                    print(f'    {tag:<9} {"(量具失明)":>10} {"—":>8} {"—":>10} {"—":>9}  '
                          f'**没有读数**：{r.get("a_err")}')
                    verdict = False
                    continue
                dm = r['med'] - c['med']
                dp = dm / c['med'] * 100
                if r['bloom'] is None or c['bloom'] is None:
                    db, dbp = None, ''
                else:
                    db = r['bloom'] - c['bloom']
                    dbp = f'{db / c["bloom"] * 100:+.1f}%'
                tag_note = ''
                if tag == 'box-23':
                    tag_note = '地板内✓' if (floor is None or abs(dm) <= max(floor, 0.3)) \
                        else '**超地板 ⇒ 换系数值本身也花钱？**'
                print(f'    {tag:<9} {dm:>+9.2f}ms {dp:>+7.1f}% '
                      f'{fmt_ms(db):>10} {dbp:>9}  {tag_note}')

            # ---- 验收判定 --------------------------------------------------
            # ★ **判据的主承载者不是量具 A，而是「结构上界 + 灵敏度哨兵」。**
            #   为什么（实测）：A 的噪声地板 |ctrl − ctrl-b| 在 1 rep 下就有 1.2 ms / 12.9%，
            #   而 丙 的预期效应只有 ~0.2 ms ⇒ **A 的分辨率根本不够**，
            #   拿它的差值下结论等于编数（实测 thin-all 取样少了 52% 反而读成「更慢」）。
            #   ⇒ A 只承担**绝对线**（帧中位 < 16.7 ms）；比较判定改走下面三条。
            cb = results.get((lv, 'ctrl-b')) or {}
            b_floor = None
            if c.get('bloom') is not None and cb.get('bloom') is not None:
                b_floor = abs(cb['bloom'] - c['bloom'])
            b_huge = (results.get((lv, 'huge-0')) or {}).get('bloom')
            b_w23 = (results.get((lv, 'wide-23')) or {}).get('bloom')

            w23 = results.get((lv, 'wide-23')) or {}

            # ⓪ 顺序漂移哨兵（每层必查）：ctrl-z 与 ctrl 完全是同一状态，只差「排在最后」。
            cz = results.get((lv, 'ctrl-z')) or {}
            if cz.get('med') is not None and c.get('med') is not None:
                drift = cz['med'] - c['med']
                thr = 3.0 * max(floor or 0.0, 0.05)
                bad = abs(drift) > thr
                print(f'    · 顺序漂移哨兵 ctrl-z（与 ctrl 完全相同、只排最后）：'
                      f'{c["med"]:.2f} → {cz["med"]:.2f} ms'
                      f'（{drift:+.2f} ms / {drift / c["med"] * 100:+.1f}%）· 门槛 {thr:.2f} ms'
                      f' ⇒ {"**有漂移**" if bad else "无漂移"}')
                if bad:
                    print('      ⚠⚠ **量具 A 有顺序漂移** ⇒ 排在后面的档位读数系统性偏高。')
                    print('         ⇒ 「谁排最后谁最慢」是**位置效应**，不是档位代价。')
                    print('         ⇒ 量具 A 的 Δ列**不能用来判便宜/贵**（保留了绝对值那一条）。')

            # ① 绝对线（项目硬指标）：帧时间中位数 < 16.7 ms
            if w23.get('med') is None:
                print('    ✗ ① 丙 没有量具 A 读数 ⇒ **不能判「过」**（没测出来 ≠ 通过）')
                verdict = False
            elif w23['med'] >= 16.7:
                print(f'    ✗ ① 帧时间中位数 {w23["med"]:.2f} ms **越过 16.7 ms** —— 丙 不能上')
                verdict = False
            else:
                print(f'    ✓ ① 帧时间中位数 {w23["med"]:.2f} ms < 16.7 ms（预算 16.7）')

            # ② 量具 B 的灵敏度哨兵：huge-0（取样 +900% 量级）必须把泛光时间顶起来
            b_ok = False
            if b_huge is None or c.get('bloom') is None:
                print('    ✗ ② 灵敏度哨兵 huge-0 没有读数 ⇒ **B 是否看得见取样次数无法判定**')
                verdict = False
            else:
                d_huge = b_huge - c['bloom']
                need = max(3.0 * (b_floor or 0.0), 0.02)
                if d_huge > need:
                    b_ok = True
                    print(f'    ✓ ② 量具 B 会响：huge-0 泛光 {c["bloom"]:.3f} → {b_huge:.3f} ms'
                          f'（{d_huge:+.3f} ms > 门槛 {need:.3f}，地板 {fmt_ms(b_floor)}）')
                else:
                    print(f'    ⚠ ② 量具 B **连 +900% 的取样都推不动**（{c["bloom"]:.3f} → '
                          f'{b_huge:.3f} ms，地板 {fmt_ms(b_floor)}）')
                    print('         ⇒ 这一级的泛光链**受取样次数以外的东西支配**（pass 开销 / 带宽）')
                    print('           ⇒ B 的**差值**分辨率不够判点估；改用下面的**结构上界**（③）')

            # ③ 丙 的代价 —— 上界（无论 B 是否灵敏都成立），点估只作参考
            if b_w23 is None or c.get('bloom') is None or c.get('med') is None:
                print('    ✗ ③ 丙 的泛光时间没有读数 ⇒ 代价无法定界')
                verdict = False
            else:
                # 泛光链占一帧多少 —— 这个比例本身就是「量具 B 的绝对刻度」的自检：
                # 一个全屏后处理占一帧 1% 量级是合理的；若读到 50% 说明 B 的读数不对。
                share = c['bloom'] / c['med'] * 100
                # **结构上界**：丙 只改 mip2/mip3 的抽头数 = 模糊链取样量 +9.7%；
                #   任何与取样次数成正比的代价分量最多涨 9.7%，与取样无关的分量（pass 开销）
                #   一点都不变 ⇒ **整条泛光链的涨幅 ≤ 9.7%**。这是硬上界，不是假设。
                ratio = (results.get((lv, 'wide-23')) or {}).get('fetch', 0) / base_fetch - 1.0
                ub_ms = max(0.0, ratio) * c['bloom']
                ub_pct = ub_ms / c['med'] * 100
                cost = b_w23 - c['bloom']
                print(f'    ③ 泛光链占一帧 {share:.1f}%（{c["bloom"]:.3f} / {c["med"]:.2f} ms）'
                      f' · 丙 改动的取样量占模糊链 **{ratio * 100:+.1f}%**')
                print(f'       ⇒ **结构上界**：Δ帧 ≤ {ratio * 100:+.1f}% × {c["bloom"]:.3f} ms '
                      f'= {ub_ms:.4f} ms = 一帧的 **{ub_pct:.2f}%**')
                print(f'       实测点估：{cost:+.3f} ms（{cost / c["med"] * 100:+.2f}%）· '
                      f'量具 B 地板 {fmt_ms(b_floor)} ⇒ '
                      + ('**低于地板，测不出**' if (b_floor is not None and abs(cost) <= b_floor)
                         else '**高于地板**'))
                print(f'       ↳ 即便我对泛光链的绝对读数**低估 10 倍**，上界也只有 '
                      f'{ub_pct * 10:.2f}% —— 仍远低于「不赔本」的 5%')
                if ub_pct > 5.0:
                    print(f'       ✗ 结构上界 {ub_pct:.2f}% > 5% —— 过不了「不赔本」线')
                    verdict = False
                else:
                    print(f'       ✓ 结构上界 {ub_pct:.2f}% ≤ 5%')

            # ④ 漂移自检：量具 B 的地板若大到与效应同量级，就明说「这一层比较不出差别」
            if b_floor is not None and c.get('bloom') and b_floor > 0.25 * c['bloom']:
                print(f'    ⚠ ④ 量具 B 地板 {b_floor:.3f} ms 已达 ctrl 泛光时间的 '
                      f'{b_floor / c["bloom"] * 100:.0f}% ⇒ **这一层的点估不可用于比较**，'
                      f'只看 ③ 的结构上界')

            if c.get('min') is not None and c['min'] > 16.0:
                print(f'    ⚠ **vsync 疑似封顶**（ctrl 的 min = {c["min"]:.2f} ms ≈ 16.7）'
                      f' ⇒ 量具 A 的绝对线要重看')
            elif c.get('min') is not None:
                print(f'    · 未封顶（ctrl 的 min = {c["min"]:.2f} ms ≪ 16.7）⇒ 帧时间有余量')

        print('=' * 104)
        if not sp_ok:
            print('  ⚠ 设计自证没过 ⇒ 上面的读数不可用')
        print(f'  量具 B 的自证：跑这一轮共见过 {len(prog_seen)} 个不同的 programs 计数 '
              f'{sorted(x for x in prog_seen if x is not None)}（K 变更 ⇒ 重编译 ⇒ 计数应增长）')
        print(f'  console 错误 {len(console_errors)} 条'
              + ('' if not console_errors else '：'))
        for e in console_errors[:6]:
            print(f'    ! {e}')
        print(f'  总结论：{"✓ 全部验收线通过" if verdict else "✗ 有验收线没过 —— 见上面逐条"}')
        print('=' * 104)

        # ---- 复位 ---------------------------------------------------------
        # ★ 恢复的是**生产状态**（`levels` 是开局从活页面读回来的那套 = 丙），
        #   不是本轮当标尺用的出厂核 —— 探针不该把标尺留在被测对象身上。
        for lv2 in levels:
            await page.evaluate(SET_K_JS, [lv2['i'], lv2['len'], lv2['coeffs']])
        chk = await page.evaluate(READ_KERNELS_JS)
        same = all(
            chk['levels'][lv2['i']]['len'] == lv2['len']
            and all(abs(a - b) < 1e-12 for a, b in zip(lv2['coeffs'], chk['levels'][lv2['i']]['coeffs']))
            for lv2 in levels)
        tup = tuple(chk['levels'][i]['len'] for i in (2, 3))
        print(f'  已复位到**生产状态**（不是出厂）：五级核（K 与系数）与开头逐位一致 = {same}'
              f' · mip2/mip3 K = {tup[0]}/{tup[1]}')
        print(f'  复位后泛光实况 strength={chk["strength"]} radius={chk["radius"]} '
              f'threshold={chk["threshold"]}')

        sys.stdout.flush()
        srv.stop()                     # ① 先停服务（结论已落盘）
        arm_hard_exit(14, 0)           # ② 再武装看门狗（关浏览器总会超时）
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except Exception as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘，由看门狗收尾）：{type(e).__name__}')
    return 0


async def main():
    srv = ServedCheck(tag='泛光核性能探针')
    base = srv.start()
    try:
        return await run(base, srv)
    finally:
        # 兜底：出错路径也要收掉服务（`stop()` 幂等，正常路径已经停过一次）
        srv.stop()


if __name__ == '__main__':
    arm_hard_exit(TIMEOUT_S, 3)
    sys.exit(asyncio.run(main()))

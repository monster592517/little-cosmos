#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方斑的**机制**归因 —— 不是「哪一级」，是「那一级的核根本不是高斯」。

## 这一测要回答的问题

坑 118 已经量到：方度集中在 **mip2（K=7）与 mip3（K=9）**，mip0/1/4 都是圆的。
文档里当时写的「为什么」是**推测，没有证据**。这一轮去读源码，找到一条能证伪的假设。

## 假设的来源（`UnrealBloomPass.js:376-382`，逐字抄）

    _getSeparableBlurMaterial( kernelRadius ) {
      const coefficients = [];
      for ( let i = 0; i < kernelRadius; i ++ )
        coefficients.push( 0.39894 * Math.exp( - 0.5 * i * i / ( kernelRadius * kernelRadius ) ) / kernelRadius );
      ...

于是每一级的抽头是 `x = 0, ±1, ±2, … ±(K−1)` **texel**（`uvOffset = direction * invSize * x`），
权重是 **σ = K 的高斯在整数点上的取值，截断在 ±(K−1)**。

**σ 与截断同量级 ⇒ 高斯根本没来得及衰减。** 代进去算 K=7：

    i  = 0     1     2     3     4     5     6
    w  = 1.000 .990  .960  .912  .849  .775  .693      ← 最外那一抽还有 **69%**

这不是高斯，这是一块**接近平的方框核**。而**可分离的方框核卷积一个点 ⇒ 轴对齐的正方形**
（两个一维方框的卷积 = 一个二维方框）。圆盘 ⊛ 方框 = 圆角方，方框比圆盘宽就纯是方。
⇒ 「mip2/mip3 是方」不需要额外的解释：**只有那两级的核宽 ≈ 源宽，方框才压过圆盘**。

## 怎么把它切开（关键：**必须把「核形状」和「核宽度」分开**）

只把 σ 从 K 改小（比如改成 K/3）会**同时**把光晕收窄 —— 那样即使方度变了，
也可能是「只是变小了」而不是「形状变了」。所以主判据档用**二阶矩配平**：

    σ_match(K) = sqrt( Σ w_i x_i² / Σ w_i )      ← 从**活页面里读回来的原核**现算

配平后核的宽度不变，只有形状从「近方框」变成「真高斯」⇒ 方度若变化，只能归因于形状。

## 档位

    0  ctrl      出厂（原样）                —— 锚点，必须复现「方」
    1  ctrl-b    与 ctrl **同状态再拍一张**   —— **噪声地板**（我的规矩：先量噪声地板）
    2  sens-id   五级核都换成 [1,0,0,…]（不模糊）—— **手段自证哨兵**：
                 换了它画面必须明显变化。**不变化 ⇒ 我的覆盖没进 GPU ⇒ 后续全部作废、中止**
    3  gM-all    五级 → 真高斯 σ=σ_match     —— **主判据**（宽度配平、只改形状）
    4  gM-23     只改 mip2/mip3 → 真高斯      —— 最外科的那一刀
    5  box-all   五级 → 全 1（纯方框）        —— **阳性对照**，预期「更方」
    6  box-23    只把 mip2/mip3 → 纯方框      —— 出厂已近方框 ⇒ 这一档变化应很小

## 判据（先写死，不是事后找解释）

| 观察 | 结论 |
|---|---|
| `gM-all`/`gM-23` 由**方**变**圆** | 核形状就是根因 ⇒ 治法 = **改核**（不是 甲/乙 那两条），且**不动 mip2/mip3 的权重 ⇒ 不损失光晕** |
| `box-all` 比 ctrl **更方** | 方框假设的**正向**证据 |
| `box-23` 与 ctrl 几乎一样 | 出厂核本来就是近方框的**直接**读数 |
| `gM-*` 不变、`box-*` 也不变 | 核形状**不是**根因 ⇒ 假设作废，回坑 118 重新找 |
| `sens-id` 与 ctrl 无差别 | **手段坏**，中止（不是被测对象的结论） |

**首轮实测（`shots/_bloom-kernel.log`，2026-09-12）**：预测全部成立 ——
`box-23` 由 **1.140→1.174**（更方）、`gM-23` 由 **1.140→1.046**（变圆）；
更硬的一条：`box-23` 与 `box-all` 的像素差 **2321**，噪声地板 **2324** ⇒ **两者是同一件事**，
**mip0/1/4 的核在画面上完全不起作用**。

但 `gM-23` 只走到「对角比 1.046 / 逐行宽度 0.78」，**离圆律（0.66/0.87/0.97）还差一半**。
残余有解释、也必须验：抽头只有 K 个 ⇒ 配平后的核**截断深度只有 1.70σ**（K=7），最外抽还剩
0.237，**还不是高斯**。于是加**剂量曲线**（只动 2/3 级）：

    gM-23 (σ=σ_eff, 深度 1.70σ) → gD75 (0.75σ_eff) → gT3 (深度恰 3σ) → gD50 (0.50σ_eff)

**先写死的验收线**（不是事后挑的）：对角比 **< 1.05** 且 12.5% 处逐行宽度 **≤ 0.70**，
且全屏均值相对 ctrl 降幅 **≤ 5%**；并且**单调**（σ 越小方度越小）。

**剂量实测（第二轮）**：单调，且落到圆律 —— 对角比 1.140→1.061→1.005（gD75）/1.005（gT3）/1.014（gD50）；
12.5% 宽 0.867→0.786→**0.658**（gT3，圆律 0.661）。**但**全屏均值 gD75 **−14%**、gT3 **−22%**、gD50 **−26%**
⇒ **只过了「形状」那条线，没过「不赔本」那条线**（≤5%）；只有 gM-23 过（−3.96%），但它只是「说不清」。
⇒ 出厂把 σ 钉死成 K，「宽」和「陡」只能二选一：磨陡买到圆度、赔掉光晕。
⇒ 于是补一档 **丙 `wide-23`**：**σ 保持原值、把抽头数 K 加够到 3σ 截断** ⇒ 试着同时拿到宽度与圆度。
   （mip2 的 K 7→12、mip3 的 K 9→15，由 `K = ⌈3σ_eff⌉ + 1` 定；代价是模糊着色器的取样次数，
   但那两级 RT 只有 175×108 / 88×54 ⇒ 绝对开销小。**性能影响未实测**。）

⚠️ 只动 `separableBlurMaterials[i].uniforms['gaussianCoefficients']`，
**不动 `strength` / `radius` / `threshold` / `bloomFactors`** —— 一次只切一个变量。

⚠️ 数组长度必须**逐级保持**（shader 里 `uniform float gaussianCoefficients[KERNEL_RADIUS]`
的 KERNEL_RADIUS 是编译期常量，长度不符 = 越界读）。本脚本逐级断言长度不变。

用法：
    py -3.13 -X utf8 tools/probe-bloom-kernel.py [--headed=false]
产出：`shots/bk-*.png`；日志由外层重定向到 `shots/_bloom-kernel.log`
"""
import asyncio
import math
import os
import sys
import threading

from playwright.async_api import async_playwright
from browser_args import OCCLUSION_ARGS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(line_buffering=True)
    except Exception:
        pass


def arm_hard_exit(seconds, code=0):
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t


HEADED = False
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')


# ---------------------------------------------------------------------------
# 读回**活页面里**每一级的核系数（不是从源码抄的 —— 抄的会过期）
# ---------------------------------------------------------------------------
READ_KERNELS_JS = r"""
() => {
  const e = window.__universe.engine;
  const p = e.bloomPass;
  if (!p || !p.separableBlurMaterials) return { err: 'no separableBlurMaterials' };
  return {
    nMips: p.nMips,
    strength: p.strength, radius: p.radius, threshold: p.threshold,
    bloom: !!(e.options && e.options.bloom),
    levels: p.separableBlurMaterials.map((m, i) => ({
      i,
      K: (m.defines && m.defines['KERNEL_RADIUS']) || null,
      len: m.uniforms['gaussianCoefficients'].value.length,
      coeffs: Array.from(m.uniforms['gaussianCoefficients'].value),
      invSize: [m.uniforms['invSize'].value.x, m.uniforms['invSize'].value.y],
      rtWH: p.renderTargetsVertical[i].width + 'x' + p.renderTargetsVertical[i].height,
    })),
  };
}
"""

# 逐级覆盖核系数。**必须赋一个新数组**（就地改元素时 three 的 uniform 缓存
# 可能认为值没变；不过这一条在这里其实由内容比对兜底 —— 见 README 的说明）。
SET_KERNEL_JS = r"""
([i, coeffs]) => {
  const p = window.__universe.engine.bloomPass;
  const m = p.separableBlurMaterials[i];
  const cur = m.uniforms['gaussianCoefficients'].value;
  if (coeffs.length !== cur.length) {
    return { err: 'length mismatch', want: cur.length, got: coeffs.length };
  }
  m.uniforms['gaussianCoefficients'].value = coeffs.slice();
  return { i, K: cur.length };
}
"""

# **丙**：连抽头数（编译期 define）一起改 —— 「又宽又圆」要求 K ≳ 3σ+1，
# 而出厂把 σ 钉死成 K，于是「宽」和「陡」只能二选一。这里把两者解耦。
# ⚠️ `defines` 变了必须 `needsUpdate = true` 触发**程序重编译**；
#    新程序的 uniform 是长度为 K 的数组，必须**同时**给出等长系数。
SET_KERNEL_K_JS = r"""
([i, K, coeffs]) => {
  const p = window.__universe.engine.bloomPass;
  const m = p.separableBlurMaterials[i];
  if (coeffs.length !== K) return { err: 'coeffs len != K', K, got: coeffs.length };
  m.defines['KERNEL_RADIUS'] = K;
  m.needsUpdate = true;
  m.uniforms['gaussianCoefficients'].value = coeffs.slice();
  return { i, K, def: m.defines['KERNEL_RADIUS'], len: m.uniforms['gaussianCoefficients'].value.length };
}
"""

ISOLATE_JS = r"""
(i) => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  if (!window.__origVis) window.__origVis = kids.map((o) => o.visible);
  for (let k = 0; k < kids.length; k++) kids[k].visible = (k === i);
  lv.labels?.setVisible?.(false);
  return kids.length;
}
"""

FIND_JS = r"""
(name) => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  for (let k = 0; k < kids.length; k++) if (kids[k].name === name) return k;
  return -1;
}
"""

HIDE_HUD_JS = """
() => {
  const KEEP = new Set(['scene', 'labels']);
  const saved = [];
  for (const el of document.body.children) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
    if (KEEP.has(el.id)) continue;
    saved.push([el, el.style.display]);
    el.style.display = 'none';
  }
  window.__hudSaved = saved;
  return saved.length;
}
"""

SHOW_HUD_JS = """
() => {
  if (!window.__hudSaved) return 0;
  for (const [el, d] of window.__hudSaved) el.style.display = d;
  window.__hudSaved = null;
  return 1;
}
"""

SETTLE_JS = r"""
(n) => new Promise(res => {
  let i = 0;
  const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
})
"""


async def settle(page, frames=3, min_ms=0):
    if min_ms:
        await page.wait_for_timeout(min_ms)
    try:
        await page.evaluate(SETTLE_JS, frames)
    except Exception:
        pass


async def shoot(page, path):
    await page.evaluate(HIDE_HUD_JS)
    await settle(page, frames=3, min_ms=240)
    await page.screenshot(path=path)
    await page.evaluate(SHOW_HUD_JS)
    return path


# ---------------------------------------------------------------------------
# 核的设计 + **代回表达式验算**（坑 121：档位设计本身也要有判据）
# ---------------------------------------------------------------------------
def sigma_eff(coeffs):
    """原核的等效高斯 σ（二阶矩口径）—— 宽度配平用它，不用我口算的数。"""
    s0 = coeffs[0] + 2.0 * sum(coeffs[1:])
    s2 = 2.0 * sum((i * i) * coeffs[i] for i in range(1, len(coeffs)))
    return math.sqrt(s2 / s0)


def gauss(K, sigma):
    return [math.exp(-0.5 * (i * i) / (sigma * sigma)) for i in range(K)]


def box(K):
    return [1.0] * K


def factory(K):
    """**出厂构造式**：σ 就取 K（`UnrealBloomPass.js:376-382` 逐字复刻）。

    ⚠️ 2026-09-12 起，活页面里的核**不再是出厂核** —— 生产环境默认套用了
    「丙」（σ 与 K 解耦，`web/js/core/bloom-kernel.js`）。所以这个探针
    必须在开局**显式复位到出厂**，否则 `ctrl` 这个锚点会静默变成丙，
    而 `design_selfproof` / `gm` 配平档会全部失效
    （丙的核已经是真高斯截断，再「配平」等于没动，断言必红）。
    「标尺自己得说清自己量的是什么」——所以复位这一步会大声打印出来。
    """
    return [0.39894 * math.exp(-0.5 * (i * i) / (K * K)) / K for i in range(K)]


# 出厂那一组 K（`UnrealBloomPass.js:148` 的 `kernelSizeArray`）
FACTORY_K = [3, 5, 7, 9, 11]


def as_factory(live):
    """把活页面读回的核换算出「出厂核」的同构 dict —— 下游全部按出厂口径走。"""
    lv = []
    for i, K in enumerate(FACTORY_K):
        c = factory(K)
        old = live['levels'][i] if i < len(live['levels']) else {}
        lv.append({**old, 'i': i, 'K': K, 'len': K, 'coeffs': c})
    return {**live, 'levels': lv}


def report_production(live):
    """**生产现状**：把活页面里正在跑的那套核算成判据。

    「丙」的三条判据（离线版在 `tools/check-bloom-kernel.mjs`，这里从活页面再量一遍）：
      · K 应该是 `⌈3σ_eff⌉+1`（mip2 = 12、mip3 = 15）
      · σ 必须**保住**（相对出厂 σ_eff 的偏差 < 2%）
      · 该级实际截断深度 ≥ 3σ
    """
    print('\n' + '=' * 96)
    print('  ★★ 生产现状：**这就是现在上线的那套核**（不是出厂核）')
    print('-' * 96)
    print(f'  {"级":<3}{"活页面 K":<10}{"出厂 K":<9}{"σ_eff(活)":<12}{"σ_eff(出厂)":<13}'
          f'{"σ 相对差":<11}{"截断":<10}{"最外抽/中心":<13}判定')
    ok = True
    for i, lv in enumerate(live['levels']):
        K = lv['len']
        c = lv['coeffs']
        se = sigma_eff(c)
        Kf = FACTORY_K[i] if i < len(FACTORY_K) else None
        sef = sigma_eff(factory(Kf)) if Kf else float('nan')
        d = abs(se - sef) / sef if Kf else float('nan')
        # ⚠️ 截断深度的分母用**源 σ（= 出厂 σ_eff）**，不用 σ_eff(活)。
        #    判据是「K−1 ≥ 3·σ」里的那个 σ —— 也就是**当初设定**的宽度。
        #    拿 σ_eff(活) 当分母会系统性**高估** 0.6–0.9%（因为 σ_eff(活) 本身偏低）。
        #    同一个量只许一处口径（坑 100 的同族）。
        trunc = (K - 1) / sef if sef else float('nan')
        touched = (Kf is not None and K != Kf)
        verdict = '—'
        if touched:
            verdict = ('✓ 丙' if (d <= 0.02 and trunc >= 3.0 - 1e-9) else '✗ 越线')
            ok = ok and d <= 0.02 and trunc >= 3.0 - 1e-9
        print(f'  {i:<3}{K:<10}{Kf if Kf else "—":<9}{se:<12.4f}{sef:<13.4f}'
              f'{d:<11.5f}{trunc:<10.3f}{edge_ratio(c):<13.4f}{verdict}')
    print('  ⇒ 全部「✓ 丙」= 生产环境确实在做「保 σ、加抽头数」。')
    print('  ⇒ 若看到活页面 K == 出厂 K，说明 `retuneBloomKernel()` 没被调用 —— '
          '先查 `engine.js._createComposer()` 的接线，别去改核。')
    print('=' * 96)
    return ok


def edge_ratio(coeffs):
    return coeffs[-1] / coeffs[0]


def design_selfproof(stock):
    """**先把每一档的系数代回公式验算，不通过就别发。**"""
    print('  [设计自证] 逐级代回验算：')
    print(f'  {"级":<3}{"K":<4}{"原核 σ_eff":<11}{"原核最外抽/中心":<15}'
          f'{"配平核 σ 用之":<13}{"配平核最外抽/中心":<16}{"降幅":<8}{"方框 σ_eff":<11}')
    for lv in stock['levels']:
        K = lv['len']
        c = lv['coeffs']
        se = sigma_eff(c)
        er = edge_ratio(c)
        gm = gauss(K, se)
        er2 = edge_ratio(gm)
        bx = box(K)
        se_bx = sigma_eff(bx)
        se_bx_theory = math.sqrt(K * (K - 1) / 3.0)     # 离散均匀 {−(K−1)..K−1} 的 σ
        assert abs(se_bx - se_bx_theory) < 1e-9, f'方框 σ_eff 理论式不符：{se_bx} vs {se_bx_theory}'
        print(f'  {lv["i"]:<3}{K:<4}{se:<11.3f}{er:<15.3f}{se:<13.3f}{er2:<16.3f}'
              f'{er2 / er:<8.2f}{se_bx:<11.3f}')
        # ⚠️ 判定「档位有效」的条件：配平核必须**真的比原核更陡**，否则这一档
        #    跟原始状态没区别，测了等于没测（这就是坑 121 的形态）。
        assert er2 < 0.5 * er, (
            f'第 {lv["i"]} 级（K={K}）配平核没有比原核更陡：最外抽比 {er2:.3f} vs {er:.3f} '
            f'—— 这一档测不出东西，档位设计无效')
        assert abs(len(gm) - K) == 0 and abs(len(bx) - K) == 0
    print('  [设计自证] ✓ 每一档：长度==K 逐级保持；配平核最外抽/中心 均 < 0.5×原核；'
          '方框 σ_eff == sqrt(K(K−1)/3) 精确成立')
    print('  ⇒ 也就是说：**不改宽度也能把核从「近方框」换成「真高斯」**，这一测是纯形状归因。')


def frames_diff(a_path, b_path):
    """两张全屏图的差别：平均绝对差 + 变化像素数。用于噪声地板与哨兵自证。"""
    import numpy as np
    from PIL import Image
    a = np.asarray(Image.open(a_path).convert('RGB')).astype(np.int16)
    b = np.asarray(Image.open(b_path).convert('RGB')).astype(np.int16)
    if a.shape != b.shape:
        return None
    d = np.abs(a - b).max(axis=2)
    return dict(mean=float(d.mean()), changed=int((d > 8).sum()), n=int(d.size))


async def main():
    # ⚠️ `srv` 必须是**全局**：`run()` 收尾那句 `srv.stop()` 在 `run()` 的作用域里
    #    读不到 `main()` 的局部变量 ⇒ NameError ⇒ 它之后的三步（武装看门狗、关浏览器）
    #    全不执行 ⇒ **每跑一次漏一个浏览器进程**。骨架从 probe-bloom-mips.py 抄来就带着这个洞。
    global srv
    srv = ServedCheck(tag='泛光核形状探针')
    base = srv.start()
    try:
        return await run(base)
    finally:
        srv.stop()


async def run(base):
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as pw:
        backend = 'msedge'
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=OCCLUSION_ARGS)
        except Exception as e:
            backend = f'bundled-chromium（msedge 起不来：{type(e).__name__}）'
            browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! {m.text[:160]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=45000)
        await page.wait_for_timeout(2200)
        await page.evaluate("""() => {
          const e = window.__universe.engine;
          if (e.gpu) e.gpu.tierPinned = true;
          if (e.applyTier) e.applyTier('high');
          return 1;
        }""")
        await page.evaluate("window.__universe.gotoScale('galaxy')")
        await page.wait_for_function(
            "window.__universe.engine.current?.id === 'galaxy'", timeout=40000)
        await page.wait_for_timeout(1800)
        emit(f'  后端 {backend}')

        live = await page.evaluate(READ_KERNELS_JS)
        if live.get('err'):
            print(f'  ✗ 读不到泛光内部状态：{live["err"]}')
            return 1
        print('\n' + '=' * 96)
        print('  活页面里的泛光核 —— **这是读回来的，不是从源码抄的**')
        print('-' * 96)
        print(f'  nMips={live["nMips"]} · strength={live["strength"]} · radius={live["radius"]}'
              f' · threshold={live["threshold"]} · bloom={live["bloom"]}')
        print(f'  {"级":<3}{"K":<4}{"RT 尺寸":<11}{"invSize":<22}{"核系数（中心 → 最外抽）"}')
        for lv in live['levels']:
            cs = ' '.join(f'{x:.3f}' for x in lv['coeffs'])
            print(f'  {lv["i"]:<3}{lv["len"]:<4}{lv["rtWH"]:<11}'
                  f'[{lv["invSize"][0]:.5f},{lv["invSize"][1]:.5f}]   {cs}')
        print('  ⇒ 注意看「最外抽 / 中心」这一列：**如果它接近 1，这个核就是方框不是高斯。**')
        print('=' * 96)

        # ★ 先给「生产现状」做判据（这才是用户实际看到的东西）
        report_production(live)

        # ★★ 再把标尺钉回出厂。**这一步不能省**：
        #    生产环境默认套用「丙」，而 `ctrl` / `gM-*` / `box-*` 全部是按
        #    **出厂核**设计的档位。不复位的话，`ctrl` 会静默变成丙
        #    （方斑已经没了 ⇒ 锚点失效），`design_selfproof` 的
        #    「配平核必须比原核陡」断言会必红 —— 而那不是代码坏了，
        #    是**标尺被悄悄换掉了**（坑 121 的形态）。
        reset_note = []
        for i, K in enumerate(FACTORY_K):
            r = await page.evaluate(SET_KERNEL_K_JS, [i, K, factory(K)])
            reset_note.append(f'第{i}级→K={K}' + ('' if not r.get('err') else f'（✗{r["err"]}）'))
        await settle(page, frames=2, min_ms=200)
        chk_fac = await page.evaluate(READ_KERNELS_JS)
        fac_ok = all(
            chk_fac['levels'][i]['len'] == FACTORY_K[i]
            and all(abs(a - b) < 1e-12 for a, b in zip(factory(FACTORY_K[i]), chk_fac['levels'][i]['coeffs']))
            for i in range(len(FACTORY_K)))
        print(f'\n  [标尺复位] 已把五级核写回**出厂**：{"、".join(reset_note)}')
        print(f'  ⇒ 读回逐位一致 = {fac_ok}；下面所有档位（含 ctrl 锚点）都按**出厂核**解释。')
        if not fac_ok:
            print('  ✗✗ 复位失败 ⇒ ctrl 锚点不可信，后面全部作废。')
            return 1

        stock = as_factory(live)      # 下游（Ks / gm_all / box / design_selfproof）一律走出厂口径

        design_selfproof(stock)

        # ---- 剂量曲线自证：每一档的 σ、截断深度 (K−1)/σ、最外抽/中心 ----
        print('\n  [剂量自证] 只动 mip2/mip3（已证明 0/1/4 无关），把核一步步磨陡：')
        print(f'  {"档":<9}{"σ(K=7)":<10}{"深度":<9}{"最外/中心":<12}'
              f'{"σ(K=9)":<10}{"深度":<9}{"最外/中心":<12}')
        dose = {}
        for tag in ('gM-23', 'gD75', 'gT3', 'gD50'):
            row = [tag]
            for i in (2, 3):
                K = stock['levels'][i]['len']
                se = sigma_eff(stock['levels'][i]['coeffs'])
                if tag == 'gM-23':
                    s = se
                elif tag == 'gT3':
                    s = (K - 1) / 3.0
                else:
                    s = se * {'gD75': 0.75, 'gD50': 0.50}[tag]
                row += [f'{s:.3f}', f'{(K - 1) / s:.2f}σ', f'{edge_ratio(gauss(K, s)):.4f}']
            dose[tag] = row
        for tag, row in dose.items():
            print(f'  {row[0]:<9}{row[1]:<10}{row[2]:<9}{row[3]:<12}'
                  f'{row[4]:<10}{row[5]:<9}{row[6]:<12}')
        # 档位设计代回验算（坑 121：档位本身也要有判据）
        for i in (2, 3):
            K = stock['levels'][i]['len']
            s = (K - 1) / 3.0
            assert abs((K - 1) / s - 3.0) < 1e-12, 'gT3 截断深度不是 3σ'
            assert abs(edge_ratio(gauss(K, s)) - math.exp(-4.5)) < 1e-9, 'gT3 最外抽不是 e^-4.5'
        print(f'  [剂量自证] ✓ gT3 逐级：截断深度 == 3σ、最外抽 == e^-4.5 = {math.exp(-4.5):.4f}')
        print('  ⇒ **单调性判据**：σ 越小（核越陡）方度应越小。这不是「挑个顺眼的」，是把机制当剂量。')

        # 孤立核球（与 probe-bloom-mips / probe-bloom-zero 同一场景，表才好对得上）
        bidx = await page.evaluate(FIND_JS, 'mw-bulge')
        await page.evaluate(ISOLATE_JS, bidx)
        print(f'\n  已孤立 mw-bulge（scene 顶层第 {bidx} 个对象）、标签已关（坑 106）')

        Ks = [lv['len'] for lv in stock['levels']]
        gm_all = [gauss(Ks[i], sigma_eff(stock['levels'][i]['coeffs'])) for i in range(len(Ks))]
        bx_all = [box(Ks[i]) for i in range(len(Ks))]

        def tag_coeffs(tag):
            if tag in ('ctrl', 'ctrl-b', 'wide-23'):
                return None     # wide-23 要连 define 一起改，走单独分支
            if tag == 'sens-id':
                return [[1.0] + [0.0] * (Ks[i] - 1) for i in range(len(Ks))]
            if tag == 'gM-all':
                return gm_all
            if tag == 'gM-23':
                return [gm_all[i] if i in (2, 3) else None for i in range(len(Ks))]
            if tag in ('gD75', 'gD50', 'gT3'):
                # **剂量曲线**：只动 mip2/mip3（已证明 0/1/4 无关），把核一步步磨陡。
                #   gD75/gD50 —— σ = σ_eff × 0.75 / 0.50（宽度会跟着变窄，是「剂量」不是「纯形状」）
                #   gT3        —— σ = (K−1)/3 ⇒ **截断恰好在 3σ**，最外抽 = e^−4.5 = 0.0111（真高斯）
                mult = {'gD75': 0.75, 'gD50': 0.50}.get(tag)
                out = []
                for i in range(len(Ks)):
                    if i not in (2, 3):
                        out.append(None)
                    elif tag == 'gT3':
                        out.append(gauss(Ks[i], (Ks[i] - 1) / 3.0))
                    else:
                        out.append(gauss(Ks[i], sigma_eff(stock['levels'][i]['coeffs']) * mult))
                return out
            if tag == 'box-all':
                return bx_all
            if tag == 'box-23':
                return [bx_all[i] if i in (2, 3) else None for i in range(len(Ks))]
            raise KeyError(tag)

        order = ['ctrl', 'ctrl-b', 'sens-id', 'gM-all', 'gM-23', 'box-all', 'box-23',
                 'gD75', 'gD50', 'gT3', 'wide-23']
        print('\n  跑档位（孤立核球 · 泛光开 · 只动核系数）')
        print('-' * 96)
        made = {}
        gate_failed = False
        for tag in order:
            if gate_failed:
                break
            if tag == 'wide-23':
                # **丙**：σ 保持原值（宽度不变 ⇒ 不丢光晕），但把抽头加够到 3σ 截断
                # （⇒ 核变成真高斯 ⇒ 不方）。K 由 3σ+1 定，不再由出厂那个「K=σ」的绑定定。
                info = []
                for i in (2, 3):
                    K0 = Ks[i]
                    se = sigma_eff(stock['levels'][i]['coeffs'])
                    K2 = int(math.ceil(3.0 * se)) + 1
                    cs = gauss(K2, se)
                    r = await page.evaluate(SET_KERNEL_K_JS, [i, K2, cs])
                    if r.get('err'):
                        print(f'      ✗ 第 {i} 级改 K 失败：{r}')
                        gate_failed = True
                        break
                    info.append(f'第{i}级 K {K0}→{K2}（σ={se:.3f} 保持不变、截断 3σ、'
                                f'最外/中心 {edge_ratio(cs):.4f}）')
                if gate_failed:
                    break
                print('      [丙 又宽又圆] ' + '；'.join(info))
            coeffs = tag_coeffs(tag)
            if coeffs is not None:
                for i, cs in enumerate(coeffs):
                    if cs is None:
                        continue
                    r = await page.evaluate(SET_KERNEL_JS, [i, cs])
                    if r.get('err'):
                        print(f'  ✗ {tag} 第 {i} 级覆盖失败：{r}')
                        gate_failed = True
                        break
                if gate_failed:
                    break
            await settle(page, frames=3, min_ms=220)
            name = f'bk-{tag}.png'
            made[tag] = await shoot(page, os.path.join(SHOTS, name))
            head = '' if coeffs is None else \
                ' 核=' + ' / '.join('—' if c is None else f'第{i}级改' for i, c in enumerate(coeffs))
            print(f'  {tag:<9} → shots/{name}{head}')

            # ---- 哨兵闸门（坑 121：**阴性对照失败必须中止主流程**）----
            if tag == 'ctrl-b':
                nf = frames_diff(made['ctrl'], made['ctrl-b'])
                print(f'      [噪声地板] 同状态连拍两张：平均绝对差 {nf["mean"]:.4f}、'
                      f'变化像素 {nf["changed"]} / {nf["n"]}')
                if nf['changed'] > 20000:
                    print('      ⚠ 噪声地板太高 —— 场景里还有动画，这一轮的读数都要打折')
            if tag == 'sens-id':
                sf = frames_diff(made['ctrl'], made['sens-id'])
                print(f'      [哨兵] 核换成「不模糊」后：平均绝对差 {sf["mean"]:.4f}、'
                      f'变化像素 {sf["changed"]} / {sf["n"]}')
                if sf['changed'] < 20000 or sf['mean'] < 1.0:
                    print('      ✗✗ **哨兵没响 ⇒ 我的覆盖根本没进 GPU ⇒ 后面全部作废，中止。**')
                    print('          （不是「核不重要」的结论 —— 是这条手段测不到目标，先修手段。）')
                    gate_failed = True

        if not gate_failed:
            print('-' * 96)
            print('  ★ 待量（判据在文件头，先写死的）：')
            for tag in ('ctrl', 'gM-all', 'gM-23', 'box-all', 'box-23',
                        'gD75', 'gD50', 'gT3', 'wide-23'):
                if tag in made:
                    print(f'      python -X utf8 tools/check-bulge-shape.py shots/bk-{tag}.png')
            print('  ★ **先写死的验收线**（不是事后挑的）：')
            print('     · 圆 ⇒ `check-bulge-shape.py` 对角比 **< 1.05**')
            print('      且 逐行宽度在 12.5% 高处 **≤ 0.70**（圆律 0.661 / 出厂 0.87）')
            print('     · 不赔本 ⇒ 全屏均值相对 ctrl 降幅 **≤ 5%**（否则就是「改一个赔三个」）')
            print('     · 单调 ⇒ σ 越小方度越小；不单调则机制归因作废')
            print('  ★ 读法：ctrl 必须复现「方」（锚点）；gM-* 若变「圆」⇒ **核形状是根因**；')
            print('     box-all 应比 ctrl 更方（正向对照）；box-23 与 ctrl 接近 ⇒ 出厂核本就近方框。')
        print('=' * 96)

        # 复位：连 define 一起写回**生产状态**（不是出厂 —— 出厂只是本轮的标尺，
        # 页面上线的那套核才是 `live`；探针不该在最后把标尺留在被测对象身上）
        for lv in live['levels']:
            await page.evaluate(SET_KERNEL_K_JS, [lv['i'], lv['len'], lv['coeffs']])
        chk = await page.evaluate(READ_KERNELS_JS)
        same = all(
            all(abs(a - b) < 1e-12 for a, b in zip(lv['coeffs'], chk['levels'][lv['i']]['coeffs']))
            for lv in live['levels'])
        prod_again = (chk['levels'][2]['len'], chk['levels'][3]['len'])
        print(f'  已复位到**生产状态**（不是出厂）：五级核系数与开局逐位一致 = {same}'
              f' · mip2/mip3 K = {prod_again[0]}/{prod_again[1]}')
        print(f'  复位后泛光实况 strength={chk["strength"]} radius={chk["radius"]}'
              f' threshold={chk["threshold"]}（应与开头一致）')

        sys.stdout.flush()
        srv.stop()
        arm_hard_exit(14, 0)
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except Exception as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘，由看门狗收尾）：{type(e).__name__}')
    return 0


if __name__ == '__main__':
    arm_hard_exit(600, 3)
    sys.exit(asyncio.run(main()))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""泛光**逐级 mip 隔离** —— 方斑是「哪一级」放大出来的？

## 为什么是这一测（判据先写死，不是事后找解释）

`坑与雷点.md` 坑 118 已经把结论与下一步写死了：

    已排除的旋钮：`radius` 0.60→0.15 **框只收 44 px（恰好一格最粗 texel）、方度一动不动**；
                  `threshold` 提到 0.9 也才 291。
    未定位：方块的来源在 `UnrealBloomPass` 内部**哪一级**。
    下一步判据：**逐个只留一级 mip**（覆盖 `compositeMaterial.uniforms.bloomFactors`），
                看方块出现在哪一级 —— 这是能把「级联放大的锅」和「别的锅」分开的那次测量。

## 为什么要这么绕

`UnrealBloomPass` 合成是五级 mip 的**加权和**：

    gl_FragColor = bloomStrength * Σ lerpBloomFactor(bloomFactors[i]) * texture2D(blurTexture_i, vUv)

`bloomFactors` 出厂 `[1.0, 0.8, 0.6, 0.4, 0.2]`，每一级分辨率减半（mip0 = 1/2，mip4 = 1/32）。
把 `bloomFactors` 换成**独热**（某一级 1、其余 0），就只剩那一级的贡献 ——
**哪一级是方，一眼就定**。

## 判据

| 观察 | 结论 |
|---|---|
| 独热 mip0/mip1 **圆**，mip3/mip4 **方** | 方块 = **粗 mip 的双线性放大**（级联放大的锅） ⇒ 治法是改这几级的采样/权重 |
| **每一级都方** | 方源在**高通那一步**（`renderTargetBright` 半分辨率 + `alphaTest`/钳位）⇒ 治法完全不同 |
| 独热全部圆，**五级之和才方** | 方源在**合成/累加**那一步 |
| 全 0（泛光不出力）应该是**圆** | 这一条是**阴性对照**；它若也方，说明整个 A/B 的判据坏了 |

`bloomFactors` 的覆盖**必须在 `settle()` 之后再回读**（坑 119：`bloomRadius` 就是在
`render()` 里才写进 uniform 的，同一帧回读会拿到上一帧的值）。

用法：
    py -3.13 -X utf8 tools/probe-bloom-mips.py [--headed=false]
产出：`shots/bm-<i>-mipN.png`、`shots/bm-ctrl-none.png`
"""
import asyncio
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

SET_FACTORS_JS = r"""
(factors) => {
  const e = window.__universe.engine;
  const p = e.bloomPass;
  if (!p || !p.compositeMaterial) return { err: 'no bloomPass' };
  /* 赋一个**新数组**，不是改原数组的元素 —— 就地改元素时 three 的 uniform 缓存
     可能认为值没变（它按缓存比对），不会再上传。 */
  p.compositeMaterial.uniforms['bloomFactors'].value = factors.slice();
  return { set: factors.slice() };
}
"""

READ_FACTORS_JS = r"""
() => {
  const e = window.__universe.engine;
  const p = e.bloomPass;
  if (!p || !p.compositeMaterial) return { err: 'no bloomPass' };
  return {
    factors: Array.from(p.compositeMaterial.uniforms['bloomFactors'].value),
    radius: p.radius, strength: p.strength, threshold: p.threshold,
    uniformRadius: p.compositeMaterial.uniforms['bloomRadius'].value,
    nMips: p.nMips,
    /* 每级 RT 的实际像素尺寸 —— 「一格 texel 多少像素」要按它算，不要按屏幕宽猜 */
    rtWH: p.renderTargetsVertical.map((rt) => rt.width + 'x' + rt.height),
  };
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


async def main():
    # ⚠️ `srv` 必须是**全局**：`run()` 收尾那句 `srv.stop()`（坑 122）
    global srv
    srv = ServedCheck(tag='泛光逐级 mip 探针')
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

        info = await page.evaluate(READ_FACTORS_JS)
        print('\n' + '=' * 78)
        print('  泛光实况（改之前）')
        print('-' * 78)
        print(f'  nMips={info.get("nMips")} · 出厂 factors={info.get("factors")} · '
              f'strength={info.get("strength")} · threshold={info.get("threshold")}')
        print(f'  各级 RT 尺寸 {info.get("rtWH")}  ← 「一格 texel 多少屏幕像素」按它算')
        print(f'  radius(状态)={info.get("radius")} · uniform 回读={info.get("uniformRadius")}'
              '   ← 坑 119：回读慢一帧，这里是在 settle 之后读的，应当一致')
        print('=' * 78)

        # 孤立核球：只留一个顶层对象，判据才干净
        bidx = await page.evaluate(FIND_JS, 'mw-bulge')
        await page.evaluate(ISOLATE_JS, bidx)

        print('  逐级独热（只留一级 mip）；外加一条「全 0」阴性对照')
        print('-' * 78)
        # ⚠️⚠️ **第一版这里直接把 `bloomFactors` 设成独热 `[1,0,0,0,0]` —— 那是错的。**
        #    合成用的是 `lerpBloomFactor(f) = mix(f, 1.2−f, r)`，展开：
        #        w(f) = f·(1 − 2r) + 1.2r          ← **有个不随 f 走的常数项 1.2r**
        #    r = 0.6 ⇒ w(1) = 0.52，但 **w(0) = 0.72**（不是 0）。
        #    ⇒ 设 `[1,0,0,0,0]` 得到的是「第 i 级 0.52 + 其余四级各 0.72」= **五级全开**，
        #      五次测量只差 0.2 的一级 ⇒ 难怪五张图一模一样（实测 334/334/334/322/323 px）。
        #    ⇒ 真独热必须**反解**：要 w = W，则 f = (W − 1.2r) / (1 − 2r)。
        #      只留第 i 级 ⇒ f_i = f(1)，其余 f_j = f(0)。
        #    **教训：判据的「档位设计」也要代回表达式验算边界值，否则测的是同一个东西的几种写法。**
        def f_for_weight(W, radius):
            return (W - 1.2 * radius) / (1 - 2 * radius)

        def onehot(i, radius=0.6, n=5):
            hi, lo = f_for_weight(1.0, radius), f_for_weight(0.0, radius)
            return [hi if k == i else lo for k in range(n)]

        # 先把设计代回公式验算一遍 —— 不通过就别发（这条断言就是本脚本的判据自证）
        r_test = 0.6
        for i in range(5):
            f = onehot(i, r_test)
            w = [x * (1 - 2 * r_test) + 1.2 * r_test for x in f]
            assert abs(w[i] - 1.0) < 1e-9, f'独热设计失败：第 {i} 级权重 {w[i]}'
            for k in range(5):
                if k != i:
                    assert abs(w[k]) < 1e-9, f'独热设计失败：旁级 {k} 权重 {w[k]}'
        print(f'  [设计自证] 反解式 f=(W−1.2r)/(1−2r)，r={r_test} ⇒ '
              f'f(1)={f_for_weight(1.0, r_test):.3f} · f(0)={f_for_weight(0.0, r_test):.3f}')
        print(f'  [设计自证] 代回 w=f(1−2r)+1.2r 验算：每一种独热都恰好得到「1 个 1.0 + 4 个 0.0」✓')
        print('-' * 78)

        rows = []
        # 全 0 = 泛光不出力，必须回到「圆」
        cases = [(None, 'ctrl-none')] + [(i, f'{i}-mip{i}') for i in range(5)]
        for i, tag in cases:
            factors = ([0.0] * 5 if i is None else onehot(i))
            await page.evaluate(SET_FACTORS_JS, factors)
            await settle(page, frames=3, min_ms=200)
            rb = await page.evaluate(READ_FACTORS_JS)     # ← settle 之后才回读（坑 119）
            name = f'bm-{tag}.png'
            await shoot(page, os.path.join(SHOTS, name))
            got = rb.get('factors')
            rr = rb.get('radius') or 0.6
            w = [round(x * (1 - 2 * rr) + 1.2 * rr, 3) for x in (got or [])]
            ok = '✓' if got and all(abs(a - b) < 1e-6 for a, b in zip(got, factors)) else '✗ 没吃进去'
            print(f'  {tag:<12} factors={[round(x, 3) for x in factors]} {ok}')
            print(f'                ⇒ 实际权重 w=f(1−2r)+1.2r = {w}')
            rows.append((tag, got, name))
        print('-' * 78)
        print('  ★ 待量：`tools/check-bulge-shape.py shots/bm-*.png`')
        print('     ctrl-none 必须读成「圆」（阴性对照）；哪一级独热读成「方」，锅就是那一级。')
        print('=' * 78)

        # 复位
        await page.evaluate(SET_FACTORS_JS, [1.0, 0.8, 0.6, 0.4, 0.2])
        rb = await page.evaluate(READ_FACTORS_JS)
        print(f'  已复位：factors 回读 = {rb.get("factors")}')

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

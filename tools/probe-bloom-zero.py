#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一刀切：方斑是泛光的**输出**，还是泛光这一步的**结构副作用**？

## 上一次测量的结论与它留下的矛盾

`tools/probe-bloom-mips.py`（逐级独热）的结果是：

    五级独热**全都是同一个方块**（334×333 / 334×333 / 334×334 / 322×320 / 323×322）
    **阴性对照 `ctrl-none`（bloomFactors 全 0）也是方块** 338×336 / 占比 0.912 / 对角比 1.158

负对照挂了这件事本身比正片值钱：`bloomFactors` 全 0 时，合成输出 `bloomStrength * Σ 0 = 0`
—— 泛光**一分钱都不该加进去**。可画面没变。

**而 `bloomFactors` 的「✓ 回读」是同义反复**：我读的正是我刚写进 JS 的那个数组，
它证明不了 GPU 收到了它。这就是**坑 119 同一个病**（「设完立刻回读」的自证）。

## 两种解释，指向两种完全不同的修法

**解释甲：方斑就是泛光「加」上去的那部分。**
  ⇒ 那 `factors` 这个 uniform **根本没到 GPU** ⇒ 上一测作废，得换一个每帧都被重写的开关。
**解释乙：方斑是「泛光这一步被执行」的结构副作用。**
  `UnrealBloomPass.render()` 第 362 行把结果 **`AdditiveBlending` 写回自己的输入缓冲
  `readBuffer`**（`autoClear = false`、原地累加）。若这一步即使「加 0」也改变了画面，
  那问题在**它与缓冲/编码的交互**上，而不是在它的图像内容里。

## 怎么区分（把开关换成 `strength`）

`render()` **第 340 行每帧都写** `compositeMaterial.uniforms['bloomStrength'].value = this.strength`。
所以 `bloomPass.strength = 0` 一定会被上传 —— 这个开关**不自证、可信**。
而 `bloomFactors` 只在构造函数里写一次，`render()` 从不碰它 ⇒ 我赋的值**只经过 three 的
uniform 缓存比对**这一道关。

    A  泛光开 strength 0.72（对照，应当复现「方」）
    B  泛光开 **strength 0**                    ← 关键
    C  泛光开 strength 0 + factors 全 0          ← 双保险
    D  泛光**关**（阳性对照，应当复现 sq-4 的「圆」）
    E  泛光开 strength 0.72 + factors 全 0（复现上一次的 ctrl-none）

| 结果 | 结论 |
|---|---|
| D 圆、B 圆 | **甲** —— 方斑是泛光的输出，`factors` 没进 GPU（新坑：**不该去改 render() 拥有的 uniform**） |
| D 圆、B **仍方** | **乙** —— 「泛光被执行」本身改变了画面，方斑在它与缓冲的交互里 |

用法：
    py -3.13 -X utf8 tools/probe-bloom-zero.py [--headed=false]
产出：`shots/bz-*.png`
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

SET_JS = r"""
([on, strength, factors]) => {
  const e = window.__universe.engine;
  const p = e.bloomPass;
  if (!p) return { err: 'no bloomPass' };
  e.options.bloom = !!on;
  p.enabled = !!on;                       // ← 显式设 pass.enabled，不靠 options 的下一次循环
  if (strength !== null && strength !== undefined) p.strength = strength;
  if (factors) p.compositeMaterial.uniforms['bloomFactors'].value = factors.slice();
  return { ok: true };
}
"""

# ⚠️ 这一条**放在 settle 之后**读（坑 119）。而且只信 `bloomStrength` 那一栏 ——
#    它是 `render()` 每帧重写的，读到的就是 GPU 真正拿到的值；
#    `bloomFactors` 那一栏只是我写进 JS 的东西，**不具备证明力**，这里照样打出来，
#    但标签写明「仅 JS 侧」。
READ_JS = r"""
() => {
  const e = window.__universe.engine;
  const p = e.bloomPass;
  return {
    enabled: !!(p && p.enabled),
    optionsBloom: e.options.bloom,
    strengthState: p ? p.strength : null,
    strengthUniform: p ? p.compositeMaterial.uniforms['bloomStrength'].value : null,
    radiusState: p ? p.radius : null,
    radiusUniform: p ? p.compositeMaterial.uniforms['bloomRadius'].value : null,
    factorsJSSide: p ? Array.from(p.compositeMaterial.uniforms['bloomFactors'].value) : null,
    rtHalf: p ? (p.renderTargetsHorizontal[0].width + 'x' + p.renderTargetsHorizontal[0].height) : null,
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


FACTORS_DEF = [1.0, 0.8, 0.6, 0.4, 0.2]
FACTORS_ZERO = [0.0, 0.0, 0.0, 0.0, 0.0]

CASES = [
    ('bz-a-on-s072',      True,  0.72, None,          '泛光开 strength 0.72（对照，应复现「方」）'),
    ('bz-b-on-s000',      True,  0.0,  None,          '**关键**：泛光开、strength 0'),
    ('bz-c-on-s000-f0',   True,  0.0,  FACTORS_ZERO,  '双保险：strength 0 + factors 全 0'),
    ('bz-d-off',          False, 0.72, None,          '阳性对照：泛光关（应复现 sq-4 的「圆」）'),
    ('bz-e-on-s072-f0',   True,  0.72, FACTORS_ZERO,  '复现上一次的 ctrl-none'),
]


async def main():
    # ⚠️ `srv` 必须是**全局**：`run()` 收尾那句 `srv.stop()`（坑 122）
    global srv
    srv = ServedCheck(tag='泛光归零探针')
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

        bidx = await page.evaluate(FIND_JS, 'mw-bulge')
        await page.evaluate(ISOLATE_JS, bidx)

        print('\n' + '=' * 78)
        print('  一刀切：方斑 = 泛光的「输出」，还是「执行它」这件事的副作用？')
        print('-' * 78)
        print('  档位                        回读(gpu侧)  strength  radius    factors(仅JS侧)')
        for tag, on, strength, factors, desc in CASES:
            await page.evaluate(SET_JS, [on, strength, factors])
            await settle(page, frames=3, min_ms=220)
            rb = await page.evaluate(READ_JS)      # ← settle 之后才回读（坑 119）
            name = f'{tag}.png'
            await shoot(page, os.path.join(SHOTS, name))
            print(f'  {tag:<26} enabled={str(rb.get("enabled")):<5} '
                  f'gpu={str(rb.get("strengthUniform")):<6} '
                  f'state={str(rb.get("strengthState")):<6} '
                  f'radius={rb.get("radiusUniform")}  '
                  f'{rb.get("factorsJSSide")}')
            print(f'      {desc}')
        print('-' * 78)
        print('  ★ 待量：`tools/check-bulge-shape.py shots/bz-*.png`')
        print('     a 应为「方」；d 应为「圆」。')
        print('     若 b / c 读成「圆」⇒ 方斑是泛光的**输出**（解释甲）。')
        print('     若 b / c 仍读成「方」⇒ 方斑是泛光这一步的**结构副作用**（解释乙）。')
        print('=' * 78)

        # 复位
        await page.evaluate(SET_JS, [True, 0.72, FACTORS_DEF])
        rb = await page.evaluate(READ_JS)
        print(f'  已复位：enabled={rb.get("enabled")} strength={rb.get("strengthUniform")} '
              f'factors={rb.get("factorsJSSide")}')

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

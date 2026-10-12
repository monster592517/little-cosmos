#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""视角按钮（`#level-nav`）能不能点 —— 全六层普查。

## 为什么这支探针必须「先把相机挪开再点」

直接点、然后看相机有没有动，**是一支不会响的判据**：
视角按钮的目标态往往就是相机的当前态（刚进这一层就是 `defaultView`），
于是「按钮好用」和「按钮死了」都读出「没动」—— 分不开。

所以每次点击前先**暴力把相机挪走**（`position *= 1.55` 再加个纵向偏移），
再点按钮。**点得动的按钮必须把相机拉回预设位置**，位移会是数量级级别的。
判据两段：位移 ≈ 0 ⇒ 死；位移大 **且** 终点贴着预设 ⇒ 活。

## 为什么它同时是「改前/改后」的同一支尺子

本轮要修的故障是：`tweenTo()` **只定义在 `solar.js` 里**，基类 `Level` 没有；
而 `main.js::setView()` 对**所有层级**都调 `lv.tweenTo(view)`。
⇒ solar 之外的 5 层，**每一个视角按钮**都在事件处理器里抛
`TypeError: lv.tweenTo is not a function`，被浏览器吞掉，表现为「点了没反应」。

太阳系那 5 个按钮是**天然的阳性对照**：它们走 solar 自己的 `tweenTo`，
改前就该是活的。**改前：solar 活、其余 5 层死；改后：6 层全活。**
—— 这两组数一对比，既证明了故障存在，也证明了修法有效。

用法：
    py -3.13 -X utf8 tools/probe-view-buttons.py
产出：终端表格（外层重定向到 `shots/_view-buttons.log`）
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

LEVELS = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe']

CATCH_JS = r"""
() => {
  if (window.__catchInstalled) return false;
  window.__catchInstalled = true;
  window.__pageErrors = [];
  window.addEventListener('unhandledrejection', (e) => {
    window.__pageErrors.push({ kind: 'unhandledrejection',
      msg: String((e.reason && (e.reason.message || e.reason)) || e.reason) });
  });
  window.addEventListener('error', (e) => {
    window.__pageErrors.push({ kind: 'error', msg: String(e.message || '') });
  });
  return true;
}
"""

# 按钮清单 + 相机挪开前的状态
SURVEY_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const btns = [...document.querySelectorAll('#level-nav button[data-view]')].map(b => ({
    view: b.dataset.view, name: b.textContent.trim(),
    active: b.classList.contains('active'),
    hasTweenTo: typeof lv.tweenTo === 'function',
  }));
  return {
    level: lv.id, n: btns.length, btns,
    cam: lv.camera.position.toArray().map(v => +v.toFixed(4)),
    preset: (lv.defaultView() || {}).position || null,
  };
}
"""

# ★ 把相机挪开：不点任何按钮，直接改相机。判据要会响，这一步不能省。
MOVE_AWAY_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  lv._tween = null; lv._viewTween = null;        // 清掉可能还在跑的过渡
  const p = lv.camera.position;
  const len = p.length() || 1;
  p.multiplyScalar(1.55);
  p.y += len * 0.42;
  lv.camera.lookAt(0, 0, 0);
  if (lv.controls) { lv.controls.target.set(0, 0, 0); lv.controls.enabled = true; lv.controls.update(); }
  lv.camera.updateProjectionMatrix();
  return { after: p.toArray().map(v => +v.toFixed(4)) };
}
"""

AFTER_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const btn = document.querySelector('#level-nav button[data-view]');
  return {
    cam: lv.camera.position.toArray().map(v => +v.toFixed(4)),
    preset: (lv.defaultView() || {}).position || null,
    active: [...document.querySelectorAll('#level-nav button[data-view].active')].map(b => b.dataset.view),
    tweenLive: !!lv._tween || !!lv._viewTween,
  };
}
"""


async def settle(page, frames=3, min_ms=0):
    if min_ms:
        await page.wait_for_timeout(min_ms)
    try:
        await page.evaluate("""(n) => new Promise(res => {
          let i = 0; const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        })""", frames)
    except Exception:
        pass


def dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


async def main():
    srv = ServedCheck(tag='视角按钮探针')
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
        page.on('pageerror', lambda e: emit(f'  ! pageerror: {str(e)[:170]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.evaluate(CATCH_JS)
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=60000)
        await page.wait_for_timeout(2500)
        emit(f'  后端 {backend}')

        print('\n' + '=' * 104)
        print('  视角按钮普查：先把相机挪开 → 点按钮 → 看相机有没有被拉回预设')
        print('=' * 104)
        print(f'  {"层级":<14}{"视角按钮":<12}{"层的 tweenTo":<12}'
              f'{"挪开后位移":<12}{"点击后位移":<12}{"离预设残差":<12}{"残差/挪开":<11}{"active":<10}判据')
        rows = []
        for lv in LEVELS:
            try:
                await page.evaluate(f'window.__universe.gotoScale("{lv}")')
                await page.wait_for_function(
                    f"window.__universe.engine.current?.id === '{lv}'", timeout=40000)
            except Exception as e:
                print(f'  {lv:<14}<进不去这一层：{type(e).__name__}>')
                continue
            await settle(page, frames=3, min_ms=900)

            sv = await page.evaluate(SURVEY_JS)
            if not sv['n']:
                print(f'  {lv:<14}(无视角按钮)')
                continue
            n_err0 = await page.evaluate('window.__pageErrors.length')
            before = await page.evaluate(MOVE_AWAY_JS)
            await settle(page, frames=3, min_ms=260)
            moved0 = dist(before['after'], sv['cam'])

            await page.evaluate("""() => {
              const b = document.querySelector('#level-nav button[data-view]');
              if (b) b.click();
            }""")
            await page.wait_for_timeout(2000)          # 留足 1.1s 过渡 + 余量
            after = await page.evaluate(AFTER_JS)
            moved1 = dist(after['cam'], before['after'])
            resid = dist(after['cam'], after['preset']) if after['preset'] else float('nan')
            rel = resid / moved0 if moved0 > 1e-9 else float('nan')
            new_err = await page.evaluate(f'window.__pageErrors.slice({n_err0})')

            n_btn = sv['n']
            first = sv['btns'][0]
            hasTween = first['hasTweenTo']
            # ⚠️ 判据必须是**相对量**（`残差 / 挪开量`），不能用绝对残差。
            #
            # 第一版写成 `resid < 1e-3`，结果**把阳性对照 solar 判成了死**
            # ——它残差 0.645（AU 单位、视距 16.4 AU，即 ~4%）。
            # 那 0.645 不是「没回位」，是 OrbitControls 的 `enableDamping`
            # 在 `controls.update()` 时把相机从精确的插值位姿上带偏了一点点。
            # ⇒ 每个层级的长度单位都不一样（AU / ly / kly / Mly / Gly），
            #   **绝对阈值跨层级根本没有可比性**；比值才有。
            # ⇒ 实测这个比值是**双峰**的：活的 0.049，死的 1.00–1.05，差 20 倍。
            # 顺带：`点击后位移` 只能当参考，**不能当判据** ——
            # `controls.autoRotate` 一直在转，按钮死了相机也会慢慢挪。
            verdict = '✓ 活' if rel < 0.2 else '✗ **死**'
            print(f'  {lv:<14}{f"{first["name"]}({n_btn}个)":<12}{str(hasTween):<12}'
                  f'{moved0:<12.4f}{moved1:<12.4f}{resid:<12.5f}{rel:<11.4f}'
                  f'{",".join(after["active"]):<10}{verdict}')
            for e in new_err[:2]:
                print(f'        ! [{e.get("kind")}] {str(e.get("msg"))[:120]}')
            rows.append((lv, moved0, moved1, resid, rel))

            await page.screenshot(path=os.path.join(SHOTS, f'vb-{lv}.png'))

        print('=' * 104)
        ok = sum(1 for r in rows if r[4] < 0.2)
        print(f'  汇总：{ok} / {len(rows)} 个层级的视角按钮是活的')
        print('  判据：「离预设残差 / 挪开量」< 0.2 ⇒ 活；否则死。')
        print('        （活的实测 0.049，死的 1.00–1.05 —— 双峰，没有灰色地带。）')
        print('  ⚠ solar 是**阳性对照**：改前它自己定义了 tweenTo，是唯一该活的一层。')
        errs = await page.evaluate('window.__pageErrors')
        print(f'\n  页面累计未处理错误 {len(errs)} 条：')
        for e in errs[:10]:
            print(f'    · [{e.get("kind")}] {str(e.get("msg"))[:140]}')
        print('=' * 104)

        sys.stdout.flush()
        # 收工关服务由 `main()` 的 `finally` 负责 —— 这里曾误写成 `srv.stop()`，
        # 而 `srv` 是 `main()` 里的局部变量，于是**报告已经全部打完**之后才抛
        # `NameError`，把一个成功的测量伪装成崩溃（尾部长一段 traceback）。
        # 教训：结论正确不等于脚本干净；退出码也会骗人。
        arm_hard_exit(14, 0)
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except Exception as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘，由看门狗收尾）：{type(e).__name__}')
    return 0


if __name__ == '__main__':
    arm_hard_exit(600, 3)
    try:
        code = asyncio.run(main())
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 0
    sys.exit(code or 0)

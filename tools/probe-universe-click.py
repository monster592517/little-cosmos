#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「宇宙全景（可观测宇宙）点不了了」的活体探针 —— 找出**哪一条静默路径**在吞掉这次点击。

## 为什么不能靠读代码下结论

读代码只能知道「有可能失败」，不能知道「这次是哪种失败」。`gotoScale()` 里至少有
三条路会**静默**结束，症状长得一模一样（点了没反应）：

    ① `levels.has(id)` 为假      → 有 toast，**不静默**，排除掉不算数
    ② `goTo()` 里 `seq !== _navSeq` → 连点两次时前一次被后一次顶掉，`return false`
    ③ `ensureBuilt()` **抛异常**   → `await` 直接 reject；`nav.js:34` 只调不 await
                                    ⇒ 未处理的 Promise 拒绝，页面上**一个像素都不动**

②③ 从**用户视角完全无法区分**：都是"点了没用"。
⇒ 这一轮不猜，把 `goTo` 包一层记录器，把**返回值**和**抛没抛**都留下来。

## 仪器必须先自证（否则又是一次假绿）

「universe 点不动」如果是**探针自己不会点**造成的，比不测更坏。
所以本脚本先点一个**已知能用的**按钮（邻近恒星系 / 银河系）作阳性对照：
**对照点得动、可疑点点不动**，才说明"点不动"是真的。两个都点不动 = 探针坏了。

## 额外查一件 CSS 可能：按钮是不是被别的东西盖住了

`elementFromPoint(按钮中心)` 返回的不是按钮本身 ⇒ 有元素抢走了点击。
这一条与 ②③ 的表现同样无法用肉眼区分，但**修法完全不同**。

用法：
    py -3.13 -X utf8 tools/probe-universe-click.py
产出：`shots/uc-*.png` + 终端报告（外层重定向到 `shots/_universe-click.log`）
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


# ---------------------------------------------------------------------------
# 装记录器：`goTo` 的返回值 / 异常，以及页面上所有未处理的错误
# ---------------------------------------------------------------------------
INSTALL_JS = r"""
() => {
  const app = window.__universe;
  const eng = app.engine;
  window.__goToLog = [];
  window.__pageErrors = [];
  window.__navToasts = [];
  if (!eng.__wrapped) {
    const orig = eng.goTo.bind(eng);
    eng.goTo = async function (id, opts) {
      const rec = { id, t0: performance.now(), state: 'called' };
      window.__goToLog.push(rec);
      try {
        const r = await orig(id, opts);
        rec.state = 'returned';
        rec.value = r;
      } catch (e) {
        rec.state = 'threw';
        rec.err = String((e && e.message) || e);
      }
      rec.ms = Math.round(performance.now() - rec.t0);
      return rec.value;
    };
    eng.__wrapped = true;
  }
  // gotoScale 自身也包一层：它有没有被调用、返回什么
  if (!app.__gsWrapped) {
    const org = app.gotoScale.bind(app);
    app.gotoScale = async function (id) {
      const rec = { kind: 'gotoScale', id, t0: performance.now() };
      window.__goToLog.push(rec);
      try {
        const r = await org(id);
        rec.state = 'returned'; rec.value = r;
      } catch (e) {
        rec.state = 'threw'; rec.err = String((e && e.message) || e);
      }
      rec.ms = Math.round(performance.now() - rec.t0);
      return rec.value;
    };
    app.__gsWrapped = true;
  }
  return { wrapped: true, hasScaleBar: !!document.getElementById('scale-nav') };
}
"""

CATCH_JS = r"""
() => {
  if (window.__catchInstalled) return false;
  window.__catchInstalled = true;
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

# 按钮体检：几何 + 计算样式 + 谁在按钮中心
SURVEY_JS = r"""
() => {
  const el = document.getElementById('scale-nav');
  const out = { nav: null, buttons: [] };
  if (el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.nav = { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
                display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents,
                opacity: cs.opacity, zIndex: cs.zIndex, childCount: el.children.length };
  }
  for (const b of document.querySelectorAll('#scale-nav button[data-scale]')) {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const hit = (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight)
      ? document.elementFromPoint(cx, cy) : null;
    out.buttons.push({
      scale: b.dataset.scale,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      pointerEvents: cs.pointerEvents, display: cs.display,
      disabled: !!b.disabled,
      active: b.classList.contains('active'),
      hitTag: hit ? (hit.tagName + (hit.id ? '#' + hit.id : '') +
        (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\s+/).join('.') : '')) : null,
      hitIsSelfOrChild: hit ? (hit === b || b.contains(hit)) : null,
    });
  }
  return out;
}
"""

STATE_JS = r"""
() => ({
  current: window.__universe.engine.current?.id || null,
  crumb: (document.getElementById('crumb')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
  active: [...document.querySelectorAll('#scale-nav button[data-scale].active')].map(b => b.dataset.scale),
  toast: [...document.querySelectorAll('#toast .toast')].map(t => t.textContent),
  built: [...window.__universe.engine.levels.entries()].map(([k, v]) => k + '=' + !!v.built),
})
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


async def click_and_watch(page, scale, wait_s=30.0):
    """真点按钮（不是调函数）—— 用户点的是按钮，探针就得点按钮。"""
    before = await page.evaluate(STATE_JS)
    n0 = await page.evaluate("window.__goToLog.length")
    await page.evaluate("""(s) => {
      const b = document.querySelector(`#scale-nav button[data-scale="${s}"]`);
      if (b) b.click(); else window.__pageErrors.push({kind:'noButton', msg:s});
    }""", scale)
    # 等 current 变（或超时）
    changed = True
    try:
        await page.wait_for_function(
            f"window.__universe.engine.current?.id === '{scale}'", timeout=wait_s * 1000)
    except Exception:
        changed = False
    await settle(page, frames=3, min_ms=700)
    after = await page.evaluate(STATE_JS)
    log = await page.evaluate(f"window.__goToLog.slice({n0})")
    await page.screenshot(path=os.path.join(SHOTS, f'uc-{scale}.png'))
    return before, after, log, changed


async def main():
    # ⚠️ `srv` 必须是**全局**：`run()` 收尾那句 `srv.stop()`（坑 122）
    global srv
    srv = ServedCheck(tag='宇宙全景点击探针')
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
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! console: {m.text[:170]}'))
        page.on('pageerror', lambda e: emit(f'  ! pageerror: {str(e)[:170]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.evaluate(CATCH_JS)                     # ← 必须在 boot 之前装（boot 是 async）
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=60000)
        await page.wait_for_timeout(2500)
        inst = await page.evaluate(INSTALL_JS)
        emit(f'  后端 {backend} · 记录器 {inst}')
        emit(f'  已注册层级：{await page.evaluate("window.__universe.engine.levels.size")} 个')

        # ---------------- ① 按钮体检 ----------------
        print('\n' + '=' * 96)
        print('  ① 尺度条按钮体检（谁在按钮中心？pointer-events 被谁关了？）')
        print('-' * 96)
        sv = await page.evaluate(SURVEY_JS)
        print(f'  #scale-nav  {sv["nav"]}')
        print(f'  {"按钮":<16}{"位置/尺寸":<26}{"pe":<10}{"hit 命中的元素":<34}{"是自己吗":<10}')
        for b in sv['buttons']:
            rect = ','.join(str(v) for v in b['rect'])
            print(f'  {b["scale"]:<16}{rect:<26}{b["pointerEvents"]:<10}'
                  f'{str(b["hitTag"])[:32]:<34}{str(b["hitIsSelfOrChild"]):<10}')
        print('=' * 96)

        # ---------------- ② 点击序列（含阳性对照） ----------------
        print('\n' + '=' * 96)
        print('  ② 点击序列 —— 对照先点得动，才说明「点不动」是真的')
        print('-' * 96)
        seq = ['neighborhood', 'galaxy', 'supercluster', 'universe', 'localgroup', 'universe']
        for i, scale in enumerate(seq, 1):
            before, after, log, changed = await click_and_watch(page, scale)
            tag = '对照' if i <= 2 else '可疑'
            print(f'  [{i}] 点「{scale}」({tag})  before={before["current"]:<13}'
                  f'after={after["current"]:<13} 变成目标={changed}')
            for r in log:
                if r.get('kind') == 'gotoScale':
                    print(f'        gotoScale({r["id"]}) -> state={r.get("state")} '
                          f'value={r.get("value")} err={r.get("err")} {r.get("ms")}ms')
                else:
                    print(f'        goTo({r["id"]})      -> state={r.get("state")} '
                          f'value={r.get("value")} err={r.get("err")} {r.get("ms")}ms')
            if not log:
                print('        ⚠ 一次 goTo/gotoScale 都没被调用 ⇒ 点击根本没传到处理器')
            print(f'        crumb: {after["crumb"]}')
            if after['toast']:
                print(f'        toast: {after["toast"]}')
            print(f'        built: {after["built"]}')
        print('=' * 96)

        # ---------------- ③ 未处理的错误 ----------------
        errs = await page.evaluate('window.__pageErrors')
        print('\n' + '=' * 96)
        print(f'  ③ 页面未处理错误：{len(errs)} 条')
        for e in errs[:14]:
            print(f'    · [{e.get("kind")}] {str(e.get("msg"))[:150]}')
        if len(errs) > 14:
            print(f'    …还有 {len(errs) - 14} 条')
        print('=' * 96)

        # ---------------- ④ 直接调用（绕开按钮） ----------------
        print('\n' + '=' * 96)
        print('  ④ 绕开按钮直接调用 gotoScale —— 分离「按钮坏了」与「goTo 坏了」')
        print('-' * 96)
        for scale in ['universe', 'supercluster']:
            n0 = await page.evaluate('window.__goToLog.length')
            try:
                r = await page.evaluate(f'window.__universe.gotoScale("{scale}")')
            except Exception as e:
                r = f'<JS 抛了：{type(e).__name__}: {str(e)[:120]}>'
            await settle(page, frames=3, min_ms=900)
            log = await page.evaluate(f'window.__goToLog.slice({n0})')
            st = await page.evaluate(STATE_JS)
            print(f'  gotoScale("{scale}") => {r}    结果是 current={st["current"]}')
            for rec in log:
                print(f'      {rec.get("kind") or "goTo"}({rec.get("id")}) '
                      f'state={rec.get("state")} value={rec.get("value")} err={rec.get("err")}')
        print('=' * 96)

        errs = await page.evaluate('window.__pageErrors')
        print(f'\n  收尾：累计未处理错误 {len(errs)} 条')

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
    try:
        code = asyncio.run(main())
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 0
    sys.exit(code or 0)

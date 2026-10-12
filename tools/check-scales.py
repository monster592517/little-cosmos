#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多尺度层级回归测试：加载页面 → 逐个进入六个尺度层级 → 跨尺度搜索 → 切画质档位 → 截图。

进度可见性说明（重要）
----------------------
这个脚本跑在 SwiftShader 软件渲染上，单个层级的过渡就可能要 3~6 秒真实时间，
全程几分钟很正常。为了让「正常地慢」不被误判成「卡死」，做了三件事：

  1. 每一行输出都 flush，并且**同时追加写入 shots/scale-test.log**——
     即使进程被外部杀掉，已经跑过的部分也不会丢。
  2. 每个阶段开始前先打印「[n/N] 阶段名」，结束时打印耗时。
  3. 等层级切换时每 2 秒打一个点，肉眼能确认它还活着。

用法：
    py -3.13 -X utf8 tools/check-scales.py [选项]

选项：
    --url=URL               用已有的服务（不给就**自己拉起一个空闲端口**，跑完自己关）
    --keep                  跑完不关服务（调试用）
    --levels=a,b,c          只测指定层级（如 --levels=solar,galaxy），做快速冒烟
    --level-timeout=MS      单层等待上限（默认 40000）
    --shots                 顺便截图
    --no-log                不写 shots/scale-test.log

⚠ 自管服务这件事是有来历的：这脚本原先写死「假设 8791 上已经有人开着服务」，
  于是它**平时从来没被跑过**；真被跑一次时输出一屏 `ERR_CONNECTION_REFUSED`，
  看着像一堆真实故障，其实一个都不是（同款问题也坑过 check-http.py）。
  **一个默认跑不过的检查等于没有检查**，所以统一改成自管（见 serve_for_checks.py）。
"""
import asyncio
import json
import os
import sys
import time

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck            # noqa: E402  自管服务的共用助手

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
URL = None                       # None = 没给 --url，由本脚本自己拉起服务
KEEP = '--keep' in sys.argv
WANT_SHOTS = '--shots' in sys.argv
WANT_LOG = '--no-log' not in sys.argv
LEVEL_TIMEOUT = 40000

for a in sys.argv[1:]:
    if a.startswith('--url='):
        URL = a[6:]
    elif a.startswith('--level-timeout='):
        LEVEL_TIMEOUT = int(a.split('=', 1)[1])

ALL_SCALES = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe']
SCALES = ALL_SCALES
for a in sys.argv[1:]:
    if a.startswith('--levels='):
        want = [s.strip() for s in a.split('=', 1)[1].split(',') if s.strip()]
        bad = [s for s in want if s not in ALL_SCALES]
        if bad:
            sys.stderr.write(f'未知层级：{bad}（可选：{", ".join(ALL_SCALES)}）\n')
            sys.exit(2)
        SCALES = want

errors: list[str] = []
warnings: list[str] = []
results: list[tuple] = []
T0 = time.monotonic()
_logf = None


def el() -> float:
    return time.monotonic() - T0


def emit(msg: str = '', end: str = '\n') -> None:
    """所有输出都走这里：flush 到终端 + 追加刷到日志文件。"""
    sys.stdout.write(msg + end)
    sys.stdout.flush()
    if _logf:
        _logf.write(msg + end)
        _logf.flush()


def ok(name: str, passed: bool, detail: str = '') -> bool:
    emit(f'  {"✓" if passed else "✗"} {name}{" — " + detail if detail else ""}')
    if not passed:
        errors.append(f'{name}：{detail}' if detail else name)
    return passed


async def run_phase(n: int, total: int, name: str, coro_fn) -> None:
    """执行一个阶段：先声明，再执行，最后报耗时。单阶段异常不中断全程。"""
    emit(f'\n[{n}/{total}] {name}  ·  已跑 {el():.0f}s')
    t = time.monotonic()
    try:
        await coro_fn()
        emit(f'      ✓ {time.monotonic() - t:.1f}s')
    except Exception as e:
        emit(f'      ✗ {time.monotonic() - t:.1f}s · {type(e).__name__}: {e}')
        errors.append(f'阶段「{name}」异常：{type(e).__name__}: {e}')


async def wait_level(page, want: str, timeout_ms: int = None, label: str = '') -> tuple[bool, float]:
    """等引擎真正切到目标层级。

    不能用固定 sleep —— 软件渲染下过渡帧率很低，而引擎的过渡进度按每帧 dt 累加
    （上限 0.1s/帧），1.05s 的过渡在低帧率下可能要 3~6 秒真实时间。

    这里改成轮询 + 心跳点：每 2 秒打一个「·」，让人看得出它在等而不是死了。
    """
    timeout_ms = timeout_ms or LEVEL_TIMEOUT
    t0 = time.monotonic()
    deadline = t0 + timeout_ms / 1000.0
    last_beat = t0
    dots = 0
    while time.monotonic() < deadline:
        try:
            cur = await page.evaluate("window.__universe.engine.current?.id")
        except Exception:
            cur = None
        if cur == want:
            if dots:
                emit('')          # 只收尾换行；耗时由调用方在结果行里报，避免把点行拼得难读
            return True, time.monotonic() - t0
        await page.wait_for_timeout(250)
        now = time.monotonic()
        if now - last_beat >= 2.0:
            emit('      · 等待层级切换' if dots == 0 else '·', '')
            dots += 1
            last_beat = now
    if dots:
        emit('')            # 超时同样要收尾，否则日志会缺一个换行
    return False, time.monotonic() - t0


async def main() -> int:
    global _logf, URL
    os.makedirs(SHOTS, exist_ok=True)
    if WANT_LOG:
        _logf = open(os.path.join(SHOTS, 'scale-test.log'), 'w', encoding='utf-8')

    emit(f'=== 小小宇宙 · 多尺度回归 ===')
    srv = ServedCheck(url=URL, keep=KEEP, tag='本脚本')
    try:
        URL = srv.start() + '/'      # 后面各处按「带尾斜杠」的完整地址用
    except Exception as e:
        emit(f'✗ {e}')
        if _logf:
            _logf.close()
        return 1
    emit(f'层级 {SCALES}  ·  单层等待上限 {LEVEL_TIMEOUT}ms  ·  截图 {"开" if WANT_SHOTS else "关"}')
    emit(f'开始时间 {time.strftime("%Y-%m-%d %H:%M:%S")}')

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])

        async def p_boot():
            page0 = await browser.new_page(viewport={'width': 1600, 'height': 900})
            main.page = page0
            page0.on('console', lambda m: (errors.append(m.text) if m.type == 'error' else None,
                                           warnings.append(m.text) if m.type == 'warning' else None))
            # 页面里未捕获的异常：**带上调用栈**。
            # 只记 message 的话，「hex.replace is not a function」这种报错会告诉你"什么错了"
            # 却不告诉你"谁调的"——25 条一样的信息等于 0 条信息。
            page0.on('pageerror', lambda e: errors.append(
                'PAGEERROR: ' + str(e) + ('\n    ' + str(getattr(e, 'stack', '') or '').replace('\n', '\n    ')
                                          if getattr(e, 'stack', None) else '')))
            emit(f'  → 打开 {URL}')
            await page0.goto(URL, wait_until='load', timeout=60000)
            try:
                await page0.wait_for_function(
                    "document.getElementById('boot').style.display === 'none'", timeout=60000)
                emit('  ✓ 启动完成（首次要解析 1.3 万条深空目录，慢是正常的）')
            except Exception:
                status = await page0.text_content('#boot-status')
                emit(f'  ✗ 启动超时，界面停在：{status}')
                errors.append(f'BOOT TIMEOUT: {status}')

        total = 8
        await run_phase(1, total, '启动与页面加载', p_boot)
        page = getattr(main, 'page', None)
        if page is None:
            emit('\n没有可用的页面，后续阶段全部跳过。')
            if _logf:
                _logf.close()
            return 1

        async def p_state():
            info = await page.evaluate("""() => {
              const a = window.__universe;
              if (!a || !a.engine) return { ok: false };
              return {
                ok: true,
                levels: [...a.engine.levels.keys()],
                current: a.engine.current?.id,
                tier: a.engine.tier?.id,
                tierLabel: a.engine.tier?.label,
                gpuKind: a.gpu?.gpu?.kind,
                gpuShort: a.gpu?.gpuShort,
                preference: a.gpu?.preference,
                powerPref: a.engine.gpu?.powerPreference,
                bodies: a.dataset.bodies.size,
                index: a.dataset.index.length,
                catalogTop: a.dataset.catalog.length,
                deepSky: a.dataset.deepSky.length,
                deepSkyPlaced: a.dataset.deepSkyPlaced?.length ?? 0,
                overridesApplied: a.dataset.overridesApplied?.length ?? 0,
                overridesFailed: a.dataset.overridesFailed?.length ?? 0,
                scaleButtons: document.querySelectorAll('#scale-nav button[data-scale]').length,
                viewButtons: document.querySelectorAll('#level-nav button').length,
              };
            }""")
            emit('  ' + json.dumps(info, ensure_ascii=False, indent=2).replace('\n', '\n  '))
            if info.get('levels') and len(info['levels']) != 6:
                errors.append(f"层级数应为 6，实际 {len(info.get('levels', []))}")
            if info.get('current') != 'solar':
                errors.append(f"初始层级应为 solar，实际 {info.get('current')}")
            if info.get('overridesFailed'):
                warnings.append(f"有 {info['overridesFailed']} 条人工修正未能应用，见控制台")

        await run_phase(2, total, '引擎与层级状态', p_state)

        async def p_levels():
            for i, sid in enumerate(SCALES):
                emit(f'  [{i + 1}/{len(SCALES)}] 进入 {sid}  …')
                await page.evaluate(f"window.__universe.gotoScale('{sid}')")
                reached, waited = await wait_level(page, sid, label=sid)
                await page.wait_for_timeout(350)
                cur = await page.evaluate("window.__universe.engine.current?.id")
                scale_label = await page.text_content('#scalebar')
                crumb = await page.text_content('#crumb')
                good = cur == sid and reached
                results.append((sid, cur, good))
                mark = '✓' if good else '✗'
                emit(f'      {mark} current={cur} · 视野={scale_label!r} · 等待 {waited:.1f}s')
                if not good:
                    errors.append(f'进入 {sid} 后 current 是 {cur}')
                if WANT_SHOTS:
                    await page.screenshot(path=os.path.join(SHOTS, f'scale-{i}-{sid}.png'))
                n = await page.evaluate("window.__universe.engine.current?.labels?.items?.size ?? 0")
                emit(f'      标签 {n} 个 · 面包屑 {crumb[:40] if crumb else ""!r}')

        await run_phase(3, total, f'逐层进入（{len(SCALES)} 层）', p_levels)

        async def p_colors():
            """贴图生成的颜色解析必须**零失败**。

            为什么单列一条：`hexToRgb()` 收到非字符串 / 非 hex 时，早先是直接抛
            `TypeError: hex.replace is not a function`（整个层级 build 挂掉、
            页面刷几十条 PAGEERROR、WebGL 上下文跟着丢）；
            修成容错之后它改成返回中性灰——**不报了，图却悄悄变黑**。
            两种都不能不管，所以判据落在**计数**上：解析失败数必须为 0。

            真实案例：`cie.blackbodyToHex()` 返回对象 `{hex, rgb}`，
            被当成字符串喂进 `makeGlowTexture()`，25 条 PAGEERROR。
            """
            try:
                fails = await page.evaluate(
                    "async () => (await import('/js/proc/textures.js')).colorParseFailures()")
            except Exception as e:
                fails = None
                emit(f'  ⚠ 取不到颜色解析失败计数：{type(e).__name__}: {e}')
            if fails is None:
                ok('贴图颜色解析', False, '计数接口取不到（模块路径变了？）')
                errors.append('COLOR PARSE: 取不到 colorParseFailures()')
            else:
                ok('贴图颜色解析', not fails, f'解析失败 {len(fails)} 个'
                   + ('：' + '、'.join(fails[:6]) if fails else ''))
                if fails:
                    errors.append(f'COLOR PARSE FAILURES: {fails[:6]}')

        await run_phase(4, total, '贴图颜色口径', p_colors)

        async def p_release():
            if 'universe' not in SCALES:
                emit('  本次未包含 universe 层，跳过（用 --levels 加回来即可）')
                return
            await page.evaluate("window.__universe.gotoScale('universe')")
            await wait_level(page, 'universe')
            await page.wait_for_timeout(600)
            built = await page.evaluate(
                "Object.fromEntries([...window.__universe.engine.levels].map(([k,v]) => [k, v.built]))")
            resident = [k for k, v in built.items() if v]
            emit(f'  universe 层常驻的层级：{resident}')
            for k in ['solar', 'neighborhood', 'galaxy']:
                if built.get(k):
                    errors.append(f'层级 {k} 走远后应被卸载，但仍常驻显存')
            if not built.get('universe'):
                errors.append('当前层级 universe 不应被卸载')
            await page.evaluate("window.__universe.gotoScale('solar')")
            await wait_level(page, 'solar')
            await page.wait_for_timeout(400)
            n = await page.evaluate("window.__universe.engine.current?.labels?.items?.size ?? 0")
            ok('回到太阳系后重建', n > 100, f'标签 {n} 个')

        await run_phase(5, total, '层级显存回收', p_release)

        async def p_search():
            for q, _lv in [('天狼星', 'neighborhood'), ('M31', 'localgroup'),
                           ('猎户', 'galaxy'), ('拉尼亚凯亚', 'supercluster'), ('木卫二', 'solar')]:
                hits = await page.evaluate(
                    f"window.__universe.dataset.search('{q}', 6)"
                    ".map(x => x.id + '|' + x.name + '|' + x.level)")
                emit(f'  "{q}" → {hits[:3]}')
                if not hits:
                    warnings.append(f'搜索 "{q}" 无结果')

        await run_phase(6, total, '跨尺度搜索与跳转', p_search)

        async def p_tier():
            for tier in ['high', 'balanced', 'saver']:
                await page.evaluate(f"""() => {{
                  window.__universe.gpu.setTier('{tier}');
                  window.__universe.engine.applyTier('{tier}');
                }}""")
                # 等久一点：不仅要看切换是否生效，还要确认「自动降档」不会把用户的
                # 手动选择覆盖掉（这是回归测试的重点）
                await page.wait_for_timeout(1500)
                got = await page.evaluate("window.__universe.engine.tier?.id")
                dpr = await page.evaluate("window.__universe.engine.renderer.getPixelRatio()")
                bloom = await page.evaluate("window.__universe.engine.options.bloom")
                pinned = await page.evaluate("window.__universe.gpu.tierPinned")
                ok(f'档位 {tier}', got == tier,
                   f'tier={got} dpr={dpr} bloom={bloom} 已锁定={pinned}')
            await page.evaluate("window.__universe.gpu.resetAuto()")
            await page.wait_for_timeout(300)
            pinned = await page.evaluate("window.__universe.gpu.tierPinned")
            pref = await page.evaluate("window.__universe.gpu.preference")
            ok('恢复自动适配', (not pinned) and pref == 'auto', f'偏好={pref} 已锁定={pinned}')

        await run_phase(7, total, '画质档位与设置面板', p_tier)

        async def p_wheel():
            await page.click('#btn-settings')
            await page.wait_for_timeout(500)
            has = await page.evaluate("""() => ({
              pref: !!document.querySelector('#set-gpu-pref'),
              tier: !!document.querySelector('#set-tier'),
              pause: !!document.querySelector('#set-pause-hidden'),
              cap: !!document.querySelector('#set-framecap'),
              reset: !!document.querySelector('#set-gpu-reset'),
              datacenter: !!document.querySelector('#set-datacenter'),
            })""")
            emit(f'  设置面板控件：{has}')
            for k, v in has.items():
                if not v:
                    errors.append(f'设置面板缺少 #{k}')
            if WANT_SHOTS:
                await page.screenshot(path=os.path.join(SHOTS, 'settings-gpu.png'))
            await page.click('#panel-close')

            await page.evaluate("window.__universe.gotoScale('solar')")
            await wait_level(page, 'solar')
            emit('  从太阳系一直往外滚 …')
            for _ in range(40):
                await page.mouse.wheel(0, 500)
                await page.wait_for_timeout(60)
            changed = False
            try:
                await page.wait_for_function(
                    "window.__universe.engine.current?.id !== 'solar'", timeout=25000)
                changed = True
            except Exception:
                pass
            cur = await page.evaluate("window.__universe.engine.current?.id")
            emit(f'  {"✓" if changed else "○"} 滚轮跨尺度 → {cur}')
            if not changed:
                warnings.append('滚轮到最后没有触发跨尺度切换（可能累计阈值偏高）')

        await run_phase(8, total, '设置面板与滚轮跨尺度', p_wheel)

        await browser.close()

    # ---- 汇总 ----
    emit('\n' + '=' * 60)
    emit(f'总用时 {el():.1f}s')
    emit(f'层级进入结果：{results}')
    emit(f'console 错误 {len(errors)} 条，警告 {len(warnings)} 条')
    for e in errors[:25]:
        emit('  ✗ ' + str(e))
    for w in warnings[:10]:
        emit('  ! ' + str(w))
    emit('=' * 60)
    srv.stop()
    if _logf:
        _logf.close()
    return 1 if errors else 0


try:
    CODE = asyncio.run(main())
except KeyboardInterrupt:
    emit('\n被中断（Ctrl+C）。已跑过的输出都在 shots/scale-test.log 里。')
    CODE = 130
except Exception as e:
    # 兜底：任何未预期异常也要把已跑的部分留在日志里，而不是静默消失
    emit(f'\n未预期异常：{type(e).__name__}: {e}')
    emit(f'已跑 {el():.1f}s。已跑过的输出都在 shots/scale-test.log 里。')
    CODE = 1
    if _logf:
        try:
            _logf.close()
        except Exception:
            pass

sys.exit(CODE)

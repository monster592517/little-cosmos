#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""浏览器端回归：数据更新中心 + 系统自检 + 日志查看器。

为什么单独写一个而不是并进 check-ui.py：那个脚本关心的是 3D 视角与目录树，
这个关心的是「面板里新挂的自检区块到底会不会炸」。混在一起，一边红了不知道是谁红。

用法：
    node server/server.mjs --port=8794     # 另开一个终端
    py -3.13 -X utf8 tools/check-datacenter-ui.py --port=8794
    py -3.13 -X utf8 tools/check-datacenter-ui.py --port=8794 --shots

判定口径（这几条才是真信号）：
  · 页面零 console error / pageerror —— 自检区块渲染时抛异常会在这里露头；
  · 六组自检卡片都渲染出来，且**每条 warn/error 都带「怎么办」** —— 这是自检的意义所在；
  · 日志查看器能读出真实记录行。

退出码：0 = 全通过。
"""
import asyncio
import os
import sys
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck            # noqa: E402  自管服务的共用助手

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
PORT = None                      # None = 没给 --port，由本脚本自己挑一个空闲端口
KEEP = '--keep' in sys.argv
for a in sys.argv:
    if a.startswith('--port='):
        PORT = a.split('=', 1)[1]
URL = ''
WANT_SHOTS = '--shots' in sys.argv

pass_n = 0
fail_n = 0


def ok(name, cond, extra=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
    else:
        fail_n += 1
    print(f'  {"OK " if cond else "FAIL"} {name}' + (f' -- {extra}' if extra else ''))


async def stable(page, n=4):
    for _ in range(n):
        await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')


async def main():
    global URL, PORT
    srv = ServedCheck(url=None, port=int(PORT) if PORT else None, keep=KEEP, tag='本脚本')
    try:
        URL = srv.start() + '/'
    except Exception as e:
        print(f'FAIL {e}')
        return 1
    errors = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 950})
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))

        print(f'打开 {URL}')
        try:
            await page.goto(URL, wait_until='networkidle', timeout=30000)
        except Exception as e:
            print(f'FAIL 页面打不开：{e}')
            await browser.close()
            sys.exit(1)
        await page.wait_for_timeout(2000)

        ok('页面有宇宙实例', await page.evaluate('Boolean(window.__universe)'))

        # ---- 打开数据更新中心 ----
        opened = await page.evaluate('''() => {
            const dc = window.__universe?.ui?.datacenter;
            if (!dc) return 'no-datacenter';
            dc.open();
            return 'ok';
        }''')
        ok('能调起数据更新中心', opened == 'ok', opened)
        try:
            await page.wait_for_selector('#dc-root', timeout=15000)
        except Exception:
            print('FAIL #dc-root 没出现，面板可能抛异常了')
            for e in errors[:10]:
                print('   -', e[:200])
            await browser.close()
            sys.exit(1)

        for sec in ['#dc-overview', '#dc-pipelines', '#dc-watch', '#dc-overrides', '#dc-detail', '#dc-selfcheck']:
            ok(f'区块存在 {sec}', await page.locator(sec).count() == 1)

        # ---- 自检：点了才跑 ----
        ok('自检初始未自动运行', await page.locator('#dc-sc-result .sc-item').count() == 0,
           '打开面板不跑自检，避免每次开面板都卡一下')

        await page.locator('.dc-selfcheck').click()
        try:
            await page.wait_for_selector('#dc-sc-result .sc-item', timeout=30000)
        except Exception:
            print('FAIL 自检没有出结果')
            for e in errors[:10]:
                print('   -', e[:200])
            await browser.close()
            sys.exit(1)

        items = await page.locator('#dc-sc-result .sc-item').count()
        ok('自检渲染出检查项', items >= 8, f'{items} 项')

        groups = await page.locator('#dc-sc-result .sc-group').count()
        ok('自检按组呈现', groups >= 5, f'{groups} 组')

        bad = await page.locator('#dc-sc-result .sc-item.warn, #dc-sc-result .sc-item.error').count()
        fixes = await page.locator('#dc-sc-result .sc-item.warn .sc-fix, #dc-sc-result .sc-item.error .sc-fix').count()
        ok('每条非通过项都带「怎么办」', bad == fixes, f'非通过 {bad} 项 / 带处置建议 {fixes} 条')

        stats = await page.locator('#dc-sc-result .dc-stat b').all_inner_texts()
        ok('顶部有通过/注意/故障计数', len(stats) == 3, ' / '.join(stats))

        # ---- 日志查看器 ----
        await page.locator('.dc-logview').click()
        try:
            await page.wait_for_selector('#dc-logview .log-view .log-row', timeout=15000)
        except Exception:
            print('FAIL 日志查看器没有读到记录')
            await browser.close()
            sys.exit(1)
        rows = await page.locator('#dc-logview .log-view .log-row').count()
        ok('日志查看器读出记录', rows >= 1, f'{rows} 行')

        levels = await page.locator('#dc-logview .log-view .log-lv').all_inner_texts()
        ok('日志行带级别标签', all(lv.strip() in ('DEBUG', 'INFO', 'WARN', 'ERROR') for lv in levels),
           '级别集合 ' + ','.join(sorted(set(l.strip() for l in levels))))

        # 收起再展开，确认不会叠两份
        await page.locator('.dc-logview').click()
        await page.wait_for_timeout(200)
        ok('日志面板可收起', not await page.locator('#dc-logview').is_visible())

        if WANT_SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            await page.locator('.dc-logview').click()
            await page.wait_for_timeout(400)
            await page.locator('#dc-sc-result').scroll_into_view_if_needed()
            await page.wait_for_timeout(300)
            await page.screenshot(path=os.path.join(SHOTS, 'dc-selfcheck.png'))
            print(f'  截图 → shots/dc-selfcheck.png')

        await stable(page)
        await browser.close()

    ok('全程零控制台错误', len(errors) == 0, f'{len(errors)} 条')
    for e in errors[:12]:
        print('   -', e[:220])

    print(f'\n{"OK" if not fail_n else "FAIL"} 通过 {pass_n} 项' + (f'，失败 {fail_n} 项' if fail_n else '，全部通过'))
    sys.exit(1 if fail_n else 0)


asyncio.run(main())

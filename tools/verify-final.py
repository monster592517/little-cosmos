#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""最终验收：加载 → 目录树 → 各视角 → 真实比例切换 → 探测器聚焦 → 面板画廊，全程收集控制台错误。"""
import asyncio, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
URL = 'http://127.0.0.1:8787/'


async def stable(page, n=6):
    for _ in range(n):
        await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')


async def main():
    errors, failed, checks = [], [], []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('requestfailed', lambda r: failed.append(r.url))
        await page.goto(URL, wait_until='networkidle')
        await page.wait_for_timeout(3000)
        await stable(page)
        checks.append(('标题', await page.title()))

        info = await page.evaluate("""() => {
          const a = window.__universe, e = a.engine.current;
          return { entries: e.entries.size, moons: e.moonPivots.length, orbits: e.orbitLines.length,
                   probeOrbits: e.probeOrbits.length, trails: e.probeTrails.length,
                   catalog: a.dataset.catalog.length, bodies: a.dataset.bodies.size,
                   index: a.dataset.index.length, gallery: Object.keys(a.dataset.gallery).length };
        }""")
        checks.append(('数据', str(info)))
        await page.screenshot(path=os.path.join(SHOTS, 'f1-太阳系全景.png'))

        await page.locator('#btn-catalog').click()
        await page.wait_for_timeout(900)
        rows = await page.locator('#catalog-body .cat-row').count()
        heads = await page.locator('#catalog-body .cat-head .ttl').all_inner_texts()
        checks.append(('左侧目录', f'{rows} 条可见 / 顶层 {len(heads)} 组: ' + ' · '.join(heads[:10])))
        await page.screenshot(path=os.path.join(SHOTS, 'f2-目录树.png'))

        for v, name in [('inner', 'f3-内行星'), ('outer', 'f4-外行星'), ('kuiper', 'f5-柯伊伯带')]:
            await page.locator(f'[data-view="{v}"]').first.click()
            await page.wait_for_timeout(2000)
            await stable(page)
            await page.screenshot(path=os.path.join(SHOTS, f'{name}.png'))
        checks.append(('视角', 'inner / outer / kuiper 已截图'))

        await page.locator('#btn-settings').click()
        await page.wait_for_timeout(700)
        ts = page.locator('#set-true')
        if await ts.count():
            await ts.first.check()
            await page.wait_for_timeout(2800)
            await stable(page)
            await page.screenshot(path=os.path.join(SHOTS, 'f6-真实比例.png'))
            await ts.first.uncheck()
            await page.wait_for_timeout(2800)
            checks.append(('真实比例', '切换往返无异常'))
        else:
            checks.append(('真实比例', '未找到开关'))
        await page.locator('#panel-close').click()
        await page.wait_for_timeout(500)

        for i, name in [('jupiter', 'f7-木星与朱诺号'), ('voyager1', 'f8-旅行者1号'), ('io', 'f9-木卫一与影像')]:
            await page.evaluate(f'window.__universe.gotoDestination({i!r})')
            await page.wait_for_timeout(2600)
            await stable(page)
            await page.screenshot(path=os.path.join(SHOTS, f'{name}.png'))
        checks.append(('聚焦', '木星 / 旅行者 1 号 / 木卫一 已截图'))

        await page.locator('#btn-research').click()
        await page.wait_for_timeout(2500)
        st = await page.locator('#rs-status').inner_text()
        checks.append(('研究面板', st.replace('\n', ' ')[:120]))
        await page.screenshot(path=os.path.join(SHOTS, 'f10-研究面板.png'))

        await browser.close()

    print('=== 验收结果 ===')
    for k, v in checks:
        print(f'  {k}: {v}')
    print(f'控制台错误: {len(errors)}  失败请求: {len([u for u in failed if "127.0.0.1" in u])}')
    for e in errors[:8]:
        print('   -', e[:200])


asyncio.run(main())

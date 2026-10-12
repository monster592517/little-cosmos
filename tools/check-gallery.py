#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查属性面板里的「真实影像」画廊：打开若干天体的面板并截图。"""
import asyncio, sys, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
URL = 'http://127.0.0.1:8787/'

async def main():
    ids = sys.argv[1:] or ['jupiter', 'io', 'pluto']
    errors = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        failed = []
        page.on('requestfailed', lambda r: failed.append(r.url))
        await page.goto(URL, wait_until='networkidle')
        await page.wait_for_timeout(3000)
        for i in ids:
            await page.evaluate(f'window.__universe.ui.info.show({i!r})')
            await page.wait_for_timeout(1500)
            n = await page.locator('#panel-body .gallery a').count()
            broken = await page.evaluate("""() => [...document.querySelectorAll('#panel-body .gallery img')]
                .filter(i => !i.complete || i.naturalWidth === 0).length""")
            print(f'{i}: 画廊 {n} 张，未加载 {broken}')
            await page.evaluate("document.getElementById('panel-body').scrollTop = 1e6")
            await page.wait_for_timeout(900)
            await page.screenshot(path=os.path.join(SHOTS, f'gallery-{i}.png'))
        await browser.close()
    bad = [u for u in failed if 'images/' in u]
    print('errors:', len(errors), '| failed image requests:', len(bad))
    for e in errors[:6]:
        print('  -', e[:200])
    for u in bad[:6]:
        print('  !', u)

asyncio.run(main())

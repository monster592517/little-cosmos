#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""浏览器端回归测试：加载页面、切换视角、点开目录树、打开天体面板、截图。

用法：py -3.13 -X utf8 tools/check-ui.py [--shots]
"""
import asyncio, json, sys, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
URL = 'http://127.0.0.1:8787/'

async def stable(page, n=6):
    for _ in range(n):
        await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')

async def main():
    want_shots = '--shots' in sys.argv
    errors, logs = [], []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('console', lambda m: (logs.append(f'{m.type}: {m.text}'),
                                      errors.append(m.text) if m.type == 'error' else None))
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        await page.goto(URL, wait_until='networkidle')
        await page.wait_for_timeout(2500)
        await stable(page)

        title = await page.title()
        views = await page.locator('.view-btn, [data-view]').count()
        print(f'标题: {title}')
        print(f'视角按钮: {views}')

        # 打开目录
        cat = page.locator('#btn-catalog, [data-act="catalog"]')
        if await cat.count():
            await cat.first.click()
            await page.wait_for_timeout(600)
            groups = await page.locator('#panel-body .cat-group').count()
            rows = await page.locator('#panel-body .cat-row').count()
            print(f'目录组: {groups}  可见条目: {rows}')
            heads = await page.locator('#panel-body .cat-head .ttl').all_inner_texts()
            print('顶层分组:', ' / '.join(heads[:12]))
            # 展开第一个行星组
            await page.locator('#panel-body .cat-head').nth(1).click()
            await page.wait_for_timeout(300)
            if want_shots:
                await page.screenshot(path=os.path.join(SHOTS, 'v-catalog.png'))
        else:
            print('未找到目录按钮')

        # 关闭面板，切换视角
        close = page.locator('#panel-close')
        if await close.count():
            await close.click()
        await page.wait_for_timeout(400)
        for v in ['outer', 'belt', 'kuiper']:
            btn = page.locator(f'[data-view="{v}"]')
            if await btn.count():
                await btn.first.click()
                await page.wait_for_timeout(1800)
                await stable(page)
                if want_shots:
                    await page.screenshot(path=os.path.join(SHOTS, f'v-{v}.png'))
        print('视角切换完成')

        await browser.close()
    print('控制台错误:', len(errors))
    for e in errors[:12]:
        print('  -', e[:220])

asyncio.run(main())

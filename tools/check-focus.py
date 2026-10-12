#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归：目录里点行星标题能选中；选中后天体全貌占屏比；着陆探测器取景与标记。"""
import asyncio, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
URL = 'http://127.0.0.1:8787/'


async def stable(page, n=6):
    for _ in range(n):
        await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')


async def main():
    errors, checks = [], []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(URL, wait_until='networkidle')
        await page.wait_for_timeout(3000)
        await stable(page)

        # 1) 目录里点「木星」标题 → 应该选中木星（打开属性面板 + 镜头移动）
        await page.locator('#btn-catalog').click()
        await page.wait_for_timeout(900)
        has = await page.locator('#panel-body .ttl[data-goto="jupiter"]').count()
        checks.append(('目录中木星标题可点', has == 1))
        if has:
            await page.locator('#panel-body .ttl[data-goto="jupiter"]').click()
            await page.wait_for_timeout(3000)
            await stable(page)
            title = await page.locator('#panel-title').inner_text()
            body = await page.locator('#panel-body').inner_text()
            checks.append(('点标题后面板', f'{title} / 含"木星"={("木星" in body)}'))
            ratio = await page.evaluate("""() => {
              const lv = window.__universe.engine.current;
              const e = lv.entries.get('jupiter');
              const d = lv.camera.position.distanceTo(e.group.position);
              const wpp = lv.worldPerPixel(d);
              return +(2 * e.r / wpp / window.innerHeight).toFixed(3);
            }""")
            checks.append(('木星全貌占屏比（高）', ratio))
            await page.screenshot(path=os.path.join(SHOTS, 'fix-目录选行星.png'))

        # 2) 逐个选中行星/矮行星，检查全貌占屏比
        ratios = {}
        for i in ['mercury', 'earth', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'ceres']:
            await page.evaluate(f'window.__universe.gotoDestination({i!r})')
            await page.wait_for_timeout(2400)
            await stable(page)
            r = await page.evaluate(f"""() => {{
              const lv = window.__universe.engine.current;
              const e = lv.entries.get({i!r});
              if (!e) return null;
              const d = lv.camera.position.distanceTo(e.group.position);
              return +(2 * e.r / lv.worldPerPixel(d) / window.innerHeight).toFixed(3);
            }}""")
            ratios[i] = r
        checks.append(('各天体占屏比', str(ratios)))

        # 3) 着陆探测器：取景母天体 + 着陆点标记
        for pid in ['perseverance', 'apollo11', 'huygens']:
            await page.evaluate(f'window.__universe.gotoDestination({pid!r})')
            await page.wait_for_timeout(2600)
            await stable(page)
            info = await page.evaluate(f"""() => {{
              const lv = window.__universe.engine.current;
              const e = lv.entries.get({pid!r});
              const host = lv.dataset.get({pid!r}).host;
              let hostPos = null, hostR = 0;
              const he = lv.entries.get(host);
              if (he) {{ hostPos = he.group.position; hostR = he.r; }}
              else {{
                const mp = lv.moonPivots.find(m => m.moon.id === host);
                if (mp) {{
                  hostPos = mp.world;
                  const pr = lv.entries.get(mp.moon.parent)?.r || 0.02;
                  hostR = lv.bodyRadius(mp.moon.radiusKm, true, pr);
                }}
              }}
              if (!hostPos) return {{ host, error: 'host not found' }};
              const d = lv.camera.position.distanceTo(hostPos);
              const wpp = lv.worldPerPixel(d);
              return {{ host, ratio: +(2 * hostR / wpp / window.innerHeight).toFixed(3),
                        pin: !!e?.pin, marker: !!e?.marker }};
            }}""")
            checks.append((f'着陆探测器 {pid}', str(info)))
            await page.screenshot(path=os.path.join(SHOTS, f'fix-{pid}.png'))

        await browser.close()
    print('=== 结果 ===')
    for k, v in checks:
        print(f'  {k}: {v}')
    print('控制台错误:', len(errors))
    for e in errors[:6]:
        print('   -', e[:200])


asyncio.run(main())

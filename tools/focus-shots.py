#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""聚焦若干天体并截图（用 window.__universe 直接驱动）。用法：py -3.13 -X utf8 tools/focus-shots.py id1 id2 ..."""
import asyncio, sys, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
URL = 'http://127.0.0.1:8787/'

async def stable(page, n=8):
    for _ in range(n):
        await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')

async def main():
    ids = sys.argv[1:] or ['jupiter']
    errors = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(URL, wait_until='networkidle')
        await page.wait_for_timeout(3000)
        await stable(page)
        for i in ids:
            close = i.startswith('close:')
            target = i.split(':', 1)[1] if close else i
            await page.evaluate(f'window.__universe.gotoDestination({target!r})')
            await page.wait_for_timeout(2600)
            if close:
                await page.evaluate(f"""() => {{
                  const e = window.__universe.engine.current;
                  const p = e.entries.get({target!r}).group.position;
                  const r = e.entries.get({target!r}).r;
                  e.camera.position.set(p.x + r*2.6, p.y + r*1.3, p.z + r*3.1);
                  e.controls.target.copy(p);
                  e.controls.update();
                }}""")
                await page.wait_for_timeout(1200)
            await stable(page)
            name = target + ('-close' if close else '')
            await page.screenshot(path=os.path.join(SHOTS, f'focus-{name}.png'))
            info = await page.evaluate("""() => {
              const a = window.__universe;
              const e = a.engine.current;
              return { view: e?.id, entries: e?.entries?.size ?? 0,
                       moons: e?.moonPivots?.length ?? 0, orbits: e?.orbitLines?.length ?? 0,
                       probeOrbits: e?.probeOrbits?.length ?? 0, trails: e?.probeTrails?.length ?? 0,
                       target: e?.controls?.target?.toArray().map(v=>+v.toFixed(3)) };
            }""")
            print(f'{i}: {info}')
        await browser.close()
    print('errors:', len(errors))
    for e in errors[:10]:
        print('  -', e[:200])

asyncio.run(main())

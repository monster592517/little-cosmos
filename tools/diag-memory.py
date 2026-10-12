#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：显存/纹理占用、长时运行是否掉帧或丢上下文。"""
import asyncio, os, sys
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = 'http://127.0.0.1:8787/'


async def main():
    minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 0.5
    errors = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--enable-unsafe-swiftshader', '--use-gl=swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(URL, wait_until='networkidle')
        await page.wait_for_timeout(4000)

        stats = await page.evaluate("""() => {
          const lv = window.__universe.engine.current;
          const r = lv.ctx.engine.renderer;
          const seen = new Map();
          let texBytes = 0, texCount = 0, geoCount = 0, triCount = 0;
          lv.scene.traverse(o => {
            if (o.geometry) {
              geoCount++;
              const p = o.geometry.attributes.position;
              if (p) triCount += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
            }
            const m = o.material;
            if (!m) return;
            for (const key of ['map', 'bumpMap', 'normalMap', 'nightMap', 'specMap', 'dayMap', 'alphaMap']) {
              const t = m[key] || (m.uniforms && m.uniforms[key] && m.uniforms[key].value);
              if (!t || !t.isTexture || seen.has(t.uuid)) continue;
              seen.set(t.uuid, 1);
              const im = t.image;
              if (!im || !im.width) continue;
              // RGBA8 + mipmap ≈ w*h*4*1.33
              const bytes = im.width * im.height * 4 * 1.34;
              texBytes += bytes; texCount++;
            }
          });
          return {
            texCount, texMB: +(texBytes / 1048576).toFixed(1),
            geoCount, triCount: Math.round(triCount),
            rendererTex: r.info.memory.textures, rendererGeo: r.info.memory.geometries,
            pixelRatio: r.getPixelRatio(),
            heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null,
            bigTextures: [...seen.keys()].length,
          };
        }""")
        print('初始统计:', stats)

        # 长时运行：切换视角 + 随机聚焦天体，统计帧率与内存变化
        frames = await page.evaluate("""() => new Promise(res => {
          let n = 0; const t0 = performance.now();
          const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res(n / 3); };
          requestAnimationFrame(tick);
        })""")
        print(f'基线帧率: {frames:.1f} fps')

        import random
        ids = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune',
               'pluto', 'ceres', 'io', 'europa', 'titan', 'enceladus', 'triton', 'voyager1',
               'perseverance', 'apollo11', '1I', '67P']
        t = 0
        while t < minutes * 60:
            await page.evaluate(f"window.__universe.gotoDestination({random.choice(ids)!r})")
            await page.wait_for_timeout(2500)
            t += 2.5
        after = await page.evaluate("""() => {
          const r = window.__universe.engine.current.ctx.engine.renderer;
          return { rendererTex: r.info.memory.textures, rendererGeo: r.info.memory.geometries,
                   heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null,
                   lost: r.getContext().isContextLost() };
        }""")
        print('长时间运行后:', after)
        await browser.close()
    print('错误数:', len(errors))
    for e in errors[:10]:
        print('  -', e[:200])


asyncio.run(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归：左侧常驻目录 / 全部天体 3D 建模 / 建模来源标注 / 太阳遮挡。"""
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
        await page.wait_for_timeout(3500)
        await stable(page)

        info = await page.evaluate("""() => {
          const a = window.__universe, e = a.engine.current;
          let meshes = 0;
          e.scene.traverse(o => { if (o.name === 'body' && o.isMesh) meshes++; });
          const bodies = [...a.dataset.bodies.values()].filter(b =>
            ['planet','dwarf','moon','asteroid','comet','tno'].includes(b.type));
          const withMesh = bodies.filter(b => e.entries.has(b.id) || e.moonPivots.some(m=>m.moon.id===b.id));
          const withTex = bodies.filter(b => b.texture);
          const withMeta = bodies.filter(b => b.textureMeta);
          const withNormal = bodies.filter(b => b.normalTexture);
          return { sceneMeshes: meshes, solarBodies: bodies.length, modelled: withMesh.length,
                   textures: withTex.length, meta: withMeta.length, normals: withNormal.length,
                   moons: e.moonPivots.length, entries: e.entries.size };
        }""")
        checks.append(('建模统计', str(info)))

        # 1) 左侧常驻目录
        await page.locator('#btn-catalog').click()
        await page.wait_for_timeout(700)
        vis = await page.locator('#catalog-pane').is_visible()
        checks.append(('目录面板在左侧且可见', vis))
        box = await page.locator('#catalog-pane').bounding_box()
        checks.append(('目录面板位置', f"x={box['x']:.0f} y={box['y']:.0f} w={box['width']:.0f}"))
        await page.screenshot(path=os.path.join(SHOTS, 'n1-左侧目录.png'))

        # 2) 点目录里的行星 → 右侧详情打开，左侧不消失
        await page.locator('#catalog-body .ttl[data-goto="mercury"]').click()
        await page.wait_for_timeout(2800)
        await stable(page)
        still = await page.locator('#catalog-pane').is_visible()
        title = await page.locator('#panel-title').inner_text()
        body = await page.locator('#panel-body').inner_text()
        checks.append(('点目录后左侧仍在', still))
        checks.append(('右侧详情', f'{title} / 建模来源={"3D 建模与影像来源" in body} / 水星={"水星" in body}'))
        await page.screenshot(path=os.path.join(SHOTS, 'n2-水星全貌.png'))

        # 3) 太阳是否遮挡内行星：截图中心区域应能看到行星本体
        await page.evaluate("window.__universe.gotoDestination('venus')")
        await page.wait_for_timeout(2800)
        await stable(page)
        await page.screenshot(path=os.path.join(SHOTS, 'n3-金星全貌.png'))

        # 4) 无贴图天体 → 暂无图片
        await page.evaluate("window.__universe.ui.info.show('3I')")
        await page.wait_for_timeout(1500)
        t3 = await page.locator('#panel-body').inner_text()
        checks.append(('3I 详情', '暂无图片' in t3 and '程序化生成' in t3))

        # 5) 离开的天体有照片
        await page.evaluate("window.__universe.ui.info.show('1I')")
        await page.wait_for_timeout(1600)
        n1 = await page.locator('#panel-body .gallery a').count()
        checks.append(('奥陌陌影像', f'{n1} 张'))
        await page.evaluate("window.__universe.ui.info.show('2I')")
        await page.wait_for_timeout(1600)
        n2 = await page.locator('#panel-body .gallery a').count()
        checks.append(('鲍里索夫影像', f'{n2} 张'))

        # 6) 小天体全景建模（选一个极小卫星）
        await page.evaluate("window.__universe.gotoDestination('pandia')")
        await page.wait_for_timeout(2600)
        await stable(page)
        p = await page.evaluate("""() => {
          const lv = window.__universe.engine.current;
          const mp = lv.moonPivots.find(m => m.moon.id === 'pandia');
          const mesh = mp && mp.holder.getObjectByName('body');
          return { found: !!mp, mesh: !!mesh, r: mesh ? +mesh.geometry.parameters?.radius?.toFixed(5) : null,
                   camDist: mp ? +lv.camera.position.distanceTo(mp.world).toFixed(5) : null };
        }""")
        checks.append(('小卫星建模', str(p)))
        await page.screenshot(path=os.path.join(SHOTS, 'n4-小卫星全貌.png'))

        await browser.close()
    print('=== 结果 ===')
    for k, v in checks:
        print(f'  {k}: {v}')
    print('控制台错误:', len(errors))
    for e in errors[:8]:
        print('   -', e[:200])


asyncio.run(main())

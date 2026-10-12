#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""渲染伪影 + 真实比例切换开销 探针

为什么有这个东西
----------------
用户报了两件事：
  ① 「切换真实比例的时候会卡」
  ② 「你这个大方框太阳是认真的？」（截图上太阳是个硬边白色方块）

两条都**不能靠读代码下结论**：

· 关于 ①：`engine.js` 对**全部六个层级**调用 `setTrueScale()`
  （`for (const lv of this.levels.values()) lv.setTrueScale?.(...)`），
  而只有 `SolarLevel` 实现了它、实现方式是**整层 dispose + rebuild**。
  ⇒ 在「邻近恒星系」层拨这个开关，可能照样把**太阳系**整个重建一遍。
  这需要实测：到底谁被重建了、花了多少毫秒。

· 关于 ②：本项目已经踩过两次「billboard 没给 map → 渲染成硬边方块」
  （`solar.js` 奥尔特云、`supercluster.js` 纤维结构，见坑 1）。
  但「看起来是方块」也可能是别的东西 —— 判断必须靠**把屏幕正中央那个对象揪出来**，
  而不是靠眼睛猜。

所以本脚本做三件事，都不预设结论：
  · 把屏幕正中央的对象投影出来，报出它的类型 / 材质 / **有没有贴图**；
  · 把当前层**所有** Sprite / Points 逐个列出，标出**哪些没有 map**（方块嫌疑人）；
  · 计时 `setTrueScale` 开关，并记录前后**每一层**的 built 状态（谁被重建了）。

用法：
    py -3.13 -X utf8 tools/probe-level-render.py
    py -3.13 -X utf8 tools/probe-level-render.py --level=neighborhood
    py -3.13 -X utf8 tools/probe-level-render.py --level=solar --shots

退出码：0 = 测到了；1 = 页面没起来。
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright
from browser_args import OCCLUSION_ARGS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

BROWSER = 'edge'
HEADED = True
GPU = 'auto'
LEVEL = 'neighborhood'
SHOTS = False
for a in sys.argv[1:]:
    if a.startswith('--level='):
        LEVEL = a.split('=', 1)[1]
    elif a.startswith('--browser='):
        BROWSER = a.split('=', 1)[1]
    elif a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--gpu='):
        GPU = a.split('=', 1)[1]
    elif a == '--shots':
        SHOTS = True

GPU_ARGS = []
if GPU == 'hp':
    GPU_ARGS = ['--force_high_performance_gpu']
elif GPU == 'lp':
    GPU_ARGS = ['--force_low_power_gpu']

LEVELS = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe']

# ---------------------------------------------------------------------------
# ① 揪出屏幕正中央的对象 + 列出所有缺 map 的 billboard
# ---------------------------------------------------------------------------
INSPECT_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  if (!lv || !lv.scene) return { ok: false, why: '拿不到当前层场景' };
  const cam = lv.camera || u.engine.camera;
  if (!cam) return { ok: false, why: '拿不到相机' };

  const sprites = [];
  const pointsList = [];
  const meshesNoMap = [];

  const walk = (o, path) => {
    const nm = o.name || o.type;
    const here = path ? path + '/' + nm : nm;
    if (o.isSprite) {
      const m = o.material || {};
      const img = m.map && m.map.image;
      sprites.push({
        path: here, name: o.name || '',
        pos: o.position.toArray().map(v => +v.toFixed(3)),
        scale: [+o.scale.x.toFixed(3), +o.scale.y.toFixed(3), +o.scale.z.toFixed(3)],
        hasMap: !!m.map,
        mapImg: m.map ? (img ? (img.width + 'x' + img.height) : 'map.image=NULL ← 加载失败/未就绪') : '（没有 map ⇒ 渲染成实心方块）',
        mat: m.type || '?', blending: m.blending, opacity: m.opacity, visible: o.visible,
      });
      // 投影到屏幕坐标，找正中央那个
      const v = o.position.clone();
      v.project(cam);
      const last = sprites[sprites.length - 1];
      last.ndc = [+v.x.toFixed(3), +v.y.toFixed(3)];
      last.onScreen = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1;
    } else if (o.isPoints) {
      const m = o.material || {};
      pointsList.push({
        path: here, name: o.name || '',
        count: o.geometry && o.geometry.attributes.position ? o.geometry.attributes.position.count : null,
        size: m.size, hasMap: !!m.map, mat: m.type || '?', visible: o.visible,
        vertexColors: !!m.vertexColors,
      });
    } else if (o.isMesh) {
      const m = o.material || {};
      const arr = Array.isArray(m) ? m : [m];
      if (!arr.some(x => x && x.map)) meshesNoMap.push({ path: here, name: o.name || '', mat: m.type || '?' });
    }
    for (const c of (o.children || [])) walk(c, here);
  };
  walk(lv.scene, '');

  // 屏幕正中央（|ndc| 很小的）候选
  const center = sprites
    .filter(s => s.onScreen && Math.abs(s.ndc[0]) < 0.08 && Math.abs(s.ndc[1]) < 0.08)
    .sort((a, b) => (Math.abs(a.ndc[0]) + Math.abs(a.ndc[1])) - (Math.abs(b.ndc[0]) + Math.abs(b.ndc[1])))
    .slice(0, 5);

  return {
    ok: true,
    level: lv.id, built: !!lv.built,
    spriteTotal: sprites.length,
    pointsTotal: pointsList.length,
    center,
    spritesNoMap: sprites.filter(s => !s.hasMap),
    pointsNoMap: pointsList.filter(p => !p.hasMap),
    meshesNoMap,
    spritesOnScreen: sprites.filter(s => s.onScreen).sort((a, b) => b.scale[0] - a.scale[0]).slice(0, 12),
  };
}
"""

# ---------------------------------------------------------------------------
# ② 真实比例开关的开销 + 谁被重建了
# ---------------------------------------------------------------------------
TOGGLE_JS = r"""
() => {
  const u = window.__universe;
  const snap = () => { const b = {}; for (const [k, v] of u.engine.levels) b[k] = !!v.built; return b; };
  const out = { current: u.engine.current?.id, before: snap() };
  let t0 = performance.now();
  u.engine.setOptions({ trueScale: true });
  out.onMs = +(performance.now() - t0).toFixed(1);
  out.afterOn = snap();
  t0 = performance.now();
  u.engine.setOptions({ trueScale: false });
  out.offMs = +(performance.now() - t0).toFixed(1);
  out.afterOff = snap();
  return out;
}
"""

# ---------------------------------------------------------------------------
# ③ 帧时间采样（区分「一次性卡」和「一直卡」）
# ---------------------------------------------------------------------------
FRAME_JS = r"""
(n) => new Promise(res => {
  const u = window.__universe;
  const times = [];
  let last = performance.now();
  let i = 0;
  const tick = () => {
    const now = performance.now();
    times.push(now - last);
    last = now;
    if (++i < n) requestAnimationFrame(tick);
    else {
      const s = times.slice(3).sort((a, b) => a - b);
      res({
        n: s.length,
        median: +s[Math.floor(s.length / 2)].toFixed(2),
        p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
        max: +s[s.length - 1].toFixed(2),
      });
    }
  };
  requestAnimationFrame(tick);
})
"""


async def main():
    srv = ServedCheck()
    base = srv.start()
    try:
        return await probe(base)
    finally:
        srv.stop()


async def probe(base):
    async with async_playwright() as pw:
        launch = {'channel': 'msedge'} if BROWSER == 'edge' else (
            {'channel': 'chrome'} if BROWSER == 'chrome' else {})
        try:
            browser = await pw.chromium.launch(headless=not HEADED, args=GPU_ARGS + OCCLUSION_ARGS, **launch)
        except Exception as e:
            emit(f'  ✗ 起浏览器失败（{BROWSER}）：{e}')
            browser = await pw.chromium.launch(headless=not HEADED, args=GPU_ARGS + OCCLUSION_ARGS)

        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! {m.text[:160]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        try:
            await page.wait_for_function(
                'window.__universe && window.__universe.engine && '
                'window.__universe.dataset', timeout=45000)
        except Exception:
            emit('  ✗ 45 秒内没等到 window.__universe.dataset')
            await browser.close()
            return 1
        await page.wait_for_timeout(2500)

        emit(f'  切到「{LEVEL}」层…')
        await page.evaluate(f"window.__universe.gotoScale('{LEVEL}')")
        try:
            await page.wait_for_function(
                f"window.__universe.engine.current?.id === '{LEVEL}'", timeout=40000)
        except Exception:
            emit('  ✗ 切层超时')
            await browser.close()
            return 1
        await page.wait_for_timeout(1200)

        fr = await page.evaluate(FRAME_JS, 90)
        r = await page.evaluate(INSPECT_JS)
        tg = await page.evaluate(TOGGLE_JS)
        await page.wait_for_timeout(600)

        # 切「真实比例」跑一遍帧时间 —— 看是不是持续卡
        await page.evaluate("window.__universe.engine.setOptions({ trueScale: true })")
        await page.wait_for_timeout(1200)
        frTrue = await page.evaluate(FRAME_JS, 90)
        await page.evaluate("window.__universe.engine.setOptions({ trueScale: false })")
        await page.wait_for_timeout(1200)

        if SHOTS:
            os.makedirs(os.path.join(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__))), 'shots'), exist_ok=True)
            p = os.path.join(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__))), 'shots', f'probe-{LEVEL}.png')
            await page.screenshot(path=p)
            emit(f'  截图 → {p}')

        print('\n' + '=' * 64)
        print(f'  当前层 {r.get("level")} · built={r.get("built")}')
        print('-' * 64)
        print(f'  ① 屏幕正中央的对象（{len(r.get("center", []))} 个候选）')
        if not r.get('center'):
            print('     （正中央没有 Sprite —— 那个方块不是 Sprite，得换方向查）')
        for s in r.get('center', []):
            print(f'     [{s["name"] or "无名"}] {s["path"]}')
            print(f'       位置 {s["pos"]} · 尺寸 {s["scale"][0]}')
            print(f'       材质 {s["mat"]} · 混合 {s["blending"]} · 不透明度 {s["opacity"]}')
            print(f'       贴图 {s["mapImg"]}')
            print(f'       NDC {s["ndc"]}')
        print('-' * 64)
        print(f'  ② 缺 map 的 billboard（会渲染成硬边方块）')
        if not r.get('spritesNoMap'):
            print('     没有缺 map 的 Sprite。')
        for s in r.get('spritesNoMap', []):
            print(f'     ✗ Sprite [{s["name"] or "无名"}] {s["path"]} · 位置 {s["pos"]} · 尺寸 {s["scale"][0]}')
        if not r.get('pointsNoMap'):
            print('     没有缺 map 的 Points。')
        for p_ in r.get('pointsNoMap', []):
            print(f'     ✗ Points [{p_["name"] or "无名"}] {p_["path"]} · {p_["count"]} 点 · size={p_["size"]}')
        if r.get('meshesNoMap'):
            print(f'     无贴图 Mesh（{len(r["meshesNoMap"])} 个，多数正常）：')
            for m in r['meshesNoMap'][:8]:
                print(f'       · {m["path"]} ({m["mat"]})')
        print('-' * 64)
        print(f'  ③ 在屏幕内的 Sprite（按尺寸降序，前 12）'
              f'   共 {r.get("spriteTotal")} 个 Sprite / {r.get("pointsTotal")} 个 Points')
        for s in r.get('spritesOnScreen', []):
            print(f'     {str(s["scale"][0]):>8}  [{s["name"] or "无名"}] {s["path"]}'
                  f'  贴图={s["mapImg"]}')
        print('-' * 64)
        print('  ④ 「真实比例」开关的开销')
        print(f'     当前层 = {tg["current"]}')
        print(f'     开启耗时 {tg["onMs"]} ms · 关闭耗时 {tg["offMs"]} ms')
        for k in LEVELS:
            b, a1, a2 = tg['before'].get(k), tg['afterOn'].get(k), tg['afterOff'].get(k)
            mark = ''
            if b is not a1 or b is not a2:
                mark = '   ← 被重建'
            print(f'     {k:<14} 开前={str(b):<5} 开后={str(a1):<5} 关后={str(a2):<5}{mark}')
        print('-' * 64)
        print('  ⑤ 帧时间（ms）')
        print(f'     视觉比例   中位 {fr["median"]:>7} · p95 {fr["p95"]:>7} · 最大 {fr["max"]:>7}')
        print(f'     真实比例   中位 {frTrue["median"]:>7} · p95 {frTrue["p95"]:>7} · 最大 {frTrue["max"]:>7}')
        print('=' * 64)

        await browser.close()
        return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「太阳的所在地是个大光球」的归属与处方实验。

## 已经确定的事（不重复测）

`shots/sq-7-hyg-bloomoff.png` 与 `sq-8-hyg-bloomon.png` 是同场景、同对象
（`mw-hyg-stars`，109,400 颗局部恒星）**只切 `options.bloom`** 的一对：

    泛光关 → 一个干净的**圆亮点**，约 34 px（正好是 3.26 千光年在视距 141 千光年下的大小）
    泛光开 → 一块约 **330 px 的方斑**（圆角方块亮芯 + 一大圈灰色方形光晕）

⇒ 光球 100% 是 `UnrealBloomPass` 的产物，源是 `mw-hyg-stars`。

## 这一轮要回答的是「怎么修」，所以只改一个变量

已经排除过的（上一轮测过，别再花时间）：`radius` 从 0.60 扫到 0.15 只让外接框缩 44 px
（**恰好一个最粗 mip 的纹素**），方形度纹丝不动 1.126–1.147；`threshold = 0.9` 只缩 8%。
⇒ **形状不是靠 `radius` / `threshold` 调的**，`strength` 才是幅度旋钮。

所以这里扫的是「**要么别让源饱和进泛光**（改源），**要么把泛光整体调轻**（改泛光）」：

    0 基线        原样（这是用户看到的）
    1 星云减淡    `mw-hyg-stars` opacity 0.95 → 0.45
    2 星云收小    `mw-hyg-stars` size 0.055 → 0.030
    3 标记收小    `mw-sun-mark` size 2.2 → 0.9、opacity 1.0 → 0.75
    4 星云隐藏    （上限：能压到多干净）
    5 泛光减半    `bloomPass.strength` 0.72 → 0.40
    6 泛光关闭    （下限，等于没有光晕）

## 判据

每张**以太阳投影点为心的 320×320 裁剪**，量三件事：

  · **外接框** —— 光球多大。基线应与 sq-8 同量级（几百 px，裁剪内会被切边，记下即可）
  · **方形度** = 掩膜面积 /(框宽×框高) —— 圆内切自框 = π/4 ≈ 0.785，方块 = 1.00
  · **峰值** —— 有没有还是死白

另外量**全屏均值亮度**：任何一处改动如果顺手把整个银河系调暗了，那是「改一个赔三个」，
必须记在账上。基线是全屏均值，不要动它。

⚠️ 测量前必须关标签（坑 106：标签走 DOM、不吃曝光，会把均值抬高并把圆心带偏）。

用法：
    py -3.13 -X utf8 tools/probe-sun-blob.py
产出：`shots/sb-*.png` + `shots/_sun-blob.log`
"""
import asyncio
import os
import sys
import threading

from playwright.async_api import async_playwright
from browser_args import OCCLUSION_ARGS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
CROP = 320

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(line_buffering=True)
    except Exception:
        pass


def arm_hard_exit(seconds, code=0):
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t


HEADED = False
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')


# ---------------------------------------------------------------------------
# 场景侧：找对象、快照、改单个变量、复位
# ---------------------------------------------------------------------------
SNAP_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const find = (n) => (lv.scene.children || []).find((o) => o.name === n) || null;
  const hyg = find('mw-hyg-stars'), mark = find('mw-sun-mark'), sun = find('mw-sun');
  lv.labels?.setVisible?.(false);          // 坑 106：标签必须关掉再量
  window.__snap = {
    hygOpacity: hyg ? hyg.material.opacity : null,
    hygSize: hyg ? hyg.material.size : null,
    markSize: mark ? mark.scale.x : null,
    markOpacity: mark ? mark.material.opacity : null,
  };
  return {
    found: { hyg: !!hyg, mark: !!mark, sun: !!sun },
    hygCount: hyg && hyg.geometry ? hyg.geometry.getAttribute('position').count : null,
    strength: window.__universe.engine.bloomPass?.strength ?? null,
    snap: window.__snap,
  };
}
"""

# 太阳投影点 → 屏幕像素（裁剪框以它为中心）
PROJECT_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((c) => c.name === 'mw-sun-mark');
  if (!o) return null;
  const p = o.position.clone().project(lv.camera);
  const { w, h } = lv.ctx.engine.size;
  return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
}
"""

SET_JS = r"""
(c) => {
  const lv = window.__universe.engine.current;
  const find = (n) => (lv.scene.children || []).find((o) => o.name === n) || null;
  const hyg = find('mw-hyg-stars'), mark = find('mw-sun-mark');
  const s = window.__snap;
  // 先无条件复位
  if (hyg) { hyg.material.opacity = s.hygOpacity; hyg.material.size = s.hygSize; hyg.visible = true; }
  if (mark) { mark.scale.setScalar(s.markSize); mark.material.opacity = s.markOpacity; }
  if (window.__universe.engine.bloomPass) window.__universe.engine.bloomPass.strength = window.__strength0;
  window.__universe.engine.options.bloom = true;
  // 再按 case 改**一个**变量
  const what = [];
  if (c === 1 && hyg) { hyg.material.opacity = 0.45; what.push('hyg.opacity=0.45'); }
  if (c === 2 && hyg) { hyg.material.size = 0.030; what.push('hyg.size=0.030'); }
  if (c === 3 && mark) { mark.scale.setScalar(0.9); mark.material.opacity = 0.75; what.push('mark.size=0.9 opacity=0.75'); }
  if (c === 4 && hyg) { hyg.visible = false; what.push('hyg.visible=false'); }
  if (c === 5 && window.__universe.engine.bloomPass) {
    window.__universe.engine.bloomPass.strength = window.__strength0 * 0.55; what.push('bloom.strength×0.55');
  }
  if (c === 6) { window.__universe.engine.options.bloom = false; what.push('bloom=off'); }
  return { case: c, what: what.length ? what.join(' ') : '（基线，什么都没改）' };
}
"""


async def settle(page, frames=3, min_ms=0):
    if min_ms:
        await page.wait_for_timeout(min_ms)
    try:
        await page.evaluate("""(n) => new Promise(res => {
          let i = 0; const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        })""", frames)
    except Exception:
        pass


def analyse(path_crop, path_full):
    """裁剪图：峰值 / 外接框 / 方形度。全屏图：均值亮度（看有没有连累银河系）。"""
    from PIL import Image
    import math
    im = Image.open(path_crop).convert('RGB')
    W, H = im.size
    px = im.load()
    lum = [[0] * W for _ in range(H)]
    peak = 0
    for y in range(H):
        row = lum[y]
        for x in range(W):
            r, g, b = px[x, y]
            v = (r * 299 + g * 587 + b * 114) // 1000
            row[x] = v
            if v > peak:
                peak = v
    # 掩膜取峰值的一半（比固定 200 稳：泛光弱下来时固定阈值会把整个斑判没）
    thr = max(24, int(peak * 0.5))
    xs, ys, n = [], [], 0
    for y in range(H):
        for x in range(W):
            if lum[y][x] >= thr:
                xs.append(x); ys.append(y); n += 1
    if n < 40:
        return {'peak': peak, 'thr': thr, 'n': n, 'note': '斑太小，读不出形状'}
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    squareness = n / (bw * bh)
    cx, cy = sum(xs) / n, sum(ys) / n
    # 对角比：e^-1 半径处 45°/0° 方向的半径之比（圆 ≈ 1.00，方 ≈ 1.41）
    rr = math.sqrt(bw * bh) / 2.0
    def prof(deg):
        a = math.radians(deg); out = 0.0
        for t in range(1, int(rr * 1.6) + 1):
            x = int(round(cx + math.cos(a) * t)); y = int(round(cy + math.sin(a) * t))
            if 0 <= x < W and 0 <= y < H and lum[y][x] >= thr:
                out = t
        return out
    r0, r90, r45, r135 = prof(0), prof(90), prof(45), prof(135)
    d1 = (r45 + r135) / 2.0
    d2 = (r0 + r90) / 2.0
    diag = (d1 / d2) if d2 > 0 else float('nan')
    verdict = '方' if diag > 1.15 else ('圆' if diag < 1.05 else '说不清')
    full = Image.open(path_full).convert('L')
    fw, fh = full.size
    fl = list(full.getdata())
    mean = sum(fl) / len(fl)
    return {'peak': peak, 'thr': thr, 'n': n, 'bbox': (bw, bh),
            'squareness': round(squareness, 3), 'diag': round(diag, 3),
            'verdict': verdict, 'fullMean': round(mean, 2), 'size': (W, H)}


CASES = [
    (0, '基线（原样）'),
    (1, '源：星云减淡 0.95→0.45'),
    (2, '源：星云收小 0.055→0.030'),
    (3, '源：太阳标记收小 2.2→0.9'),
    (4, '源：星云整片隐藏（上限）'),
    (5, '泛光：strength ×0.55'),
    (6, '泛光：关闭（下限）'),
]


async def main():
    srv = ServedCheck(tag='太阳光球实验')
    base = srv.start()
    try:
        return await run(base)
    finally:
        srv.stop()


async def run(base):
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as pw:
        backend = 'msedge'
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=OCCLUSION_ARGS)
        except Exception as e:
            backend = f'bundled-chromium（msedge 起不来：{type(e).__name__}）'
            browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('pageerror', lambda e: emit(f'  ! pageerror: {str(e)[:160]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=60000)
        await page.wait_for_timeout(2500)
        await page.evaluate("""() => {
          const e = window.__universe.engine;
          if (e.gpu) { e.gpu.tierPinned = true; e.applyTier?.('high'); }
          window.__strength0 = e.bloomPass ? e.bloomPass.strength : null;
        }""")
        await page.evaluate("window.__universe.gotoScale('galaxy')")
        await page.wait_for_function(
            "window.__universe.engine.current?.id === 'galaxy'", timeout=45000)
        await page.wait_for_timeout(2200)
        # 关自动旋转：否则裁剪框里的斑会随帧漂移（「钉住会漂的状态」）
        await page.evaluate("""() => {
          const e = window.__universe.engine;
          e.options.autoRotate = false;
          if (e.controls) e.controls.autoRotate = false;
        }""")
        await settle(page, frames=4, min_ms=600)
        emit(f'  后端 {backend}')

        snap = await page.evaluate(SNAP_JS)
        print('\n' + '=' * 100)
        print('  场景检查（先证明我改的是真的那个对象）')
        print('-' * 100)
        print(f'  对象存在性 {snap["found"]}')
        print(f'  mw-hyg-stars 点数 {snap["hygCount"]}（预期 109400）')
        print(f'  泛光 strength 起点 {snap["strength"]}')
        print(f'  快照 {snap["snap"]}')
        if not (snap['found']['hyg'] and snap['found']['mark']):
            print('  ✗ 对象没找齐 —— 后面的表没有意义，直接退出')
            return 1
        print('=' * 100)

        p = await page.evaluate(PROJECT_JS)
        cx, cy = int(p['x']), int(p['y'])
        x0 = max(0, min(cx - CROP // 2, 1400 - CROP))
        y0 = max(0, min(cy - CROP // 2, 860 - CROP))
        emit(f'  太阳投影点 ({cx},{cy}) → 裁剪框 ({x0},{y0},{CROP}×{CROP})')

        print('\n' + '=' * 100)
        print(f'  逐个变量（每张 = 以太阳投影点为心的 {CROP}×{CROP} 裁剪）')
        print('-' * 100)
        print(f'  {"case":<30}{"峰值":<7}{"框":<12}{"方形度":<9}{"对角比":<9}'
              f'{"形状":<8}{"全屏均值":<10}')
        rows = []
        for c, desc in CASES:
            info = await page.evaluate(SET_JS, c)
            await settle(page, frames=4, min_ms=700)
            name = f'sb-{c}.png'
            await page.screenshot(path=os.path.join(SHOTS, name),
                                  clip={'x': x0, 'y': y0, 'width': CROP, 'height': CROP})
            fulln = f'sb-{c}-full.png'
            await page.screenshot(path=os.path.join(SHOTS, fulln))
            a = analyse(os.path.join(SHOTS, name), os.path.join(SHOTS, fulln))
            rows.append((c, desc, a))
            if 'bbox' in a:
                print(f'  {f"{c} {desc}":<30}{a["peak"]:<7}{str(a["bbox"]):<12}'
                      f'{a["squareness"]:<9}{a["diag"]:<9}{a["verdict"]:<8}{a["fullMean"]:<10}')
            else:
                print(f'  {f"{c} {desc}":<30}{a["peak"]:<7}{a.get("note", "?"):<12}'
                      f'{"-":<9}{"-":<9}{"-":<8}{a["fullMean"]:<10}')
        print('=' * 100)
        print('  怎么读这张表：')
        print('   · 形状栏要变成「圆」（对角比 < 1.05）才叫真的治好光球；只是变小/变暗不算。')
        print('   · 全屏均值是用来抓「改一个赔三个」的：基线那一行的值，别处不该显著低于它。')
        print('   · case 4（隐藏）与 case 6（关泛光）是上下限，不是候选方案。')
        print('=' * 100)

        await page.evaluate(SET_JS, 0)
        await settle(page, frames=3, min_ms=400)
        print('  已复位到基线。')

        sys.stdout.flush()
        arm_hard_exit(14, 0)
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except Exception as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘，由看门狗收尾）：{type(e).__name__}')
    return 0


if __name__ == '__main__':
    arm_hard_exit(600, 3)
    try:
        code = asyncio.run(main())
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 0
    sys.exit(code or 0)

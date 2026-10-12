#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""消融探针：屏幕上那个硬边亮块到底是**谁**画出来的？

为什么要这么做
--------------
「太阳渲染成大方块」这个现象，读代码是**猜不出来**的：
  · 本项目已经踩过两次「billboard 没给 map → 硬边方块」（坑 1），
    但那次探针报「没有缺 map 的 Sprite」——所以这次不是那个病。
  · 硬边亮块还有第二个成因：**多个加法混合（AdditiveBlending）的辉光精灵
    叠在同一个坐标上**，亮度叠加后饱和，饱和区变成一块带硬边的"平台"。
  · 还有第三个可能的成因：**取景/投影 bug**（局部坐标当世界坐标用）。

三种病的修法完全不同，所以必须做**消融**：一个个隐藏候选对象，
每次截同一块区域，量「亮块的形状」。

判据（关键）：
    亮块 bbox 的**填充率** fill = 亮像素数 / bbox 面积
      · 圆形亮核 → fill ≈ 0.785
      · 实心矩形 → fill ≈ 1.00
    以及长宽比 aspect = w/h（Sprite 在屏幕上必然是 1:1）。

用法：
    py -3.13 -X utf8 tools/probe-ablate.py
    py -3.13 -X utf8 tools/probe-ablate.py --level=neighborhood
退出码：0 = 测到了；1 = 页面没起来。
"""
import asyncio
import os
import sys

import numpy as np
from PIL import Image
from playwright.async_api import async_playwright
from browser_args import OCCLUSION_ARGS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

HEADED = True
LEVEL = 'neighborhood'
SHOTS = False
for a in sys.argv[1:]:
    if a.startswith('--level='):
        LEVEL = a.split('=', 1)[1]
    elif a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a == '--shots':
        SHOTS = True

# 先把所有候选的世界坐标投影出来（⚠ 必须用 getWorldPosition ——
# 用 o.position 拿到的是**局部坐标**，精灵挂在 Group 里时那个值恒为 (0,0,0)，
# 会把「子对象」全投影到世界原点，制造出一批假的「原点精灵」。）
INSPECT_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  const cam = lv.camera || u.engine.camera;
  const out = { level: lv.id, sprites: [], points: [], lines: 0 };
  const v = new (Object.getPrototypeOf(lv.scene.position).constructor)();
  const walk = (o) => {
    if (o.isSprite) {
      o.getWorldPosition(v);
      const p = v.clone(); p.project(cam);
      const m = o.material || {};
      out.sprites.push({
        pos: [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)],
        ndc: [+p.x.toFixed(3), +p.y.toFixed(3)],
        scale: +o.scale.x.toFixed(3),
        parentChain: (() => { let c = o.parent, s = []; while (c) { s.push(c.name || c.type); c = c.parent; } return s.join('/'); })(),
        hasMap: !!m.map, blending: m.blending, opacity: m.opacity, visible: o.visible,
      });
    } else if (o.isPoints) {
      out.points.push({ n: o.geometry?.attributes?.position?.count ?? null, visible: o.visible, type: o.material?.type });
    } else if (o.isLine || o.isLineSegments) out.lines++;
    for (const c of (o.children || [])) walk(c);
  };
  walk(lv.scene);
  // 世界坐标真的落在原点附近的精灵
  out.atOrigin = out.sprites.filter(s => Math.abs(s.pos[0]) < 1e-3 && Math.abs(s.pos[1]) < 1e-3 && Math.abs(s.pos[2]) < 1e-3);
  out.centerSprites = out.sprites
    .filter(s => Math.abs(s.ndc[0]) < 0.06 && Math.abs(s.ndc[1]) < 0.06)
    .sort((a, b) => b.scale - a.scale).slice(0, 6);
  out.total = out.sprites.length;
  return out;
}
"""

# 消融动作：每个动作后面截图，比「亮块形状」有没有变
ABLATIONS = [
    ('baseline', '基线（什么都不改）', 'true'),
    ('hide-sun', '隐藏太阳精灵', 'window.__universe.engine.current.sunSprite.visible=false; true'),
    ('hide-sprites', '隐藏全部 Sprite', """
      (() => { const lv = window.__universe.engine.current;
        lv.scene.traverse(o => { if (o.isSprite) o.visible = false; }); return true; })()
    """),
    ('hide-points', '隐藏全部 Points', """
      (() => { const lv = window.__universe.engine.current;
        lv.scene.traverse(o => { if (o.isPoints) o.visible = false; }); return true; })()
    """),
    ('hide-lines', '隐藏全部 Line', """
      (() => { const lv = window.__universe.engine.current;
        lv.scene.traverse(o => { if (o.isLine || o.isLineSegments) o.visible = false; }); return true; })()
    """),
    ('hide-labels', '隐藏 DOM 标签层', "document.getElementById('labels').style.display='none'; true"),
    ('restore', '全部恢复', """
      (() => { const lv = window.__universe.engine.current;
        lv.scene.traverse(o => { o.visible = true; });
        document.getElementById('labels').style.display=''; return true; })()
    """),
]


def block_stats(path, cx, cy, half=110):
    """量中心区域里的「亮块」：bbox、长宽比、填充率。"""
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(int)
    H, W, _ = a.shape
    x0, x1 = max(0, int(cx - half)), min(W, int(cx + half))
    y0, y1 = max(0, int(cy - half)), min(H, int(cy + half))
    reg = a[y0:y1, x0:x1]
    lum = reg.max(axis=2)
    mx = int(lum.max())
    thr = max(235, mx - 12)
    m = lum >= thr
    n = int(m.sum())
    if n == 0:
        return {'max': mx, 'n': 0}
    ys, xs = np.nonzero(m)
    w = int(xs.max() - xs.min() + 1)
    h = int(ys.max() - ys.min() + 1)
    return {
        'max': mx, 'n': n, 'w': w, 'h': h,
        'aspect': round(w / h, 2),
        'fill': round(n / (w * h), 2),
    }


async def main():
    srv = ServedCheck()
    base = srv.start()
    try:
        return await probe(base)
    finally:
        srv.stop()


async def probe(base):
    outdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          '.trash', 'ablate')
    os.makedirs(outdir, exist_ok=True)
    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=OCCLUSION_ARGS)
        except Exception:
            browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        await page.goto(base + '/', wait_until='load')
        try:
            await page.wait_for_function(
                'window.__universe && window.__universe.engine && window.__universe.dataset',
                timeout=45000)
        except Exception:
            emit('  ✗ 页面没起来')
            await browser.close()
            return 1
        await page.wait_for_timeout(2500)
        await page.evaluate(f"window.__universe.gotoScale('{LEVEL}')")
        await page.wait_for_function(
            f"window.__universe.engine.current?.id === '{LEVEL}'", timeout=40000)
        await page.wait_for_timeout(1500)

        # 视口中心 = canvas 中心（顶栏 56px 不影响水平中心）
        cx, cy = 1400 / 2, 56 + (860 - 56) / 2

        info = await page.evaluate(INSPECT_JS)
        print('\n' + '=' * 68)
        print(f'  当前层 {info["level"]} · Sprite {info["total"]} 个 · Points {len(info["points"])} 组 · Line {info["lines"]}')
        print('-' * 68)
        print(f'  ① 世界坐标真的在原点的 Sprite：{len(info["atOrigin"])} 个')
        for s in info['atOrigin'][:8]:
            print(f'     尺寸 {s["scale"]:>6} · 父链 {s["parentChain"]} · map={s["hasMap"]} · 混合={s["blending"]}')
        print(f'  ② 屏幕中心的 Sprite（世界坐标投影）：{len(info["centerSprites"])} 个')
        for s in info['centerSprites']:
            print(f'     尺寸 {s["scale"]:>6} · 位置 {s["pos"]} · NDC {s["ndc"]} · 父链 {s["parentChain"]}')
        print('-' * 68)
        print('  ③ 消融实验：每次隐藏一类对象，量中心亮块的形状')
        print('     （fill≈0.79 = 圆核；fill≈1.00 = 实心矩形；aspect>1.1 = 非方形）')
        rows = []
        for key, label, js in ABLATIONS:
            try:
                await page.evaluate(js)
            except Exception as e:
                print(f'     {label:<16} 动作失败：{e}')
                continue
            await page.wait_for_timeout(700)
            p = os.path.join(outdir, f'{key}.png')
            await page.screenshot(path=p)
            st = block_stats(p, cx, cy)
            rows.append((label, st))
            if st.get('n'):
                print(f'     {label:<16} 亮块 {st["w"]:>3}x{st["h"]:<3} '
                      f'长宽比 {st["aspect"]:>4}  填充率 {st["fill"]:>4}  '
                      f'亮像素 {st["n"]:>5}  峰值 {st["max"]}')
            else:
                print(f'     {label:<16} 中心区域没有亮块（峰值 {st["max"]}）')
        print('-' * 68)
        # 判定：哪个消融让「填充率」从 ~1.0 掉下来
        base_fill = next((s.get('fill') for l, s in rows if l.startswith('基线')), None)
        print('  判定')
        for label, st in rows:
            f = st.get('fill')
            if f is None or label.startswith('基线') or label.startswith('全部恢复'):
                continue
            if base_fill and f < base_fill - 0.15:
                print(f'     ✅ 隐藏「{label}」后填充率 {base_fill} → {f} ⇒ **就是它画的硬边块**')
        print('=' * 68)
        if SHOTS:
            emit(f'  截图在 {outdir}')
        await browser.close()
        return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))

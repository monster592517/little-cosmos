#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""星系「核有多大 / 盘怎么衰减」的**横向对比量具**：同一把尺子量我们的渲染和真实照片。

## 为什么有这个东西

用户第二次抱怨同一个症状：**「中心的球太大了吧」/「这边还有个球是个什么鬼」**。
前两次都是靠眼睛调 α（0.78 → 0.30 → 0.24），调完还是大 —— 因为**没有尺子**，
只是「看着小了一点」。这一次先定尺子，再改参数。

## 尺子怎么定（关键：让「我们的渲染」和「一张真实照片」可比）

两张图的天光、动态范围、曝光完全不同，**绝对亮度不可比**。可比的只有**形状比例**：

  ① **天光**：取整幅的 5 百分位当天空底噪，减掉。
  ② **满标**：取减完天光后的最大值 `M`。
  ③ **饱和核**：`L ≥ 0.95·M` 的像素集合，报它的**等效半径** `r_sat`
      （等效半径 = sqrt(面积/π)，比「最大直径」抗噪、也不怕核不是正圆）。
  ④ **星系盘**：`L ≥ 0.05·M` 的像素集合（5% 等照度线），等效半径 `r_gal`。
  ⑤ **判据 = `r_sat / r_gal`**。这是**无量纲**的，所以「我们的渲染」与「真实照片」
     可以直接放在一起比。这就是这次要用的那一个数。

⚠️ 这道尺子有它自己的噪声地板：不同图的 `M` 定义不同（我们的是色调映射后的 8 位，
   照片是已经拉伸过的 8 位）。所以**只比量级（个位数百分比 vs 十几百分比），不比小数点**。

## 用法

    py -3.13 -X utf8 tools/analyze-galaxy-profile.py 图1 [图2 ...]

每张图报一行；另可加 `--crop=x0,y0,x1,y1` 只量某个窗口（裁掉界面外的星空）。
"""
import os
import sys

from PIL import Image

ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
CROP = None
for a in sys.argv[1:]:
    if a.startswith('--crop='):
        CROP = [int(v) for v in a.split('=', 1)[1].split(',')]


def profile(path):
    im = Image.open(path).convert('L')
    if CROP:
        im = im.crop(tuple(CROP))
    w, h = im.size
    px = im.load()
    hist = [0] * 256
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            hist[px[x, y]] += 1
    total = sum(hist)
    acc = 0
    sky = 0
    for v in range(256):
        acc += hist[v]
        if acc >= total * 0.05:
            sky = v
            break
    M = max(255 * 0 + v for v in range(256) if hist[v] > 0)
    # 饱和核 / 5% 等照度线：各数一次像素并求等效半径
    area_gal = 0
    area_sat = 0
    xs = ys = 0.0
    n = 0
    sat_lo = sky + 0.95 * (M - sky)
    gal_lo = sky + 0.05 * (M - sky)
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            v = px[x, y]
            if v >= gal_lo:
                area_gal += 1
            if v >= sat_lo:
                area_sat += 1
                xs += x; ys += y; n += 1
    scale = 4.0                                   # 每 2 像素采样一次 ⇒ 1 像素 = 4 个采样格
    r_gal = (area_gal * scale / 3.14159265) ** 0.5
    r_sat = (area_sat * scale / 3.14159265) ** 0.5
    cx = xs / n if n else 0
    cy = ys / n if n else 0
    # 径向剖面（以亮区质心为心，10 个环带，归一化到 0..1）。
    # ★ 为什么非要有这一条：**「核/盘 %」只量核有多「大」，量不出核有多「陡」**。
    #   两种完全不同的毛病会给出同一个比数：
    #     (a) 平顶 + 断崖（一块饱和的圆盘）  vs  (b) 一个很小的饱和点 + 一层很广的柔光。
    #   真实星系是 (b)。剖面曲线一眼就能分开这两种。
    nb = 10
    acc = [0.0] * nb
    cnt = [0] * nb
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            dx = x - cx
            dy = y - cy
            rr = (dx * dx + dy * dy) ** 0.5
            b = int(rr / (r_gal / nb))
            if 0 <= b < nb:
                acc[b] += px[x, y]
                cnt[b] += 1
    prof = [round((acc[i] / cnt[i] - sky) / max(1e-6, M - sky), 3) if cnt[i] else 0.0
            for i in range(nb)]
    return {
        'file': os.path.basename(path), 'size': f'{w}x{h}',
        'sky': sky, 'max': M, 'r_gal': round(r_gal, 1), 'r_sat': round(r_sat, 1),
        'ratio': round(100.0 * r_sat / max(1e-6, r_gal), 2),
        'center': (round(cx, 1), round(cy, 1)),
        'prof': prof,
    }


def main():
    if not ARGS:
        print('用法：analyze-galaxy-profile.py 图1 [图2 ...]')
        return 1
    print(f'{"文件":46s} {"尺寸":>10s} {"天光":>5s} {"满标":>5s} {"r_盘":>7s} {"r_饱和核":>8s} {"核/盘 %":>8s}')
    for p in ARGS:
        try:
            r = profile(p)
        except Exception as e:
            print(f'{os.path.basename(p):46s}  ERR {type(e).__name__}: {e}')
            continue
        print(f'{r["file"]:46s} {r["size"]:>10s} {r["sky"]:5d} {r["max"]:5d}'
              f' {r["r_gal"]:7.1f} {r["r_sat"]:8.1f} {r["ratio"]:8.2f}')
        print(f'{"":46s} 径向剖面 r/r_gal = 0.05→0.95：'
              + ' '.join(f'{v:.2f}' for v in r['prof']))
    print('\n判据：**核/盘 %** 无量纲、可跨图比较（只比量级，不比小数点）。')
    print('⚠️ **径向剖面只用于「我们的渲染 前后对比」，不要拿它跟这张照片比。**')
    print('   实测（2026-09-12）：NGC 6744 那张量出来是「平」的（0.19→0.28→0.14），')
    print('   不是因为它没有核，而是**测量几何不成立**：① 它是斜视的，图像空间的圆环')
    print('   把不同半径混在一起；② 星野里大量恒星都高于 5% 阈值，把 r_盘 撑到 402 px')
    print('   ⇒ 10 个环带有 8 个落在星系本体之外。**这不是星系的剖面，是掩膜的剖面。**')
    print('   （我第一版把判据写成「第 1 格之后应快速降到 0.2 以下」，与实测相反 ——')
    print('     判据自己算错方向比判据不响更坏，已改。）')
    print('   我们的渲染两张图之间是**同一几何、同一场景**，所以那之间的剖面差是有效的：')
    print('   核越集中，靠内几格越接近 1.0 且下降越快。')
    return 0


if __name__ == '__main__':
    sys.exit(main())

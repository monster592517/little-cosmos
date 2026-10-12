# -*- coding: utf-8 -*-
"""把**很小的**光点裁出来放大 —— 专门用来看「一个点精灵到底长什么样」。

为什么单独写一个（而不是改 `zoom-bulge.py`）：
`zoom-bulge.py` 按「亮度的 2%」找外接框、裁 220×220 —— 那是给**几百像素的核球**用的。
这里要看的对象只有 **2~3 像素**（盘面点云、被缩小的精灵就是这一档），
按 220 px 裁出来 99% 是背景，什么也看不出来。

判据配套：放大之后交给 `tools/check-bulge-shape.py` 量**对角比 / 面积占比**。
放大本身用 NEAREST（**不许插值** —— 插值会自己把方块磨圆，那就等于把被测对象改掉了）。

用法：
    py -3.13 -X utf8 tools/zoom-tiny.py shots/mp-on-s050.png [输出名.png] [半宽=12] [放大=24]
"""
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    half = int(sys.argv[3]) if len(sys.argv) > 3 else 12
    scale = int(sys.argv[4]) if len(sys.argv) > 4 else 24

    p = src if os.path.isabs(src) else os.path.join(SHOTS, src)
    if dst is None:
        dst = 'zoom-' + os.path.basename(p).replace('.png', '') + f'-x{scale}.png'
    out = dst if os.path.isabs(dst) else os.path.join(SHOTS, dst)

    im = Image.open(p).convert('RGB')
    a = np.asarray(im).astype(np.float64)
    lum = a @ np.array([0.2126, 0.7152, 0.0722])
    cy, cx = np.unravel_index(int(np.argmax(lum)), lum.shape)
    x0, x1 = max(0, cx - half), min(im.width, cx + half + 1)
    y0, y1 = max(0, cy - half), min(im.height, cy + half + 1)
    crop = im.crop((x0, y0, x1, y1))
    big = crop.resize(((x1 - x0) * scale, (y1 - y0) * scale), Image.NEAREST)
    big.save(out)
    print(f'{p}')
    print(f'  最亮像素 ({cx}, {cy}) · 峰值亮度 {lum.max():.1f} · '
          f'裁 {x1 - x0}×{y1 - y0} · NEAREST 放大 {scale}x')
    print(f'  画出这个点的**实际屏幕尺寸**：'
          f'{lum.max() >= 250 and "（已饱和，只能看形状）" or ""}')
    print(f'  → {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

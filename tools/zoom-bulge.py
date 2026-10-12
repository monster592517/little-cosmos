# -*- coding: utf-8 -*-
"""把核球所在区域裁出来、放大 5 倍（最近邻），落盘成图供**目检**。

数字判据（`check-bulge-shape.py`）负责说"像不像圆"，
这个脚本负责让我**真的看一眼** —— 两类判据本来就是互补的：
量具会算错方向，眼睛会看出量具没想到的东西。
"""
import sys, os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'ablate-05-mw-bulge.png'
    dst = sys.argv[2] if len(sys.argv) > 2 else 'zoom-bulge.png'
    scale = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    p = src if os.path.isabs(src) else os.path.join(SHOTS, src)
    im = Image.open(p).convert('RGB')
    a = np.asarray(im).astype(np.float64)
    g = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    th = g.max() * 0.02
    ys, xs = np.nonzero(g > th)
    if len(xs) == 0:
        print('图上没有超过阈值的东西')
        return 1
    cx, cy = int(xs.mean()), int(ys.mean())
    half = 110
    x0, x1 = max(0, cx - half), min(im.width, cx + half)
    y0, y1 = max(0, cy - half), min(im.height, cy + half)
    crop = im.crop((x0, y0, x1, y1)).resize(
        ((x1 - x0) * scale, (y1 - y0) * scale), Image.NEAREST)
    out = os.path.join(SHOTS, dst)
    crop.save(out)
    print(f'{p}')
    print(f'  质心 ({cx}, {cy}) · 裁 {x1 - x0}×{y1 - y0} · 放大 {scale}x')
    print(f'  → {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

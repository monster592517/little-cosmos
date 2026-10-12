# -*- coding: utf-8 -*-
"""把一张图的**等亮度轮廓**打成字符画 + 逐行宽度表，用来判断形状。

`check-bulge-shape.py` 只给两个标量（面积占比、对角比），标量会被
「亮斑 + 一圈很淡的大光晕」这种组合骗过去。这个脚本把形状**直接画出来**，
顺便给一条判据：**逐行宽度曲线**。
  · 正圆：`w(y)/w_max = sqrt(1 − (2y/h)²)` ⇒ 在 25%/50%/75% 高处分别是 0.97/0.87/0.66
  · 正方：全程 ≈ 1.00
"""
import sys, os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
COLS, ROWS = 78, 34


def mask_of(path, rel=0.04):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.float64)
    g = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    th = g.max() * rel
    return g, g > th, th


def ascii_art(m, maxv):
    H, W = m.shape
    out = []
    for r in range(ROWS):
        y0, y1 = int(r * H / ROWS), max(int((r + 1) * H / ROWS), int(r * H / ROWS) + 1)
        line = []
        for c in range(COLS):
            x0, x1 = int(c * W / COLS), max(int((c + 1) * W / COLS), int(c * W / COLS) + 1)
            blk = m[y0:y1, x0:x1]
            f = blk.mean()
            line.append(' ' if f < 0.05 else ('.' if f < 0.3 else ('o' if f < 0.7 else '#')))
        out.append(''.join(line))
    return out


def widths(m):
    ys, xs = np.nonzero(m)
    y0, y1 = ys.min(), ys.max()
    h = y1 - y0 + 1
    ws = []
    for frac in (0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0):
        y = int(y0 + frac * (h - 1))
        row = np.nonzero(m[y])[0]
        ws.append((frac, 0 if len(row) == 0 else row.max() - row.min() + 1))
    return ws, h, xs.min(), xs.max()


def main():
    rel = 0.04
    if len(sys.argv) < 2:
        print('用法: python tools/dump-shape-mask.py <图> [相对阈值=0.04]')
        return 1
    rel = float(sys.argv[2]) if len(sys.argv) > 2 else rel
    p = sys.argv[1]
    if not os.path.isabs(p):
        p = os.path.join(SHOTS, p)
    g, m, th = mask_of(p, rel)
    H, W = m.shape
    print('=' * 78)
    print(f'  {os.path.basename(p)}   {W}×{H}   阈值 = 峰值 {g.max():.1f} × {rel} = {th:.2f}')
    print('-' * 78)
    for ln in ascii_art(m, m.size):
        print('  |' + ln + '|')
    print('-' * 78)
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        print('  阈值以上没有像素')
        return 0
    print(f'  外接框 {xs.max() - xs.min() + 1}×{ys.max() - ys.min() + 1}   '
          f'像素数 {len(xs)}   面积占比 {len(xs) / ((xs.max() - xs.min() + 1) * (ys.max() - ys.min() + 1)):.3f}')
    ws, h, xa, xb = widths(m)
    wmax = max(w for _, w in ws) or 1
    print('  逐行宽度（归一化；圆在 25/50/75% 处 ≈ 0.97/0.87/0.66，方全程 ≈ 1.00）：')
    print('    ' + '  '.join(f'{f * 100:.0f}%:{w / wmax:.2f}' for f, w in ws))
    print('=' * 78)
    return 0


if __name__ == '__main__':
    sys.exit(main())

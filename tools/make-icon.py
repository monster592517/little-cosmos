#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成桌面快捷方式图标：深空底 + 太阳 + 轨道环 + 行星。

用法： py -3.13 tools/make-icon.py
"""
import sys
import os
import math

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT_DIR = os.path.join(ROOT, "assets")
os.makedirs(OUT_DIR, exist_ok=True)
S = 512

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方形深空底（逐行渐变，注意必须保持 alpha=255，否则整张图会变透明）
r = int(S * 0.22)
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
bd.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(8, 14, 28, 255))
for y in range(S):
    t = y / S
    k = (1 - t) ** 1.6
    bd.line([(0, y), (S, y)],
            fill=(int(8 + 14 * k), int(14 + 30 * k), int(28 + 58 * k), 255))
img = Image.alpha_composite(img, bg)
d = ImageDraw.Draw(img)

cx, cy = int(S * 0.46), int(S * 0.5)
R = int(S * 0.16)

# 太阳光晕（收敛范围，避免糊满整张图）
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in range(22, 0, -1):
    rr = int(R * (1 + i * 0.075))
    a = int(120 * (1 - i / 22) ** 2.1)
    gd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(255, 170, 60, a))
glow = glow.filter(ImageFilter.GaussianBlur(S * 0.02))
img = Image.alpha_composite(img, glow)
d = ImageDraw.Draw(img)

# 太阳本体
for i in range(R, 0, -1):
    t = i / R
    col = (
        int(255 - 10 * t),
        int(250 - 120 * t),
        int(200 - 170 * t),
        255,
    )
    d.ellipse([cx - i, cy - i, cx + i, cy + i], fill=col)

# 轨道环（倾斜椭圆）
ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
rx, ry = int(S * 0.40), int(S * 0.155)
rd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], outline=(103, 232, 249, 235), width=max(3, S // 90))
# 内圈淡一点
rd.ellipse([cx - int(rx * 0.62), cy - int(ry * 0.62), cx + int(rx * 0.62), cy + int(ry * 0.62)],
           outline=(103, 232, 249, 90), width=max(2, S // 140))
img = Image.alpha_composite(img, ring)
d = ImageDraw.Draw(img)

# 轨道上的行星
ang = math.radians(-28)
px = cx + int(rx * math.cos(ang))
py = cy + int(ry * math.sin(ang))
pr = int(S * 0.052)
for i in range(pr, 0, -1):
    t = i / pr
    d.ellipse([px - i, py - i, px + i, py + i],
              fill=(int(90 + 80 * (1 - t)), int(170 + 60 * (1 - t)), 255, 255))

# 几颗背景星
for (sx, sy, sr) in [(0.15, 0.18, 3), (0.82, 0.22, 2), (0.9, 0.62, 3), (0.22, 0.82, 2), (0.68, 0.88, 2)]:
    d.ellipse([int(S * sx) - sr, int(S * sy) - sr, int(S * sx) + sr, int(S * sy) + sr],
              fill=(220, 235, 255, 210))

png = os.path.join(OUT_DIR, "icon.png")
img.save(png)
ico = os.path.join(OUT_DIR, "icon.ico")
img.save(ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print(f"  ok {png}")
print(f"  ok {ico}")

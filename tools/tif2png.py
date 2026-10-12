#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 Solar System Scope 的 TIFF 贴图转成浏览器可用的 PNG（法线/高光/云层遮罩）。

用法： py -3.13 tools/tif2png.py <输入目录>
"""
import sys
import os
import glob

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from PIL import Image

tex_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "textures")
tex_dir = os.path.abspath(tex_dir)

count = 0
for path in sorted(glob.glob(os.path.join(tex_dir, "*.tif")) + glob.glob(os.path.join(tex_dir, "*.tiff"))):
    out = os.path.splitext(path)[0] + ".png"
    try:
        im = Image.open(path)
        if im.mode not in ("RGB", "RGBA", "L"):
            im = im.convert("RGB")
        im.save(out, "PNG", optimize=True)
        print(f"  ok {os.path.basename(path)} -> {os.path.basename(out)} ({im.size[0]}x{im.size[1]}, {os.path.getsize(out)//1024} KB)")
        count += 1
    except Exception as e:
        print(f"  fail {os.path.basename(path)}: {e}")

print(f"converted {count} file(s)")

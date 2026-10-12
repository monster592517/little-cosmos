#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
诊断（只读）· 把**银河系盘面贴图**原图导出成 PNG。

用法： py -3.13 -X utf8 tools/dump-mw-texture.py [url] [--outdir=shots]

为什么必须先做这一步
------------------------------------------------------------------
用户说「银河系这样子还是太差了」，而这句抱怨对应**两种完全不同的病**：

  (a) **贴图本身画得差** —— 那张 1024×1024 的 canvas 上就是一团糊；
  (b) **贴图画得行，但渲染时看不见** —— 被银盘点云盖住、被 additive 口径冲淡、
      被泛光洗平、opacity 太低、或者贴的那个平面根本没朝向盘面。

这两者的修法**毫无交集**（改 `proc/textures.js` 的画法 vs 改 `levels/galaxy.js`
的渲染/透明度）。在没分清之前动手 = 归因抢跑。

本脚本把渲染管线里的**那一张 canvas 原图**直接取出来落盘，
一眼就能分辨 (a) 与 (b)：贴图取的是 `material.map.image`（`CanvasTexture`
的 image 就是生成它的那个 `<canvas>`），**不重新生成、不经过任何渲染**。
"""

import os
import sys
import base64
import argparse

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOTS = os.path.join(ROOT, "shots")

SETTLE_JS = r"""
async (level) => {
  const u = window.__universe;
  u.gotoScale(level);
  const t0 = performance.now();
  while (performance.now() - t0 < 40000) {
    const e = u.engine;
    if (e.current && e.current.id === level && !e.transition && e.current.scene) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}
"""

DUMP_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const out = { level: lv.id, found: [] };
  const grab = (o, tag) => {
    const m = o && o.material;
    const img = m && m.map && m.map.image;
    if (!img || !img.toDataURL) return;
    out.found.push({
      tag: tag,
      name: o.name || null,
      w: img.width, h: img.height,
      opacity: m.opacity,
      blending: m.blending,
      colorSpace: m.map.colorSpace,
      hasAlpha: m.transparent,
      data: img.toDataURL('image/png'),
    });
  };
  for (const o of (lv.scene.children || [])) {
    if (o.name === 'galaxy-disc' && o.userData && o.userData.bodyId === 'milkyway') grab(o, 'milkyway-disc');
    if (o.name === 'mw-disk-glow') grab(o, 'mw-disk-glow');
  }
  return out;
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    ap.add_argument("--outdir", default=SHOTS)
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ])
        page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_function(
            "() => window.__universe && window.__universe.engine && window.__universe.dataset"
            " && window.__universe.dataset.galaxies && window.__universe.dataset.galaxies.length > 0",
            timeout=60000,
        )
        written = []
        for level in ("localgroup", "galaxy"):
            if not page.evaluate(SETTLE_JS, level):
                print(f"  FAIL  切不到 {level} 层")
                continue
            d = page.evaluate(DUMP_JS)
            for f in d["found"]:
                path = os.path.join(args.outdir, f"mw-texture-{level}-{f['tag']}.png")
                with open(path, "wb") as fh:
                    fh.write(base64.b64decode(f["data"].split(",", 1)[1]))
                written.append(path)
                print(f"  [{level}] {f['tag']:<16} {f['w']}×{f['h']}"
                      f" · opacity {f['opacity']} · blending {f['blending']}"
                      f" · transparent {f['hasAlpha']} · 对象名 {f['name']}")
                print(f"        → {path}")
            if not d["found"]:
                print(f"  [{level}] 没找到带贴图的盘 —— 检查对象名/bodyId")
        browser.close()

    if written:
        print(f"\n  导出 {len(written)} 张。**目检它们**：\n"
              f"  · 贴图上有清晰旋臂 + 暗尘埃带 ⇒ 病在**渲染**（去 {ROOT}/web/js/levels/galaxy.js 找 opacity / 叠放）\n"
              f"  · 贴图本身就是一团糊 ⇒ 病在**画法**（去 web/js/proc/textures.js）")


if __name__ == "__main__":
    main()

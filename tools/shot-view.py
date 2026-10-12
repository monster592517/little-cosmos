#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通用截图工具：切到某一层、摆一个**由 (视距, 方位, 仰角) 决定**的机位、截图。

用法：
  py -3.13 -X utf8 tools/shot-view.py --level=galaxy --dist=70.7 --out=shots/x.png
  py -3.13 -X utf8 tools/shot-view.py --level=galaxy --dist=70.7 --elev=27 --hide-labels

为什么要有它（而不是手写 `applyView({position:[...]})`）
------------------------------------------------------------------
用户报问题时报的是**他看到的那个画面**：「视距 70 千光年」。而 `applyView` 要的
是一个直角坐标。手算 `[0,39,59]` 这种数容易写错，而且**写错了不会报错** ——
只是截出来是另一个机位，然后我拿着一张不是他那个视角的图去归因。

这里把参数收敛成三个能对上用户描述的量：
  `dist`  = 视距（世界单位 = 该层的长度单位，层名写在底栏）
  `azim`  = 绕 Y 轴方位角（度，0 = 默认那个方向）
  `elev`  = 相对**水平面**的仰角（度）。⚠️ 默认视角 `[0,78,118]` 对应
            `atan(78/118) = 33.5°` —— 想复现「默认视角」就传 `--elev=33.5`。
默认机位方向与 `galaxy.js::defaultView()` / `cosmos.js::defaultView()` 一致。

⚠️ 截图前会**关自动旋转**：`autoRotate` 开着时每张图一个角度，
   两张图对比就全是噪声（这条踩过）。
"""

import os
import re
import sys
import math
import argparse

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

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

VIEW_JS = r"""
(o) => {
  const e = window.__universe.engine;
  const lv = e.current;
  if (o.hideLabels && lv.labels && lv.labels.setVisible) lv.labels.setVisible(false);
  lv.applyView({ position: o.position, target: o.target || [0, 0, 0] });
  if (e.controls) { e.controls.autoRotate = false; if (e.controls.update) e.controls.update(); }
  return {
    level: lv.id,
    camDist: +lv.camera.position.length().toFixed(3),
    camPos: [+lv.camera.position.x.toFixed(2), +lv.camera.position.y.toFixed(2), +lv.camera.position.z.toFixed(2)],
  };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    ap.add_argument("--level", default="galaxy")
    ap.add_argument("--dist", type=float, default=None, help="视距（世界单位）；缺省用该层的 defaultView")
    ap.add_argument("--azim", type=float, default=0.0, help="方位角（度）")
    ap.add_argument("--elev", type=float, default=33.5, help="仰角（度）；默认视角是 33.5")
    ap.add_argument("--out", default=None)
    ap.add_argument("--hide-labels", action="store_true")
    ap.add_argument("--settle", type=float, default=2.0, help="摆好机位后等几秒再截图（让 LOD/泛光稳定）")
    args = ap.parse_args()

    out = args.out or os.path.join(ROOT, "shots", f"{args.level}-view.png")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ])
        page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_function(
            "() => window.__universe && window.__universe.engine && window.__universe.dataset"
            " && window.__universe.dataset.galaxies && window.__universe.dataset.galaxies.length > 0",
            timeout=60000,
        )
        if not page.evaluate(SETTLE_JS, args.level):
            print(f"FAIL  切不到 {args.level} 层")
            browser.close()
            sys.exit(1)

        if args.dist is None:
            dv = page.evaluate("() => window.__universe.engine.current.defaultView()")
            pos = dv["position"]
            target = dv.get("target", [0, 0, 0])
            print(f"  用该层 defaultView：{pos}")
        else:
            e = math.radians(args.elev)
            a = math.radians(args.azim)
            pos = [args.dist * math.cos(e) * math.sin(a),
                   args.dist * math.sin(e),
                   args.dist * math.cos(e) * math.cos(a)]
            target = [0, 0, 0]
        r = page.evaluate(VIEW_JS, {"position": pos, "target": target, "hideLabels": args.hide_labels})
        print(f"  {r['level']} · 相机位 {r['camPos']} · 视距 {r['camDist']}")
        import time
        time.sleep(args.settle)
        page.screenshot(path=out)
        real = [x for x in errs if "favicon" not in x]
        print(f"  控制台错误 {len(real)} 条{'' if not real else '：' + str(real[:2])}")
        print(f"  → {out}")
        browser.close()


if __name__ == "__main__":
    main()

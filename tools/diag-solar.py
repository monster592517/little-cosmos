#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""太阳系版验收：截图 + 点击天体 + 属性面板 + 视角切换。"""
import sys
import time
import json
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

OUT = "shots"
errors = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"])
    pg = b.new_page(viewport={"width": 1680, "height": 940})
    pg.on("pageerror", lambda e: errors.append(f"[pageerror] {str(e)[:220]}"))
    pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text[:200]}") if m.type == "error" else None)
    pg.goto("http://127.0.0.1:8787/", wait_until="load", timeout=60000)
    pg.wait_for_selector("#boot.done", timeout=90000)
    time.sleep(3)

    def shot(name, wait=1.5):
        time.sleep(wait)
        pg.screenshot(path=f"{OUT}/{name}.png")
        print(f"  ✓ {name}.png", flush=True)

    shot("s01-overview", 2.5)

    # 视角预设
    for label, name in [("内行星", "s02-inner"), ("外行星", "s03-outer"), ("小行星带", "s04-belt"), ("柯伊伯带", "s05-kuiper")]:
        pg.click(f"#level-nav button:has-text('{label}')")
        shot(name, 2.0)

    # 回到全景，点屏幕上的木星（用标签定位它的屏幕坐标）
    pg.click("#level-nav button:has-text('太阳系全景')")
    time.sleep(2)
    pos = pg.evaluate("""() => {
      const lv = window.__universe.engine.current;
      const p = lv.entries.get('jupiter').group.position.clone().project(lv.camera);
      return { x: (p.x*0.5+0.5)*window.innerWidth, y: (-p.y*0.5+0.5)*window.innerHeight };
    }""")
    print("  木星屏幕坐标:", json.dumps(pos), flush=True)
    pg.mouse.click(pos["x"], pos["y"])
    time.sleep(1.5)
    print("  面板标题:", pg.inner_text("#panel-title"), flush=True)
    body = pg.inner_text("#panel-body")
    print("  面板前 260 字:", body[:260].replace("\n", " | "), flush=True)
    shot("s06-jupiter-click", 0.6)

    # 点击地球（内行星视角下）
    pg.click("#level-nav button:has-text('内行星')")
    time.sleep(2.5)
    pos = pg.evaluate("""() => {
      const lv = window.__universe.engine.current;
      const p = lv.entries.get('earth').group.position.clone().project(lv.camera);
      return { x: (p.x*0.5+0.5)*window.innerWidth, y: (-p.y*0.5+0.5)*window.innerHeight };
    }""")
    pg.mouse.click(pos["x"], pos["y"])
    time.sleep(1.5)
    print("  地球面板:", pg.inner_text("#panel-body")[:300].replace("\n", " | "), flush=True)
    shot("s07-earth", 0.6)

    # 聚焦地球看 3D 建模
    pg.click("#panel-body [data-act='focus']")
    shot("s08-earth-focus", 4.0)

    # 搜索木卫二并聚焦
    pg.fill("#dest-input", "木卫二")
    time.sleep(0.8)
    pg.keyboard.press("Enter")
    time.sleep(3.5)
    shot("s09-europa", 1.0)

    # 目录
    pg.click("#btn-catalog")
    shot("s10-catalog", 1.2)

    print("\n=== errors ===")
    for e in errors[:25]:
        print("  " + e)
    if not errors:
        print("  (none)")
    b.close()

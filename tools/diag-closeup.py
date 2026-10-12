#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""3D 建模近景验收：逐个聚焦天体并截图。"""
import sys
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TARGETS = sys.argv[1].split(",") if len(sys.argv) > 1 else ["木星", "土星", "火星", "月球", "太阳", "木卫一"]
errors = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"])
    pg = b.new_page(viewport={"width": 1200, "height": 800})
    pg.on("pageerror", lambda e: errors.append(f"[pageerror] {str(e)[:200]}"))
    pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text[:160]}") if m.type == "error" else None)
    pg.goto("http://127.0.0.1:8787/", wait_until="load", timeout=60000)
    pg.wait_for_selector("#boot.done", timeout=90000)
    time.sleep(2)

    for name in TARGETS:
        pg.fill("#dest-input", name)
        time.sleep(0.7)
        pg.keyboard.press("Enter")
        time.sleep(5)
        path = f"shots/cu-{name}.png"
        pg.screenshot(path=path)
        print(f"  ✓ {path}", flush=True)

    print("\n=== errors ===")
    for e in errors[:20]:
        print("  " + e)
    if not errors:
        print("  (none)")
    b.close()

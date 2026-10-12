#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""彗星活动模型验收：把时钟推到哈雷近日点（2061-07-28），聚焦核，截图看彗发/双尾。"""
import sys
import os
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(_HERE, "..", "shots"))
URL = "http://127.0.0.1:8787/"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
        "--disable-dev-shm-usage",
    ])
    page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.goto(URL, wait_until="load", timeout=60000)
    page.wait_for_selector("#boot.done", timeout=120000)
    time.sleep(2.0)

    # 推到哈雷近日点
    page.evaluate("() => window.__universe.clock.setDate(new Date('2061-07-28T00:00:00Z'))")
    time.sleep(1.0)
    # 聚焦哈雷
    page.fill("#dest-input", "哈雷彗星")
    page.keyboard.press("Enter")
    time.sleep(3.5)
    page.screenshot(path=os.path.join(OUT, "verify-halley-perihelion.png"))
    print("  ✓ verify-halley-perihelion.png", flush=True)

    # 恩克（2P）近日点验证：2032-08（周期 3.3 年，粗取一次近日时刻）
    page.evaluate("() => window.__universe.clock.setDate(new Date('2032-08-15T00:00:00Z'))")
    time.sleep(1.0)
    page.fill("#dest-input", "恩克彗星")
    page.keyboard.press("Enter")
    time.sleep(3.5)
    page.screenshot(path=os.path.join(OUT, "verify-encke.png"))
    print("  ✓ verify-encke.png", flush=True)

    print("=== 错误 ===")
    if not errors:
        print("  （无）")
    for e in errors[:10]:
        print("  " + e)
    browser.close()

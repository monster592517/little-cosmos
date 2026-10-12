#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
视觉优化前置探针：逐层截图（尺度条 #scale-nav）+ 天体特写。
用法： py -3.13 -X utf8 tools/shot-levels.py [url] [outdir] [mode]
  mode = levels（默认，六层全景） | bodies（太阳系天体逐个特写） | all
"""
import sys
import os
import time
import json
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787/"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.normpath(os.path.join(_HERE, "..", "shots", "opt-before"))
MODE = sys.argv[3] if len(sys.argv) > 3 else "levels"
os.makedirs(OUT, exist_ok=True)

errors = []

# 天体特写清单：目的地名（搜索框输入）→ 文件名
BODIES = [
    ("太阳", "sun"), ("水星", "mercury"), ("金星", "venus"), ("地球", "earth"),
    ("月球", "moon"), ("火星", "mars"), ("木星", "jupiter"), ("土星", "saturn"),
    ("天王星", "uranus"), ("海王星", "neptune"), ("冥王星", "pluto"),
    ("谷神星", "ceres"), ("灶神星", "vesta"), ("哈雷彗星", "halley"),
    ("木卫一", "io"), ("木卫二", "europa"), ("土卫六", "titan"), ("土卫八", "iapetus"),
]

LEVELS = [
    ("太阳系", "solar"), ("邻近恒星系", "neighborhood"), ("银河系", "galaxy"),
    ("本星系群", "localgroup"), ("室女座超星系团", "supercluster"), ("可观测宇宙", "universe"),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
        "--disable-dev-shm-usage",
    ])
    page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text[:300]}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.goto(URL, wait_until="load", timeout=60000)
    page.wait_for_selector("#boot.done", timeout=120000)
    time.sleep(2.5)

    def wait_settled(level, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            st = page.evaluate("() => { const e = window.__universe.engine; return { c: e.current?.id, t: !!e.transition }; }")
            if st["c"] == level and not st["t"]:
                return True
            time.sleep(0.5)
        print(f"  ! {level} 未就绪", flush=True)
        return False

    def shot(name, wait=2.0):
        time.sleep(wait)
        path = os.path.join(OUT, f"{name}.png")
        page.screenshot(path=path)
        print(f"  ✓ {name}.png", flush=True)

    def goto_level(label, lv):
        page.click(f"#scale-nav button[data-scale='{lv}']")
        return wait_settled(lv)

    if MODE in ("levels", "all"):
        for label, lv in LEVELS:
            if goto_level(label, lv):
                shot(f"L-{lv}", 2.5)

    if MODE in ("bodies", "all"):
        # 回太阳系
        goto_level("太阳系", "solar")
        time.sleep(1.5)
        for label, name in BODIES:
            try:
                page.fill("#dest-input", label)
                time.sleep(0.3)
                page.keyboard.press("Enter")
                time.sleep(2.8)  # 等相机过渡
                shot(f"B-{name}", 0.4)
            except Exception as e:
                print(f"  ✗ {label}: {e}", flush=True)

    print("\n=== 控制台错误 ===")
    if not errors:
        print("  （无）")
    for e in errors[:30]:
        print("  " + e)
    browser.close()

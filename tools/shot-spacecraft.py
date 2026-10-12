#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""探测器构型建模验收：聚焦代表性探测器（覆盖 5 类基型 × 4 种模式）+ 面板载荷节。"""
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

# (搜索词, 文件名) —— 覆盖：rover / juno / voyager / boomed / apollo / parker / lander / sphere
PROBES = [
    ("毅力号", "sc-perseverance"),
    ("朱诺", "sc-juno"),
    ("旅行者 1", "sc-voyager1"),
    ("卡西尼", "sc-cassini"),
    ("阿波罗 11", "sc-apollo11"),
    ("帕克", "sc-parker"),
    ("嫦娥四号", "sc-change4"),
    ("惠更斯", "sc-huygens"),
    ("露西", "sc-lucy"),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
        "--disable-dev-shm-usage",
    ])
    page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text[:300]}") if m.type == "error" else None)
    page.goto(URL, wait_until="load", timeout=60000)
    page.wait_for_selector("#boot.done", timeout=120000)
    time.sleep(2.5)

    for label, name in PROBES:
        try:
            page.fill("#dest-input", label)
            time.sleep(0.3)
            page.keyboard.press("Enter")
            time.sleep(3.2)
            page.screenshot(path=os.path.join(OUT, f"{name}.png"))
            print(f"  ✓ {name}.png", flush=True)
        except Exception as e:
            print(f"  ✗ {label}: {e}", flush=True)

    # 面板：打开毅力号详情，截「科学载荷」节
    page.fill("#dest-input", "毅力号")
    page.keyboard.press("Enter")
    time.sleep(2.5)
    try:
        page.click("#btn-catalog")  # 打开目录面板（详情走 onSelect）
        time.sleep(1.0)
    except Exception:
        pass
    page.screenshot(path=os.path.join(OUT, "sc-panel.png"))
    print("  ✓ sc-panel.png", flush=True)

    print("=== 错误 ===")
    if not errors:
        print("  （无）")
    for e in errors[:15]:
        print("  " + e)
    browser.close()

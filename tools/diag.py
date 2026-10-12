#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""交互诊断：逐层切换 + 面板打开，报告异常与状态。"""
import sys
import time
import json
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787/"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"])
    page = browser.new_page(viewport={"width": 1440, "height": 810})
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text[:220]}") if m.type == "error" else None)
    page.goto(URL, wait_until="load", timeout=60000)
    page.wait_for_selector("#boot.done", timeout=90000)
    time.sleep(2)

    def state(tag):
        s = page.evaluate("""() => {
          const e = window.__universe.engine;
          return { current: e.current?.id, transition: !!e.transition,
                   panelTitle: document.getElementById('panel-title').textContent,
                   panelHidden: document.getElementById('panel').hidden,
                   crumb: document.getElementById('crumb').textContent.slice(0, 40),
                   scale: document.getElementById('scalebar').textContent };
        }""")
        print(f"{tag:24s} {json.dumps(s, ensure_ascii=False)}", flush=True)

    state("boot")
    for label, lv in [("太阳系", "solar"), ("邻近恒星系", "neighborhood"), ("银河系", "galaxy"),
                      ("本星系群", "localgroup"), ("可观测宇宙", "universe")]:
        page.click(f"#level-nav button:has-text('{label}')")
        time.sleep(2.6)
        state(lv)

    page.click("#btn-catalog")
    time.sleep(1.5)
    state("catalog")

    page.click("#panel-close")
    page.click("#btn-research")
    time.sleep(1.0)
    state("research")

    print("\n=== errors ===")
    for e in errors[:30]:
        print("  " + e)
    if not errors:
        print("  (none)")
    browser.close()

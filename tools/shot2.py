#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""视觉验收（等待稳定帧后再截图，避免软件渲染下的空帧）。

用法： py -3.13 tools/shot2.py [标签1,标签2,...]
"""
import sys
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

VIEWS = sys.argv[1].split(",") if len(sys.argv) > 1 else ["太阳系全景", "内行星", "外行星", "小行星带", "柯伊伯带"]
errors = []


def stable(page, frames=4, timeout=20):
    """等若干帧真正画完（软件渲染下截图很容易抓到空帧）"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            page.evaluate("""() => new Promise(res => {
                let n = 0;
                const step = () => { n++; if (n >= 4) res(true); else requestAnimationFrame(step); };
                requestAnimationFrame(step);
            })""")
            return
        except Exception:
            time.sleep(0.5)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"])
    pg = b.new_page(viewport={"width": 1680, "height": 940})
    pg.on("pageerror", lambda e: errors.append(f"[pageerror] {str(e)[:220]}"))
    pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text[:200]}") if m.type == "error" else None)
    pg.goto("http://127.0.0.1:8787/", wait_until="load", timeout=60000)
    pg.wait_for_selector("#boot.done", timeout=90000)
    time.sleep(2)

    for i, label in enumerate(VIEWS):
        pg.click(f"#level-nav button:has-text('{label}')")
        time.sleep(3.2)          # 等相机补间动画结束
        stable(pg)
        time.sleep(0.8)
        stable(pg)
        path = f"shots/v{i+1}-{label}.png"
        pg.screenshot(path=path)
        print(f"  ✓ {path}", flush=True)

    # 太阳属性面板
    pg.fill("#dest-input", "太阳")
    time.sleep(0.8)
    pg.keyboard.press("Enter")
    time.sleep(3)
    stable(pg)
    print("  太阳面板：", pg.inner_text("#panel-body")[:400].replace("\n", " | "), flush=True)
    pg.screenshot(path="shots/v6-太阳面板.png")

    print("\n=== errors ===")
    for e in errors[:20]:
        print("  " + e)
    if not errors:
        print("  (none)")
    b.close()

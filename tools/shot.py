#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
无头浏览器验收脚本：逐层截图 + 收集控制台错误。

用法： py -3.13 tools/shot.py [url] [outdir]
依赖： Python Playwright（本机已装，浏览器在 %LOCALAPPDATA%\\ms-playwright）
"""
import sys
import os
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787/"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shots")
os.makedirs(OUT, exist_ok=True)

errors = []
logs = []


def shot(page, name, wait=1.6):
    time.sleep(wait)
    path = os.path.join(OUT, f"{name}.png")
    page.screenshot(path=path)
    print(f"  ✓ {name}.png")
    return path


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--enable-unsafe-swiftshader",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ])
        page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
        page.on("console", lambda m: (errors if m.type == "error" else logs).append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        page.on("requestfailed", lambda r: errors.append(f"[requestfailed] {r.url} {r.failure}"))

        print(f"打开 {URL}")
        page.goto(URL, wait_until="load", timeout=60000)

        try:
            page.wait_for_selector("#boot.done", timeout=90000)
            print("  ✓ 启动完成")
        except Exception as e:
            print(f"  ✗ 启动超时：{e}")
            shot(page, "00-boot-stuck", 0.5)
            dump(browser)
            return

        shot(page, "01-solar", 2.5)

        def wait_settled(level, timeout=45):
            """等场景构建与过渡结束"""
            end = time.time() + timeout
            while time.time() < end:
                st = page.evaluate("() => { const e = window.__universe.engine; return { c: e.current?.id, t: !!e.transition }; }")
                if st["c"] == level and not st["t"]:
                    return True
                time.sleep(0.5)
            print(f"  ! {level} 未在 {timeout}s 内就绪")
            return False

        # 逐层切换
        for label, name, lv in [("邻近恒星系", "02-neighborhood", "neighborhood"), ("银河系", "03-galaxy", "galaxy"),
                                ("本星系群", "04-localgroup", "localgroup"), ("可观测宇宙", "05-universe", "universe")]:
            page.click(f"#level-nav button:has-text('{label}')")
            wait_settled(lv)
            shot(page, name, 2.0)

        # 回太阳系，聚焦木星
        page.click("#level-nav button:has-text('太阳系')")
        wait_settled("solar")
        page.fill("#dest-input", "木星")
        time.sleep(0.6)
        shot(page, "06-dest-search", 0.4)
        page.keyboard.press("Enter")
        time.sleep(3.0)
        shot(page, "07-jupiter", 0.5)

        # 目录
        page.click("#btn-catalog")
        shot(page, "08-catalog", 1.2)
        page.click("#panel-close")

        # 研究面板 + 检索
        page.click("#btn-research")
        time.sleep(0.8)
        page.fill("#rs-input", "Europa subsurface ocean")
        page.click("#rs-go")
        time.sleep(12)
        shot(page, "09-research", 0.8)

        # 命令面板
        page.keyboard.press("Escape")
        page.click("#panel-close")
        page.keyboard.press("Control+k")
        time.sleep(0.5)
        page.fill("#palette-input", "比邻星")
        shot(page, "10-palette", 0.6)
        page.keyboard.press("Enter")
        shot(page, "11-proxima", 3.0)

        # 设置 / 帮助
        page.click("#btn-help")
        shot(page, "12-help", 1.0)

        dump(browser)


def dump(browser):
    print("\n=== 控制台错误 ===")
    if not errors:
        print("  （无）")
    for e in errors[:40]:
        print("  " + e)
    warn = [l for l in logs if l.startswith("[warning]")]
    if warn:
        print("=== 警告 ===")
        for w in warn[:20]:
            print("  " + w)
    browser.close()


main()

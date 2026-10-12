#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""端到端验证「天体 → 最新研究 → 中文翻译」链路。"""
import sys
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=[
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto("http://127.0.0.1:8787/", wait_until="load", timeout=60000)
    pg.wait_for_selector("#boot.done", timeout=90000)
    time.sleep(2)

    # 1) 搜索目的地「木卫二」并打开资料
    pg.fill("#dest-input", "木卫二")
    time.sleep(0.8)
    pg.keyboard.press("Enter")
    time.sleep(2.5)
    print("面板标题:", pg.inner_text("#panel-title"))
    print("天体名:", pg.inner_text("#panel-body h2").strip())

    # 2) 点「查看最新研究进展」
    pg.click("#panel-body [data-act='research']")
    time.sleep(1.0)
    print("面板标题:", pg.inner_text("#panel-title"))
    status = pg.inner_text("#rs-status")
    print("检索状态:", status.replace("\n", " ")[:160])

    # 等结果
    for _ in range(40):
        if pg.query_selector(".paper"):
            break
        time.sleep(1)
    papers = pg.query_selector_all(".paper")
    print("结果条数:", len(papers))
    if papers:
        title = papers[0].query_selector("h4").inner_text()
        print("首条标题:", title[:90])

        # 3) 点「译为中文」
        btn = papers[0].query_selector("[data-translate]")
        btn.click()
        for _ in range(60):
            txt = papers[0].query_selector(".abs").inner_text()
            if "翻译中" not in txt and len(txt) > 20:
                break
            time.sleep(1)
        zh = papers[0].query_selector(".abs").inner_text()
        print("中文摘要前 120 字:", zh[:120].replace("\n", " "))
        print("是否中文:", any('\u4e00' <= c <= '\u9fff' for c in zh))

        # 4) 生成 AI 进展简报
        pg.click("#rs-summary")
        for _ in range(90):
            box = pg.query_selector("#rs-summary-box")
            t = box.inner_text() if box else ""
            if "正在让模型" not in t and len(t) > 60:
                break
            time.sleep(1)
        print("简报前 160 字:", (box.inner_text() if box else "")[:160].replace("\n", " "))

    print("页面错误:", errs or "无")
    b.close()

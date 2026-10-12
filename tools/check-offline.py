#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
判据 · **离线自足**：页面在「一切非本地请求都被阻断」的条件下必须完整跑起来。

用法：
  py -3.13 -X utf8 tools/check-offline.py [url] [--levels=6] [--outdir=shots]

为什么要有它
------------------------------------------------------------------
「所有东西都能本地跑，不需要格外的 API」这句话必须**验**，不能靠 grep 源码。

grep 只能说明「源码里没写着要联网」，说明不了：
  · 有没有动态拼出来的地址（`${host}/api` 这种，grep 看不见）；
  · 有没有哪个库在初始化时偷偷拉一次远端；
  · 有没有「本地跑得通、但走到某个功能才炸」。

⇒ 这个脚本在**请求层**做隔离：把 Playwright 的路由拦下来，
**只放行 127.0.0.1 / localhost，其余一律 `abort()` 并记账**，
然后走一遍核心链路（启动 → 六个尺度逐层构建 → 每层渲染出画面）。

⚠️ **判据必须自证**：如果拦截器根本没生效，「外部请求 0 条」这个读数
   与「拦截器空转」长得一模一样（都是 0）。
   ⇒ 页面就绪后会**主动**请求一个外部地址（`example.invalid`，保留域名），
     断言它**被记账**了。记不到 = 拦截器是哑的 ⇒ 后面所有结论作废。

⚠️ 它**不判**「论文检索 / 中文翻译」能不能用 —— 那两个功能按设计就要联网
   （arXiv / OpenAlex / Crossref / Semantic Scholar / Google 翻译 / MyMemory，
   全是免密钥的公开接口）。本脚本判的是：**它们不在的时候，别的都照跑**。
"""

import os
import sys
import argparse

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOTS = os.path.join(ROOT, "shots")

# 核心链路：六个尺度逐层走一遍（`scales.js` 的层级 id）
ALL_LEVELS = ["solar", "neighborhood", "galaxy", "localgroup", "supercluster", "universe"]

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

# 每层：对象数 + 标签数。**亮度不走 GL 读回** —— 见下面 `shoot_lum()` 那段。
LEVEL_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  return {
    level: lv.id,
    objects: (lv.scene.children || []).length,
    labels: lv.labels && lv.labels.items ? lv.labels.items.size : null,
  };
}
"""


def shoot_lum(page):
    """截整屏 → 返回 (最亮, 均值)。

    ⚠️ 第一版用「GL 读回 + 在 15%–85% 区域上打 10×10 个采样点」。实测**本星系群层报全黑
    （maxLum 0）**，而同一时刻的截图里盘明明在 —— 因为那一层的内容**本身就是稀疏的**
    （几十个 8–126 px 的盘撒在 1680×940 上），稀疏采样点全落进空隙。
    ⇒ 改成**整屏截图 + 逐像素**：不与对象分布打赌。
    ⚠️ 也**不要**用 `gl.readPixels` 读整屏（1.5 M 像素 × 4 通道一次回读会明显拖慢 swiftshader）。
    """
    import io
    import numpy as np
    from PIL import Image
    im = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
    lum = np.asarray(im).max(axis=2)
    return int(lum.max()), float(lum.mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    ap.add_argument("--outdir", default=SHOTS)
    ap.add_argument("--levels", type=int, default=6, help="走前 N 个尺度（默认 6 = 全部）")
    ap.add_argument("--screenshot", default=None)
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    fails = []
    total = [0]

    def check(name, ok, detail):
        total[0] += 1
        print(f"  {'OK ' if ok else 'FAIL'}  {name}")
        print(f"        {detail}")
        if not ok:
            fails.append(name)

    blocked = []          # 被 abort 的外部请求（按 url 去重前后都记）
    local_count = [0]

    def on_route(route):
        url = route.request.url
        if url.startswith("http://127.0.0.1") or url.startswith("http://localhost"):
            local_count[0] += 1
            route.continue_()
        else:
            blocked.append(url)
            route.abort()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ])
        page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.route("**/*", on_route)

        print(f"\n  目标：{args.url}")
        print("  隔离方式：只放行 127.0.0.1 / localhost，其余请求 abort 并记账\n")

        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_function(
            "() => window.__universe && window.__universe.engine && window.__universe.dataset"
            " && window.__universe.dataset.galaxies && window.__universe.dataset.galaxies.length > 0",
            timeout=120000,
        )
        # ★ 启动屏要**等**，不能立即查。
        #   第一版在 dataset 就绪后立刻读 `#boot.done` ⇒ 报 False，
        #   而同一时刻的截图里页面早就完整跑起来了（银河系盘、标签、底栏视距全在）——
        #   `bootEl.classList.add('done')` 发生在数据装载的**最后一帧**，比 dataset 就绪晚。
        #   这不是页面故障，是判据没等（「判据自己算错方向比判据不响更坏」）。
        try:
            page.wait_for_function(
                "() => { const b = document.getElementById('boot');"
                " return !b || b.classList.contains('done') || b.style.display === 'none'; }",
                timeout=45000,
            )
            boot_ok = True
        except Exception:
            boot_ok = False

        # ★ 拦截器自证：主动打一个外部地址，它必须被记账。
        #   `example.invalid` 是保留域名（DNS 必然失败）—— 所以**不能**用
        #   「fetch 有没有报错」当判据（拦截器坏了它也会报错）。判据只看**记账条数**。
        #   ⚠️ 这次 fetch 会在控制台留下一条 `net::ERR_FAILED`，属于**探针自己制造的噪声**，
        #      下面统计控制台错误时按 URL 把它滤掉（否则永远红一条）。
        before = len(blocked)
        page.evaluate("() => fetch('https://example.invalid/offline-probe').catch(() => 'x')")
        page.wait_for_timeout(600)
        probe_recorded = len(blocked) > before

        check("拦截器真的在工作（自证：主动请求外部地址必须被记账）",
              probe_recorded,
              f"自证请求后记账条数 {before} → {len(blocked)}"
              + ("" if probe_recorded else " ⇒ 拦截器是哑的，下面「外部请求 0 条」等于没测"))

        # 把自证那条剔掉，剩下的才是页面自己发起的
        page_made = [u for u in blocked if "example.invalid" not in u]
        check("页面自身**零**外部请求",
              len(page_made) == 0,
              f"本地请求 {local_count[0]} 条 · 页面发起的外部请求 {len(page_made)} 条"
              + (f"：{page_made[:5]}" if page_made else " ✓"))

        check("启动屏已收起（数据装载完成）", bool(boot_ok), f"#boot.done = {boot_ok}")

        # 逐层走一遍
        print("\n  六个尺度逐层构建（禁用外网条件下）")
        rows = []
        for lv_id in ALL_LEVELS[: args.levels]:
            ok = page.evaluate(SETTLE_JS, lv_id)
            if not ok:
                rows.append({"level": lv_id, "ok": False, "maxLum": 0})
                print(f"    {lv_id:<14} ★切不过去★")
                continue
            page.wait_for_timeout(700)                    # 让首帧稳定再截
            info = page.evaluate(LEVEL_JS)
            mx, mean = shoot_lum(page)
            info.update({"ok": True, "maxLum": mx, "meanLum": round(mean, 1)})
            rows.append(info)
            print(f"    {info['level']:<14} 顶层对象 {info['objects']:>3} · 标签 {info['labels']}"
                  f" · 整屏最亮 {mx:>3} · 均值 {mean:>6.2f}")

        check("六个尺度全部能构建出来",
              len(rows) == len(ALL_LEVELS[: args.levels]) and all(r.get("ok") for r in rows),
              f"{sum(1 for r in rows if r.get('ok'))} / {len(ALL_LEVELS[: args.levels])} 层成功"
              f"（失败：{[r['level'] for r in rows if not r.get('ok')] or '无'}）")
        dark = [r["level"] for r in rows if r.get("ok") and r["maxLum"] < 30]
        check("每一层都真的渲染出了画面（整屏最亮像素 ≥ 30/255）",
              not dark,
              f"偏黑的层：{dark or '无'}（全黑 = 建起来了但没画出来）"
              f" · 各层最亮 {[(r['level'], r['maxLum']) for r in rows if r.get('ok')]}")

        # ⚠️ 滤掉**探针自己**制造的那条：自证用的 `fetch('example.invalid')` 被 abort，
        #    浏览器必然在控制台留一条 `net::ERR_FAILED`。不滤掉的话这条判据永远是红的，
        #    而它红的原因跟被测对象无关（同族教训：探针的输出不许污染被测对象的读数）。
        real_errs = [e for e in errs
                     if "favicon" not in e and "ERR_FAILED" not in e]
        check("控制台零错误（已滤掉自证 probe 的 ERR_FAILED 与 favicon）",
              not real_errs,
              f"{len(real_errs)} 条{'' if not real_errs else '：' + str(real_errs[:3])}"
              f" · 全部原始错误 {len(errs)} 条")

        shot = args.screenshot or os.path.join(args.outdir, "offline-check.png")
        # 回到有内容的默认视角再截图
        page.evaluate(SETTLE_JS, "galaxy")
        page.wait_for_timeout(1500)
        page.screenshot(path=shot)
        print(f"\n  截图：{shot}")
        print(f"  记账的外部请求共 {len(blocked)} 条（含自证 1 条）"
              f"{'' if not blocked else '：' + str(sorted(set(blocked))[:6])}")
        browser.close()

    print()
    if fails:
        print(f"  ✗ 失败 {len(fails)} 项：{', '.join(fails)}")
        print(f"  （共 {total[0]} 项判据）")
        sys.exit(1)
    print(f"  全部通过：{total[0]} 项判据 —— 这套东西**完全本地自足**。")
    print("  ⚠️ 例外（按设计就要联网、不影响本地运行）：论文检索（arXiv/OpenAlex/Crossref/"
          "Semantic Scholar）· 中文翻译（Google/MyMemory）—— 都免密钥，都是用户点了才走。")


if __name__ == "__main__":
    main()

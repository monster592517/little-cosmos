#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
诊断（只读）· 本星系群层**星系盘尺寸**：合并后直径的完整性 + 场景里的真实尺寸分布。

用法： py -3.13 -X utf8 tools/diag-lg-disc-size.py [url]

为什么要有它
------------------------------------------------------------------
用户报「本星系群这下面有一些没命名的星系全在和别的星系圈重叠在一起」。
第一嫌疑是 `cosmos.js` 里那行尺寸映射。但**不能照着那行就下结论**：

  · `dataset.galaxies` 是**手写目录 ∪ 星表**合并后的结果，而合并是**字段级**的
    （`mergeGalaxies` 里 `{ ...base, ...g }`，手写逐字段覆盖星表）。
    星表里 `diameterLy: null` 的 9 条（银河系 / M31 / M33 / LMC / SMC …）
    合并后**未必**还是 null —— 手写那 20 条自带直径。
    ⇒ 必须读**合并后**的那一份，不能读原始 `data/local-group.json`。

  · 尺寸的**终值**必须从**场景里的盘对象**读（`geometry.parameters.width`
    —— `makeGalaxyDisc` 用的是 `PlaneGeometry(size, size)`），
    **不要**在这个脚本里复刻一遍公式：那是第二份实现，改完源码它就会和真相
    不符，而且**不会报错**。

本脚本只打印，不改任何东西。
"""

import os
import sys
import json
import argparse

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

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

# ① 数据侧：合并后的直径完整性（**只有事实，没有公式**）。
DATA_JS = r"""
() => {
  const d = window.__universe.dataset;
  const g = d.galaxies || [];
  const ds = g.map((x) => x.diameterLy).filter((v) => typeof v === 'number' && isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const q = (p) => ds[Math.min(ds.length - 1, Math.floor(ds.length * p))];
  return {
    total: g.length,
    withDiam: ds.length,
    diam: { min: ds[0], p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), max: ds[ds.length - 1] },
    missing: g.filter((x) => !(typeof x.diameterLy === 'number' && isFinite(x.diameterLy) && x.diameterLy > 0))
      .map((x) => x.id + ' [' + (x.provenance || '?') + ' · ' + (x.group || '无组') + ']'),
  };
}
"""

# ② 场景侧：**从盘对象读终值**（`PlaneGeometry(size, size)` ⇒ parameters.width）。
#    并直接验证映射的**单调性**不变式：按真实直径排序后，size 必须单调不减。
SCENE_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  const discs = (lv.scene.children || []).filter((o) => o.name === 'galaxy-disc');
  const rows = [];
  for (const o of discs) {
    const b = o.userData && o.userData.bodyId ? u.dataset.bodies.get(o.userData.bodyId) : null;
    const p = o.geometry && o.geometry.parameters ? o.geometry.parameters : null;
    rows.push({
      id: o.userData ? o.userData.bodyId : null,
      size: p ? +p.width.toFixed(5) : null,
      diam: b && typeof b.diameterLy === 'number' && isFinite(b.diameterLy) ? b.diameterLy : null,
      visible: o.visible,
    });
  }
  const sizes = rows.map((r) => r.size).filter((v) => v != null).sort((a, b) => a - b);
  const hist = {};
  for (const s of sizes) hist[s.toFixed(4)] = (hist[s.toFixed(4)] || 0) + 1;
  /* 单调性：有直径的那些，按直径升序 → size 必须不减。
   * ⚠️ 这只看**顺序**，与具体系数无关 —— 所以它抓的是「有人给某个星系手调了
   *    大小」这类破坏，抓不到「所有值一起缩了一半」。 */
  const withBoth = rows.filter((r) => r.size != null && r.diam != null).sort((a, b) => a.diam - b.diam);
  const viol = [];
  for (let i = 1; i < withBoth.length; i++) {
    if (withBoth[i].size < withBoth[i - 1].size - 1e-9) {
      viol.push(withBoth[i - 1].id + '(' + withBoth[i - 1].diam + '→' + withBoth[i - 1].size + ')'
        + ' > ' + withBoth[i].id + '(' + withBoth[i].diam + '→' + withBoth[i].size + ')');
    }
  }
  const px = (s) => {
    const h = u.engine.size.h, fov = lv.camera.fov * Math.PI / 180;
    const d = lv.camera.position.length();
    return +(s * (h / 2) / (d * Math.tan(fov / 2))).toFixed(1);
  };
  return {
    total: discs.length,
    visible: rows.filter((r) => r.visible).length,
    distinct: Object.keys(hist).length,
    sizeMin: sizes[0], sizeMax: sizes[sizes.length - 1],
    sizeP50: sizes[Math.floor(sizes.length * 0.5)],
    camDist: +lv.camera.position.length().toFixed(3),
    pxMin: px(sizes[0]), pxMax: px(sizes[sizes.length - 1]), pxP50: px(sizes[Math.floor(sizes.length * 0.5)]),
    histogram: Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => s + ' × ' + n),
    monotonic: viol.length === 0,
    violations: viol.slice(0, 6),
    extremes: withBoth.slice(0, 3).map((r) => r.id + ' ' + r.diam + 'ly → ' + r.size + ' (' + px(r.size) + 'px)')
      .concat(withBoth.slice(-4).map((r) => r.id + ' ' + r.diam + 'ly → ' + r.size + ' (' + px(r.size) + 'px)')),
  };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ])
        page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_function(
            "() => window.__universe && window.__universe.engine && window.__universe.dataset"
            " && window.__universe.dataset.galaxies && window.__universe.dataset.galaxies.length > 0",
            timeout=60000,
        )
        if not page.evaluate(SETTLE_JS, "localgroup"):
            print("FAIL  切不到 localgroup 层")
            browser.close()
            sys.exit(1)

        d = page.evaluate(DATA_JS)
        print("\n=== 合并后的 dataset.galaxies（渲染层用的那一份）===")
        print(f"  总条数 {d['total']} · 有直径 {d['withDiam']} · 缺直径 {d['total'] - d['withDiam']}")
        print(f"  真实直径 ly  min {d['diam']['min']} · p25 {d['diam']['p25']} · p50 {d['diam']['p50']}"
              f" · p75 {d['diam']['p75']} · p90 {d['diam']['p90']} · max {d['diam']['max']}")
        if d["missing"]:
            print(f"  ⚠️ 缺直径的 {len(d['missing'])} 条（走兜底常量）：")
            for r in d["missing"]:
                print(f"    {r}")

        s = page.evaluate(SCENE_JS)
        print("\n=== 场景里的盘（终值从 geometry.parameters 读，不复刻公式）===")
        print(f"  盘对象 {s['total']} 个（可见 {s['visible']}）· 不同的尺寸取值 {s['distinct']} 种"
              f" · 相机距 {s['camDist']} Mly")
        print(f"  世界单位：[{s['sizeMin']}, {s['sizeMax']}] · 中位 {s['sizeP50']}")
        print(f"  屏幕直径 px：最小 {s['pxMin']} · 中位 {s['pxP50']} · 最大 {s['pxMax']}")
        print(f"  出现最多的尺寸：{'; '.join(s['histogram'])}")
        print(f"  单调性（直径大 ⇒ 尺寸不小）：{'✓ 成立' if s['monotonic'] else '✗ 被破坏'}")
        if not s["monotonic"]:
            for v in s["violations"]:
                print(f"    {v}")
        print("  两端样本：")
        for r in s["extremes"]:
            print(f"    {r}")
        browser.close()


if __name__ == "__main__":
    main()

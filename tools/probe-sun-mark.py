#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
银河系层「太阳系标记」验收探针（第 37 轮）。

用法： py -3.13 -X utf8 tools/probe-sun-mark.py [url] [--outdir=shots]

为什么要有这个探针
------------------------------------------------------------------
用户原话：「都这个尺度下了，你太阳系画个点不行吗」。

上一版是 `size: 0.85` 的**世界单位柔光团**。它「看不见」的原因不是不够亮，
而是**两个量纲都用错了**：

  · 尺寸用了世界单位 ⇒ 141.4 kly 下只有 ~6 px，而且是软边渐隐的 ⇒
    落在 362 px 宽、还带泛光的银盘点云上，**对比度为零**；
  · 同一个口径在相机拉近时会让它长成一团大光球 ——
    第 33 轮记的「银河系的第二个核」就是这个病的另一个形态。

⇒ 第 37 轮改成 `sizeAttenuation: false` 的**屏幕恒定尺寸标记**（实心点 + 星芒 +
一圈很淡的光晕），`depthTest: false` 让点云挡不住它。

这个改动**不能靠公式验收**：「size × cot(fov/2) 就是像素数」是它自己的定义式，
拿它当判据等于用定义证明定义（恒真）。所以本探针的主判据是**像素级消融**：

  钉住相机与 rAF ⇒ 手动渲一帧 ⇒ `gl.readPixels` 读标记周围一块区域 ⇒
  把两个 sprite `visible=false` ⇒ 再渲一帧 ⇒ **同一区域重读** ⇒
  逐像素差分的外接盒 = 这个标记**真的在屏幕上占了多少像素**。

  同一次测量顺带给出**对比度**（`maxDelta`）—— 这才是用户说的「看得见」。

判据自证会响（两条正对照，缺一条就是假绿）
------------------------------------------------------------------
  · **量具对尺寸敏感**：把 `scale` 乘 2 ⇒ 差分外接盒必须跟着变宽。
    不成立 ⇒ 下面的「尺寸落在合理范围」是**空判据**。
  · **拉远 2 倍屏幕尺寸不变**：这正是不衰减的定义；若量出来变了，
    说明改变生效不了（或者量错了对象）。

⚠️ 用 swiftshader 软件渲染（无头）。所以：
  · 像素读数与 draw call 可信（它们与谁执行无关）；
  · **帧时间不可信**，本探针不把它当判据，只打印参考值。
"""

import os
import sys
import json
import time
import argparse

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOTS = os.path.join(ROOT, "shots")

# 钉住画质档。⚠️ 必须**回读 `applyTier` 的返回值** —— 不存在的档位 id 会
#    **静默空转、零报错**（合法 id 只有 saver / balanced / high，见 core/gpu.js::TIERS）。
PIN_JS = r"""
(tier) => {
  const e = window.__universe.engine;
  if (e.gpu) e.gpu.tierPinned = true;
  const applied = tier ? (e.applyTier ? e.applyTier(tier) : false) : null;
  return { requested: tier || null, applied: applied, tier: e.tierId,
           pointBudget: e.tier ? e.tier.pointBudget : null };
}
"""

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

VIEW_JS = r"""
(o) => {
  const e = window.__universe.engine;
  const lv = e.current;
  if (o.hideLabels && lv.labels && lv.labels.setVisible) lv.labels.setVisible(false);
  if (o.position) lv.applyView({ position: o.position, target: o.target || [0, 0, 0] });
  if (e.controls) { e.controls.autoRotate = false; if (e.controls.update) e.controls.update(); }
  const p = lv.camera.position;
  return { level: lv.id, camDist: +p.length().toFixed(3) };
}
"""

# 标记的静态口径 + 标签是否上屏（DOM 同步事实）。
MARK_JS = r"""
() => {
  const u = window.__universe;
  const e = u.engine, lv = e.current;
  const find = (n) => (lv.scene.children || []).find((c) => c.name === n) || null;
  const core = find('mw-sun-mark'), glow = find('mw-sun-glow');
  const mat = (spr) => spr ? {
    sizeAttenuation: spr.material.sizeAttenuation,
    depthTest: spr.material.depthTest,
    blending: spr.material.blending,
    opacity: spr.material.opacity,
    scale: +spr.scale.x.toFixed(5),
    renderOrder: spr.renderOrder,
    visible: spr.visible,
    worldY: +spr.position.y.toFixed(3),
    bodyOffset: +spr.position.length().toFixed(3),
  } : null;
  /* ⚠️ `labels.items` 是 `Map<id, DOM 元素>` —— **value 就是元素本身**，
   *    不是 `{el}`。按 `lab.el` 读会得到 `undefined` ⇒ 判据报「标签没登记」，
   *    而截图里那行「太阳系」明明在上屏（这就是「量具自己错了」的样子）。
   *    见 `ui/labels.js:37/48/72`。 */
  const labEl = (lv.labels && lv.labels.items) ? lv.labels.items.get('mw-sun') : null;
  /* ⚠️ 判「标签可见」只能看 `display`：`ui/labels.js::hide()` 写的是
   *    `el.style.display='none'`，而 `display:none` 的 `visibility` 仍是 visible
   *    ⇒ 按 visibility 数会把藏起来的全算成可见。 */
  return {
    level: lv.id,
    viewport: [e.size.w, e.size.h],
    fov: lv.camera.fov,
    camDist: +lv.camera.position.length().toFixed(3),
    core: mat(core), glow: mat(glow),
    unnamedTop: (lv.unnamedTop || []).slice(),
    label: {
      registered: !!labEl,
      display: labEl ? getComputedStyle(labEl).display : null,
      opacity: labEl ? labEl.style.opacity : null,
      text: labEl ? labEl.textContent : null,
      position: labEl && labEl._data && labEl._data.position
        ? [+labEl._data.position.x.toFixed(2), +labEl._data.position.y.toFixed(2),
           +labEl._data.position.z.toFixed(2)]
        : null,
    },
  };
}
"""

# ★ 主判据：像素级消融。
#   `mul` = 相机距离倍数（默认视角 × mul，同方向）；`scaleMul` = 标记 scale 倍数（正对照）。
PIX_JS = r"""
([camMul, scaleMul, half]) => {
  const u = window.__universe;
  const e = u.engine, lv = e.current;
  const gl = e.renderer.getContext();
  const W = e.size.w, H = e.size.h;
  const find = (n) => (lv.scene.children || []).find((c) => c.name === n) || null;
  const core = find('mw-sun-mark'), glow = find('mw-sun-glow');
  if (!core) return { ok: false, why: '场景里找不到 mw-sun-mark' };

  const wasPaused = e._paused;
  const wasRot = e.controls ? e.controls.autoRotate : null;
  /* ⚠️ 相机在 **Level** 上（`engine.current.camera`），不是 engine 上。
   *    写成 `e.camera` 会 `TypeError: Cannot read properties of undefined` —— 好在这
   *    是**响的**故障，不是静默的。 */
  const cam = lv.camera;
  const basePos = cam.position.clone();
  const baseS = core.scale.x, baseG = glow ? glow.scale.x : 0;
  const out = { ok: true, camMul: camMul, scaleMul: scaleMul };

  const lum = (b, i) => Math.max(b[i], b[i + 1], b[i + 2]);
  const stats = (b) => {
    let s = 0, mx = 0;
    for (let i = 0; i < b.length; i += 4) { const l = lum(b, i); s += l; if (l > mx) mx = l; }
    return { sum: s, max: mx };
  };
  /* ⚠️ 逐像素差分**只当参考读数**，不当判据。第 37 轮实测踩到：
   *    银盘点云**每帧都在自转**，而它是「离散小点 + additive」—— 一个点挪
   *    0.1 px 就能让该像素从满亮跌到零。于是逐像素差分的读数被这个噪声完全
   *    主导：实测报出「外接盒 = 整个读数区 141×141 px、变色像素 1565、
   *    maxΔ 132」，而截图上那个标记只有 ~19 px ⇒ **数出来的全是噪声**。
   *    ⇒ 判据改用**抗动画的统计量：区域总亮度**（点云整体平移几乎不改变
   *    区域总亮度，只改变它落在哪个像素上）。
   *    ⇒ 并且**先量噪声地板**（下面 `noise`）：什么都不改连着渲两帧，
   *    看这个统计量的抖动有多大 —— 这是「量具先自证再量对象」。 */
  const boxOf = (a, b) => {
    let changed = 0, maxd = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(lum(a, i) - lum(b, i));
      if (d > maxd) maxd = d;
      if (d > 40) changed++;
    }
    return { changed: changed, maxDelta: maxd };
  };

  try {
    e._paused = true;                                  // 不让引擎自己的 rAF 插进来
    if (e.controls) e.controls.autoRotate = false;     // 钉住视角：否则两次量的是两个角度
    if (camMul !== 1) { cam.position.copy(basePos).multiplyScalar(camMul); }
    if (e.controls && e.controls.update) e.controls.update();
    if (scaleMul !== 1) {
      core.scale.setScalar(baseS * scaleMul);
      if (glow) glow.scale.setScalar(baseG * scaleMul);
    }
    e._frame();                                        // 让可见性/尺寸改动落到画面

    /* 标记的屏幕位置：世界 → NDC → 画布像素（左上原点） */
    const v = core.position.clone().project(cam);
    const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
    out.screenPos = [+sx.toFixed(1), +sy.toFixed(1)];
    out.ndcZ = +v.z.toFixed(4);
    /* ⚠️ 相机往原点拉近时，太阳（在 z=26.7 千光年）会比相机更靠前 ——
     *    它直接**跑到相机背后**，投影出天文数字的屏幕坐标。
     *    第一版没防这一手，`new Uint8Array(w*h*4)` 拿到负长度，
     *    报的是 `RangeError: Invalid typed array length: -671580` ——
     *    好在这是**响的**故障。静默版是：w 被 Math.min 截成某个正数 ⇒
     *    量到的是画面边上完全无关的一块像素，而判据照样报 OK。 */
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || Math.abs(sx) > 1e4
        || Math.abs(sy) > 1e4 || v.z > 1) {
      return { ok: false, camMul: camMul, scaleMul: scaleMul,
               why: '标记不在视野内（屏幕 ' + sx.toFixed(1) + ',' + sy.toFixed(1) + '）' };
    }
    const x0 = Math.max(0, Math.round(sx) - half), y0 = Math.max(0, Math.round(sy) - half);
    const w = Math.max(1, Math.min(W - x0, half * 2 + 1));
    const h = Math.max(1, Math.min(H - y0, half * 2 + 1));
    const gy = H - y0 - h;                             // GL 的 y 自下往上
    out.rect = { x: x0, y: y0, w: w, h: h };
    const read = () => {
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(x0, gy, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };

    /* ⓿ **噪声地板**：什么都不改，连着渲两帧。 */
    e._frame(); const n1 = read();
    e._frame(); const n2 = read();
    const s1 = stats(n1), s2 = stats(n2);
    out.noise = { sum: Math.abs(s1.sum - s2.sum), box: boxOf(n1, n2) };

    /* ① 开 → 关：只有标记变了（相机/尺寸/其他对象都没动）。 */
    const on = read();
    core.visible = false; if (glow) glow.visible = false;
    e._frame();
    const off = read();
    core.visible = true; if (glow) glow.visible = true;
    e._frame();

    out.on = stats(on);
    out.off = stats(off);
    /* ★ 主读数：标记对这块区域的**净亮度贡献**（正 = 开时更亮）。 */
    out.markSum = out.on.sum - out.off.sum;
    out.noiseSum = out.noise.sum;
    out.snr = out.noise.sum > 0 ? +(out.markSum / out.noise.sum).toFixed(2) : null;
    out.box = boxOf(on, off);
    /* ⚠️ 区域 `max` **不是**「标记有多显眼」的读数（第 37 轮第一次就栽在这）：
     *    区域里还有 HYG 恒星和银核泛光，`max` 被**别的亮星**占住 ⇒
     *    开/关两次都是 248，报出一个 `contrast: 0` 的假读数。
     *    ⇒ 要量的是**标记自己那个位置**被抬亮了多少：取标记正中心的 3×3 平均。
     *    ⚠️ `gl.readPixels` 的行序**自下往上**（GL 原点在左下），而行索引错一位
     *       不会报错、只会静默量到隔壁像素 —— 所以这里显式翻转。 */
    const idx = (xLocal, yLocal) => (((h - 1 - yLocal) * w) + xLocal) * 4;
    const cxl = Math.round(sx) - x0, cyl = Math.round(sy) - y0;
    const patch = (b) => {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cxl + dx, y = cyl + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          s += lum(b, idx(x, y)); n++;
        }
      }
      return n ? s / n : null;
    };
    out.centerOn = patch(on);
    out.centerOff = patch(off);
    /* 「标记把它自己那个位置抬亮了多少」（0-255）—— 这才是「看得见」的读数。 */
    out.centerDelta = out.centerOn - out.centerOff;
    out.areaMax = { on: out.on.max, off: out.off.max };
  } finally {
    core.scale.setScalar(baseS); if (glow) glow.scale.setScalar(baseG);
    core.visible = true; if (glow) glow.visible = true;
    cam.position.copy(basePos);
    if (e.controls && e.controls.update) e.controls.update();
    e._paused = wasPaused; if (e.controls) e.controls.autoRotate = wasRot;
    e._frame();
  }
  return out;
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    ap.add_argument("--outdir", default=SHOTS)
    ap.add_argument("--tier", default="high",
                    help="画质档位 id，合法值只有 saver / balanced / high（见 web/js/core/gpu.js::TIERS）")
    ap.add_argument("--half", type=int, default=45, help="像素读数区域的半宽（px）")
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

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--enable-unsafe-swiftshader",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ])
        page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_function(
            "() => window.__universe && window.__universe.engine && window.__universe.dataset"
            " && window.__universe.dataset.galaxies && window.__universe.dataset.galaxies.length > 0",
            timeout=60000,
        )
        pin = page.evaluate(PIN_JS, args.tier)
        print("  画质档 ", json.dumps(pin, ensure_ascii=False))
        check("画质档钉住**真的生效**",
              (not args.tier) or (pin.get("applied") is True and pin.get("tier") == args.tier),
              f"请求「{args.tier or '（不钉）'}」· `applyTier` 返回 {pin.get('applied')}"
              f" · 实际档位「{pin.get('tier')}」")

        ok = page.evaluate(SETTLE_JS, "galaxy")
        if not ok:
            print("  FAIL  切不到 galaxy 层")
            browser.close()
            sys.exit(1)

        # 出货默认视角（`galaxy.js::defaultView()` = position [0,78,118]）
        r_v = page.evaluate(VIEW_JS, {"hideLabels": False, "position": [0, 78, 118], "target": [0, 0, 0]})
        time.sleep(2.0)
        m = page.evaluate(MARK_JS)
        print("\n  标记口径")
        print(f"    层 {m['level']} · 视口 {m['viewport']} · fov {m['fov']} · 相机距 {m['camDist']}")
        print(f"    核心 {json.dumps(m['core'], ensure_ascii=False)}")
        print(f"    光晕 {json.dumps(m['glow'], ensure_ascii=False)}")
        print(f"    标签 {json.dumps(m['label'], ensure_ascii=False)}")
        print(f"    顶层未命名 {m['unnamedTop'] or '无'}")

        check("太阳标记存在（核心 + 光晕）",
              bool(m["core"]) and bool(m["glow"]),
              f"mw-sun-mark={'有' if m['core'] else '★缺★'}"
              f" · mw-sun-glow={'有' if m['glow'] else '★缺★'}")
        check("标记用屏幕恒定尺寸 + 不被点云遮挡",
              bool(m["core"]) and m["core"]["sizeAttenuation"] is False
              and m["core"]["depthTest"] is False
              and bool(m["glow"]) and m["glow"]["sizeAttenuation"] is False
              and m["glow"]["depthTest"] is False,
              f"sizeAttenuation={m['core']['sizeAttenuation'] if m['core'] else None}"
              f" · depthTest={m['core']['depthTest'] if m['core'] else None}"
              f"（改回 true 就会重犯第 33 轮「第二个核」：拉近时长成一团大光球）")
        check("标记位置就是太阳位置（不在原点）",
              bool(m["core"]) and 20.0 < m["core"]["bodyOffset"] < 34.0,
              f"离原点 {m['core']['bodyOffset'] if m['core'] else None} 世界单位"
              f"（1 单位 = 1 千光年，太阳距银心 26.7 kly）")
        check("新增的顶层对象都有名字（探针清单认得出它们）",
              not m["unnamedTop"],
              f"未命名 {m['unnamedTop'] or '无'}")
        check("「太阳系」标签在默认视角上屏",
              m["label"]["registered"] and m["label"]["display"] not in ("none", None),
              f"登记={m['label']['registered']} · display={m['label']['display']}"
              f" · 透明度={m['label']['opacity']} · 文本「{m['label']['text']}」"
              f" · 标签位 {m['label']['position']}")

        # ---- ★ 主判据：区域总亮度的消融（抗动画统计量）----
        base = page.evaluate(PIX_JS, [1, 1, args.half])
        print("\n  消融（默认视角 · 关掉标记后同一区域重读；坐标 = 区域总亮度）")
        print(f"    {json.dumps(base, ensure_ascii=False)}")
        if not base.get("ok"):
            print(f"  FAIL  像素读数失败：{base.get('why')}")
            browser.close()
            sys.exit(1)

        area = base["rect"]["w"] * base["rect"]["h"]
        ratio = base["markSum"] / (area * 255.0)
        c_on = base.get("centerOn")
        c_off = base.get("centerOff")
        c_d = base.get("centerDelta")
        print(f"    噪声地板 Δsum={base['noiseSum']}（什么都不改连渲两帧）"
              f" · 标记贡献 Δsum={base['markSum']} · 信噪比={base['snr']}"
              f" · 占区域亮度总量 {ratio * 100:.2f}%"
              f" · 中心 3×3 亮度 {c_off} → {c_on}（抬升 {c_d}）"
              f" · 逐像素参考（不作判据）：变色 {base['box']['changed']} px / maxΔ {base['box']['maxDelta']}")

        check("标记真的画在屏幕上（消融它这块区域显著变暗）",
              base["markSum"] > 0 and (base["snr"] is None or base["snr"] >= 5),
              f"关掉标记 ⇒ 区域总亮度 Δsum={base['markSum']}"
              f" · 信噪比 {base['snr']}（相对噪声地板 {base['noiseSum']}）"
              f"（Δsum ≤ 0 或信噪比 < 5 ⇒ 它被银盘点云/泛光淹掉，或者根本没画出来）")
        check("标记把自己那个位置抬起来了（这是「看得见」的直接读数）",
              c_d is not None and c_d >= 40,
              f"标记中心 3×3 平均亮度：关 {c_off} → 开 {c_on} ⇒ 抬升 {c_d} / 255"
              f"（< 40 ⇒ 在银盘亮处读不出来 —— 这正是用户报的那个症状。"
              f"⚠️ 不要拿「区域最亮像素」当这个读数：区域里还有恒星与银核泛光，"
              f"那个数开关两次都是 248，是假读数）")
        check("亮度贡献与「一个点」相称（不是一团大光斑）",
              0.003 <= ratio <= 0.15,
              f"占区域亮度总量 {ratio * 100:.2f}%（期望 0.3%–15%）"
              f"· 区域 {base['rect']['w']}×{base['rect']['h']} px"
              f"（> 15% ⇒ 它已经是一团光斑，不再是「点」；"
              f"第 33 轮「第二个核」的读数就在这个区间上面）")

        # 正对照 ①：量具对尺寸敏感 —— 不做这条，上面两条就是空判据。
        big = page.evaluate(PIX_JS, [1, 2, args.half])
        print("\n  正对照 ① · 标记 scale ×2（面积应 ×4）")
        print(f"    {json.dumps({k: big.get(k) for k in ('markSum', 'noiseSum', 'snr', 'box', 'screenPos')}, ensure_ascii=False)}")
        check("量具对尺寸敏感（正对照 ①：scale ×2 ⇒ 亮度贡献显著变大）",
              big["ok"] and big["markSum"] > base["markSum"] * 1.8,
              f"贡献 {base['markSum']} → {big['markSum']}"
              f"（面积 ×4 但泛光出界会被截，所以只要 > 1.8 倍；"
              f"不变 ⇒ 上面两条是空判据）")

        # 正对照 ②：拉远 2 倍，屏幕尺寸必须不变（不衰减的定义）。
        far = page.evaluate(PIX_JS, [2, 1, args.half])
        print("\n  正对照 ② · 相机拉远 2 倍")
        print(f"    {json.dumps({k: far.get(k) for k in ('markSum', 'noiseSum', 'snr', 'screenPos', 'camMul')}, ensure_ascii=False)}")
        check("亮度贡献与视距无关（正对照 ②：拉远 2 倍，贡献基本不变）",
              far["ok"] and far["markSum"] >= base["markSum"] * 0.7,
              f"默认 {base['markSum']} → 拉远 2 倍 {far['markSum']}"
              f"（若这一版还按**世界单位**衰减，远一倍的面积只剩 1/4 ⇒ "
              f"贡献会掉到 ~{base['markSum'] * 0.25:.0f}，这条判据就是用来分辨这两者的）")

        # 正对照 ③：**拉到近处**。这是「第 33 轮第二个核」的正面反证 ——
        #   世界单位口径下，相机拉近一半 ⇒ 半径 ×2 ⇒ 面积 ×4 ⇒
        #   一个 6.8 px 的小点长成 27 px 的光球（就是当年那个「第二个核」）。
        #   ⚠️ 只敢拉到 0.5 倍：再近相机就飞到太阳**前面**了（太阳在 z=26.7，
        #     而相机看向原点），标记会出画 —— 那时测的不是标记，是画面边缘。
        near = page.evaluate(PIX_JS, [0.5, 1, args.half])
        print("\n  正对照 ③ · 相机拉近一半（第 33 轮「第二个核」的正面反证）")
        print(f"    {json.dumps({k: near.get(k) for k in ('markSum', 'noiseSum', 'snr', 'screenPos', 'camMul, ok, why')}, ensure_ascii=False)}")
        check("拉近一半不会长成大光球（正对照 ③：贡献不随视距放大）",
              near["ok"] and near["markSum"] <= base["markSum"] * 1.5,
              f"贡献 {base['markSum']} → 拉近一半 {near.get('markSum')}"
              f"（世界单位口径下这里会 ×~4 ⇒ ~{base['markSum'] * 4:.0f}，"
              f"标记会长成 27 px 的光球 —— 那就是第 33 轮的「银河系第二个核」）")

        page.evaluate(VIEW_JS, {"hideLabels": False, "position": [0, 78, 118], "target": [0, 0, 0]})
        time.sleep(1.2)
        page.screenshot(path=os.path.join(args.outdir, "galaxy-sun-mark.png"))
        page.screenshot(path=os.path.join(args.outdir, "galaxy-sun-mark-crop.png"),
                        clip={"x": max(0, base["screenPos"][0] - 200), "y": max(0, base["screenPos"][1] - 200),
                              "width": 400, "height": 400})

        real_errs = [e for e in errs if "favicon" not in e]
        check("控制台零错误", not real_errs, f"{real_errs[:3] if real_errs else '无'}")
        browser.close()

    print()
    if fails:
        print(f"  ✗ 失败 {len(fails)} 项：{', '.join(fails)}")
        print(f"  （共 {total[0]} 项判据）")
        sys.exit(1)
    print(f"  全部通过：{total[0]} 项判据。")
    print(f"  截图：{os.path.join(args.outdir, 'galaxy-sun-mark.png')}"
          f" · {os.path.join(args.outdir, 'galaxy-sun-mark-crop.png')}")
    print("  ⚠️ 帧时间未在本探针内量（swiftshader 下不可信）。要帧基线请用")
    print("     `py -3.13 -X utf8 tools/probe-universe-perf.py --level=galaxy`。")


if __name__ == "__main__":
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
本星系群接线验收探针：数对象 + 判「画得出 = 搜得到」+ 判「只留核心」+ A/B 画布代价 + 截图。

用法： py -3.13 -X utf8 tools/probe-localgroup.py [url] [--outdir=shots]

为什么要有这个探针
------------------------------------------------------------------
这一层的接线经历过两次会改变画面的改动，两次都不能靠眼睛验收：

  【第 34 轮】数据源从 **1 份手写目录** 变成 **手写目录 + 真实星表取并集**：
    1. 到底多画了多少个？（`dataset.galaxies` vs `localGroup` vs `meta.count`）
    2. 「目录里搜得到」和「场景里画得出」是不是同一份列表？
    3. 多出来那批的**画布代价**是多少？

  【第 36 轮】「只留核心」：默认**只画本星系群成员**，星表里划在零速度面之外的
    那批（`近邻星系`，4.40–9.67 Mly，全部越过 5 Mly 标尺环）默认不画。
    这条改动**同时**带来两个新的静默故障风险，两个都必须有判据盯住：
    4. **默认可见集合**是不是恰好等于「成员」集合？（数对象，不数计数）
    5. 群外那批**仍然要搜得到、点得开、飞过去看得见** ——
       否则「目录里搜得到、场景里看不见」这条老故障就换了个方向回来（这次连报错都没有）。
       ⇒ 「飞过去看得见」用**两段式**量：调用 `focusById()` **前**该盘不可见、**后**可见；
         并配一个**正对照**（成员天体调用前后都可见），否则「后=可见」可能只是量具坏了。

口径从哪来（**探针里不写第二份**）
------------------------------------------------------------------
「谁是群外」的判断**不在这里重写**。页面把口径挂在 `dataset.isLocalGroupMember` /
`dataset.lgOutsideGroup` 上，渲染层与探针取的是**同一个函数、同一个常量**
（由来：同一条不变量有第二份实现的地方必有一份会漏）。本文件里因此**不出现**
「近邻星系」这个字面量 —— 出现即说明又长出了第二份口径。

量具自证（必须看这一段）
------------------------------------------------------------------
本探针用 **swiftshader 软件渲染**（无头）。所以：
  * `renderer.info.render.calls` / `triangles` 可信 —— 它们是提交给 GL 的**计数**，
    与谁执行无关。
  * **帧时间不可信** —— 软件光栅化的成本与独显不可比，这里报出来的毫秒数
    只能用于「同一次运行里 A 与 B 的相对比较」，不能当成真实帧成本写进验收。
  * 因此本探针**不**把帧时间当判据，只打印出来做参考，并在输出里标明这一点。
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

# 钉住画质档（必须在 gotoScale 之前）+ 读状态，口径与 probe-mw-look.py 一致。
#
# ⚠️ 必须**回读 `applyTier` 的返回值**：`engine.applyTier()` 对不存在的档位 id
#    走的是 `const t = TIERS[tierId]; if (!t) return false;` —— **静默空转、零报错**。
#    本探针原先默认 `--tier=hp`，而合法 id 只有 `saver / balanced / high`
#    （`web/js/core/gpu.js::TIERS`）⇒ 「钉住画质档」这件事**从来没有生效过**，
#    页面一直用它自己自动判定的档位（无头 swiftshader 下是 `saver`）。
#    这不是「参数没用」，是**命令跑过 ≠ 命令有效**：先前的输出里那行
#    `画质档 {"tier": "saver"}` 其实已经把真相打印出来了，只是没人核对。
PIN_JS = r"""
(tier) => {
  const e = window.__universe.engine;
  if (e.gpu) e.gpu.tierPinned = true;
  const applied = tier ? (e.applyTier ? e.applyTier(tier) : false) : null;
  return {
    requested: tier || null,
    applied: applied,
    tier: e.tierId,
    pointBudget: e.tier ? e.tier.pointBudget : null,
  };
}
"""

# 数据侧清点：三个数必须自洽，且「搜得到」必须覆盖全部成员（含群外那批）。
# ⚠️ 成员/群外一律走 `d.isLocalGroupMember`，不在这里重写判断。
DATA_JS = r"""
() => {
  const d = window.__universe.dataset;
  const g = d.galaxies || [];
  const lg = d.localGroup || [];
  const isMember = d.isLocalGroupMember;
  const byProv = {}, byGroup = {};
  for (const x of g) {
    byProv[x.provenance || '(无标记)'] = (byProv[x.provenance || '(无标记)'] || 0) + 1;
    byGroup[x.group || '(无)'] = (byGroup[x.group || '(无)'] || 0) + 1;
  }
  const outside = g.filter((x) => !isMember(x));
  const nonFinite = g.filter((x) => !Number.isFinite(x.x) || !Number.isFinite(x.y) || !Number.isFinite(x.z));
  const notSearchable = g.filter((x) => !d.bodies.has(x.id));
  const dists = g.map((x) => x.distMly).filter((v) => Number.isFinite(v));
  return {
    outsideGroupName: d.lgOutsideGroup,
    predicateIsFunction: typeof isMember === 'function',
    galaxies: g.length,
    localGroupRaw: lg.length,
    metaCount: d.localGroupMeta ? d.localGroupMeta.count : null,
    metaMatchedHandwritten: d.localGroupMeta ? d.localGroupMeta.matchedHandwritten : null,
    byProvenance: byProv,
    byGroup: byGroup,
    members: g.length - outside.length,
    outside: outside.length,
    outsideIds: outside.map((x) => x.id),
    hidden: g.filter((x) => x.hidden).length,
    nonFiniteCoords: nonFinite.map((x) => x.id),
    notSearchable: notSearchable.map((x) => x.id),
    outsideNotSearchable: outside.filter((x) => !d.bodies.has(x.id)).map((x) => x.id),
    beyond5Mly: g.filter((x) => (x.distMly || 0) > 5).length,
    maxDistMly: dists.length ? +Math.max.apply(null, dists).toFixed(3) : null,
  };
}
"""

# 场景侧清点：谁真的在画，以及**索引与场景是不是同一份名单**。
SCENE_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  const isMember = u.dataset.isLocalGroupMember;
  const bodyOf = (o) => {
    const id = o.userData ? o.userData.bodyId : null;
    return id ? u.dataset.bodies.get(id) : null;
  };
  const discs = (lv.scene.children || []).filter((o) => o.name === 'galaxy-disc');
  const members = discs.filter((o) => { const b = bodyOf(o); return b && isMember(b); });
  const outside = discs.filter((o) => { const b = bodyOf(o); return b && !isMember(b); });
  const catalogOnly = discs.filter((o) => { const b = bodyOf(o); return b && b.provenance === 'catalog'; });
  /* ⚠️ 判「标签可见」只能用 `display`，不能用 `visibility`。
   *    `ui/labels.js::hide()` 用的是 `el.style.display = 'none'`，
   *    而 `display:none` 的元素 `getComputedStyle().visibility` 仍然是 `visible`
   *    ⇒ 按 visibility 数会**把藏起来的全算成可见**（实测：上限 20、数出 99）。
   *    同族教训见 MEMORY.md「量具必须先自证」：先问「这个属性真的会被写吗」。 */
  const visLabels = lv.labels && lv.labels.items
    ? [...lv.labels.items.values()].filter((el) => getComputedStyle(el).display !== 'none' && +el.style.opacity !== 0).length
    : null;
  return {
    level: lv.id,
    discs: discs.length,
    spritesSize: lv.sprites ? lv.sprites.size : null,
    discsVisible: discs.filter((o) => o.visible).length,
    memberDiscs: members.length,
    memberVisible: members.filter((o) => o.visible).length,
    outsideDiscs: outside.length,
    outsideVisible: outside.filter((o) => o.visible).length,
    catalogOnlyDiscs: catalogOnly.length,
    labelsVisible: visLabels,
    labelCap: lv.labelOptions ? (lv.labelOptions.maxLabels || 0) : null,
    programs: u.engine.renderer.info.programs
      ? u.engine.renderer.info.programs.length : null,
  };
}
"""

# 「飞过去看得见」—— 两段式，量的是 `focusById()` **这个动作**。
# 只读 `focusById` 前后**同一个属性**（`sprites` 里那个盘的 `visible`），
# 顺带确认标签也被补上了（标签是 DOM，只查「有没有登记」这个同步事实）。
REVEAL_JS = r"""
(id) => {
  const lv = window.__universe.engine.current;
  const s = lv.sprites.get(id);
  if (!s) return { id, found: false };
  const before = s.visible;
  const labelBefore = lv.labels && lv.labels.items ? lv.labels.items.has(id) : null;
  const ret = lv.focusById(id);
  const after = s.visible;
  const labelAfter = lv.labels && lv.labels.items ? lv.labels.items.has(id) : null;
  return { id, found: true, ret: ret, before: before, after: after, labelBefore: labelBefore, labelAfter: labelAfter };
}
"""

# 拾取守卫：默认不画的那个**不许被拾取**。两段式 + 正对照。
# ⚠️ 正对照是必须的：只判「点它点不到」，若拾取器整个坏掉也照样「通过」。
PICK_JS = r"""
(id) => {
  const lv = window.__universe.engine.current;
  const s = lv.sprites.get(id);
  if (!s) return { id, found: false };
  const v = s.position.clone().project(lv.camera);
  const onScreen = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z >= -1 && v.z <= 1;
  const hit = lv.pick({ x: v.x, y: v.y });
  return { id, found: true, visible: s.visible, onScreen: onScreen, hitId: hit ? hit.id : null };
}
"""

# 跨尺度「飞过去看它」—— **用户真正走的那条路**：从别的层 `goTo('localgroup', { focus })`。
# 同层那条（上面 REVEAL_JS）只覆盖「已经在本层、从目录点」；
# 而搜索 / 目录跨尺度点击走的是 `main.js` → `engine.goTo(id, { focus })`，
# 它过去只拿 focus 算了相机落点、**不点亮对象** ⇒ 相机飞到一片空处，零报错。
#
# ⚠️⚠️ 这一条**做不了两段式**，而且原因值得记住：
#    「前一段」落在**被测动作内部** —— 本层会被 `goTo('neighborhood')` 释放
#    （`_releaseLevel()` 换掉 `lv.scene`、`built = false`），而**重建发生在
#    `goTo('localgroup')` 里的 `ensureBuilt()`**，也就是说「重建后、点亮前」的
#    那个瞬间在外部根本插不进读数。硬读一个 `before` 会读到**上一个判据留下的旧对象**，
#    那是孤儿（已不在场景里），它的值与被测动作无关。
#    两段式拿不到时，替代品是**证明这个值只能来自被测动作**：
#      ① `rebuilt` 必须为 True —— 盘是这次新造的，初始 `visible = 成员资格`（群外恒 false）；
#      ② 配一条独立自证：把钩子打成空实现，**同一个动作**必须不再点亮（见下面 DISARM_JS）。
#    ① + ② 合起来比「两段都动」更强，因为它排除了「值本来就在那儿」这一整类假绿。
CROSS_JS = r"""
async (id) => {
  const u = window.__universe;
  const e = u.engine;
  const lv = e.levels.get('localgroup');
  if (!lv) return { id, found: false, why: '本层不在 engine.levels 里' };
  const s0 = lv.sprites.get(id);
  const beforeLeave = s0 ? s0.visible : null;   // 只作读数：这里还带着上一个判据的状态
  const from = e.current ? e.current.id : null;
  // ① 先跳到**别的**层：保证接下来这一跳走 goTo 的**跨层**分支（同层分支由 REVEAL_JS 覆盖）
  await e.goTo('neighborhood', { instant: true });
  const gone = !lv.built;                       // 本层应已被 `_releaseLevel()` 释放
  // ② 跨层 + 带 focus —— 就是要判的那个动作
  await e.goTo('localgroup', { focus: id });
  // ③ 等过渡散场（transition 被 `_finishTransition()` 清空）；上限 300 帧防挂死
  let waited = 0;
  while (e.transition && waited < 300) { await new Promise((r) => requestAnimationFrame(r)); waited++; }
  const s1 = lv.sprites.get(id);
  return {
    id, found: !!(s1 || s0), from, beforeLeave, gone,
    after: s1 ? s1.visible : null,
    level: e.current ? e.current.id : null,
    /* ⚠️ 这个读数**是判据的一部分**，不是装饰：本层重建过 ⇒ 读到的是**新造**的盘
     *    （初始 `visible` 由成员资格决定，群外那批恒 false）⇒ 此刻 `after === true`
     *    只可能来自跨层点亮。若 `rebuilt === false`，读到的就是上一个判据留下的旧对象，
     *    那这一条会**假绿**。 */
    rebuilt: s0 !== s1,
    waited, transitioning: !!e.transition,
  };
}
"""

# 判据自证：把钩子打成**空实现**，同一个动作必须**不再点亮**。
# 防的是「after === true」其实另有来源（例如重建后本来就 true）—— 那样子没见过，但读数会骗人。
DISARM_JS = r"""
() => {
  const lv = window.__universe.engine.levels.get('localgroup');
  if (!lv) return null;
  const armed = typeof lv.revealById === 'function';
  if (armed) lv.revealById = () => {};      // 实例属性覆盖原型方法（方法名变空 ⇒ 可自证已替换）
  return { armed, nameAfter: lv.revealById.name };
}
"""

RESTORE_JS = r"""
() => {
  const lv = window.__universe.engine.levels.get('localgroup');
  if (!lv) return null;
  delete lv.revealById;                     // 删掉实例属性 ⇒ 回到原型方法
  return { name: typeof lv.revealById === 'function' ? lv.revealById.name : null };
}
"""

# A/B：把「群外那批」整体打开/关上再读一次渲染计数。同一场景、同一相机、同一后端。
# ⚠️ 口径从页面取（`isLocalGroupMember`），不在这里重写。
AB_JS = r"""
(on) => {
  const u = window.__universe;
  const lv = u.engine.current;
  const isMember = u.dataset.isLocalGroupMember;
  const discs = (lv.scene.children || []).filter((o) => o.name === 'galaxy-disc');
  let n = 0;
  for (const o of discs) {
    const id = o.userData ? o.userData.bodyId : null;
    const b = id ? u.dataset.bodies.get(id) : null;
    if (b && !isMember(b)) { o.visible = on; if (on) n++; }
  }
  return n;
}
"""

# 一帧的真同步读法：跑 K 帧取总时间，末尾 readPixels(1x1) 逼 GPU 干完。
# 口径见 MEMORY.md「量程不够 = 另一种失明」：rAF 间隔在窗口未被真正显示时
# 量到的是命令提交耗时；所以这里只用它做**同一次运行内的相对比较**。
FRAME_JS = r"""
async (k) => {
  const e = window.__universe.engine;
  const gl = e.renderer.getContext();
  const px = new Uint8Array(4);
  const one = () => new Promise((r) => requestAnimationFrame(r));
  await one();                       // 预热一帧，避免把首帧编译成本算进去
  const t0 = performance.now();
  for (let i = 0; i < k; i++) await one();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { msPerFrame: (performance.now() - t0) / k };
}
"""

# 累计 draw call。**为什么要 autoReset = false**：
# 本项目渲染走 EffectComposer（RenderPass → Bloom → OutputPass），而
# `renderer.info` 在**每一次** `renderer.render()` 里都会自动 reset ⇒ 直接读它
# 拿到的是**最后一个全屏 pass**的计数，恒等于 1 call / 1 triangle，
# 与场景里画了多少个天体完全无关（实测：102 个盘与 20 个盘给出同一个 1）。
# 关掉自动重置、手动减一次，才是整条管线累计的真实提交量。
CALLS_JS = r"""
async (k) => {
  const e = window.__universe.engine;
  const info = e.renderer.info;
  const gl = e.renderer.getContext();
  const px = new Uint8Array(4);
  const one = () => new Promise((r) => requestAnimationFrame(r));
  info.autoReset = false;
  info.reset();
  await one();
  info.reset();                      // 丢掉预热那一帧
  for (let i = 0; i < k; i++) await one();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = { frames: k, calls: info.render.calls, triangles: info.render.triangles };
  info.autoReset = true;
  info.reset();
  return out;
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
  return { level: lv.id, camDist: +p.length().toFixed(2) };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    ap.add_argument("--outdir", default=SHOTS)
    ap.add_argument("--tier", default="high",
                    help="画质档位 id，合法值只有 saver / balanced / high（见 web/js/core/gpu.js::TIERS）")
    ap.add_argument("--frames", type=int, default=80)
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
        # ⚠️ 这条是**给量具自己上的一道闸**：档位没钉住，后面所有「同一次运行里 A/B 相对比较」
        #    都还成立，但**跨运行**的数字就不再可比（自动档位会随机器/后端变）。
        #    传错档位名时 `applyTier` 静默返回 false —— 所以判据读的是**返回值 + 回读的档位**，
        #    不是「我请求了」这件事。
        check("画质档钉住**真的生效**",
              (not args.tier) or (pin.get("applied") is True and pin.get("tier") == args.tier),
              f"请求「{args.tier or '（不钉）'}」· `applyTier` 返回 {pin.get('applied')}"
              f" · 实际档位「{pin.get('tier')}」· 粒子上限 {pin.get('pointBudget')}"
              f"（合法 id 只有 saver / balanced / high）")

        print("\n  数据侧")
        d = page.evaluate(DATA_JS)
        for k in ("outsideGroupName", "predicateIsFunction", "galaxies", "localGroupRaw", "metaCount",
                  "metaMatchedHandwritten", "members", "outside", "hidden", "beyond5Mly", "maxDistMly"):
            print(f"    {k:24} {d[k]}")
        print(f"    byProvenance            {json.dumps(d['byProvenance'], ensure_ascii=False)}")
        print(f"    byGroup                 {json.dumps(d['byGroup'], ensure_ascii=False)}")
        check("星表条数 == meta.count", d["metaCount"] == d["localGroupRaw"],
              f"meta.count={d['metaCount']}  localGroup={d['localGroupRaw']}")
        check("20 条手写全部命中", d["metaMatchedHandwritten"] == 20,
              f"matchedHandwritten={d['metaMatchedHandwritten']}")
        check("坐标全部有限", not d["nonFiniteCoords"],
              f"坏坐标 {d['nonFiniteCoords'] or '无'}")
        check("画得出 = 搜得到（含群外那批）",
              not d["notSearchable"] and not d["outsideNotSearchable"],
              f"搜不到的 id {d['notSearchable'] or '无'}"
              f"（其中属于群外的 {d['outsideNotSearchable'] or '无'}）"
              f"· 群外 {d['outside']} 条必须全部仍在检索索引里")
        # 「只留核心」的口径本身（谁是群外）由离线判据 `check-localgroup.mjs::member-split` 盯；
        # 这里只确认页面**真的把那个函数暴露出来了**，否则下面全是空判据。
        check("页面暴露了成员口径（探针不重写判断）",
              d["predicateIsFunction"] and bool(d["outsideGroupName"]),
              f"isLocalGroupMember 是函数={d['predicateIsFunction']}"
              f" · 群外组名「{d['outsideGroupName']}」· 判出群外 {d['outside']} 条 / 成员 {d['members']} 条")

        ok = page.evaluate(SETTLE_JS, "localgroup")
        if not ok:
            print("  FAIL  切不到 localgroup 层")
            browser.close()
            sys.exit(1)

        # 默认视角（拉远到 12 百万光年，让群外那批也在框里 —— 否则「没画」和「出画了」分不开）
        page.evaluate(VIEW_JS, {"hideLabels": False, "position": [0, 6.0, 12.0], "target": [0, 0, 0]})
        time.sleep(2.0)
        s_on = page.evaluate(SCENE_JS)
        print("\n  场景侧 · 默认（只留核心）")
        print(f"    {json.dumps(s_on, ensure_ascii=False)}")
        page.screenshot(path=os.path.join(args.outdir, "lg-core-default.png"))

        # 判据一：**数对象，不数计数**。
        check("默认只画核心（可见对象 == 成员数）",
              s_on["discsVisible"] == d["members"] and s_on["memberVisible"] == d["members"],
              f"可见 {s_on['discsVisible']} · 成员 {d['members']}"
              f"（总 {d['galaxies']} − 群外 {d['outside']}）· 其中成员可见 {s_on['memberVisible']}")
        check("群外成员建了对象但默认不画",
              s_on["outsideDiscs"] == d["outside"] and s_on["outsideVisible"] == 0,
              f"群外对象 {s_on['outsideDiscs']}（期望 {d['outside']}）"
              f"· 其中默认可见 {s_on['outsideVisible']}（期望 0）")
        check("索引与场景是同一份名单",
              s_on["spritesSize"] == s_on["discs"],
              f"sprites {s_on['spritesSize']} vs 场景里的盘 {s_on['discs']}"
              f"（差一个就是「搜得到、点不开」）")
        check("星表新增的对象都在场景里",
              s_on["catalogOnlyDiscs"] == d["galaxies"] - 20,
              f"星表独有的盘 {s_on['catalogOnlyDiscs']} 个"
              f"（dataset.galaxies {d['galaxies']} − 手写 20；"
              f"⚠️ 这一条数的是**盘对象在不在**，与它可见与否无关 —— "
              f"群外那批默认不画，但对象必须在）")
        check("宽视角标签被 maxLabels 关住",
              (s_on["labelCap"] or 0) > 0 and s_on["labelsVisible"] is not None
              and s_on["labelsVisible"] <= s_on["labelCap"] + 4,
              f"可见标签 {s_on['labelsVisible']} · 上限 maxLabels={s_on['labelCap']}"
              f"（超出 4 个以内视为布局余量；标了签的成员 {d['members']} − 隐藏 {d['hidden']}）")

        # 判据二：拾取守卫 —— 两段式 + 正对照。
        hid = next((x for x in d["outsideIds"]), None)
        vis = "m31"
        p_hidden = page.evaluate(PICK_JS, hid) if hid else None
        p_vis = page.evaluate(PICK_JS, vis)
        print("\n  拾取守卫（默认不画的那个不许被拾取；正对照：可见的那个必须点得到）")
        print(f"    默认不画 {json.dumps(p_hidden, ensure_ascii=False)}")
        print(f"    正对照   {json.dumps(p_vis, ensure_ascii=False)}")
        check("拾取器看得见「可见天体」（正对照）",
              bool(p_vis and p_vis.get("found") and (not p_vis.get("onScreen") or p_vis.get("hitId") == vis)),
              "正对照要求：m31 在框内时点它的屏幕位置必须命中它"
              "（不成立 ⇒ 拾取器本身坏了，下一条判据无效）")
        check("默认不画的成员不被拾取",
              bool(p_hidden and p_hidden.get("found") and (not p_hidden.get("onScreen") or p_hidden.get("hitId") != hid)),
              f"把 {hid} 的屏幕位置喂给 pick()：在上屏={p_hidden.get('onScreen') if p_hidden else None}"
              f" · 命中={p_hidden.get('hitId') if p_hidden else None}（必须不是它自己）")

        fr_on = page.evaluate(FRAME_JS, args.frames)
        c_on = page.evaluate(CALLS_JS, args.frames)

        # A/B：把群外那批整体打开（同一场景、同一相机）
        n_out = page.evaluate(AB_JS, True)
        time.sleep(0.6)
        s_off = page.evaluate(SCENE_JS)
        page.screenshot(path=os.path.join(args.outdir, "lg-with-outside.png"))
        fr_off = page.evaluate(FRAME_JS, args.frames)
        c_off = page.evaluate(CALLS_JS, args.frames)
        page.evaluate(AB_JS, False)      # 还原成「只留核心」

        def per(fr, key, k):
            return fr[key] / k

        print("\n  A/B（同一场景同一相机，只切「群外那批」的可见性）")
        print(f"    只留核心 对象 {s_on['discsVisible']:4} · {per(c_on, 'calls', args.frames):7.1f} call/帧"
              f" · {per(c_on, 'triangles', args.frames):9.0f} 三角形/帧"
              f" · {fr_on['msPerFrame']:6.2f} ms/帧（swiftshader，仅供参考）")
        print(f"    全打开   对象 {s_off['discsVisible']:4} · {per(c_off, 'calls', args.frames):7.1f} call/帧"
              f" · {per(c_off, 'triangles', args.frames):9.0f} 三角形/帧"
              f" · {fr_off['msPerFrame']:6.2f} ms/帧（swiftshader，仅供参考）")
        print(f"    Δ对象={s_off['discsVisible'] - s_on['discsVisible']}"
              f"  Δcall/帧={per(c_off, 'calls', args.frames) - per(c_on, 'calls', args.frames):.1f}"
              f"  Δms/帧={fr_off['msPerFrame'] - fr_on['msPerFrame']:+.2f}"
              f"（软件渲染下 1 单位 ≈ {1000.0 / max(1e-9, fr_on['msPerFrame']):.0f} 帧/秒的档位，"
              f"不能当真实帧成本）")
        check("A/B 确实切到的那批（对象数对得上）",
              n_out == d["outside"]
              and s_off["discsVisible"] == s_on["discsVisible"] + d["outside"],
              f"打开 {n_out} 个（期望 {d['outside']}）· 可见对象"
              f" {s_on['discsVisible']} → {s_off['discsVisible']}")
        # 判据三：累计 draw call 必须真的变化 —— 这条同时**自证量具有效**
        # （若两条相等，说明要么消融没打在对象上、要么计数读法又被重置掉了）。
        check("A/B 在累计 draw call 上可见",
              per(c_off, "calls", args.frames) > per(c_on, "calls", args.frames),
              f"{per(c_off, 'calls', args.frames):.1f} > {per(c_on, 'calls', args.frames):.1f} call/帧")

        # 判据四：「飞过去看得见」—— 放在最后做，因为它会**改变状态**（点亮后保持可见）。
        out_id = next((x for x in d["outsideIds"]), None)
        rv_out = page.evaluate(REVEAL_JS, out_id) if out_id else None
        rv_ctl = page.evaluate(REVEAL_JS, vis)
        print("\n  飞过去看得见（两段式：调用 focusById 前 / 后 读同一个盘的 visible）")
        print(f"    群外 {json.dumps(rv_out, ensure_ascii=False)}")
        print(f"    正对照 {json.dumps(rv_ctl, ensure_ascii=False)}")
        check("focusById 能把群外成员点亮（含补标签）",
              bool(rv_out and rv_out.get("found") and rv_out.get("before") is False
                   and rv_out.get("after") is True and rv_out.get("labelBefore") is False
                   and rv_out.get("labelAfter") is True),
              f"{out_id}：visible {rv_out.get('before') if rv_out else None}"
              f" → {rv_out.get('after') if rv_out else None}"
              f" · 标签登记 {rv_out.get('labelBefore') if rv_out else None}"
              f" → {rv_out.get('labelAfter') if rv_out else None}"
              f"（两段都要动；只动一段说明这个量具看不见变化）")
        check("正对照：本来就在画的成员不受影响",
              bool(rv_ctl and rv_ctl.get("found") and rv_ctl.get("before") is True
                   and rv_ctl.get("after") is True),
              f"{vis}：visible {rv_ctl.get('before') if rv_ctl else None}"
              f" → {rv_ctl.get('after') if rv_ctl else None}（应保持 true）")
        page.screenshot(path=os.path.join(args.outdir, "lg-core-revealed.png"))

        # 判据五：**跨尺度**那条路（从目录 / 搜索跨层飞过去）—— 用户更常走的就是这条。
        # 它量的是 `engine.goTo()` 的跨层分支，与上面那条（`focusById`）是**两个不同入口**：
        # 上面绿了这条仍可能是坏的（改之前正是如此）。
        # ⚠️ 这里**没有 `before === false` 那一段** —— 不是省事，是那段在物理上取不到
        #    （重建发生在被测动作内部）。替代它的两个条件见 CROSS_JS 上面那段说明：
        #    `gone` + `rebuilt` 必须为 True（盘是这次新造的）+ 下面那条独立自证。
        print("\n  跨尺度飞过去看得见（走 engine.goTo 的跨层分支：先离开本层，再带 focus 回来）")
        cr = page.evaluate(CROSS_JS, out_id) if out_id else None
        print(f"    跨层 {json.dumps(cr, ensure_ascii=False)}")
        check("跨尺度飞过去也点亮群外成员（跨层分支）",
              bool(cr and cr.get("after") is True and cr.get("level") == "localgroup"
                   and cr.get("gone") is True and cr.get("rebuilt") is True
                   and cr.get("transitioning") is False),
              f"{out_id}：{cr.get('from') if cr else None} → localgroup"
              f" · 离开后本层被释放={cr.get('gone') if cr else None}"
              f" · 盘被重建={cr.get('rebuilt') if cr else None}（必须 True：False 说明读的是旧对象 ⇒ 假绿）"
              f" · visible {cr.get('beforeLeave') if cr else None}（离开前）→ {cr.get('after') if cr else None}"
              f" · 过渡已结束={not (cr.get('transitioning') if cr else True)}")

        # 判据五的自证：把钩子打成空实现，**同一个动作**必须不再点亮。
        # ⚠️ 缺了这一条，`after === true` 可能只是「重建后本来就 true」之类的假绿（量具没打在动作上）。
        dis = page.evaluate(DISARM_JS)
        cr2 = page.evaluate(CROSS_JS, out_id) if out_id else None
        rst = page.evaluate(RESTORE_JS)
        print(f"    注入后（revealById 打成空实现）{json.dumps(cr2, ensure_ascii=False)} · 已还原 {json.dumps(rst, ensure_ascii=False)}")
        check("自证：钩子被打空后同一个动作不再点亮",
              bool(dis and dis.get("armed") and dis.get("nameAfter") == ""
                   and cr2 and cr2.get("after") is False
                   and rst and rst.get("name") == "revealById"),
              f"打空前 armed={dis.get('armed') if dis else None}"
              f" · 打空后 visible {cr2.get('after') if cr2 else None}（必须 false）"
              f" · 还原后钩子名 {rst.get('name') if rst else None}")

        if errs:
            print("\n  控制台错误")
            for e in errs[:10]:
                print("    !", e[:180])
            check("无控制台错误", False, f"{len(errs)} 条")
        else:
            check("无控制台错误", True, "0 条")

        browser.close()

    print("")
    if fails:
        print(f"  未通过 {len(fails)} / {total[0]} 项：{', '.join(fails)}")
        sys.exit(1)
    # ⚠️ 报出**实跑条数**：本项目已经出现过「手数判据条数、数错、写进文档」的事故
    #（第 36 轮把 20 条写成 12 条）。条数只认这一行，别在别处抄。
    print(f"  全部通过：{total[0]} 项判据。")


if __name__ == "__main__":
    main()

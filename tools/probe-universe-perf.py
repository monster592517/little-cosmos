#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""可观测宇宙层：帧时间**绝对线** + 逐对象的成本**归因**。

## 为什么必须有这个东西

怪怪的硬指标写在那儿：**帧时间中位数 < 16.7 ms，不能卡顿**。
而「可观测宇宙」这一层刚被大改过 —— 新增 70000 个宇宙网点 + 5939 个类星体点
（外加原有的 179 个星系点云、CMB 球、7 个结构/环）。只看截图说「好看了」
不能交付：`坑与雷点.md` 里有一句原话就是「**性能影响未实测**，接进去之前必须补帧时间」。

且**不许猜瓶颈**（坑 86：第一嫌疑实测只占 3%）。所以这个探针做两件事：
① 绝对线：出货默认状态下量帧时间中位数，与 16.7 ms 比；
② 归因：把每个对象单独藏起来再量，差值就是它的成本。

## ★★ 量法：为什么**不能**用 rAF 间隔（这一版是重写的，第一版就是错的）

第一版偷懒沿用了 `probe-bloom-kernel-perf.py` 的「rAF 帧间隔」量法，实测**当场失明**：

    静止 中位 0.30 ms · 出货默认 中位 0.40 ms          ← 2500 FPS，配 16.7 ms 的预算
    关掉宇宙网 → 1.00 ms（Δ −0.60）                  ← 藏东西反而「变慢」
    关掉宇宙网/类星体/星系 ⇒ 整屏均值 +0.84 / +1.09 / +1.35  ← 藏东西画面变**亮**

三个症状指向两件独立的事：

**（一）rAF 间隔在窗口没被真正显示时＝命令提交耗时，不是帧成本。**
`engine.js:744` 是 `if (this._paused) return;`，引擎每帧 `_frame()` 里
`composer.render(dt)` 把 WebGL 命令**排队**就返回了（WebGL 是异步队列，这是最经典的假读）。
背压只来自「合成器真的来取帧」—— 窗口被遮住/不在前台时**没有背压**
⇒ 排队排得飞快 ⇒ rAF 间隔 0.3 ms。而 GPU 到底干完没干完，它**不知道**。
（project 原有注释记的是相反方向的失明：「遮挡时 Chromium 挂起 rAF」。
两种都会发生，取决于遮挡方式 ⇒ **不能靠「rAF 有没有跑」判断量具是否可信。**）

**（二）相机在自转 ⇒ 每次截图是不同角度。**
mean 在「藏了东西」时反而上升，只有一种解释：**视角变了**（坑 127 的位置效应换了张脸）。

⇒ 现在改用**同步整帧计时**（与 `probe-bloom-kernel-perf.py` 的「量具 B」同口径，
  那里的原话是「`gl.finish()` 是必须的 —— 不加它量到的只是命令提交耗时」）：

    eng._paused = true            // 关掉引擎自己的 rAF 循环，不让它插进测量
    eng.controls.autoRotate = false
    循环 { t0 = now(); eng._frame(); gl.finish(); 记录 now() - t0 }

`_frame()` 是**完整的一帧**（引擎自己在 `start()` 的 loop 里调的就是它，
含 controls.update / 层级 update / composer 三级链 / 标签投影）。`gl.finish()` 保证
量到的是「GPU 真的干完了」，不是「命令交出去了」。这个量**不受窗口是否可见影响**。

## 量具先自证，再量对象

① **噪声地板**：同一状态连量两次，报 |Δ|。地板之上的差才算差。
② **正对照**：把所有几何**全藏起来**，必须**明显变快**。如果连正对照都不动，
   说明这个量具看不见场景变化 —— 后面所有归因读数全部作废。

## 用法

    py -3.13 -X utf8 tools/probe-universe-perf.py                 # 默认真实 Edge、有头
    py -3.13 -X utf8 tools/probe-universe-perf.py --gpu=hp         # 逼独显
    py -3.13 -X utf8 tools/probe-universe-perf.py --shot           # 落截图
    py -3.13 -X utf8 tools/probe-universe-perf.py --level=galaxy   # 换一层（对照）

退出码：0 = 量到了；1 = 页面没起来 / 量具没自证通过。
**达标与否看 ① 那一行，不看退出码。**
"""
import asyncio
import io
import os
import sys

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402
from browser_args import OCCLUSION_ARGS         # noqa: E402

BROWSER = 'edge'
HEADED = True
GPU = 'auto'
SHOT = False
LEVEL = 'universe'
REPS = 40                 # 每次量多少个「批」
BATCH = 20                # 每批多少帧（分辨率 = 计时器步长 / BATCH）
WARM = 5                  # 预热批（丢）
BUDGET_FRAME_MS = 16.7

for a in sys.argv[1:]:
    if a.startswith('--browser='):
        BROWSER = a.split('=', 1)[1]
    elif a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--gpu='):
        GPU = a.split('=', 1)[1]
    elif a.startswith('--level='):
        LEVEL = a.split('=', 1)[1]
    elif a.startswith('--reps='):
        REPS = int(a.split('=', 1)[1])
    elif a == '--shot':
        SHOT = True


# ---------------------------------------------------------------------------
# 页面内：同步整帧计时（**主量具**）
# ---------------------------------------------------------------------------
# ⚠️ 这一版是**第二次重写**，两次失明的原因不同，都要记下来：
#
# 失明①（rAF 间隔）：窗口不在前台时没有合成背压 ⇒ 量到的是命令提交耗时。见文件头。
# 失明②（`gl.finish()` + 单帧计时）：整层读数 0.200 ms，而「几何全藏」也是 0.200 ms
#        —— 不是量具瞎了，是**量程不够**：`performance.now()` 在 Chromium 里被
#        夹到 100 µs 精度，而这一层的真实成本连这个步长都不到
#        （把它全部画一遍也就 ~0.2 ms）。拿一把毫米刻度的尺量 0.2 毫米，
#        读数永远是 0 或者 1 格。
#        ⇒ 两条解药：
#          · **批量**：一次量 K 帧的总耗时再除以 K，分辨率直接降 K 倍；
#          · **真同步**：`gl.finish()` 在 Chromium/ANGLE 上**不足以**保证 GPU 干完
#            （命令还在队列里它就返回了）。真正能同步的是 `readPixels`
#            —— 它必须把结果取回来，所以必须等前面的活全部做完。
#        ⚠️ 这条是对本项目既有说法的**修正**：`probe-bloom-kernel-perf.py` 写着
#           「`gl.finish()` 是必须的 —— 不加它量到的只是命令提交耗时」，
#           方向是对的（要同步），但 `gl.finish()` 这个手段**在 ANGLE 上不够**。
#           那边能分辨出 kernel 变体的差别，是因为泛光本身够贵、贵到提交也超过地板。
SYNC_JS = r"""
([reps, batch, warm]) => {
  const e = window.__universe.engine;
  const r = e.renderer;
  let gl = null;
  try { gl = r.getContext(); } catch (err) { return { ok: false, why: '拿不到 WebGL 上下文' }; }
  if (!gl) return { ok: false, why: '拿不到 WebGL 上下文' };
  const px = new Uint8Array(4);
  const cx = Math.floor(e.size.w / 2), cy = Math.floor(e.size.h / 2);
  let syncErr = null;
  const sync = () => {
    try { gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    catch (err) { if (!syncErr) syncErr = err.message; }
  };
  const wasPaused = e._paused;
  const wasRot = e.controls ? e.controls.autoRotate : null;
  e._paused = true;                                  // 不让引擎自己的 rAF 循环插进来
  if (e.controls) e.controls.autoRotate = false;     // 钉住视角：否则同一状态两次量的是两个角度
  const t = [];
  let pixel = null;
  try {
    for (let w = 0; w < warm; w++) { e._frame(); sync(); }
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      for (let k = 0; k < batch; k++) e._frame();
      sync();                                        // ★ 真同步点：读回中心像素
      t.push((performance.now() - t0) / batch);
      if (i === reps - 1) pixel = [px[0], px[1], px[2], px[3]];
    }
  } finally {
    if (e.controls && wasRot !== null) e.controls.autoRotate = wasRot;
    e._paused = wasPaused;
  }
  t.sort((a, b) => a - b);
  const q = (p) => +t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(4);
  return {
    ok: true, n: t.length, batch, reps,
    min: q(0), p25: q(0.25), median: q(0.5), p95: q(0.95), max: +t[t.length - 1].toFixed(4),
    pixel, syncErr,
    visibility: document.visibilityState, hidden: !!document.hidden,
  };
}
"""

# 页面内：rAF 帧间隔（**副量具，只留作对照**；窗口不在前台时它会失明，见文件头）
RAF_JS = r"""
([n, budgetMs]) => Promise.race([
  new Promise(res => {
    const times = [];
    let last = performance.now();
    let i = 0;
    const tick = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (++i < n) requestAnimationFrame(tick);
      else {
        const s = times.slice(3).sort((a, b) => a - b);
        res({
          n: s.length, min: +s[0].toFixed(2),
          median: +s[Math.floor(s.length / 2)].toFixed(2),
          p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
        });
      }
    };
    requestAnimationFrame(tick);
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error(
    'rAF 在 ' + budgetMs + ' ms 内没跑完 ' + n + ' 帧 —— 窗口被遮挡/最小化时浏览器会挂起 rAF')),
    budgetMs)),
])
"""

SETTLE_JS = r"""
([frames, minMs, budgetMs]) => Promise.race([
  new Promise(res => {
    let i = 0;
    const t0 = performance.now();
    const tick = () => {
      if (++i >= frames && performance.now() - t0 >= minMs) res(i);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }),
  new Promise((_, rej) => setTimeout(
    () => rej(new Error('settle 在 ' + budgetMs + ' ms 内没等到 rAF')), budgetMs)),
])
"""

INFO_JS = r"""
() => {
  const eng = window.__universe.engine;
  const r = eng.renderer, lv = eng.current;
  let gpuName = '?';
  try {
    const gl = r.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    gpuName = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { gpuName = '取不到：' + e.message; }
  const n = (o) => (o && o.geometry && o.geometry.attributes.position
    ? o.geometry.attributes.position.count : null);
  return {
    level: lv && lv.id,
    tier: eng.gpu && eng.gpu.tier && eng.gpu.tier.id,
    pixelRatio: +r.getPixelRatio().toFixed(3),
    canvas: [eng.size.w, eng.size.h],
    gpu: gpuName,
    paused: !!eng._paused,
    autoRotate: !!(eng.controls && eng.controls.autoRotate),
    autoRotateSpeed: eng.controls && eng.controls.autoRotateSpeed,
    bloomEnabled: !!(eng.bloomPass && eng.bloomPass.enabled),
    bloomStrength: eng.bloomPass && eng.bloomPass.strength,
    optionsLabels: !!(eng.options && eng.options.labels),
    points: { web: n(lv && lv.web), quasars: n(lv && lv.quasars), galaxies: n(lv && lv.galaxies) },
    counts: { quasarCount: lv && lv.quasarCount, universeGalaxyCount: lv && lv.universeGalaxyCount },
    camDist: lv && lv.camera && eng.controls
      ? +lv.camera.position.distanceTo(eng.controls.target).toFixed(3) : null,
    visibility: document.visibilityState,
  };
}
"""

# 消融：按**层的公开字段**取对象（不按名字、不按下标 —— 下标会漂）
ABLATE_JS = r"""
([key, on]) => {
  const eng = window.__universe.engine;
  const lv = eng.current;
  if (!lv) return 'no-level';
  const set = (o) => { if (o) o.visible = on; };
  if (key === 'web') { if (!lv.web) return 'miss'; set(lv.web); }
  else if (key === 'quasars') { if (!lv.quasars) return 'miss'; set(lv.quasars); }
  else if (key === 'galaxies') { if (!lv.galaxies) return 'miss'; set(lv.galaxies); }
  else if (key === 'cmb') { if (!lv.cmb) return 'miss'; set(lv.cmb); }
  else if (key === 'structures') {
    if (!lv.nodes) return 'miss';
    for (const s of lv.nodes.values()) s.visible = on;
    set(lv.rings);
  }
  else if (key === 'all-geometry') {
    for (const k of ['web', 'quasars', 'galaxies', 'cmb']) set(lv[k]);
    if (lv.nodes) for (const s of lv.nodes.values()) s.visible = on;
    set(lv.rings);
  }
  else if (key === 'labels') {
    /* ⚠️ 只 `labels.setVisible(false)` 不够：主循环是
     *    `if (active && this.options.labels) active.labels.update(...)`，
     *    所以 options 一起关，才是 UI 复选框真正做的事。 */
    if (!lv.labels) return 'miss';
    lv.labels.setVisible(on);
    if (eng.options) eng.options.labels = on;
  }
  else if (key === 'bloom') {
    /* ⚠️ **必须关 `options.bloom`，不能关 `bloomPass.enabled`。**
     *    `engine.js` 的 `_frame()` 里每帧都有一句
     *        this.bloomPass.enabled = this.options.bloom !== false;
     *    所以直接写 `bloomPass.enabled = false` 会被**下一帧原样写回 true**
     *    —— 消融看着接上了（返回 'ok'），其实什么都没发生，读数 Δ≈0，
     *    而且不报错。本探针第一版就是这么被骗的（泛光 Δ +0.0050 ms = 0.7%）。
     *    这就是「哑开关」（坑 130）在**探针侧**的同一张脸：
     *    判断消融有没有生效，不能看它返回成功，要看**读数动不动**。 */
    if (!eng.bloomPass) return 'miss';
    if (!eng.options) return 'miss';
    eng.options.bloom = on;
    eng.bloomPass.enabled = on;
  }
  else if (key.indexOf('only:') === 0) {
    /* 单项隔离：先把**全部**几何藏掉，再把目标那一个放回来。
     * 用途：回答「这东西到底看不看得见」—— 消融只告诉你它占了多少钱，
     * 不告诉你它是否可见（「屏均值贡献 1.17」和「眼睛看不见」可以同时成立）。
     * `on = true` → 隐藏其它、只显目标；`on = false` → 全部还原。
     *
     * ⚠️ **这个分支第一次写错了，而且错法很值得记：**
     *    我顺手复用了上面那个 `set(o)` 小工具，而 `set` 的内部是
     *    `o.visible = on` —— 它把**外层的 `on`** 闭包进去了。
     *    于是「先全藏」这句写成了 `set(lv[k])`，在 `on = true` 时
     *    变成「全显」⇒ 什么都没隔离，四个不同的 `only:` **读数完全一样**
     *    （实测 9.231 / 9.242 / 9.258 / 9.268）。
     *    这就是「单项隔离什么都没干」的**签名**：几个不同目标给出同一个数。
     *    ⇒ 老老实实显式写 `false` / `true`，不要为了省事复用一个带隐含参数的助手。 */
    const which = key.slice(5);
    const groups = [lv.web, lv.quasars, lv.galaxies, lv.cmb].filter(Boolean);
    const nodes = lv.nodes ? [...lv.nodes.values()] : [];
    if (!on) {
      for (const o of groups) o.visible = true;
      for (const s of nodes) s.visible = true;
      if (lv.rings) lv.rings.visible = true;
      return 'ok';
    }
    for (const o of groups) o.visible = false;
    for (const s of nodes) s.visible = false;
    if (lv.rings) lv.rings.visible = false;
    if (which === 'structures') {
      for (const s of nodes) s.visible = true;
      if (lv.rings) lv.rings.visible = true;
    } else if (lv[which]) {
      lv[which].visible = true;
    } else {
      return 'miss';
    }
  }
  else return 'unknown-key';
  return 'ok';
}
"""


ROTATE_JS = r"""
(on) => {
  const eng = window.__universe.engine;
  if (!eng.controls) return 'no-controls';
  const was = !!eng.controls.autoRotate;
  eng.controls.autoRotate = !!on;
  return was;
}
"""


def lum_stats(png_bytes):
    """整屏亮度均值 / 近黑占比 / 亮像素占比。视角被钉住之后，这个量才有比较意义。"""
    try:
        from PIL import Image
    except Exception as e:                                   # pragma: no cover
        return {'err': f'PIL 不可用：{e}'}
    im = Image.open(io.BytesIO(png_bytes)).convert('RGB')
    px = im.load()
    w, h = im.size
    tot = 0
    dark = 0
    bright = 0
    n = 0
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            r, g, b = px[x, y]
            v = 0.2126 * r + 0.7152 * g + 0.0722 * b
            tot += v
            if v < 12:
                dark += 1
            if v > 96:
                bright += 1
            n += 1
    return {'mean': round(tot / n, 3), 'darkPct': round(100.0 * dark / n, 2),
            'brightPct': round(100.0 * bright / n, 2)}


async def run():
    with ServedCheck() as base:
        emit(f'  服务已起：{base}')
        args = ['--use-angle=d3d11']
        # 有头时窗口被别的窗口盖住 ⇒ Chromium 判降级：rAF 节流 / 合成器不出新帧
        # ⇒ 量到的是「等帧的时间」，不是渲染成本（且偏慢 ⇒ 会得出「性能变差了」的假结论）。
        # 见坑 136 / 坑 149；开关的唯一来源是 `tools/browser_args.py`。
        args += OCCLUSION_ARGS
        if GPU == 'hp':
            args += ['--force_high_performance_gpu']
        elif GPU == 'lp':
            args += ['--force_low_power_gpu']
        async with async_playwright() as pw:
            if BROWSER == 'bundled':
                browser = await pw.chromium.launch(headless=not HEADED, args=args)
            else:
                ch = 'msedge' if BROWSER == 'edge' else 'chrome'
                browser = await pw.chromium.launch(headless=not HEADED, channel=ch, args=args)
            page = await browser.new_page(viewport={'width': 1400, 'height': 860})
            try:
                await page.goto(base + '/', wait_until='load')
            except Exception as e:
                emit(f'  ✗ 页面没起来：{e}')
                await browser.close()
                return 1
            await page.wait_for_function(
                'window.__universe && window.__universe.engine && window.__universe.dataset',
                timeout=60000)
            try:
                await page.bring_to_front()
            except Exception:
                pass

            r = await page.evaluate(f'window.__universe.gotoScale("{LEVEL}")')
            await page.wait_for_function(
                f"window.__universe.engine.current && window.__universe.engine.current.id === '{LEVEL}'",
                timeout=60000)
            await page.evaluate(SETTLE_JS, [20, 800.0, 20000])
            emit(f'  gotoScale("{LEVEL}") → {r}')

            info = await page.evaluate(INFO_JS)
            emit('')
            emit('=' * 100)
            emit(f'  {LEVEL} 层 · 帧时间（同步整帧计时：{REPS} 次重复，丢前 {WARM} 次）')
            emit('=' * 100)
            emit(f'  画质档 {info["tier"]} · pixelRatio {info["pixelRatio"]}'
                 f' · 画布 {info["canvas"][0]}×{info["canvas"][1]} · 泛光 {info["bloomEnabled"]}'
                 f'（strength {info["bloomStrength"]}）')
            emit(f'  GPU    {info["gpu"]}')
            emit(f'  页面   visibilityState={info["visibility"]} · engine._paused={info["paused"]}'
                 f' · 默认自转 autoRotate={info["autoRotate"]} speed={info["autoRotateSpeed"]}')
            emit(f'  点云   宇宙网 {info["points"]["web"]} · 类星体 {info["points"]["quasars"]}'
                 f'（数据 {info["counts"]["quasarCount"]}）'
                 f' · 星系 {info["points"]["galaxies"]}（数据 {info["counts"]["universeGalaxyCount"]}）')
            emit(f'  相机   距靶 {info["camDist"]}')

            async def shot(name):
                b = await page.screenshot()
                p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'shots',
                                 f'_uperf-{LEVEL}-{name}.png')
                if SHOT:
                    with open(os.path.abspath(p), 'wb') as f:
                        f.write(b)
                return lum_stats(b)

            def line(tag, m):
                med = m['median']
                share = med / BUDGET_FRAME_MS * 100
                flag = '✓' if med < BUDGET_FRAME_MS else '✗ 越线'
                emit(f'  {tag:<24} 中位 {med:>8.4f} ms（占预算 {share:>6.2f}%）{flag}'
                     f'   p25 {m["p25"]:>8.4f} · p95 {m["p95"]:>8.4f}'
                     f' · min {m["min"]:>8.4f} · max {m["max"]:>8.4f}')
                if m.get('syncErr'):
                    emit(f'    ⚠ readPixels 同步失败（{m["syncErr"]}）⇒ 这个数只是提交耗时')

            # ---------- ★ 全程钉住视角 ----------
            # 只在 SYNC_JS 内部钉住是不够的：那管不到**截图**。出来就还原成
            # 出货默认的 autoRotate=true，于是每张截图一个角度，所有屏均值差
            # 全是漂移（实测：所有对象的 Δ 都是 -1.0 ~ -1.2，方向一致 ⇒ 那不是效应）。
            rot_was = await page.evaluate(ROTATE_JS, False)
            emit(f'  ★ 量测期间已把 autoRotate 从 {rot_was} 钉为 false'
                 f'（否则每张截图一个角度，亮度差不可比）；收工前还原。')
            emit('')

            # ---------- ① 绝对线 ----------
            emit('  ① 绝对线')
            try:
                raf = await page.evaluate(RAF_JS, [90, 30000])
                emit(f'  [副量具] rAF 间隔     中位 {raf["median"]:>7.2f} ms  p95 {raf["p95"]:>7.2f}'
                     f'  min {raf["min"]:>7.2f}   ← 窗口不在前台时这个数会失明，只作对照')
            except Exception as e:
                emit(f'  [副量具] rAF 间隔     量不了：{str(e)[:110]}')
            base = await page.evaluate(SYNC_JS, [REPS, BATCH, WARM])
            if not base.get('ok'):
                emit(f'  ✗ 主量具不可用：{base.get("why")}')
                await browser.close()
                return 1
            line('静止（视角钉住）', base)
            base_med = base['median']
            emit(f'  量法   {REPS} 批 × 每批 {BATCH} 帧 ÷ {BATCH}（分辨率 ≈ 0.1ms/{BATCH}'
                 f' = {0.1 / BATCH:.4f} ms）· 中心像素 {base.get("pixel")}')

            # ---------- 量具自证 ----------
            emit('')
            emit('  ② 量具自证（没通过的话，下面全部读数作废）')
            floor = await page.evaluate(SYNC_JS, [REPS, BATCH, WARM])
            d_floor = abs(floor['median'] - base_med)
            emit(f'    噪声地板：同一状态再量一次 中位 {floor["median"]:.4f} ms'
                 f' ⇒ |Δ| {d_floor:.4f} ms（{d_floor / base_med * 100:.1f}%）'
                 + ('  ✓ 地板可接受' if d_floor < max(0.02, base_med * 0.1)
                    else '  ⚠ 地板偏高，下列 Δ 需大于它才可信'))
            full_shot = await shot('full')          # ★ 「全开」参照必须在藏任何东西**之前**取
            r0 = await page.evaluate(ABLATE_JS, ['all-geometry', False])
            pos = await page.evaluate(SYNC_JS, [REPS, BATCH, WARM])
            pos_shot = await shot('all-hidden')
            await page.evaluate(ABLATE_JS, ['all-geometry', True])
            d_pos = base_med - pos['median']
            pos_need = max(d_floor * 3, base_med * 0.05)
            emit(f'    正对照：几何全藏 ⇒ 中位 {pos["median"]:.4f} ms'
                 f'（Δ {d_pos:+.4f} ms，{d_pos / base_med * 100:.1f}%）· 中心像素 {pos.get("pixel")}'
                 f'（要求 Δ > {pos_need:.4f} ms）'
                 + ('  ✓ 量具看得见场景变化' if d_pos > pos_need
                    else '  ✗ 正对照都不动 —— 量具看不见场景变化，归因作废'))
            emit(f'    正对照（亮度侧）：屏均值 {full_shot["mean"]:.3f} → {pos_shot["mean"]:.3f}'
                 f'（Δ {pos_shot["mean"] - full_shot["mean"]:+.3f}）'
                 + ('  ✓ 消融真的把东西拿掉了' if pos_shot['mean'] < full_shot['mean'] - 0.02
                    else '  ✗ 画面没变 ⇒ 消融是空实现'))
            pos_ok = d_pos > pos_need and pos_shot['mean'] < full_shot['mean'] - 0.02

            # ---------- ③ 归因 ----------
            emit('')
            emit('  ③ 归因（依次只藏一个对象；视角已钉住，所以亮度差是可比的了）')
            label_cn = {'web': '宇宙网（程序化）', 'quasars': '类星体（真实）',
                        'galaxies': '星系点云（真实）', 'cmb': '宇宙微波背景球',
                        'structures': '已知结构 + 距离环', 'labels': '标签层（DOM）',
                        'bloom': '泛光通道', 'all-geometry': '（全部几何）'}
            rows = []
            full_mean = full_shot['mean']
            for key in ['web', 'quasars', 'galaxies', 'cmb', 'structures', 'labels', 'bloom']:
                r0 = await page.evaluate(ABLATE_JS, [key, False])
                if r0 != 'ok':
                    emit(f'    {label_cn[key]:<20} ⚠ 消融没接上（{r0}）—— 这一行作废')
                    await page.evaluate(ABLATE_JS, [key, True])
                    continue
                m = await page.evaluate(SYNC_JS, [REPS, BATCH, WARM])
                ls = await shot(f'no-{key}')
                await page.evaluate(ABLATE_JS, [key, True])
                d = base_med - m['median']
                dmean = ls['mean'] - full_mean
                rows.append((key, d, m['median'], dmean))
                warn = ''
                if key not in ('labels', 'bloom') and abs(dmean) < max(0.02, full_mean * 0.002):
                    warn = '  ⚠ 整屏亮度几乎没动 —— 疑似空实现'
                if abs(d) < d_floor:
                    warn += '  ⚠ Δ 在地板以内'
                emit(f'    {label_cn[key]:<20} 中位 {m["median"]:>8.4f} ms · Δ {d:>+8.4f} ms'
                     f'（{d / base_med * 100:>+6.1f}%）· 屏均值 {ls["mean"]:>7.3f}'
                     f'（Δ {dmean:>+7.3f}）{warn}')

            emit('')
            emit('  ④ 单项隔离（只留一个对象，其余全藏）—— 这一节**只报数，不判过不过**')
            emit(f'     参照：几何全藏 = 均值 {pos_shot["mean"]:.3f} / 近黑 {pos_shot["darkPct"]}%'
                 f' / 亮 {pos_shot["brightPct"]}%；全开 = 均值 {full_shot["mean"]:.3f}'
                 f' / 近黑 {full_shot["darkPct"]}% / 亮 {full_shot["brightPct"]}%')
            # ⚠️ 这里原来给每项定了一条「净贡献均值 ≥ 1.0/255」的判据，**那条是错的**：
            #    它把「面积」和「可见度」混成一个量。小面积亮斑的均值贡献有数学上限 ——
            #    银河系那个亮斑只占全屏 0.17% 的像素，**就算它纯白（255）也只能贡献 0.43**，
            #    所以拿 1.0 去卡它永远不可能过，而它在画面上清晰可见（实测 0.125）。
            #    ⇒ 均值只适合**铺满整屏的底噪**（宇宙网），不适合点状目标。
            #      与其硬分两套门槛，不如**不在这一节判过不过**，只把两个量都报出来，
            #      可见性由下面那条**全开 vs 全藏**的判据统一判。
            for key in ['web', 'quasars', 'galaxies', 'structures']:
                r0 = await page.evaluate(ABLATE_JS, ['only:' + key, True])
                if r0 != 'ok':
                    emit(f'    {label_cn.get(key, key):<20} ⚠ 隔离没接上（{r0}）')
                    await page.evaluate(ABLATE_JS, ['only:' + key, False])
                    continue
                ls = await shot(f'only-{key}')
                await page.evaluate(ABLATE_JS, ['only:' + key, False])
                gain = ls['mean'] - pos_shot['mean']
                dbr = ls['brightPct'] - pos_shot['brightPct']
                emit(f'    {label_cn.get(key, key):<20} 均值 {ls["mean"]:>7.3f}'
                     f'（净 {gain:>+6.3f}/255）· 近黑 {ls["darkPct"]:>6.2f}%'
                     f'（净 {ls["darkPct"] - pos_shot["darkPct"]:>+6.2f}pp）'
                     f' · 亮像素 {ls["brightPct"]:>5.2f}%（净 {dbr:>+5.2f}pp）')

            emit('')
            emit('=' * 100)
            emit('  结论')
            emit('=' * 100)
            ok = base_med < BUDGET_FRAME_MS
            emit(f'  ① 帧时间中位数（出货默认画质档 / 视角钉住）{base_med:.4f} ms'
                 f' vs 硬指标 16.7 ms → ' + ('**通过**' if ok else '**不通过**')
                 + f'  余量 {BUDGET_FRAME_MS / max(base_med, 1e-6):.0f}×')
            # ★ 可见性判据（唯一）：本层「不是空的」这句话要能量。
            #   取**全开 vs 几何全藏**的近黑占比差：一个「有内容」的画面必须让
            #   近黑像素显著减少。门槛 10pp 是**预登记**的（先写下来再跑）。
            dk = pos_shot['darkPct'] - full_shot['darkPct']
            emit(f'  ② 可见性：全开 近黑 {full_shot["darkPct"]}% vs 几何全藏 {pos_shot["darkPct"]}%'
                 f' ⇒ 差 {dk:.2f}pp（判据 ≥ 10pp）→ ' + ('**通过**' if dk >= 10 else '**不通过：画面仍然等于空的**'))
            emit(f'     旁证：亮像素 {pos_shot["brightPct"]}% → {full_shot["brightPct"]}%'
                 f'（×{full_shot["brightPct"] / max(pos_shot["brightPct"], 1e-6):.2f}）'
                 f'；屏均值 {pos_shot["mean"]:.3f} → {full_shot["mean"]:.3f}')
            if not pos_ok:
                emit('  ③ ✗ 量具自证未通过 ⇒ 归因结论作废（先把量具修好）')
            elif rows:
                sig = [r for r in rows if abs(r[1]) >= max(d_floor, base_med * 0.02)]
                if sig:
                    worst = max(sig, key=lambda r: r[1])
                    emit(f'  ③ 地板 {d_floor:.4f} ms 之上可分辨的项：'
                         + '、'.join(f'{label_cn[r[0]]} {r[1]:+.4f}' for r in sorted(sig, key=lambda x: -x[1]))
                         + f'  ⇒ 最贵的是 {label_cn[worst[0]]}（{worst[1] / base_med * 100:.1f}%）')
                else:
                    emit(f'  ③ 所有 Δ 都在噪声地板（{d_floor:.4f} ms）以内'
                         f' ⇒ 本层**没有单个大头**，别再猜了')
            emit('')
            emit('  ⚠ 归因栏里有负 Δ（藏了东西反而更快）—— 那是**顺序漂移**，不是收益：'
                 '越靠后测的越慢。'
                 '要压掉它得把消融**交错**着测（A/B/A/B），本版没做，所以只有**大而稳**的项可信。')
            emit('')
            try:
                await page.evaluate(ROTATE_JS, rot_was)     # 还原出货默认
            except Exception:
                pass
            await browser.close()
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        sys.exit(asyncio.run(run()))
    except Exception as e:
        emit(f'  ✗ 探针自己炸了：{type(e).__name__}: {e}')
        sys.exit(1)

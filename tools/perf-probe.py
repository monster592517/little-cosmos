#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""性能与显存探针：这个程序到底吃谁的内存？

为什么有这个东西
----------------
用户反馈「内存压力太大了」，并提出「把一部分计算换成矩阵乘法、吃显卡的显存」。

**这是一个需要先测量的请求，不是一个可以照着做的请求**，因为：

1. 「内存压力大」有两种完全不同的病 —— ① 本程序（浏览器标签页）在吃；
   ② 宿主/系统别的东西在吃。**开错药会把没参与的东西改一遍，真凶照旧。**
2. 「搬到显存」只在**浏览器真的用上了硬件 GPU** 时才成立。
   软件渲染（SwiftShader / llvmpipe）下，「GPU 计算」是 CPU 自己模拟的，
   搬过去不但不会更快，还会**多一份 CPU 侧缓冲**，把内存压力变得更大。

所以本脚本只做两件事，不预设结论：
  · 报出**这个页面**的 WebGL 后端是谁、JS 堆多大、显存侧对象几何/贴图多少个；
  · 报出**六个尺度各自**在场景里挂了几个对象 —— 好看出「大头在哪一层」。

用法：
    py -3.13 -X utf8 tools/perf-probe.py                  # 默认真实 Edge、有头模式
    py -3.13 -X utf8 tools/perf-probe.py --browser=bundled  # Playwright 自带（软件渲染，作对照）
    py -3.13 -X utf8 tools/perf-probe.py --headed=false      # 无头（通常拿不到硬件 GPU）

⚠ 有头模式会真的弹一个浏览器窗口，跑完自己关。无头模式常拿不到硬件 GPU，
  对比时要看清 renderer 字段 —— 别把「无头拿不到 GPU」当成「用户也没有 GPU」。

退出码：0 = 测到了；1 = 页面没起来 / 拿不到句柄。
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit, ROOT   # noqa: E402
from browser_args import OCCLUSION_ARGS               # noqa: E402

BROWSER = 'edge'          # edge | bundled | chrome
HEADED = True
GPU = 'auto'              # auto | hp | lp —— 强制高性能/低功耗 GPU（Chromium 开关）
ALL_LEVELS = False        # 是否先把六个尺度都逛一遍再测（看最坏情况的占用）
LABEL_COST = False        # 是否隔离计时「标签投影」—— 每帧唯一的大批量矩阵运算
for a in sys.argv[1:]:
    if a.startswith('--browser='):
        BROWSER = a.split('=', 1)[1]
    elif a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--gpu='):
        GPU = a.split('=', 1)[1]
    elif a == '--all-levels':
        ALL_LEVELS = True
    elif a == '--label-cost':
        LABEL_COST = True

# 混合显卡笔记本（核显 + 独显）默认会挑核显省电。核显的「显存」是**从系统内存借的**，
# 所以「把负载搬到显存」在核显上等于「搬到系统内存」—— 恰恰相反。
# 这个开关用 Chromium 自带的偏好开关逼它挑独显，是本探针的**决定性测量**：
# 不碰任何系统设置，只看「换卡之后后端是不是真的变了」。
GPU_ARGS = []
if GPU == 'hp':
    GPU_ARGS = ['--force_high_performance_gpu']
elif GPU == 'lp':
    GPU_ARGS = ['--force_low_power_gpu']

# 有头模式下窗口被别的窗口盖住时，Chromium 会把 rAF 降频甚至暂停
# ⇒ 量到的「帧时间」是「窗口被遮挡的等待时间」，不是渲染成本（而且它比真实值更慢，
#   会把人引向「性能变差了」的假结论）。
# 2026-09-12：有头跑起来卡在「打开浏览器」4m39s 无输出，就是漏了这三条；
# 补上后同一台机器 22 秒跑完。**开关的唯一来源是 `tools/browser_args.py`**（坑 149：
# 以前把它散在各处写死、还在文档里维护一份手写名单，结果 20 个有头探针只有 3 个真带了）。
GPU_ARGS = GPU_ARGS + OCCLUSION_ARGS

LEVELS = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe']

# 在页面里跑的一段：把「内存压力」拆成可判读的几栏。
# 注意 performance.memory 只在 Chromium 系有 —— 拿不到就报 null，不编数。
PAGE_JS = r"""
() => {
  const u = window.__universe;
  if (!u || !u.engine) return { ok: false, why: '拿不到 window.__universe.engine' };
  const r = u.engine.renderer;
  const gl = r.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const unmasked = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  const vendor   = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : null;
  const pm = performance.memory || null;
  const info = r.info || {};

  // 遍历当前场景，按对象类型数一数 —— 这是「场景里有几个东西」的真凭据。
  const byType = {};
  let meshes = 0, points = 0, lines = 0, sprites = 0, total = 0;
  const root = u.engine.current?.scene || r.__scene || null;
  const walk = (o) => {
    if (!o) return;
    total++;
    if (o.isMesh) meshes++;
    else if (o.isPoints) points++;
    else if (o.isLine || o.isLineSegments) lines++;
    else if (o.isSprite) sprites++;
    const k = o.type || '?';
    byType[k] = (byType[k] || 0) + 1;
    for (const c of (o.children || [])) walk(c);
  };
  if (root) walk(root);

  // 各尺度「建好了没 / 挂了几个对象」—— 显存回收是否生效看这个。
  const levels = {};
  if (u.engine.levels) {
    for (const [k, v] of u.engine.levels) {
      levels[k] = { built: !!v.built, children: v.scene ? v.scene.children.length : null };
    }
  }

  return {
    ok: true,
    renderer: unmasked || '(扩展不可用)',
    vendor,
    software: /swiftshader|llvmpipe|software|basic render/i.test(unmasked || ''),
    gpuTier: u.engine.tier?.id,
    gpuPref: u.engine.gpu?.powerPreference,
    current: u.engine.current?.id,
    heap: pm ? {
      used: pm.usedJSHeapSize, total: pm.totalJSHeapSize, limit: pm.jsHeapSizeLimit,
    } : null,
    mem: {
      geometries: info.memory?.geometries ?? null,
      textures:   info.memory?.textures   ?? null,
    },
    draw: {
      calls:      info.render?.calls      ?? null,
      triangles:  info.render?.triangles  ?? null,
      points:     info.render?.points     ?? null,
      lines:      info.render?.lines      ?? null,
    },
    programs: info.programs ? info.programs.length : null,
    scene: { total, meshes, points, lines, sprites, top: Object.entries(byType)
      .sort((a, b) => b[1] - a[1]).slice(0, 8) },
    levels,
  };
}
"""


def mb(n):
    return '—' if n is None else f'{n / 1048576:.1f} MB'


# 隔离计时标签层：只跑 labels.update()，不掺渲染。
# 为什么单独测它 —— 在一帧里，几何体的变换**已经**在顶点着色器上做了（GPU），
# 唯一还在 CPU 上按标签个数做矩阵乘法、并且按个数写 DOM 样式的地方，就是这里。
LABEL_JS = r"""
(level) => {
  const u = window.__universe;
  const lv = u.engine.levels.get(level);
  if (!lv || !lv.labels || !lv.camera) return { ok: false, why: '这一层没有标签层/相机' };
  const cam = lv.camera, labels = lv.labels;
  const w = window.innerWidth, h = window.innerHeight;
  const opts = { ...(lv.labelOptions || {}) };
  const ctrl = lv.controls && lv.controls.target;
  if (ctrl) {
    const focus = cam.position.distanceTo(ctrl);
    if (focus > 0) opts.maxDistance = Math.min(opts.maxDistance ?? Infinity, Math.max(0.02, focus * 26));
  }
  const N = 40;
  for (let i = 0; i < 5; i++) labels.update(cam, w, h, opts);   // 预热
  const t0 = performance.now();
  for (let i = 0; i < N; i++) labels.update(cam, w, h, opts);
  const t1 = performance.now();

  // 顺带数一下「这一帧真正显示出来」的有几个 —— 它决定 O(n²) 防重叠的真实规模
  let shown = 0;
  for (const el of labels.items.values()) if (el.style.display !== 'none') shown++;
  return { ok: true, total: labels.items.size, shown, msPerFrame: (t1 - t0) / N };
}
"""


async def main():
    # ServedCheck 是**同步**上下文管理器（start() 用 subprocess.Popen）——
    # 不能用 async with，那会 TypeError。在进 asyncio 的 playwright 之前就把它起好。
    srv = ServedCheck()
    base = srv.start()
    try:
        return await probe(base)
    finally:
        srv.stop()


async def probe(base):
    async with async_playwright() as pw:
        launch = {}
        if BROWSER == 'edge':
            launch['channel'] = 'msedge'
        elif BROWSER == 'chrome':
            launch['channel'] = 'chrome'
        try:
            browser = await pw.chromium.launch(headless=not HEADED, args=GPU_ARGS, **launch)
        except Exception as e:
            emit(f'  ✗ 起浏览器失败（{BROWSER}）：{e}')
            emit('    退到 Playwright 自带浏览器再试一次…')
            browser = await pw.chromium.launch(headless=not HEADED, args=GPU_ARGS)

        page = await browser.new_page()
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! {m.text[:160]}'))

        emit(f'\n打开 {base}/ …（浏览器={BROWSER} 有头={HEADED} GPU偏好={GPU}）')
        await page.goto(base + '/', wait_until='load')
        try:
            await page.wait_for_function(
                'window.__universe && window.__universe.engine && '
                'window.__universe.dataset', timeout=45000)
        except Exception:
            emit('  ✗ 45 秒内没等到 window.__universe.dataset —— 页面没起来')
            await browser.close()
            return 1
        # 让首帧和显存分配落定
        await page.wait_for_timeout(2500)

        if ALL_LEVELS:
            emit('  先把六个尺度都逛一遍（看最坏情况占用）…')
            for lv in LEVELS:
                await page.evaluate(f"window.__universe.gotoScale('{lv}')")
                try:
                    await page.wait_for_function(
                        f"window.__universe.engine.current?.id === '{lv}'", timeout=40000)
                except Exception:
                    emit(f'    {lv} 切换超时')
                await page.wait_for_timeout(500)
            # 回到最内层，让「当前层 ±1」的保留策略生效
            await page.evaluate("window.__universe.gotoScale('solar')")
            await page.wait_for_function(
                "window.__universe.engine.current?.id === 'solar'", timeout=40000)
            await page.wait_for_timeout(1500)

        r = await page.evaluate(PAGE_JS)
        if not r.get('ok'):
            emit(f"  ✗ {r.get('why')}")
            await browser.close()
            return 1

        print('\n' + '=' * 62)
        print(f'  WebGL 后端   {r["renderer"]}')
        print(f'  厂商         {r["vendor"]}')
        if r['software']:
            print('  ⚠ 这是**软件渲染** —— 「搬到显存」在当前环境下不成立：')
            print('     GPU 计算会由 CPU 模拟，反而多一份 CPU 侧缓冲。')
        else:
            print('  ✓ 硬件渲染 —— 显存侧的负载是真的落在显卡上。')
        print(f'  画质档位     {r["gpuTier"]} · powerPreference={r["gpuPref"]}'
              f' · 当前层 {r["current"]}')
        print('-' * 62)
        print('  JS 堆（页面侧，这才是「内存压力」里本程序该负责的那部分）')
        h = r['heap']
        if h:
            print(f'    已用 {mb(h["used"])} · 已分配 {mb(h["total"])} · 上限 {mb(h["limit"])}')
            print(f'    占上限 {h["used"] / h["limit"] * 100:.1f}%')
        else:
            print('    拿不到 performance.memory（非 Chromium 系）—— 不编数')
        print('-' * 62)
        print('  显存侧（GPU 对象，单位：个）')
        print(f'    几何体 {r["mem"]["geometries"]} · 贴图 {r["mem"]["textures"]}'
              f' · 着色器程序 {r["programs"]}')
        print(f'    一次绘制：{r["draw"]["calls"]} 次调用 · '
              f'三角形 {r["draw"]["triangles"]} · 点 {r["draw"]["points"]} · 线 {r["draw"]["lines"]}')
        print('-' * 62)
        print(f'  当前场景对象  共 {r["scene"]["total"]} 个'
              f'（Mesh {r["scene"]["meshes"]} / Points {r["scene"]["points"]}'
              f' / Line {r["scene"]["lines"]} / Sprite {r["scene"]["sprites"]}）')
        for t, n in r['scene']['top']:
            print(f'    {t:<22} {n}')
        print('-' * 62)
        print('  六个尺度的场景状态（built=False 说明已被显存回收 / 还没建）')
        for k in LEVELS:
            v = r['levels'].get(k)
            if v is None:
                print(f'    {k:<14} （引擎里没有这一层）')
            else:
                print(f'    {k:<14} built={str(v["built"]):<5} 直接子节点 {v["children"]}')
        print('=' * 62)

        if LABEL_COST:
            emit('\n  隔离计时：标签层（每帧唯一的大批量 CPU 矩阵运算）')
            for lv in LEVELS:
                await page.evaluate(f"window.__universe.gotoScale('{lv}')")
                try:
                    await page.wait_for_function(
                        f"window.__universe.engine.current?.id === '{lv}'", timeout=40000)
                except Exception:
                    emit(f'    {lv} 切换超时，跳过')
                    continue
                await page.wait_for_timeout(400)
                d = await page.evaluate(LABEL_JS, lv)
                if not d.get('ok'):
                    emit(f'    {lv:<14} 跳过（{d.get("why")}）')
                    continue
                # 16.7ms 是一帧的预算。占比过 30% 就该动它了。
                share = d['msPerFrame'] / 16.7 * 100
                flag = '← 值得优化' if share > 30 else ''
                print(f'    {lv:<14} 标签 {d["total"]:>5} 个 · 这一帧显示 {d["shown"]:>4} 个'
                      f' · {d["msPerFrame"]:>6.2f} ms/帧（占 16.7ms 的 {share:>5.1f}%） {flag}')
            print('=' * 62)

        await browser.close()
        return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))

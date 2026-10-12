#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""渲染管线探针：后期链到底有没有在干活 / 色调映射是不是装饰品

为什么有这个东西
----------------
银河系那团过曝的白核心有个绕不过去的疑点：`core/engine.js` 里明明写着

    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

而画面里**完全看不到高光滚降** —— 该是 255 的地方就是一片 255。
如果色调映射真的生效了，几千个 additive 片元叠起来也应该是「亮而不白」，
而不是一团硬边的白斑。

嫌疑在 three 的管线规则上：**材质着色器里的色调映射，只在渲染到默认帧缓冲
（`renderTarget === null`）时才注入**。本项目走的是 EffectComposer：

    RenderPass → UnrealBloomPass → CopyShader 直通 → 屏幕

`RenderPass` 渲染到一个 render target 里 ⇒ 材质那一步**不注入色调映射**；
而最后的 `CopyShader` 是自带片元的自定义 shader，里面没有
`#include <tonemapping_fragment>` ⇒ 也不会补上。
**两头都不做 ⇒ 这条 ACES 从头到尾没跑过一次。**

⚠️ 这是**假设，不是结论**。本脚本用「哨兵值」验证它（这是本项目的老规矩：
「先验一次这个手段看得见我的改动吗」）：

    toneMappingExposure 从 1.05 拉到 6.0

曝光**只**影响色调映射。如果画面一个像素都不变 ⇒ 色调映射确实不在渲染路径上。
如果画面整体亮了 ⇒ 它在跑，我就得换个方向找原因。

判据
----
    Δ(平均亮度) < 0.5 且 Δ(最大亮度) == 0   ⇒ NoToneMapping 级别的证据：**没跑**
    Δ(平均亮度) > 5                        ⇒ 跑了
    中间地带                               ⇒ 说话要留余地，别急着下结论

同时输出管线快照（pass 链 / render target 的 colorSpace 与 type / 泛光参数），
因为「加法混合累积在 sRGB 编码空间里」这件事本身就是过曝的放大器：
两个 sRGB 0.5 相加 = 1.0（编码值），对应的线性光其实只有 0.21+0.21=0.42。

用法
----
    py -3.13 -X utf8 tools/probe-render-pipeline.py
    py -3.13 -X utf8 tools/probe-render-pipeline.py --headed=false
    py -3.13 -X utf8 tools/probe-render-pipeline.py --scale=galaxy|neighborhood|solar

产出
----
    shots/pipeline-base.png / pipeline-exposure6.png / _pipeline-hud-off.png
退出码：0 = 测到了；1 = 页面没起来。
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright
from browser_args import OCCLUSION_ARGS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')

HEADED = True
SCALE = 'galaxy'
TIER = None          # 空 = 保持当前档位（但要钉住，防自动降档把分支换掉）
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--scale='):
        SCALE = a.split('=', 1)[1]
    elif a.startswith('--tier='):
        TIER = a.split('=', 1)[1]

# ---------------------------------------------------------------------------
# 页面内：管线快照
# ---------------------------------------------------------------------------
PIPE_JS = r"""
() => {
  const e = window.__universe.engine;
  const r = e.renderer;
  const c = e.composer;
  const NAMES = {
    0: 'NoToneMapping', 1: 'LinearToneMapping', 2: 'ReinhardToneMapping',
    3: 'CineonToneMapping', 4: 'ACESFilmicToneMapping', 5: 'CustomToneMapping',
    6: 'AgXToneMapping', 7: 'NeutralToneMapping',
  };
  const TYPES = { 1009: 'UnsignedByteType', 1015: 'HalfFloatType', 1016: 'FloatType' };
  const rt = c && c.renderTarget1;
  return {
    toneMapping: NAMES[r.toneMapping] || String(r.toneMapping),
    exposure: r.toneMappingExposure,
    outputColorSpace: r.outputColorSpace,
    renderTargetDuringRender: String(r.getRenderTarget()),
    pixelRatio: r.getPixelRatio(),
    drawingBuffer: [r.domElement.width, r.domElement.height],
    passes: c ? c.passes.map((p) => p.constructor.name + (p.enabled === false ? '(off)' : '')) : null,
    rt1: rt ? [rt.texture.colorSpace, TYPES[rt.texture.type] || String(rt.texture.type)] : null,
    rtSamples: rt ? rt.samples : null,
    bloom: e.bloomPass ? {
      strength: e.bloomPass.strength,
      radius: e.bloomPass.radius,
      threshold: e.bloomPass.threshold,
      res: [e.bloomPass.resolution.x, e.bloomPass.resolution.y],
    } : null,
    level: e.current && e.current.id,
    tier: e.tierId || (e.tier && e.tier.id),
    pinned: !!(e.gpu && e.gpu.tierPinned),
    branch: (e.options && e.options.bloom !== false) ? 'composer' : 'direct',
    // 有多少材质的 toneMapped 还是 true —— 若色调映射真的没跑，这个标志位就是摆设
    toneMappedMaterials: (() => {
      let yes = 0, no = 0;
      e.current && e.current.scene && e.current.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mm of (Array.isArray(m) ? m : [m])) {
          if (mm.toneMapped === false) no++; else yes++;
        }
      });
      return { toneMappedTrue: yes, toneMappedFalse: no };
    })(),
  };
}
"""

# ---------------------------------------------------------------------------
# 页面内：把曝光拧到 6.0（哨兵）
# ---------------------------------------------------------------------------
EXPOSURE_JS = r"""
(v) => {
  const r = window.__universe.engine.renderer;
  r.toneMappingExposure = v;
  return r.toneMappingExposure;
}
"""

TONEMAP_JS = r"""
(v) => {
  const r = window.__universe.engine.renderer;
  r.toneMapping = v;
  return r.toneMapping;
}
"""

# ---------------------------------------------------------------------------
# ⚠️ 第三个坑，仍然是仪器自己的：上面两个开关打出来的信号**自相矛盾** ——
#    曝光 ×6 几乎没反应（核区 Δ +0.00，和噪声地板一样），
#    可「关掉色调映射」却把核区从 244.95 压到 183.73。
#    同一个代码路径上这两件事不可能同时成立。
#
#    漏掉的变量是「**到底走了哪条渲染分支**」：
#      engine.js 里是 if (options.bloom !== false) → composer.render()
#                        else                    → renderer.render(..., null)
#    而 three 只在**渲染到默认帧缓冲**时注入色调映射。
#    ⇒ 走 composer：色调映射不跑（ACES 是装饰品）；
#      走直出：色调映射跑，**而且是在每个片元上逐点施加、累积之前**。
#    这个开关由**画质档**决定（saver 档 bloom:false），而画质档又会被
#    自动降档逻辑在低帧率下**当场改掉** —— 探针跑在无头软件渲染里，
#    帧率必然低 ⇒ 档位可能在两次截图之间就漂了。
#
#    所以必须：① **钉住档位**再测；② 每次截图前把 branch 记下来。
# ---------------------------------------------------------------------------
STATE_JS = r"""
() => {
  const e = window.__universe.engine;
  return {
    tier: e.tierId || (e.tier && e.tier.id),
    pinned: !!(e.gpu && e.gpu.tierPinned),
    bloom: e.options && e.options.bloom,
    forceRT: !!e.forceRT,
    pr: e.renderer.getPixelRatio(),
    tm: e.renderer.toneMapping,
    branch: (e.options && e.options.bloom !== false) ? 'composer' : 'direct',
  };
}
"""

PIN_JS = r"""
(tier) => {
  const e = window.__universe.engine;
  if (e.gpu) e.gpu.tierPinned = true;
  if (tier && e.applyTier) e.applyTier(tier);
  return { tier: e.tierId, bloom: e.options.bloom, pinned: !!e.gpu.tierPinned };
}
"""


def fmt_state(s):
    return (f'档位={s["tier"]}{"(钉住)" if s["pinned"] else ""} · 分支={s["branch"]}'
            f' · bloom={s["bloom"]} · 像素比={s["pr"]:.2f}')

# ---------------------------------------------------------------------------
# ⚠️ 这条探针踩过自己的坑：第一版拿「变化像素占比」当判据 —— 结果是 15.6%，
#    看着像「色调映射在跑」。**其实那是场景自己在动**（盘面自转、核球呼吸、
#    太阳标记），跟曝光一点关系没有。
#    ⇒ 两个补救，都必须有：
#      ① **噪声地板**：什么都不改连拍两张，先量出「动画造成的变化」有多大；
#      ② **抗动画的统计量**：用**径向/核区的平均亮度**，而不是逐像素差分 ——
#         盘面转一点，径向剖面几乎不动；曝光变了，径向剖面整体移动。
#    这正是本项目的老规矩：**先验一次这个手段看得见我的改动吗**。
# ---------------------------------------------------------------------------
def radial_metrics(arr, np):
    """圆心=最亮像素，回报核区(0–2%)与中盘(6–20%)的平均亮度。抗自转。"""
    lum = arr[..., :3].astype('float32') @ np.array([0.2126, 0.7152, 0.0722], 'float32')
    cy, cx = np.unravel_index(int(np.argmax(lum)), lum.shape)
    h, w = lum.shape
    rmax = float(np.sqrt(max(cy, h - 1 - cy) ** 2 + max(cx, w - 1 - cx) ** 2)) or 1.0
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) / rmax
    core = lum[r <= 0.02]
    mid = lum[(r >= 0.06) & (r <= 0.20)]
    return {
        'core': float(core.mean()) if core.size else 0.0,
        'mid': float(mid.mean()) if mid.size else 0.0,
        'max': float(lum.max()),
        'lit': float((lum > 6).mean()) * 100.0,
    }

HIDE_HUD_JS = r"""
() => {
  const sel = ['#topbar', '#hud', '#crumb', '#palette', '#toast', '#boot', '#catalog-pane', '#panel'];
  for (const s of sel) for (const el of document.querySelectorAll(s)) {
    el.dataset.__oldVis = el.style.visibility || '';
    el.style.visibility = 'hidden';
  }
  return sel.length;
}
"""

SHOW_HUD_JS = r"""
() => {
  const sel = ['#topbar', '#hud', '#crumb', '#palette', '#toast', '#boot', '#catalog-pane', '#panel'];
  for (const s of sel) for (const el of document.querySelectorAll(s)) {
    el.style.visibility = el.dataset.__oldVis || '';
    delete el.dataset.__oldVis;
  }
}
"""


async def shoot(page, path):
    await page.screenshot(path=path, animations='disabled')
    return path


async def main():
    srv = ServedCheck(tag='渲染管线探针')
    base = srv.start()
    try:
        return await run(base)
    finally:
        srv.stop()


async def run(base):
    try:
        import numpy as np
        from PIL import Image
    except Exception as exc:                       # pragma: no cover
        emit(f'  ! 缺 numpy/Pillow：{exc}')
        return 1

    os.makedirs(SHOTS, exist_ok=True)

    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=OCCLUSION_ARGS)
        except Exception:
            browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! {m.text[:160]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=45000)
        await page.wait_for_timeout(2500)
        await page.evaluate(f"window.__universe.gotoScale('{SCALE}')")
        await page.wait_for_function(
            f"window.__universe.engine.current?.id === '{SCALE}'", timeout=40000)
        await page.wait_for_timeout(2000)

        pipe = await page.evaluate(PIPE_JS)
        print('=' * 78)
        print('  管线快照')
        print('-' * 78)
        print(f'  renderer.toneMapping      = {pipe["toneMapping"]}')
        print(f'  renderer.toneMappingExposure = {pipe["exposure"]}')
        print(f'  renderer.outputColorSpace = {pipe["outputColorSpace"]}')
        print(f'  renderer.getRenderTarget() 在渲染时 = {pipe["renderTargetDuringRender"]}')
        print(f'  像素比 {pipe["pixelRatio"]} · 绘制缓冲 {pipe["drawingBuffer"][0]}×{pipe["drawingBuffer"][1]}')
        print(f'  后期链：{" → ".join(pipe["passes"] or []) or "(没有 composer)"}')
        print(f'  composer.renderTarget1 = colorSpace {pipe["rt1"][0]} / {pipe["rt1"][1]}'
              f' · MSAA samples={pipe["rtSamples"]}')
        if pipe['bloom']:
            b = pipe['bloom']
            print(f'  泛光：强度 {b["strength"]} · 半径 {b["radius"]} · 阈值 {b["threshold"]}'
                  f' · 分辨率 {b["res"][0]}×{b["res"][1]}')
        tm = pipe['toneMappedMaterials']
        print(f'  本层材质 toneMapped：true {tm["toneMappedTrue"]} 个 / false {tm["toneMappedFalse"]} 个')
        print(f'  当前层级 = {pipe["level"]} · 画质档 = {pipe["tier"]}'
              f' · 渲染分支 = {pipe["branch"]} · 钉住 = {pipe["pinned"]}')
        print('  ⚠ three 的注入规则（本仓库 vendor/three/three.module.js:6942）：')
        print('      有色调映射 **仅当** currentRenderTarget === null')
        print('    ⇒ 走 composer 的帧（renderTarget 非空）**不注入**色调映射；')
        print('      只有 direct 分支（渲染到默认帧缓冲）才注入 —— 而且是**逐片元**的。')

        # ---- 哨兵：先钉住档位，连拍两张量噪声地板，再改色调映射/曝光各一张 ----
        #   ⚠️ 不钉住档位的话，低帧率自动降档会在两次截图之间把渲染分支换掉，
        #      量到的是「档位漂移」而不是「色调映射」。
        pinned = await page.evaluate(PIN_JS, TIER)
        emit(f'  已钉住档位：{pinned}')

        await page.evaluate(HIDE_HUD_JS)
        await page.wait_for_timeout(400)
        shots, states = {}, {}
        for key, act in (('base1', None), ('base2', None),
                         ('exp6', ('exp', 6.0)),
                         ('notm', ('tm', 0))):
            if act:
                await page.evaluate(EXPOSURE_JS if act[0] == 'exp' else TONEMAP_JS, act[1])
                await page.wait_for_timeout(600)
            states[key] = await page.evaluate(STATE_JS)
            p = os.path.join(SHOTS, f'pipeline-{key}.png')
            shots[key] = await shoot(page, p)
            await page.wait_for_timeout(500)
        await page.evaluate(EXPOSURE_JS, 1.05)
        await page.evaluate(TONEMAP_JS, 4)
        await page.evaluate(SHOW_HUD_JS)

        M = {k: radial_metrics(np.asarray(Image.open(p).convert('RGB')), np)
             for k, p in shots.items()}

        print('=' * 78)
        print('  哨兵：曝光/色调映射动一下，画面动多少？（判据用径向统计，抗自转）')
        print('-' * 78)
        print('  条件                        核区亮度      中盘亮度    最亮    亮像素%   实际分支')
        for k in ('base1', 'base2', 'exp6', 'notm'):
            lbl = {'base1': '基线①（什么都不改）', 'base2': '基线②（什么都不改）',
                   'exp6': '曝光 1.05 → 6.0', 'notm': 'toneMapping=NoToneMapping'}[k]
            m = M[k]
            print(f'  {lbl:<26} {m["core"]:>9.2f} {m["mid"]:>11.3f} {m["max"]:>7.0f}'
                  f' {m["lit"]:>8.2f}   {states[k]["branch"]}')

        noise_core = abs(M['base2']['core'] - M['base1']['core'])
        noise_mid = abs(M['base2']['mid'] - M['base1']['mid'])
        d_exp_core = M['exp6']['core'] - M['base1']['core']
        d_exp_mid = M['exp6']['mid'] - M['base1']['mid']
        d_tm_core = M['notm']['core'] - M['base1']['core']
        d_tm_mid = M['notm']['mid'] - M['base1']['mid']

        print('-' * 78)
        print(f'  噪声地板（基线①②之间的差）      核区 {noise_core:.2f}   中盘 {noise_mid:.3f}')
        print(f'  曝光 ×6 带来的差                 核区 {d_exp_core:+.2f}   中盘 {d_exp_mid:+.3f}')
        print(f'  关掉色调映射带来的差             核区 {d_tm_core:+.2f}   中盘 {d_tm_mid:+.3f}')
        print('-' * 78)
        # 判据：变化必须明显大于噪声地板，才算「这个手段看得见」
        vis_exp = abs(d_exp_core) > max(3 * noise_core, 1.0) or abs(d_exp_mid) > max(3 * noise_mid, 0.05)
        vis_tm = abs(d_tm_core) > max(3 * noise_core, 1.0) or abs(d_tm_mid) > max(3 * noise_mid, 0.05)
        br = states['base1']['branch']
        print(f'  本次测量走的是 **{br}** 分支'
              + ('（options.bloom === false ⇒ renderer.render 直出）' if br == 'direct'
                 else '（options.bloom !== false ⇒ composer 链）'))
        if br == 'direct':
            print('  ⚠ 直出分支下 three 会**逐片元**注入色调映射 —— 它在「累积之前」，')
            print('    压不住加法叠加造成的冲顶。而且这一支**没有泛光**。')
            print('    ⇒ 这一屏并不是普通用户（均衡/高性能档）看到的那一屏。')
        if vis_exp or vis_tm:
            print('  → 结论：色调映射在**当前分支**上确实生效（开关能显著改画面）。')
        else:
            print('  → 结论：色调映射在**当前分支**上不生效（改了看不出差别）。')
        print(f'  图：{os.path.relpath(shots["base1"], ROOT)} · {os.path.relpath(shots["exp6"], ROOT)}'
              f' · {os.path.relpath(shots["notm"], ROOT)}')
        sys.stdout.flush()
        try:
            await asyncio.wait_for(browser.close(), timeout=10)
        except Exception as exc:
            print(f'  ⚠ 关浏览器超时（结论已经写出来了，不影响）：{type(exc).__name__}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""银河系**外观**探针：把「难看」变成可以指着看的东西。

## 为什么有这个东西

用户原话：**「你这个银河系的样子实在难看，参照真实样子做，银河系尺度下的和
星系群视角下的都要改」**。

「难看」是主观词，不能当判据 —— 但这一轮它**先要一次目检**，因为「像不像一个
真实的棒旋星系」是**形状**问题，而形状问题光看数字会看漏。所以本脚本做两件事：

  ① **把两个视角各拍下来**（银河系层的俯视全景 / 本星系群视角里的银河系），
     外加**标签关掉**的那一份 —— 标签是 DOM，会盖在盘面上干扰判断。
  ② 报出**每次测量都必需的伴随状态**：渲染后端 / 画质档 / pointBudget。
     ⚠️ 这三样不记下来，两张图之间的差别就分不清是「改了代码」还是「换了后端」。

## 为什么必须钉住画质档

`probe-galaxy-visual.py` 的注释里写着实测：同一份画面、同一个 `--headed=false`，
两次运行量到的帧时间中位数是 198.3 ms 与 7.9 ms（**差 25 倍**）——
差别在后端（`channel='msedge'` 拿真 GPU，回退到自带 chromium 就是 SwiftShader）。
**画质档与后端跟「哪个视角」同级，不记下来这次测量不算数。**

## 用法

    py -3.13 -X utf8 tools/probe-mw-look.py                  # 两个视角 + 局部特写
    py -3.13 -X utf8 tools/probe-mw-look.py --headed=false    # 无头（会退化成软件渲染）
    py -3.13 -X utf8 tools/probe-mw-look.py --tag=before      # 输出文件名加前缀

产出：`shots/mwlook-<tag>-*.png`。退出码 0 = 拍到了；1 = 页面没起来。

⚠️ **必须后台跑**（本机收割器会把前台进程树 SIGTERM 掉，日志停在半路）。
"""
import asyncio
import os
import sys
import threading

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402
from browser_args import OCCLUSION_ARGS         # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(line_buffering=True)
    except Exception:                                     # pragma: no cover
        pass

HEADED = True
TAG = 'a'
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--tag='):
        TAG = a.split('=', 1)[1]


def arm_hard_exit(seconds, code=0):
    """收尾硬上限：`seconds` 秒后无条件 `os._exit`（理由见 probe-galaxy-visual.py）。"""
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t


# 钉画质档 + 读状态。**必须在 gotoScale 之前做**：点数是在 build() 时按
# `engine.tier.pointBudget` 定死的，进层之后再钉只改了渲染设置、改不动几何。
PIN_JS = r"""
(tier) => {
  const e = window.__universe.engine;
  if (e.gpu) e.gpu.tierPinned = true;
  if (tier && e.applyTier) e.applyTier(tier);
  return { tier: e.tierId, pointBudget: e.tier ? e.tier.pointBudget : null };
}
"""

BACKEND_JS = r"""
() => {
  const r = window.__universe && window.__universe.engine && window.__universe.engine.renderer;
  if (!r) return { renderer: '(拿不到 renderer)', software: null };
  const gl = r.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const unmasked = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  return { renderer: unmasked || '(扩展不可用)', software: /swiftshader|llvmpipe|software/i.test(unmasked || '') };
}
"""

# 切到某一层并等它建完（过渡结束）。
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

# 摆一个明确视角 + 可选地关标签，然后报出当前相机。
VIEW_JS = r"""
(o) => {
  const e = window.__universe.engine;
  const lv = e.current;
  if (o.hideLabels && lv.labels && lv.labels.setVisible) lv.labels.setVisible(false);
  if (o.showLabels && lv.labels && lv.labels.setVisible) lv.labels.setVisible(true);
  if (o.position) lv.applyView({ position: o.position, target: o.target || [0, 0, 0] });
  if (e.controls) { e.controls.autoRotate = false; if (e.controls.update) e.controls.update(); }
  const p = lv.camera.position, t = lv.controls ? lv.controls.target : null;
  return {
    level: lv.id,
    camDist: +p.distanceTo(t || { x: 0, y: 0, z: 0, distanceTo: () => 0 }).toFixed(2),
    labelsVisible: lv.labels && lv.labels.items
      ? [...lv.labels.items.values()].filter((el) => getComputedStyle(el).display !== 'none').length
      : null,
  };
}
"""

# 场景清单：谁在画、用什么混合、多少个点。判「这东西是谁画的」不能靠读代码。
INVENTORY_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  return (lv.scene.children || []).map((o) => {
    const m = o.material ? (Array.isArray(o.material) ? o.material[0] : o.material) : null;
    return {
      name: o.name || '(无名)', type: o.type, visible: o.visible,
      blend: m ? m.blending : null, opacity: m ? m.opacity : null,
      count: o.geometry && o.geometry.attributes && o.geometry.attributes.position
        ? o.geometry.attributes.position.count : null,
    };
  });
}
"""


# 把**程序化贴图本身**倒出来看。
#
# 为什么必须单独看它：盘面是「贴图 + 点云」两层叠出来的，两者都画旋臂。
# 若不把贴图单独导出来，「旋臂看不见」就分不清是**贴图没画对**还是**点云把它糊了**
# —— 这两件事的处方完全相反（改画法 vs 改配比）。
# 口径：`import()` 的是**页面正在跑的那一份模块**，不是另抄一套。
DUMP_TEXTURE_JS = r"""
async () => {
  const m = await import('/js/proc/textures.js');
  const out = {};
  const grab = (tex) => {
    const c = tex.image;
    return c.toDataURL('image/png');
  };
  out.mw = grab(m.makeMilkyWayDiskTexture({ size: 1024 }));
  out.spiral = grab(m.makeGalaxyTexture({ type: 'spiral', size: 512 }));
  out.dwarf = grab(m.makeGalaxyTexture({ type: 'dwarf', size: 512 }));
  return out;
}
"""


def save_dataurl(data_url, path):
    import base64
    head, _, body = data_url.partition(',')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(body))
    return path


def stats(path):
    """整幅像素统计（PIL）。**只作旁证**：形状要靠眼睛，数字只用来抓「整片灰掉」这类硬伤。"""
    try:
        from PIL import Image
    except Exception:
        return None
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    n = 0
    sr = sg = sb = 0
    lit = 0
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            r, g, b = px[x, y]
            sr += r; sg += g; sb += b; n += 1
            if r + g + b > 150:
                lit += 1
    return {
        'size': f'{w}x{h}', 'meanRGB': (round(sr / n, 2), round(sg / n, 2), round(sb / n, 2)),
        'litPct': round(100.0 * lit / n, 2),
        'R/B': round((sr / n) / max(1e-6, sb / n), 3),
    }


async def run(base, srv):
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as pw:
        # 这三个开关是**必须的**，不是保险（2026-09-12 实测踩到）：
        #   有头跑的时候，Chromium 若判定自己的窗口「被遮挡」，Windows 的
        #   `CalculateNativeWinOcclusion` 会把渲染进程降级 —— rAF 被节流、合成器
        #   干脆不再出新帧。症状是 `page.screenshot()` **卡在**
        #   `waiting for fonts to load... fonts loaded` 之后**一直不返回**（30 秒超时），
        #   而 `page.evaluate()` 一切正常 —— 于是很容易误判成「渲染挂了」，跑去查 WebGL。
        #   真正的病灶在窗口遮挡判定上。
        #   同族教训：**「工具超时」和「被测量的东西坏了」不能用同一个症状去解释。**
        #   ⚠️ 开关的唯一来源是 `tools/browser_args.py`（坑 149：以前散在各处写死、
        #   文档里还维护一份手写名单，结果 20 个有头探针只有 3 个真带了）。
        args = list(OCCLUSION_ARGS)
        backend = 'msedge'
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=args)
        except Exception as e:
            backend = f'bundled-chromium（msedge 起不来：{type(e).__name__}）'
            browser = await pw.chromium.launch(headless=not HEADED, args=args)
        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! {m.text[:160]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=45000)
        await page.wait_for_timeout(2500)

        pin = await page.evaluate(PIN_JS, 'high')
        bk = await page.evaluate(BACKEND_JS)
        emit(f'\n后端 {backend} → {bk["renderer"]}'
             + ('  ⚠️ 软件渲染，像素与帧时间都不可比' if bk['software'] else ''))
        emit(f'画质档 {pin["tier"]} · pointBudget {pin["pointBudget"]}')

        out = []

        # ---------- ⓿ 贴图本身 ----------
        emit('\n⓿ 程序化贴图（盘面结构的第一来源）')
        try:
            texs = await page.evaluate(DUMP_TEXTURE_JS)
            for k, v in texs.items():
                p = save_dataurl(v, os.path.join(SHOTS, f'mwlook-{TAG}-tex-{k}.png'))
                emit(f'  ✓ {os.path.basename(p)}  {stats(p)["meanRGB"] if stats(p) else ""}')
        except Exception as e:
            emit(f'  ! 贴图导出失败（不影响其它测量）：{type(e).__name__}: {e}')

        async def shoot(name, view, wait=1.2):
            v = await page.evaluate(VIEW_JS, view)
            await page.wait_for_timeout(int(wait * 1000))
            path = os.path.join(SHOTS, f'mwlook-{TAG}-{name}.png')
            last = None
            for attempt in (1, 2):                      # 截图偶发卡住时重试一次（见上面 args 的注释）
                try:
                    await page.screenshot(path=path, timeout=15000)
                    last = None
                    break
                except Exception as e:
                    last = e
                    emit(f'  ! 第 {attempt} 次截图失败：{type(e).__name__}，重试')
                    await page.wait_for_timeout(1200)
            if last is not None:
                emit(f'  ✗ {name} 截图始终失败：{last}')
                return None
            st = stats(path)
            out.append((name, v, st))
            emit(f'  ✓ {os.path.basename(path)}  相机距靶 {v["camDist"]}'
                 + (f' · 均值 {st["meanRGB"]} · R/B {st["R/B"]} · 亮像素 {st["litPct"]}%' if st else ''))
            return path

        # ---------- ① 银河系层 ----------
        ok = await page.evaluate(SETTLE_JS, 'galaxy')
        emit(f'\n① 银河系层（进入 {"成功" if ok else "超时"}）')
        await page.wait_for_timeout(1500)
        inv = await page.evaluate(INVENTORY_JS)
        emit(f'  场景顶层对象 {len(inv)} 个：'
             + ' · '.join(f'{i["name"]}[{i["type"]}]' for i in inv[:14])
             + (' …' if len(inv) > 14 else ''))
        await shoot('1-galaxy-default', {'showLabels': True})
        await shoot('1-galaxy-default-nolabel', {'hideLabels': True})
        # 正俯视：视线沿银道面法线。⚠️ 完全垂直会与 camera.up 退化（万向锁），
        # 所以偏 8°（[0,148,20]）—— 这一点偏移对「看盘面结构」没有影响。
        await shoot('1-galaxy-faceon', {'hideLabels': True, 'position': [0, 148, 20]})
        # 近侧视：看盘是不是有厚度、边缘有没有渐隐
        await shoot('1-galaxy-edgeon', {'hideLabels': True, 'position': [0, 16, 130]})

        # ---------- ② 本星系群层 ----------
        ok = await page.evaluate(SETTLE_JS, 'localgroup')
        emit(f'\n② 本星系群层（进入 {"成功" if ok else "超时"}）')
        await page.wait_for_timeout(1500)
        inv = await page.evaluate(INVENTORY_JS)
        emit(f'  场景顶层对象 {len(inv)} 个')
        await shoot('2-localgroup-default', {'showLabels': True})
        await shoot('2-localgroup-default-nolabel', {'hideLabels': True})
        # 站到银河系正上方 0.6 百万光年处 —— 看它在**群视角下**长什么样
        await shoot('2-localgroup-mw-closeup', {'hideLabels': True, 'position': [0.35, 0.55, 1.05], 'target': [0, 0, 0]})
        # 与 M31 同框（真实本星系群的样子：两个大螺旋 + 一群矮星系）
        m31 = await page.evaluate(
            "() => { const b = window.__universe.dataset.get('m31'); return [b.x, b.y, b.z]; }")
        emit(f'  M31 位置 {m31}')
        await shoot('2-localgroup-pair', {'hideLabels': True,
                                         'position': [m31[0] * 0.55, m31[1] * 0.55 + 1.1, m31[2] * 0.55],
                                         'target': [m31[0] * 0.4, m31[1] * 0.4, m31[2] * 0.4]})

        emit('\n=== 汇总 ===')
        for name, v, st in out:
            emit(f'  {name:32s} 相机 {str(v["camDist"]):>8s}'
                 + (f'  均值 {st["meanRGB"]}  R/B {st["R/B"]}  亮 {st["litPct"]}%' if st else ''))

        # 收尾顺序：结论先落盘 → 服务先停 → 再武装看门狗 → 最后才碰浏览器
        sys.stdout.flush()
        srv.stop()
        arm_hard_exit(20)
        try:
            await browser.close()
        except Exception:
            pass
    return 0


async def main():
    srv = ServedCheck(tag='银河系外观探针')
    base = srv.start()
    try:
        return await run(base, srv)
    finally:
        srv.stop()


if __name__ == '__main__':
    try:
        code = asyncio.run(main())
    except Exception as e:                                # pragma: no cover
        emit(f'✗ {type(e).__name__}: {e}')
        code = 1
    emit('完成。')
    sys.stdout.flush()
    os._exit(int(code))

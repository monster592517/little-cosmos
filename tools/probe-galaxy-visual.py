#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""银河系视觉探针：标签密度 / 径向亮度色彩剖面 / 逐对象消融

为什么有这个东西
----------------
用户的原话是：**「你这银河系真是假爆了」**。
「假」是个主观词，不能拿它当判据 —— 必须换成能测量的东西。本脚本把「假」拆成三问：

  ① **标签是不是把星系埋了？** —— 数屏幕上真正可见的 `.label` 元素个数。
     参照：真实星系的科普图通常只标 10 个左右的天体；本项目在默认视角下曾标 40+ 个。

  ② **颜色是不是塌成中性灰了？**（坑 99）—— additive 叠加会把三个通道一起冲顶，
     实测 R≈G≈B。判据 = 每个径向环的平均 **R/B 比**：暖色盘面应 > 1，
     蓝白旋臂处 < 1；**若整盘 R/B 都贴在 1.00 附近 ⇒ 颜色已经被冲掉了**。
     ⇒ 这就是坑 99 欠的那条「自动像素判据」。

  ③ **那层说不清的蓝青色雾到底是谁画的？** —— 不猜，做**消融**：
     逐个隐藏场景的顶层子对象、各截一张图，与基线做**差分**，
     报出谁被隐藏后「蓝色过量」下降最多。被指认的那个就是元凶。

用法
----
    py -3.13 -X utf8 tools/probe-galaxy-visual.py
    py -3.13 -X utf8 tools/probe-galaxy-visual.py --no-ablate      # 只跑 ①②
    py -3.13 -X utf8 tools/probe-galaxy-visual.py --headed=false

产出
----
    shots/probe-galaxy.png            默认视角基线图（覆盖旧图）
    shots/ablate-<n>-<name>.png       消融图（只有 --ablate 时）
退出码：0 = 测到了；1 = 页面没起来。
"""
import asyncio
import os
import sys
import threading

from playwright.async_api import async_playwright
from browser_args import OCCLUSION_ARGS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')

# ★ 输出**必须行缓冲**。这个脚本的结尾注释里写着一条血泪教训：
#   「上一次跑在 browser.close() 上挂住，而 print 到重定向文件是**带缓冲的**
#     ⇒ 全部结论随进程一起丢掉，磁盘上只剩 emit() 刷过的部分。」
#   —— 那条注释只解释了现象，**并没有真正修**：只要 stdout 不是 tty（管道/文件），
#   Python 就按 8 KB 块缓冲，进程一挂，半天的测量照样丢光。
#   一行 reconfigure 修掉它：让日志**活着落盘**，挂住时也留得下已完成的结论。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(line_buffering=True)
    except Exception:                                     # pragma: no cover
        pass


def arm_hard_exit(seconds, code=0):
    """给「收尾」上一道硬上限：`seconds` 秒后**无条件** `os._exit(code)`。

    为什么必须这么干（第 23 轮实测，不是猜的）
    ------------------------------------------
    2026-09-11 一次会话里这个探针泄漏了**七份**残留进程，每一份都是：
    python 卡在极少 CPU、子进程（playwright 驱动 node + `server/server.mjs`）
    都还活着、日志停在最后一行不动，**四个小时不退**。
    现场读到的数：`CPU 3.59s → 3.59s（6 秒零增长）`、`threads=22`、
    `子 29156 playwright/driver/node.exe`、`子 4092 server.mjs --port=8792`。

    卡点在收尾那一句：
        await asyncio.wait_for(browser.close(), timeout=10)
    —— 「`wait_for` 有超时」是**假的安全感**。`wait_for` 在超时后要做的是
    *取消*内层协程，然后**等取消完成**；而 playwright 的 `browser.close()`
    是在等一条驱动 RPC，那东西**不接受取消**。于是 `wait_for` 自己也不返回，
    超时形同虚设，进程永久停在那里。
    ⇒ 凡是「靠别人可取消」来保证退出的写法，都不可靠。
    **唯一可靠的保证是：本进程自己动手退。**

    顺序很重要（照抄即可）：
      ① 结论先落盘（`sys.stdout.flush()`）；
      ② **服务先停**（`ServedCheck.stop()` 有界：terminate → wait(8) → kill）；
      ③ 再武装本看门狗；
      ④ 最后才去碰浏览器/驱动 —— 那一步可能永远不回来。
    ②在③之前，是因为 `os._exit` 会跳过 `atexit`；顺序颠倒就会留下孤儿服务。
    """
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t

# 钉住的画质档：`high` = 泛光开、像素比 2，是用户实际会看到的那一档。
# 传 'none' 表示不钉（只记录，不改变）—— 但那样 A/B 对比不可信，见 PIN_JS 上面的说明。
PIN_TIER = 'high'

# 渲染状态：每次测量都记下来。分支(composer|direct) 直接决定这次测量算不算数。
#
# ⚠️⚠️ **`pointBudget` 必须一起报，而且这一行比 `tier` 更重要**（2026-09-11 第 23 轮实测）：
#   `applyTier()` 改得动**渲染设置**（泛光 / 像素比 / 色调映射），
#   改不动**已经建好的几何** —— 点数是在 `build()` 时按当时的 `engine.tier.pointBudget` 定死的。
#   实测同一句 `applyTier('high')` 之后：
#     · 软件渲染那次（自动探测判成**省电档**）→ 盘点数合计 **60,000**
#     · 真 GPU 那次（自动探测判成**高性能档**）→ 盘点数合计 **160,000**
#   而**两次报告的 `tier` 都写着 `high`、`pinned` 都写着 `True`** ——
#   那一栏是真的，只是它管不着几何。**两栏都对、合起来是错的** ⇒ 一切像素统计不可比。
#   ⇒ 所以这里把 `pointBudget` 一并读出来，并且**钉档要发生在建场景之前**（见 `run()` 里的顺序）。
PIN_JS = r"""
(tier) => {
  const e = window.__universe.engine;
  if (e.gpu) e.gpu.tierPinned = true;
  if (tier && tier !== 'none' && e.applyTier) e.applyTier(tier);
  return {
    tier: e.tierId,
    pinned: !!(e.gpu && e.gpu.tierPinned),
    bloom: e.options && e.options.bloom,
    pixelRatio: e.renderer.getPixelRatio(),
    toneMapping: e.renderer.toneMapping,
    branch: (e.options && e.options.bloom !== false) ? 'composer' : 'direct',
    pointBudget: e.tier ? e.tier.pointBudget : null,
    levelBuilt: !!(e.current && e.current.scene),
  };
}
"""

# 渲染后端：**帧时间的读数必须配上它**（理由见 `run()` 里 launch 处的注释）。
# 口径与 `tools/perf-probe.py::PAGE_JS` 是同一套（`WEBGL_debug_renderer_info`），
# 别在这儿造第二份 —— 两套口径分叉的方向永远是「一边报软件渲染、另一边报 GPU」。
BACKEND_JS = r"""
() => {
  const r = window.__universe && window.__universe.engine && window.__universe.engine.renderer;
  if (!r) return { ok: false, renderer: '(拿不到 renderer)', vendor: null, software: null };
  const gl = r.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const unmasked = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
  return {
    ok: true,
    renderer: unmasked || '(扩展不可用)',
    vendor: vendor || null,
    software: /swiftshader|llvmpipe|software|basic render/i.test(unmasked || ''),
  };
}
"""

HEADED = True
ABLATE = True
MAX_ABLATE = 20
LINEAR = True                 # 第六节：核区线性峰值（压曝光反演）。见 `--no-linear`
E0 = 1.05                     # 与 engine.js 里 `toneMappingExposure = 1.05` 保持一致
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--max-ablate='):
        MAX_ABLATE = int(a.split('=', 1)[1])
    elif a == '--no-ablate':
        ABLATE = False
    elif a == '--no-linear':
        LINEAR = False

# ---------------------------------------------------------------------------
# 页面内：帧时间
# ---------------------------------------------------------------------------
FRAME_JS = r"""
(n) => new Promise(res => {
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
      res({ n: s.length, median: +s[Math.floor(s.length / 2)].toFixed(2),
            p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) });
    }
  };
  requestAnimationFrame(tick);
})
"""

# ---------------------------------------------------------------------------
# 页面内：标签盘点（只数「真正显示出来」的）
# ---------------------------------------------------------------------------
LABELS_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const all = lv.labels?.items || new Map();
  const shown = [];
  for (const el of all.values()) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (parseFloat(cs.opacity || '1') <= 0.02) continue;
    shown.push((el.textContent || '').trim().slice(0, 24));
  }
  return {
    total: all.size,
    shownCount: shown.length,
    shown,
    opts: lv.labelOptions || null,
    camDistToOrigin: +lv.camera.position.length().toFixed(1),
  };
}
"""

# ---------------------------------------------------------------------------
# 页面内：场景清单（顶层子对象 + 混合方式）
# ---------------------------------------------------------------------------
INVENTORY_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const out = [];
  const kids = lv.scene.children || [];
  for (let i = 0; i < kids.length; i++) {
    const o = kids[i];
    let mat = null, blend = null, opacity = null, count = null, hasMap = null;
    if (o.material) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      mat = m.type; blend = m.blending; opacity = m.opacity;
      hasMap = !!m.map;
    }
    if (o.geometry && o.geometry.attributes && o.geometry.attributes.position) {
      count = o.geometry.attributes.position.count;
    }
    out.push({
      i, name: o.name || '(无名)', type: o.type, visible: o.visible,
      children: (o.children || []).length,
      mat, blend, opacity, count, hasMap,
    });
  }
  return out;
}
"""

# ---------------------------------------------------------------------------
# 页面内：只让第 i 个顶层子对象可见（其它全部隐藏）
# ---------------------------------------------------------------------------
ISOLATE_JS = r"""
(i) => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  // ★ 第一次隔离时把**原始可见性**存下来，供 SHOWALL 按原样还回去。
  if (!window.__origVis) window.__origVis = kids.map((o) => o.visible);
  for (let k = 0; k < kids.length; k++) kids[k].visible = (k === i);
  lv.labels?.setVisible?.(false);
  return kids.length;
}
"""

# ⚠️ 「全部打开」是**错的**，两个方向都错（第 23 轮实测）：
#
#   ① `o.visible = true` 会把**出厂就藏着的**对象打开。
#      实测：`mw-guide-lines` 在场景清单里是 `可见=False`，跑完 ③ 就变成可见，
#      而紧接着的 ⑥ 是在**被 ③ 改过的场景**上量的。这正是同一份代码两次运行
#      结果差 3 倍的来源之一。
#   ② `lv.labels?.setVisible?.(true)` 会把**标签**打开 ——
#      而 ④c 之后整段（③b / ③c / ⑥）约定是**无标签口径**（见 ④c 处的注释）。
#      标签是 CSS，不吃曝光也不走 WebGL，⑥ 里又是**按曝光除**来读线性值的
#      ⇒ 不随曝光变化的像素会让读数直接失真。**⑥ 的所有截图都因此带了标签。**
#   ⇒ 恢复要**按原样**，标签保持在关。`ISOLATE_JS` 存的那份快照就是「原样」。
SHOWALL_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  const orig = window.__origVis;
  for (let k = 0; k < kids.length; k++) {
    kids[k].visible = orig ? !!orig[k] : true;      // 没有快照才退回「全开」
  }
  lv.labels?.setVisible?.(false);                   // 无标签口径，别在这儿打开
  return kids.length;
}
"""

# ---------------------------------------------------------------------------
# 只截 3D 画面，把 HUD 排除掉
# ---------------------------------------------------------------------------
# ⚠️ 为什么必须排除：`page.screenshot()` 会连**顶层工具栏 + 底部状态栏 + 栏目/面板**一起截进来。
#    它们在同一块屏幕像素上恒定不变 ⇒ 按半径分环统计时，**界面在冒充信号**。
#    实测证据：四张**完全不同**的消融图（md5 各不相同），环带统计却给出
#    **一模一样**的 77360 个亮像素、R/G/B 也逐位相同。看见这个矛盾就该怀疑量具，而不是相信结论。
#
# ⚠️ **不能用「裁 canvas 矩形」来排除**：本项目的 canvas 是**全视口**的（`#scene` 铺满），
#    HUD 是用 `position:absolute` **叠在上面**的 —— 裁 canvas 等于裁整页，一点用都没有。
#    （第一版就这么写了，还「成功」了，因为裁剪矩形恰好等于视口。**静默无效的修复。**）
#    正确做法是**把干扰源藏起来**，不是裁掉它。
# ⚠️ 下面这份清单**已废弃**（保留成注释是为了记住教训）。手写清单一定会漏 ——
#    （坑 26「靠手写文件清单做全量替换，必漏」的同一条病）。
#    2026-09-11 第 23 轮实测：右上角那排按钮（目录 / 研究 / 设置 / ?）和底部
#    「回到此刻」**根本不在清单里**，于是它们**留在截图里冒充信号** ——
#    径向剖面第 11、12 环的亮度从 0.3 / 0.5 跳到 1.1 / 2.6，而且 R/B 只有 0.39（偏蓝），
#    正好就是那几个按钮的配色。**判据被界面污染了，而清单还自称「我藏好了」。**
#    旧写法：HUD_SELECTORS = ['#topbar', '#hud', '#crumb', '#palette', '#toast',
#                             '#boot', '#catalog-pane', '#panel']
#    ⇒ 改成**构造上穷举**：隐藏 `<body>` 除 `#scene`（画布）与 `#labels`（标签层）
#      之外的所有直接子元素。没有清单要维护，也就没有清单会过期。
HIDE_HUD_JS = """
() => {
  const KEEP = new Set(['scene', 'labels']);
  const saved = [];
  for (const el of document.body.children) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
    if (KEEP.has(el.id)) continue;
    saved.push([el, el.style.display]);
    el.style.display = 'none';
  }
  window.__hudSaved = saved;
  return saved.length;
}
"""
# 藏完**必须核实**：还有谁在占像素？返回非空 ⇒ 判据要响（而不是「我以为藏好了」）。
AUDIT_HUD_JS = """
() => {
  const KEEP = new Set(['scene', 'labels']);
  const vis = [];
  for (const el of document.body.children) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
    if (KEEP.has(el.id)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 4 && r.height > 4) {
      vis.push((el.id || tag) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  return vis;
}
"""
SHOW_HUD_JS = """
() => {
  const saved = window.__hudSaved || [];
  for (const [el, v] of saved) el.style.display = v || '';
  window.__hudSaved = null;
  return saved.length;
}
"""

# 拧曝光。OutputPass 每帧从 `renderer.toneMappingExposure` 同步（vendor 里第 84 行），
# 所以改这一个值就能整体平移色调曲线。
SET_EXPOSURE_JS = """
(v) => {
  const r = window.__universe.engine.renderer;
  r.toneMappingExposure = v;
  return r.toneMappingExposure;
}
"""

# ★「线性读出模式」：把末端换成**纯增益 + 不编码**，让码值直接等于线性值。
#
# 为什么要另起一套读法（第 23 轮实测教训）：
#   第一版拿 ACES 档位压曝光、再按 ACES 公式反演，结果是
#     曝光 1.05 → 线性 1.35 ； 0.3675 → 2.23 ； 0.12862 → 4.12
#   同一个不动的画面，换曝光给出的线性值差 **3 倍** —— 按「曝光只是末端增益」
#   这个模型，三者必须完全相同。差这么多只说明模型缺了一环。
#   ⇒ 与其去猜缺了什么，不如换一个**没有曲线可以出错**的读法：
#       `LinearToneMapping` = saturate(toneMappingExposure * color)
#       `outputColorSpace = 'srgb-linear'` = 不做 sRGB 编码
#     于是 **码值 = 255 · min(1, L · E)**，反演就是一次除法。
#     这样「换个曝光是否得到同一个 L」才成为对管线本身的**真检验**。
LINEAR_MODE_JS = """
(on) => {
  const r = window.__universe.engine.renderer;
  if (on) {
    if (window.__savedTM === undefined) {
      window.__savedTM = r.toneMapping;
      window.__savedCS = r.outputColorSpace;
    }
    r.toneMapping = 1;                    // THREE.LinearToneMapping
    r.outputColorSpace = 'srgb-linear';   // THREE.LinearSRGBColorSpace
  } else if (window.__savedTM !== undefined) {
    r.toneMapping = window.__savedTM;
    r.outputColorSpace = window.__savedCS;
    window.__savedTM = undefined;
  }
  return { tm: r.toneMapping, cs: r.outputColorSpace };
}
"""

# 管线实况。**每次测量前都要读** —— 这几项直接决定读数还算不算数。
PIPE_STATE_JS = """
() => {
  const e = window.__universe.engine;
  const r = e.renderer, c = e.composer;
  return {
    tm: r.toneMapping, exp: +r.toneMappingExposure.toFixed(4), cs: r.outputColorSpace,
    rtCS: c && c.renderTarget1 ? c.renderTarget1.texture.colorSpace : null,
    rtType: c && c.renderTarget1 ? c.renderTarget1.texture.type : null,
    passes: c ? c.passes.map(p => p.constructor.name + (p.enabled === false ? '(off)' : '')) : [],
    bloomOn: e.bloomPass ? !!e.bloomPass.enabled : null,
    bloomTh: e.bloomPass ? e.bloomPass.threshold : null,
    pr: r.getPixelRatio(),
    tier: e.tierId, pinned: !!(e.gpu && e.gpu.tierPinned),
  };
}
"""

# 泛光开关：**分解测量必须关掉它**。
# `UnrealBloomPass` 的高通是 `smoothstep(threshold, threshold+width, luma)` ——
# 带阈值 ⇒ 逐对象算泛光再相加 ≠ 一起算。实测残差 68.7%，这张分解表在泛光开着时**不可加**。
BLOOM_JS = """
(on) => {
  const e = window.__universe.engine;
  if (e.bloomPass) e.bloomPass.enabled = !!on;
  return e.bloomPass ? e.bloomPass.enabled : null;
}
"""

# 标签层开关。**核区的任何亮度统计都必须先关掉它。**
#
# ⚠️ 这是本轮最贵的一个错误，值得单列：`HIDE_HUD_JS` 的 `KEEP` 里有 `'labels'`
#    （标签密度本来就是待考察的画面内容，所以故意留着）。但标签是 **CSS 画的**，
#    既不吃曝光、也不走渲染管线 —— 而屏幕上恰好有一个标签叫「**银心 · 人马座 A***」，
#    它就压在核区上。后果是核区那一坨统计变成了
#      「随曝光变暗的 3D 渲染」＋「纹丝不动的白字」的混合，
#    于是**换曝光反演出来的线性值差 3 倍**，而我还去猜管线缺了哪一环。
#    同一个污染还让 ③c 表**基线行带标签、被测行不带**（`ISOLATE_JS` 会关标签）
#    ⇒ 「单独显示核球 251.1 比全开 246.1 还亮」这种不可能的事看起来像真的。
#    ⇒ 教训与坑 26 同源：**统计口径里混进了不受被测机制控制的成分。**
HIDE_LABELS_JS = """
(on) => {
  const el = document.getElementById('labels');
  if (!el) return null;
  if (on) {
    if (window.__labPrev === undefined) window.__labPrev = el.style.display;
    el.style.display = 'none';
  } else {
    el.style.display = window.__labPrev || '';
    window.__labPrev = undefined;
  }
  return el.style.display;
}
"""


SETTLE_JS = r"""
(n) => new Promise(res => {
  let i = 0;
  const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
})
"""


async def settle(page, frames=3, min_ms=0):
    """等**真的渲染了 `frames` 帧**，并且**至少过了 `min_ms` 毫秒**。

    两个条件都要 —— 它们在防两件不同的事：

    · **等帧数**：防「截图抢在重新渲染之前」。原来的写法是一堆固定的
      `wait_for_timeout(430)`，那是**按快帧校准的**（真 GPU 一帧 8 ms ⇒ 430 ms ≈ 54 帧，绰绰有余）。
      软件渲染时一帧要 198 ms ⇒ 430 ms **只够 2 帧**，而改完可见性需要渲染才体现。
    · **等时间**：防「帧数够了但活还没干完」。换 shader defines 要**重编译着色器**，
      rAF 照常回调，但新程序还没编译完 —— 那时等帧数是没用的。

    固定毫秒数只对付得了后者，而且**只在帧率快的时候顺便对付了前者**；
    帧率一慢，它就静默变成「等不到渲染」。这正是它骗人的地方。

    实测症状（第 23 轮，同一份代码两次运行）：
      · 隐藏 `mw-guide-lines`（出厂就 `可见=False`，藏它不可能改变任何像素）却报 Δ = **+94.97**；
      · `mw-points-bar` / `mw-core-sprite` 的消融图 R=G=B=**0**（整张近乎全黑）；
      · 同一个分解表里 `mw-points-disk` 的线性值两次运行差 **3 倍**（2.2566 → 0.7301）。
    """
    if min_ms:
        await page.wait_for_timeout(min_ms)
    try:
        await page.evaluate(SETTLE_JS, frames)
    except Exception:                                     # pragma: no cover
        pass


async def shoot(page, path, label=''):
    """截「只有 3D 画面 + 标签」的图：HUD 临时隐藏，并**核实确实藏住了**。"""
    await page.evaluate(HIDE_HUD_JS)
    await settle(page, frames=2)              # 等渲染真的反映「HUD 已藏」
    left = await page.evaluate(AUDIT_HUD_JS)
    if left:
        emit(f'  ⚠ 还有界面元素在占像素，统计会被污染：{", ".join(left[:6])}'
             + (f' … 共 {len(left)} 个' if len(left) > 6 else '') + f'  〔{path}〕')
    await page.screenshot(path=path)
    await page.evaluate(SHOW_HUD_JS)
    return path


def _np_pil():
    try:
        import numpy as np
        from PIL import Image
        return np, Image
    except Exception as e:                                    # pragma: no cover
        emit(f'  ✗ 需要 numpy + Pillow 才能做像素分析：{e}')
        return None, None


# ---------------------------------------------------------------------------
# 像素分析
# ---------------------------------------------------------------------------
def radial_profile(arr, np):
    """以「最亮像素」为银心做径向剖面。

    ⚠️ 用最亮像素当圆心，而不是图像几何中心 —— 星系在画面里未必居中，
    圆心错了会让所有环都串味（这是第一版犯过的错）。
    """
    lum = arr[..., :3].astype('float32') @ np.array([0.2126, 0.7152, 0.0722], 'float32')
    cy, cx = np.unravel_index(int(np.argmax(lum)), lum.shape)
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    rmax = float(r.max())
    rows = []
    edges = [i / 12.0 for i in range(13)]
    for k in range(12):
        lo, hi = edges[k] * rmax, edges[k + 1] * rmax
        m = (r >= lo) & (r < hi)
        if not m.any():
            continue
        px = arr[..., :3][m].astype('float32')
        ml = float(lum[m].mean())
        rgb = px.mean(axis=0)
        rows.append({
            'ring': k + 1,
            'r0': round(lo), 'r1': round(hi),
            'lum': round(ml, 1),
            'R': round(float(rgb[0]), 1),
            'G': round(float(rgb[1]), 1),
            'B': round(float(rgb[2]), 1),
            'RB': round(float(rgb[0] / max(rgb[2], 0.5)), 3),
            'hot': round(float((lum[m] > 220).mean()) * 100, 2),
            'warm': round(float(((px[:, 0] > px[:, 2] + 8) & (lum[m] > 40)).mean()) * 100, 1),
            'cool': round(float(((px[:, 2] > px[:, 0] + 8) & (lum[m] > 40)).mean()) * 100, 1),
        })
    return (cy, cx), rmax, rows


def core_profile(arr, np, center, rmax, frac=0.20, bins=10):
    """核区剖面：把 0→`frac`·rmax 分 `bins` 个环，报亮度 / 饱和占比 / RGB。

    ⚠️ 为什么单独的核区函数：**整盘平均看不见过曝**。
    「0.12–1.0 R」那个环带把只有百分之几面积的核球平均掉了 ——
    实测核区 37% 的像素 >220，而整盘平均给出来的只是一个「暖色主导」的漂亮结论。
    **统计口径选错，会让人以为已经修好了。**

    判据（看 `sat%` 那一列）：
      · 合格：饱和占比随半径**单调下降**，且前几个环内就掉到 <1%
      · 不合格：前几个环都贴在 ~100% ⇒ 那是**平顶**，不是核球，是曝光过度
      · `satR`（饱和占比跌破 1% 的半径，占 rmax 的百分比）越小越好 ——
        真实星系照片里饱和区只有盘半径的百分之几。
    """
    cy, cx = center
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) / max(rmax, 1)
    lum = arr[..., :3].astype('float32') @ np.array([0.2126, 0.7152, 0.0722], 'float32')
    rows = []
    sat_r = None
    for k in range(bins):
        lo, hi = frac * k / bins, frac * (k + 1) / bins
        m = (r >= lo) & (r < hi)
        if not m.any():
            continue
        px = arr[..., :3][m].astype('float32')
        sat = float((lum[m] > 250).mean()) * 100
        rows.append({'r': f'{lo * 100:.1f}-{hi * 100:.1f}%', 'lum': round(float(lum[m].mean()), 1),
                     'sat': round(sat, 1), 'hot220': round(float((lum[m] > 220).mean()) * 100, 1),
                     'R': round(float(px[:, 0].mean()), 1), 'G': round(float(px[:, 1].mean()), 1),
                     'B': round(float(px[:, 2].mean()), 1)})
        if sat_r is None and sat < 1.0:
            sat_r = (k + 1) / bins * frac * 100
    return rows, (round(sat_r, 1) if sat_r is not None else None)


def disk_stats(arr, np, center=None, rmax=None, lo=0.12, hi=1.0):
    """盘面区域（不含核球）的整体统计 —— 消融对比用这一个数。

    ⚠️ `center=None` 时**自己按最亮像素重新定位圆心**。不要跨图沿用基线圆心：
    消融图里高频变化的是「谁在发光」，随便哪张图的最亮点都可能挪位，
    沿用旧圆心会让环带和实际内容错开 —— 那样量到的是「圆心错了」而不是「对象没了」。
    """
    if center is None or rmax is None:
        lum0 = arr[..., :3].astype('float32') @ np.array([0.2126, 0.7152, 0.0722], 'float32')
        cy, cx = np.unravel_index(int(np.argmax(lum0)), lum0.shape)
        hh, ww = lum0.shape
        center = (cy, cx)
        rmax = float(np.sqrt(max(cy, hh - 1 - cy) ** 2 + max(cx, ww - 1 - cx) ** 2))
    cy, cx = center
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) / max(rmax, 1)
    m = (r >= lo) & (r <= hi)
    px = arr[..., :3][m].astype('float32')
    lum = px @ np.array([0.2126, 0.7152, 0.0722], 'float32')
    on = lum > 6.0                     # 只算「有内容」的像素，否则黑底会把蓝量稀释
    return {
        'area': int(m.sum()),
        'litPct': round(float(on.mean()) * 100, 2),
        'R': round(float(px[on, 0].mean()) if on.any() else 0, 1),
        'G': round(float(px[on, 1].mean()) if on.any() else 0, 1),
        'B': round(float(px[on, 2].mean()) if on.any() else 0, 1),
        'blueExcess': round(float((px[on, 2] - px[on, 0]).mean()) if on.any() else 0, 2),
    }


# ---------------------------------------------------------------------------
# 线性峰值：把 ACES 肩部让开，再按 three 自己的公式反演
# ---------------------------------------------------------------------------
# ⚠️ 为什么非要有这一节（第 23 轮实测教训）：
#   管线改成「线性 HDR 累积 → 泛光 → 单个 OutputPass 出 ACES」之后，
#   截断**从 code value 空间搬进了 ACES 的肩部**。而肩部是压缩的 ——
#   线性亮度 2.0→4.0（翻一倍），画面只从 246 走到 252（**+6 个码值**）。
#   ⇒ 「核区亮度 246 还是 251」这种比较**已经没有分辨力**了，
#     拿它决定「核球该降多少」等于在比两个都贴着天花板的数字。
#   ⇒ 办法：把曝光压到中心退出肩部，读数重新变回线性，再反演回**真实线性值**。
#
# 复刻来源：`web/vendor/three/three.module.js` 里的 `tonemapping_pars_fragment`
#   （ACESInputMat / RRTAndODTFit / ACESOutputMat）+ sRGB 编码。
#   ⚠️ 两个矩阵的**行和都是 1** ⇒ 中性输入出中性输出，所以等色度方向可以标量二分。
#   ⚠️ 反演必须**正演自证**：反演出线性值后正演一遍，应当复原观测码值；
#      残差写进输出。做不到自证的反演，和「看着顺眼就调参」没有区别。
_ACES_IN = None
_ACES_OUT = None


def _aces_mats(np):
    global _ACES_IN, _ACES_OUT
    if _ACES_IN is None:
        # GLSL 里 `mat3(c0, c1, c2)` 是**按列**给的；行和 = 1（中性保持）。
        _ACES_IN = np.array([[0.59719, 0.35458, 0.04823],
                             [0.07600, 0.90834, 0.01566],
                             [0.02840, 0.13383, 0.83777]], 'float32')
        _ACES_OUT = np.array([[1.60475, -0.53108, -0.07367],
                              [-0.10208, 1.10813, -0.00605],
                              [-0.00327, -0.07276, 1.07602]], 'float32')
    return _ACES_IN, _ACES_OUT


def aces_forward(lin, exposure, np):
    """线性 RGB → 屏幕码值（0..1）。逐片元复刻 three 的 ACESFilmic + sRGB。"""
    mi, mo = _aces_mats(np)
    c = np.asarray(lin, 'float32') * (float(exposure) / 0.6)
    c = c @ mi.T
    a = c * (c + 0.0245786) - 0.000090537
    b = c * (0.983729 * c + 0.4329510) + 0.238081
    c = np.clip(a / b, 0.0, 1.0) @ mo.T
    c = np.clip(c, 0.0, 1.0)
    s = np.where(c <= 0.0031308, c * 12.92,
                 1.055 * np.power(np.maximum(c, 1e-8), 1.0 / 2.4) - 0.055)
    return np.clip(s, 0.0, 1.0)


_LUMA = (0.2126, 0.7152, 0.0722)


def _rrt(v, np):
    """`RRTAndODTFit` 本体（逐元素）。"""
    a = v * (v + 0.0245786) - 0.000090537
    b = v * (0.983729 * v + 0.4329510) + 0.238081
    return a / b


def _rrt_inv(y, np):
    """`RRTAndODTFit` 的逆：单调（严格递增）⇒ 二分。

    ⚠️ 它**不是**在 0 处过原点：`a(x)=x(x+0.0245786)−0.000090537` 在 x≈0.00325 处才变正。
       也就是说线性值再小也会被这个函数压成负、再被 `saturate` 压成 0
       ⇒ **ACES 会把最深的那一档压成纯黑**。所以反演的下界取 0.00324 而不是 0。
    """
    lo, hi = 0.00325, 400.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if float(_rrt(np.array([mid], 'float32'), np)[0]) < y:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def aces_invert(obs255, exposure, np):
    """屏幕码值 RGB → 线性 RGB。**解析反演**，不对色度做任何假设。

    链条：线性 →(×exp/0.6)→ ACESInputMat → RRTAndODTFit → ACESOutputMat → saturate → sRGB
    逆着走一遍即可：
      ① sRGB 反编码；
      ② `ACESOutputMat` **求逆**（3×3 线性方程组，唯一解）；
      ③ `RRTAndODTFit` 逐元素二分求逆；
      ④ `ACESInputMat` 求逆，再除回 `exp/0.6`。

    ⚠️ 第一版这里是「保持色度方向 + 标量二分」，在暖色上报废 —— 因为
       `ACESOutputMat` 会混通道，**输出色度 ≠ 输入色度**（实测相对误差 11.4%）。
       自检脚本 `tools/check-aces-reimpl.py` 抓到了它。别改回去。

    返回 (线性RGB, 正演残差码值, 是否被 saturate 削平)。
    """
    obs = np.asarray(obs255, 'float32') / 255.0
    sat_flag = bool(obs.max() >= 254.5 / 255.0)
    if obs.max() <= 0:
        return np.zeros(3, 'float32'), 0.0, sat_flag
    mi, mo = _aces_mats(np)
    out = np.where(obs <= 0.04045, obs / 12.92, ((obs + 0.055) / 1.055) ** 2.4)
    try:
        c2 = np.linalg.solve(mo, out)                       # ② 输出矩阵求逆
        c1 = np.array([_rrt_inv(float(max(v, 1e-6)), np) for v in c2], 'float32')   # ③
        lin = np.linalg.solve(mi, c1) / (float(exposure) / 0.6)                     # ④
    except np.linalg.LinAlgError:
        return np.zeros(3, 'float32'), 999.0, sat_flag
    lin = np.maximum(lin, 0.0).astype('float32')
    back = aces_forward(lin, exposure, np) * 255.0
    return lin, float(np.abs(back - np.asarray(obs255, 'float32')).max()), sat_flag


def core_stats(arr, np, center, rmax, frac=0.02):
    """核区（0→`frac`·rmax）的标量统计。**专给线性反演用**：给的是均值通道和最大值。

    和 `core_profile` 的分工：那个报「分环剖面」（看形状），这个报「一坨的峰值」
    （看有没有顶到天花板）。判据 `clip%`：>0 就说明**这一张图不能用来反演**。
    """
    cy, cx = center
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) / max(rmax, 1)
    m = r < frac
    lum = arr[..., :3].astype('float32') @ np.array(_LUMA, 'float32')
    if not m.any():
        return None
    px = arr[..., :3][m].astype('float32')
    lm = lum[m]
    return {
        'n': int(m.sum()),
        'lum': round(float(lm.mean()), 1),
        'RGB': [round(float(px[:, i].mean()), 1) for i in range(3)],
        'max': round(float(lm.max()), 1),
        'p999': round(float(np.percentile(lm, 99.9)), 1),
        'clip': round(float((lm >= 250).mean()) * 100, 3),
    }


# ---------------------------------------------------------------------------
async def main():
    srv = ServedCheck(tag='银河系视觉探针')
    base = srv.start()
    try:
        return await run(base, srv)
    finally:
        # 兜底：`run()` 正常走到收尾时已经停过一次（幂等，重复调用无副作用）。
        # 留着它是为了**出错路径**也能收掉服务。
        srv.stop()


async def run(base, srv):
    np, Image = _np_pil()
    if np is None:
        return 1
    os.makedirs(SHOTS, exist_ok=True)

    async with async_playwright() as pw:
        # ★ 必须记住**用的是哪个后端**。第 23 轮实测：同一份画面、同一个 `--headed=false`，
        #   两次运行量到的帧时间中位数是 **198.3 ms 和 7.9 ms —— 差 25 倍**。
        #   两个数不可能都对。差别在渲染后端：`channel='msedge'` 拿真 GPU，
        #   而它一失败就**静默退回** playwright 自带的 chromium（无头下走 SwiftShader 软件渲染）。
        #   ⇒ 帧时间是硬指标，**「哪个后端」和「哪个画质档」同级，不记下来这次测量就不算数**。
        backend = 'msedge'
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=OCCLUSION_ARGS)
        except Exception as e:
            backend = f'bundled-chromium（msedge 起不来：{type(e).__name__}）'
            browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! {m.text[:160]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=45000)
        await page.wait_for_timeout(2500)

        # ---- 先钉住画质档，**再进银河系**（坑 104 + 坑 116）-------------
        # ⚠️ 这两步的顺序**不能反**，而且反了不会报错。
        #    点数预算是在 `level.build()` 那一刻按 `engine.tier.pointBudget` 定死的，
        #    而 `applyTier()` 只改得动**渲染设置**（泛光/像素比/色调映射），
        #    **改不动已经建好的几何**。
        #    原来这里写反了（先进 galaxy、再钉档）⇒ 几何留在**自动探测**的那一档：
        #      软件渲染 ⇒ 省电档 **60,000** 点 ；真 GPU ⇒ 高性能档 **160,000** 点
        #    而**两次报告的 `tier` 都写着 `high`、`pinned` 都写着 `True`** ——
        #    那一栏是真的，只是它管不着几何。**差 2.67 倍的场景，报告里看不出来**，
        #    这就是「⑥ 逐层分解两次差 3 倍」的真因（不是 race、不是状态泄漏）。
        st = await page.evaluate(PIN_JS, PIN_TIER)
        emit(f'  画质档已钉住（进 galaxy 之前）：{st}')

        await page.evaluate("window.__universe.gotoScale('galaxy')")
        await page.wait_for_function(
            "window.__universe.engine.current?.id === 'galaxy'", timeout=40000)
        await page.wait_for_timeout(2000)

        # 建完场景再读一次：确认**钉住的档在几何上也生效了**（只用 'none'，不再改档）。
        st2 = await page.evaluate(PIN_JS, 'none')
        if st2.get('levelBuilt') and st2.get('pointBudget') != st.get('pointBudget'):
            emit(f'  ⚠ 建完场景后 pointBudget 变了：{st.get("pointBudget")} → '
                 f'{st2.get("pointBudget")} ⇒ **自动降档在建场景之后动过手**，')
            emit('     这次的点数预算不可信，像素统计别拿去和别的运行比。')
        gp = await page.evaluate(BACKEND_JS)
        emit(f'  渲染后端：{backend} · WebGL={gp.get("renderer")} · '
             f'软件渲染={gp.get("software")}')
        if backend != 'msedge':
            emit('  ⚠⚠ 没拿到 msedge，退回自带 chromium ⇒ **无头下走 SwiftShader 软件渲染**。')
            emit('     实测：同一份画面、同样 `--headed=false`，软件渲染 198 ms/帧，')
            emit('     真 GPU 7.9 ms/帧 —— **差 25 倍**。⑤ 的帧时间在这一轮里不作数。')
            emit('     要量帧时间就加 `--headed=true`（有头，走真 GPU）。')

        # ---- ① 标签盘 + 帧时间 + 基线图 -------------------------------
        lab = await page.evaluate(LABELS_JS)
        fr = await page.evaluate(FRAME_JS, 90)
        base_png = os.path.join(SHOTS, 'probe-galaxy.png')
        await shoot(page, base_png)
        emit('  基线截图 → shots/probe-galaxy.png')

        print('\n' + '=' * 78)
        print('  ① 标签密度（默认视角）')
        print('-' * 78)
        print(f'  相机距银心 {lab["camDistToOrigin"]} 千光年 · '
              f'labelOptions={lab["opts"]}')
        print(f'  建了 {lab["total"]} 个标签，**屏幕上真正显示 {lab["shownCount"]} 个**')
        print('  显示出来的：' + '、'.join(lab['shown'][:40]))
        if lab['shownCount'] > 30:
            print('  ⚠ 超过 30 个 ⇒ 这一屏在讲「编号」而不是在讲「星系」')
        print('-' * 78)
        print(f'  ⑤ 帧时间（视觉比例）  中位 {fr["median"]} ms · '
              f'p95 {fr["p95"]} ms · 最大 {fr["max"]} ms   '
              f'（60fps 预算 16.7 ms）')
        # ⚠️ 帧时间**只有配上后端才可解释**：同一份画面、同样 `--headed=false`，
        #    实测出现过 198.3 ms（软件渲染）与 7.9 ms（真 GPU）两个数，差 25 倍。
        #    单看数字会得出完全相反的性能结论 —— 而两边都是「量出来的」。
        print(f'     ↳ 后端 {backend} · WebGL={gp.get("renderer")} · '
              f'软件渲染={gp.get("software")}')
        if gp.get('software'):
            print('     ⚠ 软件渲染 ⇒ **这个帧时间不代表用户看到的性能**，'
                  '不要拿它做 A/B 或判定「卡顿」。'
                  '要真数就 `--headed=true`（有头，走真 GPU）。')

        # ---- ④ 基线径向剖面 -------------------------------------------
        arr0 = np.asarray(Image.open(base_png).convert('RGB'))
        center, rmax, rows = radial_profile(arr0, np)
        print('=' * 78)
        print('  ④ 径向亮度/色彩剖面（圆心 = 最亮像素）')
        print('-' * 78)
        print('   环   半径px      亮度      R      G      B    R/B    >220%  暖%  冷%')
        for r in rows:
            flag = ''
            if abs(r['RB'] - 1.0) < 0.04 and r['lum'] > 25:
                flag = '  ← R≈G≈B 灰'
            print(f'  {r["ring"]:>2}  {r["r0"]:>4}-{r["r1"]:<4} {r["lum"]:>8} '
                  f'{r["R"]:>6} {r["G"]:>6} {r["B"]:>6} {r["RB"]:>6} '
                  f'{r["hot"]:>6} {r["warm"]:>5} {r["cool"]:>5}{flag}')
        base_disk = disk_stats(arr0, np, center, rmax)
        print(f'  整盘区域（0.12–1.0 R）：有效像素 {base_disk["litPct"]}% · '
              f'R{base_disk["R"]}/G{base_disk["G"]}/B{base_disk["B"]} · '
              f'蓝过量 {base_disk["blueExcess"]:+.2f}')

        # ---- ④b 核区剖面（过曝只有这一个口径看得见）--------------------
        crows, satR = core_profile(arr0, np, center, rmax)
        print('=' * 78)
        print('  ④b 核区剖面（0–20% 半径，10 环）—— 「中央是不是糊成一团白」看这里')
        print('-' * 78)
        print('   半径区间      亮度    >250%   >220%      R      G      B')
        for r in crows:
            flag = '  ← 平顶' if r['sat'] > 80 else ''
            print(f'   {r["r"]:>9}  {r["lum"]:>8} {r["sat"]:>7} {r["hot220"]:>7} '
                  f'{r["R"]:>6} {r["G"]:>6} {r["B"]:>6}{flag}')
        print(f'  → 饱和(>250)占比跌破 1% 的半径 ≈ {satR}% of rmax '
              f'（越小越好；这决定「白斑」有多大）')

        # ---- ④c 标签污染：同一曝光下，关掉标签再量一遍 ------------------
        # 标签是 CSS 画的，不吃曝光也不走管线，而「银心 · 人马座 A*」正压在核区上。
        # 这一节的作用是**把污染量出来**，并给 ⑥ 和 ③c 提供无标签的口径。
        await page.evaluate(HIDE_LABELS_JS, True)
        await settle(page, frames=3)
        nolab_png = os.path.join(SHOTS, 'probe-galaxy-nolabel.png')
        await shoot(page, nolab_png)          # shoot 的 KEEP 里有 labels，不会把它放回来
        arr_nl = np.asarray(Image.open(nolab_png).convert('RGB'))
        # ⚠️ 圆心也要重定：`radial_profile` 取「最亮像素」当圆心，
        #    而带标签的图里最亮像素**可能是文字**，那样所有环都串味。
        ctr, rr, _ = radial_profile(arr_nl, np)
        ctr_shift = float(np.hypot(ctr[0] - center[0], ctr[1] - center[1]))
        # 同圆心对比，才只剩「标签」这一个变量。
        crows_lab, _ = core_profile(arr0, np, ctr, rr)
        crows_nl, satR_nl = core_profile(arr_nl, np, ctr, rr)
        print('=' * 78)
        print('  ④c 标签污染 —— 同一张画面，只把 `#labels` 关掉再量核区')
        print('-' * 78)
        print(f'  圆心：带标签 {center} → 无标签 {ctr}（偏移 {ctr_shift:.1f} px）'
              + ('  ⚠ 偏移 >2px ⇒ 之前的圆心是**标签像素**' if ctr_shift > 2 else ''))
        print('   半径区间      带标签   无标签    差    |  带标签>250%  无标签>250%')
        for a, b in zip(crows_lab, crows_nl):
            print(f'   {a["r"]:>9}  {a["lum"]:>8} {b["lum"]:>8} {b["lum"] - a["lum"]:>+7.1f}  |'
                  f'  {a["sat"]:>10} {b["sat"]:>11}')
        print(f'  → 饱和半径：带标签 {core_profile(arr0, np, ctr, rr)[1]}% '
              f'→ 无标签 {satR_nl}% of rmax')
        if abs(crows_nl[0]['lum'] - crows_lab[0]['lum']) > 1.0:
            print(f'  ⚠ 核区被标签动了 {crows_nl[0]["lum"] - crows_lab[0]["lum"]:+.1f} 码值'
                  f' ⇒ ③c 的基线行必须用无标签口径，否则基线与被测行不同尺。')
        # ⚠️ 标签**从这里开始一直关着**：③c 与 ⑥ 都在无标签口径（圆心 `ctr`、半径 `rr`）下量。
        #    恢复统一放在收尾处，别中途散着恢复（漏一处 = 后半段测量全污染）。
        #
        # 口径统一切过来：③b 的基线与 ③c/⑥ 全部跟着走，避免「基线一套尺、被测另一套尺」。
        center, rmax = ctr, rr
        base_disk_nl = disk_stats(arr_nl, np, center, rmax)
        print(f'  无标签口径的整盘基线：有效像素 {base_disk_nl["litPct"]}% · '
              f'蓝过量 {base_disk_nl["blueExcess"]:+.2f}  ← ③b 的对比基准换成这个')

        # ---- ③ 消融：谁在画那层蓝雾 ------------------------------------
        if ABLATE:
            inv = await page.evaluate(INVENTORY_JS)
            print('=' * 78)
            print('  ③ 场景清单（顶层子对象）')
            print('-' * 78)
            for o in inv:
                print(f'  [{o["i"]:>2}] {o["name"]:<20} {o["type"]:<8} '
                      f'可见={str(o["visible"]):<5} 子={o["children"]:<3} '
                      f'点数={str(o["count"]):<7} 材质={o["mat"]} '
                      f'混合={o["blend"]} 不透明度={o["opacity"]} map={o["hasMap"]}')

            # ⚠️ 候选要包含 **Group**，不能只挑 Points/Mesh/Sprite。
            #    第一版只挑后三类，于是**四条蓝色尺度圈（Group[9] / `0x3a6a9a`）和导引线
            #    根本没进消融名单** —— 而它们正是「蓝」这个嫌疑的最大来源。
            #    候选漏掉一类对象 = 把真凶判成无罪（同族错误：判据少认一个声明源）。
            cand = [o for o in inv if o['type'] != 'AmbientLight']
            emit(f'\n  逐个**只留一个**顶层对象、各截一张，看这一层单独长什么样…')
            abl = []
            for n, o in enumerate(cand):
                if n >= MAX_ABLATE:
                    emit(f'  （--max-ablate={MAX_ABLATE}，余下 {len(cand) - n} 个跳过）')
                    break
                await page.evaluate(ISOLATE_JS, o['i'])
                await settle(page, frames=3)
                fn = os.path.join(SHOTS, f'ablate-{n:02d}-{o["name"].replace("/", "_")[:18]}.png')
                await shoot(page, fn)
                a = np.asarray(Image.open(fn).convert('RGB'))
                # ⚠️ 消融图必须用**基线那一套圆心/半径**，不能每张自己重定位 ——
                #    否则量到的是「圆心挪了」，不是「对象没了」。
                st = disk_stats(a, np, center, rmax)
                cr, sR = core_profile(a, np, center, rmax)
                st['satR'] = sR
                st['coreSat'] = cr[0]['sat'] if cr else None
                st['coreLum'] = cr[0]['lum'] if cr else None
                abl.append({**st, 'name': o['name'], 'i': o['i'], 'type': o['type'], 'shot': fn})
            await page.evaluate(SHOWALL_JS)
            await settle(page, frames=3)

            print('=' * 78)
            # ⚠️ 标题原来写的是「隐藏谁之后蓝过量下降最多」—— **说反了**。
            #    `ISOLATE_JS` 是 `kids[k].visible = (k === i)`，也就是**只显示这一个**。
            #    按「隐藏」去读，会去找「蓝过量最低的那层」当元凶，而那恰恰是**最暖的**那层
            #    （`mw-sun-mark` −80.5、`mw-globulars` −40.0 都是暖色）——
            #    判据方向反了，就会把人派去删掉正解。这类错误比判据不响更坏（坑 65）。
            print('  ③b 逐对象「只显示」—— 单独留下某一层时，整幅画面的颜色是什么样？')
            print(f'      （参照：全开基线 蓝过量 {base_disk_nl["blueExcess"]:+.2f}、'
                  f'亮像素 {base_disk_nl["litPct"]}%，无标签口径）')
            print('-' * 78)
            print('  只显示的对象            亮像素%     R      G      B   蓝过量   与全开之差')
            for a in abl:
                d = a['blueExcess'] - base_disk_nl['blueExcess']
                mark = '  ★ 偏蓝' if d > 1.5 else ('  ★ 偏暖' if d < -1.5 else '')
                print(f'  {a["name"][:22]:<22} {a["litPct"]:>7} {a["R"]:>6} '
                      f'{a["G"]:>6} {a["B"]:>6} {a["blueExcess"]:>+7} {d:>+9}{mark}')

            # ★ 已知不变量（给这张表配一条会响的判据）：
            #   只显示**更少**的对象，不可能点亮**更多**像素。
            #   违反 ⇒ 截图抢在渲染之前（见 settle 的说明），整张表作废。
            bad = [a for a in abl if a['litPct'] > base_disk_nl['litPct'] + 0.5]
            if bad:
                print('-' * 78)
                print(f'  ❌ **这张表不可信**：{len(bad)} 行的亮像素比「全开」还多 ——')
                for a in bad[:5]:
                    print(f'       {a["name"]} 亮像素 {a["litPct"]}% > 全开 '
                          f'{base_disk_nl["litPct"]}%（只显示更少的东西却能点亮更多像素，不可能）')
                print('     原因通常是截图抢在重新渲染之前 —— 看帧时间：软件渲染一帧可能近 200 ms。')
            else:
                print(f'  ✓ 自证：所有被测行亮像素 ≤ 全开 {base_disk_nl["litPct"]}%，'
                      f'没有「只显示更少却更亮」的行。')

            # 偏蓝的一侧才是「蓝雾」的来源。**排序方向必须与问题一致**：
            # 问的是「谁在画那层蓝」，就看蓝过量的**最高**值，不是最低值。
            top = sorted(abl, key=lambda x: -x['blueExcess'])[:3]
            print('-' * 78)
            print('  单独看最偏蓝的三层（= 蓝雾的候选来源；注意全开时它们被暖色中和了）：')
            for a in top:
                print(f'    · {a["name"]}  蓝过量 {a["blueExcess"]:+.2f}  →  {a["shot"]}')

            # ⑤ 核区归属：**谁在画中心那团白斑**
            print('=' * 78)
            print('  ③c 核区归属 —— 单独显示某个对象时，中心那块（0–2% 半径）有多亮/多饱和')
            print('-' * 78)
            print('  只显示的对象                核区亮度   核区>250%   饱和半径(占 rmax)')
            print(f'  {"【基线】全开":<26} {crows_nl[0]["lum"]:>8} {crows_nl[0]["sat"]:>9} '
                  f'{str(satR_nl) + "%":>14}   ← ④c 无标签口径，与下面被测行同尺')
            for a in abl:
                if a['coreSat'] is None:
                    continue
                mark = '  ★ 中心最亮' if (a['coreSat'] or 0) > 80 else ''
                print(f'  {a["name"][:26]:<26} {str(a["coreLum"]):>8} {str(a["coreSat"]):>9} '
                      f'{str(a["satR"]) + "%":>14}{mark}')

        # ---- ⑥ 核区线性值：用「纯增益」读法直接量 -----------------------
        if LINEAR:
            agg = lambda v: float(np.mean(v))                    # noqa: E731
            print('=' * 78)
            print('  ⑥ 核区线性值（纯增益读出 + 关泛光分解）')
            print('-' * 78)
            print('  ⚠️ 为什么不沿用上一版（ACES 档压曝光再反演）：')
            print('     曝光 1.05→线性 1.35 ；0.3675→2.23 ；0.12862→4.12。')
            print('     同一个不动的画面换曝光差 **3 倍** ⇒ 曝光不是纯末端增益，模型缺了一环。')
            print('     ⇒ 改成 `LinearToneMapping` + `outputColorSpace=srgb-linear`：')
            print('       码值 = 255·min(1, 线性×曝光)，反演就是一次除法，没有曲线可以出错。')

            ps = await page.evaluate(PIPE_STATE_JS)
            print('-' * 78)
            print(f'  管线实况：toneMapping={ps["tm"]} 曝光={ps["exp"]} '
                  f'outputColorSpace={ps["cs"]}')
            print(f'            合成器 RT 色彩空间={ps["rtCS"]} 类型={ps["rtType"]}'
                  f'{"" if ps["rtCS"] == "srgb-linear" else "  ← ⚠ 不是 linear，线性累积没生效！"}')
            print(f'            通道={ps["passes"]}')
            print(f'            泛光={ps["bloomOn"]} 阈值={ps["bloomTh"]}')
            print(f'            档位={ps["tier"]}{"(钉住)" if ps["pinned"] else ""} 像素比={ps["pr"]}')

            st0 = await page.evaluate(LINEAR_MODE_JS, True)
            await settle(page, frames=3, min_ms=650)  # defines 变了要重编译着色器：光等帧数不够
            print(f'  → 线性读出模式：toneMapping={st0["tm"]} '
                  f'outputColorSpace={st0["cs"]}')

            def lin_of(c, ex):
                """纯增益下的反演：线性 = (码值/255) / 曝光。**没有曲线，不可能算错。**"""
                return [(float(v) / 255.0) / ex for v in c['RGB']]

            # 噪声地板：核球每帧改自己的 opacity（`0.86 + sin(t·0.0008)·0.05`）。
            e = E0
            await page.evaluate(SET_EXPOSURE_JS, e)
            await settle(page, frames=3)
            na = os.path.join(SHOTS, 'lin-noise-a.png')
            await shoot(page, na)
            await settle(page, frames=3)
            nb = os.path.join(SHOTS, 'lin-noise-b.png')
            await shoot(page, nb)
            ca = core_stats(np.asarray(Image.open(na).convert('RGB')), np, center, rmax)
            cb = core_stats(np.asarray(Image.open(nb).convert('RGB')), np, center, rmax)
            noise_rel = abs(agg(lin_of(ca, e)) - agg(lin_of(cb, e))) / max(agg(lin_of(ca, e)), 1e-9)
            print(f'  噪声地板（同曝光连拍两张的线性相对差）＝ {noise_rel * 100:.2f}%')

            # 阶梯降曝光，直到核区不再有满值像素。
            steps, cs = [], None
            for _ in range(9):
                await page.evaluate(SET_EXPOSURE_JS, e)
                await settle(page, frames=3)
                fn = os.path.join(SHOTS, f'lin-exp-{e:.5f}.png')
                await shoot(page, fn)
                cs = core_stats(np.asarray(Image.open(fn).convert('RGB')), np, center, rmax)
                steps.append((e, cs))
                print(f'  曝光 {e:>9.5f} · 核区码值均值 {cs["lum"]:>6} · 峰值 {cs["max"]:>5}'
                      f' · 满值像素 {cs["clip"]:>7.3f}%')
                if cs['clip'] <= 0.05:
                    break
                e *= 0.35

            # ★★ 这条才是真正的尺子检验：同一个不动的画面，换个曝光必须给出**同一个线性值**。
            #    纯增益读法下这条如果不成立，说明「线性累积」这件事本身没做到。
            print('  ★ 尺子检验：不同曝光读出的线性值必须一致（对不上 ⇒ 管线不是线性的）')
            valid = []
            for (ek, ck) in steps:
                lk = lin_of(ck, ek)
                tag = '  ← 有满值像素，仅参照' if ck['clip'] > 0.05 else ''
                if ck['clip'] <= 0.05:
                    valid.append(agg(lk))
                print(f'    曝光 {ek:>9.5f} → 线性均值 {agg(lk):>9.4f}'
                      f'（码值 {ck["lum"]}）{tag}')
            if len(valid) >= 2:
                spread = (max(valid) - min(valid)) / max(agg(valid), 1e-9)
                print(f'    → 未削平的 {len(valid)} 档之间最大相对差 {spread * 100:.1f}%'
                      f'{"  ✅ 管线是线性的" if spread < 0.10 else "  ❌ 对不上，下面的数不能用"}')
            elif valid:
                print('    ⚠ 只有一档可用 ⇒ 无法自证。')
            else:
                print('    ❌ 全部削平 ⇒ 这次测量作废。')

            L_full = valid[-1] if valid else agg(lin_of(cs, e))

            def lin_for_code(code, exp=E0):
                """ACES 档下「码值 → 线性」的换算。**用管线自己的曲线算，不是拍的数。**"""
                lo, hi = 1e-4, 300.0
                for _ in range(70):
                    mid = (lo * hi) ** 0.5
                    g = float(aces_forward(np.array([mid, mid, mid], 'float32'), exp, np).mean()) * 255
                    if g < code:
                        lo = mid
                    else:
                        hi = mid
                return (lo * hi) ** 0.5

            L180, L205 = lin_for_code(180.0), lin_for_code(205.0)
            print('-' * 78)
            print(f'  核区线性均值 ≈ {L_full:.4f}   （用**同一曝光下的均值**，不靠单点峰值）')
            print(f'  用户实际看到的 ACES 档下：线性 {L_full:.3f} → 码值 '
                  f'{float(aces_forward(np.array([L_full] * 3, "float32"), 1.05, np).mean()) * 255:.1f}'
                  f'（与 ④b 的核区亮度互相印证）')
            print(f'  目标（由 ACES 曲线反推，不是拍的）：码值 180 ⇒ 线性 {L180:.4f} ；'
                  f'码值 205 ⇒ 线性 {L205:.4f}')
            if L_full > 0:
                print(f'  ⇒ 核区线性要降 **{L_full / L180:.2f} 倍**（到均值码值 180）'
                      f' ／ {L_full / L205:.2f} 倍（到 205）')

            # ---- 分解：**必须先关泛光** -----------------------------------
            # `UnrealBloomPass` 的高通是 `smoothstep(阈值, 阈值+宽度, 亮度)` —— 带阈值
            # ⇒ 逐对象算泛光再相加 ≠ 一起算。实测残差 68.7%，泛光开着这张表**不可加**。
            bl = await page.evaluate(BLOOM_JS, False)
            await settle(page, frames=3)
            await page.evaluate(SHOWALL_JS)
            await settle(page, frames=3)
            f0 = os.path.join(SHOTS, 'lin-nobloom-all.png')
            await shoot(page, f0)
            c0 = core_stats(np.asarray(Image.open(f0).convert('RGB')), np, center, rmax)
            L_nb = agg(lin_of(c0, e))
            print(f'  泛光已关={bl is False} · 全开无泛光的核区线性均值 {L_nb:.4f}'
                  f'（关泛光前 {L_full:.4f} ⇒ 泛光贡献 {L_full - L_nb:+.4f}）')

            inv2 = await page.evaluate(INVENTORY_JS)
            byname = {o['name']: o for o in inv2}
            # ⚠️⚠️ 这张 `watch` 清单**必须覆盖所有「在核区有贡献」的层**，否则残差不是噪声、
            #   而是**漏掉的那个层**（2026-09-11 第 23 轮实测）。
            #   原来只列 5 个（bulge / points-disk / points-bar / disk-glow / core-sprite），
            #   而场景里有 15 个顶层对象 ⇒ 残差稳定在 12–13%，我还一度以为它是「不可加性」。
            #   线索来自 **③c**：`mw-hyg-stars`（109,400 颗真实恒星）在核区**码值 66.2**，
            #   而它**不在 watch 里** —— 那个 66 就是残差。
            #   ⚠️ `mw-guide-lines` **不能进这个清单**：`ISOLATE_JS` 会把目标层设成可见，
            #   而它出厂是隐藏的（坑 114）—— 孤立它会把它**打开**，量到的就不是原有画面。
            watch = ['mw-bulge', 'mw-points-disk', 'mw-points-bar', 'mw-disk-glow',
                     'mw-hyg-stars', 'mw-globulars', 'mw-sun-mark', 'mw-deep-sky',
                     'mw-far-galaxies', 'mw-starfield', 'mw-points-arm',
                     'mw-core-sprite', 'mw-rings']
            print('-' * 78)
            print('  关泛光后逐层分解 —— 「降谁、降多少」看这里')
            print('  只显示的层                  核区码值  线性均值   占全开    满值%      需降')
            parts = []
            for nm in watch:
                o = byname.get(nm)
                if not o:
                    print(f'  {nm:<26}（场景里没有这个名字，跳过）')
                    continue
                await page.evaluate(ISOLATE_JS, o['i'])
                await settle(page, frames=3)
                f2 = os.path.join(SHOTS, f'lin-iso-{nm}.png')
                await shoot(page, f2)
                c2 = core_stats(np.asarray(Image.open(f2).convert('RGB')), np, center, rmax)
                lv = agg(lin_of(c2, e))
                clipped2 = c2['clip'] > 0.05
                need = (lv / L180) if lv > L180 else 1.0
                parts.append({'name': nm, 'lin': lv, 'clip': clipped2})
                share = f'{lv / max(L_nb, 1e-9) * 100:.0f}%' if not clipped2 else '—'
                need_s = '下界' if clipped2 else f'{need:.2f}×'
                print(f'  {nm:<26} {c2["lum"]:>8} {lv:>9.4f} {share:>8} '
                      f'{c2["clip"]:>7.3f} {need_s:>8}')
            await page.evaluate(SHOWALL_JS)
            await settle(page, frames=3, min_ms=200)

            ssum = sum(p['lin'] for p in parts)
            print('-' * 78)
            print(f'  自证：各层线性均值之和 {ssum:.4f}  vs  全开无泛光实测 {L_nb:.4f}'
                  f'  → 残差 {abs(ssum - L_nb) / max(L_nb, 1e-6) * 100:.1f}%'
                  f'（≈0 才说明这套分解可信）')
            big = sorted(parts, key=lambda p: -p['lin'])[:2]
            if big and ssum > 0:
                print('  药该打在：' + '、'.join(
                    f'{p["name"]}（线性 {p["lin"]:.4f}，占 {p["lin"] / ssum * 100:.0f}%）'
                    for p in big))
                b0 = big[0]
                if b0['lin'] > 0:
                    # ⚠️ 这里原来写的是
                    #      k = b0['lin'] / max(b0['lin'] - (L_nb - L180), 1e-9)
                    #    核球线性 6.9688、L_nb - L180 = 11.07 ⇒ **分母是负的**，
                    #    被 max(..., 1e-9) 一兜，屏幕上就出现了「需降 6968773904.12 倍」
                    #    和「R_e 要变成 272275.70 kly」两个荒唐数字（第 23 轮实测）。
                    #    更坏的是：**分母为负本身才是结论** ——
                    #    它意味着「只动这一层根本不够」，代码却把这个事实伪装成了一个数字。
                    #    ⇒ 先判能不能单独解决，再谈倍数。
                    rest = L_nb - b0['lin']
                    if rest > L180:
                        print(f'     · ⚠ **只动 {b0["name"]} 不够**：把它**整层删光**，'
                              f'剩下 {rest:.4f} 仍是目标 {L180:.4f} 的 '
                              f'{rest / L180:.1f} 倍。')
                        print('       ⇒ 药要同时打在最大的两层上（或直接动总量/曝光），'
                              '单点调整只会把白斑变小一点、不会消失。')
                    else:
                        k = 1.0 / max(1.0 - (L_nb - L180) / b0['lin'], 1e-9)
                        print(f'     · 若只动 {b0["name"]}：需把它降 {k:.2f} 倍'
                              f'（{b0["lin"]:.4f} → {b0["lin"] / k:.4f}）。'
                              f'若改用「摊开」的办法（峰值 ∝ 流量/R_e²）：'
                              f'R_e 要从 3.26 kly 变成 {3.2616 * k ** 0.5:.2f} kly')
                        print('       ⚠ 那个 R_e 要拿去对文献：银河核球的有效半径不是想改就改的。'
                              '超了 ⇒ 该降的是**流量份额或不透明度**，不是宽度。')

            await page.evaluate(BLOOM_JS, True)
            await page.evaluate(LINEAR_MODE_JS, False)
            await page.evaluate(SET_EXPOSURE_JS, E0)
            await settle(page, frames=3, min_ms=200)
            back = await page.evaluate(PIPE_STATE_JS)
            print(f'  （已复位：toneMapping={back["tm"]} outputColorSpace={back["cs"]} '
                  f'曝光={back["exp"]} 泛光={back["bloomOn"]}）')

        # 收尾：把 ④c 关掉的标签放回来。**只在这里放一次** ——
        # 散着放、漏一处，后半段测量就全被标签污染，而画面看起来完全正常。
        await page.evaluate(HIDE_LABELS_JS, False)

        print('=' * 78)
        # ⚠️ 结论必须在关浏览器**之前**落盘。
        #    上一次跑就在 `browser.close()` 上挂住了，而 `print` 到重定向文件是**带缓冲**的
        #    ⇒ 全部结论（含 ③b 的消融表）随进程一起丢掉，磁盘上只剩前面 `emit()` 刷过的部分。
        #    这不是「跑得慢」，是**输出丢了**。所以：先 flush，再带超时关浏览器。
        sys.stdout.flush()

        # ★ 收尾三步，顺序不能换（第 23 轮，七次泄漏换来的）：
        #   ① 停服务（有界）② 武装硬退看门狗 ③ 才去碰浏览器。
        #   ②必须在③之前 —— 下面是**唯一**会让本进程卡死的一句话，
        #   而 `wait_for` 的超时对它**无效**（理由写在 arm_hard_exit 的注释里）。
        srv.stop()
        arm_hard_exit(15)
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except BaseException as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘，由看门狗收尾）：'
                 f'{type(e).__name__}')
        return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「方块」溯源探针 —— 那个方斑到底是**贴图**、**泛光**、还是**点精灵自己**画的？

## 为什么要单独写它（而不是去改 `probe-galaxy-visual.py`）

第 23 轮把「中央过曝」判成**形状问题**，理由是：`makeGlowTexture` 画的圆盘在
缩小时会被 mipmap 平均成一个方形 texel，于是每个点渲染成小方片、三万块叠成方斑。
修法是 `tex.generateMipmaps = false; tex.minFilter = LinearFilter`。

修完重跑，核球的外轮廓**还是**读成「方」（外接框 316×315、面积占比 **0.899**，
圆的期望是 0.785）。更要命的是**同一个方斑在别的层也出现了**：

    ablate-13-mw-hyg-stars.png   109,400 颗真实恒星   外接框 **647×647**  面积占比 0.889
    ablate-13-(无名).png         同一对象，20:56 那次  外接框 **534×534**  面积占比 0.885

10 万颗 `size: 0.055` 的**亚像素**点、铺开半径只有 3.26 kly，投影出来该是一片**麻点**，
不可能是一块亮度均匀、边界笔直的方板。**⇒ 那块方板不是这些点画出来的。**

所以这一轮不再猜，把三种可能的来源**分别关掉来定位**：

    来源 A：**贴图**——`makeGlowTexture` 出来的图本身就是方的（或在采样时退化成方）
    来源 B：**泛光**——`UnrealBloomPass` 对「又小又饱和」的源做多级降采样再放大，
            低分辨率那几级的双线性放大**会**产生轴对齐的方块状结构（已知现象）
    来源 C：**点精灵的方块几何**——每个点就是一个屏幕空间的正方形 quad

## 怎么区分（每条都是"关掉它看还在不在"）

  · **A** → 把一个 **Sprite** 放大到 300+ px（精灵只有一个实例，**不累积**）
            ⇒ 直接看到 `makeGlowTexture` 放大的真形状。是圆就是圆，是方就是方。
  · **B** → 同一次场景，`engine.options.bloom = false` 前后各截一张。
  · **C** → 把核球的 `size` 放大（0.55→8）同时把 `opacity` 压到 0.01，
            单个点足够大又足够淡，**它的形状直接看得见**。

## 另外一件必须做的事：**证明我的改动真的进了浏览器**

`web/` 和 `dist/` 两棵树都在，源码改了不等于页面加载的那份改了。
⇒ 第一件事就是把**活页面里**每个 `Points` 的
`material.map.generateMipmaps / minFilter / image.width` 读出来。

用法：
    py -3.13 -X utf8 tools/probe-square-origin.py [--headed=false]
产出：`shots/sq-*.png` + `shots/_square-origin.log`（由外层重定向）
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

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(line_buffering=True)
    except Exception:
        pass


def arm_hard_exit(seconds, code=0):
    """`seconds` 秒后无条件退出。顺序见 `probe-galaxy-visual.py::arm_hard_exit`。"""
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t


HEADED = False
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')

# ---------------------------------------------------------------------------
# 活页面里把每个顶层对象的材质/贴图实况读出来
# ---------------------------------------------------------------------------
STATE_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const FILT = {1003:'Nearest',1004:'NearMipNear',1005:'NearMipLin',
                1006:'Linear',1007:'LinMipNear',1008:'LinMipLin'};
  const rows = [];
  for (const o of (lv.scene.children || [])) {
    const m = o.material;
    if (!m) { rows.push({ name: o.name || '(无名)', type: o.type, mat: null }); continue; }
    const t = m.map || null;
    rows.push({
      mat: true,
      name: o.name || '(无名)',
      type: o.type,
      count: o.geometry && o.geometry.getAttribute
             ? (o.geometry.getAttribute('position') || {}).count ?? null : null,
      size: (m.size === undefined ? null : m.size),
      alphaTest: (m.alphaTest === undefined ? null : m.alphaTest),
      blending: m.blending,
      opacity: (m.opacity === undefined ? null : m.opacity),
      hasMap: !!t,
      mapWH: (t && t.image) ? (t.image.width + 'x' + t.image.height) : null,
      genMips: t ? t.generateMipmaps : null,
      minFilter: t ? (FILT[t.minFilter] || t.minFilter) : null,
      visible: o.visible,
    });
  }
  /* Group 的子对象也读一遍（去重）：方形如果有主，多半藏在某一层的贴图上，
     而 `mw-globulars` / `mw-far-galaxies` / `mw-deep-sky` 都是 Group。 */
  const seen = new Set();
  const kids = [];
  for (const o of (lv.scene.children || [])) {
    if (!o.children || !o.children.length) continue;
    for (const c of o.children) {
      const m = c.material;
      if (!m) continue;
      const t = m.map || null;
      const key = [o.name, c.type, m.type, m.size, m.alphaTest, m.opacity,
                   m.blending, t ? t.image && t.image.width : null,
                   t ? t.generateMipmaps : null, t ? t.minFilter : null].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      kids.push({
        parent: o.name, type: c.type, matType: m.type,
        size: (m.size === undefined ? null : m.size),
        alphaTest: (m.alphaTest === undefined ? null : m.alphaTest),
        blending: m.blending, opacity: (m.opacity === undefined ? null : m.opacity),
        mapWH: (t && t.image) ? (t.image.width + 'x' + t.image.height) : null,
        genMips: t ? t.generateMipmaps : null,
        minFilter: t ? (FILT[t.minFilter] || t.minFilter) : null,
      });
    }
  }
  return { top: rows, kids: kids };
}
"""

# ---------------------------------------------------------------------------
# 隔离某一层 / 全开（按原样恢复）
# ---------------------------------------------------------------------------
ISOLATE_JS = r"""
(i) => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  if (!window.__origVis) window.__origVis = kids.map((o) => o.visible);
  for (let k = 0; k < kids.length; k++) kids[k].visible = (k === i);
  lv.labels?.setVisible?.(false);
  return kids.length;
}
"""

FIND_JS = r"""
(name) => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  for (let k = 0; k < kids.length; k++) if (kids[k].name === name) return k;
  return -1;
}
"""

SHOWALL_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  const orig = window.__origVis;
  for (let k = 0; k < kids.length; k++) kids[k].visible = orig ? !!orig[k] : true;
  lv.labels?.setVisible?.(false);
  return kids.length;
}
"""

# 泛光开关。注意：渲染循环每帧都会从 `options.bloom` 重写 `bloomPass.enabled`
# （engine.js:802），所以**两处都要改**，只改 pass 会被下一帧覆盖回去。
BLOOM_JS = r"""
(on) => {
  const e = window.__universe.engine;
  e.options.bloom = !!on;
  if (e.bloomPass) e.bloomPass.enabled = !!on;
  return { options: e.options.bloom, pass: !!(e.bloomPass && e.bloomPass.enabled) };
}
"""

# 把某一层的点放大 + 压淡，让**单个点的形状**露出来。
# 比例是「放大 N 倍 ⇒ 不透明度压 1/N² 附近」：面积涨了 N²，压下去之后
# 单点的峰值亮度不变，叠起来的总量也不至于把画面冲顶。
MAGNIFY_JS = r"""
([name, size, opacity]) => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((k) => k.name === name);
  if (!o || !o.material) return null;
  if (window.__magSaved === undefined) {
    window.__magSaved = { size: o.material.size, opacity: o.material.opacity,
                          needsUpdate: false };
  }
  o.material.size = size;
  o.material.opacity = opacity;
  o.material.needsUpdate = true;
  return { name: o.name, size: o.material.size, opacity: o.material.opacity };
}
"""

RESTORE_JS = r"""
(name) => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((k) => k.name === name);
  if (!o || !o.material) return null;
  if (o.material.isSpriteMaterial) return { skipped: 'sprite' };
  if (o.geometry && o.geometry.boundingSphere) o.geometry.boundingSphere = null;
  return { name: o.name };
}
"""

# 把 Sprite 放大：精灵只有一份，**不累积** —— 这是看贴图真形状最干净的途径。
SPRITE_SCALE_JS = r"""
([name, s]) => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((k) => k.name === name);
  if (!o) return null;
  if (window.__sprSaved === undefined) window.__sprSaved = {};
  if (!(name in window.__sprSaved)) {
    window.__sprSaved[name] = [o.scale.x, o.scale.y, o.scale.z];
  }
  o.scale.set(s, s, 1);
  return { name: o.name, scale: [o.scale.x, o.scale.y, o.scale.z],
           isSprite: !!o.isSprite,
           matScale: (o.material && o.material.scale)
             ? [o.material.scale.x, o.material.scale.y] : null };
}
"""

RESTORE_SPRITE_JS = r"""
(name) => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((k) => k.name === name);
  if (!o || !window.__sprSaved || !(name in window.__sprSaved)) return null;
  const s = window.__sprSaved[name];
  o.scale.set(s[0], s[1], s[2]);
  return { name: o.name, scale: [o.scale.x, o.scale.y, o.scale.z] };
}
"""

# 把某层的贴图摘掉（`map = null`）⇒ 剩下的就是**点精灵的裸几何**：
# 如果摘掉之后方斑大小/形状基本不变，那说明「方」本来就不是贴图画出来的。
UNMAP_JS = r"""
(name) => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((k) => k.name === name);
  if (!o || !o.material) return null;
  if (window.__mapSaved === undefined) window.__mapSaved = o.material.map;
  o.material.map = null;
  o.material.needsUpdate = true;
  return { name: o.name, hasMap: !!o.material.map };
}
"""

REMAP_JS = r"""
(name) => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((k) => k.name === name);
  if (!o || !o.material) return null;
  o.material.map = window.__mapSaved || null;
  o.material.needsUpdate = true;
  return { name: o.name, hasMap: !!o.material.map };
}
"""

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

AUDIT_HUD_JS = """
() => {
  const KEEP = new Set(['scene', 'labels']);
  const bad = [];
  for (const el of document.body.children) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
    if (KEEP.has(el.id)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 8 && r.height > 8) bad.push((el.id || el.className || tag) + '');
  }
  return bad;
}
"""

SHOW_HUD_JS = """
() => {
  if (!window.__hudSaved) return 0;
  for (const [el, d] of window.__hudSaved) el.style.display = d;
  window.__hudSaved = null;
  return 1;
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
    if min_ms:
        await page.wait_for_timeout(min_ms)
    try:
        await page.evaluate(SETTLE_JS, frames)
    except Exception:
        pass


async def shoot(page, path):
    await page.evaluate(HIDE_HUD_JS)
    await settle(page, frames=3, min_ms=260)
    left = await page.evaluate(AUDIT_HUD_JS)
    if left:
        emit(f'    ⚠ 还有界面元素在占像素：{", ".join(left[:5])}')
    await page.screenshot(path=path)
    await page.evaluate(SHOW_HUD_JS)
    return path


async def main():
    # ⚠️ `srv` 必须是**全局**：`run()` 收尾那句 `srv.stop()`（坑 122）
    global srv
    srv = ServedCheck(tag='方块溯源探针')
    base = srv.start()
    try:
        return await run(base)
    finally:
        srv.stop()


async def run(base):
    os.makedirs(SHOTS, exist_ok=True)

    async with async_playwright() as pw:
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
        await page.wait_for_timeout(2200)

        st = await page.evaluate("""() => {
          const e = window.__universe.engine;
          if (e.gpu) e.gpu.tierPinned = true;
          if (e.applyTier) e.applyTier('high');
          return { tier: e.tierId, bloom: e.options.bloom,
                   pointBudget: e.tier ? e.tier.pointBudget : null };
        }""")
        emit(f'  画质档已钉住（进 galaxy 之前）：{st}')

        await page.evaluate("window.__universe.gotoScale('galaxy')")
        await page.wait_for_function(
            "window.__universe.engine.current?.id === 'galaxy'", timeout=40000)
        await page.wait_for_timeout(1800)
        emit(f'  后端 {backend}')

        # ================= 第 0 步：证明改动真的进了浏览器 =================
        print('\n' + '=' * 78)
        print('  ⓪ 活页面里的贴图实况 —— **先证明我改的那一行真的生效了**')
        print('-' * 78)
        st0 = await page.evaluate(STATE_JS)
        rows = st0['top']
        print('  对象                   类型              点数      size  alphaT  混 不透明 贴图     mip   minFilter')
        for r in rows:
            if not r['mat']:
                print(f'  {r["name"]:<20} {r["type"]:<16} {"-":>8}   （无材质）')
                continue
            cnt = '-' if r['count'] is None else str(r['count'])
            sz = '-' if r['size'] is None else f'{r["size"]:.3f}'
            at = '-' if r['alphaTest'] is None else f'{r["alphaTest"]:.2f}'
            op = '-' if r['opacity'] is None else f'{r["opacity"]:.2f}'
            print(f'  {r["name"]:<20} {r["type"]:<16} {cnt:>8}  {sz:>6} {at:>6} '
                  f'{r["blending"]:>3} {op:>6}  {(r["mapWH"] or "-"):>7}  '
                  f'{"T" if r["genMips"] else ("F" if r["genMips"] is not None else "-"):>3}  '
                  f'{r["minFilter"] or "-"}')
        print('  ⇒ 判据：凡是 `map` 是 `makeGlowTexture` 出来的层，**mip 必须全为 F、'
              'minFilter 必须为 Linear**。')
        print('    只要有一行是 T / LinMipLin ⇒ **我改的那份源码没进页面**（web/ 与 dist/ 两棵树）。')
        if st0['kids']:
            print('-' * 78)
            print('  Group 的子对象（去重后）—— 方形如果有主，多半藏在某一层的贴图上：')
            print('  父层                 子类型        材质             size  alphaT  混 不透明 贴图      mip  minFilter')
            for k in st0['kids']:
                sz = '-' if k['size'] is None else f'{k["size"]:.3f}'
                at = '-' if k['alphaTest'] is None else f'{k["alphaTest"]:.2f}'
                op = '-' if k['opacity'] is None else f'{k["opacity"]:.2f}'
                print(f'  {k["parent"]:<20} {k["type"]:<12} {k["matType"]:<16} {sz:>6} '
                      f'{at:>6} {k["blending"]:>3} {op:>6} {(k["mapWH"] or "-"):>8}  '
                      f'{"T" if k["genMips"] else ("F" if k["genMips"] is not None else "-"):>3}  '
                      f'{k["minFilter"] or "-"}')

        # ================= 第 1 步：贴图本身是圆还是方 =================
        print('=' * 78)
        print('  ① 贴图真形状 —— 把一个 **Sprite** 放大到 ~350 px（单实例，不累积）')
        print('-' * 78)
        idx = await page.evaluate(FIND_JS, 'mw-sun-mark')
        if idx >= 0:
            await page.evaluate(ISOLATE_JS, idx)
            sc = await page.evaluate(SPRITE_SCALE_JS, ['mw-sun-mark', 52.0])
            emit(f'  mw-sun-mark 放大：{sc}')
            await shoot(page, os.path.join(SHOTS, 'sq-1-sprite-bloomon.png'))
            print('  → shots/sq-1-sprite-bloomon.png  （泛光开）')
            b = await page.evaluate(BLOOM_JS, False)
            emit(f'  泛光已关：{b}')
            await shoot(page, os.path.join(SHOTS, 'sq-2-sprite-bloomoff.png'))
            print('  → shots/sq-2-sprite-bloomoff.png （泛光关）**这张的形状就是贴图的真形状**')
            await page.evaluate(BLOOM_JS, True)
            await page.evaluate(RESTORE_SPRITE_JS, 'mw-sun-mark')
        else:
            print('  ✗ 没找到 mw-sun-mark，跳过')

        # ================= 第 2 步：核球的单个点长什么样 =================
        print('=' * 78)
        print('  ② 核球单点形状 —— size 0.55→8、opacity 0.45→0.01（放大又压淡）')
        print('-' * 78)
        bidx = await page.evaluate(FIND_JS, 'mw-bulge')
        await page.evaluate(ISOLATE_JS, bidx)
        await page.evaluate(BLOOM_JS, False)
        mg = await page.evaluate(MAGNIFY_JS, ['mw-bulge', 8.0, 0.01])
        emit(f'  已放大：{mg}')
        await shoot(page, os.path.join(SHOTS, 'sq-3-bulge-magnified.png'))
        print('  → shots/sq-3-bulge-magnified.png  （泛光关、单点 ~48 px）')
        print('     ★ 判据：单个点若是**圆斑** ⇒ 贴图没问题，方块另有出处；')
        print('       若是**圆角方块** ⇒ 贴图/采样就是方的，`makeGlowTexture` 还没修干净。')

        # ================= 第 3 步：泛光对那块方晕负不负责 =================
        print('=' * 78)
        print('  ③ 泛光前后 —— 同场景、同尺寸，只切 `options.bloom`')
        print('-' * 78)
        await page.evaluate(MAGNIFY_JS, ['mw-bulge', 0.55, 0.45])   # 还原成默认大小
        await shoot(page, os.path.join(SHOTS, 'sq-4-bulge-bloomoff.png'))
        print('  → shots/sq-4-bulge-bloomoff.png （泛光关）')
        b = await page.evaluate(BLOOM_JS, True)
        emit(f'  泛光已开：{b}')
        await shoot(page, os.path.join(SHOTS, 'sq-5-bulge-bloomon.png'))
        print('  → shots/sq-5-bulge-bloomon.png  （泛光开）')
        print('     ★ 两张做差分：**方晕如果只出现在泛光开的那张 ⇒ 是 `UnrealBloomPass` 画的**。')
        await page.evaluate(BLOOM_JS, False)

        # ================= 第 4 步：摘贴图，看裸几何 =================
        print('=' * 78)
        print('  ④ 摘掉贴图（map=null）—— 剩下的就是点精灵的裸几何')
        print('-' * 78)
        um = await page.evaluate(UNMAP_JS, 'mw-bulge')
        emit(f'  map 已摘：{um}')
        await shoot(page, os.path.join(SHOTS, 'sq-6-bulge-nomap.png'))
        print('  → shots/sq-6-bulge-nomap.png')
        print('     ★ 判据：若它和 sq-4 长得**差不多** ⇒ 方斑来自**点精灵几何**，与贴图无关。')
        await page.evaluate(REMAP_JS, 'mw-bulge')

        # ================= 第 5 步：10 万颗星到底是麻点还是板 =================
        print('=' * 78)
        print('  ⑤ mw-hyg-stars（109,400 颗亚像素星）单独看 —— 麻点还是方板？')
        print('-' * 78)
        hidx = await page.evaluate(FIND_JS, 'mw-hyg-stars')
        await page.evaluate(ISOLATE_JS, hidx)
        await page.evaluate(BLOOM_JS, False)
        mg2 = await page.evaluate(MAGNIFY_JS, ['mw-hyg-stars', 0.055, 0.95])
        emit(f'  hyg-stars 尺寸复位：{mg2}')
        await shoot(page, os.path.join(SHOTS, 'sq-7-hyg-bloomoff.png'))
        print('  → shots/sq-7-hyg-bloomoff.png （泛光关）')
        b = await page.evaluate(BLOOM_JS, True)
        emit(f'  泛光已开：{b}')
        await shoot(page, os.path.join(SHOTS, 'sq-8-hyg-bloomon.png'))
        print('  → shots/sq-8-hyg-bloomon.png  （泛光开）')
        print('     ★ 判据：泛光关那张若还是**一块均匀方板** ⇒ 绝对不是这 10 万颗星画的；')
        print('       若是**稀疏麻点** ⇒ 方板是泛光在这片密集小点上烧出来的。')

        # ================= 收尾 =================
        print('=' * 78)
        await page.evaluate(BLOOM_JS, True)
        await page.evaluate(SHOWALL_JS)
        await page.evaluate("""() => {
          const lv = window.__universe.engine.current;
          for (const o of (lv.scene.children || [])) {
            if (o.name === 'mw-bulge' && o.material) {
              o.material.size = 0.55; o.material.opacity = 0.45;
              o.material.needsUpdate = true;
            }
          }
          return 1;
        }""")
        print('  已复位（泛光开 / 全部可见 / 核球 size 0.55 opacity 0.45）')
        print('=' * 78)

        sys.stdout.flush()
        srv.stop()
        arm_hard_exit(14, 0)
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except Exception as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘，由看门狗收尾）：{type(e).__name__}')
    return 0


if __name__ == '__main__':
    arm_hard_exit(600, 3)
    sys.exit(asyncio.run(main()))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""泛光参数扫描 + mipmap A/B —— 给「方斑」找出**可复算**的旋钮取值。

## 上一轮（`probe-square-origin.py`）已经**证明**的事

    泛光关 → 圆；泛光开 → 方。四组对照全对上：
      核球  关 100×66  占比 0.648 对角比 0.917 圆   ／ 开 317×316 占比 0.899 对角比 1.140 方
      hyg   关  48×47  占比 0.627 对角比 0.808 圆   ／ 开 643×650 占比 0.887 对角比 1.146 方
      贴图真形状（单精灵放大 52×，泛光关）275×275 占比 0.796 对角比 1.000 ⇒ **正圆**
      核球**摘掉贴图**（泛光关）102×67 占比 0.692 对角比 0.916 ⇒ **仍是圆**
    ⇒ **方斑是 `UnrealBloomPass` 画的**；贴图、点精灵几何、mipmap 都不是它的来源。

## 为什么 `radius = 0.6` 会画出一个几百像素的方框（读 vendor 源码推出来的）

`UnrealBloomPass` 合成阶段（`web/vendor/three/addons/postprocessing/UnrealBloomPass.js`）：

    bloomFactors = [1.0, 0.8, 0.6, 0.4, 0.2]        // 五级 mip 的基准权重
    float lerpBloomFactor(float factor) {
      float mirrorFactor = 1.2 - factor;            // 把权重「镜像」
      return mix(factor, mirrorFactor, bloomRadius); // bloomRadius ← this.radius
    }

⇒ 实际权重 `w(f) = f + r·(1.2 − 2f) = f·(1 − 2r) + 1.2r`。代入各档：

    r = 0.6（当前）：w = [0.52, 0.56, 0.60, 0.64, **0.68**]   ← **最粗的 mip4 权重最大**
    r = 0.5        ：w = [0.60, 0.60, 0.60, 0.60,  0.60]      ← 五级等权
    r = 0.3        ：w = [0.76, 0.68, 0.60, 0.52,  0.44]      ← 最细占主导
    r = 0.0        ：w = [1.00, 0.80, 0.60, 0.40,  0.20]      ← 教科书原味

`nMips = 5`，每一级分辨率减半 ⇒ **mip4 的 texel = 画面宽 / 32**（1372 px ⇒ **43 px**）。
一个又小又饱和的源在 mip4 上只有一两个 texel，双线性放大 32 倍就是**一摞 43 px 的方砖**
—— 这正是「核球外面罩着一个 317 px 的方框」的来历。
⇒ 结论：**`radius` 是「方斑 」这个症状的旋钮，而且临界点可以算出来：`r < 0.5`。**

## 本脚本做两件事

### 一、泛光 `radius` 扫描（在**孤立的核球**上量，判据干净）
    判据：`tools/check-bulge-shape.py` 的 **对角比 ≈1.00 / 面积占比 ≈0.785**。
    同时报「晕的外接框」，看泛光半径收缩了多少。
    ⚠️ 只改 `radius`，**`strength` / `threshold` 保持出厂**，一次只动一个变量。

### 二、mipmap A/B（**这次才真的测了上一轮没测的那件事**）
    上一轮我把「方斑」判成 mipmap 退化并关掉了 mipmap，但**从没做过它的 A/B**。
    现在补：**泛光关**、单个 Sprite 缩到 **~3 px**（就是盘面点云的尺寸档），
    贴图 `generateMipmaps` 开/关各截一张，再放大 16 倍看轮廓。
    ⇒ 若「开」那张读出方、「关」那张读出圆 ⇒ 上一轮那条规则**成立**；
      两张都是圆 ⇒ 那条规则**不成立**，该把 mipmap 还回去（关掉 mipmap 让
      远小于贴图的点**闪烁**，是实打实的代价）。

用法：
    py -3.13 -X utf8 tools/probe-bloom-sweep.py [--headed=false]
产出：`shots/bl-*.png`、`shots/mp-*.png`
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
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t


HEADED = False
for a in sys.argv[1:]:
    if a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')

# ---------------------------------------------------------------------------
# 页面内
# ---------------------------------------------------------------------------
SET_BLOOM_JS = r"""
([on, radius, strength, threshold]) => {
  const e = window.__universe.engine;
  e.options.bloom = !!on;
  if (e.bloomPass) e.bloomPass.enabled = !!on;
  if (radius !== null && radius !== undefined) e.bloomPass.radius = radius;
  if (strength !== null && strength !== undefined) e.bloomPass.strength = strength;
  if (threshold !== null && threshold !== undefined) e.bloomPass.threshold = threshold;
  /* ★ 回读的才是判据（「返回 200 不等于参数被接受」）。
     `bloomRadius` 这个 uniform 是在 `render()` 里每帧从 `this.radius` 覆写进去的，
     所以这里顺手把**合成权重**也算出来 —— 它就是「哪一级 mip 说话最响」的答案。 */
  const p = e.bloomPass;
  const F = [1.0, 0.8, 0.6, 0.4, 0.2];
  const r = p ? p.radius : null;
  const w = p ? F.map((f) => f * (1 - 2 * r) + 1.2 * r) : null;
  return {
    options: e.options.bloom,
    pass: !!(p && p.enabled),
    radius: r, strength: p ? p.strength : null, threshold: p ? p.threshold : null,
    uniformRadius: p ? p.compositeMaterial.uniforms['bloomRadius'].value : null,
    weights: w ? w.map((v) => Math.round(v * 1000) / 1000) : null,
    coarsestTexelPx: p ? Math.round(window.innerWidth / 32) : null,
  };
}
"""

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

FIND_JS = r"""
(name) => {
  const lv = window.__universe.engine.current;
  const kids = lv.scene.children || [];
  for (let k = 0; k < kids.length; k++) if (kids[k].name === name) return k;
  return -1;
}
"""

# 单个 Sprite 缩到很小（就是盘面点云的尺寸档），并切换它贴图的 mipmap。
# ★ 为什么用 Sprite 而不是点云：精灵**只有一份实例**，不累积 ——
#   三万个点叠在一起时，「单点的方/圆」根本读不出来。
SPRITE_MIP_JS = r"""
([name, scale, mips]) => {
  const lv = window.__universe.engine.current;
  const o = (lv.scene.children || []).find((k) => k.name === name);
  if (!o || !o.material) return { err: 'not found' };
  o.scale.set(scale, scale, 1);
  const t = o.material.map;
  if (!t) return { err: 'no map' };
  if (window.__mipSaved === undefined) {
    window.__mipSaved = { gen: t.generateMipmaps, min: t.minFilter };
  }
  t.generateMipmaps = !!mips;
  t.minFilter = mips ? 1008 : 1006;     // 1008 = LinearMipmapLinearFilter
  t.needsUpdate = true;                  // ← 不置这个，切换不会重新上传
  return {
    name: o.name, scale: [o.scale.x, o.scale.y, o.scale.z],
    genMips: t.generateMipmaps, minFilter: t.minFilter,
    mapWH: t.image ? (t.image.width + 'x' + t.image.height) : null,
  };
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
    await settle(page, frames=3, min_ms=240)
    await page.screenshot(path=path)
    await page.evaluate(SHOW_HUD_JS)
    return path


# radius 扫描档位。0.6 = 出厂现值（`engine.js:337` 的第三个参数）。
SWEEP = [0.6, 0.5, 0.35, 0.25, 0.15]


async def main():
    # ⚠️ `srv` 必须是**全局**：`run()` 收尾那句 `srv.stop()`（坑 122）
    global srv
    srv = ServedCheck(tag='泛光扫描探针')
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
        await page.evaluate("""() => {
          const e = window.__universe.engine;
          if (e.gpu) e.gpu.tierPinned = true;
          if (e.applyTier) e.applyTier('high');
          return 1;
        }""")
        await page.evaluate("window.__universe.gotoScale('galaxy')")
        await page.wait_for_function(
            "window.__universe.engine.current?.id === 'galaxy'", timeout=40000)
        await page.wait_for_timeout(1800)
        emit(f'  后端 {backend}')

        # ================= 一、radius 扫描 =================
        print('\n' + '=' * 78)
        print('  一、泛光 radius 扫描（孤立核球，判据 = 对角比≈1.00 / 面积占比≈0.785）')
        print('     w(f) = f·(1−2r) + 1.2r   —— 越大说明哪一级 mip 越"说话算数"')
        print('-' * 78)
        bidx = await page.evaluate(FIND_JS, 'mw-bulge')
        await page.evaluate(ISOLATE_JS, bidx)
        for r in SWEEP:
            st = await page.evaluate(SET_BLOOM_JS, [True, r, None, None])
            name = f'bl-r{int(round(r * 100)):03d}.png'
            await shoot(page, os.path.join(SHOTS, name))
            wl = st['weights']
            print(f'  radius={r:<5} 权重 {wl}  uniform回读={st["uniformRadius"]}  '
                  f'mip4 一格 = {st["coarsestTexelPx"]} px  → {name}')
        print('  ★ 待量：外接框从 317 px 收到多少、对角比几时回到 ≈1.00')

        # 顺带看一眼「只提阈值」这条路能不能也解决（源变小 ⇒ 粗 mip 上没有东西可放大）
        st = await page.evaluate(SET_BLOOM_JS, [True, 0.6, None, 0.9])
        await shoot(page, os.path.join(SHOTS, 'bl-thr090.png'))
        print(f'  radius=0.6 + threshold=0.9 → bl-thr090.png   '
              f'（回读 threshold={st["threshold"]}）')

        # ================= 二、mipmap A/B =================
        print('=' * 78)
        print('  二、mipmap A/B —— 上一轮漏做的那次测量（泛光关，单个 Sprite 缩到 ~3 px）')
        print('-' * 78)
        await page.evaluate(SET_BLOOM_JS, [False, 0.6, None, None])
        sidx = await page.evaluate(FIND_JS, 'mw-sun-mark')
        await page.evaluate(ISOLATE_JS, sidx)
        for tag, mips, scale in (('on', True, 0.5), ('off', False, 0.5),
                                 ('on', True, 0.25), ('off', False, 0.25)):
            st = await page.evaluate(SPRITE_MIP_JS, ['mw-sun-mark', scale, mips])
            name = f'mp-{tag}-s{int(scale * 100):03d}.png'
            await shoot(page, os.path.join(SHOTS, name))
            print(f'  scale={scale}（≈{round(scale * 6):>2} px）mip={tag:<4} '
                  f'回读 genMips={st.get("genMips")} minFilter={st.get("minFilter")} '
                  f'贴图 {st.get("mapWH")} → {name}')
        print('  ★ 待量：放大 16 倍后，mip=on 那张是否比 mip=off 那张更"方"。')

        # ================= 三、全画面默认视角（真实观感）=================
        print('=' * 78)
        print('  三、全画面默认视角 —— 这个方斑在用户实际看到的画面里有多显眼')
        print('-' * 78)
        await page.evaluate(SHOWALL_JS)
        for r in (0.6, 0.25):
            st = await page.evaluate(SET_BLOOM_JS, [True, r, None, None])
            name = f'bl-full-r{int(round(r * 100)):03d}.png'
            await shoot(page, os.path.join(SHOTS, name))
            print(f'  radius={r:<5} → {name}')
        print('=' * 78)

        # ---- 复位 ----
        await page.evaluate(SET_BLOOM_JS, [True, 0.6, 0.72, 0.45])
        await page.evaluate("""() => {
          const lv = window.__universe.engine.current;
          const o = (lv.scene.children || []).find((k) => k.name === 'mw-sun-mark');
          if (o) o.scale.set(2.2, 2.2, 1);
          const s = window.__mipSaved;
          if (o && o.material.map && s) {
            o.material.map.generateMipmaps = s.gen;
            o.material.map.minFilter = s.min;
            o.material.map.needsUpdate = true;
          }
          return 1;
        }""")
        print('  已复位（radius 0.6 / strength 0.72 / threshold 0.45 / 太阳标记 scale 2.2 / mipmap 原值）')

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

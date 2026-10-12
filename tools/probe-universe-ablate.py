#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「可观测宇宙满屏是雾、什么也没有」的消融探针 —— 逐层关掉，看雾是谁的。

## 为什么必须做消融

第一个探针（`probe-universe-content.py`）已经量出两件事：
  · 这一层的屏幕**不是黑的**：均值 36.2、近黑(<8) 只占 0.1% ⇒ 满屏是一层中灰的**雾**；
  · 这一层的数据集里有 **181 条**天体（179 个真实河外星系），场景里**只画了 1 条**。

但「雾是谁画的」不能靠读代码猜。屏幕上至少有三个加法混合（AdditiveBlending）的
候选，亮度会互相叠加，**逐个关掉才知道各占多少**：

    · CMB 球壳（半径 45.2、不透明度 0.22）—— 相机在球**内部**，所以它铺满整个视口；
    · 线框球壳（半径 45.2、wireframe）—— 满屏的网格线；
    · 宇宙网散点（15818 点、不透明度 0.62、加法混合）；
    · 恒星场（2600 点、半径 540–900 Gly）。

⚠️ 本项目在泛光上吃过的亏（坑 107）：**加法混合的分量不可加**（残差 68.7%），
但那说的是泛光的高通带。这里的消融只关「谁在画」，不关泛光；所以关泛光前后各测一次，
两者都记下来，**不用「各分量之和 == 全体」来对账**（那笔账在有泛光时本来就不成立）。

## 先把动画冻住（否则量的是动画不是画面）

CMB 每帧 `rotation.y += dt*0.004`。连拍两张有 58.8% 的像素在变（第一个探针实测），
噪声地板完全不干净。所以本脚本把 `lv.update` 包一层、**只喂 dt=0**——
刻度文字照常更新，画面不动。噪声地板必须回到 ~0，否则下面的差值是噪声。

用法：
    py -3.13 -X utf8 tools/probe-universe-ablate.py
    py -3.13 -X utf8 tools/probe-universe-ablate.py --level=supercluster   # 阳性对照
退出码：0 = 测到了；1 = 页面没起来。
"""
import asyncio
import os
import sys
import threading

import numpy as np
from PIL import Image
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


TARGET = 'universe'
HEADED = False
KEEP_BLOOM = True
for a in sys.argv[1:]:
    if a.startswith('--level='):
        TARGET = a.split('=', 1)[1]
    elif a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a.startswith('--bloom='):
        KEEP_BLOOM = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')


# ---------------------------------------------------------------------------
# ① 冻结动画
# ---------------------------------------------------------------------------
FREEZE_JS = r"""
() => {
  const eng = window.__universe.engine;
  const lv = eng.current;
  if (!lv.__frozen) {
    const orig = lv.update.bind(lv);
    lv.update = (dt) => orig(0);
    lv.__frozen = true;
  }
  /* ⚠️ 只冻 `lv.update` 不够 —— 第一个版本就是这么写的，噪声地板仍然是
   *    max 172 / 25.8% 的像素在变。真凶是 `engine.js:146 autoRotate: true`：
   *    相机自己在绕圈，**每一张截图都是从不同角度拍的**。
   *    量图像差之前必须先把相机钉住，否则量的是轨道运动。 */
  let rot = null;
  if (eng.controls) {
    rot = { was: eng.controls.autoRotate, speed: eng.controls.autoRotateSpeed };
    eng.controls.autoRotate = false;
  }
  return { frozen: !!lv.__frozen, level: lv.id, autoRotate: rot };
}
"""

# ---------------------------------------------------------------------------
# ② 给每个候选起名字（消融要按名字关，不能按 index —— index 会漂）
# ---------------------------------------------------------------------------
NAME_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const out = [];
  let i = 0;
  lv.scene.traverse((o) => {
    if (o === lv.scene) return;
    if (!(o.isPoints || o.isMesh || o.isLine || o.isSprite)) return;
    if (!o.name) {
      if (o.isPoints) o.name = 'points#' + i;
      else if (o.isMesh) o.name = 'mesh#' + i;
      else if (o.isLine) o.name = 'line#' + i;
      else o.name = 'sprite#' + i;
      i++;
    }
    const n = o.geometry?.attributes?.position?.count ?? null;
    out.push({
      name: o.name, type: o.type, count: n,
      size: o.material?.size ?? null, opacity: o.material?.opacity ?? null,
      wireframe: !!o.material?.wireframe,
      blending: o.material?.blending ?? null,
      radius: o.geometry?.parameters?.radius ?? null,
      scale: o.isSprite ? +o.scale.x.toFixed(3) : null,
    });
  });
  lv.__items = out.map((r) => r.name);
  return out;
}
"""

# ---------------------------------------------------------------------------
# ③ 消融：按名字隐藏一批
# ---------------------------------------------------------------------------
SET_VIS_JS = r"""
(names) => {
  const lv = window.__universe.engine.current;
  const set = new Set(names);
  let n = 0;
  lv.scene.traverse((o) => {
    if (o === lv.scene) return;
    if (set.has(o.name)) { o.visible = false; n++; }
  });
  // 复原：先全开，再按名单关
  if (names.length === 0) {
    lv.scene.traverse((o) => { if (o !== lv.scene) o.visible = true; });
    n = -1;
  }
  return { hidden: n };
}
"""

# 宇宙网点的半径直方图 —— 确认「近处空、远处密」这个猜测
RADIAL_JS = r"""
(ptsName) => {
  const lv = window.__universe.engine.current;
  let target = null;
  lv.scene.traverse((o) => { if (o.name === ptsName) target = o; });
  if (!target) return null;
  const a = target.geometry.attributes.position.array;
  const n = target.geometry.attributes.position.count;
  const NB = 20, RMAX = 46;
  const bins = new Array(NB).fill(0);
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
    const b = Math.min(NB - 1, Math.floor((r / RMAX) * NB));
    bins[b]++;
  }
  // 按壳层体积归一 ⇒ 「每单位体积的点数」（密度），不是「每层的点数」
  const dens = bins.map((c, k) => {
    const r1 = (k / NB) * RMAX, r2 = ((k + 1) / NB) * RMAX;
    const vol = (4 / 3) * Math.PI * (r2 ** 3 - r1 ** 3);
    return +(c / vol * 1000).toFixed(4);
  });
  return { n, RMAX, bins, dens };
}
"""

SET_BLOOM_JS = r"""
(on) => {
  const bp = window.__universe.engine.bloomPass;
  if (!bp) return null;
  const was = bp.enabled;
  bp.enabled = !!on;
  return { was, now: bp.enabled };
}
"""


async def settle(page, frames=4, min_ms=500):
    try:
        await page.evaluate("""(n) => new Promise(res => {
          let i = 0; const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        })""", frames)
    except Exception:
        pass
    await page.wait_for_timeout(min_ms)


async def shoot(page, name):
    path = os.path.join(SHOTS, name)
    await page.screenshot(path=path)
    return path


def stats(path):
    im = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
    L = im[:, :, 0] * 0.2126 + im[:, :, 1] * 0.7152 + im[:, :, 2] * 0.0722
    tot = L.size
    return {
        'mean': float(L.mean()),
        'p50': float(np.percentile(L, 50)),
        'p90': float(np.percentile(L, 90)),
        'p99': float(np.percentile(L, 99)),
        'nearblack': float((L < 8).sum() * 100.0 / tot),
        'bright': float((L >= 60).sum() * 100.0 / tot),
        'L': L,
    }


def diff(a, b):
    d = np.abs(a - b)
    return {'max': float(d.max()), 'mean': float(d.mean()),
            'changed': float((d > 3).sum() * 100.0 / d.size)}


async def run(base):
    os.makedirs(SHOTS, exist_ok=True)
    tag = TARGET
    async with async_playwright() as pw:
        backend = 'msedge'
        try:
            browser = await pw.chromium.launch(headless=not HEADED, channel='msedge', args=OCCLUSION_ARGS)
        except Exception as e:
            backend = f'bundled-chromium（msedge 起不来：{type(e).__name__}）'
            browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
        page = await browser.new_page(viewport={'width': 1400, 'height': 860})
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! console: {m.text[:170]}'))
        page.on('pageerror', lambda e: emit(f'  ! pageerror: {str(e)[:170]}'))

        emit(f'\n打开 {base}/ …  后端 {backend}')
        await page.goto(base + '/', wait_until='load')
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=60000)
        await page.wait_for_timeout(2500)

        await page.evaluate("() => { const e = document.getElementById('labels'); if (e) e.style.display = 'none'; }")
        r = await page.evaluate(f'window.__universe.gotoScale("{tag}")')
        await page.wait_for_function(f"window.__universe.engine.current?.id === '{tag}'", timeout=45000)
        await settle(page, frames=6, min_ms=2200)

        emit(f'\n冻结动画：{await page.evaluate(FREEZE_JS)}')
        emit(f'泛光 = {"开" if KEEP_BLOOM else "关"}（预登记：两种都测，不用分量和对账，坑 107）')
        await page.evaluate(SET_BLOOM_JS, KEEP_BLOOM)

        items = await page.evaluate(NAME_JS)
        emit(f'\n  ① 这一层的可消融对象（{len(items)} 个）')
        emit(f'  {"名字":<14}{"类型":<9}{"点数":>9}{"size":>8}{"不透明":>8}{"线框":>6}  半径')
        emit('  ' + '-' * 74)
        for it in items:
            cnt = '' if it['count'] is None else str(it['count'])
            sz = '' if it['size'] is None else f'{it["size"]:.3f}'
            op = '' if it['opacity'] is None else f'{it["opacity"]:.2f}'
            wf = '是' if it['wireframe'] else ''
            rr = ''
            if it['radius'] is not None:
                rr = f'球半径 {it["radius"]}'
            elif it['scale'] is not None:
                rr = f'scale {it["scale"]}'
            emit(f'  {it["name"]:<14}{it["type"]:<9}{cnt:>9}{sz:>8}{op:>8}{wf:>6}  {rr}')

        # 挑出四类：CMB 球 / 线框球 / 点云里最大的那个（宇宙网）/ 恒星场
        def find(pred):
            return [i['name'] for i in items if pred(i)]

        points = sorted([i for i in items if i['type'] == 'Points' and (i['count'] or 0) > 1000],
                        key=lambda x: -(x['count'] or 0))
        web = points[0]['name'] if points else None
        starfield = next((i['name'] for i in items if i['name'] == 'starfield'), None)
        cmb = next((i['name'] for i in items if i['type'] == 'Mesh' and (i['radius'] or 0) > 20
                    and not i['wireframe']), None)
        shell = next((i['name'] for i in items if i['type'] == 'Mesh' and (i['radius'] or 0) > 20
                      and i['wireframe']), None)
        struct = find(lambda i: i['type'] in ('Sprite', 'Line'))
        emit(f'\n  分类：宇宙网={web}({[i["count"] for i in points if i["name"]==web]}) '
             f'恒星场={starfield} CMB球={cmb} 线框球={shell} 结构/环={len(struct)} 个')

        # 宇宙网密度分布
        if web:
            rad = await page.evaluate(RADIAL_JS, web)
            if rad:
                emit(f'\n  ② 宇宙网点半径分布（共 {rad["n"]} 点，按 R<={rad["RMAX"]} 分 20 壳）')
                emit('     壳层半径(Gly)  点数    每单位体积密度(×10⁻³)')
                for k in range(20):
                    r1, r2 = k * rad['RMAX'] / 20, (k + 1) * rad['RMAX'] / 20
                    bar = '█' * min(40, int(rad['dens'][k] * 40 / (max(rad['dens']) or 1)))
                    emit(f'     {r1:>5.1f}–{r2:<5.1f}  {rad["bins"][k]:>7}   {rad["dens"][k]:>8}  {bar}')

        # ---------------- 消融矩阵 ----------------
        emit('\n' + '=' * 96)
        emit('  ③ 消融矩阵 —— 每次关掉一批，量屏幕统计')
        emit('=' * 96)

        plan = [('base 全开', [])]
        if cmb:
            plan.append(('关 CMB 球', [cmb]))
            plan.append(('关 CMB+线框', [cmb] + ([shell] if shell else [])))
        if web:
            plan.append(('关 宇宙网', [web]))
        if starfield:
            plan.append(('关 恒星场', [starfield]))
        if struct:
            plan.append(('关 结构与环', struct))
        if cmb and web and starfield and shell:
            plan.append(('只留宇宙网', [cmb, shell, starfield] + struct))

        rows = []
        baseL = None
        for label, names in plan:
            await page.evaluate(SET_VIS_JS, [])
            if names:
                await page.evaluate(SET_VIS_JS, names)
            await settle(page, frames=4, min_ms=420)
            p = await shoot(page, f'_uvab-{tag}-{len(rows)}.png')
            s = stats(p)
            if baseL is None:
                baseL = s['L']
                dd = {'max': 0.0, 'mean': 0.0, 'changed': 0.0}
            else:
                dd = diff(baseL, s['L'])
            rows.append((label, s, dd, p))
            emit(f'  {label:<16}均值 {s["mean"]:>7.2f}  p50 {s["p50"]:>6.1f}  p90 {s["p90"]:>6.1f}  '
                 f'p99 {s["p99"]:>6.1f}  近黑 {s["nearblack"]:>6.2f}%  亮 {s["bright"]:>6.2f}%  '
                 f'| 相对全开 Δ均值 {dd["mean"]:>7.2f} 变化 {dd["changed"]:>6.2f}%')

        # ---------------- 噪声地板（冻住动画之后） ----------------
        await page.evaluate(SET_VIS_JS, [])
        await settle(page, frames=4, min_ms=420)
        a = await shoot(page, f'_uvab-{tag}-nf-a.png')
        b = await shoot(page, f'_uvab-{tag}-nf-b.png')
        nf = diff(stats(a)['L'], stats(b)['L'])
        emit(f'\n  ④ 噪声地板（已冻动画、同状态连拍两张）：max {nf["max"]:.1f}  '
             f'变化 {nf["changed"]:.3f}%   → '
             f'{"干净，差值是画面差异" if nf["changed"] < 0.05 else "⚠ 仍不干净，上面的差值含噪声"}')

        # ---------------- 贡献拆解 ----------------
        emit('\n' + '=' * 96)
        emit('  ⑤ 贡献拆解（均值亮度，相对「全开」）')
        emit('=' * 96)
        full = rows[0][1]['mean']
        for label, s, dd, p in rows:
            if label == 'base 全开':
                continue
            emit(f'  关掉 {label[2:] if label.startswith("关 ") else label:<14} '
                 f'⇒ 均值从 {full:>6.2f} 掉到 {s["mean"]:>6.2f}（Δ {s["mean"] - full:>+7.2f}）')
        emit('=' * 96)
        emit('  ⚠ 这些 Δ 只在泛光关闭时才可以相加；泛光开着时分量和 ≠ 全体（坑 107）。')

        sys.stdout.flush()
        srv.stop()
        arm_hard_exit(14, 0)
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except Exception as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘）：{type(e).__name__}')
    return 0


async def main():
    global srv
    srv = ServedCheck(tag='可观测宇宙消融探针')
    base = srv.start()
    try:
        return await run(base)
    finally:
        srv.stop()


if __name__ == '__main__':
    arm_hard_exit(900, 3)
    try:
        code = asyncio.run(main())
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 0
    sys.exit(code or 0)

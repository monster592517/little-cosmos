#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""银河系层**逐个对象消融**探针：判「这块画面是谁画的」，不靠读代码。

## 为什么有这个东西

「银河系正俯视图上有一个**偏心的第二团白斑**」——用户看到的是一团光，但
**能画出这团光的东西至少有三个候选**（太阳标记的辉光精灵 / 银心精灵 / 贴图自身
那一侧的亮区）。读代码只能证明「某个对象存在」，证不出「它在画面上占了多少」。
2026-09-12 我就是靠读代码把这块归因给太阳标记，算完像素发现对不上（size 0.85
在默认视距下只有约 4 px 半径，撑不出 90 px 的白斑）——**归因抢跑了**。

做法照搬项目里已经验证过的「按名字消融」（坑 105）：
  ① 先拍一张**基线**（什么都不动）；
  ② 每次只把**一个**顶层对象 `visible = false`，拍一张；
  ③ 与基线做差，报「变了多少像素 / 平均差」，并把**放大 4 倍的差分图**落盘。
     ⇒ 差分图就是那个对象的**足迹**：足迹形状能直接读出它是精灵、是点云、还是盘面。

## 两个必须钉住的状态（否则差分会骗人）

1. **相机**：每次拍之前重摆同一个视角。`autoRotate` 关掉。
2. **盘面点云的自转**：`galaxy.js` 的 `update()` 里每帧 `rotation.y += dt*0.0035`
   —— 20 张图拍下来会转过约 5 度，**差分里全是它**，真正的信号会被淹掉。
   所以每次拍之前把 `diskParts` 的 `rotation.y` 归零（残余漂移约 0.05 度，可忽略）。

⚠️ 泛光是开着的，它会**把光摊开到远处** ⇒ 消融的影响范围大于对象本身的几何范围。
   这对「谁在发光」的归因是好事，但**不可以用差分图的面积当对象的可见面积**。

## 用法

    py -3.13 -X utf8 tools/probe-mw-ablation.py --tag=abl1

产出：`shots/mwabl-<tag>-base.png`、`-off-<对象名>.png`、`-diff-<对象名>.png`
     （4 倍放大差分）、日志走 stdout。**必须后台跑。**
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

TAG = 'abl'
NULL_N = 0                      # `--null=N`：只测噪声地板，不跑消融（快通道）
for a in sys.argv[1:]:
    if a.startswith('--tag='):
        TAG = a.split('=', 1)[1]
    elif a.startswith('--null='):
        NULL_N = int(a.split('=', 1)[1])

# 正俯视（偏 8 度避开万向锁，见 probe-mw-look.py）。
VIEW_POS = [0, 148, 20]
VIEW_TGT = [0, 0, 0]


def arm_hard_exit(seconds, code=0):
    t = threading.Timer(float(seconds), lambda: os._exit(int(code)))
    t.daemon = True
    t.start()
    return t


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

# 摆视角：隐藏标签 + 固定相机 + 关自动旋转 + **把盘面自转转死**。
#
# ★ 「归零」不够，必须「摘掉」——这是实测出来的（abl2 的噪声地板 10.32%，高得离谱）：
#   `galaxy.js#update()` 每帧跑 `for (const p of this.diskParts) p.rotation.y += dt*0.0035`。
#   只在拍之前把 `rotation.y` 置零，两次「同一状态」之间仍会转过约 **0.18 度**
#   （0.9 秒 × 0.0035 rad/s）⇒ 在 r≈250 px 处就是**约 1 px 的位移** ⇒ 16 万个 additive
#   点整体挪一格 ⇒ **整个盘都落进差分里**（地板 10.32%，平均差 2.8）。
#   把数组暂时**摘空**，那一行循环就什么都不做，点云彻底静止。
#   ⚠️ 这是「钉住会漂的状态」（坑 104 的第 ③ 条），不是作弊：钉住之后量的才是被消融对象。
DETACH_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const parts = lv.diskParts || [];
  for (const p of parts) p.rotation.y = 0;      // 先摆正
  lv.diskParts = [];                            // 再摘掉 ⇒ update() 里的自转循环空转
  return parts.length;
}
"""

POSE_JS = r"""
(o) => {
  const e = window.__universe.engine;
  const lv = e.current;
  if (lv.labels && lv.labels.setVisible) lv.labels.setVisible(false);
  lv.applyView({ position: o.position, target: o.target });
  if (e.controls) {
    e.controls.autoRotate = false;
    // ⚠️ 阻尼也必须关：`enableDamping` 会让相机在**每帧 update()** 里继续被惯性推着走，
    //    表现就是「两张同状态的图不一样」。判据要看**姿态**，不要靠「应该停了」。
    e.controls.enableDamping = false;
    if (e.controls.update) e.controls.update();
  }
  const q = lv.camera.quaternion;
  const p = lv.camera.position;
  return {
    orbit: e.controls ? e.controls.autoRotate : null,
    damp: e.controls ? e.controls.enableDamping : null,
    // 姿态用**字符串**回传：浮点比较在 Python 侧没法做，字符串可以逐位比。
    pose: [p.x, p.y, p.z, q.x, q.y, q.z, q.w].map((v) => +v.toFixed(6)).join(','),
  };
}
"""

# 列出顶层对象：名字 / 类型 / 世界坐标 / 缩放 / 点数 / 材质口径。
# 「世界坐标」是回答「那块偏心白斑落在哪」的关键 —— 光有名字不够。
OBJECTS_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const out = [];
  for (const o of lv.scene.children) {
    const m = o.material ? (Array.isArray(o.material) ? o.material[0] : o.material) : null;
    o.updateWorldMatrix(true, false);
    // 直接读 matrixWorld 的第 4 列，不 import THREE：页面里没有全局 THREE，
    // `new THREE.Vector3()` 会 ReferenceError —— 那种错会被 evaluate 包成一句
    // 很难读的报错，而这里本来就不需要那个类。
    const e = o.matrixWorld.elements;
    out.push({
      name: o.name || '(无名)', type: o.type,
      pos: [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)],
      scale: [o.scale.x, o.scale.y, o.scale.z].map((v) => +v.toFixed(3)),
      children: o.children ? o.children.length : 0,
      blend: m ? m.blending : null, opacity: m ? m.opacity : null,
      mapKind: m && m.map && m.map.image
        ? (m.map.image.width + 'x' + m.map.image.height) : (m ? (m.map ? '?' : '-') : '?'),
      count: o.geometry && o.geometry.attributes && o.geometry.attributes.position
        ? o.geometry.attributes.position.count : null,
    });
  }
  return out;
}
"""

SET_VISIBLE_JS = r"""
(o) => {
  const lv = window.__universe.engine.current;
  const t = lv.scene.children.find((c) => (c.name || '(无名)') === o.name);
  if (!t) return false;
  t.visible = !!o.visible;
  return true;
}
"""


def diff_vs(base_path, path, out_path, amp=4):
    """差分图 + 统计。返回 (变化像素数, 平均差, 变化占比)。"""
    from PIL import Image, ImageChops
    a = Image.open(base_path).convert('RGB')
    b = Image.open(path).convert('RGB')
    d = ImageChops.difference(a, b)
    px = d.load()
    w, h = d.size
    changed = 0
    total = 0.0
    n = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, bl = px[x, y]
            v = r if r > g else g
            if bl > v:
                v = bl
            if v > 8:
                changed += 1
            total += v
            n += 1
    d.point(lambda v: min(255, v * amp)).save(out_path)
    return changed, round(total / max(1, n), 3), round(100.0 * changed / max(1, n), 2)


async def run(base, srv):
    os.makedirs(SHOTS, exist_ok=True)
    from PIL import Image                                    # noqa: F401  （缺了就早报错）
    async with async_playwright() as pw:
        # 有头时窗口被遮挡 ⇒ Chromium 降级（rAF 节流 / 合成器不出新帧），探针会假死。
        # 开关的唯一来源是 `tools/browser_args.py`（坑 136 / 坑 149）。
        args = list(OCCLUSION_ARGS)
        backend = 'msedge'
        try:
            browser = await pw.chromium.launch(headless=False, channel='msedge', args=args)
        except Exception as e:
            backend = f'bundled-chromium（msedge 起不来：{type(e).__name__}）'
            browser = await pw.chromium.launch(headless=False, args=args)
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
        emit(f'后端 {backend} → {bk["renderer"]}'
             + ('  ⚠️ 软件渲染，像素不可比' if bk['software'] else ''))
        emit(f'画质档 {pin["tier"]} · pointBudget {pin["pointBudget"]}')

        await page.evaluate("""async (lv) => {
            const u = window.__universe; u.gotoScale(lv);
            const t0 = performance.now();
            while (performance.now() - t0 < 40000) {
              const e = u.engine;
              if (e.current && e.current.id === lv && !e.transition && e.current.scene) return true;
              await new Promise((r) => setTimeout(r, 120));
            }
            return false;
        }""", 'galaxy')
        await page.wait_for_timeout(1500)
        nparts = await page.evaluate(DETACH_JS)
        await page.evaluate(POSE_JS, {'position': VIEW_POS, 'target': VIEW_TGT})
        emit(f'已进银河系层，盘面自转已**摘除**（原本 diskParts {nparts} 个；不摘的话'
             f'噪声地板会高到 10%，见 POSE_JS 上面的注释）')

        objs = await page.evaluate(OBJECTS_JS)
        emit(f'\n顶层对象 {len(objs)} 个（世界坐标 / 缩放 / 贴图 / 点数 / 混色）：')
        for o in objs:
            emit(f'  {o["name"]:22s} {o["type"]:12s} pos={o["pos"]} scale={o["scale"]}'
                 f' blend={o["blend"]} op={o["opacity"]} map={o["mapKind"]} pts={o["count"]}')

        async def shot(name, wait=0.9):
            pose = await page.evaluate(POSE_JS, {'position': VIEW_POS, 'target': VIEW_TGT})
            await page.wait_for_timeout(int(wait * 1000))
            path = os.path.join(SHOTS, f'mwabl-{TAG}-{name}.png')
            last = None
            for _ in (1, 2):
                try:
                    await page.screenshot(path=path, timeout=15000)
                    last = None
                    break
                except Exception as e:
                    last = e
                    emit(f'  ! 截图失败：{type(e).__name__}，重试')
                    await page.wait_for_timeout(1200)
            if last is not None:
                emit(f'  ✗ {name} 截图始终失败：{last}')
                return None, pose
            return path, pose

        # ---------- 只测噪声地板的快通道（`--null=N`）----------
        # 为什么要有这条路：地板一旦和待测效应同量级，整张排名表就不可读 ——
        # 而**查地板本身的原因**不该每次都把 15 个对象重拍一遍。
        if NULL_N:
            emit(f'\n=== 噪声地板模式：同一状态连拍 {NULL_N + 1} 张 ===')
            shots = []
            for i in range(NULL_N + 1):
                p, pose = await shot(f'null-{i}', wait=1.0)
                if not p:
                    break
                emit(f'  null-{i}  相机姿态 {pose["pose"]}  autoRotate={pose["orbit"]} damping={pose["damp"]}')
                shots.append(p)
            for i in range(1, len(shots)):
                ch, md, pc = diff_vs(shots[0], shots[i],
                                      os.path.join(SHOTS, f'mwabl-{TAG}-diff-null-{i}.png'))
                emit(f'  null-0 vs null-{i}：变化 {ch} px / 占比 {pc}% / 平均差 {md}')
            sys.stdout.flush()
            srv.stop()
            arm_hard_exit(20)
            try:
                await browser.close()
            except Exception:
                pass
            return 0

        base_png, base_pose = await shot('base', wait=1.6)
        if not base_png:
            srv.stop()
            arm_hard_exit(20)
            await browser.close()
            return 1
        emit(f'\n基线 {os.path.basename(base_png)}  相机姿态 {base_pose["pose"]}')

        # ★ **先量噪声地板**（坑 104）：什么都不动、连拍第二张，与基线做同一个差分。
        #   为什么非要这一步：泛光 / 抖动的点云 / 浮点累积都会让「同一状态的两张图」不相等。
        #   第一版漏了这一步，于是清单里 12 个对象齐刷刷落在 2.2%~2.9% —— 
        #   那个区间根本分不出「真的画了东西」和「纯噪声」。**没有地板，消融排名不可读。**
        null_png = await shot('null-b', wait=0.9)
        nch, nmd, npc = diff_vs(base_png, null_png,
                                os.path.join(SHOTS, f'mwabl-{TAG}-diff-__null__.png'))
        emit(f'噪声地板（什么都不动，连拍两张）：变化 {nch} px / 占比 {npc}% / 平均差 {nmd}'
             f'  ⇒ **低于这个数的名次不可信**')

        emit(f'\n{"关掉的对象":24s} {"变化像素":>9s} {"占比%":>7s} {"平均差":>8s}  差分图')
        rows = []
        for o in objs:
            nm = o['name']
            ok = await page.evaluate(SET_VISIBLE_JS, {'name': nm, 'visible': False})
            if not ok:
                emit(f'  ! 找不到 {nm}')
                continue
            p = await shot(f'off-{nm}')
            await page.evaluate(SET_VISIBLE_JS, {'name': nm, 'visible': True})
            if not p:
                continue
            dp = os.path.join(SHOTS, f'mwabl-{TAG}-diff-{nm}.png')
            ch, md, pc = diff_vs(base_png, p, dp)
            rows.append((nm, ch, pc, md, os.path.basename(dp)))
        rows.sort(key=lambda r: -r[2])
        for nm, ch, pc, md, fn in rows:
            tag = '  ← 与地板同一量级，未必真画了东西' if pc <= npc * 1.3 else ''
            emit(f'{nm:24s} {ch:9d} {pc:7.2f} {md:8.3f}  {fn}{tag}')
        emit(f'\n判读：高于地板 1.3 倍（≈{round(npc * 1.3, 2)}%）才算「确实在画东西」。')
        emit('注：泛光会把影响范围摊开，差分面积不等于对象的可见面积。')

        sys.stdout.flush()
        srv.stop()
        arm_hard_exit(20)
        try:
            await browser.close()
        except Exception:
            pass
    return 0


async def main():
    srv = ServedCheck(tag='银河系消融探针')
    base = srv.start()
    try:
        return await run(base, srv)
    finally:
        srv.stop()


if __name__ == '__main__':
    try:
        code = asyncio.run(main())
    except Exception as e:                                    # pragma: no cover
        emit(f'✗ {type(e).__name__}: {e}')
        code = 1
    emit('完成。')
    sys.stdout.flush()
    os._exit(int(code))

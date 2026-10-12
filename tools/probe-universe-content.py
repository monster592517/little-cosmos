#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「可观测宇宙背景太空了啥也没有」的活体探针 —— 先分清两种病，再动手。

## 为什么不能靠读代码下结论

用户的原话是「可观测宇宙**背景**太空了啥也没有」。同一句话至少对应**两种完全不同的病**，
而修法互不通用：

    A. 「本来就没内容」—— 这一层的数据只有 7 个手工结构，画得再准也就 7 个点。
       修法在**数据层**：补真实的大尺度结构 / 星系。
    B. 「有内容但没画出来」—— 数据层把天体分给了这一层，渲染层没画。
       修法在**渲染层**：把本层的天体铺出来。
    C. 「画了但看不见」—— 画了，但太暗/太小/被别的图层盖住。
       修法在**材质与相机**。

读代码只能知道「A/B/C 都可能」，不能知道**屏幕上这一张**是哪一个。所以本探针：

  · ① 场景清点：这一层**真的往 scene 里加了什么**，每样多少个点、什么材质、半径范围多大；
  · ② 数据对照：数据集里 `level === 'universe'` 的天体有多少条，其中渲染层画了几条；
  · ③ 屏幕统计：关掉标签连拍两张（**噪声地板**），再统计亮度分布与空间分布 ——
       「一片近黑」和「一片雾但没天体」是两种病，像素统计能分开；
  · ④ 阳性对照：同一套量具去量**室女座超星系团**层（那层有真实星系点云）。
       对照层有东西、目标层没有 ⇒ 「空」是真的；两层都空 ⇒ 量具坏了。

## 量具先自证（坑 104 / 106）

① 先量**噪声地板**：不改任何东西连拍两张，逐像素差的最大值必须≈0，否则量的是动画不是画面。
② **关掉 `#labels`**：标签走 DOM、不吃曝光，但会占像素、把亮度均值抬上去（坑 106）。
③ 钉住会漂的状态（画质档 / 像素比 / 泛光参数）并逐次打印，避免「两次测量条件不同」。

用法：
    py -3.13 -X utf8 tools/probe-universe-content.py
    py -3.13 -X utf8 tools/probe-universe-content.py --level=supercluster
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
CONTROL = 'supercluster'
HEADED = False
for a in sys.argv[1:]:
    if a.startswith('--level='):
        TARGET = a.split('=', 1)[1]
    elif a.startswith('--control='):
        CONTROL = a.split('=', 1)[1]
    elif a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')


# ---------------------------------------------------------------------------
# ① 场景清点：把当前层 scene 里每一类对象数出来
# ---------------------------------------------------------------------------
CENSUS_JS = r"""
() => {
  const eng = window.__universe.engine;
  const lv = eng.current;
  if (!lv) return { error: 'no current level' };
  const Vec = lv.camera.position.constructor;
  const v = new Vec();
  const rows = [];
  const walk = (o, depth, hiddenBy) => {
    rows.push({ o, depth, hiddenBy });
    for (const c of (o.children || [])) walk(c, depth + 1, hiddenBy || !o.visible);
  };
  walk(lv.scene, 0, false);

  const out = { level: lv.id, name: lv.name, items: [], labelCount: 0, stats: {} };
  for (const { o, hiddenBy } of rows) {
    if (o === lv.scene) continue;
    const it = {
      name: o.name || '', type: o.type, hiddenBy: !!hiddenBy, visible: o.visible !== false,
    };
    if (o.isPoints || o.isLine || o.isMesh) {
      const g = o.geometry;
      const n = g?.attributes?.position?.count ?? null;
      it.count = n;
      const m = o.material;
      if (m) {
        if (Array.isArray(m)) it.multi = m.length;
        else {
          it.size = m.size ?? null;
          it.opacity = m.opacity ?? null;
          it.blending = m.blending;
          it.vertexColors = !!m.vertexColors;
          it.hasMap = !!(m.map || (m.alphaMap));
          it.wireframe = !!m.wireframe;
          it.side = m.side;
        }
      }
      // 半径范围（相对世界原点）
      if (n && g.attributes.position) {
        const arr = g.attributes.position.array;
        let rmin = Infinity, rmax = 0;
        const step = Math.max(1, Math.floor(n / 4000));
        for (let i = 0; i < n; i += step) {
          const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
          const r = Math.hypot(x, y, z);
          if (r < rmin) rmin = r;
          if (r > rmax) rmax = r;
        }
        it.rMin = +rmin.toFixed(4); it.rMax = +rmax.toFixed(4); it.rSampled = Math.ceil(n / step);
      }
      if (o.isMesh && o.geometry.parameters && o.geometry.parameters.radius != null) {
        it.geoRadius = o.geometry.parameters.radius;
      }
    } else if (o.isSprite) {
      it.scaleXY = [o.scale.x, o.scale.y];
    }
    out.items.push(it);
  }
  out.labelCount = lv.labels && lv.labels.count ? lv.labels.count : null;
  return out;
}
"""

# ---------------------------------------------------------------------------
# ② 数据对照 + ④ 结构在屏幕上的分布
# ---------------------------------------------------------------------------
DATA_JS = r"""
() => {
  const app = window.__universe;
  const eng = app.engine;
  const lv = eng.current;
  const ds = app.dataset;
  const id = lv.id;
  const mine = [...ds.bodies.values()].filter((b) => b.level === id);
  const byType = {};
  for (const b of mine) byType[b.type] = (byType[b.type] || 0) + 1;
  const placed = mine.filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z));
  // 这一层 scene 里的 bodyId 集合（渲染层真画了谁）
  const drawn = new Set();
  lv.scene.traverse((o) => { if (o.userData && o.userData.bodyId) drawn.add(o.userData.bodyId); });
  const drawnMine = mine.filter((b) => drawn.has(b.id));
  return {
    level: id, total: mine.length, byType, placed: placed.length,
    drawnAnyBody: drawn.size, drawnMineCount: drawnMine.length,
    drawnMineSample: drawnMine.slice(0, 12).map((b) => b.id),
    undrawnSample: mine.filter((b) => !drawn.has(b.id)).slice(0, 8).map((b) => b.id),
    // 分布：三维半径分位
    radii: (() => {
      const r = placed.map((b) => Math.hypot(b.x, b.y, b.z)).sort((a, b) => a - b);
      if (!r.length) return null;
      const q = (p) => +r[Math.min(r.length - 1, Math.floor(p * r.length))].toFixed(4);
      return { n: r.length, p0: +r[0].toFixed(4), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), max: +r[r.length - 1].toFixed(4) };
    })(),
  };
}
"""

# 结构/天体在屏幕上的落点（像素），量「真实内容占了多少屏」
FOOTPRINT_JS = r"""
() => {
  const eng = window.__universe.engine;
  const lv = eng.current;
  const cam = lv.camera;
  const { w, h } = eng.size;
  const Vec = cam.position.constructor;
  const hits = [];
  lv.scene.traverse((o) => {
    if (!o.userData || !o.userData.bodyId) return;
    const p = new Vec();
    o.getWorldPosition(p);
    const q = p.clone().project(cam);
    if (q.z > 1 || q.z < -1) return;
    hits.push({
      id: o.userData.bodyId, type: o.type,
      x: Math.round((q.x * 0.5 + 0.5) * w), y: Math.round((-q.y * 0.5 + 0.5) * h),
      r: +p.length().toFixed(4),
      scale: +Math.max(o.scale?.x || 0, o.scale?.y || 0).toFixed(4),
    });
  });
  return { w, h, hits, camPos: [+cam.position.x.toFixed(3), +cam.position.y.toFixed(3), +cam.position.z.toFixed(3)],
           dist: +cam.position.distanceTo(lv.controls?.target || new Vec()).toFixed(3) };
}
"""

# 钉住会漂的状态
STATE_JS = r"""
() => {
  const eng = window.__universe.engine;
  return {
    tier: eng.tier?.id ?? null,
    pixelRatio: eng.renderer.getPixelRatio(),
    size: [eng.size.w, eng.size.h],
    toneMapping: eng.renderer.toneMapping,
    exposure: eng.renderer.toneMappingExposure,
    bloomEnabled: !!eng.bloomPass?.enabled,
    bloomStrength: eng.bloomPass?.strength ?? null,
    bloomThreshold: eng.bloomPass?.threshold ?? null,
    bloomRadius: eng.bloomPass?.radius ?? null,
    current: eng.current?.id ?? null,
  };
}
"""


async def settle(page, frames=4, min_ms=600):
    try:
        await page.evaluate("""(n) => new Promise(res => {
          let i = 0; const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        })""", frames)
    except Exception:
        pass
    await page.wait_for_timeout(min_ms)


async def shoot(page, name, labels_off=True):
    if labels_off:
        await page.evaluate("() => { const e = document.getElementById('labels'); if (e) e.style.display = 'none'; }")
    await settle(page, frames=4, min_ms=500)
    path = os.path.join(SHOTS, name)
    await page.screenshot(path=path)
    return path


def pixel_report(path, label):
    """亮度分布 + 空间分布（32x16 ASCII 热图）。返回 dict。"""
    from PIL import Image
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()
    lum = []
    grid = [[0] * 32 for _ in range(16)]
    gcnt = [[0] * 32 for _ in range(16)]
    hist = {'<2': 0, '<8': 0, '<24': 0, '<60': 0, '>=60': 0}
    tot = 0
    for y in range(0, H, 2):
        gy = min(15, y * 16 // H)
        for x in range(0, W, 2):
            r, g, b = px[x, y]
            L = 0.2126 * r + 0.7152 * g + 0.0722 * b
            lum.append(L)
            tot += 1
            if L < 2: hist['<2'] += 1
            elif L < 8: hist['<8'] += 1
            elif L < 24: hist['<24'] += 1
            elif L < 60: hist['<60'] += 1
            else: hist['>=60'] += 1
            gx = min(31, x * 32 // W)
            grid[gy][gx] += L
            gcnt[gy][gx] += 1
    lum.sort()
    n = len(lum)
    pct = lambda p: round(lum[min(n - 1, int(p * n))], 1)
    chars = ' .:-=+*#%@'
    mx = max(max(row) / max(1, gcnt[i][j]) for i, row in enumerate(grid) for j, v in enumerate(row)) or 1
    lines = []
    for i in range(16):
        s = ''
        for j in range(32):
            m = grid[i][j] / max(1, gcnt[i][j])
            k = int(min(9, (m / mx) * 9.999))
            s += chars[k]
        lines.append(s)
    return {
        'label': label, 'size': [W, H],
        'mean': round(sum(lum) / n, 2), 'p50': pct(0.5), 'p90': pct(0.9), 'p99': pct(0.99), 'max': round(lum[-1], 1),
        'hist': {k: f'{v * 100.0 / tot:.1f}%' for k, v in hist.items()},
        'map': lines,
    }


def print_pixel_report(rep):
    print(f'  ── {rep["label"]}  {rep["size"][0]}×{rep["size"][1]}')
    print(f'     亮度  均值 {rep["mean"]:<7} p50 {rep["p50"]:<7} p90 {rep["p90"]:<7} '
          f'p99 {rep["p99"]:<7} max {rep["max"]}')
    print(f'     占比  ' + '  '.join(f'{k}:{v}' for k, v in rep["hist"].items()))
    print(f'     32×16 亮度热图（ .:-=+*#%@ ，越靠右越亮）：')
    for ln in rep['map']:
        print('       |' + ln + '|')


def diff_report(a, b):
    from PIL import Image, ImageChops
    ia, ib = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    d = ImageChops.difference(ia, ib)
    bb = d.getbbox()
    if bb is None:
        return {'identical': True, 'maxDiff': 0, 'changedPct': 0.0}
    ex = d.getextrema()
    mx = max(e[1] for e in ex)
    hist = d.convert('L').histogram()
    tot = sum(hist)
    changed = sum(hist[3:])
    return {'identical': False, 'maxDiff': mx, 'changedPct': round(changed * 100.0 / tot, 3)}


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
        page.on('console', lambda m: m.type == 'error' and emit(f'  ! console: {m.text[:170]}'))
        page.on('pageerror', lambda e: emit(f'  ! pageerror: {str(e)[:170]}'))

        emit(f'\n打开 {base}/ …')
        await page.goto(base + '/', wait_until='load')
        await page.wait_for_function(
            'window.__universe && window.__universe.engine && window.__universe.dataset',
            timeout=60000)
        await page.wait_for_timeout(2500)
        emit(f'  后端 {backend}')

        reports = {}
        for lv in [CONTROL, TARGET]:
            emit('\n' + '=' * 96)
            emit(f'  ▎切到 {lv}')
            emit('=' * 96)
            r = await page.evaluate(f'window.__universe.gotoScale("{lv}")')
            try:
                await page.wait_for_function(
                    f"window.__universe.engine.current?.id === '{lv}'", timeout=45000)
            except Exception:
                emit(f'  ⚠ 没切到 {lv}（gotoScale 返回 {r}）')
                continue
            await settle(page, frames=6, min_ms=2200)

            st = await page.evaluate(STATE_JS)
            emit(f'  固定条件  tier={st["tier"]} pixelRatio={st["pixelRatio"]} size={st["size"]} '
                 f'tone={st["toneMapping"]} exp={st["exposure"]}')
            emit(f'            bloom(enabled={st["bloomEnabled"]} strength={st["bloomStrength"]} '
                 f'threshold={st["bloomThreshold"]} radius={st["bloomRadius"]})')

            # ---------------- ① 场景清点 ----------------
            cen = await page.evaluate(CENSUS_JS)
            emit(f'\n  ① 场景清点 —— {cen["name"]}（{cen["level"]}）')
            emit(f'  {"对象":<22}{"类型":<9}{"点数":>9}{"size":>8}{"不透明":>8}{"顶点色":>7}{"有贴图":>7}'
                 f'  半径范围')
            emit('  ' + '-' * 94)
            for it in cen['items']:
                nm = (it['name'] or '(无名)')[:20]
                cnt = it.get('count')
                cnt = '' if cnt is None else str(cnt)
                sz = it.get('size')
                sz = '' if sz is None else f'{sz:.3f}'
                op = it.get('opacity')
                op = '' if op is None else f'{op:.2f}'
                vc = '' if it.get('vertexColors') is None else ('是' if it['vertexColors'] else '否')
                mp = '' if it.get('hasMap') is None else ('是' if it['hasMap'] else '否')
                rr = ''
                if it.get('rMin') is not None:
                    rr = f'{it["rMin"]} … {it["rMax"]}'
                if it.get('geoRadius') is not None:
                    rr = f'球半径 {it["geoRadius"]}'
                if it.get('scaleXY'):
                    rr = f'scale {it["scaleXY"][0]:.3f}'
                if it.get('multi'):
                    rr = f'{it["multi"]} 个材质'
                flag = '  [默认隐藏]' if not it['visible'] and not it['hiddenBy'] else ''
                if it['hiddenBy']:
                    flag = '  [父级隐藏]'
                emit(f'  {nm:<22}{it["type"]:<9}{cnt:>9}{sz:>8}{op:>8}{vc:>7}{mp:>7}  {rr}{flag}')
            emit(f'  标签数（DOM，不吃曝光）：{cen["labelCount"]}')

            # ---------------- ② 数据对照 ----------------
            dat = await page.evaluate(DATA_JS)
            emit(f'\n  ② 数据对照 —— 数据集里 level==="{dat["level"]}" 的天体')
            emit(f'  总数 {dat["total"]} · 有坐标 {dat["placed"]} · type 分布 {dat["byType"]}')
            emit(f'  场景里带 bodyId 的对象 {dat["drawnAnyBody"]} 个，其中属于本层的天体 '
                 f'**{dat["drawnMineCount"]} / {dat["total"]}**')
            emit(f'  画了的样本   {dat["drawnMineSample"]}')
            emit(f'  没画的样本   {dat["undrawnSample"]}')
            if dat['radii']:
                emit(f'  三维半径分位 {dat["radii"]}')

            # ---------------- ④ 结构落点 ----------------
            fp = await page.evaluate(FOOTPRINT_JS)
            emit(f'\n  ④ 落点 —— 相机 {fp["camPos"]} 距目标 {fp["dist"]}，视口 {fp["w"]}×{fp["h"]}')
            if fp['hits']:
                onscr = [h for h in fp['hits'] if 0 <= h['x'] < fp['w'] and 0 <= h['y'] < fp['h']]
                emit(f'  带 bodyId 的对象落在视口内的 {len(onscr)} / {len(fp["hits"])}')
                for h in fp['hits'][:20]:
                    emit(f'     {h["id"]:<22}{h["type"]:<9}px=({h["x"]:>5},{h["y"]:>5}) '
                         f'r={h["r"]:<9} scale={h["scale"]}')
            else:
                emit('  ⚠ 场景里**一个带 bodyId 的对象都没有** —— 这一层没有任何可点天体')

            # ---------------- ③ 像素统计（含噪声地板） ----------------
            p1 = await shoot(page, f'_uvc-{lv}-a.png')
            p2 = await shoot(page, f'_uvc-{lv}-b.png')
            nf = diff_report(p1, p2)
            emit(f'\n  ③ 像素统计（已关 #labels）')
            emit(f'  噪声地板（同状态连拍两张）：identical={nf["identical"]} '
                 f'maxDiff={nf["maxDiff"]} 变化像素={nf["changedPct"]}%')
            if not nf['identical'] and nf['maxDiff'] > 6:
                emit('  ⚠ 噪声地板不干净 —— 画面在动（动画/呼吸装饰），下面的数字含不可控变量')
            rep = pixel_report(p1, lv)
            print_pixel_report(rep)
            reports[lv] = rep

        # ---------------- 对照小结 ----------------
        if len(reports) == 2:
            emit('\n' + '=' * 96)
            emit('  ⑤ 对照小结 —— 同一套量具，两个层')
            emit('=' * 96)
            emit(f'  {"层":<14}{"均值":>8}{"p90":>8}{"p99":>8}{"近黑(<8)":>10}{"亮(>=60)":>10}')
            for k, v in reports.items():
                emit(f'  {k:<14}{v["mean"]:>8}{v["p90"]:>8}{v["p99"]:>8}'
                     f'{v["hist"]["<8"]:>10}{v["hist"][">=60"]:>10}')
            emit('=' * 96)

        sys.stdout.flush()
        srv.stop()
        arm_hard_exit(14, 0)
        try:
            await asyncio.wait_for(browser.close(), timeout=8)
        except Exception as e:
            emit(f'  ⚠ 关浏览器没在 8 秒内回来（结论已落盘，由看门狗收尾）：{type(e).__name__}')
    return 0


async def main():
    global srv
    srv = ServedCheck(tag='可观测宇宙内容探针')
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

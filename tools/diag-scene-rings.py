"""诊断：枚举某一层场景里的**线**对象（环 / 曲线）与网格对象，定位「画面里那个圈」是谁。

为什么要有这个脚本：用户报「这些超大天体集合体下的这个圈啥情况，恒星上也有，都去了」，
而**照着截图猜是哪段代码画的，猜了四轮都不对**（本星系群层 `build()` 里根本没有 `makeRingMarker`，
galaxy 层里也只有 4 个同心标尺环 + 臂线）。⇒ 改成实测：把场景里每个对象的
**局部半径 / 世界坐标 / 材质颜色与不透明度 / 投影到屏幕后的半径 px** 全部打出来，
一屏就能对上「用户在图上看到的那个圈」。

用法：
    py -3.13 -X utf8 tools/diag-scene-rings.py http://127.0.0.1:8795/ --levels=localgroup,galaxy
    py -3.13 -X utf8 tools/diag-scene-rings.py http://127.0.0.1:8795/ --levels=neighborhood --outdir=shots

⚠️ 本脚本**只读**，不改场景（除了切层）。判据脚本不要 import 它。
"""
import argparse
import json
import os
import sys

from playwright.sync_api import sync_playwright

SHOTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "shots")

# 切层 + 等 build 完成
GOTO_JS = r"""
async (levelId) => {
  const e = window.__universe.engine;
  await e.goTo(levelId, { instant: true });
  let n = 0;
  while (!e.levels.get(levelId).built && n < 600) {
    await new Promise((r) => requestAnimationFrame(r));
    n++;
  }
  return { level: levelId, built: !!e.levels.get(levelId).built, waited: n, current: e.current ? e.current.id : null };
}
"""

# 枚举：线 / 网格 / 点数统计。**不碰场景**。
DIAG_JS = r"""
(levelId) => {
  const u = window.__universe;
  const e = u.engine;
  const lv = e.levels.get(levelId);
  if (!lv) return { level: levelId, err: '本层不在 engine.levels 里' };
  if (!lv.built) return { level: levelId, err: '本层尚未 build' };
  const cam = lv.camera;
  const el = e.renderer.domElement;
  const w = el.clientWidth, h = el.clientHeight;

  /* 屏幕半径：把「环心」与「环心 + 局部 +x·r」各投影一次，取两点的屏幕距离。
   * 本层对象都是直接 scene.add() 的顶层对象（没有父级变换），所以 o.position 就是世界坐标；
   * 这里仍然乘一次父级矩阵，为的是以后有人给它们套 Group 时不至于静默失效。 */
  const screenR = (o, r) => {
    const c = o.position.clone().applyMatrix4(o.parent ? o.parent.matrixWorld : o.matrixWorld);
    const p0 = c.clone().project(cam);
    const p1 = o.position.clone().set(r, 0, 0).applyQuaternion(o.quaternion).add(o.position)
      .applyMatrix4(o.parent ? o.parent.matrixWorld : o.matrixWorld).project(cam);
    return Math.round(Math.hypot((p1.x - p0.x) * w / 2, (p1.y - p0.y) * h / 2));
  };
  const screenXY = (o) => {
    const c = o.position.clone().applyMatrix4(o.parent ? o.parent.matrixWorld : o.matrixWorld);
    const p = c.clone().project(cam);
    return [Math.round((p.x * 0.5 + 0.5) * w), Math.round((-p.y * 0.5 + 0.5) * h)];
  };

  const lines = [], meshes = [], groups = [], sprites = [], points = [];
  let nSprite = 0, nPoints = 0, nLight = 0, nOther = 0;
  lv.scene.traverse((o) => {
    if (o.isLine) {
      const g = o.geometry;
      const n = (g && g.attributes && g.attributes.position) ? g.attributes.position.count : 0;
      let r = 0;
      if (n) {
        const a = g.attributes.position.array;
        for (let i = 0; i < n; i++) { const d = Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]); if (d > r) r = d; }
      }
      lines.push({
        name: o.name || null, verts: n, localR: +r.toFixed(4),
        color: (o.material && o.material.color) ? '#' + o.material.color.getHexString() : null,
        opacity: o.material ? o.material.opacity : null,
        screen: screenXY(o), screenR_px: screenR(o, r),
        parent: o.parent && o.parent.type !== 'Scene' ? (o.parent.name || o.parent.type) : null,
      });
    } else if (o.isMesh) {
      const g = o.geometry;
      const n = (g && g.attributes && g.attributes.position) ? g.attributes.position.count : 0;
      let r = 0;
      if (g && g.parameters && g.parameters.width) r = g.parameters.width / 2;
      else if (g && g.boundingSphere) r = g.boundingSphere.radius;
      else if (n) {
        const a = g.attributes.position.array;
        for (let i = 0; i < n; i++) { const d = Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]); if (d > r) r = d; }
      }
      meshes.push({
        name: o.name || null, geo: g ? g.type : null, verts: n, localR: +r.toFixed(4),
        color: (o.material && o.material.color) ? '#' + o.material.color.getHexString() : null,
        opacity: o.material ? o.material.opacity : null,
        screen: screenXY(o), screenR_px: screenR(o, r),
        parent: o.parent && o.parent.type !== 'Scene' ? (o.parent.name || o.parent.type) : null,
      });
    } else if (o.isSprite) {
      nSprite++;
      /* sprite 的「世界半径」取 scale（`makeSprite` 把尺寸写进 scale）*/
      const r = Math.abs(o.scale.x) / 2;
      if (r > 0) {
        sprites.push({
          name: o.name || null, worldR: +r.toFixed(3),
          color: (o.material && o.material.color) ? '#' + o.material.color.getHexString() : null,
          opacity: o.material ? o.material.opacity : null,
          screen: screenXY(o), screenR_px: screenR(o, r),
          parent: o.parent && o.parent.type !== 'Scene' ? (o.parent.name || o.parent.type) : null,
        });
      }
    } else if (o.isPoints) {
      nPoints++;
      const g = o.geometry;
      try { if (g && !g.boundingSphere) g.computeBoundingSphere(); } catch (e) { /* 空几何 */ }
      const r = (g && g.boundingSphere) ? g.boundingSphere.radius : 0;
      points.push({
        name: o.name || null, verts: (g && g.attributes && g.attributes.position) ? g.attributes.position.count : 0,
        worldR: +r.toFixed(3), size: o.material ? o.material.size : null,
        opacity: o.material ? o.material.opacity : null,
        screen: screenXY(o), screenR_px: screenR(o, r),
        parent: o.parent && o.parent.type !== 'Scene' ? (o.parent.name || o.parent.type) : null,
      });
    }
    else if (o.isLight) nLight++;
    else if (o.isGroup) groups.push({ name: o.name || null, children: o.children.length });
    else nOther++;
  });

  /* 标签：DOM 层，但登记表是同步事实 —— 用来对照「图上那几个文字」是谁。 */
  const labelIds = lv.labels && lv.labels.items ? [...lv.labels.items.keys()] : null;
  const labelVisible = [];
  if (lv.labels && lv.labels.items) {
    for (const [k, v] of lv.labels.items) {
      const elt = v && v.el ? v.el : null;
      if (elt && elt.parentNode && elt.style && elt.style.display !== 'none' && elt.style.visibility !== 'hidden') labelVisible.push(k);
    }
  }

  return {
    level: lv.id,
    counts: { sprite: nSprite, points: nPoints, light: nLight, other: nOther, groups: groups.length },
    groups,
    lines, meshes, sprites, points,
    labels: { registered: labelIds ? labelIds.length : null, visible: labelVisible.length, visibleIds: labelVisible },
    camera: { pos: [+cam.position.x.toFixed(3), +cam.position.y.toFixed(3), +cam.position.z.toFixed(3)], dist: +cam.position.length().toFixed(3) },
    canvas: [w, h],
  };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    ap.add_argument("--levels", default="localgroup,galaxy")
    ap.add_argument("--outdir", default=SHOTS)
    ap.add_argument("--limit", type=int, default=40, help="每条列表最多打印多少行（按屏幕半径降序）")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    levels = [s.strip() for s in args.levels.split(",") if s.strip()]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--enable-unsafe-swiftshader",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ])
        page = browser.new_page(viewport={"width": 1680, "height": 940}, device_scale_factor=1)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.goto(args.url, wait_until="load", timeout=60000)
        page.wait_for_function("() => !!window.__universe && !!window.__universe.engine", timeout=90000)
        # ⚠️ 必须等**加载屏散掉**再量。第一次跑这个脚本时没等，
        #   截图里还是「小小宇宙 · 霍金第一版」的加载层，标签层一行都没上屏，
        #   量到的相机位姿也不是默认视角 —— 读数全是加载中途的快照。
        #   信号取自 `main.js`：`bootEl.classList.add('done')` 后再 800ms 隐藏。
        page.wait_for_function(
            "() => { const b = document.getElementById('boot'); return !!b && (b.classList.contains('done') || b.style.display === 'none'); }",
            timeout=180000,
        )
        page.wait_for_timeout(1500)

        for lv in levels:
            got = page.evaluate(GOTO_JS, lv)
            print(f"\n=== 层 {lv} ===")
            print(f"  切层 {json.dumps(got, ensure_ascii=False)}")
            d = page.evaluate(DIAG_JS, lv)
            if d.get("err"):
                print(f"  ! {d['err']}")
                continue
            print(f"  画布 {d['canvas']} · 相机 距原点 {d['camera']['dist']} · 位置 {d['camera']['pos']}")
            print(f"  对象统计 {json.dumps(d['counts'], ensure_ascii=False)}")
            if d.get("groups"):
                print(f"  Group: {json.dumps(d['groups'], ensure_ascii=False)}")
            print(f"  标签：登记 {d['labels']['registered']} · 上屏 {d['labels']['visible']}")
            if d["labels"].get("visibleIds"):
                print(f"    上屏 id：{', '.join(d['labels']['visibleIds'][:30])}")

            for kind in ("lines", "meshes", "points", "sprites"):
                rows = sorted(d[kind] or [], key=lambda r: -r["screenR_px"])
                if not rows:
                    print(f"  [{kind}] 无")
                    continue
                # 同族且屏幕半径相同的（例如 4745 个一模一样的系外行星环）**合并成一条**，
                # 否则一屏全是同一行 —— 数量才是这一族的关键信息。
                merged = {}
                for r in rows:
                    key = (r.get("color"), r.get("opacity"), r.get("localR", r.get("worldR")), r["screenR_px"])
                    merged.setdefault(key, []).append(r)
                print(f"  [{kind}] 共 {len(d[kind])} 个，去重后 {len(merged)} 族（按屏幕半径降序，前 {args.limit}）：")
                for key, grp in sorted(merged.items(), key=lambda kv: -kv[0][3])[: args.limit]:
                    r = grp[0]
                    extra = f"{len(grp)} 个同族" if len(grp) > 1 else ""
                    print(f"    {r['screenR_px']:>5} px  r={r.get('localR', r.get('worldR')):<9} "
                          f"{(r.get('geo') or r.get('size') or 'Line')!s:<12} {r.get('color') or '—'} "
                          f"op={r.get('opacity')}  "
                          f"@{r['screen']}  {'parent=' + str(r['parent']) + ' ' if r['parent'] else ''}"
                          f"{r['name'] or '(无名)'} {extra}")
            page.screenshot(path=os.path.join(args.outdir, f"diag-{lv}.png"))

        if errs:
            print("\n  控制台错误")
            for e in errs[:10]:
                print("    !", e[:200])
        else:
            print("\n  控制台错误 0 条")
        browser.close()


if __name__ == "__main__":
    main()

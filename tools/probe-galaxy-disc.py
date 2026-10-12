#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本星系群：星系盘到底是**有固定朝向的盘**，还是**永远面向屏幕的贴纸**。

## 为什么必须量活的

用户原话：「你这个本星系群的没改，而且转动的时候他**始终面向屏幕**」。

根因在源码里就能看见：`cosmos.js` 原来用 `makeGalaxySprite` 造成员星系，
而它内部是 `new THREE.Sprite(...)` —— **Sprite 天生是 billboard**：
朝向完全由相机决定，`lookAt()` 挂在 Sprite 上**不产生任何效果**
（那里原来那句 `spr.lookAt(0, 0, 0)` 是死代码）。
所以那不是"感觉不对"，是**它本来就这么渲的**。

修没修好，只能在这里量 —— 而且要量的是**「转动视角时形状会不会变」**：
· 有固定朝向的盘：转过去会看到侧视，视轴比从 1 变到 ≈0；
· billboard：**任何视角下视轴比恒等于 1**。

## 判据（每条都要能响）

① **阳性对照**：确实在 localgroup 层、成员对象数 > 0。不做这条，
   后面「Sprite 数 == 0」可能只是因为一个成员都没建 —— 那是个不会响的判据。
② 成员里 **Mesh 数 == 成员数**、**Sprite 数 == 0**。
③ 建出来的几何是 `PlaneGeometry`（是"盘面"，不是随手一个网格）。
④ 三个**有实测倾角**的成员，从原点看过去的**实测倾角 == 数据里的 `incl`**（容差 0.6°）：
   M31 = 77°（Walterbos & Kennicutt 1988）· M33 = 49°（Corbelli & Schneider 1997）·
   LMC = 35°（van der Marel & Cioni 2001）。
   ⚠️ 期望值取自**数据文件**，不是从公式反推 —— 否则就是拿公式验公式。
⑤ M31 从原点看过去的**视轴比 == cos(77°) = 0.2250**（容差 0.01）。
⑥ **判别力**：取盘面自己的两个基做视点 ——
   沿**法线**看（应得视轴比 ≈1）与沿**长轴**看（应得 ≈0），两者之差应 > 0.9。
   ⚠️ 视角是**从对象自己的世界矩阵**算出来的，不改对象、也不重算朝向。
⑦ **判据自证（注入 billboard）**：往场景里临时塞一个 `THREE.Sprite`（用现成背景精灵的
   材质克隆），**同一对视角**下量它 —— 视轴比之差必须 ≈0。
   这条是**必需的**：它证明 ⑥ 真的能把「有朝向的盘」和「billboard」分开。
   不做这一步，⑥ 通过也可能只是判据本身不会响（本项目栽过好几次）。
⑧ 背景远景星系**仍是有意保留的 billboard**（`Sprite` 数 > 0）——
   防止后来人"顺手统一"，把那条有意的设计改掉。
⑨ **贴图外缘的 alpha 径向剖面 —— 只打印，故意不计入判据。**
   ⚠️ 第一版拿它当判据（外缘 alpha < 0.5×内侧）是**假绿**：这条下降分不清
   「贴图级的 `destination-in` 外缘渐隐」与「旋臂自己的末端渐隐」，
   而后者是**必需**的一步（坑 98），同样会把外缘 alpha 压下去
   ⇒ **把 `destination-in` 整段删掉，这条判据照样绿。**
   「渐隐这一步在不在」改由自检项 `textures.disc-edge-fade` 在**源码级**判。
   这正是本项目那条老规矩：判据要打在**被测量的那个动作**上。
⑩ 收尾：注入的精灵已移除、相机已复位。

用法：
    py -3.13 -X utf8 tools/probe-galaxy-disc.py
    py -3.13 -X utf8 tools/probe-galaxy-disc.py --shots
退出码：0 = 全部判据通过；1 = 有判据没过（或页面没起来）。

⚠️ **必须后台跑**（`run_in_background`）：本机的收割器会把整个前台进程树 SIGTERM 掉，
   日志会停在半路 —— 这个坑本次会话已经踩过两次。
跑之前建议先 node tools/clean-strays.mjs --apply。
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

BROWSER = 'edge'
HEADED = True
SHOTS_ON = False
for a in sys.argv[1:]:
    if a.startswith('--browser='):
        BROWSER = a.split('=', 1)[1]
    elif a.startswith('--headed='):
        HEADED = a.split('=', 1)[1].lower() not in ('0', 'false', 'no')
    elif a == '--shots':
        SHOTS_ON = True


# ---------------------------------------------------------------- 读取成员
READ_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  if (!lv) return { ok: false, why: '拿不到当前层' };
  if (lv.id !== 'localgroup') return { ok: false, why: '不在 localgroup 层：' + lv.id };
  const members = [];
  for (const [id, o] of lv.sprites) {
    const rec = u.dataset.get ? u.dataset.get(id) : null;
    members.push({
      id,
      isSprite: !!o.isSprite, isMesh: !!o.isMesh,
      geo: o.geometry ? o.geometry.type : null,
      pos: [o.position.x, o.position.y, o.position.z],
      // 期望倾角**取自数据文件**，不是从公式反推
      dataIncl: rec && rec.incl != null ? rec.incl : null,
      dataPa: rec && rec.pa != null ? rec.pa : null,
      dataPole: rec && rec.pole ? rec.pole.slice() : null,
    });
  }
  // 场景里还有多少 Sprite（= 有意保留 billboard 的背景远景那批）
  let sceneSprites = 0, sceneMeshes = 0;
  lv.scene.traverse((o) => { if (o.isSprite) sceneSprites++; else if (o.isMesh) sceneMeshes++; });
  return {
    ok: true, level: lv.id, built: !!lv.built,
    memberTotal: members.length, members,
    sceneSprites, sceneMeshes,
    camPos: [lv.camera.position.x, lv.camera.position.y, lv.camera.position.z],
  };
}
"""


# ------------------------------------------------- 量一个对象的「视轴比 + 倾角」
# ⚠️ 法线一律从对象**自己的世界矩阵**取（`matrixWorld` 的第三列 = 世界 +Z = 盘面法线），
#    不自己旋四元数 —— 那会变成「拿一套自己写的几何去验项目里的几何」。
#    Sprite 例外：它的 billboard 是着色器用 modelViewMatrix 做的，世界矩阵里看不出朝向，
#    所以按**定义**取「指向相机的方向」。
METRIC_JS = r"""
(o) => {
  const lv = window.__universe.engine.current;
  const cam = lv.camera;
  const P = [o.position.x, o.position.y, o.position.z];
  const len = Math.hypot(P[0], P[1], P[2]);
  const phat = len > 1e-12 ? [P[0] / len, P[1] / len, P[2] / len] : [0, 0, 1];
  const camP = [cam.position.x, cam.position.y, cam.position.z];
  const v = [camP[0] - P[0], camP[1] - P[1], camP[2] - P[2]];
  const vl = Math.hypot(v[0], v[1], v[2]) || 1;
  const vhat = [v[0] / vl, v[1] / vl, v[2] / vl];
  let n, basisX = null;
  if (o.isSprite) {
    n = vhat;                                   // billboard 的定义：法线永远指向相机
  } else {
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements;
    n = [e[8], e[9], e[10]];                    // 世界 +Z = 盘面法线
    basisX = [e[0], e[1], e[2]];                // 世界 +X = 长轴
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    const xl = Math.hypot(basisX[0], basisX[1], basisX[2]) || 1;
    basisX = [basisX[0] / xl, basisX[1] / xl, basisX[2] / xl];
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return {
    isSprite: !!o.isSprite,
    normal: n, axisX: basisX,
    ratioFromCamera: Math.abs(dot(n, vhat)),
    ratioFromOrigin: len > 1e-12 ? Math.abs(dot(n, phat)) : null,
    inclFromOrigin: len > 1e-12 ? Math.acos(Math.min(1, Math.abs(dot(n, phat)))) * 180 / Math.PI : null,
    camPos: camP,
  };
}
"""


# ------------------- 用**对象自己的两个基**造一对极端视角（沿法线 / 沿长轴）
def probe_pair_js(id_):
    """返回 {id, ok, ratioAlongNormal, ratioAlongAxis, delta, ...}

    视角位置 = 目标位置 ± 基向量 × |位置| —— 这样视向就精确等于该基向量，
    视轴比分别取到 1 与 0 两个端点，判别力最大。
    ⚠️ 这里只动**相机**，不动对象；也没有重算任何朝向。
    """
    return ("() => {"
            " const u = window.__universe; const lv = u.engine.current;"
            f" const o = lv.sprites.get({id_!r});"
            " if (!o) return { ok: false, why: '没有这个成员' };"
            " const P = [o.position.x, o.position.y, o.position.z];"
            " const len = Math.hypot(P[0],P[1],P[2]) || 1;"
            " const m0 = (" + METRIC_JS.strip() + ")(o);"
            " const n = m0.normal, X = m0.axisX;"
            " if (!X) return { ok: false, why: '这个对象没有可用的面内长轴（billboard）' };"
            " const at = (b) => [P[0] + b[0]*len, P[1] + b[1]*len, P[2] + b[2]*len];"
            " const back = () => lv.applyView({ position: [P[0]*3.2, P[1]*3.2, P[2]*3.2], target: [0,0,0] });"
            " const out = {};"
            " lv.applyView({ position: at(n), target: P });"
            " out.ratioAlongNormal = (" + METRIC_JS.strip() + ")(o).ratioFromCamera;"
            " lv.applyView({ position: at(X), target: P });"
            " out.ratioAlongAxis = (" + METRIC_JS.strip() + ")(o).ratioFromCamera;"
            " back();"
            " out.ok = true; out.delta = Math.abs(out.ratioAlongNormal - out.ratioAlongAxis);"
            " return out;"
            " }")


# ------------------------------------------- 注入一个 billboard，自证判据会响
INJECT_JS = r"""
(id) => {
  const u = window.__universe;
  const lv = u.engine.current;
  const target = lv.sprites.get(id);
  if (!target) return { ok: false, why: '没有这个成员' };
  // 借一个现成的 Sprite（背景远景那批）来克隆材质 —— 不去 import three，
  // 也不自己造一套渲染路径：注入的东西必须和线上那批**同源**。
  let sample = null;
  lv.scene.traverse((o) => { if (!sample && o.isSprite) sample = o; });
  if (!sample) return { ok: false, why: '场景里没有可借用的 Sprite' };
  const s = new sample.constructor(sample.material.clone());
  s.scale.copy(sample.scale);
  s.position.copy(target.position);
  lv.scene.add(s);
  window.__probeInjected = s;
  return { ok: true, injected: true };
}
"""

REMOVE_INJECTED_JS = r"""
() => {
  const s = window.__probeInjected;
  if (!s) return { ok: true, removed: false };
  s.parent && s.parent.remove(s);
  s.material && s.material.dispose && s.material.dispose();
  window.__probeInjected = null;
  return { ok: true, removed: true };
}
"""

# ------------------------------------------------ 贴图外缘渐隐（读 canvas 像素）
EDGE_FADE_JS = r"""
(id) => {
  const lv = window.__universe.engine.current;
  const o = lv.sprites.get(id);
  const tex = o && o.material && o.material.map;
  const cv = tex && tex.image;
  if (!cv || !cv.getContext) return { ok: false, why: '拿不到贴图 canvas' };
  const g = cv.getContext('2d');
  const S = cv.width;
  const cx = S / 2, cy = S / 2;
  const bins = 20;                       // 按半径分 20 个环带，统计 alpha 均值
  const sum = new Array(bins).fill(0), cnt = new Array(bins).fill(0);
  const step = Math.max(1, Math.floor(S / 160));
  for (let y = 0; y < S; y += step) {
    for (let x = 0; x < S; x += step) {
      const r = Math.hypot(x - cx, y - cy) / (S / 2);   // 归一化到 0..1（相对半宽）
      const b = Math.min(bins - 1, Math.floor(r * bins));
      const a = g.getImageData(x, y, 1, 1).data[3] / 255;
      sum[b] += a; cnt[b]++;
    }
  }
  const prof = sum.map((v, i) => cnt[i] ? v / cnt[i] : 0);
  const at = (f) => prof[Math.min(bins - 1, Math.floor(f * bins))];
  /* ⚠️ 采样点必须落在**渐隐区间里面**，否则判据是假绿：
   *    旋涡盘的真实半径 = 贴图半宽的 0.92（maxR = size*0.46），
   *    而渐隐是从 0.63 走到 0.92 —— 所以取 0.60（区间外，应≈满）与 0.85（区间内，应显著更低）。
   *    早先取 0.95R 是错的：那里已经在盘**外面**，有没有渐隐都是 0，判据永远通过。 */
  return { ok: true, size: S, prof: prof.map((v) => +v.toFixed(4)),
           b12: at(0.625), b17: at(0.875), b19: at(0.975),
           a70: at(0.70), a95: at(0.95), a99: at(0.99) };
}
"""


def judge(name, cond, extra=''):
    emit(f'  {"✓" if cond else "✗"} {name}{("  —— " + extra) if extra else ""}')
    return bool(cond)


async def main():
    srv = ServedCheck(tag='本脚本')
    base = srv.start()
    checks = []
    try:
        async with async_playwright() as pw:
            launch = {'channel': 'msedge'} if BROWSER == 'edge' else (
                {'channel': 'chrome'} if BROWSER == 'chrome' else {})
            try:
                browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS, **launch)
            except Exception as e:
                emit(f'  ✗ 起浏览器失败（{BROWSER}）：{e}')
                browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)
            page = await browser.new_page(viewport={'width': 1400, 'height': 860})
            page.on('console', lambda m: m.type == 'error' and emit(f'  ! {m.text[:160]}'))

            emit(f'\n打开 {base}/ …')
            await page.goto(base + '/', wait_until='load')
            try:
                await page.wait_for_function(
                    'window.__universe && window.__universe.engine && window.__universe.dataset',
                    timeout=60000)
            except Exception:
                emit('  ✗ 60 秒内没等到 window.__universe.dataset')
                await browser.close()
                return 1
            await page.wait_for_timeout(2500)

            emit('  切到「本星系群」层 …')
            await page.evaluate("window.__universe.gotoScale('localgroup')")
            try:
                await page.wait_for_function(
                    "window.__universe.engine.current && window.__universe.engine.current.id === 'localgroup'"
                    " && window.__universe.engine.current.built", timeout=60000)
            except Exception:
                emit('  ✗ 本星系群层 60 秒内没建好')
                await browser.close()
                return 1
            await page.wait_for_timeout(1500)

            info = await page.evaluate(READ_JS)
            if not info.get('ok'):
                emit(f'  ✗ 读不到本层：{info.get("why")}')
                await browser.close()
                return 1

            emit('\n【普查】本星系群这一层画了什么')
            emit(f'  成员对象 {info["memberTotal"]} 个 · 场景里 Sprite {info["sceneSprites"]}'
                 f' / Mesh {info["sceneMeshes"]}')
            mesh_n = sum(1 for m in info['members'] if m['isMesh'])
            sprite_n = sum(1 for m in info['members'] if m['isSprite'])
            planes = sum(1 for m in info['members'] if m['geo'] == 'PlaneGeometry')
            emit(f'  成员里 Mesh {mesh_n} · Sprite {sprite_n} · 几何是 PlaneGeometry 的 {planes}')
            with_incl = [m for m in info['members'] if m['dataIncl'] is not None]
            emit(f'  有实测倾角的成员：{len(with_incl)} 个 —— '
                 + ' · '.join(f'{m["id"]}(i={m["dataIncl"]}°,PA={m["dataPa"]}°)' for m in with_incl))

            emit('\n① 阳性对照')
            checks.append(judge('确实在 localgroup 层', info['level'] == 'localgroup', info['level']))
            checks.append(judge('成员对象数 > 0（否则后面的判据都是空转）',
                                info['memberTotal'] > 0, f'{info["memberTotal"]} 个'))

            emit('\n② 成员必须是「盘」，不是 billboard')
            checks.append(judge('成员全部是 Mesh（Sprite 数 == 0）',
                                sprite_n == 0 and mesh_n == info['memberTotal'],
                                f'Mesh {mesh_n} · Sprite {sprite_n}'))
            checks.append(judge('几何是 PlaneGeometry（确实是个盘面）',
                                planes == info['memberTotal'], f'{planes}/{info["memberTotal"]}'))

            emit('\n③ 三个有实测倾角的成员：从原点看过去的倾角 == 数据里的 incl')
            TOL_DEG = 0.6
            for m in with_incl:
                met = await page.evaluate(
                    "(id)=>{const lv=window.__universe.engine.current;return (" + METRIC_JS.strip()
                    + ")(lv.sprites.get(id));}", m['id'])
                got = met['inclFromOrigin']
                if got is None:
                    checks.append(judge(f'{m["id"]} 倾角可测', False, '原点处视向退化（位置为 0）'))
                    continue
                ok = abs(got - m['dataIncl']) < TOL_DEG
                checks.append(judge(
                    f'{m["id"]} 实测倾角 {got:.2f}° == 数据 {m["dataIncl"]}°',
                    ok, f'差 {abs(got - m["dataIncl"]):.2f}°（容差 {TOL_DEG}°）'))

            emit('\n④ M31 从原点看过去的视轴比 == cos(77°) = 0.2250')
            if any(m['id'] == 'm31' for m in info['members']):
                met = await page.evaluate(
                    "(id)=>{const lv=window.__universe.engine.current;return (" + METRIC_JS.strip()
                    + ")(lv.sprites.get('m31'));}")
                r = met['ratioFromOrigin']
                checks.append(judge('M31 视轴比 == cos(77°)', abs(r - 0.22495) < 0.01,
                                    f'实测 {r:.4f}（期望 0.2250）'))
            else:
                checks.append(judge('M31 在成员里', False, '找不到 m31 —— 判据空转'))

            emit('\n⑤ 判别力：沿法线看 vs 沿长轴看，视轴比之差应 > 0.9')
            pair = await page.evaluate(probe_pair_js('m31'))
            if not pair.get('ok'):
                checks.append(judge('能造出这对视角', False, pair.get('why', '')))
            else:
                emit(f'  沿法线 {pair["ratioAlongNormal"]:.4f} · 沿长轴 {pair["ratioAlongAxis"]:.4f}'
                     f' · 差 {pair["delta"]:.4f}')
                checks.append(judge('盘面在两种视角下形状**明显不同**（不是 billboard）',
                                    pair['delta'] > 0.9, f'差 {pair["delta"]:.4f}'))

            emit('\n⑥ 判据自证：注入一个 billboard，同一对视角下它必须**不变**')
            inj = await page.evaluate(INJECT_JS, 'm31')
            if not inj.get('ok'):
                checks.append(judge('能注入 billboard（自证这一步不能省）', False, inj.get('why', '')))
            else:
                # 注入的对象没有 lv.sprites 条目，直接把临时句柄塞进 sprites 再去量
                pair2 = await page.evaluate(
                    "() => { const lv = window.__universe.engine.current;"
                    " const o = window.__probeInjected;"
                    " const P = [o.position.x, o.position.y, o.position.z];"
                    " const len = Math.hypot(P[0],P[1],P[2]) || 1;"
                    " const disc = lv.sprites.get('m31');"
                    " disc.updateWorldMatrix(true,false);"
                    " const e = disc.matrixWorld.elements;"
                    " const Z=[e[8],e[9],e[10]], X=[e[0],e[1],e[2]];"
                    " const nm=v=>{const l=Math.hypot(...v)||1;return v.map(c=>c/l);};"
                    " const nz=nm(Z), nx=nm(X);"
                    " const at=b=>[P[0]+b[0]*len, P[1]+b[1]*len, P[2]+b[2]*len];"
                    " const M = " + METRIC_JS.strip() + ";"
                    " lv.applyView({position: at(nz), target: P}); const r1 = M(o).ratioFromCamera;"
                    " lv.applyView({position: at(nx), target: P}); const r2 = M(o).ratioFromCamera;"
                    " lv.applyView({position:[P[0]*3.2,P[1]*3.2,P[2]*3.2], target:[0,0,0]});"
                    " return { ok:true, r1, r2, delta: Math.abs(r1-r2) }; }")
                emit(f'  billboard 在同样两种视角下：{pair2["r1"]:.4f} → {pair2["r2"]:.4f}'
                     f' · 差 {pair2["delta"]:.4f}')
                checks.append(judge('billboard 的视轴比**不随视角变化**（判据真的会响）',
                                    pair2['delta'] <= 0.05, f'差 {pair2["delta"]:.4f}'))
                checks.append(judge('同一次运行里，盘面(⑤)与 billboard(⑥)读数**明显不同**',
                                    pair['ok'] and pair['delta'] - pair2['delta'] > 0.5,
                                    f'{pair.get("delta", 0):.4f} vs {pair2["delta"]:.4f}'))
                rem = await page.evaluate(REMOVE_INJECTED_JS)
                checks.append(judge('注入的精灵已移除（探针不许污染现场）', rem.get('removed') is not False))

            emit('\n⑦ 背景远景星系仍是**有意保留**的 billboard')
            checks.append(judge('场景里仍有 Sprite（背景远景那批，别顺手统一掉）',
                                info['sceneSprites'] > 0, f'{info["sceneSprites"]} 个'))

            emit('\n⑧ 贴图外缘的 alpha 径向剖面（**只打印，不算判据** —— 理由见下）')
            if any(m['id'] == 'm31' for m in info['members']):
                ef = await page.evaluate(EDGE_FADE_JS, 'm31')
                if not ef.get('ok'):
                    emit(f'  （读不到盘面贴图像素：{ef.get("why")}）')
                else:
                    emit(f'  alpha 径向剖面（0→1 共 20 环带）：{ef["prof"]}')
                    emit(f'  0.625R 处 {ef["b12"]:.4f} · 0.875R 处 {ef["b17"]:.4f}'
                         f' · 0.975R 处 {ef["b19"]:.4f}')
                    emit('  ⚠️ **这一条故意不计入判据**：这条下降分不清「贴图级的 destination-in')
                    emit('     外缘渐隐」和「旋臂自己的末端渐隐」—— 后者是**必需**的一步')
                    emit('     （坑 98：末端不渐隐的臂会封口成环），而它同样让外缘 alpha 掉下去。')
                    emit('     第一版拿它当判据，读出来「通过」是**假绿**：把 destination-in')
                    emit('     整段删掉，这条判据照样绿。所以「渐隐这一步在不在」改由')
                    emit('     自检项 `textures.disc-edge-fade` 在**源码级**判（删了就红）。')

            if SHOTS_ON:
                if not os.path.isdir(SHOTS):
                    os.makedirs(SHOTS, exist_ok=True)
                await page.evaluate("window.__universe.engine.current.applyView("
                                    "{position:[2.2,1.7,4.2], target:[0,0,0]})")
                await page.wait_for_timeout(700)
                await page.screenshot(path=os.path.join(SHOTS, '_galaxy-disc.png'))

            await browser.close()
    finally:
        srv.stop()

    ok_n = sum(1 for c in checks if c)
    emit(f'\n{"=" * 78}')
    emit(f'  通过 {ok_n}/{len(checks)}')
    if ok_n == len(checks):
        emit('  ✓ 本星系群的成员星系是**有固定朝向的盘**：转动视角能看出侧视；')
        emit('    三个有实测倾角的成员与文献值一致；注入 billboard 做对照时判据会响。')
    else:
        emit('  ✗ 有判据没过 —— 见上面带 ✗ 的行。')
    emit(f'{"=" * 78}')
    return 0 if ok_n == len(checks) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))

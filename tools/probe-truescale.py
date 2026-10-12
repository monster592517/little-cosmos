#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实比例开关探针：拨一次「真实比例」，引擎到底被拖着做了多少事？

为什么需要这个
--------------
症状是「切换真实比例的时候会卡」。而卡顿只是**结果**，真因在调用方式上：

    engine.js:604   if ('trueScale' in opts) for (const lv of this.levels.values()) lv.setTrueScale?.(opts.trueScale);
    solar.js:859    setTrueScale(v) { ...; this.rebuild(); }        // 无条件全区重建
    solar.js:878    this.ctx.engine?._attachControls(this);         // ← 顺手把全局控制器挂到自己头上

于是出现两个独立的问题，**在邻近恒星系上拨开关时同时发生**：

  1. 白白重建一遍太阳系。太阳系层在邻近恒星系层并没有被释放（`_trimLevels` 保留相邻 ±1 层），
     所以它「存在」，但**存在不等于要被看见**。用户看不见的东西重建一次，纯亏。
  2. 更严重的：`_attachControls` 会把 `engine.controls` 重新指向**这个层的相机**。
     于是在邻近恒星系上拨一下开关，OrbitControls 就被悄悄挂到不可见的太阳系相机上，
     当前这一层的控制器被 `dispose()` 掉 —— 表现是「拖不动了 / 拖起来在转别的东西」。

第 2 条没有任何异常、没有日志，只有「手感不对」。所以这里不读代码结构，只问**运行中的事实**。

四条判据
--------  A 重建次数  非当前层拨开关，该层的 `rebuilds` 增量必须为 **0**；
              当前层就是该层时，增量必须 **恰好 2**（开一次、关一次各一次）。
              ⚠️ **两个方向都卡**：只卡「必须为 0」的话，「干脆别重建了」也会通过 ——
                 而那会让开关彻底失效，是个更坏的 bug。
              计数器只挂在太阳系层上，因为**它是这项设置唯一的消费者**；
              别的层没有 setTrueScale，也就没有"被白重建"这回事。
  B 切换耗时  以毫秒计上限。性能是硬指标，但毫秒在本机（软件渲染 + 内存吃紧）抖得厉害，
              所以它只是**兜底**，主判据是 A 的「重建次数」这个结构事实。
  C 控制器归属 `engine.controls` 必须属于**当前层**。这一条是那件没人看得见的事故的判据。
  D 过渡途中   判据 A/B/C 都是"落定之后才拨"。这一条**掐在过渡动画途中拨**，
              落层之后场景必须已经是新口径 —— 防的是**延迟重建自己引入的那个洞**：
              延迟 = 欠账，欠了账没人补，场景就会一直停在旧口径，而且不报错。
              读数直接看**场景里的数**（`entries.earth.r`），不看标志位。

判据 A 依赖 `solar.rebuilds` 这个计数器（页面上的 instrumentation）。
**取不到就判失败、不继续** —— 否则计数器没了，A 会恒等于 0 而报「合规」，
那正是这类探针最经典的撒谎方式。

用法
----
    py -3.13 -X utf8 tools/probe-truescale.py
    py -3.13 -X utf8 tools/probe-truescale.py --level=neighborhood
    py -3.13 -X utf8 tools/probe-truescale.py --selftest     # 故障注入：A/B/C 三条都验它会响
    py -3.13 -X utf8 tools/probe-truescale.py --json
退出码：0 = 全部合规；1 = 有判据不合规 / 页面没起来。
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck, emit   # noqa: E402

ARGV = sys.argv[1:]
JSON_OUT = '--json' in ARGV
SELFTEST = '--selftest' in ARGV
PROFILE = '--profile' in ARGV
ONLY = None
for a in ARGV:
    if a.startswith('--level='):
        ONLY = a.split('=', 1)[1]

TIERS = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe']

# 当前层**就是**太阳系时，重建是必然的，只设一个"别离谱"的上限兜底。
# 别的层上，这次切换不该产生任何重建工作，所以压得很紧。
MS_CAP_SELF = 3000
MS_CAP_OTHER = 80

MEASURE_JS = r"""
() => {
  const u = window.__universe, e = u.engine;
  const cur = e.current;
  const solar = e.levels.get('solar');
  if (!cur) return { error: '没有当前层' };
  if (!solar) return { error: 'levels 里没有 solar' };
  if (typeof solar.rebuilds !== 'number') {
    return { error: 'solar.rebuilds 计数器不存在 —— 判据 A 会恒等于 0 而假报合规，本次读数不可信' };
  }

  // 控制器现在挂在哪个层的相机上？返回层名，别返回 true/false ——
  // 「挂错了」的时候，人要立刻知道**挂到谁身上去了**。
  const ownerOf = (c) => {
    if (!c) return null;
    for (const [id, lv] of e.levels) if (lv.camera === c.object) return id;
    return 'unknown';
  };

  const snap = () => ({
    rebuilds: solar.rebuilds,
    ctrlOwner: ownerOf(e.controls),
    ctrlIsCurrent: !!(cur.controls && e.controls && cur.controls === e.controls),
    ctrlEnabled: e.controls ? e.controls.enabled : null,
  });

  const before = snap();
  const tOn = performance.now();
  e.setOptions({ trueScale: true });
  const msOn = performance.now() - tOn;
  const mid = snap();
  const tOff = performance.now();
  e.setOptions({ trueScale: false });
  const msOff = performance.now() - tOff;
  const after = snap();

  return {
    level: cur.id,
    isSolar: cur.id === 'solar',
    solarBuilt: !!solar.built,
    msOn: Math.round(msOn * 10) / 10,
    msOff: Math.round(msOff * 10) / 10,
    rebuildDelta: (mid.rebuilds - before.rebuilds) + (after.rebuilds - mid.rebuilds),
    before, after,
  };
}
"""


def judge(r):
    """把一条读数判成 (通过?, 一句话)。判据和读数分开写，方便 selftest 复用。"""
    bad = []
    if 'error' in r:
        return False, r['error']

    if r['isSolar']:
        # 当前层就是太阳系：开一次 + 关一次 = 恰好 2 次重建。
        # 少于 2 说明开关没生效（比卡顿更坏的 bug），多于 2 说明有重复重建。
        if r['rebuildDelta'] != 2:
            bad.append(f"当前层就是太阳系，重建增量应为 2（开+关各一次），实测 {r['rebuildDelta']}")
    else:
        if r['rebuildDelta'] != 0:
            bad.append(
                f"当前层是 {r['level']}，太阳系并未被显示，却被重建了 {r['rebuildDelta']} 次")

    cap = MS_CAP_SELF if r['isSolar'] else MS_CAP_OTHER
    worst = max(r['msOn'], r['msOff'])
    if worst > cap:
        bad.append(f"setOptions 耗时 {worst}ms 超过上限 {cap}ms（开 {r['msOn']} / 关 {r['msOff']}）")

    if r['after']['ctrlOwner'] != r['level']:
        bad.append(
            f"切换后 engine.controls 挂在「{r['after']['ctrlOwner']}」层上，而当前层是 {r['level']}"
            f"（切换前是「{r['before']['ctrlOwner']}」）—— 当前层被剥夺了轨道控制")
    if not r['after']['ctrlIsCurrent']:
        bad.append(f"{r['level']}.controls !== engine.controls —— 当前层拿不到全局控制器")

    return not bad, '；'.join(bad)


# 拆开「本层重建」这笔钱花在哪：dispose 与 build 各占多少。
# 用在 solar 层 —— 那里的重建是**必要**的，所以唯一能优化的方向是让它更便宜，
# 而"更便宜"必须先知道贵的部分是什么。这两行的口径不同，别混起来看：
#   disposeMs 高 ⇒ 释放路径有问题（遍历/材质 dispose 慢）；
#   buildMs   高 ⇒ 构建路径有问题（几何、贴图解码、轨道线采样）。
PROFILE_SOLAR_JS = r"""
() => {
  const e = window.__universe.engine, solar = e.levels.get('solar');
  if (e.current !== solar) return { error: '当前层不是 solar' };
  const oD = solar.dispose.bind(solar), oB = solar.build.bind(solar);
  let td = 0, tb = 0, nd = 0, nb = 0;
  solar.dispose = () => { const t = performance.now(); oD(); td += performance.now() - t; nd++; };
  solar.build = () => { const t = performance.now(); oB(); tb += performance.now() - t; nb++; };
  const t0 = performance.now();
  e.setOptions({ trueScale: true });
  const on = performance.now() - t0;
  const t1 = performance.now();
  e.setOptions({ trueScale: false });
  const off = performance.now() - t1;
  solar.dispose = oD; solar.build = oB;      // 还原，别把包装留在页面上
  return {
    level: 'solar', msOn: Math.round(on * 10) / 10, msOff: Math.round(off * 10) / 10,
    disposeMs: Math.round(td * 10) / 10, buildMs: Math.round(tb * 10) / 10,
    disposeCalls: nd, buildCalls: nb,
    entries: solar.entries.size, moons: solar.moonPivots.length,
    orbitLines: solar.orbitLines.length,
  };
}
"""


# 采样这一段的钱单独量一遍：build() 里最可疑的就是它。
# 复现的是 build() 里**同样的两次调用**（行星 320 点 × N；小天体 512 点 × M），
# 只计时、不改状态。目的是把「build 慢」拆成「采样慢」还是「建网格慢」——
# 这两件事的修法完全不同，猜错方向会白改一遍。
PROFILE_SAMPLING_JS = r"""
() => {
  const e = window.__universe.engine, solar = e.levels.get('solar');
  if (!solar) return { error: '没有 solar 层' };
  const bodies = [...solar.dataset.bodies.values()];

  const t1 = performance.now();
  let nPlanet = 0, cPlanet = 0;
  for (const p of bodies) {
    if (p.type !== 'planet' && p.type !== 'dwarf') continue;
    const pts = solar.eph.path(p.id, new Date(), 320);
    cPlanet++; if (pts && pts.length) nPlanet += pts.length / 3;
  }
  const tPlanet = performance.now() - t1;

  const t2 = performance.now();
  let nSmall = 0, cSmall = 0;
  for (const b of bodies) {
    if (!b._orbit || typeof b._orbit.sample !== 'function') continue;
    const pts = b._orbit.sample(512);
    cSmall++; if (pts && pts.length) nSmall += pts.length / 3;
  }
  const tSmall = performance.now() - t2;

  return {
    planet: { ms: Math.round(tPlanet * 10) / 10, calls: cPlanet, points: nPlanet },
    small: { ms: Math.round(tSmall * 10) / 10, calls: cSmall, points: nSmall },
  };
}
"""


# 环境部分（背景星空、三条粒子带、球体几何）单独复现一遍。
# 目的是判断那 233ms 是**少数几个大件**（好优化）还是**摊在 313 个天体上**（基本等于固有成本）。
# 复现用的参数**抄自 build()**，所以两者可比；抄错了这里的数字就毫无意义，
# 所以下面每条都标了出处行号。
PROFILE_ENV_JS = r"""
async () => {
  const B = await import('./js/objects/builders.js');
  const THREE = await import('three');
  const t = {};

  let t0 = performance.now();
  B.makeStarfield({ count: 6000, radius: 30000, innerRadius: 0.6, size: 180, seed: 17 });   // solar.js:107
  t.starfield = performance.now() - t0;

  t0 = performance.now();
  B.makeParticleBelt({ count: 3200, inner: 2.06, outer: 3.32, thickness: 0.05, color: '#a89880', size: 0.006, seed: 5, tiltJitter: 0.14 });   // :139
  B.makeParticleBelt({ count: 7000, inner: 30, outer: 50, thickness: 0.045, color: '#7fa0c8', size: 0.05, seed: 9, tiltJitter: 0.9 });        // :142
  B.makeParticleBelt({ count: 900, inner: 5.2, outer: 5.25, thickness: 0.02, color: '#a89478', size: 0.01, seed: 21, tiltJitter: 0.5 });      // :145
  t.belts = performance.now() - t0;

  // 313 个球体几何（157 天体 + 156 卫星），取 build 里用到的段数档位
  t0 = performance.now();
  for (let i = 0; i < 313; i++) {
    const seg = i % 13 === 0 ? [96, 48] : [48, 24];
    // 故意不保留引用：这批几何马上可回收，只量分配成本
    void new THREE.SphereGeometry(0.001 + i * 1e-7, seg[0], seg[1]);
  }
  t.spheres = performance.now() - t0;

  t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(320 * 3), 3));
    void new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#fff', transparent: true, opacity: 0.4 }));
  }
  t.lines = performance.now() - t0;

  for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 10) / 10;
  return t;
}
"""


# 判据 D 用：掐在**过渡动画途中**拨开关，落层之后场景必须已经是新口径。
# 这是判据 A/B/C 都看不见的一条路 —— 那几个都是"落定之后才拨"。
MEASURE_TRANSITION_JS = r"""
async () => {
  const u = window.__universe, e = u.engine, solar = e.levels.get('solar');
  if (!solar) return { error: '没有 solar 层' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
    return false;
  };

  // 先把 solar 建起来。必须是"已经建好"的层，才有"过渡途中拨开关"这个窗口。
  u.gotoScale('solar');
  if (!await waitFor(() => e.current && e.current.id === 'solar' && !e.transition, 30000)) {
    return { error: '没能先切到 solar' };
  }
  const builtBefore = !!solar.built;

  // 退到邻近恒星系：它是 solar 的相邻层，solar 不会被 _trimLevels 释放，仍然 built
  u.gotoScale('neighborhood');
  if (!await waitFor(() => e.current && e.current.id === 'neighborhood' && !e.transition, 30000)) {
    return { error: '没能退到 neighborhood' };
  }
  e.setOptions({ trueScale: false });   // 归零，别让上一轮的残留影响读数

  // 发起切回 solar —— **故意不 await**，然后掐在过渡窗口里拨开关
  const nav = u.gotoScale('solar');
  const caught = await waitFor(() => !!e.transition, 5000);
  const mid = { caught, to: e.transition ? e.transition.to.id : null, cur: e.current ? e.current.id : null };
  e.setOptions({ trueScale: true });

  await waitFor(() => e.current && e.current.id === 'solar' && !e.transition, 30000);
  const ent = solar.entries.get('earth');
  const out = {
    builtBefore,
    caught,
    midTo: mid.to,
    midCur: mid.cur,
    solarTrueScale: solar.trueScale,
    staleAfter: !!solar._scaleStale,
    earthR: ent ? ent.r : null,
    // 真实比例下地球半径 = 6371 / 1.496e8 ≈ 4.26e-5（单位 AU）；视觉模式约 4e-3。
    // 直接读**场景里那个数**，而不是读标志位 —— 场口变了没变，这才是行为判据。
    looksTrueScale: ent ? ent.r < 1e-4 : null,
  };
  e.setOptions({ trueScale: false });   // 收尾
  await sleep(60);
  return out;
}
"""


def judge_transition(r):
    """判据 D：过渡途中拨开关，落层后场景必须跟上。"""
    if not r or 'error' in r:
        return False, (r or {}).get('error', '没有读数')
    bad = []
    if not r['caught']:
        bad.append('没能掐进过渡窗口（判据 D 根本没被行使，这次读数不算通过）')
    else:
        if r['midTo'] != 'solar' or r['midCur'] != 'neighborhood':
            bad.append(f"过渡窗口状态不对：正在切往 {r['midTo']}，当前还停在 {r['midCur']}")
    if r['solarTrueScale'] is not True:
        bad.append(f"solar.trueScale = {r['solarTrueScale']}，开关没生效")
    if r['staleAfter']:
        bad.append('落层之后 solar._scaleStale 仍是 true —— 这笔账欠着没人来补')
    if not r['looksTrueScale']:
        bad.append(f"落层之后场景还是旧口径：地球半径读到 {r['earthR']}（真实比例应 < 1e-4）")
    return not bad, '；'.join(bad)


# 判据 D 的故障注入：**拆掉我的延迟重建设计的两处守卫**，忠实复现"欠了账没人补"。
# ⚠️ 为什么不能只拆一处：`solar.setTrueScale` 里的过渡目标判定，和
#    `engine._finishTransition` 里的兜底，是同一道门上的**两把锁**（有意为之）。
#    只拆一把，另一把照样把账补上，判据不会响 —— 那样这次注入也是白做。
INJECT_TRANSITION_HOLE_JS = r"""
() => {
  const u = window.__universe, e = u.engine, solar = e.levels.get('solar');
  window.__savedSetTrueScale2 = solar.setTrueScale;
  solar.setTrueScale = function (v) {
    if (this.trueScale === v) return;
    this.trueScale = v;
    this._scaleStale = true;
    if (window.__universe.engine.current === this) this.refreshIfStale();
    // 少了「本层是过渡目标」那一半
  };
  window.__savedFinishTransition = e._finishTransition;
  e._finishTransition = function () {
    const t = this.transition;
    this.transition = null;
    this.current = t.to;
    this._attachControls(t.to);        // 少了 to.refreshIfStale?.() 兜底
    this._setLabels(t.to);
    this._trimLevels();
    this.dispatchEvent(new CustomEvent('level', { detail: t.to }));
  };
  return true;
}
"""

RESTORE_TRANSITION_JS = r"""
() => {
  const u = window.__universe, e = u.engine, solar = e.levels.get('solar');
  if (window.__savedSetTrueScale2) { solar.setTrueScale = window.__savedSetTrueScale2; delete window.__savedSetTrueScale2; }
  if (window.__savedFinishTransition) { e._finishTransition = window.__savedFinishTransition; delete window.__savedFinishTransition; }
  solar._scaleStale = true; solar.refreshIfStale();   // 把场景拉回当前 trueScale
  return true;
}
"""


async def main():
    srv = ServedCheck(tag='真实比例探针')
    base = srv.start()
    try:
        return await probe(base)
    finally:
        srv.stop()


async def probe(base):
    rows, results, errs = [], [], []
    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.launch(headless=True, channel='msedge')
        except Exception:
            browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 1280, 'height': 720})
        # 存完整栈。只留 message 的话，一条 TypeError 指不出是哪一行。
        page.on('pageerror', lambda e: errs.append(getattr(e, 'stack', None) or str(e)))
        await page.goto(base + '/', wait_until='domcontentloaded')
        await page.wait_for_function('() => window.__universe && window.__universe.engine', timeout=60000)
        # 「引擎对象存在」不等于「第一层建完了」。只等前者会撞上 current 还是 null 的窗口，
        # 于是第一次导航报失败、重跑又通过 —— 那种"偶发"会把真故障一起放过。
        await page.wait_for_function(
            '() => { const lv = window.__universe.engine.current; return !!(lv && lv.id); }',
            timeout=60000,
        )

        for tier in TIERS:
            if ONLY and tier != ONLY:
                continue
            try:
                await page.evaluate("(t) => window.__universe.gotoScale(t)", tier)
            except Exception as e:
                rows.append({'level': tier, 'error': f'gotoScale 调用就抛了：{type(e).__name__}: {str(e).splitlines()[0][:150]}'})
                continue
            try:
                # 等过渡真的收尾（`transition` 还在时读到的控制器归属是过渡中途态）
                await page.wait_for_function(
                    "(t) => { const e = window.__universe.engine; return e.current.id === t && !e.transition; }",
                    arg=tier, timeout=45000)
            except Exception:
                cur = await page.evaluate(
                    '() => { const e = window.__universe.engine; return { cur: e.current && e.current.id, '
                    'transition: !!e.transition }; }')
                rows.append({'level': tier, 'error': f"等就绪失败：当前层 {cur['cur']}，"
                                                     f"过渡中 {cur['transition']}"})
                continue
            try:
                rows.append(await page.evaluate(MEASURE_JS))
            except Exception as e:
                rows.append({'level': tier, 'error': f'测量就抛了：{type(e).__name__}: {str(e).splitlines()[0][:150]}'})

        # 判据 D：单独跑一条 —— 它走的是"过渡动画途中拨开关"这条路，
        # 前面三条（落定之后才拨）看不见它。这条专门防**我自己引入**的那个洞：
        # 延迟重建意味着"欠账"，欠了账没人补，场景就会一直停在旧口径而不报错。
        trans = None
        try:
            trans = await page.evaluate(MEASURE_TRANSITION_JS)
        except Exception as e:
            trans = {'error': f'{type(e).__name__}: {str(e).splitlines()[0][:150]}'}

        selftest = None
        if SELFTEST:
            selftest = await run_selftest(page)

        profile = None
        if PROFILE:
            try:
                await page.evaluate("() => window.__universe.gotoScale('solar')")
                await page.wait_for_function(
                    "() => { const e = window.__universe.engine; return e.current.id === 'solar' && !e.transition; }",
                    timeout=45000)
                profile = await page.evaluate(PROFILE_SOLAR_JS)
                profile['sampling'] = await page.evaluate(PROFILE_SAMPLING_JS)
                profile['env'] = await page.evaluate(PROFILE_ENV_JS)
            except Exception as e:
                profile = {'error': f'{type(e).__name__}: {str(e).splitlines()[0][:150]}'}

        await browser.close()

    for r in rows:
        ok, why = judge(r) if 'error' not in r else (False, r['error'])
        results.append({'ok': ok, 'why': why, **r})

    trans_ok, trans_why = judge_transition(trans)

    if JSON_OUT:
        emit(json.dumps({'rows': results, 'transition': trans, 'transitionOk': trans_ok,
                         'selftest': selftest, 'profile': profile, 'pageerrors': errs},
                        ensure_ascii=False, indent=2))
        return 0 if (all(x['ok'] for x in results) and trans_ok
                     and (selftest is None or selftest['ok'])) else 1

    emit('')
    emit('真实比例开关：拨一次，引擎被拖着做了多少事')
    emit('  层                  开(ms)    关(ms)   太阳系重建   重建判据      控制器归属     当前层持有')
    for r in results:
        if 'error' in r:
            emit(f"  {r['level']:<18} {r['error']}")
            continue
        good_a = (r['rebuildDelta'] == (2 if r['isSolar'] else 0))
        good_c = (r['after']['ctrlOwner'] == r['level'] and r['after']['ctrlIsCurrent'])
        emit(f"  {r['level']:<18} {r['msOn']:>7.1f} {r['msOff']:>8.1f} "
             f"{r['rebuildDelta']:>10}   {'✓' if good_a else '✗ 该为 ' + str(2 if r['isSolar'] else 0):<10} "
             f"{str(r['after']['ctrlOwner']):<13} {'✓' if good_c else '✗'}"
             + ('' if r['ok'] else '    ← 不合规'))

    if selftest:
        emit('')
        emit('  故障注入（证明这四条判据会响，不是摆设）')
        for name, item in selftest['checks'].items():
            emit(f"    {'✓' if item['ok'] else '✗'} {name}：{item['detail']}")

    if profile:
        emit('')
        emit('  本层重建拆账（太阳系层：这次重建是必要的，问题只剩"能不能更便宜"）')
        if 'error' in profile:
            emit(f"    ✗ {profile['error']}")
        else:
            emit(f"    开 {profile['msOn']}ms / 关 {profile['msOff']}ms"
                 f"  =  dispose {profile['disposeMs']}ms({profile['disposeCalls']} 次)"
                 f" + build {profile['buildMs']}ms({profile['buildCalls']} 次)")
            emit(f"    规模：天体 {profile['entries']} · 卫星枢轴 {profile['moons']} · 轨道线 {profile['orbitLines']}")
            s = profile.get('sampling') or {}
            if s and 'error' not in s:
                pl, sm = s.get('planet', {}), s.get('small', {})
                emit(f"    其中轨道采样：行星 {pl.get('ms')}ms（{pl.get('calls')} 次 / {pl.get('points')} 点）"
                     f" + 小天体 {sm.get('ms')}ms（{sm.get('calls')} 次 / {sm.get('points')} 点）"
                     f" = {round((pl.get('ms', 0) + sm.get('ms', 0)), 1)}ms，"
                     f"占单次 build 的 {round((pl.get('ms', 0) + sm.get('ms', 0)) / max(profile['buildMs'] / max(profile['buildCalls'], 1), 0.1) * 100)}%")
            env = profile.get('env') or {}
            if env:
                one = profile['buildMs'] / max(profile['buildCalls'], 1)
                emit(f"    复现环境部分：星空 {env.get('starfield')}ms + 三条粒子带 {env.get('belts')}ms"
                     f" + 313 个球体几何 {env.get('spheres')}ms + 50 条轨道线壳 {env.get('lines')}ms"
                     f" = {round(sum(v for k, v in env.items() if isinstance(v, (int, float))), 1)}ms")
                emit(f"    ⇒ 单次 build 约 {round(one)}ms，上面的可复现部分只解释了其中一部分；"
                     f"剩下的摊在建材质 / 光晕精灵 / 标签 / 卫星枢轴上（属于整层重建的固有成本）")

    emit('')
    if trans and 'error' not in trans:
        emit(f"  判据 D · 过渡动画途中拨开关（落层后场景必须已是新口径）")
        emit(f"    {'✓' if trans_ok else '✗'} 掐进过渡窗口 {trans['midCur']} → {trans['midTo']} 时拨动；"
             f"落层后地球半径 {trans['earthR']}（真实比例应 < 1e-4）、欠账标记 {trans['staleAfter']}"
             + ('' if trans_ok else f"    ← {trans_why}"))
    elif trans:
        emit(f"  判据 D · ✗ {trans.get('error')}")
        trans_ok = False

    if errs:
        emit('')
        emit(f'  ⚠ 页面报了 {len(errs)} 个错误（第一条）：{errs[0].splitlines()[0][:200]}')

    bad = [x for x in results if not x['ok']]
    emit('')
    if not results:
        emit('  ✗ 一个层都没测到')
        return 1
    if bad:
        emit(f'  ✗ {len(bad)}/{len(results)} 层不合规：')
        for x in bad:
            emit(f"      [{x.get('level', '?')}] {x['why']}")
        return 1
    if not trans_ok:
        emit(f'  ✗ 逐层判据通过，但判据 D（过渡途中拨开关）不过：{trans_why}')
        return 1
    emit(f"  ✓ 全部通过（{len(results)} 层 + 判据 D）")
    if selftest and not selftest['ok']:
        emit('  ✗ 但故障注入没全部触响 —— 判据的"会响"这件事本身没被证明')
        return 1
    return 0


# ---------------------------------------------------------------- 故障注入

# A1：复现**旧行为** —— 设置广播后，不管在不在这一层都无条件重建太阳系。
# ⚠️ 第一版写错了：直接 `solar.rebuild()` 手动加一次，那是在**判据的测量窗口之外**发生的事，
#    判据只读 `setOptions` 前后的增量，于是注入的东西根本没进入它的视野 ——
#    读数照样是 0，判据"没响"，而看起来像是判据坏了。
#    注入必须作用在**被测量的那个动作**上：这里改成包一层 setOptions，
#    让「拨开关」这个动作自己把太阳系带上，也就是旧代码做的事。
INJECT_EXTRA_REBUILD_JS = r"""
() => {
  const e = window.__universe.engine, solar = e.levels.get('solar');
  window.__savedSetOptions = e.setOptions.bind(e);
  e.setOptions = (opts) => {
    const r = window.__savedSetOptions(opts);
    if ('trueScale' in opts) solar.rebuild();   // 旧行为：每层都跟着重建
    return r;
  };
  return true;
}
"""

# A2：让 setTrueScale 变成空操作 → 当前层是太阳系时 rebuildDelta 该为 0，
#     判据 A 的**另一个方向**（要求恰好 2）应当报错。
INJECT_NOOP_TRUESCALE_JS = r"""
() => {
  const solar = window.__universe.engine.levels.get('solar');
  window.__savedSetTrueScale = solar.setTrueScale;
  solar.trueScale = null;                // 让 `this.trueScale === v` 的短路提前返回失效
  solar.setTrueScale = function () { /* 开关失效 */ };
  return true;
}
"""

# B：给 setOptions 灌 150ms 忙等 → 超过 MS_CAP_OTHER，判据 B 应当报错
INJECT_SLOW_JS = r"""
() => {
  const e = window.__universe.engine;
  window.__savedSetOptions = e.setOptions.bind(e);
  e.setOptions = (opts) => {
    if ('trueScale' in opts) {
      const t = performance.now();
      while (performance.now() - t < 150) { /* 空转，故意拖慢 */ }
    }
    return window.__savedSetOptions(opts);
  };
  return true;
}
"""

# C：把全局控制器抢给非当前层 → 判据 C 应当报错
INJECT_STEAL_JS = r"""
() => {
  const e = window.__universe.engine;
  const other = e.levels.get('solar');
  e._attachControls(other);              // 故意仿冒 rebuild() 里的那行偷控制器
  let owner = null;
  for (const [id, lv] of e.levels) if (e.controls && lv.camera === e.controls.object) owner = id;
  return { owner };
}
"""

RESTORE_JS = r"""
() => {
  const e = window.__universe.engine;
  if (window.__savedSetOptions) { e.setOptions = window.__savedSetOptions; delete window.__savedSetOptions; }
  const solar = e.levels.get('solar');
  if (window.__savedSetTrueScale) { solar.setTrueScale = window.__savedSetTrueScale; delete window.__savedSetTrueScale; }
  e._attachControls(e.current);          // 控制器归还当前层
  solar.setTrueScale(false);             // 让 `this.trueScale === v` 短路重新可用（solar 不是当前层时只会打脏标记）
  return true;
}
"""


async def run_selftest(page):
    """对每条判据各注入一次故障，确认它**真的会响**。

    没做这一步的话，「判据通过」可能只是因为它从来没被触发过 —— 比如注入 0 个对象，
    读数不变，而那被当成合规。**测不到自己故障的故障注入比没有更坏。**

    ⚠️ 每条判据都是「**注入前必须绿、注入后必须红**」两段式。
    只断言"注入后红了"是不够的：基线本来就红的时候，注入什么都没做，
    判据照样红 —— 于是这次注入**验收了一个它没碰过的结论**，还给人"已验证"的假安心。
    （坑 87 就是这么来的：注入 0 个对象，读数 +0，判为合规。）
    """
    checks = {}

    async def at(tier):
        await page.evaluate("(t) => window.__universe.gotoScale(t)", tier)
        await page.wait_for_function(
            "(t) => { const e = window.__universe.engine; return e.current.id === t && !e.transition; }",
            arg=tier, timeout=45000)

    async def clean(tier):
        """注入前的基线读数。必须是绿的，否则这次的注入不构成验证。"""
        await at(tier)
        r = await page.evaluate(MEASURE_JS)
        ok, why = judge(r)
        return r, ok, why

    # --- A1：非当前层被强行重建 ---
    r0, ok0, why0 = await clean('galaxy')
    if not ok0:
        checks['A1 非当前层被重建 → 判据 A 报警'] = {
            'ok': False,
            'detail': f'注入前基线就是红的（{why0}）⇒ 这次注入不能证明任何事，先修基线',
        }
    else:
        await page.evaluate(INJECT_EXTRA_REBUILD_JS)
        r = await page.evaluate(MEASURE_JS)
        ok, why = judge(r)
        checks['A1 非当前层被重建 → 判据 A 报警'] = {
            'ok': (not ok) and r.get('rebuildDelta') == 2,
            'detail': f"注入前绿 ⇒ 让拨开关这个动作自己带上太阳系（重建增量 {r.get('rebuildDelta')}），"
                      f"注入后{'红：' + why if not ok else '仍绿 —— 判据没响'}",
        }
    await page.evaluate(RESTORE_JS)

    # --- A2：开关失效（该重建却不重建）---
    r0, ok0, why0 = await clean('solar')
    if not ok0:
        checks['A2 开关失效（当前层不重建）→ 判据 A 报警'] = {
            'ok': False,
            'detail': f'注入前基线就是红的（{why0}）⇒ 这次注入不能证明任何事，先修基线',
        }
    else:
        await page.evaluate(INJECT_NOOP_TRUESCALE_JS)
        r = await page.evaluate(MEASURE_JS)
        ok, why = judge(r)
        checks['A2 开关失效（当前层不重建）→ 判据 A 报警'] = {
            'ok': (not ok) and r.get('rebuildDelta') == 0,
            'detail': f"注入前绿 ⇒ 开关改成空操作（重建增量 {r.get('rebuildDelta')}），"
                      f"注入后{'红：' + why if not ok else '仍绿 —— 判据没响'}",
        }
    await page.evaluate(RESTORE_JS)

    # --- B：耗时超限 ---
    r0, ok0, why0 = await clean('neighborhood')
    if not ok0:
        checks['B 灌 150ms 忙等 → 判据 B 报警'] = {
            'ok': False,
            'detail': f'注入前基线就是红的（{why0}）⇒ 这次注入不能证明任何事，先修基线',
        }
    else:
        await page.evaluate(INJECT_SLOW_JS)
        r = await page.evaluate(MEASURE_JS)
        ok, why = judge(r)
        checks['B 灌 150ms 忙等 → 判据 B 报警'] = {
            'ok': (not ok) and max(r.get('msOn', 0), r.get('msOff', 0)) > MS_CAP_OTHER,
            'detail': f"注入前绿 ⇒ 每拨一次加 150ms 忙等（开 {r.get('msOn')}ms / 关 {r.get('msOff')}ms，"
                      f"上限 {MS_CAP_OTHER}），注入后{'红' if not ok else '仍绿 —— 判据没响'}",
        }
    await page.evaluate(RESTORE_JS)

    # --- C：控制器被抢走 ---
    r0, ok0, why0 = await clean('neighborhood')
    if not ok0:
        checks['C 控制器被非当前层抢走 → 判据 C 报警'] = {
            'ok': False,
            'detail': f'注入前基线就是红的（{why0}）⇒ 这次注入不能证明任何事，先修基线',
        }
    else:
        inj = await page.evaluate(INJECT_STEAL_JS)
        r = await page.evaluate(MEASURE_JS)
        ok, why = judge(r)
        checks['C 控制器被非当前层抢走 → 判据 C 报警'] = {
            'ok': (not ok) and inj['owner'] not in (None, 'neighborhood'),
            'detail': f"注入前绿 ⇒ 控制器被抢到「{inj['owner']}」，"
                      f"注入后{'红：' + why if not ok else '仍绿 —— 判据没响'}",
        }
    await page.evaluate(RESTORE_JS)

    # --- D：过渡动画途中拨开关（两处守卫都拆掉才复现得出来）---
    r0 = await page.evaluate(MEASURE_TRANSITION_JS)
    ok0, why0 = judge_transition(r0)
    if not ok0:
        checks['D 过渡途中拨开关 → 判据 D 报警'] = {
            'ok': False,
            'detail': f'注入前基线就是红的（{why0}）⇒ 这次注入不能证明任何事，先修基线',
        }
    else:
        await page.evaluate(INJECT_TRANSITION_HOLE_JS)
        r = await page.evaluate(MEASURE_TRANSITION_JS)
        ok, why = judge_transition(r)
        checks['D 过渡途中拨开关 → 判据 D 报警'] = {
            'ok': (not ok) and r.get('staleAfter') is True and r.get('looksTrueScale') is False,
            'detail': f"注入前绿 ⇒ 拆掉两处守卫后落层场景仍是旧口径（地球半径 {r.get('earthR')}，"
                      f"欠账标记 {r.get('staleAfter')}），"
                      f"注入后{'红：' + why if not ok else '仍绿 —— 判据没响'}",
        }
    await page.evaluate(RESTORE_TRANSITION_JS)

    return {'ok': all(c['ok'] for c in checks.values()), 'checks': checks}


if __name__ == '__main__':
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)

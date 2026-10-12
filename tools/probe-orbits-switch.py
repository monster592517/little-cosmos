#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「轨道」开关在邻近层到底连没连上 —— 活页面量具（坑 130）。

## 为什么必须量活的

`neighborhood.js` 里的 `setOrbitsVisible()` 原来是**一行空桩**，而底栏有个 `☑ 轨道` 开关
（`hud.js:29` → `engine.setOptions({orbits})` → `engine.js:736` 派给每一层）。
⇒ 用户在邻近层关掉开关，**什么都没发生**，那些「有行星」的青色圆环照样在。
这就是「意义不明的光环」的来源：**想关，关不掉。**

自检里的 `shell.orbits-switch` 只能判**接线在不在**（源码级）。
「按下去屏幕真的变了」只能在这里量。

## 判据（每条都要能响）

1. **「有行星」光环已整体移除**（第 37 轮）：`exoSprites` 字段不存在、环数 0。
   ⚠️ 这条是**反方向**的判据，而且是必须的：删掉对象之后，本探针原来的
   `rings = lv.exoSprites || []` 会稳定读到空数组 ⇒「环全部不可见 ✓」**永远通过** ——
   那是换了个方向的假绿。所以判据改成「**字段已不存在**」，光环哪天被加回来它就红。
2. **阳性对照**：开关**开着**时，轨道线可见数 > 0。
   不做这条对照，「关掉后是 0」可能只是因为本来就没有轨道线 —— 那是个不会响的判据。
3. 关掉后：轨道线可见数 == 0。
4. ⚠️ 读第 3 条**必须等若干帧**：`update()` 每帧都会碰 `visible`，
   只测「点下去那一刻」会把「下一帧又被点亮」的故障放过去（坑 84 的老毛病）。
5. 重新打开：回到 > 0（证明不是单向不可逆的假动作）。
6. **延迟构建必须继承开关状态**：关着开关去聚焦另一颗有行星的恒星，
   新构建出来的系统不许自己冒出轨道线。⚠️ 同时断言**新视图数真的增加了**
   （`views` 变大），否则这条判据是空的 —— 「关着的时候当然没有」不等于「新构建的也听话」。

> 历史（第 36 轮以前）：本探针还判「有行星」的**青色光环**能不能关掉。那个光环在
> 第 37 轮被**整体删除**（用户原话「恒星上也有，都去了」），判据 1 因此改成反向断言。

用法：
    py -3.13 -X utf8 tools/probe-orbits-switch.py
    py -3.13 -X utf8 tools/probe-orbits-switch.py --shots
退出码：0 = 全部判据通过；1 = 有判据没过（或页面没起来）。
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


READ_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  if (!lv) return { ok: false, why: '拿不到当前层' };
  const exo = lv.exoRenderer;
  /* ★ 第 37 轮：「有行星」的光环标记（`exoSprites`）已按用户要求**整体移除**。
   *   这里**故意保留** `exoSprites` 的读取，并另给一个 `ringsFieldGone` 读数 ——
   *   因为「对象没了」和「探针读到一个空数组所以永远通过」在外表上**完全一样**。
   *   把「字段已不存在」做成一等判据，光环哪天被加回来本探针就会红。 */
  const rings = lv.exoSprites || [];
  let views = 0, orbitTotal = 0, orbitVisible = 0;
  if (exo && exo.active) {
    for (const v of exo.active.values()) {
      views++;
      for (const l of (v.orbitLines || [])) { orbitTotal++; if (l.visible) orbitVisible++; }
    }
  }
  const box = document.getElementById('opt-orbits');
  return {
    ok: true, level: lv.id, built: !!lv.built,
    levelFlag: lv.orbitsVisible,
    engineFlag: (u.engine.options || {}).orbits,
    checkOn: box ? box.checked : null,
    ringTotal: rings.length, ringVisible: rings.filter(r => r.visible).length,
    ringsFieldGone: lv.exoSprites === undefined,
    views, orbitTotal, orbitVisible,
    rendererFlag: exo ? exo.orbitsVisible : null,
  };
}
"""

PICK_HOST_JS = r"""
() => {
  const u = window.__universe;
  const out = [];
  for (const b of u.dataset.bodies.values()) {
    if (b.level !== 'neighborhood') continue;
    const n = b.exo && b.exo.planets ? b.exo.planets.length : 0;
    if (n > 0) out.push({ id: b.id, name: b.name, planets: n });
  }
  out.sort((a, b) => b.planets - a.planets);
  return { total: out.length, pick: out.slice(0, 8) };
}
"""

CENSUS_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  const rings = lv.exoSprites || [];
  const named = lv.named || [];
  const buckets = { '≤30': 0, '30–60': 0, '60–120': 0, '120–300': 0, '>300': 0, '未知': 0 };
  let withInfo = 0, withExo = 0;
  const far = [];
  for (const item of named) {
    const st = item.star || {};
    if (st.info) withInfo++;
    if (st.exo) withExo++;
    const d = Number.isFinite(st.distLy) ? st.distLy : null;
    if (d == null) buckets['未知']++;
    else if (d <= 30) buckets['≤30']++;
    else if (d <= 60) buckets['30–60']++;
    else if (d <= 120) buckets['60–120']++;
    else if (d <= 300) buckets['120–300']++;
    else { buckets['>300']++; if (far.length < 5) far.push(item.id + '@' + d.toFixed(0) + 'ly'); }
  }
  return {
    namedTotal: named.length,
    namedWithInfo: withInfo,
    namedWithExo: withExo,
    ringTotal: rings.length,
    ringsFieldGone: lv.exoSprites === undefined,
    buckets, farSample: far,
    exoCount: lv.exoCount,
    systemsInRenderer: lv.exoRenderer ? lv.exoRenderer.systems.length : null,
    skippedOffTier: lv.skippedOffTier,
    skippedNoPlace: lv.skippedNoPlace,
    starsInCloud: (lv.dataset && lv.dataset.stars) ? lv.dataset.stars.length : null,
  };
}
"""

"""判据 5 的专用测量：直接走 `ensure()` 那条「强制建出」路径。

⚠️ 第一版这里写的是「聚焦另一颗星，看视图数有没有变大」—— **那是个会算错方向的判据**：
`update()` 会在同一次调用里释放走远的视图、建出走近的视图，**净数可以一点不变**，
于是「没新建」和「换了一个」分不开，判据永远读成 ✗（本次实测 `视图数 1 → 1`）。
改成直接问「**新建出来的那个视图** 是否遵守开关」，与距离迟滞完全解耦。
"""
SPAWN_INHERIT_JS = r"""
() => {
  const lv = window.__universe.engine.current;
  const exo = lv.exoRenderer;
  if (!exo) return { ok: false, why: '没有 exoRenderer' };
  const before = new Set(exo.active.keys());
  let target = null;
  for (const s of exo.systems) {
    if (!before.has(s.starName)) { target = s.starName; break; }
  }
  if (!target) return { ok: false, why: '找不到不在场的系统' };
  const v = exo.ensure(target);
  const lines = (v && v.orbitLines) || [];
  return {
    ok: true, target,
    flag: exo.orbitsVisible,
    built: !!v,
    orbitTotal: lines.length,
    orbitVisible: lines.filter(l => l.visible).length,
    activeBefore: before.size,
    activeAfter: exo.active.size,
  };
}
"""


def toggle_js(on):
    return ("() => { const el = document.getElementById('opt-orbits'); if (!el) return null;"
            " if (el.checked !== " + ('true' if on else 'false') + ") el.click();"
            " return el.checked; }")


def row(tag, r):
    emit(f'  {tag:<12} 开关={str(r["checkOn"]):<5} 层标记={str(r["levelFlag"]):<5} '
         f'渲染器={str(r["rendererFlag"]):<5} | 有行星光环={"已删除" if r.get("ringsFieldGone") else "★又回来了★"}'
         f' · 系统视图 {r["views"]} 个 · 轨道线 {r["orbitVisible"]}/{r["orbitTotal"]} 可见')
    return r


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

            emit('  切到「neighborhood」层 …')
            await page.evaluate("window.__universe.gotoScale('neighborhood')")
            try:
                await page.wait_for_function(
                    "window.__universe.engine.current && window.__universe.engine.current.id === 'neighborhood'"
                    " && window.__universe.engine.current.built", timeout=60000)
            except Exception:
                emit('  ✗ 邻近层 60 秒内没建好')
                await browser.close()
                return 1
            await page.wait_for_timeout(1200)

            hosts = await page.evaluate(PICK_HOST_JS)
            emit(f'  有行星的邻近恒星：{hosts["total"]} 颗，取前 {len(hosts["pick"])} 颗做样本')
            if hosts['total'] < 2:
                emit('  ⚠ 有行星的恒星少于 2 颗 —— 判据 5（延迟构建继承）会没样本，本次不下结论')
            pick = hosts['pick']

            census = await page.evaluate(CENSUS_JS)
            emit('\n【普查】邻近层到底画了多少东西 —— 「很多…光环」的「很多」是多少')
            emit(f'  点云恒星 {census["starsInCloud"]} · 单独精灵(有专名/有行星) {census["namedTotal"]}'
                 f'（有专名 {census["namedWithInfo"]} · 有行星 {census["namedWithExo"]}）')
            emit(f'  「有行星」光环 {"已删除（第 37 轮）" if census.get("ringsFieldGone") else census["ringTotal"]}'
                 f' · 登记的系统 {census["exoCount"]}'
                 f' · 渲染器持有 {census["systemsInRenderer"]}')
            emit(f'  精灵宿主距离分布：{census["buckets"]}')
            if census['farSample']:
                emit(f'  最远的几个（例）：{census["farSample"]}')
            emit(f'  建层时被跳过：层级不符 {census["skippedOffTier"]} · 拿不到位置 {census["skippedNoPlace"]}')
            if census.get('ringsFieldGone'):
                emit('  ✓ 「有行星」光环 **已在第 37 轮整体移除**（`exoSprites` 字段不存在）。')
                emit('    它此前的实测规模是 **4745 个** —— 那就是用户那句「很多恒星系带行星轨道或')
                emit('    意义不明的光环」的字面规模。现在「有行星」只体现在精灵尺寸(+0.12)、')
                emit('    标签优先级(6 vs 3) 与天体面板里。')

            # 先聚焦一颗：否则邻近层默认视角离所有恒星都 >3 光年，一个系统都没建（判据会空转）
            await page.evaluate(f"window.__universe.engine.current.focusById({pick[0]['id']!r})")
            await page.wait_for_timeout(2000)

            emit('\n① 开关应该默认是「开」')
            a = row('① 开', await page.evaluate(READ_JS))
            checks.append(judge('开关默认是开的', a['checkOn'] is True, f'checkOn={a["checkOn"]}'))
            checks.append(judge('「有行星」光环已整体移除（`exoSprites` 字段不存在 · 第 37 轮）',
                                a['ringsFieldGone'] is True and a['ringTotal'] == 0,
                                f'字段已删={a["ringsFieldGone"]} · 环 {a["ringTotal"]} 个'
                                f'（若这里变成 False，说明有人把它加回来了）'))
            checks.append(judge('开时轨道线可见数 > 0（阳性对照）',
                                a['orbitVisible'] > 0, f'{a["orbitVisible"]}/{a["orbitTotal"]}'))
            if SHOTS_ON:
                await page.screenshot(path=os.path.join(SHOTS, '_orbits-on.png'))

            emit('\n② 点掉「轨道」开关，**等 1 秒（约 60 帧）再读** —— 等帧是判据的一部分')
            await page.evaluate(toggle_js(False))
            await page.wait_for_timeout(1000)
            b = row('② 关', await page.evaluate(READ_JS))
            checks.append(judge('开关状态真的变了', b['checkOn'] is False, f'checkOn={b["checkOn"]}'))
            checks.append(judge('关掉开关后光环依然「不存在」（不是被开关藏起来的）',
                                b['ringsFieldGone'] is True, f'字段已删={b["ringsFieldGone"]}'))
            checks.append(judge('关后轨道线全部不可见（等过帧，不是点下去那一刻）',
                                b['orbitVisible'] == 0, f'{b["orbitVisible"]}/{b["orbitTotal"]} 仍可见'))
            if SHOTS_ON:
                await page.screenshot(path=os.path.join(SHOTS, '_orbits-off.png'))

            emit('\n③ 再打开')
            await page.evaluate(toggle_js(True))
            await page.wait_for_timeout(1000)
            c = row('③ 再开', await page.evaluate(READ_JS))
            checks.append(judge('轨道线回到可见', c['orbitVisible'] > 0,
                                f'{c["orbitVisible"]}/{c["orbitTotal"]}'))

            emit('\n④ 关着开关，直接走「强制建出」那条路径 —— 新视图不许自己冒出轨道线')
            await page.evaluate(toggle_js(False))
            await page.wait_for_timeout(600)
            d = row('④ 关+新建', await page.evaluate(READ_JS))
            sp = await page.evaluate(SPAWN_INHERIT_JS)
            if not sp.get('ok'):
                emit(f'  ⚠ 建不出新视图（{sp.get("why")}）—— 这条判据本次不下结论')
            else:
                emit(f'  新建成 {sp["target"]}：轨道线 {sp["orbitVisible"]}/{sp["orbitTotal"]} 可见 · '
                     f'渲染器标记={sp["flag"]} · 在场视图 {sp["activeBefore"]} → {sp["activeAfter"]}')
                checks.append(judge('确实建出了新视图（否则这条判据是空的）',
                                    bool(sp['built']) and sp['activeAfter'] > sp['activeBefore'],
                                    f'视图 {sp["activeBefore"]} → {sp["activeAfter"]}'))
                checks.append(judge('新建出来的视图也遵守开关（延迟构建继承）',
                                    sp['orbitTotal'] > 0 and sp['orbitVisible'] == 0,
                                    f'{sp["orbitVisible"]}/{sp["orbitTotal"]} 可见'))

            # 收尾：把开关恢复到「开」——探针不许把用户的状态留在关着的位置
            await page.evaluate(toggle_js(True))
            await page.wait_for_timeout(400)
            e = row('收尾·复原', await page.evaluate(READ_JS))
            checks.append(judge('收工后开关已复位为「开」', e['checkOn'] is True))

            await browser.close()
    finally:
        srv.stop()

    ok_n = sum(1 for c in checks if c)
    emit(f'\n{"=" * 78}')
    emit(f'  通过 {ok_n}/{len(checks)}')
    if ok_n == len(checks):
        emit('  ✓ 「轨道」开关在邻近层真的连上了：关掉 → 环与轨道线都归零；重开 → 都回来；')
        emit('    且**关着的时候新构建的系统也遵守**（延迟构建继承，坑 130）。')
    else:
        emit('  ✗ 有判据没过 —— 见上面带 ✗ 的行。哑开关（坑 130）回来了。')
    emit(f'{"=" * 78}')
    return 0 if ok_n == len(checks) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))

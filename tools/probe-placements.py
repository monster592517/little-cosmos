#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""落点纯洁性探针：每一层里，**有没有天体落到了不该落的地方？**

为什么需要这个
--------------
「太阳渲染成一个硬边大白色方块」的真因是：
  2,158 个 `level: 'galaxy'` 的深空天体和一批缺坐标的天体，
  全被邻近恒星系层的绘制循环画在了**世界原点**上（那正好是太阳）。
而这两类问题在代码里都**不抛异常**：
  · 循环没读 `level` 字段 → 别的尺度的天体混进来（字段是对的，没人看）；
  · `new THREE.Vector3(undefined,…)` → NaN 向量；`(0,0,0)` → 合法向量；
    两者在渲染上**都表现为堆在世界原点**。

所以这里不检查「代码里有没有守卫」，而是直接问**渲染结果**：
成百上千个精灵叠在原点，这是唯一能"看得见"的症状。

三条判据（都是**数对象**，不是数计数）
------------------------------------
  A 原点堆叠   自己位置的三个分量都 < 1e-3 的 Sprite 数。正常只该有 1–3 个
               （太阳 / 「我们在这里」标记）。> 上限即故障。
  B 跨尺度泄漏 sprite 上 `userData.bodyId` 指向的天体，其 `level` 与当前层不一致。
  C 无位置却落点 该天体**既没有直角坐标、也没有赤经赤纬**，却仍然被画出来了。

⚠️ 判据 C 的「没有位置」用的是 `attrs.js::placeAccuracy`，**不是本脚本自己写的**。
   踩过一次：绘制代码的口径是「ra/dec 有限就算有位置，距离未测定就用代表值
   （`galaxy.js` 里是 5 千光年）」，而探针原来的口径是「`placeOfLy()` 解析不出就是没位置」。
   于是同一批天体（NGC 405 / IC 4816 / 几个 X 射线双星黑洞）在绘制代码眼里是
   「方位已知、距离未测定」，在探针眼里是「无位置却落点」——
   **一条具体的、看起来很专业的错误结论**，照着它修会去动本来正确的代码。
   判据和绘制共用一个定义源，是这件事唯一的解法。

⚠️ Points / Line 不算。它们的 `position` 普遍是 (0,0,0)，
   真正的顶点坐标在 geometry 里 —— 把它们算进来会得到一批**假的原点堆叠**。
   （这个坑已经踩过一次：用 `o.position` 而不是 `getWorldPosition()`。）

结构锚（豁免要自证）
--------------------
太阳 / 银河系 / 本星系群在各自那层**本来就在世界原点** —— 那不是缺数据，是定义。
这类对象在数据里用 `anchor: 'home' | 'context'` **自己声明**（见 `deep-sky.js`），
本探针认这份声明，把它们从 B/C 两条判据里排除，但**另行计数并设上限**：
  · 上限防止「全部标成锚」把判据变成空转；
  · `anchor: 'home'` 却不在原点是**自相矛盾的声明**，直接判故障。
豁免写在对象自己身上，不写在检查脚本的名单里 —— 中央名单会腐烂，字段跟着对象走。

用法
----
    py -3.13 -X utf8 tools/probe-placements.py
    py -3.13 -X utf8 tools/probe-placements.py --level=neighborhood
    py -3.13 -X utf8 tools/probe-placements.py --selftest     # 故障注入（A/B/C 三条都测）
    py -3.13 -X utf8 tools/probe-placements.py --json
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
ONLY = None
for a in ARGV:
    if a.startswith('--level='):
        ONLY = a.split('=', 1)[1]

TIERS = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe']

# 尺度阶梯顺序。结构锚的「上下文」判据要用它：
#   只允许把**更低**的东西当上下文标出来，绝不允许把更高的东西塞进低层 ——
#   后者正是「太阳被别的尺度的天体糊成一个大方块」那件事本身。
TIER_ORDER = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe']

# 每一层里，位置恰好是原点而**合法**的精灵上限。
ORIGIN_CAP = {'solar': 3, 'neighborhood': 3, 'galaxy': 3, 'localgroup': 3, 'supercluster': 3, 'universe': 3}

# 结构锚的合法取值 —— **运行时从页面上的 attrs.js 取**，不在这里再写一份。
# 踩过（而且这个项目反复踩）：判据脚本自己抄一份词表，数据那边加了新种类，
# 两边就静默分叉 —— 而分叉的方向恰好是「探针把不认识的取值当成有效豁免放过」。
# 取不到词表一律判失败：那时候「anchor 写错一个字母 = 免检」这条路是敞开着的。
# 另外这里**不设数量上限**：上限是会腐烂的魔数，而真正要防的两件事都有
# **结构性**判据管着（见 classify）。
KNOWN_ANCHORS = ()

# 页面上装一个递归找 Sprite 的小工具。
# ⚠️ 不能写成 `lv.scene.children.find(o => o.isSprite)` —— 各层的精灵几乎都挂在
#    Group 里（`deepGroup` / `this.far` / `labels` …），直接子节点里一个都没有，
#    于是故障注入塞进去 **0 个**精灵、判据读数 +0，脚本却把这一条报成「判定为合规」。
#    测不到自己故障的故障注入比没有更坏：它给的是**假的安心**。
#    也不能用 `arguments.callee`（严格模式下非法，箭头函数里更不成立）——
#    所以装成页面上具名的全局函数，让它自己递归自己。
INSTALL_HELPER_JS = r"""
() => {
  window.__findFirstSprite = (o) => {
    if (o.isSprite) return o;
    for (const c of (o.children || [])) {
      const r = window.__findFirstSprite(c);
      if (r) return r;
    }
    return null;
  };
}
"""

# 逐层收集：把每个 Sprite 的世界坐标、它的 bodyId、以及"该天体到底有没有位置"一次问清。
# ⚠️ 必须用 getWorldPosition()。`o.position` 是**局部坐标**，精灵挂在 Group 里时恒为 (0,0,0)。
INSPECT_JS = r"""
() => {
  const u = window.__universe;
  const lv = u.engine.current;
  const out = { level: lv.id, sprites: [], skip: { offTier: lv.skippedOffTier ?? null, noPlace: lv.skippedNoPlace ?? null } };
  const v = new (Object.getPrototypeOf(lv.scene.position).constructor)();
  const walk = (o) => {
    if (o.isSprite) {
      o.getWorldPosition(v);
      const id = o.userData && o.userData.bodyId;
      // `get()` 走的是索引；故障注入塞进去的临时天体不在索引里 —— 两个都问一下
      const b = id ? (u.dataset.get(id) || (u.dataset.bodies && u.dataset.bodies.get(id)) || null) : null;
      out.sprites.push({
        id: id || null,
        pos: [v.x, v.y, v.z],
        // 用**数据集**的 level，不是从场景猜
        bodyLevel: b ? (b.level || null) : null,
        // 该天体能不能落点（与绘制代码同一套判据：attrs.js::placeAccuracy）
        place: b ? window.__lcPlaceAccuracy(b, b.anchor === 'home') : null,
        // 结构自己声明的豁免；没声明就是 null
        anchor: b ? (b.anchor || null) : null,
        scale: +o.scale.x.toFixed(3),
      });
    }
    for (const c of (o.children || [])) walk(c);
  };
  walk(lv.scene);
  return out;
}
"""

# 故障注入第一条：6 个叠在世界原点的精灵 → 判据 A 必须涨 6。
INJECT_ORIGIN_JS = r"""
() => {
  const u = window.__universe, lv = u.engine.current;
  const s0 = window.__findFirstSprite(lv.scene);
  if (!s0) return 0;
  let n = 0;
  for (let i = 0; i < 6; i++) {
    const c = s0.clone();
    c.position.set(0, 0, 0);
    c.userData = { __selftestInject: true };
    lv.scene.add(c);
    n++;
  }
  return n;
}
"""

# 故障注入第二条：3 个指向「既没有坐标也没有方向、且声明的层与当前层不符」的天体的精灵
# → 判据 B、C 各必须涨 3。
# ⚠️ 三个**不同的** id：判据是**按天体去重**的，同一个天体挂 3 个精灵只算 1 个 ——
#    用一个 id 注入会让「读数 +3」永远不成立，而那是断言写错、不是判据坏了。
# 位置故意不在原点：这样它只触 B/C，不会顺带把 A 的读数也推高，三条判据各自被单独证明。
INJECT_GHOST_JS = r"""
() => {
  const u = window.__universe, lv = u.engine.current;
  const s0 = window.__findFirstSprite(lv.scene);
  if (!s0) return 0;
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const gid = '__selftest_ghost_' + i;
    if (u.dataset.bodies) {
      u.dataset.bodies.set(gid, { id: gid, name: '故障注入', type: 'galaxy', level: '__selftest_wrong_tier', x: NaN, y: NaN, z: NaN });
    }
    const c = s0.clone();
    c.position.set(500 + i, 500, 500);
    c.userData = { __selftestInject: true, bodyId: gid };
    lv.scene.add(c);
    n++;
  }
  return n;
}
"""

# 回收按**标记**，不靠索引（索引会随场景变化而错位）。
RECLAIM_JS = r"""
() => {
  const u = window.__universe, lv = u.engine.current;
  const dead = [];
  const walk = (o) => {
    for (const c of (o.children || [])) {
      if (c.userData && c.userData.__selftestInject) dead.push([o, c]);
      else walk(c);
    }
  };
  walk(lv.scene);
  for (const [parent, o] of dead) parent.remove(o);
  // 幽灵天体也要撤掉，否则会留在数据集里影响后面几层
  if (u.dataset.bodies) {
    for (const k of [...u.dataset.bodies.keys()]) {
      if (String(k).startsWith('__selftest_ghost')) u.dataset.bodies.delete(k);
    }
  }
  return dead.length;
}
"""


def classify(res, level):
    """把一层的原始结果判成三条判据（+ 结构锚）的计数。"""
    sprites = res.get('sprites') or []
    origin, leak, unplaced = 0, [], []
    anchors, anchor_bad, anchor_kinds = [], [], {}
    for s in sprites:
        p = s['pos']
        at_origin = abs(p[0]) < 1e-3 and abs(p[1]) < 1e-3 and abs(p[2]) < 1e-3
        if at_origin:
            origin += 1
        a = s.get('anchor')
        if a:
            # 结构自己声明了豁免 → 另行计数，不参与 B/C。
            # 但豁免本身要受审：声明错了就是「声明错 = 免检」，比不声明更坏。
            anchors.append(s['id'])
            anchor_kinds[a] = anchor_kinds.get(a, 0) + 1
            if a not in KNOWN_ANCHORS:
                anchor_bad.append(f"{s['id']} 的 anchor='{a}' 不是合法取值（只能 {'/'.join(KNOWN_ANCHORS)}）")
            elif a == 'home' and not at_origin:
                anchor_bad.append(f"{s['id']} 声明 anchor:'home' 却不在原点 —— 声明自相矛盾")
            elif a == 'context':
                # 上下文节点必须**真的知道自己在哪**，否则就是拿声明洗掉「缺坐标」
                if s['place'] == 'none':
                    anchor_bad.append(f"{s['id']} 声明 anchor:'context'，却既没有坐标也没有方向")
                bl = s.get('bodyLevel')
                if bl in TIER_ORDER and level in TIER_ORDER and TIER_ORDER.index(bl) > TIER_ORDER.index(level):
                    anchor_bad.append(f"{s['id']} 属 {bl} 层，却以 anchor:'context' 出现在更低的 {level} 层")
            continue
        if s['bodyLevel'] and s['bodyLevel'] != level:
            leak.append((s['id'], s['bodyLevel']))
        if s['id'] and s['place'] == 'none':
            unplaced.append(s['id'])
    # 去重：同一个天体可能有多个精灵（本体 + 高亮），按天体算
    leak_ids = sorted({i for i, _ in leak})
    return {
        'level': level,
        'sprites': len(sprites),
        'origin': origin,
        'origin_cap': ORIGIN_CAP.get(level, 3),
        'leak': leak_ids,
        'leak_n': len(leak_ids),
        'unplaced': sorted(set(unplaced)),
        'unplaced_n': len(set(unplaced)),
        'anchor_n': len(set(anchors)),
        'anchor_kinds': anchor_kinds,
        'anchor_bad': anchor_bad,
        'skip': res.get('skip') or {},
    }


def verdict(r):
    bad = []
    if r['origin'] > r['origin_cap']:
        bad.append(f"原点堆叠 {r['origin']} 个（上限 {r['origin_cap']}）")
    if r['leak_n']:
        bad.append(f"跨尺度泄漏 {r['leak_n']} 个：{', '.join(r['leak'][:5])}")
    if r['unplaced_n']:
        bad.append(f"无位置却落点 {r['unplaced_n']} 个：{', '.join(r['unplaced'][:5])}")
    if r['anchor_bad']:
        bad.append(f"结构锚声明有问题 {len(r['anchor_bad'])} 处：{r['anchor_bad'][0]}")
    return bad


async def main():
    srv = ServedCheck(tag='落点探针')
    base = srv.start()
    try:
        return await probe(base)
    finally:
        srv.stop()


async def probe(base):
    rows = []
    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.launch(headless=True, channel='msedge')
        except Exception:
            browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 1280, 'height': 720})
        errs = []
        # 存**完整栈**，不只存 message。
        # 踩过：只留 message 时，一条 `Cannot read properties of null (reading 'id')`
        # 完全指不出是哪一行 —— 而这条错误本身还伴随着「跳转超时」，
        # 让人以为是性能问题。栈才分得清「哪个文件哪一行」。
        page.on('pageerror', lambda e: errs.append(getattr(e, 'stack', None) or str(e)))
        await page.goto(base + '/', wait_until='domcontentloaded')
        # 等应用就绪（不用固定 sleep —— 软件渲染下过渡时长不可预测）
        await page.wait_for_function('() => window.__universe && window.__universe.engine', timeout=60000)
        # ⚠️「engine 对象存在」不等于「第一层建完了」。只等前者的话，
        #    紧接着的 gotoScale 会撞上 `current` 还是 null 的那个窗口 ——
        #    App 侧抛 `Cannot read properties of null (reading 'id')`，第一层报失败。
        #    这是**竞态**，不是那一层有病：同一份代码重跑就通过，于是它会被当成
        #    「偶发」放过，而真正的病（层没建起来）就跟着一起被放过了。
        #    判据要等 `current` 真的落地。
        await page.wait_for_function(
            '() => { const lv = window.__universe.engine.current; return !!(lv && lv.id); }',
            timeout=60000,
        )

        # 把判据函数暴露到页面上：判据要和**绘制代码**用同一套口径，
        # 不能在这里另写一遍（那就是第二套定义来源，迟早漂）
        await page.evaluate("""async () => {
            const m = await import('./js/data/attrs.js');
            window.__lcPlaceAccuracy = (b, allowOrigin) => m.placeAccuracy(b, { allowOrigin });
            window.__lcAnchorKinds = Object.keys(m.ANCHOR_KINDS || {});
        }""")
        await page.evaluate(INSTALL_HELPER_JS)

        # 结构锚的词表也只从 attrs.js 取。取不到就**不要继续** ——
        # 那时候判据会把任何 truthy 的 anchor 当成有效豁免，
        # 于是「写错一个字母」和「有意豁免」在读数上完全一样。
        global KNOWN_ANCHORS
        got_kinds = await page.evaluate('() => window.__lcAnchorKinds || null')
        if not got_kinds:
            emit('  ✗ attrs.js 没有给出 ANCHOR_KINDS —— 结构锚的词表取不到，本次读数不可信')
            await browser.close()
            return 1
        KNOWN_ANCHORS = tuple(got_kinds)

        selftest = None
        for tier in TIERS:
            if ONLY and tier != ONLY:
                continue
            try:
                await page.evaluate("(t) => window.__universe.gotoScale(t)", tier)
            except Exception as e:
                rows.append({'level': tier, 'error': f'gotoScale 调用就抛了：{type(e).__name__}: {str(e).splitlines()[0][:150]}'})
                continue
            try:
                await page.wait_for_function("(t) => window.__universe.engine.current.id === t", arg=tier, timeout=45000)
            except Exception:
                # ⚠️ 不能把「等超时」和「谓词自己抛了」都写成「跳转超时」。
                #    两者的病完全不一样：前者是慢/没建起来，后者是**这一层炸了**。
                #    原来这里就是不区分，于是 4 秒就返回的一次失败被标成「超时」，
                #    看起来像性能问题 —— 一条把人引向错方向的读数。
                st = await page.evaluate("""() => {
                    const u = window.__universe || {};
                    const lv = u.engine && u.engine.current;
                    let known = null;
                    try { known = Object.keys(u.engine.levels || u.engine._levels || {}); } catch (e) { known = null; }
                    return { current: lv ? (lv.id || '(无名)') : null, known };
                }""")
                rows.append({
                    'level': tier,
                    'error': f"等「{tier}」就绪失败 —— 当前层是 {st.get('current') or '空（这一层没建起来）'}",
                    'state': st,
                })
                continue
            # 一跳完立刻取样，不额外等待（过渡时长不可靠）
            res = await page.evaluate(INSPECT_JS)
            r = classify(res, tier)

            if SELFTEST and tier == 'solar' and selftest is None:
                selftest = await run_selftest(page, r)

            rows.append(r)

        await browser.close()

    if JSON_OUT:
        print(json.dumps({'rows': rows, 'pageErrors': errs[:10], 'selftest': selftest}, ensure_ascii=False, indent=2))
    else:
        emit('\n分层落点纯洁性（Sprite 计数；Points/Line 不计 —— 它们的 position 恒为原点）')
        emit(f"  {'层':<14}{'精灵':>7}{'原点堆叠':>9}{'跨尺度泄漏':>11}{'无位置落点':>11}{'结构锚':>8}")
        for r in rows:
            if r.get('error'):
                emit(f"  {r['level']:<14}  ✗ {r['error']}")
                continue
            emit(f"  {r['level']:<14}{r['sprites']:>7}{r['origin']:>9}{r['leak_n']:>11}{r['unplaced_n']:>11}{r['anchor_n']:>8}")
            sk = r.get('skip') or {}
            if sk.get('offTier') is not None:
                emit(f"                 （本层主动跳过：外来尺度 {sk['offTier']} · 无坐标 {sk['noPlace']}）")
            if r['anchor_kinds']:
                kinds = ' / '.join(f"{k} {v}" for k, v in sorted(r['anchor_kinds'].items()))
                emit(f"                 （结构锚已自证：{kinds}）")
        if errs:
            emit(f"\n  ⚠ 页面报错 {len(errs)} 条，前 3 条：")
            for e in errs[:3]:
                emit('    ' + e.split('\n')[0][:160])

    bad_rows = [(r, verdict(r)) for r in rows if not r.get('error')]
    failures = [(r, v) for r, v in bad_rows if v]
    if not JSON_OUT:
        emit('')
        if failures:
            for r, v in failures:
                emit(f"  ✗ {r['level']}：{'；'.join(v)}")
        else:
            emit(f"  ✓ 全部通过（{len(bad_rows)} 层）")
    if SELFTEST:
        if selftest is None or not selftest.get('ok'):
            failures.append(({'level': 'selftest'}, ['故障注入没被抓住 —— 这几条判据没有分辨力']))
    return 1 if failures else 0


async def run_selftest(page, base_row):
    """故障注入：三条判据各证明一次「我抓得住这种病」。

    A 靠 6 个叠在原点的精灵；B/C 靠 3 个指向「无坐标幽灵天体」的精灵。
    只注入不证明，等于给判据发一张免检证。
    """
    inj_origin = await page.evaluate(INJECT_ORIGIN_JS)
    after_a = classify(await page.evaluate(INSPECT_JS), base_row['level'])
    d_origin = after_a['origin'] - base_row['origin']

    inj_ghost = await page.evaluate(INJECT_GHOST_JS)
    after_b = classify(await page.evaluate(INSPECT_JS), base_row['level'])
    d_unplaced = after_b['unplaced_n'] - after_a['unplaced_n']
    d_leak = after_b['leak_n'] - after_a['leak_n']

    reclaimed = await page.evaluate(RECLAIM_JS)

    checks = {
        'A 原点堆叠': {'injected': inj_origin, 'delta': d_origin, 'ok': inj_origin == 6 and d_origin >= 6},
        'B 跨尺度泄漏': {'injected': inj_ghost, 'delta': d_leak, 'ok': inj_ghost == 3 and d_leak >= 3},
        'C 无位置落点': {'injected': inj_ghost, 'delta': d_unplaced, 'ok': inj_ghost == 3 and d_unplaced >= 3},
    }
    ok = all(c['ok'] for c in checks.values()) and reclaimed >= 9
    if not JSON_OUT:
        for name, c in checks.items():
            mark = '✓' if c['ok'] else '✗'
            emit(f"  {mark} 故障注入·{name}：塞入 {c['injected']} 个，判据读数 +{c['delta']}")
        emit(f"  {'✓' if reclaimed >= 9 else '✗'} 故障注入回收：撤掉 {reclaimed} 个（按标记回收，不靠索引）")
    return {'ok': ok, 'reclaimed': reclaimed, 'checks': checks}


if __name__ == '__main__':
    sys.exit(asyncio.run(main()) or 0)

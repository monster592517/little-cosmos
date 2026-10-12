#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
天体目录面板检查：自管服务 → 断言尺度分节与包含关系 → 截图。

为什么要有这个检查
------------------
用户报的是「包含关系有问题，太阳系应该包含在其他更大的尺度范围下」。
这类缺陷**没有别的检查能抓到**：
  · 自检内核（server/lib/selfcheck.mjs）不看 DOM；
  · check-scales 只管引擎能不能切层级、显存回不回收；
  · check-macro 管的是画面上光斑多大。
而「包含关系」说白了就是「六段尺度按正确顺序、按正确归属渲染出来了」——
完全可以断言的，不该靠肉眼看截图。

断言什么
  1. 目录面板能打开
  2. 恰好 6 个尺度分节，data-scale 顺序 = 从大到小（可观测宇宙 → 太阳系）
  3. **没有**「未归入尺度」节（= dataset.catalogUntiered 为空，
     也就是 dataset.js 的 TIER_OF 覆盖了所有顶层分组）
  4. 每个分节都带名称 / 单位 / 叶子数，且叶子数 > 0
  5. 当前所在尺度恰好高亮一个（且就是引擎当前层级）
  6. 点尺度标题能真的切到该尺度
  7. 每个非太阳系尺度下都至少有 1 个分组（否则那一节是空的，说明归属写错）

用法：py -3.13 -X utf8 tools/check-catalog.py [--port=8796] [--keep] [--no-shots]
退出码：0 = 全通过
"""

import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots", "catalog")

PORT = 8796
KEEP = False
WANT_SHOTS = True

# SCALE_CHAIN 的 id 顺序（从小到大），断言用「从大到小」的期望值
EXPECT_DESC = ["universe", "supercluster", "localgroup", "galaxy", "neighborhood", "solar"]
# 切到每一层后，高亮的应该是它自己
PROBE_LEVELS = ["galaxy", "supercluster", "solar"]

checks = []
errors = []


def emit(*a):
    print(*a, flush=True)


def ok(name, cond, extra=""):
    checks.append((bool(cond), name, extra))
    emit(f"  {'✓' if cond else '✗'} {name}{(' — ' + extra) if extra else ''}")


def find_node():
    cands = [shutil.which("node"), shutil.which("node.exe")]
    home = os.path.expanduser("~")
    base = os.path.join(home, ".workbuddy", "binaries", "node", "versions")
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base), reverse=True):
            cands.append(os.path.join(base, ver, "node.exe"))
    cands.append(r"C:\Program Files\nodejs\node.exe")
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


async def wait_port(url, timeout=25.0):
    import urllib.request

    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return False


READ_PANEL_JS = r"""
() => {
  const u = window.__universe;
  const pane = document.getElementById('catalog-pane');
  const body = document.getElementById('catalog-body');
  const secs = [...(body ? body.querySelectorAll('.cat-scale') : [])].map((el) => ({
    scale: el.dataset.scale || '',
    name: (el.querySelector('.scale-name') || {}).textContent || '',
    unit: (el.querySelector('.scale-unit') || {}).textContent || '',
    cnt: Number((el.querySelector('.scale-cnt') || {}).textContent || '0'),
    groups: el.querySelectorAll('.cat-group').length,
    active: el.classList.contains('active'),
  }));
  return {
    visible: !!(pane && !pane.hidden),
    sections: secs,
    untiered: (u && u.dataset && u.dataset.catalogUntiered) || null,
    current: u && u.engine && u.engine.current ? u.engine.current.id : null,
  };
}
"""


COVERAGE_JS = r"""
() => {
  const u = window.__universe;
  const ds = u.dataset;
  let hit = null;
  const find = (ns, id) => {
    for (const n of ns || []) {
      if (n.id === id) { hit = n; return; }
      if (n.kind === 'group') find(n.children, id);
    }
  };
  const leafCount = (ns) => (ns || []).reduce(
    (a, n) => a + ((n.kind === 'body' || n.kind === 'ring') ? 1 : leafCount(n.children)), 0);
  const groupCount = (id) => { hit = null; find(ds.catalog, id); return hit ? leafCount(hit.children || []) : -1; };
  const first = (q) => { const r = ds.search(q, 3); return r.length ? r[0].id : ''; };
  /* 系外行星分组声明的几个数。**不能**拿「露出的叶子数」直接比总数：
   * 4,741 个系统全铺进 DOM 会把首屏拖慢，所以目录按**系统**有意截断，
   * 截掉的由分组自己声明（hidden）+「显示全部」/检索兜住。
   * 直接比会得出「目录 439 颗 / 数据 6332 颗」—— 数字是真的，结论是错的。 */
  const exosys = (k) => {
    hit = null; find(ds.catalog, 'nearby-exoplanets');
    if (!hit) return -1;
    if (k === 'allIds' || k === 'allNodes') {
      return Array.isArray(hit[k]) ? hit[k].length : -1;
    }
    return typeof hit[k] === 'number' ? hit[k] : -1;
  };
  return {
    exoLeaves: groupCount('nearby-exoplanets'),
    exoTotal: exosys('total'),
    exoShown: exosys('shown'),
    exoHidden: exosys('hidden'),
    exoIndex: exosys('allIds'),
    exoNodes: exosys('allNodes'),
    planetBodies: (ds.exoPlanetBodies || []).length,
    systems: (ds.exoplanets || []).length,
    hosts: ds.exoHostBodyId ? ds.exoHostBodyId.size : -1,
    hostsCreated: ds.exoHostsCreated ?? -1,
    searchPlanet: first('Proxima Cen b'),
    searchHost: first('Proxima Cen'),
    bh: groupCount('mw-bh'),
    psr: groupCount('mw-psr'),
    wd: groupCount('nearby-wd'),
    galaxy: groupCount('mw-galaxy'),
  };
}
"""


# 截断（目录只列前 N 条）必须在**界面上**看得见说明。
# ⚠️ 这条和 model-probe 的判据不重复：那边查的是**数据里**有没有 note，
#    这边查的是**渲染出来**了没有 —— 「数据里有说明」和「用户看得见」是两件事，
#    而当初的 bug 恰恰是前者有、后者无（面板只渲染标题和徽标，没渲染 note）。
TRUNC_DOM_JS = r"""
() => {
  const out = { capped: 0, withNote: 0, missing: [], badgeBad: [], sample: '', galaxyLeaves: -1, moreButtons: 0, noButton: [] };
  const body = document.getElementById('catalog-body');
  if (!body) return out;
  for (const g of body.querySelectorAll('.cat-group')) {
    const head = g.querySelector(':scope > .cat-head');
    const cnt = head ? head.querySelector('.cnt') : null;
    if (!cnt) continue;
    const txt = (cnt.textContent || '').trim();
    // 「被截断」的标记有两个：cnt.capped 类，或计数写成「260 / 598」
    const isCapped = cnt.classList.contains('capped') || /^\d+\s*\/\s*\d+$/.test(txt);
    if (!isCapped) continue;
    out.capped++;
    if (!out.sample) out.sample = txt;
    const note = g.querySelector(':scope > .cat-note');
    const hasNote = !!(note && (note.textContent || '').trim().length > 0);
    if (hasNote) out.withNote++;
    else {
      const ttl = head.querySelector('.ttl');
      out.missing.push(ttl ? ttl.textContent.trim() : '(无名分组)');
    }
    if (!/^\d+\s*\/\s*\d+$/.test(txt)) {
      const ttl = head.querySelector('.ttl');
      out.badgeBad.push(`${ttl ? ttl.textContent.trim() : '?'} → 「${txt}」`);
    }
    // 每个被截断的分组都要有「显示全部」（否则剩下的永远翻不到）
    if (!g.querySelector(':scope > .cat-children > .cat-more-wrap .cat-more')) {
      const ttl = head.querySelector('.ttl');
      out.noButton.push(ttl ? ttl.textContent.trim() : '(无名分组)');
    }
    out.moreButtons++;
  }
  for (const g of body.querySelectorAll('.cat-group')) {
    const ttl = g.querySelector(':scope > .cat-head .ttl');
    if (ttl && (ttl.textContent || '').trim().startsWith('星系 ·')) {
      out.galaxyLeaves = g.querySelectorAll(':scope > .cat-children .cat-row').length;
    }
  }
  return out;
}
"""


# 取一个**远在 CAP 之后**的天体：默认渲染里根本没有它的行，
# 唯一能看到它的办法就是「按需把它翻出来」。用它验证 setActive 的补渲染逻辑。
REVEAL_JS = r"""
() => {
  const ds = window.__universe.dataset;
  let hit = null;
  const find = (ns, id) => {
    for (const n of ns || []) {
      if (n.id === id) { hit = n; return; }
      if (n.children) find(n.children, id);
    }
  };
  find(ds.catalog, 'sc-galaxies');
  if (!hit || !hit.allIds || !hit.allIds.length) return null;
  const idx = Math.min(hit.allIds.length - 1, 3000);
  const id = hit.allIds[idx];
  const b = ds.get(id);
  return { id, name: b ? (b.name || b.en || '') : '', index: idx, total: hit.total };
}
"""


async def main():
    from playwright.async_api import async_playwright

    node = find_node()
    if not node:
        emit("✗ 找不到可用的 node，无法拉起服务")
        return 1
    if WANT_SHOTS:
        os.makedirs(SHOTS, exist_ok=True)

    base = f"http://127.0.0.1:{PORT}"
    emit("=== 小小宇宙 · 天体目录面板检查 ===")
    emit(f"node  {node}")
    emit(f"服务  {base}（本脚本自行拉起并收工关掉）")
    emit("")

    logf = open(os.path.join(SHOTS, "server.log"), "w", encoding="utf-8", errors="replace") \
        if WANT_SHOTS else subprocess.DEVNULL
    srv = subprocess.Popen(
        [node, os.path.join(ROOT, "server", "server.mjs"), f"--port={PORT}"],
        cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT,
        # 别让这个临时服务器改写 data/.port（同 check-macro.py 的说明）：
        # 那会让自检的 svc.port 把日常服务的端口误判成「与记录不一致」。
        env={**os.environ, "LC_NO_PORT_RECORD": "1"},
    )
    exit_code = 0
    try:
        if not await wait_port(f"{base}/api/health"):
            emit("✗ 服务 25 秒内没起来；看 shots/catalog/server.log")
            return 1
        emit("  ✓ 服务已就绪\n")

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                args=["--enable-unsafe-swiftshader", "--use-gl=swiftshader"])
            page = await browser.new_page(viewport={"width": 1440, "height": 810})
            page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
            page.on("console", lambda m: errors.append(f"[console.error] {m.text}")
                    if m.type == "error" else None)

            await page.goto(f"{base}/", wait_until="load", timeout=60000)
            try:
                await page.wait_for_function(
                    "document.getElementById('boot').style.display === 'none'", timeout=90000)
                emit("  ✓ 启动完成")
            except Exception:
                status = await page.text_content("#boot-status")
                emit(f"  ✗ 启动超时，界面停在：{status}")
                return 1

            # --- 打开目录面板 ---
            await page.click("#btn-catalog")
            await page.wait_for_timeout(600)
            st = await page.evaluate(READ_PANEL_JS)
            ok("目录面板能打开", st["visible"], "catalog-pane 仍 hidden" if not st["visible"] else "")

            secs = st["sections"]
            ok("恰好六个尺度分节", len(secs) == 6, f"实际 {len(secs)} 个")
            ok("尺度分节顺序 = 从大到小（外层包含内层）",
               [s["scale"] for s in secs] == EXPECT_DESC,
               "实际 " + " → ".join(s["scale"] or "(空)" for s in secs))
            ok("没有「未归入尺度」的顶层分组",
               not st["untiered"] and all(s["scale"] for s in secs),
               f"catalogUntiered={st['untiered']}")
            bad = [s["name"] for s in secs if not s["name"] or not s["unit"] or s["cnt"] <= 0]
            ok("每个分节都有名称 / 单位 / 非零计数", not bad, "缺项：" + "、".join(bad) if bad else "")
            nogrp = [s["name"] for s in secs if s["groups"] == 0]
            ok("每个分节下都至少有一个分组", not nogrp, "空节：" + "、".join(nogrp) if nogrp else "")

            emit("")
            for s in secs:
                emit(f"    · [{s['scale']:<13}] {s['name']}（{s['unit']}）"
                     f" · 分组 {s['groups']} 个 · 叶子 {s['cnt']}")

            # --- 高亮跟随当前层级 ---
            for lv in PROBE_LEVELS:
                emit("")
                await page.evaluate(f"window.__universe.gotoScale('{lv}')")
                t0 = time.monotonic()
                while time.monotonic() - t0 < 60:
                    cur = await page.evaluate("window.__universe.engine.current?.id")
                    if cur == lv:
                        break
                    await page.wait_for_timeout(250)
                await page.wait_for_timeout(500)
                st = await page.evaluate(READ_PANEL_JS)
                act = [s["scale"] for s in st["sections"] if s["active"]]
                ok(f"切到 {lv} 后高亮恰好一个分节", len(act) == 1,
                   f"高亮 {len(act)} 个：{act}")
                ok(f"高亮的就是 {lv}", act == [lv], f"实际高亮 {act}")

            # --- 用户报过的三类天体必须在目录与检索里找得到 ---
            emit("")
            cov = await page.evaluate(COVERAGE_JS)
            # ⚠️ 判据是「露出的 + 分组声明藏起的 === 数据里的总数」，不是「叶子数 === 总数」。
            #    后者在目录**有意按系统截断**之后必然不成立，报出来的是
            #    「目录 439 颗 / 数据 6332 颗」—— 看着像丢了 5 千颗，其实一颗没丢。
            #    判据方向错了比判据不响更坏：它会让人去修一个不存在的问题。
            ok("目录里有「系外行星系统」分组，且「露出的 + 声明藏起的」= 数据里的总数",
               cov["planetBodies"] > 0
               and cov["exoShown"] == cov["exoLeaves"]
               and cov["exoShown"] + cov["exoHidden"] == cov["planetBodies"]
               and cov["exoTotal"] == cov["planetBodies"],
               f"露出 {cov['exoLeaves']} + 声明藏起 {cov['exoHidden']} = {cov['exoShown'] + cov['exoHidden']}"
               f" / 数据 {cov['planetBodies']} 颗")
            # 「显示全部」的索引必须覆盖它承诺的全部条数 —— 否则用户点到按钮消失也翻不到剩下的
            ok("「显示全部」的索引覆盖了它承诺的全部行星",
               cov["exoIndex"] == cov["exoTotal"] and cov["exoNodes"] == cov["hosts"],
               f"索引 {cov['exoIndex']} / 承诺 {cov['exoTotal']} 颗 · 可展开系统 {cov['exoNodes']} / 宿主 {cov['hosts']} 个")
            ok(f"宿主恒星全部进目录（{cov['hosts']} 个系统）",
               cov["hosts"] == cov["systems"] and cov["systems"] > 0,
               f"宿主 {cov['hosts']} / 系统 {cov['systems']}"
               f"（其中 {cov['hostsCreated']} 个由系外行星星表补建）")
            ok("系外行星可按名字搜到", cov["searchPlanet"].startswith("exo-"),
               f"搜「Proxima Cen b」→ {cov['searchPlanet'] or '(空)'}")
            ok("宿主恒星可按名字搜到", cov["searchHost"].startswith("star-"),
               f"搜「Proxima Cen」→ {cov['searchHost'] or '(空)'}")
            ok("黑洞分组非空（银河系层）", cov["bh"] > 0, f"黑洞 {cov['bh']} 个")
            ok("脉冲星分组非空（银河系层）", cov["psr"] > 0, f"脉冲星 {cov['psr']} 个")
            ok("白矮星分组非空（邻近层）", cov["wd"] > 0, f"白矮星 {cov['wd']} 个")
            ok("星系分组非空（银河系层）", cov["galaxy"] > 0, f"星系 {cov['galaxy']} 个")

            # --- 被截断的分组必须在界面上自己说清楚 ---
            # 「白矮星 · 598」配「260」而不解释，用户会当成数据丢了。
            emit("")
            tr = await page.evaluate(TRUNC_DOM_JS)
            ok("目录里确实有被截断的分组（数量大到需要截断）",
               tr["capped"] > 0, f"{tr['capped']} 个分组被截断")
            ok("被截断的分组在界面上都给出了说明",
               tr["capped"] > 0 and tr["withNote"] == tr["capped"],
               f"带说明 {tr['withNote']} / {tr['capped']}"
               + ((" · 缺说明：" + "、".join(tr["missing"])) if tr["missing"] else ""))
            ok("被截断分组的计数写成「已列 / 全部」",
               not tr["badgeBad"], f"例：{tr['sample']}"
               + ((" · 写法不对：" + "、".join(tr["badgeBad"])) if tr["badgeBad"] else ""))
            ok("每个被截断的分组都给了「显示全部」按钮",
               not tr["noButton"], f"{tr['moreButtons']} 个被截断的分组"
               + ((" · 缺按钮：" + "、".join(tr["noButton"])) if tr["noButton"] else ""))
            ok("「星系」分组在界面上真的有行（银河系层）",
               tr["galaxyLeaves"] > 0, f"星系 {tr['galaxyLeaves']} 行")

            # --- 「显示全部」与「跳到一个默认没渲染的天体」 ---
            # 这两条是「可观性」的核心：收进数据不算数，**翻得到**才算数。
            emit("")
            reveal = await page.evaluate(REVEAL_JS)
            if not reveal:
                ok("能取到一个默认没渲染的天体（用于验证按需翻页）", False, "sc-galaxies 分组拿不到 allIds")
            else:
                got = await page.evaluate(
                    """(id) => {
                      window.__universe.ui.catalog.setActive(id);
                      const row = document.querySelector(`#catalog-body .cat-row[data-id="${id}"]`);
                      return {
                        found: !!row,
                        active: !!(row && row.classList.contains('active')),
                        rows: document.querySelectorAll('#catalog-body .cat-row').length,
                      };
                    }""",
                    reveal["id"],
                )
                ok("跳到一个排在 3000 位之后的天体，目录能把它按需翻出来",
                   got["found"] and got["active"],
                   f"「{reveal['name']}」（第 {reveal['index']} / {reveal['total']} 位）"
                   f" → found={got['found']} active={got['active']} · 当前行数 {got['rows']}")

            before = await page.evaluate("() => document.querySelectorAll('#catalog-body .cat-row').length")
            clicked = await page.evaluate(
                """() => {
                  const b = document.querySelector('#catalog-body .cat-more');
                  if (!b) return null;
                  // 祖先分组不展开的话按钮在 display:none 里，点了也没反应
                  let p = b.closest('.cat-group');
                  while (p && !p.classList.contains('cat-scale')) { p.classList.add('open'); p = p.parentElement; }
                  const label = (b.textContent || '').trim();
                  const gid = b.closest('.cat-group').dataset.gid;
                  const badge = (b.closest('.cat-group').querySelector(':scope > .cat-head .cnt') || {}).textContent || '';
                  b.click();
                  return { label, gid, badge };
                }"""
            )
            await page.wait_for_timeout(600)
            after = await page.evaluate("() => document.querySelectorAll('#catalog-body .cat-row').length")
            ok("点「显示全部」会真的把后续天体加进来",
               clicked is not None and after > before,
               (f"{before} → {after} 行 · 按钮「{clicked['label']}」" if clicked else "没找到按钮"))
            if clicked:
                badge_after = await page.evaluate(
                    "(gid) => { const g = document.querySelector(`.cat-group[data-gid=\"${gid}\"]`);"
                    " return g ? (g.querySelector(':scope > .cat-head .cnt').textContent || '').trim() : ''; }",
                    clicked["gid"],
                )
                ok("翻页之后徽标同步更新",
                   badge_after != clicked["badge"] and "/" in badge_after,
                   f"「{clicked['badge'].strip()}」→「{badge_after.strip()}」")

            # --- 节点式分组的「显示全部」：续加的是**系统**，不是行 ---
            # 系外行星按宿主分组，所以这个分组的子节点是「分组」而不是「行」。
            # 这一支代码路径走不到上面那条行式断言里，而且它有一个**只有真浏览器能验**的坑：
            # 追加进来的系统标题必须能点开 —— 逐个 addEventListener 的写法对动态节点必漏，
            # 表现是「点它展不开，而且不报任何错」。
            emit("")
            sys_before = await page.evaluate(
                """() => {
                  const g = document.querySelector('.cat-group[data-gid="nearby-exoplanets"]');
                  if (!g) return null;
                  let p = g.parentElement;
                  while (p && !p.classList.contains('cat-scale')) { p.classList.add('open'); p = p.parentElement; }
                  g.classList.add('open');
                  const box = g.querySelector(':scope > .cat-children');
                  const b = box && box.querySelector('.cat-more');
                  if (!b) return null;
                  const o = {
                    label: (b.textContent || '').trim(),
                    badge: (g.querySelector(':scope > .cat-head .cnt') || {}).textContent || '',
                    groups: box.querySelectorAll(':scope > .cat-group').length,
                  };
                  b.click();
                  return o;
                }"""
            )
            await page.wait_for_timeout(900)
            sys_after = await page.evaluate(
                """() => {
                  const g = document.querySelector('.cat-group[data-gid="nearby-exoplanets"]');
                  const box = g && g.querySelector(':scope > .cat-children');
                  if (!box) return null;
                  return {
                    groups: box.querySelectorAll(':scope > .cat-group').length,
                    badge: (g.querySelector(':scope > .cat-head .cnt').textContent || '').trim(),
                  };
                }"""
            )
            ok("「显示全部」在按宿主分组的分组上会续加**系统**",
               sys_before is not None and sys_after is not None
               and sys_after["groups"] > sys_before["groups"] and sys_after["groups"] > 260,
               (f"系统 {sys_before['groups']} → {sys_after['groups']} 个 · 徽标「{sys_before['badge'].strip()}」"
                f"→「{sys_after['badge'].strip()}」" if sys_before and sys_after else "拿不到系外行星分组"))
            ok("（节点式）续加之后徽标同步更新",
               bool(sys_before and sys_after and sys_after["badge"] != sys_before["badge"]),
               f"「{(sys_before or {}).get('badge','?').strip()}」→「{(sys_after or {}).get('badge','?').strip()}」")

            # 追加进来的系统标题必须能点开 —— 这条就是给「委托绑定」上的保险
            toggled = await page.evaluate(
                """() => {
                  const g = document.querySelector('.cat-group[data-gid="nearby-exoplanets"]');
                  const box = g.querySelector(':scope > .cat-children');
                  const groups = [...box.querySelectorAll(':scope > .cat-group')];
                  const last = groups[groups.length - 1];   // 最后一个是刚刚追加进来的
                  if (!last) return null;
                  const wasOpen = last.classList.contains('open');
                  const ttl = last.querySelector(':scope > .cat-head .ttl');
                  last.querySelector(':scope > .cat-head').click();
                  return {
                    wasOpen,
                    nowOpen: last.classList.contains('open'),
                    name: ttl ? ttl.textContent.trim() : '?',
                    gid: last.dataset.gid,
                  };
                }"""
            )
            ok("续加进来的系统分组，点标题能展开（动态节点没漏绑）",
               bool(toggled) and toggled["nowOpen"] != toggled["wasOpen"],
               (f"「{toggled['name']}」open {toggled['wasOpen']} → {toggled['nowOpen']}" if toggled
                else "拿不到续加进来的分组"))

            # --- 点尺度标题能切层 ---
            emit("")
            await page.click(".cat-scale[data-scale='solar'] .scale-head")
            t0 = time.monotonic()
            got = None
            while time.monotonic() - t0 < 60:
                got = await page.evaluate("window.__universe.engine.current?.id")
                if got == "solar":
                    break
                await page.wait_for_timeout(250)
            ok("点「太阳系」标题能切到太阳系层级", got == "solar", f"实际 {got}")
            await page.wait_for_timeout(600)

            if WANT_SHOTS:
                path = os.path.join(SHOTS, "panel.png")
                await page.screenshot(path=path)
                emit(f"\n    · 截图 {os.path.relpath(path, ROOT)}")

                # 再拍一张**展开被截断分组**的：这是「截断有没有说清楚」的**视觉证据**，
                # 光靠断言只能证明 DOM 里有 .cat-note，证明不了它没被 CSS 藏起来 / 压成一像素。
                try:
                    opened = await page.evaluate(
                        """() => {
                          const body = document.getElementById('catalog-body');
                          if (!body) return '';
                          for (const g of body.querySelectorAll('.cat-group')) {
                            const cnt = g.querySelector(':scope > .cat-head .cnt');
                            if (!cnt || !cnt.classList.contains('capped')) continue;
                            // ⚠️ 必须把**所有祖先分组**一起展开：
                            //    .cat-children 是 display:none，祖先没展开时
                            //    scrollIntoView 作用在一个不可见元素上 = 什么都不发生（拍出来和没点一样）。
                            let p = g.parentElement;
                            while (p && p !== body) {
                              if (p.classList.contains('cat-group')) p.classList.add('open');
                              p = p.parentElement;
                            }
                            g.classList.add('open');
                            const ttl = g.querySelector(':scope > .cat-head .ttl');
                            // 滚**表头**而不是整组：组里有 260 行，整组居中会把表头和说明顶出视口
                            (g.querySelector(':scope > .cat-head') || g).scrollIntoView({ block: 'start' });
                            return ttl ? ttl.textContent.trim() : '';
                          }
                          return '';
                        }"""
                    )
                    await page.wait_for_timeout(500)
                    path2 = os.path.join(SHOTS, "panel-truncated.png")
                    await page.screenshot(path=path2)
                    emit(f"    · 截图 {os.path.relpath(path2, ROOT)}（展开「{opened}」看截断说明）")
                except Exception as ex:
                    emit(f"    · 截断分组截图失败（不影响判定）：{ex}")

            await browser.close()
    finally:
        if KEEP:
            emit(f"\n(--keep) 服务保留在 {base}，PID {srv.pid}")
        else:
            try:
                srv.terminate()
                srv.wait(timeout=8)
            except Exception:
                try:
                    srv.kill()
                except Exception:
                    pass
        try:
            if logf not in (None, subprocess.DEVNULL):
                logf.close()
        except Exception:
            pass

    emit("")
    emit("=== 页面错误 ===")
    for e in errors[:20]:
        emit("  " + e)
    if not errors:
        emit("  （无）")

    npass = sum(1 for c, _, _ in checks if c)
    nfail = len(checks) - npass
    emit("")
    emit(f"结果：{npass} 通过 / {nfail} 未通过")
    for c, n, ex in checks:
        if not c:
            emit(f"  ✗ {n} — {ex}")
    if nfail or errors:
        exit_code = 1
    return exit_code


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8796)
    ap.add_argument("--keep", action="store_true", help="跑完不关服务（排障用）")
    ap.add_argument("--no-shots", action="store_true", help="不写截图与服务日志")
    a = ap.parse_args()
    PORT = a.port
    KEEP = a.keep
    WANT_SHOTS = not a.no_shots
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)

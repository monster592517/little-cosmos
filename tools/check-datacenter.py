#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据更新中心回归测试

覆盖：
  1. 页面正常启动（新模块若语法有错，启动会挂在这里）
  2. 设置面板 → 数据更新中心 能打开并渲染出概览 / 管线 / 明细表
  3. overrides 闭环：写一条修正 → 刷新页面 → 断言修正已作用到运行时实体
  4. 待复核队列能渲染，采纳表单能从 target 预填出天体 id 与字段路径
  5. 更新管线按钮存在且未被禁用

用法：
    py -3.13 -X utf8 tools/check-datacenter.py [--shots]
    py -3.13 -X utf8 tools/check-datacenter.py --url=http://127.0.0.1:8791/   # 用已有的服务

不给 --url 就**自己拉起一个空闲端口**，跑完自己关（见 serve_for_checks.py）。
"""
import asyncio
import json
import os
import sys
import urllib.request

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck            # noqa: E402  自管服务的共用助手

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')
URL = None                       # None = 没给 --url，由本脚本自己拉起服务
KEEP = '--keep' in sys.argv
for a in sys.argv[1:]:
    if a.startswith('--url='):
        URL = a[6:]
WANT_SHOTS = '--shots' in sys.argv

API = ''

results = []


def ok(name, passed, detail=''):
    results.append((name, bool(passed), detail))
    print(('  ✓ ' if passed else '  ✗ ') + name + (f' — {detail}' if detail else ''))


def api(path, method='GET', body=None):
    req = urllib.request.Request(API + path, method=method)
    if body is not None:
        req.add_header('content-type', 'application/json')
        req.data = json.dumps(body).encode('utf-8')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


async def main():
    global URL, API
    srv = ServedCheck(url=URL, keep=KEEP, tag='本脚本')
    try:
        URL = srv.start() + '/'
    except Exception as e:
        print(f'✗ {e}')
        return 1
    API = URL.rstrip('/')
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
                  '--disable-gpu-sandbox', '--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 950})

        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))

        # ---- 1. 启动 ----
        await page.goto(URL, wait_until='domcontentloaded')
        try:
            await page.wait_for_function(
                "window.__universe && window.__universe.dataset && window.__universe.engine", timeout=90000)
            await page.wait_for_function(
                "document.getElementById('boot')?.classList.contains('done')", timeout=90000)
            ok('页面启动完成', True)
        except Exception as e:
            ok('页面启动完成', False, str(e)[:120])

        boot_err = [e for e in errors if 'boot' in e.lower() or 'Cannot' in e or 'is not' in e]
        ok('启动无脚本错误', not boot_err, '; '.join(boot_err[:2])[:200])

        # ---- 2. 打开数据更新中心 ----
        await page.evaluate("window.__universe.ui.datacenter.open()")
        try:
            await page.wait_for_selector('#dc-root', timeout=15000)
            ok('数据更新中心可打开', True)
        except Exception as e:
            ok('数据更新中心可打开', False, str(e)[:120])
            await browser.close()
            return

        has_overview = await page.locator('#dc-overview .dc-stat').count()
        ok('概览统计卡渲染', has_overview >= 4, f'{has_overview} 张卡')

        n_pipe = await page.locator('.dc-pipe').count()
        ok('更新管线卡片渲染', n_pipe >= 4, f'{n_pipe} 条管线')

        n_rows = await page.locator('.dc-tr').count()
        ok('数据源明细表渲染', n_rows >= 10, f'{n_rows} 行（含表头）')

        n_run = await page.locator('.dc-run').count()
        disabled = await page.locator('.dc-run[disabled]').count()
        ok('管线更新按钮可用', n_run >= 4 and disabled == 0, f'{n_run} 个按钮，{disabled} 个禁用')

        body_text = await page.locator('#dc-root').inner_text()
        ok('说明了「人工维护」的边界', '人工维护' in body_text)
        ok('说明了监测不是自动判错', '不是自动判错' in body_text or '读不懂论文' in body_text)

        if WANT_SHOTS:
            await page.screenshot(path=os.path.join(SHOTS, 'datacenter.png'))

        # ---- 3. 监测主题可展开 ----
        await page.click('.dc-subjects')
        await page.wait_for_timeout(900)
        n_subj = await page.locator('.dc-subj').count()
        ok('监测主题可展开', n_subj >= 8, f'{n_subj} 个主题')

        # ---- 4. overrides 闭环 ----
        # 先记录木星卫星数的「当前值」（可能已被之前的测试改过）
        before = await page.evaluate("window.__universe.dataset.get('jupiter').moons")
        target = 999

        ov = api('/api/data/overrides', 'POST', {
            'entityId': 'jupiter', 'path': 'moons', 'value': target,
            'note': '回归测试用例', 'origin': 'tools/check-datacenter.py',
        })
        ok('覆盖写入成功', ov.get('ok') is True, f"id={ov.get('id')}")

        # 刷新页面 → 断言覆盖已作用
        await page.reload(wait_until='domcontentloaded')
        await page.wait_for_function(
            "window.__universe && window.__universe.dataset", timeout=90000)
        after = await page.evaluate("window.__universe.dataset.get('jupiter').moons")
        ok('刷新后覆盖生效', after == target, f'{before} → {after}（期望 {target}）')

        applied = await page.evaluate("window.__universe.dataset.overridesApplied.length")
        ok('覆盖计入已应用列表', applied == 1, f'{applied} 条')

        # 目录徽标也应反映修正后的值。
        # 精确取「木星」分组的 .tag 徽标（形如「115 颗卫星」），
        # 不要退化成「在整棵树里找包含木星两字的节点」——那样会误命中「行星」分组表头。
        await page.evaluate("window.__universe.ui.catalog.show()")
        await page.wait_for_timeout(700)
        badge = await page.evaluate("""
            (() => {
              const g = document.querySelector('.cat-group[data-gid="planet-jupiter"]');
              const tag = g?.querySelector('.tag');
              return tag ? tag.textContent.trim() : '';
            })()
        """)
        ok('目录徽标同步修正值', badge == f'{target} 颗卫星', f'木星分组徽标：{badge!r}（期望 {target} 颗卫星）')
        await page.evaluate("window.__universe.ui.catalog.hide()")

        # ---- 5. 采纳表单预填 ----
        q = api('/api/data/watch/queue')
        cands = [c for c in q.get('candidates', []) if c.get('status') == 'pending']
        if cands:
            await page.evaluate("window.__universe.ui.datacenter.open()")
            await page.wait_for_selector('.dc-cand', timeout=15000)
            await page.locator('.dc-cand .dc-accept').first.click()
            await page.wait_for_timeout(400)
            vis = await page.locator('.dc-cand .dc-acceptform:not([hidden])').count()
            ok('采纳表单可展开', vis >= 1, f'{vis} 个可见')
            vals = await page.locator('.dc-cand .dc-acceptform:not([hidden]) .dc-in').first.get_attribute('value')
            ok('采纳表单能从 target 预填', bool(vals), f'预填值：{vals!r}')
        else:
            ok('采纳表单可展开', True, '队列为空，跳过（可先运行扫描）')

        # ---- 清理：撤销测试用的覆盖 ----
        doc = api('/api/data/overrides')
        for o in doc.get('overrides', []):
            if o.get('note') == '回归测试用例':
                api('/api/data/overrides/remove', 'POST', {'id': o['id']})
        ok('测试覆盖已清理', True)

        real_err = [e for e in errors if 'favicon' not in e.lower()]
        ok('全程无 console 错误', not real_err, f'{len(real_err)} 条：{"; ".join(real_err[:2])[:180]}')

        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
    bad = [r for r in results if not r[1]]
    print('\n' + '=' * 60)
    print(f'通过 {len(results) - len(bad)} / {len(results)}')
    if bad:
        print('失败项：')
        for n, _, d in bad:
            print(f'  · {n} — {d}')
    print('=' * 60)
    sys.exit(1 if bad else 0)

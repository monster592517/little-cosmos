#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
静态资源服务回归 —— 不依赖浏览器、不依赖第三方库，几秒出结果。

    py -3.13 -X utf8 tools/check-http.py
    py -3.13 -X utf8 tools/check-http.py --url=http://127.0.0.1:8791/   # 用已有的服务
    py -3.13 -X utf8 tools/check-http.py --keep                          # 跑完不关服务

它守的是三件容易被"顺手改坏"的事：

  1. 真实资源必须 200，且 Content-Type 得对（图片不能是 text/html）。
  2. **不存在的资源必须 404。** 这是重点：早先的 SPA 回退把任何找不到的路径
     都回成 200 + index.html，于是贴图名写错就会静默变成"浏览器拿 HTML 当图片解码"，
     表面看是画面黑了一块，排查起来能让人怀疑人生。
  3. 路径穿越必须被拒（403 / 404），绝不能真把工程文件端出去。

⚠ **自己拉起服务、自己收工关掉**（不给 `--url` 时）。
   早先这脚本假设「8791 上已经有人开着服务」，于是它**从来没被真正跑过**，
   某天被跑一次就直接输出 `0 / 19` + 19 条 `WinError 10061 连接被拒`——
   看着像 19 个真实故障，其实一个都不是。
   **一个默认跑不过的检查等于没有检查**，所以改成自管（见 serve_for_checks.py）。

全部输出逐行 flush —— 这个环境里进程随时可能被外部杀掉，被缓冲掉的输出等于没输出。
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve_for_checks import ServedCheck            # noqa: E402  自管服务的共用助手

URL = None
KEEP = False
for _a in sys.argv[1:]:
    if _a.startswith('--url='):
        URL = _a[6:]
    elif _a == '--keep':
        KEEP = True

BASE = ''

# (路径, 期望状态码或状态码元组, 期望 Content-Type 前缀 或 None, 说明)
CASES = [
    ('/', 200, 'text/html', '首页'),
    ('/index.html', 200, 'text/html', '首页（显式）'),
    ('/css/app.css', 200, 'text/css', '样式表'),
    ('/js/main.js', 200, 'text/javascript', '前端入口'),
    ('/vendor/three/three.module.js', 200, 'text/javascript', 'three.js 运行时'),
    ('/vendor/astronomy/astronomy.js', 200, 'text/javascript', 'astronomy-engine 运行时'),
    ('/data/stars.json', 200, 'application/json', '数据集'),
    ('/textures/earth.jpg', 200, 'image/jpeg', '行星贴图'),
    ('/textures/earth_normal.png', 200, 'image/png', '法线贴图'),
    ('/api/health', 200, 'application/json', '健康检查'),

    ('/textures/definitely_missing.jpg', 404, 'application/json', '缺贴图必须 404，不能回 index.html'),
    ('/js/nope.js', 404, 'application/json', '缺脚本必须 404'),
    ('/data/nope.json', 404, 'application/json', '缺数据集必须 404'),
    ('/nope/deep/missing.png', 404, 'application/json', '多级缺失路径必须 404'),

    ('/some/spa/route', 200, 'text/html', '无扩展名的前端路由仍回退到首页'),

    ('/../server/server.mjs', (403, 404), None, '穿越到 server/ 必须被拒'),
    ('/../package.json', (403, 404), None, '穿越到工程根必须被拒'),
    ('/..%2fserver%2fserver.mjs', (403, 404), None, '编码后的穿越必须被拒'),
    ('/data/../server/server.mjs', (403, 404), None, '借 data 根穿越必须被拒'),
]

errors = []
passed = 0


def emit(msg=''):
    sys.stdout.write(msg + '\n')
    sys.stdout.flush()


def want_of(w):
    return w if isinstance(w, tuple) else (w,)


def fetch(path):
    """返回 (状态码, content-type, body 前若干字节)。状态码不会被异常吞掉。"""
    req = urllib.request.Request(BASE + path, method='GET')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=15) as r:
            return r.status, (r.headers.get('content-type') or ''), r.read(4096)
    except urllib.error.HTTPError as e:
        return e.code, (e.headers.get('content-type') or ''), e.read(4096)


def run_cases():
    global passed
    for i, (p, want, ctype, why) in enumerate(CASES, 1):
        try:
            code, ct, body = fetch(p)
        except Exception as e:                      # 连不上 / 超时 / 连接被拒
            emit(f'  ✗ [{i}/{len(CASES)}] {p} — {type(e).__name__}: {e}')
            errors.append(f'{p}：请求失败 {type(e).__name__}: {e}')
            continue

        problems = []
        if code not in want_of(want):
            problems.append(f'状态码 {code}，期望 {want_of(want)}')
        if ctype and not ct.startswith(ctype):
            problems.append(f'Content-Type "{ct}"，期望以 {ctype} 开头')

        # 关键防线：404 必须是 JSON 错误体，不能是被 SPA 回退塞进去的 HTML
        if code == 404:
            try:
                obj = json.loads(body.decode('utf-8'))
                if obj.get('ok') is not False:
                    problems.append('404 响应体不是 {ok:false}')
            except Exception:
                problems.append('404 响应体不是合法 JSON —— 多半又被回退成 index.html 了')

        if problems:
            emit(f'  ✗ [{i}/{len(CASES)}] {p} — ' + '；'.join(problems))
            errors.append(f'{p}：' + '；'.join(problems))
        else:
            emit(f'  ✓ [{i}/{len(CASES)}] {p} — {code} {why}')
            passed += 1


def main():
    global BASE
    emit('静态资源服务回归')

    srv = ServedCheck(url=URL, keep=KEEP, tag='本脚本')
    try:
        BASE = srv.start()
    except Exception as e:
        emit(f'✗ {e}')
        return 1

    emit('')
    try:
        run_cases()
    finally:
        srv.stop()

    emit('')
    emit('=' * 60)
    emit(f'通过 {passed} / {len(CASES)}')
    if errors:
        emit('')
        emit('失败项：')
        for e in errors:
            emit(f'  · {e}')
    emit('=' * 60)
    return 0 if not errors else 1


if __name__ == '__main__':
    sys.exit(main())

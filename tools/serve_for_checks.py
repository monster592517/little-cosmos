#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给「需要本地服务的检查脚本」用的共用助手。

为什么有这个东西
----------------
本仓库的浏览器/接口回归脚本（`check-scales` / `check-datacenter` / `check-datacenter-ui`
/ `check-http`）原先都假设**外部已经有人开着服务**（默认 `127.0.0.1:8791`）。
后果是它们**平时从来没被跑过** —— 谁高兴为了跑个检查单独开一个终端？
真被跑一次的时候，输出是一屏 `WinError 10061 连接被拒`，
看着像几十个真实故障，其实一个都不是。

**一个默认跑不过的检查等于没有检查。** 所以统一改成自管：
没给 `--url` 就自己挑一个空闲端口拉起服务，跑完自己收工关掉。

用法
----
    from serve_for_checks import ServedCheck

    with ServedCheck(url=URL_IF_GIVEN) as base:
        # base 形如 'http://127.0.0.1:8792'
        ...

端口选择
--------
只挑**当前没人听**的端口（先 bind 试一下），所以不会悄悄连到上一次遗留的孤儿服务
——那会让人把旧实例的结论当成新结果，是典型的假绿。
范围默认 8792–8805：避开 8787（日常服务默认端口）和 8791/8793/8794/8795/8796
（别的检查占着），撞上会分不清是谁的锅。
"""
import atexit
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RANGE = (8792, 8806)


def emit(msg=''):
    sys.stdout.write(str(msg) + '\n')
    sys.stdout.flush()


def find_node():
    """找一个真能跑的 node。

    不写死托管运行时路径 —— 那个版本目录会被替换掉（曾遇到 22.22.2-2 被移除）。
    先问 PATH，再退到已知的托管/系统位置，最后才报错。
    """
    cands = [shutil.which('node'), shutil.which('node.exe')]
    base = os.path.join(os.path.expanduser('~'), '.workbuddy', 'binaries', 'node', 'versions')
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base), reverse=True):
            cands.append(os.path.join(base, ver, 'node.exe'))
    cands.append(r'C:\Program Files\nodejs\node.exe')
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def port_busy(p):
    s = socket.socket()
    try:
        s.bind(('127.0.0.1', p))
        return False
    except OSError:
        return True
    finally:
        s.close()


def pick_port(rng=DEFAULT_RANGE):
    lo, hi = rng
    busy = [p for p in range(lo, hi) if port_busy(p)]
    if busy:
        emit(f'  ⚠ {lo}–{hi - 1} 里这些端口已被占用：{busy}')
        emit('    若那是上次跑崩留下的孤儿服务，收工命令：'
             'netstat -ano | findstr LISTENING | findstr 879  →  taskkill /PID <pid> /T /F')
    for p in range(lo, hi):
        if not port_busy(p):
            return p
    raise RuntimeError(f'{lo}–{hi - 1} 全被占用，先清掉孤儿服务进程')


def wait_health(base, timeout=30.0, tag='服务'):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(base + '/api/health', timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


class ServedCheck:
    """自管服务：没给 url 就自己起一个，进程退出时自己关掉（atexit，正常退出必触发）。"""

    def __init__(self, url=None, port=None, keep=False, rng=DEFAULT_RANGE, tag='本脚本'):
        self.explicit_url = url
        self.port = port
        self.keep = keep
        self.rng = rng
        self.tag = tag
        self.proc = None
        self.base = None

    def start(self):
        if self.explicit_url:
            self.base = self.explicit_url.rstrip('/')
            emit(f'目标  {self.base}/（用已有服务，本脚本不拉）')
            return self.base

        p = self.port or pick_port(self.rng)
        node = find_node()
        if not node:
            raise RuntimeError('找不到可用的 node —— 这些检查需要起一次本地服务')
        self.base = f'http://127.0.0.1:{p}'
        emit(f'目标  {self.base}/（由{self.tag}自行拉起并收工关掉）')
        emit(f'node  {node}')
        self.proc = subprocess.Popen(
            [node, os.path.join(ROOT, 'server', 'server.mjs'), f'--port={p}'],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
            # 别让临时服务器改写 data/.port —— 那会让自检的 svc.port
            # 把「日常服务 8787」误判成「与记录不一致」。见 server.mjs 里的说明。
            env={**os.environ, 'LC_NO_PORT_RECORD': '1'},
        )
        atexit.register(self.stop)
        if not wait_health(self.base):
            self.stop()
            raise RuntimeError(
                f'服务 30 秒内没起来 —— 手动跑 "node server/server.mjs --port={p}" 看报错')
        emit('  ✓ 服务已就绪')
        return self.base

    def stop(self):
        if self.proc is None:
            return
        proc, self.proc = self.proc, None      # 幂等：atexit 与显式调用只会生效一次
        if self.keep:
            emit(f'\n(--keep) 服务保留在 {self.base}，PID {proc.pid}')
            return
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
        return False

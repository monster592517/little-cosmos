# -*- coding: utf-8 -*-
"""把 `启动小小宇宙.bat` 的 `:openApp` 段整段替换成一版干净、不依赖历史包袱的逻辑。

为什么整段换而不是逐行修（2026-09-15）：
  这一段被改过七八轮，缠着 `--app` / 独立 profile / `--new-window` /
  `focus-app.ps1` / 四个浏览器探测。每一轮都在它上面留下条件分支，
  而启动器每次都停在 `server up on 8787` 之后 —— 也就是这一段的开头。
  逐行读代码已经定位不出来（我试了三次），所以整段换成能一眼看懂的版本。

新逻辑只做一件事：**把裸 URL 交给磁盘上找得到的浏览器程序**。
  实测（本机 Edge 153.0.4234.32）：
    · `--app=` / `--new-window` 在 Edge 已在运行时**被丢弃**（只开空白标签页）
    · `start "" "%URL%"` **直接失败**：本机没有可用的 http:// 关联
      ⇒ cmd 退出码 1、零窗口，Windows 弹「找不到 '\'」
  · 裸 URL 交给 msedge.exe ⇒ 转发给已有实例开新标签页 ⇒ 能用。
"""

import sys

P = '启动小小宇宙.bat'

raw = open(P, 'rb').read()
try:
    text = raw.decode('ascii')
except UnicodeDecodeError:
    sys.exit('文件里还有非 ASCII 字符 —— 先清干净再跑这个脚本')
lines = text.splitlines()

try:
    s = next(i for i, l in enumerate(lines) if l.startswith(':openApp'))
    e = next(i for i, l in enumerate(lines) if l.startswith(':done_ok'))
except StopIteration:
    sys.exit('找不到 :openApp 或 :done_ok 标签')

EDGE_X86 = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
EDGE_X64 = r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
CHR_X64 = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
CHR_X86 = r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'

new = [
    'rem ---- Open the interface: minimal and deliberately dumb (2026-09-15) ----',
    'rem',
    'rem  Everything that used to live here is GONE on purpose: --app mode, the',
    'rem  dedicated --user-data-dir profile, --new-window, focus-app.ps1, and the',
    'rem  four browser probes. Each was measured on this Edge build (153.0.4234.32)',
    'rem  and each failed:',
    'rem    * --app / --new-window are DISCARDED when Edge is already running',
    'rem      (the only window that opens is a blank "New tab")',
    'rem    * start "" "%URL%" fails outright - this machine has no working http://',
    'rem      association: cmd exits 1, zero windows, and Windows pops up',
    "rem      \"cannot find '\\'\". That was the error dialog the user reported.",
    'rem  What DOES work: hand a BARE url to a browser executable found on disk.',
    'rem  Edge forwards it to its already-running instance as a new tab.',
    'rem  Full history of the failed attempts: tools/launcher-notes.md',
    'rem',
    'rem  No pause on this path - success must not block.',
    'if "%URL%"=="" (',
    '  echo   [ERROR] internal: URL is empty, nothing to open.',
    '  pause',
    '  goto done_fail',
    ')',
    'set "BROWSER="',
    'if exist "%s" set "BROWSER=%s"' % (EDGE_X86, EDGE_X86),
    'if not defined BROWSER if exist "%s" set "BROWSER=%s"' % (EDGE_X64, EDGE_X64),
    'if not defined BROWSER if exist "%s" set "BROWSER=%s"' % (CHR_X64, CHR_X64),
    'if not defined BROWSER if exist "%s" set "BROWSER=%s"' % (CHR_X86, CHR_X86),
    'if defined BROWSER (',
    '  call :log "opening %URL% with %BROWSER%"',
    '  start "" "%BROWSER%" "%URL%"',
    ') else (',
    '  call :log "no browser found on disk - falling back to the shell association"',
    '  start "" "%URL%"',
    ')',
    'goto done_ok',
]

out = lines[:s] + new + lines[e:]
open(P, 'w', newline='\r\n', encoding='ascii').write('\n'.join(out))

data = open(P, 'rb').read()
print('  替换原第 %d..%d 行（%d 行）-> 新 %d 行' % (s + 1, e, e - s, len(new)))
print('  文件现在 %d 行 · 非 ASCII 字符 = %d' % (len(out), sum(1 for c in data if c > 127)))

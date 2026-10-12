@echo off
rem ============================================================
rem  Little Cosmos - portable launcher
rem
rem  DESIGN CONSTRAINTS (do not "clean up" these):
rem
rem  1) THIS FILE MUST STAY **ASCII-ONLY**.
rem     cmd.exe decodes .bat by the OEM code page (GBK/936 on a Chinese
rem     Windows, CP437 on an English one). A Chinese literal here renders
rem     and BEHAVES differently on different machines. All output below is
rem     English on purpose. Log files also use ASCII names for the same reason.
rem
rem  2) THE SERVER MUST NEVER FAIL SILENTLY.
rem     The old version started it with `start /min cmd /c ...` - output went
rem     into a minimized console. If it crashed, the user saw NOTHING and the
rem     launcher STILL opened the browser, so the only symptom was
rem     "cannot connect". Now:
rem       - server stdout/stderr go to logs\server-stdout.txt (survives close)
rem       - a failed start prints the tail of that log and PAUSES
rem       - every launch appends to launch-log.txt
rem
rem  3) FAIL = PAUSE, SUCCESS = NO PAUSE.
rem ============================================================

setlocal enabledelayedexpansion
title Little Cosmos
pushd "%~dp0"

set "LOGFILE=%~dp0launch-log.txt"
set "SRVLOG=%~dp0logs\server-stdout.txt"
set "PORT=8787"
rem  Override the port without editing this file (useful when 8787 is taken,
rem  and it is how the self-check below tests the real start path):
rem      set COSMOS_PORT=8791
if defined COSMOS_PORT set "PORT=%COSMOS_PORT%"

rem [CN note moved to tools/launcher-notes.md line 37]
rem
rem [CN note moved to tools/launcher-notes.md line 39]
rem [CN note moved to tools/launcher-notes.md line 40]
rem
rem [CN note moved to tools/launcher-notes.md line 42]
rem [CN note moved to tools/launcher-notes.md line 43]
rem [CN note moved to tools/launcher-notes.md line 44]
rem [CN note moved to tools/launcher-notes.md line 45]
rem
rem [CN note moved to tools/launcher-notes.md line 47]
set "URL=http://127.0.0.1:%PORT%/"

call :log "==== Little Cosmos launch ===="
call :log "time: %DATE% %TIME%"
call :log "cwd : %CD%"

if not exist "logs" mkdir "logs" >nul 2>nul

rem ---------------------------------------------------------------
rem  0) running straight out of a zip archive?
rem     Explorer lets you double-click a file INSIDE a .zip. It then runs
rem     from a random temp folder, where the server cannot write its data
rem     and the relative paths do not survive. This is the single most
rem     common "it will not start on my other computer".
rem ---------------------------------------------------------------
echo "%CD%" | findstr /I /C:"\Temp\" /C:"\TEMP\" /C:"\Rar$" /C:"\7z" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   [ERROR] You are running from a TEMPORARY folder.
  echo           This usually means the .zip was opened and a file inside
  echo           it was double-clicked, without extracting first.
  echo.
  echo   FIX: right-click the .zip  -^>  "Extract All..."  -^>
  echo        pick a normal folder  -^>  run this .bat from THERE.
  echo.
  call :log "ABORT: temp folder"
  pause
  goto done_fail
)

rem ---------------------------------------------------------------
rem  0b) environment precheck -- "it must just run, on any machine"
rem      Everything that can differ between machines is measured and written
rem      to launch-log.txt BEFORE we try to start anything.
rem ---------------------------------------------------------------
for /f "tokens=*" %%V in ('ver') do call :log "windows: %%V"
call :log "cpu arch: %PROCESSOR_ARCHITECTURE%"
echo   Arch     : %PROCESSOR_ARCHITECTURE%

rem  Can we write here? The server must create logs\ and data\.port.
> ".__write_test" echo x 2>nul
if not exist ".__write_test" goto notWritable
del ".__write_test" >nul 2>nul
call :log "writable: yes"

rem  The bundled runtime is win-x64. On a 32-bit Windows it CANNOT run, and
rem  because the file still "exists", the launcher would otherwise believe it
rem  is usable and fail with a confusing symptom. Skip it on x86 and fall
rem  through to a system-wide Node instead.
set "ARCH_OK=1"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" set "ARCH_OK=0"
if "%ARCH_OK%"=="0" (
  echo   [warn] 32-bit Windows: the bundled runtime is 64-bit.
  echo          Trying a system-wide Node.js instead.
  call :log "arch x86 - bundled runtime skipped on purpose"
)

rem ---------------------------------------------------------------
rem  1) locate Node.js: bundled runtime first, then system PATH
rem
rem [CN note moved to tools/launcher-notes.md line 108]
rem     exactly this: double-click -> "Press any key to continue" -> window
rem     closes. That is this file's :noNode branch, i.e. runtime\node.exe was
rem     not there (or was not usable). The three causes we have seen:
rem       a) the .zip was extracted incompletely,
rem       b) antivirus / Defender quarantined the unsigned 88 MB node.exe,
rem       c) SmartScreen never let it run (file present, executable blocked).
rem     (a) and (b) are told apart by SIZE, (c) by the `node -v` probe below.
rem ---------------------------------------------------------------
set "NODE="
if "%ARCH_OK%"=="1" if exist "runtime\node.exe" (
  for %%A in ("runtime\node.exe") do set "RT_SIZE=%%~zA"
  if !RT_SIZE! LSS 20000000 goto runtTruncated
  set "NODE=runtime\node.exe"
)
if defined NODE goto haveNode
where node >nul 2>nul
if errorlevel 1 goto noNode
set "NODE=node"

:haveNode
call :log "node: %NODE%"
"%NODE%" -v > "%LOGFILE%.ver" 2>&1
set "NODEV="
for /f "usebackq delims=" %%v in ("%LOGFILE%.ver") do set "NODEV=%%v"
del "%LOGFILE%.ver" >nul 2>nul
echo   Node: %NODEV%
call :log "node -v: %NODEV%"
if not defined NODEV goto badNode

rem ---------------------------------------------------------------
rem  2) data / texture self-check (only needed if files were deleted)
rem ---------------------------------------------------------------
if not exist "web\textures\jupiter.jpg" goto fetchAssets
if not exist "data\stars.json" goto buildData
goto run

:fetchAssets
echo   [1/2] Downloading planet textures and star catalog...
call :log "fetch-assets (network required)"
"%NODE%" tools\fetch-assets.mjs

:buildData
if exist "data\stars.json" goto run
echo   [2/2] Building datasets...
call :log "build-data"
"%NODE%" tools\build-data.mjs

rem ---------------------------------------------------------------
rem  3) server
rem ---------------------------------------------------------------
:run
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>nul
if not errorlevel 1 (
  call :log "port %PORT% already listening - reuse"
  goto openApp
)

echo   [1/3] Starting local server on port %PORT% ...
call :log "starting server, stdout -> %SRVLOG%"
rem [CN note moved to tools/launcher-notes.md line 168]
rem [CN note moved to tools/launcher-notes.md line 169]
rem [CN note moved to tools/launcher-notes.md line 170]
rem [CN note moved to tools/launcher-notes.md line 171]
rem [CN note moved to tools/launcher-notes.md line 172]
rem [CN note moved to tools/launcher-notes.md line 173]
rem [CN note moved to tools/launcher-notes.md line 174]
rem [CN note moved to tools/launcher-notes.md line 175]
rem [CN note moved to tools/launcher-notes.md line 176]
start "Little Cosmos Server (DO NOT CLOSE - closing stops the app)" /min cmd /c "chcp 65001 >nul & echo. & echo   Little Cosmos server is RUNNING in this window. & echo   Keep this window open - closing it stops the app. & echo   Full log: logs\server-stdout.txt & echo. & ""%NODE%"" server\server.mjs --port=%PORT% > ""%SRVLOG%"" 2>&1"

rem --- wait until it answers (max ~24s).
rem [CN note moved to tools/launcher-notes.md line 180]
rem [CN note moved to tools/launcher-notes.md line 181]
rem [CN note moved to tools/launcher-notes.md line 182]
rem [CN note moved to tools/launcher-notes.md line 183]
rem [CN note moved to tools/launcher-notes.md line 184]
set /a tries=0
:wait
set /a tries+=1
ping -n 1 -w 200 127.0.0.1 >nul 2>nul
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>nul
if errorlevel 1 if !tries! lss 120 goto wait

rem --- did it actually come up?
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>nul
if errorlevel 1 goto serverDown

rem --- read the actual port the server chose (in case 8787 was taken)
if exist "data\.port" for /f "usebackq delims=" %%p in ("data\.port") do set "PORT=%%p"
set "URL=http://127.0.0.1:%PORT%/"
echo   [2/3] Server is up: %URL%
call :log "server up on %PORT%"

rem ---------------------------------------------------------------
rem  4) open as a standalone app window (no browser chrome)
rem ---------------------------------------------------------------
:openApp
rem ---- Open the interface: minimal and deliberately dumb (2026-09-15) ----
rem
rem  Everything that used to live here is GONE on purpose: --app mode, the
rem  dedicated --user-data-dir profile, --new-window, focus-app.ps1, and the
rem  four browser probes. Each was measured on this Edge build (153.0.4234.32)
rem  and each failed:
rem    * --app / --new-window are DISCARDED when Edge is already running
rem      (the only window that opens is a blank "New tab")
rem    * start "" "%URL%" fails outright - this machine has no working http://
rem      association: cmd exits 1, zero windows, and Windows pops up
rem      "cannot find '\'". That was the error dialog the user reported.
rem  What DOES work: hand a BARE url to a browser executable found on disk.
rem  Edge forwards it to its already-running instance as a new tab.
rem  Full history of the failed attempts: tools/launcher-notes.md
rem
rem  No pause on this path - success must not block.
if "%URL%"=="" (
  echo   [ERROR] internal: URL is empty, nothing to open.
  pause
  goto done_fail
)
set "BROWSER="
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if defined BROWSER (
  call :log "opening %URL% with %BROWSER%"
  start "" "%BROWSER%" "%URL%"
) else (
  call :log "no browser found on disk - falling back to the shell association"
  start "" "%URL%"
)
goto done_ok
:done_ok
rem  Bring the app window to the FRONT (2026-09-15).
rem  A freshly opened Edge/Chrome window does NOT receive focus when that browser
rem  is already running - it gets created BEHIND the existing window. The user
rem  then reports "it jumped to the browser and there is no interface", while the
rem  window is in fact open, visible, not minimised and fully rendered.
rem  Measured on this machine: title = the page <title>, IsWindowVisible = true,
rem  IsIconic = false - it was simply not on top.
rem  The script polls for a few seconds by itself, so no sleep is needed here.
rem [CN note moved to tools/launcher-notes.md line 305]
rem [CN note moved to tools/launcher-notes.md line 306]
rem [CN note moved to tools/launcher-notes.md line 307]
rem [CN note moved to tools/launcher-notes.md line 308]
rem [CN note moved to tools/launcher-notes.md line 309]
if "%COSMOS_APP_WINDOW%"=="1" if not "%COSMOS_NO_BROWSER%"=="1" if exist "tools\focus-app.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\focus-app.ps1" -Url "%URL%" >nul 2>nul
  call :log "focus-app exit=%errorlevel%"
)
call :log "OK"
popd
exit /b 0

rem ---------------------------------------------------------------
rem  failure paths - ALL of them pause and show something actionable
rem ---------------------------------------------------------------
:serverDown
echo.
echo   [ERROR] The local server did NOT start within 25 seconds.
echo.
echo   Port %PORT% is currently used by:
netstat -ano | findstr ":%PORT% " 
echo.
echo   Last lines of logs\server-stdout.txt:
echo   ---------------------------------------------
if exist "%SRVLOG%" (
  powershell -NoProfile -Command "Get-Content -LiteralPath '%SRVLOG%' -Tail 20" 2>nul
) else (
  echo   ^(that file was never created - the server process died instantly^)
)
echo   ---------------------------------------------
echo.
echo   If the list above is EMPTY, the server process crashed on startup:
echo     run this in the extracted folder to see the raw error:
echo         runtime\node.exe server\server.mjs --port=%PORT%
echo.
call :log "ABORT: server down"
pause
goto done_fail

:badNode
echo.
echo   [ERROR] Found "%NODE%" but it cannot run ^(no version output^).
echo   If this is the bundled runtime\node.exe, it was probably BLOCKED or
echo   QUARANTINED by antivirus / Windows SmartScreen after the download.
echo   Try: right-click runtime\node.exe  -^>  Properties  -^>  Unblock.
echo.
call :log "ABORT: node cannot run"
pause
goto done_fail

:notWritable
echo.
echo   [ERROR] This folder is READ-ONLY. The server cannot create its logs\
echo           folder or write data\.port next to itself.
echo.
echo   This happens when the folder was extracted straight into:
echo     - a CD/DVD or a mounted disk image,
echo     - a compressed folder, or a OneDrive folder set to "online only",
echo     - C:\Program Files or another protected location.
echo.
echo   Fix: copy the WHOLE extracted folder to a normal writable place
echo        (your Desktop, or D:\...) and run it from there.
echo.
call :log "ABORT: folder not writable"
pause
goto done_fail

:noNode
echo.
echo   [ERROR] Node.js not found, and runtime\node.exe is MISSING.
echo.
echo   What is actually in this folder right now:
if exist "runtime" (
  echo     runtime\ exists. Its contents:
  dir /b "runtime"
) else (
  echo     runtime\ folder DOES NOT EXIST AT ALL.
)
echo.
echo   Likely causes, in order:
echo     1. The .zip was not extracted completely ^(large files get skipped^).
echo        Fix: delete this folder, extract the WHOLE .zip into an empty one.
echo     2. Antivirus / Windows Defender quarantined node.exe.
echo        Fix: Windows Security  -^>  Protection history  -^>  allow / restore.
echo     3. Only part of the folder got copied ^(chat apps drop big files^).
echo.
echo   Alternative: install Node 18+ from https://nodejs.org/ and rerun.
echo.
call :log "ABORT: no node (runtime folder: $RT_SIZE$)"
pause
goto done_fail

:runtTruncated
echo.
echo   [ERROR] runtime\node.exe exists but is only !RT_SIZE! bytes.
echo   A complete copy is about 88,000,000 bytes  ^(~84 MB^).
echo.
echo   So the file was NOT fully written - almost always a partial or
echo   interrupted extraction. A file this large is the first thing an
echo   extractor gives up on.
echo.
echo   Fix: delete this folder, extract the .zip again COMPLETELY, or use a
echo   real extractor ^(7-Zip / WinRAR^) instead of Windows Explorer.
echo.
call :log "ABORT: runtime truncated (!RT_SIZE! bytes)"
pause
goto done_fail

:done_fail
popd
exit /b 1

rem ---------------------------------------------------------------
:log
>>"%LOGFILE%" echo %~1
goto :eof
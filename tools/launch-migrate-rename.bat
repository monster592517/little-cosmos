@echo off
chcp 65001 >nul
REM ===================================================================
REM  Little Cosmos -- rename the workspace folder to the product name.
REM
REM  Why this launcher exists at all:
REM    The folder being renamed is ALSO WorkBuddy's workspace root.
REM    Windows refuses to rename a directory that is a live process's
REM    current directory, so this must run with WorkBuddy CLOSED and
REM    from a working directory OUTSIDE the folder.
REM  What it does:
REM    1. finds the folder by its marker file  -- no non-ASCII literal
REM       in this file, so the OEM code page cannot mangle it;
REM    2. refuses to run while WorkBuddy is still open;
REM    3. copies the .mjs tool to %TEMP% and runs it from there, so
REM       nothing inside the folder is held open by cmd.exe or node.
REM
REM  PLAIN ASCII ONLY. cmd.exe reads .bat in the OEM code page (936 on
REM  this box); UTF-8 Chinese in a .bat is mangled and breaks parsing.
REM  Keep CRLF line endings as well.
REM ===================================================================

echo ==========================================================
echo   Little Cosmos -- workspace folder rename
echo ==========================================================
echo.

REM --- 1. locate the project folder on the Desktop by marker file ---
set "PROJ="
for %%R in ("%USERPROFILE%\Desktop" "%USERPROFILE%\OneDrive\Desktop" "%USERPROFILE%\OneDrive") do (
  if exist "%%~R\" (
    for /d %%D in ("%%~R\*") do (
      if exist "%%~fD\tools\migrate-workspace-rename.mjs" set "PROJ=%%~fD"
    )
  )
)
if not defined PROJ (
  echo [ERROR] Cannot find the project folder.
  echo         Looked for a Desktop folder containing:
  echo             tools\migrate-workspace-rename.mjs
  echo         Place this .bat next to that folder and run it again.
  echo.
  pause
  exit /b 1
)
echo Project folder:
echo   %PROJ%
echo.

REM --- 2. WorkBuddy must be closed ---
tasklist /fi "imagename eq WorkBuddy.exe" 2>nul | find /i "WorkBuddy.exe" >nul
if not errorlevel 1 (
  echo [STOP] WorkBuddy is still running.
  echo        It keeps this folder open, so the rename would fail
  echo        halfway. Quit WorkBuddy completely, then run this again.
  echo.
  pause
  exit /b 1
)
echo WorkBuddy: not running -- OK.
echo.

REM --- 3. pick a node runtime ---
set "NODE="
if exist "%PROJ%\runtime\node.exe" set "NODE=%PROJ%\runtime\node.exe"
if not defined NODE for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
if not defined NODE (
  echo [ERROR] No Node.js found.
  echo         Expected %PROJ%\runtime\node.exe or node.exe on PATH.
  echo.
  pause
  exit /b 1
)
echo Node:
echo   %NODE%
echo.
echo This will:
echo   - back up WorkBuddy's session index;
echo   - rewrite the cwd of the sessions pointing at this folder;
echo   - move the transcript directory to the new path-slug;
echo   - rename the folder itself (LAST);
echo   - rebuild the desktop shortcut.
echo.
echo Nothing inside the folder is modified by this launcher.
echo.
pause

REM --- 4. run the tool from OUTSIDE the folder ---
set "WORK=%TEMP%\lc-rename-%RANDOM%%RANDOM%"
mkdir "%WORK%" 2>nul
copy /y "%PROJ%\tools\migrate-workspace-rename.mjs" "%WORK%\" >nul
cd /d "%WORK%"

echo.
"%NODE%" "%WORK%\migrate-workspace-rename.mjs" --from "%PROJ%" --apply
set "RC=%ERRORLEVEL%"
cd /d "%TEMP%"
rd /s /q "%WORK%" 2>nul

echo.
echo ==========================================================
if not "%RC%"=="0" (
  echo   [FAILED] exit code %RC% -- read the report above.
  echo   Nothing else was touched. The index backup is under
  echo   %%USERPROFILE%%\.workbuddy\sessions.bak-*
) else (
  echo   [DONE] Folder renamed. Reopen WorkBuddy and carry on.
)
echo ==========================================================
echo.
pause
exit /b %RC%

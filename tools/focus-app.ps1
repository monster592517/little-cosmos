# Bring the Little Cosmos app window to the front, and wait for it if needed.
#
# WHY THIS EXISTS
#   The launcher opens the browser with `--app=<url>` so the result looks like a
#   real application window (no address bar, no tabs). But when that browser is
#   ALREADY running - which is the normal case - the new window is created
#   WITHOUT focus and lands BEHIND the existing browser window. The user then
#   reports exactly this:
#
#       "it jumped to the browser and there is no interface"
#
#   ...while the window is in fact open, visible, not minimised and fully
#   rendered (its title is the page's <title>). It is merely behind.
#   Measured on this machine before the fix:
#     title = page <title> · IsWindowVisible = true · IsIconic = false
#
# HOW IT IS IDENTIFIED
#   Deliberately NOT by window title: the page title is Chinese, and a .ps1 must
#   stay PURE ASCII - cmd.exe and PowerShell decode script files by the local
#   ANSI code page, so a Chinese literal here would behave differently per
#   machine. Instead: take the browser window whose title is NOT a browser
#   default (the app window's title is the page <title>; the other windows are
#   "New tab - ... Edge" / "新建标签页 - ...", and both contain "Edge"/"Chrome").
#
# TWO MECHANISMS (both are needed)
#   1. SetForegroundWindow, with AttachThreadInput first to raise the odds of it
#      being accepted. Windows refuses foreground changes from a process that is
#      not itself the foreground process, and when the launcher was started by
#      another program, that is exactly our situation.
#   2. A z-order bounce (TOPMOST -> NOTOPMOST). This ALWAYS works visually: even
#      when the foreground change is refused, the window ends up in front of the
#      other windows. The foreground change is the nice-to-have, this is the
#      guarantee.
#
# EXIT CODES
#   0 = found a window and pushed it forward
#   1 = nothing found within the wait window (browser still starting, or the
#       caller did not open a browser)

param([string]$Url = '')

$ErrorActionPreference = 'SilentlyContinue'

if (-not ('CosmosWin' -as [type])) {
  Add-Type -Namespace '' -Name 'CosmosWin' -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
[DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
}

# Browser-default title fragments. ASCII only; this also catches the Chinese UI
# because those titles still end with "Microsoft Edge".
$defaults = 'Edge|Chrome|Chromium|Microsoft|Tab'

$deadline = (Get-Date).AddSeconds(8)
$hit = $null
while ((Get-Date) -lt $deadline) {
  $hit = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      $_.MainWindowTitle -and
      $_.MainWindowTitle -notmatch $defaults
    } | Select-Object -First 1
  if ($hit) { break }
  Start-Sleep -Milliseconds 400
}

if (-not $hit) {
  # No app window showed up. The most common reason: Edge was ALREADY running and
  # silently ignored the `--app` switch - all the user saw was their ordinary
  # browser window. That is exactly the reported symptom:
  #     "it jumped to the browser and there is no interface"
  # Fall back to an explicit new window. It is less pretty (browser chrome is
  # back), but it is GUARANTEED to be visible, which is the whole point.
  if ($Url -ne '') {
    $exe = @(
      'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
      'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
      'C:\Program Files\Google\Chrome\Application\chrome.exe',
      'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($exe) {
      Start-Process -FilePath $exe -ArgumentList '--new-window', $Url
      exit 2
    }
  }
  exit 1
}

$h = $hit.MainWindowHandle

[void][CosmosWin]::ShowWindow($h, 9)                 # SW_RESTORE

$fgH = [CosmosWin]::GetForegroundWindow()
$fgT = [CosmosWin]::GetWindowThreadProcessId($fgH, [IntPtr]::Zero)
$myT = [CosmosWin]::GetCurrentThreadId()
$attached = $false
if ($fgT -ne $myT -and $fgT -ne 0) {
  $attached = [CosmosWin]::AttachThreadInput($myT, $fgT, $true)
}

[void][CosmosWin]::BringWindowToTop($h)
[void][CosmosWin]::SetForegroundWindow($h)

if ($attached) { [void][CosmosWin]::AttachThreadInput($myT, $fgT, $false) }

# Give focus back the normal way, then bounce through TOPMOST as a guarantee.
$SB = 0x0001 -bor 0x0002                             # SWP_NOSIZE | SWP_NOMOVE
$null = [CosmosWin]::SetWindowPos($h, [IntPtr]([int]-1), 0, 0, 0, 0, $SB)   # HWND_TOPMOST
$null = [CosmosWin]::SetWindowPos($h, [IntPtr]([int]-2), 0, 0, 0, 0, $SB)   # HWND_NOTOPMOST

exit 0

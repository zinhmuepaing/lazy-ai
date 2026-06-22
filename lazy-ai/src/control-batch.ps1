# Lizzie — Screen Control batch executor (Stage 5.5 — verify-first focus).
#
# Performs a whole PLAN of input actions in ONE PowerShell process (so we pay the
# Add-Type compile + process spawn ONCE per plan, not once per action — the key to
# the keyboard-first "fast path"). The Electron main process has already resolved
# everything: click/scroll coords are PHYSICAL pixels, "press" carries a ready
# SendKeys string, and text is verbatim. We read the plan from a temp JSON file
# (avoids CLI quoting issues with arbitrary text).
#
# FOCUS IS THE HARD PART. Keyboard actions (press/text) inject into whatever window
# currently has the foreground. If that isn't the app we mean to drive, the URL/text
# lands in the wrong app (Claude, Notepad, the overlay…). So this script tracks the
# CURRENT target window and, before EVERY keystroke action, force-focuses it AND
# verifies GetForegroundWindow() actually became it — aborting the whole plan if it
# can't, rather than typing blind. Window discovery uses EnumWindows (the window
# manager), NOT Process.MainWindowHandle, which is unreliable and varies by host
# environment (VS Code terminal vs standalone PowerShell).
#
# Per-monitor DPI-aware so SetCursorPos uses true physical pixels.

param([string]$PlanFile, [long]$TargetHwnd = 0, [long]$OverlayHwnd = 0)

# Compile the inline P/Invoke C# ONCE to a cached DLL, then load it with -Path on
# later runs. Every batch is a fresh process, and recompiling the same C# via csc
# each call costs ~200-500ms. Keyed by an MD5 of the source, so editing the C#
# rebuilds automatically. Any failure falls back to inline compile (the original
# behavior), so this can never break a run.
function Use-CachedTypes([string]$Src, [string]$Tag) {
  $dll = $null
  try {
    $dir = Join-Path $env:LOCALAPPDATA 'lazy-ai'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $md5 = [Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Src))
    $key = ([BitConverter]::ToString($md5)).Replace('-','').Substring(0,12)
    $dll = Join-Path $dir ("native-$Tag-$key.dll")
    if (-not (Test-Path $dll)) { Add-Type -TypeDefinition $Src -OutputAssembly $dll -OutputType Library -ErrorAction Stop }
    Add-Type -Path $dll -ErrorAction Stop
    return
  } catch {
    if ($dll) { try { Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue } catch {} }
  }
  Add-Type -TypeDefinition $Src   # fallback: inline compile (original behavior)
}

$lazyCtlSrc = @"
using System;
using System.Runtime.InteropServices;
public static class LazyCtl {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, WHEEL=0x0800;
  // Absolute synthetic-move flags. A drag must feed the real mouse-move INPUT STREAM,
  // which drawing apps sample to lay down ink; SetCursorPos teleports the cursor WITHOUT
  // feeding it, so the button-held moves never registered as a stroke ("ghost drag").
  public const uint MOVE=0x0001, ABSOLUTE=0x8000, VIRTUALDESK=0x4000;
}
"@
Use-CachedTypes $lazyCtlSrc 'ctl'

# EnumWindows-based window discovery. This is the ROBUST replacement for the old
# Get-Process.MainWindowHandle scan, which returned stale/zero handles for multi-
# process apps like Chrome and behaved differently depending on the host shell. We
# walk the window manager's top-level windows (top of Z-order first) and map each to
# its owning process by PID, so "is Chrome open, and which window?" is answered by
# the same source the OS uses to draw the screen.
$lazyWinSrc = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class LazyWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  static string ClassOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static string Norm(string s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder();
    foreach (char c in s) if (Char.IsLetterOrDigit(c)) b.Append(Char.ToLowerInvariant(c));
    return b.ToString();
  }

  // Visible, titled, top-level windows whose owning process NAME or window TITLE
  // (both alnum-lowercased) match the requested app. "google chrome"->proc "chrome";
  // "edge"->"msedge"; title "YouTube - Google Chrome" matches "youtube". Process-name
  // matches are returned before title-only matches; within each, front-most first.
  public static List<IntPtr> Find(string app, long exclude) {
    string q = Norm(app);
    List<IntPtr> names = new List<IntPtr>();
    List<IntPtr> titles = new List<IntPtr>();
    if (q.Length == 0) return names;
    EnumProc cb = delegate(IntPtr h, IntPtr l) {
      try {
        if (exclude != 0 && h.ToInt64() == exclude) return true;
        if (!IsWindowVisible(h)) return true;
        string cls = ClassOf(h);
        // Never match the desktop shell or taskbar. explorer.exe owns these, so a
        // process-name query for "explorer"/"file explorer" used to match the Desktop
        // ("Program Manager") and the launch then reused/focused it - new files landed
        // on the Desktop. Skipping them forces a real File Explorer (CabinetWClass) window.
        if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true;
        // Console windows are owned by conhost.exe, so the process-name test below never
        // matches "cmd". Match them by window class for cmd/terminal/powershell queries.
        if (cls == "ConsoleWindowClass" && (q == "cmd" || q == "commandprompt" || q == "terminal" || q == "powershell")) { names.Add(h); return true; }
        int len = GetWindowTextLength(h);
        if (len <= 0) return true;
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        string title = Norm(sb.ToString());
        uint pid = 0; GetWindowThreadProcessId(h, out pid);
        string pname = "";
        try { pname = Norm(Process.GetProcessById((int)pid).ProcessName); } catch {}
        if (pname.Length > 0 && (q.Contains(pname) || pname.Contains(q))) names.Add(h);
        else if (title.Length > 0 && title.Contains(q)) titles.Add(h);
      } catch {}
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    names.AddRange(titles);
    return names;
  }

  // Normalized (alnum-lowercased) process name owning a window, or "" — used to tell a
  // real browser from an Electron/WebView2 app and to decide if a "launch website" can
  // be skipped (we're already in a browser) rather than spawning a duplicate browser.
  public static string ProcName(IntPtr h) {
    try {
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      return Norm(Process.GetProcessById((int)pid).ProcessName);
    } catch { return ""; }
  }

  // True if the window is the Windows shell desktop or taskbar (Program Manager / the
  // wallpaper host / the taskbar). A pointer action whose target becomes one of these
  // MISSED the app it meant to hit (it landed on the desktop behind a small window), so
  // the caller aborts + re-plans instead of hammering a dead coordinate into empty space.
  public static bool IsShell(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    string c = ClassOf(h);
    return c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd";
  }
}
"@
Use-CachedTypes $lazyWinSrc 'win'

Add-Type -AssemblyName System.Windows.Forms
# UI Automation (Stage 5.4): act on real elements by name/id, not pixels.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

try { [void][LazyCtl]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][LazyCtl]::SetProcessDPIAware() } catch {} }
# Disable the foreground-lock timeout for THIS process so SetForegroundWindow is
# honored (the lock is what otherwise silently drops our focus change, especially
# when launched from a different host shell). 0x2001 = SPI_SETFOREGROUNDLOCKTIMEOUT.
try { [void][LazyCtl]::SystemParametersInfo(0x2001, 0, [IntPtr]::Zero, 0) } catch {}

# Lightweight diagnostic log so a failing run can be inspected after the fact
# (the overlay/keystrokes can't be watched live). Appends to %TEMP%\lazy-ai-control.log;
# safe to delete anytime. Records the target/foreground handles and per-action focus.
$LogFile = Join-Path $env:TEMP "lazy-ai-control.log"
function Log([string]$m) {
  try { Add-Content -LiteralPath $LogFile -Value ("{0}  {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $m) } catch {}
}

$AE = [System.Windows.Automation.AutomationElement]
$InvokeP = [System.Windows.Automation.InvokePattern]::Pattern
$AutoIdProp = [System.Windows.Automation.AutomationElement]::AutomationIdProperty
$NameProp = [System.Windows.Automation.AutomationElement]::NameProperty
$Descendants = [System.Windows.Automation.TreeScope]::Descendants

# The window we currently intend to drive. Starts as the app the user summoned over
# ($TargetHwnd); updated when a "launch" activates/opens a window, and after any click
# (the click changes the foreground). Every keystroke action verifies focus against it.
$script:CurrentTarget = if ($TargetHwnd -ne 0) { [IntPtr]$TargetHwnd } else { [IntPtr]::Zero }

# Force a window to the foreground AND verify it took. Returns $true only if the window
# actually ends up foreground. Combines: restore-if-minimized, AttachThreadInput to the
# current foreground + target threads (legalizes the focus change), BringWindowToTop +
# SetForegroundWindow — retried a few times, re-checking GetForegroundWindow each pass.
# This is the verification the previous version lacked (it set focus once and assumed).
function Focus-Window([IntPtr]$hWnd) {
  if ($hWnd -eq [IntPtr]::Zero) { return $false }
  $ok = $false
  for ($i = 0; $i -lt 8; $i++) {
    if ([LazyCtl]::GetForegroundWindow() -eq $hWnd) { $ok = $true; break }
    try {
      if ([LazyCtl]::IsIconic($hWnd)) { [void][LazyCtl]::ShowWindow($hWnd, 9) }  # SW_RESTORE
      $thisThread = [LazyCtl]::GetCurrentThreadId()
      $fg = [LazyCtl]::GetForegroundWindow()
      $fgThread = [LazyCtl]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
      $tgtThread = [LazyCtl]::GetWindowThreadProcessId($hWnd, [IntPtr]::Zero)
      [void][LazyCtl]::AttachThreadInput($thisThread, $fgThread, $true)
      [void][LazyCtl]::AttachThreadInput($thisThread, $tgtThread, $true)
      [void][LazyCtl]::BringWindowToTop($hWnd)
      [void][LazyCtl]::ShowWindow($hWnd, 5)  # SW_SHOW
      [void][LazyCtl]::SetForegroundWindow($hWnd)
      [void][LazyCtl]::AttachThreadInput($thisThread, $tgtThread, $false)
      [void][LazyCtl]::AttachThreadInput($thisThread, $fgThread, $false)
    } catch {}
    Start-Sleep -Milliseconds 120
  }
  if (-not $ok) { $ok = ([LazyCtl]::GetForegroundWindow() -eq $hWnd) }
  # Settle: even once GetForegroundWindow reports the target, the per-thread keyboard
  # focus needs a beat to actually transfer before SendKeys — without this, the FIRST
  # keystroke of a no-launch plan (e.g. ctrl+l on an already-open Chrome) can still leak
  # to the previously-focused window (our overlay). The launch path got this for free
  # via its post-launch wait; this gives the no-launch path the same settle.
  if ($ok) { Start-Sleep -Milliseconds 90 }
  return $ok
}

# Is this window owned by a real WEB BROWSER (chrome/edge/firefox/...)? Distinct from
# Electron/WebView2 desktop apps. Used so a mislabeled "launch <website>" doesn't spawn
# a duplicate browser when we're already in one.
function Test-IsBrowser([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $false }
  $p = [LazyWin]::ProcName($h)
  return ($p -match '^(chrome|msedge|firefox|brave|opera|operagx|vivaldi|chromium|iexplore|librewolf|waterfox)$')
}

# Front-most VISIBLE window for an app (or Zero). Prefers the exact window the user
# summoned over ($TargetHwnd) when it's among the matches; never returns our overlay.
function Find-AppWindow([string]$app) {
  $hits = [LazyWin]::Find([string]$app, [long]$OverlayHwnd)
  if ($hits.Count -eq 0) { return [IntPtr]::Zero }
  if ($TargetHwnd -ne 0) {
    foreach ($h in $hits) { if ([long]$h -eq $TargetHwnd) { return [IntPtr]$TargetHwnd } }
  }
  return $hits[0]
}

# After launching an app, its window doesn't exist instantly (cold start can take
# several seconds). Poll until a visible window for it appears, so we never inject
# keystrokes before the window — and its focus — are ready. Returns the window or Zero.
function Wait-ForAppWindow([string]$app, [int]$timeoutMs = 9000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    $h = Find-AppWindow $app
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 250
  }
  return [IntPtr]::Zero
}

# Is the window's UI thread pumping messages (i.e. NOT locked up loading — the "blue
# spinner")? A cold-starting heavy app (Word) shows its window while its thread is still
# busy initializing; WM_NULL with a short timeout returns 0 until that thread goes idle.
function Test-Responsive([IntPtr]$hWnd) {
  $out = [IntPtr]::Zero
  $r = [LazyCtl]::SendMessageTimeout($hWnd, 0, [IntPtr]::Zero, [IntPtr]::Zero, 2, 300, [ref]$out)  # WM_NULL, SMTO_ABORTIFHUNG, 300ms
  return ($r -ne [IntPtr]::Zero)
}

# A freshly launched app shows its window BEFORE it can accept input (Word's start/template
# screen, a cold-start splash, the loading spinner). Wait until the window is BOTH foreground
# AND responsive (its UI thread is pumping — done loading) continuously for a short STABLE
# period, re-focusing if it drifts, capped — so the next keystrokes/paste don't fire into a
# still-loading app. This is the cold-vs-warm Word race: Notepad is instant and passes
# immediately; Word can take several seconds and used to slip through on foreground alone.
function Wait-WindowReady([IntPtr]$hWnd, [int]$stableMs = 600, [int]$timeoutMs = 12000) {
  if ($hWnd -eq [IntPtr]::Zero) { return }
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  $stableSince = $null
  while ((Get-Date) -lt $deadline) {
    if ([LazyCtl]::GetForegroundWindow() -ne $hWnd) {
      $stableSince = $null
      [void](Focus-Window $hWnd)
      Start-Sleep -Milliseconds 150
      continue
    }
    if (-not (Test-Responsive $hWnd)) {   # foreground, but the UI thread is still locked loading
      $stableSince = $null
      Start-Sleep -Milliseconds 150
      continue
    }
    if ($null -eq $stableSince) { $stableSince = Get-Date }
    elseif (((Get-Date) - $stableSince).TotalMilliseconds -ge $stableMs) { break }
    Start-Sleep -Milliseconds 120
  }
  Start-Sleep -Milliseconds 300  # final settle once ready
}

# After a mouse action (which changes focus by itself), adopt the now-foreground
# window as the current target — unless it's our overlay. Keeps the focus we verify
# before the next keystroke in sync with what the click actually activated.
function Update-Target {
  $fg = [LazyCtl]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero -and [long]$fg -ne $OverlayHwnd) { $script:CurrentTarget = $fg }
}

function Move-To([int]$x, [int]$y) {
  [void][LazyCtl]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 25
}
function Left-Click {
  [LazyCtl]::mouse_event([LazyCtl]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [LazyCtl]::mouse_event([LazyCtl]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
}

# Virtual-desktop metrics (physical px; DPI-awareness already set above), used to
# normalize absolute mouse moves into the 0..65535 range mouse_event expects.
$script:VsX = [LazyCtl]::GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
$script:VsY = [LazyCtl]::GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
$script:VsW = [LazyCtl]::GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
$script:VsH = [LazyCtl]::GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN
# Absolute synthetic move that feeds the real mouse-move input stream (so a held-button
# drag actually inks). SetCursorPos can't do this - it teleports without a move event.
function Move-Abs([int]$x, [int]$y) {
  $nx = [int][math]::Round((($x - $script:VsX) * 65535.0) / [math]::Max(1, ($script:VsW - 1)))
  $ny = [int][math]::Round((($y - $script:VsY) * 65535.0) / [math]::Max(1, ($script:VsH - 1)))
  if ($nx -lt 0) { $nx = 0 } elseif ($nx -gt 65535) { $nx = 65535 }
  if ($ny -lt 0) { $ny = 0 } elseif ($ny -gt 65535) { $ny = 65535 }
  [LazyCtl]::mouse_event(([LazyCtl]::MOVE -bor [LazyCtl]::ABSOLUTE -bor [LazyCtl]::VIRTUALDESK), [uint32]$nx, [uint32]$ny, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 5
}

# Type text by pasting it WITHOUT destroying the clipboard. A "text"/"ui_type"
# action borrows the clipboard to paste its string, then puts the previous content
# back. This is critical for cross-app copy→paste: a search-query type (e.g.
# "Bhone") must NOT wipe a URL the agent copied earlier (ctrl+c) and intends to
# paste later (ctrl+v). Without this restore, the copied payload is gone by the
# paste turn — the root of the "wrong thing gets sent" bug.
function Paste-Text([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return }
  $prev = $null
  try { $prev = Get-Clipboard -Raw } catch {}
  Set-Clipboard -Value $text
  Start-Sleep -Milliseconds 40
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 90
  if (-not [string]::IsNullOrEmpty($prev)) { try { Set-Clipboard -Value $prev } catch {} }
}

# Re-find a UIA element in the current target window by AutomationId (preferred) or exact Name.
function Find-Element($id, $name) {
  $hwnd = if ($script:CurrentTarget -ne [IntPtr]::Zero) { $script:CurrentTarget } elseif ($TargetHwnd -ne 0) { [IntPtr]$TargetHwnd } else { [LazyCtl]::GetForegroundWindow() }
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  try {
    $root = $AE::FromHandle($hwnd)
    if (-not [string]::IsNullOrEmpty([string]$id)) {
      $cond = New-Object System.Windows.Automation.PropertyCondition($AutoIdProp, [string]$id)
      $el = $root.FindFirst($Descendants, $cond)
      if ($el -ne $null) { return $el }
    }
    if (-not [string]::IsNullOrEmpty([string]$name)) {
      $cond = New-Object System.Windows.Automation.PropertyCondition($NameProp, [string]$name)
      return $root.FindFirst($Descendants, $cond)
    }
  } catch {}
  return $null
}

$plan = Get-Content -Raw -LiteralPath $PlanFile | ConvertFrom-Json

Log ("=== run: Target={0} ({1}) Overlay={2} fgAtStart={3}" -f [long]$TargetHwnd, [LazyWin]::ProcName([IntPtr]$TargetHwnd), [long]$OverlayHwnd, [long][LazyCtl]::GetForegroundWindow())

# Bring the target app to the foreground up front (so the first keystroke lands in it,
# not in our focused overlay). Best-effort here; each keystroke re-verifies anyway.
if ($script:CurrentTarget -ne [IntPtr]::Zero) {
  $okf = Focus-Window $script:CurrentTarget
  Log ("top-of-batch focus: target={0} fgAfter={1} focusOk={2}" -f [long]$script:CurrentTarget, [long][LazyCtl]::GetForegroundWindow(), $okf)
  Start-Sleep -Milliseconds 150
}

# NOTE: clipboard preservation is intentionally NOT done here. A cross-app
# copy→paste task spans TWO turns = TWO separate runs of this script, so saving
# and restoring the clipboard per-batch would wipe data the agent deliberately
# copied (e.g. a URL) before the paste turn could use it. The user's clipboard is
# now saved/restored once per SESSION in main.js (startControlGoal/stopControl).

$aborted = $false
foreach ($a in $plan) {
  switch ([string]$a.type) {
    "click" {
      Move-To ([int]$a.x) ([int]$a.y); Left-Click
      Update-Target
      Log ("click ({0},{1}): target now {2} ({3})" -f [int]$a.x, [int]$a.y, [long]$script:CurrentTarget, [LazyWin]::ProcName($script:CurrentTarget))
      # The click landed on the desktop/taskbar = it MISSED the app window (the app is now
      # backgrounded). Abort so the loop re-plans from a fresh shot, instead of the next
      # clicks in this batch hammering the same dead spot (the Clock "+ then exits" loop).
      if ([LazyWin]::IsShell($script:CurrentTarget)) { Log ("FOCUS_ABORT: click landed on the desktop/shell (missed the app); re-planning"); $aborted = $true; break }
    }
    "doubleclick" {
      Move-To ([int]$a.x) ([int]$a.y); Left-Click; Start-Sleep -Milliseconds 60; Left-Click
      Update-Target
      Log ("doubleclick ({0},{1}): target now {2} ({3})" -f [int]$a.x, [int]$a.y, [long]$script:CurrentTarget, [LazyWin]::ProcName($script:CurrentTarget))
      if ([LazyWin]::IsShell($script:CurrentTarget)) { Log ("FOCUS_ABORT: doubleclick landed on the desktop/shell (missed the app); re-planning"); $aborted = $true; break }
    }
    "rightclick" {
      Move-To ([int]$a.x) ([int]$a.y)
      [LazyCtl]::mouse_event([LazyCtl]::RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 25
      [LazyCtl]::mouse_event([LazyCtl]::RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
      Log ("rightclick ({0},{1})" -f [int]$a.x, [int]$a.y)
    }
    "scroll" {
      Move-To ([int]$a.x) ([int]$a.y)
      [LazyCtl]::mouse_event([LazyCtl]::WHEEL, 0, 0, [uint32]([int]$a.amount), [IntPtr]::Zero)
      Log ("scroll ({0},{1}) amount {2}" -f [int]$a.x, [int]$a.y, [int]$a.amount)
    }
    "drag" {
      # Press-move-release: the only way to DRAW a stroke, move a slider, or
      # drag-and-drop. Move to the start, hold the left button, glide through
      # several intermediate points (a single jump won't register as a stroke in
      # Paint/canvas apps), then release at the end. Coords are PHYSICAL pixels.
      $dragPrevTarget = $script:CurrentTarget
      $x1 = [int]$a.x1; $y1 = [int]$a.y1; $x2 = [int]$a.x2; $y2 = [int]$a.y2
      # Use ABSOLUTE synthetic moves (not SetCursorPos) so the held-button glide feeds the
      # real mouse-move stream that drawing apps ink from. Deliberate timing: settle after
      # the press so the app registers the stroke start, glide through many points feeding
      # moves, then hold briefly before release so the final segment inks.
      Move-Abs $x1 $y1
      Start-Sleep -Milliseconds 60
      [LazyCtl]::mouse_event([LazyCtl]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 90
      $steps = 36
      for ($i = 1; $i -le $steps; $i++) {
        $ix = [int]($x1 + ($x2 - $x1) * $i / $steps)
        $iy = [int]($y1 + ($y2 - $y1) * $i / $steps)
        Move-Abs $ix $iy
        Start-Sleep -Milliseconds 16
      }
      Start-Sleep -Milliseconds 90
      [LazyCtl]::mouse_event([LazyCtl]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Update-Target
      Log ("drag ({0},{1})->({2},{3}): target now {4}" -f $x1, $y1, $x2, $y2, [long]$script:CurrentTarget)
      if ([LazyWin]::IsShell($script:CurrentTarget)) {
        # The drag slipped onto the desktop (it never selected anything in the app) - the
        # Chrome lyrics "select, exit, repeat" loop. Abort + re-plan rather than copying an
        # empty selection. (Prefer "selecttext" over "drag" for text - see the planner.)
        Log ("FOCUS_ABORT: drag landed on the desktop/shell (missed the app); re-planning")
        $aborted = $true; break
      } elseif ($dragPrevTarget -ne [IntPtr]::Zero -and [long]$script:CurrentTarget -ne [long]$dragPrevTarget) {
        # A drag that tears off a browser tab / drags a window makes a DIFFERENT (non-shell)
        # window foreground. Don't adopt that stray window - restore the one we were driving
        # so the next keystroke (e.g. ctrl+c) still lands in the right place.
        Log ("drag: foreground changed (was {0}, now {1}); restoring target" -f [long]$dragPrevTarget, [long]$script:CurrentTarget)
        $script:CurrentTarget = $dragPrevTarget
      }
    }
    "selecttext" {
      # Select a range of TEXT by clicking the start, then SHIFT+clicking the end. Far more
      # reliable than a press-drag for text: a drag can slip onto the desktop (selecting
      # nothing) or tear off a browser tab, whereas two clicks land inside the window and
      # keep it foreground. Then the plan's ctrl+c copies the selection.
      $x1 = [int]$a.x1; $y1 = [int]$a.y1; $x2 = [int]$a.x2; $y2 = [int]$a.y2
      Move-To $x1 $y1; Left-Click          # place the caret + activate the window
      Update-Target
      Log ("selecttext start ({0},{1}): target now {2}" -f $x1, $y1, [long]$script:CurrentTarget)
      if ([LazyWin]::IsShell($script:CurrentTarget)) {
        Log ("FOCUS_ABORT: selecttext start landed on the desktop/shell (missed the app); re-planning")
        $aborted = $true; break
      }
      Start-Sleep -Milliseconds 60
      [LazyCtl]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)   # SHIFT down (VK_SHIFT)
      Start-Sleep -Milliseconds 20
      Move-To $x2 $y2; Left-Click          # SHIFT+click extends the selection to here
      Start-Sleep -Milliseconds 20
      [LazyCtl]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)   # SHIFT up (KEYEVENTF_KEYUP)
      Update-Target
      Log ("selecttext end ({0},{1}): target now {2}" -f $x2, $y2, [long]$script:CurrentTarget)
    }
    "press" {
      # VERIFY-FIRST: only inject when the intended window is provably foreground.
      $okf = Focus-Window $script:CurrentTarget
      Log ("press '{0}': target={1} fgAfter={2} focusOk={3}" -f $a.send, [long]$script:CurrentTarget, [long][LazyCtl]::GetForegroundWindow(), $okf)
      if (-not $okf) { $aborted = $true; break }
      [System.Windows.Forms.SendKeys]::SendWait([string]$a.send)
    }
    "text" {
      # VERIFY-FIRST: never paste into whatever happens to be focused.
      $okf = Focus-Window $script:CurrentTarget
      Log ("text (len={0}): target={1} fgAfter={2} focusOk={3}" -f ([string]$a.text).Length, [long]$script:CurrentTarget, [long][LazyCtl]::GetForegroundWindow(), $okf)
      if (-not $okf) { $aborted = $true; break }
      Paste-Text ([string]$a.text)  # clipboard-safe: restores prior content (e.g. a copied URL)
    }
    "launch" {
      # Map common friendly names to a real launcher so Start-Process succeeds (and we
      # skip the flaky Start-menu fallback). File Explorer is the key case: explorer.exe
      # is always running as the shell, so "open File Explorer" must spawn a real folder
      # window, not reuse the Desktop.
      $appName = [string]$a.app
      $an = ($appName -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
      $launchExe = $appName
      if ($an -eq 'fileexplorer' -or $an -eq 'explorer' -or $an -eq 'windowsexplorer' -or $an -eq 'thispc' -or $an -eq 'myfiles' -or $an -eq 'files') { $launchExe = 'explorer.exe' }
      elseif ($an -eq 'cmd' -or $an -eq 'commandprompt' -or $an -eq 'cmdexe') { $launchExe = 'cmd.exe' }
      # Is the requested "app" actually a browser or a website URL? Only THEN do we skip a
      # launch while already in a browser (so "launch youtube.com" navigates instead of
      # spawning a duplicate). A REAL app name like "microsoft word" must still launch -
      # the old check skipped EVERY non-exe launch from a browser, so Word/Notepad never
      # opened and the loop spun re-copying (the "can't open Word, stuck" bug).
      $isBrowserApp = $an -match '^(chrome|googlechrome|msedge|edge|microsoftedge|firefox|mozillafirefox|brave|opera|operagx|vivaldi|chromium)$'
      $looksLikeUrl = $appName -match '(\.[a-zA-Z]{2,})|(^\s*https?://)|(^\s*www\.)'
      # Reuse an already-open VISIBLE window for this app — never spawn a duplicate
      # of a window that's already there (a 2nd Chrome collides on the profile lock
      # and strands the first, then it won't reopen without a Task-Manager kill).
      $existing = Find-AppWindow $appName
      if ($existing -ne [IntPtr]::Zero) {
        Log ("launch '{0}': reusing existing window {1}" -f $a.app, [long]$existing)
        $script:CurrentTarget = $existing
        [void](Focus-Window $script:CurrentTarget)
        Start-Sleep -Milliseconds 250
      } else {
        # No visible window for this app (fully closed OR only a background process):
        # Start-Process opens a window — through any existing background instance, so
        # no duplicate/lock conflict — then we WAIT for that window to actually exist
        # before any keystroke targets it (the launch race the old code ignored).
        $opened = $false
        try { Start-Process -FilePath $launchExe -ErrorAction Stop; $opened = $true } catch { $opened = $false }
        $launched = $opened
        if (-not $opened) {
          if ((Test-IsBrowser $script:CurrentTarget) -and ($isBrowserApp -or $looksLikeUrl)) {
            # We're ALREADY in a browser AND the "app" is itself a browser or a URL — this
            # is a WEBSITE the model mislabeled as an app (e.g. launch "youtube.com"). Do
            # NOT Start-menu-launch a new browser: that spawns a duplicate that can strand
            # the user's Chrome (Task-Manager-kill territory). Skip it — the plan's
            # following keyboard actions (ctrl+l + type the URL) navigate the browser we're
            # already in. (A REAL app name like "microsoft word" falls through and launches.)
            Log ("launch '{0}': SKIPPED (already in browser; treat as website navigation, no new window)" -f $a.app)
          } else {
            # Genuine app with no plain exe name (Microsoft Store / UWP, or a real desktop
            # app while a browser is foreground) → Start-menu search.
            Log ("launch '{0}': Start-menu fallback" -f $a.app)
            [LazyCtl]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)  # LWIN down
            [LazyCtl]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)  # LWIN up
            Start-Sleep -Milliseconds 500
            $q = ([string]$a.app) -replace '[+^%~(){}\[\]]', '{$&}'
            [System.Windows.Forms.SendKeys]::SendWait($q)
            Start-Sleep -Milliseconds 850
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
            $launched = $true
          }
        } else {
          Log ("launch '{0}': Start-Process" -f $a.app)
        }
        if ($launched) {
          $win = Wait-ForAppWindow ([string]$a.app) 9000
          if ($win -ne [IntPtr]::Zero) {
            $script:CurrentTarget = $win
            [void](Focus-Window $script:CurrentTarget)
            # Cold-started app: the window exists but may not accept input yet (Word's start
            # screen). Wait for stable foreground so a later paste/keystroke isn't lost.
            Wait-WindowReady $script:CurrentTarget
          }
        }
      }
    }
    "wait" {
      Start-Sleep -Milliseconds ([int]$a.ms)
    }
    "uia" {
      # Act on a real UI element. verb: click | invoke | settext. x/y are the
      # element's PHYSICAL center (fallback if find/invoke isn't available).
      if ($a.verb -eq "click") {
        Move-To ([int]$a.x) ([int]$a.y); Left-Click
        Update-Target
        Log ("uia click ({0},{1}): target now {2}" -f [int]$a.x, [int]$a.y, [long]$script:CurrentTarget)
      } else {
        $el = Find-Element $a.id $a.name
        if ($a.verb -eq "invoke") {
          $invoked = $false
          if ($el -ne $null) {
            $ip = $null
            if ($el.TryGetCurrentPattern($InvokeP, [ref]$ip)) {
              try { $ip.Invoke(); $invoked = $true } catch { $invoked = $false }
            }
          }
          if (-not $invoked) { Move-To ([int]$a.x) ([int]$a.y); Left-Click }  # fallback
          Update-Target
          Log ("uia invoke name='{0}' ({1},{2}) invoked={3}: target now {4}" -f $a.name, [int]$a.x, [int]$a.y, $invoked, [long]$script:CurrentTarget)
        } elseif ($a.verb -eq "settext") {
          # Focus the field by clicking its real rect center (reliable activation),
          # adopt that window, then VERIFY before pasting (so we never type into the
          # overlay/wrong window if the click didn't land where we expected).
          Move-To ([int]$a.x) ([int]$a.y); Left-Click
          Start-Sleep -Milliseconds 80
          Update-Target
          if (-not (Focus-Window $script:CurrentTarget)) { $aborted = $true; break }
          Paste-Text ([string]$a.text)  # clipboard-safe: restores prior content after typing
        }
      }
    }
  }
  if ($aborted) { break }
  Start-Sleep -Milliseconds 120  # small gap so each action registers before the next
}

if ($aborted) {
  # Couldn't guarantee the right window had focus — fail LOUD instead of typing into
  # the wrong app. main.js surfaces this and the loop can re-plan from a fresh shot.
  Log "ABORTED: could not focus target before a keystroke action"
  [Console]::Error.WriteLine("FOCUS_ABORT: Couldn't focus the target window - aborted before typing to avoid sending text to the wrong app.")
  exit 1
}
Log "=== run complete"

# Clipboard is restored at the SESSION level in main.js (see note above), not here.

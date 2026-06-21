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

Add-Type @"
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
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, WHEEL=0x0800;
}
"@

# EnumWindows-based window discovery. This is the ROBUST replacement for the old
# Get-Process.MainWindowHandle scan, which returned stale/zero handles for multi-
# process apps like Chrome and behaved differently depending on the host shell. We
# walk the window manager's top-level windows (top of Z-order first) and map each to
# its owning process by PID, so "is Chrome open, and which window?" is answered by
# the same source the OS uses to draw the screen.
Add-Type @"
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
}
"@

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
    }
    "doubleclick" {
      Move-To ([int]$a.x) ([int]$a.y); Left-Click; Start-Sleep -Milliseconds 60; Left-Click
      Update-Target
    }
    "rightclick" {
      Move-To ([int]$a.x) ([int]$a.y)
      [LazyCtl]::mouse_event([LazyCtl]::RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 25
      [LazyCtl]::mouse_event([LazyCtl]::RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
    }
    "scroll" {
      Move-To ([int]$a.x) ([int]$a.y)
      [LazyCtl]::mouse_event([LazyCtl]::WHEEL, 0, 0, [uint32]([int]$a.amount), [IntPtr]::Zero)
    }
    "drag" {
      # Press-move-release: the only way to DRAW a stroke, move a slider, or
      # drag-and-drop. Move to the start, hold the left button, glide through
      # several intermediate points (a single jump won't register as a stroke in
      # Paint/canvas apps), then release at the end. Coords are PHYSICAL pixels.
      $x1 = [int]$a.x1; $y1 = [int]$a.y1; $x2 = [int]$a.x2; $y2 = [int]$a.y2
      Move-To $x1 $y1
      [LazyCtl]::mouse_event([LazyCtl]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      $steps = 24
      for ($i = 1; $i -le $steps; $i++) {
        $ix = [int]($x1 + ($x2 - $x1) * $i / $steps)
        $iy = [int]($y1 + ($y2 - $y1) * $i / $steps)
        [void][LazyCtl]::SetCursorPos($ix, $iy)
        Start-Sleep -Milliseconds 12
      }
      Start-Sleep -Milliseconds 40
      [LazyCtl]::mouse_event([LazyCtl]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Update-Target
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
      # Reuse an already-open VISIBLE window for this app — never spawn a duplicate
      # of a window that's already there (a 2nd Chrome collides on the profile lock
      # and strands the first, then it won't reopen without a Task-Manager kill).
      $existing = Find-AppWindow ([string]$a.app)
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
        try { Start-Process -FilePath ([string]$a.app) -ErrorAction Stop; $opened = $true } catch { $opened = $false }
        $launched = $opened
        if (-not $opened) {
          if (Test-IsBrowser $script:CurrentTarget) {
            # We're ALREADY in a browser and the "app" isn't a real executable — this is
            # almost certainly a WEBSITE the model mislabeled as an app (e.g. launch
            # "youtube"). Do NOT Start-menu-launch a new browser: that spawns a duplicate
            # that can strand the user's Chrome (Task-Manager-kill territory). Skip it —
            # the plan's following keyboard actions (ctrl+l + type the URL) navigate the
            # browser we're already in.
            Log ("launch '{0}': SKIPPED (already in browser; treat as website navigation, no new window)" -f $a.app)
          } else {
            # Genuine app with no plain exe name (Microsoft Store / UWP) → Start-menu search.
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
            Start-Sleep -Milliseconds 250
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
  [Console]::Error.WriteLine("Couldn't focus the target window - aborted before typing to avoid sending text to the wrong app.")
  exit 1
}
Log "=== run complete"

# Clipboard is restored at the SESSION level in main.js (see note above), not here.

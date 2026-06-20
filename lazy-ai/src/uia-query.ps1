# Lazy AI - UI Automation query (Stage 5.4).
#
# Returns the foreground window's named, on-screen, actionable controls as JSON,
# so the model can reference real UI elements by name instead of guessing pixels.
# Output: {"hwnd":<n>,"elements":[{idx,name,type,x,y,w,h,invoke,value,id}, ...]}
# Rects are PHYSICAL pixels (script is per-monitor DPI-aware, matching the clicker).
#
# -ExcludeHwnd: if the foreground window is this handle (our own overlay), returns
# an empty list (the overlay isn't a target).

param([long]$ExcludeHwnd = 0, [long]$FallbackHwnd = 0, [int]$Max = 80)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
try { [void][Fg]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][Fg]::SetProcessDPIAware() } catch {} }

# Use the live foreground window, unless it's our overlay (or none) -> fall back
# to the target the user summoned over (so an already-open app is still seen).
$h = [Fg]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero -or ($ExcludeHwnd -ne 0 -and [long]$h -eq $ExcludeHwnd)) {
  if ($FallbackHwnd -ne 0) { $h = [IntPtr]$FallbackHwnd } else { Write-Output '{"hwnd":0,"elements":[]}'; exit 0 }
}

$A = [System.Windows.Automation.AutomationElement]
$Invoke = [System.Windows.Automation.InvokePattern]::Pattern
$ValueP = [System.Windows.Automation.ValuePattern]::Pattern

$root = $A::FromHandle($h)

# Identify the owning process. We treat real WEB BROWSERS differently from Electron/
# WebView2 DESKTOP apps (Teams, Slack, VS Code, Claude) — both use the
# "Chrome_WidgetWin"/"WebView" window class, so the class alone can't tell them apart.
$wpid = [uint32]0
[void][Fg]::GetWindowThreadProcessId($h, [ref]$wpid)
$pname = ""
try { $pname = (Get-Process -Id ([int]$wpid) -ErrorAction Stop).ProcessName.ToLower() } catch {}
$isBrowser = $pname -match '^(chrome|msedge|firefox|brave|opera|vivaldi|chromium|iexplore|librewolf|waterfox)$'

# REAL BROWSER: do NOT harvest the web-page a11y tree. Those element rects go stale
# between this query and the click (the page scrolls / re-renders), and feeding them
# lures the model into flaky ui_* actions instead of the reliable keyboard path
# (ctrl+l -> type the URL/query -> enter) plus a vision click. That asymmetry is
# exactly why Screen Control worked when summoned over ANOTHER app (the browser's
# elements were never seen) but failed when summoned ON the browser. Return no
# elements so both cases behave the same. (Electron/WebView2 desktop apps below still
# get the a11y wake — their whole UI lives in that tree and its rects are stable.)
if ($isBrowser) {
  Write-Output ('{"hwnd":' + [long]$h + ',"elements":[]}')
  exit 0
}

# Chromium/Edge/WebView DESKTOP apps keep their accessibility tree OFF until a UIA
# client asks for it. Do a throwaway query to trigger it, wait, then proceed, so the
# app's controls (contact rows, message box, buttons) show up instead of nothing.
$cn = New-Object System.Text.StringBuilder 256
[void][Fg]::GetClassName($h, $cn, $cn.Capacity)
if ($cn.ToString() -match "Chrome_WidgetWin|Edge|WebView") {
  try { [void]$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch {}
  Start-Sleep -Milliseconds 700
  $root = $A::FromHandle($h)
}

$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

# Window size, to drop container-sized elements (documents, regions, big lists/
# groups). A real, clickable/typeable control is small relative to the window;
# anything spanning most of it is a container the model must NOT target (its
# center is empty space). Generic, size-based — no app/control-type assumptions.
$winRect = $root.Current.BoundingRectangle
$winW = [double]$winRect.Width
$winH = [double]$winRect.Height

$items = New-Object System.Collections.ArrayList
$idx = 0
foreach ($e in $all) {
  if ($items.Count -ge $Max) { break }
  try {
    $name = $e.Current.Name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    if ($e.Current.IsOffscreen) { continue }
    # Skip containers: nearly full-width, or taller than ~60% of the window.
    if ($winW -gt 0 -and $winH -gt 0 -and ($r.Width -ge 0.92 * $winW -or $r.Height -ge 0.6 * $winH)) { continue }

    $tmp = $null
    $inv = $e.TryGetCurrentPattern($Invoke, [ref]$tmp)
    $val = $e.TryGetCurrentPattern($ValueP, [ref]$tmp)
    $id = ""
    try { $id = $e.Current.AutomationId } catch {}

    $obj = [pscustomobject]@{
      idx    = $idx
      name   = $name
      type   = $e.Current.LocalizedControlType
      x      = [int]$r.X
      y      = [int]$r.Y
      w      = [int]$r.Width
      h      = [int]$r.Height
      invoke = [bool]$inv
      value  = [bool]$val
      id     = $id
    }
    [void]$items.Add(($obj | ConvertTo-Json -Compress -Depth 3))
    $idx++
  } catch {
    # stale/inaccessible element - skip
  }
}

$joined = $items -join ","
Write-Output ('{"hwnd":' + [long]$h + ',"elements":[' + $joined + ']}')

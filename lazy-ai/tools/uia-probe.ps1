# Lizzie - UI Automation probe (Stage 5.4 feasibility check).
#
# Dumps what Windows UI Automation (UIA) exposes for the FOREGROUND window, so we
# can decide whether "name the target -> resolve via UIA" is viable for a given app
# (great for native apps; sometimes thin for Electron/Store apps). No app changes,
# no native module - uses the built-in WPF UIAutomation assemblies via PowerShell.
#
# HOW TO RUN (from a normal terminal - needs the real screen):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Lazy AI\lazy-ai\tools\uia-probe.ps1"
# You get a few seconds to click the target app (Teams, Apple Music, ...) so it is
# the foreground window; then it prints the tree summary + named/on-screen controls.
# Re-run per app and share the output. Optional: -DelaySeconds 5 -Max 200

param(
  [int]$DelaySeconds = 4,   # time to switch to the target app before capture
  [int]$Max = 150           # cap on how many controls to print
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$A = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]
$Invoke = [System.Windows.Automation.InvokePattern]::Pattern
$ValueP = [System.Windows.Automation.ValuePattern]::Pattern

Write-Host "Switch to the target app NOW - capturing the foreground window in $DelaySeconds seconds..."
for ($i = $DelaySeconds; $i -gt 0; $i--) { Write-Host "  $i..."; Start-Sleep -Seconds 1 }

$h = [Fg]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Host "No foreground window."; exit 1 }

$root = $A::FromHandle($h)
Write-Host ""
Write-Host ("===== Foreground window: '{0}'  [class: {1}] =====" -f $root.Current.Name, $root.Current.ClassName)

$started = Get-Date
$all = $root.FindAll($TreeScope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$elapsed = [int]((Get-Date) - $started).TotalMilliseconds
Write-Host ("Total descendant elements: {0}   (UIA walk took {1} ms)" -f $all.Count, $elapsed)
Write-Host ""

# Summary: how many of each control type (tells us if e.g. 'list item' contacts exist).
$byType = @{}
foreach ($e in $all) {
  try { $t = $e.Current.LocalizedControlType } catch { $t = "?" }
  if (-not $t) { $t = "?" }
  if ($byType.ContainsKey($t)) { $byType[$t]++ } else { $byType[$t] = 1 }
}
Write-Host "----- control types present (count) -----"
$byType.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Write-Host ("  {0,-18} {1}" -f $_.Key, $_.Value) }
Write-Host ""

# Detail: named, on-screen controls with their rect + actionable patterns. This is
# exactly what a "click_element by name/role" feature would match against.
Write-Host "----- named, on-screen controls (name | type | rect | patterns | autoId) -----"
$count = 0
foreach ($e in $all) {
  if ($count -ge $Max) { Write-Host ("  ...(capped at {0}; re-run with -Max higher)" -f $Max); break }
  try {
    $name = $e.Current.Name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    if ($e.Current.IsOffscreen) { continue }

    $pats = @()
    $tmp = $null
    if ($e.TryGetCurrentPattern($Invoke, [ref]$tmp)) { $pats += "Invoke" }
    if ($e.TryGetCurrentPattern($ValueP, [ref]$tmp)) { $pats += "Value" }
    if ($pats.Count -gt 0) { $patStr = $pats -join "," } else { $patStr = "-" }

    $autoId = ""
    try { $autoId = $e.Current.AutomationId } catch {}

    if ($name.Length -gt 50) { $shortName = $name.Substring(0, 50) + "..." } else { $shortName = $name }
    $line = "  [{0,-12}] '{1}'  @({2},{3} {4}x{5})  pats={6}  id={7}" -f $e.Current.LocalizedControlType, $shortName, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, $patStr, $autoId
    Write-Host $line
    $count++
  } catch {
    # stale/inaccessible element - skip
  }
}
Write-Host ""
Write-Host ("Done. Printed {0} named on-screen controls." -f $count)
Write-Host "Share this output (per app). What matters: are the things you'd click (contacts, the"
Write-Host "message box, buttons) listed with sensible names + an Invoke pattern or a real rect?"

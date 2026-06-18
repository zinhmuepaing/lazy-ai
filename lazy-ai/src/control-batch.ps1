# Lazy AI — Screen Control batch executor (Stage 5.3).
#
# Performs a whole PLAN of input actions in ONE PowerShell process (so we pay the
# Add-Type compile + process spawn ONCE per plan, not once per action — the key to
# the keyboard-first "fast path"). The Electron main process has already resolved
# everything: click/scroll coords are PHYSICAL pixels, "press" carries a ready
# SendKeys string, and text is verbatim. We read the plan from a temp JSON file
# (avoids CLI quoting issues with arbitrary text).
#
# Per-monitor DPI-aware so SetCursorPos uses true physical pixels.

param([string]$PlanFile)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LazyCtl {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, WHEEL=0x0800;
}
"@
Add-Type -AssemblyName System.Windows.Forms

try { [void][LazyCtl]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][LazyCtl]::SetProcessDPIAware() } catch {} }

function Move-To([int]$x, [int]$y) {
  [void][LazyCtl]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 25
}
function Left-Click {
  [LazyCtl]::mouse_event([LazyCtl]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [LazyCtl]::mouse_event([LazyCtl]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
}

$plan = Get-Content -Raw -LiteralPath $PlanFile | ConvertFrom-Json

# Preserve the user's clipboard — "text" actions paste through it.
$savedClip = $null
try { $savedClip = Get-Clipboard -Raw } catch {}

foreach ($a in $plan) {
  switch ($a.type) {
    "click" {
      Move-To ([int]$a.x) ([int]$a.y); Left-Click
    }
    "doubleclick" {
      Move-To ([int]$a.x) ([int]$a.y); Left-Click; Start-Sleep -Milliseconds 60; Left-Click
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
    "press" {
      [System.Windows.Forms.SendKeys]::SendWait([string]$a.send)
    }
    "text" {
      if (-not [string]::IsNullOrEmpty([string]$a.text)) {
        Set-Clipboard -Value ([string]$a.text)
        Start-Sleep -Milliseconds 40
        [System.Windows.Forms.SendKeys]::SendWait("^v")
        Start-Sleep -Milliseconds 60
      }
    }
    "launch" {
      # Fast path: Start-Process resolves real executables / PATH / App Paths
      # (Word, OneNote, Notepad, explorer, chrome…). If that fails — e.g. a
      # Microsoft Store / UWP app like Apple Music with no plain exe name — fall
      # back to Start-menu search, which opens anything a user can: tap the
      # Windows key, type the name, Enter.
      $opened = $false
      try { Start-Process -FilePath ([string]$a.app) -ErrorAction Stop; $opened = $true } catch { $opened = $false }
      if (-not $opened) {
        [LazyCtl]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)  # LWIN down
        [LazyCtl]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)  # LWIN up
        Start-Sleep -Milliseconds 500
        $q = ([string]$a.app) -replace '[+^%~(){}\[\]]', '{$&}'
        [System.Windows.Forms.SendKeys]::SendWait($q)
        Start-Sleep -Milliseconds 850
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      }
    }
    "wait" {
      Start-Sleep -Milliseconds ([int]$a.ms)
    }
  }
  Start-Sleep -Milliseconds 120  # small gap so each action registers before the next
}

# Restore the clipboard (best effort).
try { if ($null -ne $savedClip) { Set-Clipboard -Value $savedClip } } catch {}

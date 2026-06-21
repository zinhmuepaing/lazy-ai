# Lizzie — Screen Control action (Stage 5).
#
# Performs ONE low-level input action via Win32 user32.dll: move/click/scroll the
# mouse at physical screen pixels, type text, or open an app. Made per-monitor
# DPI-aware so SetCursorPos coordinates are true physical pixels (the Electron
# main process maps screenshot pixels → physical pixels before calling this).
#
# No native/compiled dependency — matches the Stage 3 PowerShell approach.

param(
  [string]$Action,        # move | click | doubleclick | rightclick | scroll | type | open
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Amount = 0,       # scroll wheel delta (+ up / - down)
  [string]$Text = ""      # text to type, or app name/path to open
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LazyCtl {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, WHEEL=0x0800;
}
"@

# Per-monitor-aware v2 (handle -4) so SetCursorPos uses true physical pixels;
# fall back to system-aware on older Windows.
try { [void][LazyCtl]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][LazyCtl]::SetProcessDPIAware() } catch {} }

function Invoke-LeftClick {
  [void][LazyCtl]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 30
  [LazyCtl]::mouse_event([LazyCtl]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [LazyCtl]::mouse_event([LazyCtl]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
}

switch ($Action) {
  "move" {
    [void][LazyCtl]::SetCursorPos($X, $Y)
  }
  "click" {
    Invoke-LeftClick
  }
  "doubleclick" {
    Invoke-LeftClick
    Start-Sleep -Milliseconds 60
    [LazyCtl]::mouse_event([LazyCtl]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [LazyCtl]::mouse_event([LazyCtl]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
  }
  "rightclick" {
    [void][LazyCtl]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 30
    [LazyCtl]::mouse_event([LazyCtl]::RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [LazyCtl]::mouse_event([LazyCtl]::RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
  }
  "scroll" {
    [void][LazyCtl]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 30
    [LazyCtl]::mouse_event([LazyCtl]::WHEEL, 0, 0, [uint32]([int]$Amount), [IntPtr]::Zero)
  }
  "type" {
    Add-Type -AssemblyName System.Windows.Forms
    # Escape SendKeys' special characters by wrapping each in braces.
    $escaped = $Text -replace '[+^%~(){}\[\]]', '{$&}'
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
  }
  "paste" {
    # Fast, length-proof text entry: main puts the text on the clipboard and we
    # send Ctrl+V (one keystroke), then main restores the clipboard.
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("^v")
  }
  "open" {
    Start-Process -FilePath $Text -ErrorAction Stop
  }
}

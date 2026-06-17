# Lazy AI — restore focus to the source window and paste the polished result.
#
# Takes the window handle captured by grab-selection.ps1. The Electron main
# process has already put the polished text on the clipboard; here we bring the
# original app back to the foreground and send Ctrl+V into it.

param([long]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LazyWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
Add-Type -AssemblyName System.Windows.Forms

[void][LazyWin]::SetForegroundWindow([IntPtr]$Hwnd)
Start-Sleep -Milliseconds 90
[System.Windows.Forms.SendKeys]::SendWait("^v")

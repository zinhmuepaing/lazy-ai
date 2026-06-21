# Lizzie — capture the foreground window and copy the current selection.
#
# Run while the user's source app is still focused (our popup is hidden at this
# point). Records the foreground window handle so we can paste back into it
# later, sends Ctrl+C to copy whatever is selected, and prints the handle on
# stdout for the Electron main process to read.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LazyWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
Add-Type -AssemblyName System.Windows.Forms

$handle = [LazyWin]::GetForegroundWindow()
[System.Windows.Forms.SendKeys]::SendWait("^c")
[Console]::Out.Write($handle.ToInt64())

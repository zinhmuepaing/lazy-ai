# Lazy AI - print the current foreground window handle (Stage 5.4).
# Captured at Screen Control summon (BEFORE our overlay steals focus) so we know
# the target app window even once our overlay is foreground.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FgW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
[Console]::Out.Write([long][FgW]::GetForegroundWindow())

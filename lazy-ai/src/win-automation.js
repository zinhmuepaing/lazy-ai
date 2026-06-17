// Lazy AI — Windows keyboard/window automation (Stage 3).
//
// Thin wrappers around two PowerShell scripts that use Win32 user32.dll +
// SendKeys to (a) copy the current selection while recording which app window
// owned it, and (b) restore that window and paste back into it. This keeps the
// "select → hotkey → polish → paste" loop working with no native/compiled
// dependency. (nut.js comes later, in Stage 5, for richer automation.)

const path = require("node:path");
const { execFile } = require("node:child_process");

const isWindows = process.platform === "win32";
const GRAB_SCRIPT = path.join(__dirname, "grab-selection.ps1");
const PASTE_SCRIPT = path.join(__dirname, "paste-result.ps1");

// Run a PowerShell script file, resolving with trimmed stdout.
function runScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { windowsHide: true, timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve((stdout || "").trim());
      }
    );
  });
}

// Sends Ctrl+C to the focused app and returns the foreground window handle
// (as a numeric string) so we can paste back into it later. Returns null off
// Windows or if the handle couldn't be read.
async function grabSelection() {
  if (!isWindows) return null;
  const out = await runScript(GRAB_SCRIPT);
  return /^\d+$/.test(out) ? out : null;
}

// Restores the given window to the foreground and sends Ctrl+V into it.
async function focusAndPaste(hwnd) {
  if (!isWindows || !hwnd) return;
  await runScript(PASTE_SCRIPT, ["-Hwnd", String(hwnd)]);
}

module.exports = { isWindows, grabSelection, focusAndPaste };

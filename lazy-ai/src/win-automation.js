// Lazy AI — Windows keyboard/window automation (Stage 3).
//
// Thin wrappers around two PowerShell scripts that use Win32 user32.dll +
// SendKeys to (a) copy the current selection while recording which app window
// owned it, and (b) restore that window and paste back into it. This keeps the
// "select → hotkey → polish → paste" loop working with no native/compiled
// dependency. (nut.js comes later, in Stage 5, for richer automation.)

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");

const isWindows = process.platform === "win32";
const GRAB_SCRIPT = path.join(__dirname, "grab-selection.ps1");
const PASTE_SCRIPT = path.join(__dirname, "paste-result.ps1");
const CONTROL_SCRIPT = path.join(__dirname, "control-action.ps1");
const BATCH_SCRIPT = path.join(__dirname, "control-batch.ps1");

// Run a PowerShell script file, resolving with trimmed stdout.
function runScript(scriptPath, args = [], timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { windowsHide: true, timeout: timeoutMs },
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

// Screen Control (Stage 5): perform one low-level input action.
//   { type:"click"|"doubleclick"|"rightclick"|"move", x, y }
//   { type:"scroll", x, y, amount }   amount = wheel delta (+ up / - down)
//   { type:"type", text }
//   { type:"open", app }              launch an app by name/path
// x/y are PHYSICAL screen pixels (the control script is DPI-aware).
async function performAction({ type, x = 0, y = 0, amount = 0, text = "", app = "" }) {
  if (!isWindows) throw new Error("Screen Control is Windows-only (PowerShell automation).");
  const args = ["-Action", type, "-X", String(Math.round(x)), "-Y", String(Math.round(y)), "-Amount", String(Math.round(amount))];
  if (type === "type") args.push("-Text", text);
  if (type === "open") args.push("-Text", app);
  // Generous timeout: the first call compiles the Add-Type block, and some apps
  // are slow to accept input. (Long text is entered via clipboard paste, not here.)
  await runScript(CONTROL_SCRIPT, args, 15000);
}

// Map a friendly key combo ("ctrl+l", "enter", "ctrl+shift+p", "alt+f4") to a
// .NET SendKeys string. Modifiers: ctrl→^, alt→%, shift→+. The Windows key isn't
// SendKeys-addressable (apps are opened via "launch" instead, so it's not needed).
const SENDKEYS_NAMED = {
  enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}",
  space: " ", backspace: "{BACKSPACE}", delete: "{DEL}", del: "{DEL}", insert: "{INS}",
  up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
};
function composeSendKeys(combo) {
  const parts = String(combo || "").toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  const key = parts.pop();
  let mods = "";
  for (const m of parts) {
    if (m === "ctrl" || m === "control") mods += "^";
    else if (m === "alt") mods += "%";
    else if (m === "shift") mods += "+";
    // "win"/"meta" intentionally ignored — not addressable via SendKeys
  }
  let k;
  if (SENDKEYS_NAMED[key]) k = SENDKEYS_NAMED[key];
  else if (/^f\d{1,2}$/.test(key)) k = `{${key.toUpperCase()}}`;
  else k = key; // single character (letter/digit/symbol)
  return mods + k;
}

// Screen Control "fast path" (Stage 5.3): run a whole resolved plan in ONE
// PowerShell process. `actions` are already resolved by main.js — click/scroll
// coords are PHYSICAL pixels, "press" carries a `send` SendKeys string. The plan
// is handed over via a temp JSON file (safe for arbitrary text). `timeoutMs`
// should budget for the plan's own waits.
async function performPlan(actions, timeoutMs = 20000) {
  if (!isWindows) throw new Error("Screen Control is Windows-only (PowerShell automation).");
  const file = path.join(os.tmpdir(), `lazy-ai-plan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fs.promises.writeFile(file, JSON.stringify(actions || []), "utf8");
  try {
    await runScript(BATCH_SCRIPT, ["-PlanFile", file], timeoutMs);
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

module.exports = { isWindows, grabSelection, focusAndPaste, performAction, performPlan, composeSendKeys };

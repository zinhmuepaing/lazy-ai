// Lizzie — Windows keyboard/window automation (Stage 3).
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

// Resolve a bundled .ps1 next to this file. These scripts are run by an EXTERNAL
// powershell.exe, which cannot read from inside the packed `app.asar` archive.
// In a packaged build they're asarUnpack'd to `app.asar.unpacked/src/`, so when
// __dirname points into `app.asar` we redirect to the real on-disk copy. The
// regex only matches `app.asar` followed by a separator (not `app.asar.unpacked`),
// so it's a no-op in dev and idempotent when already unpacked.
function scriptPath(name) {
  const p = path.join(__dirname, name);
  return p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

const GRAB_SCRIPT = scriptPath("grab-selection.ps1");
const PASTE_SCRIPT = scriptPath("paste-result.ps1");
const CONTROL_SCRIPT = scriptPath("control-action.ps1");
const BATCH_SCRIPT = scriptPath("control-batch.ps1");
const UIA_QUERY_SCRIPT = scriptPath("uia-query.ps1");
const FOREGROUND_SCRIPT = scriptPath("foreground.ps1");
const OCR_SCRIPT = scriptPath("ocr-lines.ps1");

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
  // The Windows key isn't addressable via SendKeys. A combo like "win+e"/"win+r" must
  // NOT be reduced to a bare "e"/"r" — that injects a stray letter into the focused app
  // (it typed "r" into File Explorer and derailed the task into Windows Search). Drop the
  // whole action; the caller skips an empty send, and the model opens apps via "launch".
  if (parts.includes("win") || parts.includes("meta") || parts.includes("super")) return "";
  const key = parts.pop();
  let mods = "";
  for (const m of parts) {
    if (m === "ctrl" || m === "control") mods += "^";
    else if (m === "alt") mods += "%";
    else if (m === "shift") mods += "+";
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
async function performPlan(actions, timeoutMs = 20000, targetHwnd = 0, overlayHwnd = 0) {
  if (!isWindows) throw new Error("Screen Control is Windows-only (PowerShell automation).");
  const file = path.join(os.tmpdir(), `lazy-ai-plan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fs.promises.writeFile(file, JSON.stringify(actions || []), "utf8");
  const args = ["-PlanFile", file];
  if (targetHwnd) args.push("-TargetHwnd", String(targetHwnd)); // for UIA re-find + focus-verify
  if (overlayHwnd) args.push("-OverlayHwnd", String(overlayHwnd)); // never treat our overlay as the target
  try {
    await runScript(BATCH_SCRIPT, args, timeoutMs);
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

// The window that was foreground (the target app the user summoned over), so we
// can query/act on it even after our overlay takes focus. 0 on failure.
async function getForegroundWindow() {
  if (!isWindows) return 0;
  try {
    const out = await runScript(FOREGROUND_SCRIPT, [], 5000);
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

// Query the target window's UIA elements (Stage 5.4). Uses the live foreground
// window, but if that's our overlay (excludeHwnd) or none, falls back to the
// known target (fallbackHwnd) — so an already-open app is still seen. Returns
// { hwnd, elements } (elements have PHYSICAL-pixel rects), or { hwnd:0, elements:[] }.
async function queryUiElements(excludeHwnd = 0, fallbackHwnd = 0, max = 80, skipWake = false) {
  if (!isWindows) return { hwnd: 0, elements: [], browser: false };
  try {
    const args = ["-ExcludeHwnd", String(excludeHwnd || 0), "-FallbackHwnd", String(fallbackHwnd || 0), "-Max", String(max)];
    if (skipWake) args.push("-SkipWake"); // a11y tree already woken this session → skip the 700ms wait
    const out = await runScript(UIA_QUERY_SCRIPT, args, 10000);
    const data = JSON.parse(out);
    return {
      hwnd: Number(data.hwnd) || 0,
      elements: Array.isArray(data.elements) ? data.elements : [],
      browser: !!data.browser,
    };
  } catch {
    return { hwnd: 0, elements: [], browser: false };
  }
}

// Screen Teacher OCR (Sonnet line-snapping). Runs Windows.Media.Ocr over the PNG
// we send the model and returns the text lines it found WITH their pixel boxes:
//   [{ text, x, y, w, h }, ...]  (coords in the image's own pixels)
// Sonnet can't place pixels well, so it points at a line by index from this list
// and we snap the annotation to the real rect. Best-effort: returns [] off Windows
// or on any failure, so the caller cleanly falls back to the model's pixel coords.
async function ocrImage(pngBase64) {
  if (!isWindows || !pngBase64) return [];
  const file = path.join(os.tmpdir(), `lazy-ai-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await fs.promises.writeFile(file, Buffer.from(pngBase64, "base64"));
    const out = await runScript(OCR_SCRIPT, ["-ImagePath", file], 12000);
    const data = JSON.parse(out);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (l) => l && typeof l.text === "string" && [l.x, l.y, l.w, l.h].every((n) => Number.isFinite(n))
    );
  } catch {
    return [];
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

module.exports = { isWindows, grabSelection, focusAndPaste, performAction, performPlan, composeSendKeys, queryUiElements, getForegroundWindow, ocrImage };

// Lazy AI — Electron main process.
//
// Holds the API keys (from .env) and owns the shared polish engine. Exposes it
// two ways:
//   1. IPC, for the desktop window (preload.js bridges it to the UI).
//   2. A local HTTP server on localhost:8788, for the browser extension.
//
// Stage 3: the app now lives in the system tray and is summoned by a global
// hotkey as a frameless, always-on-top popup — no taskbar window to hunt for.

const path = require("node:path");
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  clipboard,
  desktopCapturer,
  screen,
  session,
} = require("electron");

// Load .env from the project root (one level up from src/).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { MODELS, DEFAULT_MODEL, polish, extractTextFromFile } = require("./polish-engine");
const { startLocalServer } = require("./local-server");
const winAutomation = require("./win-automation");
const settingsStore = require("./settings-store");
const screenTeacher = require("./screen-teacher");
const screenControl = require("./screen-control");
const voiceEngine = require("./voice-engine");

// Screen Teacher summon hotkeys, in preference order (separate from the polish
// summon key). Stage 4.
const SCREEN_TEACHER_CANDIDATES = [
  "CommandOrControl+Shift+S",
  "CommandOrControl+Alt+S",
  "CommandOrControl+Shift+G",
];

// Screen Control summon hotkeys (Stage 5) — voice/text command → the app acts.
const SCREEN_CONTROL_CANDIDATES = [
  "CommandOrControl+Shift+A",
  "CommandOrControl+Alt+A",
  "CommandOrControl+Shift+D",
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Written to the clipboard before we copy a selection, so we can tell whether
// Ctrl+C actually grabbed anything (sentinel still there = nothing selected).
const SELECTION_SENTINEL = "__lazy_ai_no_selection__";

// Candidate summon hotkeys, in preference order. Electron maps
// "CommandOrControl" to Ctrl on Windows. We register the first one the OS lets
// us have — Ctrl+Alt+Space is often claimed by IMEs / other tools — and report
// which won. Made fully configurable in the Stage 3 settings panel later.
const HOTKEY_CANDIDATES = [
  "CommandOrControl+Alt+Space",
  "CommandOrControl+Shift+Space",
  "CommandOrControl+Alt+P",
  "CommandOrControl+Shift+P",
];

// Human-readable form of an Electron accelerator for the tray UI (Windows).
function prettyHotkey(accelerator) {
  return accelerator.replace("CommandOrControl", "Ctrl");
}

let mainWindow = null;
let settingsWindow = null;
let overlayWindow = null;
let tray = null;
let activeHotkey = null; // the summon accelerator we actually managed to register
let activeScreenHotkey = null; // the Screen Teacher accelerator we registered
let activeControlHotkey = null; // the Screen Control accelerator we registered
let overlayMode = "teach"; // "teach" (draw/explain) | "control" (act)
let controlTimer = null; // pending action-execute timer (cancelable on dismiss)
let controlActive = false; // a multi-step Screen Control command is running
let controlGoal = ""; // the user's command/goal for the control loop
let controlHistory = []; // Anthropic messages (text-only) across control turns
let controlTurnCount = 0;
let controlElements = []; // this turn's UIA element list (idx,name,type,rect,…)
let controlTargetHwnd = 0; // the target app window (for UIA re-find at execution)
let controlSourceHwnd = 0; // foreground window captured at summon (the app the user was in)
let sourceHwnd = null; // window the selection came from, to paste back into
let lastScreenshot = null; // { base64, mediaType, width, height } for Screen Teacher
let activeDisplay = null; // the display the current Screen Teacher session is bound to

// ---- Interactive guide loop (Live Teach) ----------------------------------
// When the user asks a multi-step "how do I…" question, we annotate the next
// action, watch the screen for them to perform it, then re-capture and guide the
// next step — until the model reports the task is done.
let guideActive = false;
let guideGoal = "";
let guideHistory = []; // Anthropic messages (text-only) carried across turns
let guideTurn = 0;
let watchTimer = null; // setTimeout handle for the screen-change poll
let watchPrev = null; // previous poll thumbnail (RGBA Buffer) for diffing
let watchDirty = false; // true once the screen has started changing (user acting)

// The Screen Teacher vision model is user-selectable in Settings; read it fresh
// each turn so a change takes effect on the next capture/ask.
function activeScreenTeacherModel() {
  return settingsStore.getPublicSettings().screenTeacherModel || screenTeacher.DEFAULT_SCREEN_TEACHER_MODEL;
}

// Whether to OCR the screenshot and let the model point at lines by index (we snap
// the annotation to the real rect). Only the prior-gen vision models (Sonnet) need
// this — Opus 4.7/4.8 place pixels accurately, so they keep the lighter pixel path.
function usesOcrLineSnapping(model) {
  return /sonnet/i.test(model || "");
}

// Screen Control plans with a fast/cheap model (Sonnet 4.6) — separate from the
// Teacher picker. Captures for control MUST be capped to this model's vision
// limit, or its coordinates drift.
function controlModel() {
  return screenControl.DEFAULT_CONTROL_MODEL;
}

// The screenshot caps for the model that will consume the capture (long edge AND
// megapixels — both registered per model in screen-teacher.js).
function maxEdgeForModel(model) {
  return screenTeacher.maxEdgeFor(model);
}
function maxPixelsForModel(model) {
  return screenTeacher.maxPixelsFor(model);
}

const GUIDE_MAX_TURNS = 14; // safety cap so a misbehaving loop can't run forever
const WATCH_INTERVAL_MS = 450; // how often we poll the screen while watching (snappy detection)
// We detect a LOCALIZED change (a dropdown, a new panel) rather than an average
// change across the whole frame — averaging buries a small UI change below the
// noise floor. So we count the fraction of pixels that changed substantially.
const WATCH_PIXEL_DELTA = 40; // per-pixel change (|ΔR|+|ΔG|+|ΔB|, max 765) to count as "changed"
const WATCH_CHANGE_FRACTION = 0.012; // fraction of sampled pixels that must change = "user did something"

// ---------------------------------------------------------------------------
// Single-instance lock — a global hotkey + tray must own exactly one process.
// A second launch just summons the existing one instead of starting a rival.
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => showPopup());
  app.whenReady().then(init);
}

// ---------------------------------------------------------------------------
// IPC handlers (called from the renderer via window.lazyAI.*)
// ---------------------------------------------------------------------------
// Send only id + label to the UI — provider/apiModel stay internal.
function modelsForUI() {
  return Object.fromEntries(
    Object.entries(MODELS).map(([id, info]) => [id, { label: info.label }])
  );
}

ipcMain.handle("get-models", () => {
  const defaultModel = settingsStore.getPublicSettings().defaultModel || DEFAULT_MODEL;
  return { models: modelsForUI(), defaultModel };
});

// ---- Settings panel (Stage 3) --------------------------------------------
ipcMain.handle("get-settings", () => {
  const pub = settingsStore.getPublicSettings();
  const screenTeacherModels = Object.fromEntries(
    Object.entries(screenTeacher.SCREEN_TEACHER_MODELS).map(([id, info]) => [id, { label: info.label }])
  );
  return {
    ...pub,
    models: modelsForUI(),
    engineDefaultModel: DEFAULT_MODEL,
    screenTeacherModels,
    engineScreenTeacherModel: screenTeacher.DEFAULT_SCREEN_TEACHER_MODEL,
    prettyActiveHotkey: activeHotkey ? prettyHotkey(activeHotkey) : null,
  };
});

ipcMain.handle("save-settings", (_event, payload) => {
  const pub = settingsStore.save(payload || {});
  // Apply the (possibly new) hotkey immediately and reflect it in the tray.
  const registered = registerSummonHotkey(pub.hotkey);
  applyTrayMenu();
  // Refresh the popup's model dropdown so a new default takes effect at once.
  mainWindow?.webContents.send("settings-updated");
  return {
    ...pub,
    hotkeyRegistered: Boolean(registered),
    gotRequestedHotkey: registered === pub.hotkey, // did we get the one they picked?
    prettyActiveHotkey: registered ? prettyHotkey(registered) : null,
    prettyRequestedHotkey: prettyHotkey(pub.hotkey),
  };
});

ipcMain.handle("pick-file", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Documents & code", extensions: ["txt", "md", "pdf", "docx", "js", "ts", "py", "json", "html", "css", "java", "c", "cpp", "cs", "go", "rs", "rb", "php", "swift", "csv", "yml", "yaml", "xml"] },
    ],
  });
  if (canceled || filePaths.length === 0) return null;
  const filePath = filePaths[0];
  try {
    const text = await extractTextFromFile(filePath);
    return { name: path.basename(filePath), text };
  } catch (err) {
    return { name: path.basename(filePath), error: String(err.message || err) };
  }
});

ipcMain.handle("polish", async (_event, payload) => polish(payload));

// Renderer asks to dismiss the popup (Esc key or the ✕ button).
ipcMain.on("hide-window", () => mainWindow?.hide());

// Screen Teacher: the renderer hands us the user's goal; we drive the guide loop.
ipcMain.on("start-guide", (_event, question) => startGuide(question));

// Manual fallback: the user says "I've done it, continue" (e.g. if auto-detect
// missed the change, or they acted while it was still narrating).
ipcMain.on("guide-continue", () => {
  if (guideActive) runGuideTurn({ useExistingShot: false });
});

// Screen Control (Stage 5): the renderer hands us a command/goal to carry out.
ipcMain.on("start-control", (_event, command) => startControlGoal(command));

ipcMain.on("hide-overlay", () => {
  stopGuide();
  stopControl();
  overlayWindow?.hide();
});

// Live Teach prerequisite: let the overlay be click-through so annotations don't
// trap the cursor — the renderer flips this off only while the pointer is over
// the control bar. `forward: true` keeps mouse-move events flowing so the
// renderer's hover detection still fires while clicks pass through.
ipcMain.on("overlay-set-ignore-mouse", (_event, ignore) => {
  if (!overlayWindow) return;
  if (ignore) overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  else overlayWindow.setIgnoreMouseEvents(false);
});

// Screen Teacher voice input: transcribe mic audio locally via Whisper, then
// clean up likely speech-to-text errors with a fast model before using it.
ipcMain.handle("transcribe", async (_event, audio) => {
  try {
    const raw = await voiceEngine.transcribe(audio);
    const text = await screenTeacher.cleanVoiceQuery(raw);
    return { ok: true, text, raw };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Renderer accepted a result and wants it pasted back into the source app.
ipcMain.on("paste-result", async (_event, text) => {
  if (typeof text !== "string" || !text) return;
  clipboard.writeText(text);
  mainWindow?.hide(); // get our window out of the way before refocusing source
  try {
    await winAutomation.focusAndPaste(sourceHwnd);
  } catch (err) {
    // Paste is best-effort — the result is on the clipboard either way, so the
    // user can Ctrl+V manually if the automation was blocked.
    console.error(`[lazy-ai] Auto-paste failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// The summon popup — frameless, always-on-top, kept out of the taskbar.
// Created hidden once at startup and shown/hidden on demand, so summoning is
// instant (no per-press window construction).
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "Lazy AI",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // The window must outlive its close box: hide instead of destroy so the next
  // summon is instant. Only a real quit (tray menu) tears it down.
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // NOTE: deliberately no "hide on blur" — attaching a file or opening the
  // model dropdown briefly blurs the window, and auto-hiding there would yank
  // the popup away mid-interaction. Dismissal is Esc / ✕ / the toggle hotkey.
}

function showPopup(selectionText = "") {
  if (!mainWindow) createWindow();
  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();
  // renderer prefills the prompt box with any grabbed selection and focuses it
  mainWindow.webContents.send("popup-shown", { selectionText });
}

// Toggle without touching the selection — used by the tray (where the source
// app is no longer focused, so there's nothing meaningful to copy).
function togglePopupNoGrab() {
  if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
  else showPopup();
}

// Copy whatever the user has selected in their current app and capture that
// app's window so we can paste back into it. Restores the user's original
// clipboard afterwards. Returns the selected text ("" if nothing was selected).
async function grabSelectionText() {
  if (!winAutomation.isWindows) return "";

  const original = clipboard.readText();
  clipboard.writeText(SELECTION_SENTINEL);

  sourceHwnd = await winAutomation.grabSelection(); // sends Ctrl+C, returns hwnd

  // The source app may take a beat to populate the clipboard after Ctrl+C.
  let grabbed = clipboard.readText();
  for (let i = 0; i < 6 && grabbed === SELECTION_SENTINEL; i++) {
    await delay(40);
    grabbed = clipboard.readText();
  }

  clipboard.writeText(original); // be polite — leave the clipboard as we found it
  return grabbed === SELECTION_SENTINEL ? "" : grabbed;
}

// The global-hotkey path: if open, dismiss; otherwise grab the selection first,
// then summon the popup prefilled with it.
async function summon() {
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  let selectionText = "";
  try {
    selectionText = await grabSelectionText();
  } catch (err) {
    console.error(`[lazy-ai] Selection grab failed: ${err.message}`);
  }
  showPopup(selectionText);
}

// ---------------------------------------------------------------------------
// Tray icon — the app's persistent home while it runs in the background.
// ---------------------------------------------------------------------------
// (Re)build the tray tooltip + menu — called on startup and whenever the
// active hotkey changes via Settings.
function applyTrayMenu() {
  if (!tray) return;
  const hotkeyLabel = activeHotkey ? prettyHotkey(activeHotkey) : "no hotkey — set one in Settings";
  tray.setToolTip(`Lazy AI — press ${hotkeyLabel}`);
  const screenLabel = activeScreenHotkey ? prettyHotkey(activeScreenHotkey) : "no hotkey";
  const controlLabel = activeControlHotkey ? prettyHotkey(activeControlHotkey) : "no hotkey";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open Lazy AI  (${hotkeyLabel})`, click: () => showPopup() },
      { label: `Ask about my screen  (${screenLabel})`, click: () => showScreenTeacher() },
      { label: `Control my screen  (${controlLabel})`, click: () => showScreenControl() },
      { label: "Settings…", click: openSettings },
      { type: "separator" },
      {
        label: "Quit Lazy AI",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, "..", "assets", "icon.png"))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  // Left-click the tray icon toggles the popup (no selection grab — the source
  // app isn't focused when you're clicking the tray).
  tray.on("click", togglePopupNoGrab);
  applyTrayMenu();
}

// The settings window — a normal framed window, single-instance.
function openSettings() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 640,
    title: "Lazy AI — Settings",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// Register the summon hotkey, preferring the user's choice and falling back
// through the candidate list if it's unavailable. Returns the accelerator that
// actually bound, or null if none did.
function registerSummonHotkey(preferred) {
  // Unregister only our own previous summon key, so re-registering on a
  // settings save doesn't also drop the Screen Teacher hotkey.
  if (activeHotkey) globalShortcut.unregister(activeHotkey);
  activeHotkey = null;
  const order = [preferred, ...HOTKEY_CANDIDATES].filter(Boolean);
  for (const candidate of order) {
    if (globalShortcut.register(candidate, summon)) {
      activeHotkey = candidate;
      break;
    }
  }
  return activeHotkey;
}

function registerScreenTeacherHotkey() {
  for (const candidate of SCREEN_TEACHER_CANDIDATES) {
    if (globalShortcut.register(candidate, showScreenTeacher)) {
      activeScreenHotkey = candidate;
      break;
    }
  }
  if (activeScreenHotkey) {
    console.log(`[lazy-ai] Screen Teacher hotkey: ${prettyHotkey(activeScreenHotkey)}`);
  } else {
    console.error(`[lazy-ai] Could not register any Screen Teacher hotkey — all candidates are in use.`);
  }
}

function registerControlHotkey() {
  for (const candidate of SCREEN_CONTROL_CANDIDATES) {
    if (globalShortcut.register(candidate, showScreenControl)) {
      activeControlHotkey = candidate;
      break;
    }
  }
  if (activeControlHotkey) {
    console.log(`[lazy-ai] Screen Control hotkey: ${prettyHotkey(activeControlHotkey)}`);
  } else {
    console.error(`[lazy-ai] Could not register any Screen Control hotkey — all candidates are in use.`);
  }
}

// ---------------------------------------------------------------------------
// Screen Teacher (Stage 4): screenshot → ask Claude → draw answer on a
// transparent click-safe overlay.
// ---------------------------------------------------------------------------

// The display the Screen Teacher session is bound to — chosen at summon as the
// one under the cursor, so it works on whichever monitor the user is looking at.
// Falls back to primary if no session is active.
function currentDisplay() {
  return activeDisplay || screen.getPrimaryDisplay();
}

// Capture the active display, sized for the consuming model. We fit BOTH a
// long-edge cap AND a MEGAPIXEL cap — the megapixel one is what the API actually
// enforces (per Anthropic's computer-use guidance): exceed it and the API silently
// downscales, so the model's coordinates no longer match the dimensions we report
// and clicks/annotations drift. Long-edge alone wasn't enough (1568×882 = 1.38 MP
// is OVER the Sonnet ~1.15 MP cap). The overlay sizes its canvas to the returned
// dimensions, so coordinates stay 1:1.
async function captureScreen(maxLongEdge, maxPixels) {
  const display = currentDisplay();
  const { width, height } = display.size; // CSS pixels
  const scaleFactor = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor),
    },
  });
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) throw new Error("No screen source available");

  let image = source.thumbnail;
  let size = image.getSize();

  const MAX_LONG_EDGE = maxLongEdge || screenTeacher.maxEdgeFor(activeScreenTeacherModel());
  const MAX_PIXELS = maxPixels || screenTeacher.maxPixelsFor(activeScreenTeacherModel());
  const longEdge = Math.max(size.width, size.height);
  const pixels = size.width * size.height;
  // Take the smaller of the two scales so we satisfy whichever limit binds first.
  let scale = 1;
  if (MAX_LONG_EDGE && longEdge > MAX_LONG_EDGE) scale = Math.min(scale, MAX_LONG_EDGE / longEdge);
  if (MAX_PIXELS && pixels > MAX_PIXELS) scale = Math.min(scale, Math.sqrt(MAX_PIXELS / pixels));
  if (scale < 1) {
    image = image.resize({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
    });
    size = image.getSize();
  }
  // Diagnostic: the sent dims must equal what we tell the model. If the API still
  // downscales, these would mismatch and coords would drift — log so we can spot it.
  console.log(`[lazy-ai] capture sent ${size.width}×${size.height} (${(size.width * size.height / 1e6).toFixed(2)} MP, cap ${(MAX_PIXELS / 1e6).toFixed(2)} MP)`);

  return {
    base64: image.toPNG().toString("base64"),
    mediaType: "image/png",
    width: size.width,
    height: size.height,
  };
}

function createOverlayWindow() {
  const display = currentDisplay();
  overlayWindow = new BrowserWindow({
    ...display.bounds, // x, y, width, height of the active display
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // Exclude our overlay from screen capture (Win10 2004+: WDA_EXCLUDEFROMCAPTURE).
  // The user still sees the annotations, but desktopCapturer does NOT — so the
  // screenshots we send Claude are pristine (no bar/annotation), AND we can watch
  // for the user's action DURING narration without our own animation/pulse being
  // mistaken for a screen change.
  overlayWindow.setContentProtection(true);
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  overlayWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      stopGuide();
      stopControl();
      overlayWindow.hide();
    }
  });
}

// Summon the transparent overlay in a given mode: "teach" (draw/explain) or
// "control" (act on a command). Both share the capture + overlay + voice/bar.
async function summonOverlay(mode) {
  // Toggle off if already up.
  if (overlayWindow && overlayWindow.isVisible()) {
    stopGuide();
    stopControl();
    overlayWindow.hide();
    return;
  }
  stopGuide(); // start each session clean — no leftover watch loop
  stopControl();
  overlayMode = mode;
  // For control: capture the target app window NOW, before our overlay steals
  // focus — so we can query/act on it even once the overlay is foreground.
  controlSourceHwnd = mode === "control" ? await winAutomation.getForegroundWindow() : 0;
  // Bind this session to the display under the cursor, so it works on whichever
  // monitor the user is looking at (capture + overlay + watch all use it).
  activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // Get our own windows out of the shot before capturing.
  if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
  if (overlayWindow && overlayWindow.isVisible()) overlayWindow.hide();
  await delay(150);

  // Cap the capture to the model that will process it (control → Sonnet/1568,
  // teach → the Settings model) so its coordinates map 1:1.
  const captureModel = mode === "control" ? controlModel() : activeScreenTeacherModel();
  try {
    lastScreenshot = await captureScreen(maxEdgeForModel(captureModel), maxPixelsForModel(captureModel));
  } catch (err) {
    console.error(`[lazy-ai] Screenshot failed: ${err.message}`);
    return;
  }

  if (!overlayWindow) createOverlayWindow();
  overlayWindow.setBounds(currentDisplay().bounds);
  overlayWindow.show();
  overlayWindow.focus(); // keyboard focus (typing/Esc) is independent of mouse pass-through
  // Start click-through: annotations never trap the cursor; the bar re-enables
  // itself on hover. Keyboard still reaches the focused window for typing/Esc.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.webContents.send("overlay-show", {
    mode,
    imageWidth: lastScreenshot.width,
    imageHeight: lastScreenshot.height,
  });
}

function showScreenTeacher() {
  return summonOverlay("teach");
}

function showScreenControl() {
  return summonOverlay("control");
}

// ---------------------------------------------------------------------------
// Interactive guide loop: annotate the next action → watch the screen for the
// user to perform it → re-capture and guide the next step → … until done.
// ---------------------------------------------------------------------------
function sendOverlayStatus(text, kind = "") {
  overlayWindow?.webContents.send("overlay-status", { text, kind });
}

// A small thumbnail of the screen, as a raw RGBA buffer, for cheap change
// detection. The overlay's annotation is static while we watch, so it cancels
// out when we diff consecutive frames — only the user's actions show up.
async function captureScreenThumbnail() {
  const display = currentDisplay();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 200, height: 120 },
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  return source ? source.thumbnail.toBitmap() : null;
}

// Fraction (0..1) of sampled pixels that changed substantially between two
// equal-size RGBA buffers (sampling every 4th pixel for speed). This catches a
// localized change — a dropdown, a panel — that a whole-frame average would miss,
// while ignoring faint compression/antialiasing noise. 1 = "different/unknown".
function changedFraction(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 1;
  let changed = 0;
  let total = 0;
  for (let i = 0; i + 2 < a.length; i += 16) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > WATCH_PIXEL_DELTA) changed++;
    total++;
  }
  return total ? changed / total : 1;
}

function stopWatching() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  watchPrev = null;
  watchDirty = false;
}

function stopGuide() {
  guideActive = false;
  stopWatching();
}

// Stop the Screen Control loop and cancel any action waiting in its preview
// window (so dismissing the overlay aborts mid-sequence).
function stopControl() {
  controlActive = false;
  if (controlTimer) clearTimeout(controlTimer);
  controlTimer = null;
}

// Map a normalized fraction of the active display (fx, fy in 0–1) to a PHYSICAL
// screen pixel for the DPI-aware control script. The model returns PERCENTAGES
// (resolution-independent — no dependence on the screenshot's pixel size or the
// model's image cap), which we convert to a fraction here. Two delegated stages:
//   1) fraction → DIP point inside the display's bounds (DIP).
//   2) DIP → physical via Electron's screen.dipToScreenPoint, which the OS makes
//      accurate across per-monitor DPI (125%/150%) and multi-monitor layouts.
function fractionToPhysical(fx, fy) {
  const d = currentDisplay();
  const cfx = Math.min(1, Math.max(0, fx));
  const cfy = Math.min(1, Math.max(0, fy));
  const dipPoint = {
    x: Math.round(d.bounds.x + cfx * d.bounds.width),
    y: Math.round(d.bounds.y + cfy * d.bounds.height),
  };
  const phys = screen.dipToScreenPoint(dipPoint);
  return { x: Math.round(phys.x), y: Math.round(phys.y) };
}

// Inverse: a PHYSICAL screen pixel → overlay-canvas pixel (canvas = screenshot
// size), so a UIA element's real rect can be marked accurately in the preview.
function physicalToCanvas(px, py, shot) {
  const d = currentDisplay();
  const dip = screen.screenToDipPoint({ x: Math.round(px), y: Math.round(py) });
  const fx = d.bounds.width ? (dip.x - d.bounds.x) / d.bounds.width : 0;
  const fy = d.bounds.height ? (dip.y - d.bounds.y) / d.bounds.height : 0;
  return { x: Math.round(fx * shot.width), y: Math.round(fy * shot.height) };
}

// Our overlay's native window handle, so the UIA query can skip it (the overlay
// is never a target). Returns 0 if unavailable.
function overlayHwnd() {
  try {
    const buf = overlayWindow.getNativeWindowHandle();
    return buf.length >= 8 ? Number(buf.readBigUInt64LE()) : buf.readUInt32LE();
  } catch {
    return 0;
  }
}

async function startGuide(question) {
  if (!overlayWindow || !overlayWindow.isVisible()) return;
  stopWatching();
  guideActive = true;
  guideGoal = (question || "").trim();
  guideHistory = [];
  guideTurn = 0;
  await runGuideTurn({ useExistingShot: true });
}

// Poll the screen; once it changes (user acting) and then settles, guide the
// next step. Runs in parallel with narration. The baseline is grabbed right now
// (just after the clean capture, before the user has acted) so even a near-
// instant click is detected against the pre-action state.
async function startWatching() {
  stopWatching();
  try {
    watchPrev = await captureScreenThumbnail();
  } catch {
    watchPrev = null;
  }
  watchDirty = false;
  if (guideActive && !watchTimer) scheduleWatchTick();
}

function scheduleWatchTick() {
  watchTimer = setTimeout(watchTick, WATCH_INTERVAL_MS);
}

async function watchTick() {
  watchTimer = null;
  if (!guideActive || !overlayWindow || !overlayWindow.isVisible()) return;

  let cur = null;
  try {
    cur = await captureScreenThumbnail();
  } catch {
    cur = null;
  }
  if (!guideActive) return;

  if (cur && watchPrev) {
    const frac = changedFraction(cur, watchPrev);
    if (frac > WATCH_CHANGE_FRACTION) {
      if (!watchDirty) console.log(`[lazy-ai] guide: screen change detected (${(frac * 100).toFixed(1)}%), waiting for it to settle…`);
      watchDirty = true; // the screen is in motion — the user is doing something
    } else if (watchDirty) {
      // it moved and has now settled → the action is complete; guide what's next
      console.log("[lazy-ai] guide: screen settled → guiding next step");
      runGuideTurn({ useExistingShot: false });
      return;
    }
  }
  if (cur) watchPrev = cur;
  scheduleWatchTick();
}

async function runGuideTurn({ useExistingShot }) {
  if (!guideActive || !overlayWindow) return;
  stopWatching();

  if (guideTurn >= GUIDE_MAX_TURNS) {
    sendOverlayStatus("That's as far as I can guide automatically — ask again to continue.", "");
    stopGuide();
    return;
  }

  sendOverlayStatus("Looking at your screen…", "loading");

  // The overlay is excluded from capture (content protection), so captureScreen()
  // is already clean — no need to hide it, which also keeps any open menu/dropdown
  // intact. Turn 1 reuses the shot taken at summon.
  let shot;
  try {
    if (useExistingShot && lastScreenshot) {
      shot = lastScreenshot;
    } else {
      overlayWindow.webContents.send("overlay-clear"); // wipe the old pointer while we think
      shot = await captureScreen(maxEdgeForModel(activeScreenTeacherModel()), maxPixelsForModel(activeScreenTeacherModel()));
      lastScreenshot = shot;
    }
  } catch (err) {
    console.error(`[lazy-ai] Guide capture failed: ${err.message}`);
    sendOverlayStatus("Couldn't capture the screen — try again.", "err");
    stopGuide();
    return;
  }

  const turnText =
    guideTurn === 0
      ? null // first turn: the goal (question) is the prompt
      : `The user has now acted and the screen has changed. Continue guiding them toward their goal: "${guideGoal}". Look only at the CURRENT screen and point to the next single action — or, if the goal is now achieved, set "done": true and say so briefly.`;

  const model = activeScreenTeacherModel();
  // Sonnet path: OCR this exact screenshot so the model can point at code/text
  // lines by index (we snap to the real rect). Best-effort — [] falls back cleanly
  // to the pixel path. Opus skips OCR entirely (keeps its accurate pixel path).
  let ocrLines = [];
  if (usesOcrLineSnapping(model)) {
    try {
      ocrLines = await winAutomation.ocrImage(shot.base64);
    } catch {
      ocrLines = [];
    }
    if (!guideActive) return; // dismissed while OCR ran
  }

  let res;
  try {
    res = await screenTeacher.askAboutScreen({
      imageBase64: shot.base64,
      mediaType: shot.mediaType,
      question: guideGoal,
      imageWidth: shot.width,
      imageHeight: shot.height,
      history: guideHistory,
      turnText,
      model,
      ocrLines,
    });
  } catch (err) {
    res = { ok: false, error: String(err.message || err) };
  }

  if (!guideActive) return; // user dismissed while we were waiting on the API

  if (!res.ok) {
    sendOverlayStatus(res.error || "Something went wrong.", "err");
    stopGuide();
    return;
  }

  // Carry the turn forward as text only (drop the image to keep tokens sane).
  guideHistory.push({ role: "user", content: [{ type: "text", text: (turnText || guideGoal) + " [screenshot shown]" }] });
  guideHistory.push({ role: "assistant", content: [{ type: "text", text: res.raw }] });
  guideTurn += 1;

  overlayWindow.webContents.send("overlay-play-steps", {
    steps: res.steps, // Teacher draw-coords are absolute pixels in screenshot space
    done: res.done,
    accumulate: res.accumulate,
    imageWidth: shot.width,
    imageHeight: shot.height,
  });

  // Start watching for the user's action immediately — in PARALLEL with the
  // narration — so a click made mid-instruction is caught on the next poll
  // instead of only after the voiceover finishes. (Our overlay is excluded from
  // capture, so its animation never trips the detector.)
  if (res.done) stopGuide();
  else startWatching();
}

// ---------------------------------------------------------------------------
// Screen Control (Stage 5.3, keyboard-first fast path): each turn we capture →
// ask for a PLAN (a batch of mostly-keyboard actions) → preview it → run the
// whole batch in ONE PowerShell process → if not done, wait for the screen to
// settle, re-capture and plan again. Most tasks finish in one model call + one
// PowerShell run; vision-clicks are the fallback within the same plan.
// ---------------------------------------------------------------------------
const CONTROL_PREVIEW_MS = 400; // brief, cancelable preview before a batch runs
const CONTROL_MAX_TURNS = 14; // safety cap on re-plans (multi-step app tasks need headroom)
const SPATIAL_TYPES = ["click", "doubleclick", "rightclick", "scroll"];

async function startControlGoal(command) {
  if (!overlayWindow || !overlayWindow.isVisible()) return;
  stopControl();
  controlActive = true;
  controlGoal = (command || "").trim();
  controlHistory = [];
  controlTurnCount = 0;
  controlTargetHwnd = controlSourceHwnd; // start from the app the user summoned over
  await controlTurn({ useExistingShot: true });
}

// Poll until the screen stops changing after we acted, so the UI has finished
// updating before we decide the next step. Bounded by maxMs.
async function waitForScreenSettle({ maxMs = 2000, interval = 250 } = {}) {
  const start = Date.now();
  let prev = await captureScreenThumbnail().catch(() => null);
  await delay(interval);
  while (controlActive && Date.now() - start < maxMs) {
    const cur = await captureScreenThumbnail().catch(() => null);
    if (cur && prev && changedFraction(cur, prev) < 0.02) return; // settled enough
    prev = cur;
    await delay(interval);
  }
}

// Turn the model's plan into a fully-resolved batch the PowerShell executor can
// run directly: key combos → SendKeys; vision %-coords → physical pixels; UIA
// element refs → {id,name,physical center} for the executor to re-find/invoke.
// Is the user's goal to SEND/WRITE a message (as opposed to merely searching)?
// Used to enforce the search-box-vs-message-box guard below.
function isMessagingGoal(goal) {
  return /\b(message|messaging|msg|send|tell|reply|writ|compose|say|dm|text|chat|ping)\b/i.test(String(goal || ""));
}

// Phase 3 — element disambiguation guard. The model sometimes targets the SEARCH
// box (top of Teams/Outlook/Slack) for a ui_type that should go in the MESSAGE box
// (bottom) — both are edit fields, so the prompt alone isn't enough. These are
// CODE-level guards (not prompt-only): we verify the chosen element's properties
// and DROP an unsafe ui_type so the loop re-plans rather than dumping the message
// into the wrong field. Dropping (not redirecting) keeps it honest — we never
// silently retarget the model's ref; we just refuse the obviously-wrong one.
function resolvePlan(actions, elements, goal, imageWidth, imageHeight) {
  const byRef = (ref) => (Array.isArray(elements) ? elements.find((e) => e.idx === ref) : null);
  const messaging = isMessagingGoal(goal);
  // Model click/scroll coords are PIXELS in the screenshot frame (W×H). Convert to a
  // 0–1 fraction of the display, then to physical px (DPI/multi-monitor accurate).
  const W = imageWidth || (lastScreenshot && lastScreenshot.width) || 1;
  const H = imageHeight || (lastScreenshot && lastScreenshot.height) || 1;
  const resolved = [];
  for (const a of actions) {
    if (a.type === "launch") resolved.push({ type: "launch", app: a.app });
    else if (a.type === "press") resolved.push({ type: "press", send: winAutomation.composeSendKeys(a.keys) });
    else if (a.type === "text") resolved.push({ type: "text", text: a.text });
    else if (a.type === "wait") resolved.push({ type: "wait", ms: a.ms });
    else if (a.type === "scroll") {
      const p = fractionToPhysical(a.x / W, a.y / H);
      resolved.push({ type: "scroll", x: p.x, y: p.y, amount: a.amount });
    } else if (a.type === "click" || a.type === "doubleclick" || a.type === "rightclick") {
      const p = fractionToPhysical(a.x / W, a.y / H);
      resolved.push({ type: a.type, x: p.x, y: p.y });
    } else if (a.type === "ui_invoke" || a.type === "ui_click" || a.type === "ui_type") {
      const el = byRef(a.ref);
      if (!el) continue; // stale ref → drop
      if (a.type === "ui_type") {
        // Guard 1 — never type into a non-editable control (a button/icon/tab has
        // no Value pattern and an edit/text/combo/document type). Skip + re-plan.
        const editable = el.value || /edit|text|combo|document/i.test(String(el.type || ""));
        if (!editable) {
          console.warn(`[lazy-ai] control: blocked ui_type into non-editable "${el.name}" (${el.type})`);
          continue;
        }
        // Guard 2 — when the goal is to send a message, never type it into a field
        // named like a search box. The message belongs in the compose field.
        if (messaging && /search|find/i.test(`${el.name || ""} ${el.id || ""}`)) {
          console.warn(`[lazy-ai] control: blocked message ui_type into search field "${el.name}"`);
          continue;
        }
      }
      const cx = Math.round(el.x + el.w / 2); // element center (physical px)
      const cy = Math.round(el.y + el.h / 2);
      if (a.type === "ui_click") resolved.push({ type: "uia", verb: "click", x: cx, y: cy });
      else if (a.type === "ui_invoke") resolved.push({ type: "uia", verb: "invoke", id: el.id, name: el.name, x: cx, y: cy });
      else resolved.push({ type: "uia", verb: "settext", id: el.id, name: el.name, x: cx, y: cy, text: a.text });
    }
  }
  return resolved;
}

// Budget a timeout that covers the plan's own waits plus per-action overhead.
function planTimeoutMs(actions) {
  const waits = actions.reduce((sum, a) => sum + (a.type === "wait" ? a.ms : 0), 0);
  return Math.min(45000, 8000 + waits + actions.length * 500);
}

async function controlTurn({ useExistingShot }) {
  if (!controlActive || !overlayWindow) return;

  if (controlTurnCount >= CONTROL_MAX_TURNS) {
    sendOverlayStatus("Stopped after several steps — ask again to continue.", "");
    stopControl();
    return;
  }

  sendOverlayStatus("Planning…", "loading");
  let shot;
  try {
    // Capture + UIA query in parallel (independent). queryUiElements never throws.
    // Query uses the live foreground, falling back to the known target window so
    // an already-open app is seen even while our overlay is foreground.
    const [s, ui] = await Promise.all([
      useExistingShot && lastScreenshot ? Promise.resolve(lastScreenshot) : captureScreen(maxEdgeForModel(controlModel()), maxPixelsForModel(controlModel())),
      winAutomation.queryUiElements(overlayHwnd(), controlTargetHwnd, 80),
    ]);
    shot = s;
    lastScreenshot = shot;
    controlElements = ui.elements || [];
    if (ui.hwnd) controlTargetHwnd = ui.hwnd; // track the resolved target window
  } catch (err) {
    sendOverlayStatus("Couldn't capture the screen — try again.", "err");
    stopControl();
    return;
  }

  const turnText =
    controlTurnCount === 0
      ? null // first turn: the goal (command) is the prompt
      : `You have performed the previous actions; here is the updated screen. Continue toward the goal: "${controlGoal}". Return the next batch of actions, or set "done":true with "actions":[] if the goal is now complete.`;

  let res;
  try {
    res = await screenControl.planActions({
      imageBase64: shot.base64,
      mediaType: shot.mediaType,
      command: controlGoal,
      imageWidth: shot.width,
      imageHeight: shot.height,
      model: controlModel(), // must match the capture cap above
      history: controlHistory,
      turnText,
      elements: controlElements,
    });
  } catch (err) {
    res = { ok: false, error: String(err.message || err) };
  }
  if (!controlActive) return; // dismissed mid-call

  if (!res.ok) {
    sendOverlayStatus(res.error || "Something went wrong.", "err");
    stopControl();
    return;
  }

  const plan = res.plan;
  controlHistory.push({ role: "user", content: [{ type: "text", text: (turnText || `Goal: ${controlGoal}`) + " [screenshot shown]" }] });
  controlHistory.push({ role: "assistant", content: [{ type: "text", text: res.raw }] });
  controlTurnCount += 1;

  // No actions: goal already complete (done) or stuck (explain + stay open).
  if (!plan.actions.length) {
    overlayWindow.webContents.send("overlay-play-steps", {
      steps: [{ say: plan.say || "Done.", draw: [] }],
      done: true,
      accumulate: false,
      imageWidth: shot.width,
      imageHeight: shot.height,
    });
    if (plan.done) finishControl();
    else stopControl(); // couldn't proceed — leave the overlay up for another command
    return;
  }

  // Preview: speak the plan's summary and mark any click targets — both vision
  // %-clicks and UIA element targets (drawn on the element's real rect center).
  const r = Math.max(26, Math.round(shot.width / 60));
  const draw = [];
  for (const a of plan.actions) {
    if (SPATIAL_TYPES.includes(a.type)) {
      // a.x/a.y are already pixels in the screenshot frame = overlay-canvas space.
      draw.push({ shape: "circle", x: Math.round(a.x), y: Math.round(a.y), r, label: a.type });
    } else if (a.type === "ui_invoke" || a.type === "ui_click" || a.type === "ui_type") {
      const el = controlElements.find((e) => e.idx === a.ref);
      if (el) {
        const c = physicalToCanvas(el.x + el.w / 2, el.y + el.h / 2, shot);
        draw.push({ shape: "circle", x: c.x, y: c.y, r, label: a.type.replace("ui_", "") });
      }
    }
  }
  overlayWindow.webContents.send("overlay-play-steps", {
    steps: [{ say: plan.say || "Working…", draw }],
    done: true,
    accumulate: false,
    imageWidth: shot.width,
    imageHeight: shot.height,
  });

  const resolved = resolvePlan(plan.actions, controlElements, controlGoal, shot.width, shot.height);
  const targetHwnd = controlTargetHwnd;
  controlTimer = setTimeout(async () => {
    controlTimer = null;
    if (!controlActive) return;
    try {
      await winAutomation.performPlan(resolved, planTimeoutMs(plan.actions), targetHwnd);
    } catch (err) {
      sendOverlayStatus(`Action failed: ${String(err.message || err)}`, "err");
      stopControl();
      return;
    }
    if (!controlActive) return;
    if (plan.done) {
      finishControl(); // the batch completed the goal
      return;
    }
    await waitForScreenSettle(); // let the batch's effects render before re-planning
    if (!controlActive) return;
    controlTurn({ useExistingShot: false });
  }, CONTROL_PREVIEW_MS);
}

// Goal complete: stop the loop and get the overlay out of the way (after a beat
// so any spoken confirmation finishes).
function finishControl() {
  stopControl();
  setTimeout(() => {
    if (overlayWindow && !controlActive) overlayWindow.hide();
  }, 1600);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function init() {
  settingsStore.injectKeysIntoEnv(); // stored keys override .env before any call

  // Allow the Screen Teacher overlay to use the microphone (Whisper voice input).
  // Local single-user app: grant media; the audio is transcribed on-device.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "microphone" || permission === "audioCapture");
  });

  startLocalServer(); // serve localhost:8788 for the browser extension
  createWindow();

  // Prefer the user's saved hotkey, falling back through the candidates.
  registerSummonHotkey(settingsStore.getPublicSettings().hotkey);
  if (activeHotkey) {
    console.log(`[lazy-ai] Summon hotkey: ${prettyHotkey(activeHotkey)}`);
  } else {
    console.error(`[lazy-ai] Could not register any summon hotkey — all candidates are in use. Open from the tray instead.`);
  }

  registerScreenTeacherHotkey();
  registerControlHotkey();
  createTray();
}

app.on("will-quit", () => globalShortcut.unregisterAll());

// The app is a tray resident: closing the popup must NOT quit it. (With
// hide-on-close above this rarely fires, but we keep it alive regardless.)
app.on("window-all-closed", () => {});

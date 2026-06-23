// Lizzie — Electron main process.
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

const { MODELS, DEFAULT_MODEL, polish, extractTextFromFile, extractAttachment } = require("./polish-engine");
const { startLocalServer } = require("./local-server");
const winAutomation = require("./win-automation");
const settingsStore = require("./settings-store");
const screenTeacher = require("./screen-teacher");
const screenControl = require("./screen-control");
const voiceEngine = require("./voice-engine");
const ttsEngine = require("./tts-engine");

// Resilience net. A benign hiccup in the streamed Edge-TTS path — e.g. the shared
// socket being hard-closed mid-stream when narration is interrupted or a new turn
// starts — can surface as an unhandled rejection or a late socket "error" in this
// process. Electron's default turns those into the modal "A JavaScript error occurred
// in the main process" dialog and aborts the narration. Log them instead, so the app
// stays alive and the overlay simply falls back to the local voice — never popping
// that dialog. (Genuine bugs are still printed with a full stack.)
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection (ignored):", (reason && reason.stack) || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException (ignored):", (err && err.stack) || err);
});

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
let controlRetries = 0; // consecutive soft failures (focus abort / unparseable plan) this loop; bounded re-plan
let controlElements = []; // this turn's UIA element list (idx,name,type,rect,…)
let controlTargetHwnd = 0; // the target app window (for UIA re-find at execution)
let controlWokeHwnd = 0; // last target whose UIA a11y tree we already woke this session (skip the 700ms re-wake)
let controlBrowserHwnd = 0; // last target detected as a real browser (skip the UIA query — it returns [] anyway)
let controlSourceHwnd = 0; // foreground window captured at summon (the app the user was in)
let controlSavedClipboard = null; // user's clipboard text, preserved for the whole control session
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
let guideStreamAbort = null; // AbortController for the in-flight streamed Teacher turn
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
  const docExts = ["txt", "md", "pdf", "docx", "js", "ts", "py", "json", "html", "css", "java", "c", "cpp", "cs", "go", "rs", "rb", "php", "swift", "csv", "yml", "yaml", "xml"];
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Documents, code & images", extensions: [...docExts, ...imageExts] },
      { name: "Images", extensions: imageExts },
      { name: "Documents & code", extensions: docExts },
    ],
  });
  if (canceled || filePaths.length === 0) return null;
  const filePath = filePaths[0];
  try {
    // Returns { text } for docs/code or { image: { base64, mediaType } } for images.
    const attachment = await extractAttachment(filePath);
    return { name: path.basename(filePath), ...attachment };
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

// Premium TTS (Phase 1B): synthesize spoken narration with the Edge-TTS "Ava"
// voice and hand the MP3 back to the overlay as base64. Throwing here is fine —
// the overlay falls back to the local Windows speechSynthesis voice on !ok.
ipcMain.handle("speak", async (_event, { text, rate } = {}) => {
  try {
    const { audio, mime } = await ttsEngine.synthesize(text, { rate });
    return { ok: true, audio: audio.toString("base64"), mime };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Debug: surface the overlay's TTS decision path in the terminal alongside the
// [tts] engine logs, so the whole Edge-TTS → fallback flow is visible in one place.
ipcMain.on("tts-log", (_event, msg) => console.log("[overlay-tts]", msg));

// Hard-kill the Edge-TTS connection when the overlay interrupts / starts a new
// turn, so a stale in-flight prefetch can't keep streaming on the shared socket
// and starve the next request. No-op in the engine when nothing is in flight.
ipcMain.on("tts-reset", () => ttsEngine.resetConnection());

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
    transparent: true, // see-through window so the glass cards frost the live desktop
    backgroundColor: "#00000000",
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "Lizzie",
    icon: path.join(__dirname, "..", "assets", "Lizzie_Logo.png"),
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
  tray.setToolTip(`Lizzie — press ${hotkeyLabel}`);
  const screenLabel = activeScreenHotkey ? prettyHotkey(activeScreenHotkey) : "no hotkey";
  const controlLabel = activeControlHotkey ? prettyHotkey(activeControlHotkey) : "no hotkey";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open Lizzie  (${hotkeyLabel})`, click: () => showPopup() },
      { label: `Ask about my screen  (${screenLabel})`, click: () => showScreenTeacher() },
      { label: `Control my screen  (${controlLabel})`, click: () => showScreenControl() },
      { label: "Settings…", click: openSettings },
      { type: "separator" },
      {
        label: "Quit Lizzie",
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
    .createFromPath(path.join(__dirname, "..", "assets", "Lizzie_Logo.png"))
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
    title: "Lizzie — Settings",
    icon: path.join(__dirname, "..", "assets", "Lizzie_Logo.png"),
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
async function captureScreen(maxLongEdge, maxPixels, format = "png") {
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

  // DeskPilot uploads JPEG (much smaller payload → faster API round-trip); the
  // Teacher path stays PNG (its OCR line-snapping reads the PNG). Either way the
  // dimensions are unchanged, so the model's pixel coords still map 1:1.
  const useJpeg = format === "jpeg";
  return {
    base64: (useJpeg ? image.toJPEG(72) : image.toPNG()).toString("base64"),
    mediaType: useJpeg ? "image/jpeg" : "image/png",
    width: size.width,
    height: size.height,
  };
}

// Resolves when the overlay renderer has finished loading (set in
// createOverlayWindow). summonOverlay awaits it before sending "overlay-show".
let overlayReadyPromise = null;

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
      // Streamed Edge-TTS narration auto-plays without a click — the overlay is
      // summoned by a hotkey, which isn't a web "user gesture", so allow autoplay.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // Exclude our overlay from screen capture (Win10 2004+: WDA_EXCLUDEFROMCAPTURE).
  // The user still sees the annotations, but desktopCapturer does NOT — so the
  // screenshots we send Claude are pristine (no bar/annotation), AND we can watch
  // for the user's action DURING narration without our own animation/pulse being
  // mistaken for a screen change.
  overlayWindow.setContentProtection(true);
  // Resolve once the renderer has loaded (and registered its onOverlayShow
  // listener), so summonOverlay never sends the mode before anyone is listening —
  // that race made the FIRST Ctrl+Shift+A open DeskTutor instead of DeskPilot.
  overlayReadyPromise = new Promise((resolve) => {
    overlayWindow.webContents.once("did-finish-load", resolve);
  });
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
  // Control → JPEG (small/fast upload); Teach → PNG (OCR line-snapping needs it).
  const captureFormat = mode === "control" ? "jpeg" : "png";
  try {
    lastScreenshot = await captureScreen(maxEdgeForModel(captureModel), maxPixelsForModel(captureModel), captureFormat);
  } catch (err) {
    console.error(`[lazy-ai] Screenshot failed: ${err.message}`);
    return;
  }

  if (!overlayWindow) createOverlayWindow();
  overlayWindow.setBounds(currentDisplay().bounds);
  overlayWindow.show();
  overlayWindow.focus(); // keyboard focus (typing/Esc) is independent of mouse pass-through
  ttsEngine.warmUp(); // pre-open the Edge-TTS socket so the first narration starts fast
  // Start click-through: annotations never trap the cursor; the bar re-enables
  // itself on hover. Keyboard still reaches the focused window for typing/Esc.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  // Wait until the renderer is loaded before sending the mode, or the FIRST summon
  // (window still loading) loses the event and opens in the wrong mode (#5).
  if (overlayReadyPromise) await overlayReadyPromise;
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
  if (guideStreamAbort) { guideStreamAbort.abort(); guideStreamAbort = null; } // cancel any in-flight stream
  stopWatching();
}

// Stop the Screen Control loop and cancel any action waiting in its preview
// window (so dismissing the overlay aborts mid-sequence).
function stopControl() {
  controlActive = false;
  if (controlTimer) clearTimeout(controlTimer);
  controlTimer = null;
  // Restore the user's clipboard saved at session start (see startControlGoal).
  // Idempotent: nulled after restoring, so the stopControl() at the top of
  // startControlGoal and any repeated/dismiss calls don't double-restore. Only
  // restore real text — a falsy ("") saved value means the clipboard held no text
  // (e.g. an image), so we leave it rather than clobber it with an empty string.
  if (controlSavedClipboard) {
    clipboard.writeText(controlSavedClipboard);
  }
  controlSavedClipboard = null;
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

  // Stream the answer so step 0 narrates/draws the instant it parses, while the model
  // is still generating the rest — this is the big time-to-first-audio win. main
  // forwards each step to the overlay: step 0 starts the walkthrough, later steps
  // append, and steps-done closes the list so playback can finish at the end.
  if (guideStreamAbort) guideStreamAbort.abort(); // supersede any prior in-flight turn
  const abort = new AbortController();
  guideStreamAbort = abort;
  let firstSent = false;
  let turnDone = true; // updated by onMeta (done/accumulate stream before the steps)
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
      signal: abort.signal,
      onMeta: ({ done }) => { turnDone = done; },
      onStep: (step, i) => {
        if (!guideActive || !overlayWindow) return;
        if (i === 0) {
          firstSent = true;
          overlayWindow.webContents.send("overlay-play-steps", {
            steps: [step], // Teacher draw-coords are absolute pixels in screenshot space
            done: turnDone,
            // Force REPLACE mode: each step's annotation clears as the next is spoken
            // (the model's accumulate build-up is intentionally ignored for DeskTutor).
            accumulate: false,
            imageWidth: shot.width,
            imageHeight: shot.height,
            streaming: true, // more steps will arrive via overlay-append-step
          });
        } else {
          overlayWindow.webContents.send("overlay-append-step", { step });
        }
      },
    });
  } catch (err) {
    res = { ok: false, error: String(err.message || err) };
  } finally {
    if (guideStreamAbort === abort) guideStreamAbort = null;
  }

  if (!guideActive) return; // user dismissed while we were waiting on the API

  if (!res.ok) {
    if (res.aborted) return; // a newer turn / stop superseded us — it now owns the overlay
    if (!firstSent) { sendOverlayStatus(res.error || "Something went wrong.", "err"); stopGuide(); return; }
    overlayWindow.webContents.send("overlay-steps-done"); // some steps played → close cleanly
    stopGuide();
    return;
  }

  // No step ever parsed (rare) → a single spoken fallback so the overlay isn't empty.
  if (!firstSent) {
    overlayWindow.webContents.send("overlay-play-steps", {
      steps: [{ say: "Done.", draw: [] }],
      done: res.done,
      accumulate: false,
      imageWidth: shot.width,
      imageHeight: shot.height,
    });
  } else {
    overlayWindow.webContents.send("overlay-steps-done"); // list complete — overlay may finish at the end
  }

  // Carry the turn forward as text only (drop the image to keep tokens sane).
  guideHistory.push({ role: "user", content: [{ type: "text", text: (turnText || guideGoal) + " [screenshot shown]" }] });
  guideHistory.push({ role: "assistant", content: [{ type: "text", text: res.raw }] });
  guideTurn += 1;

  // Watch for the user's action in PARALLEL with narration so a click made
  // mid-instruction is caught on the next poll, not only after the voiceover ends.
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
const CONTROL_PREVIEW_MS = 120; // brief, cancelable preview before a batch runs (kept tight to cut per-step latency)
const CONTROL_MAX_TURNS = 14; // safety cap on re-plans (multi-step app tasks need headroom)
const SPATIAL_TYPES = ["click", "doubleclick", "rightclick", "scroll"];

async function startControlGoal(command) {
  if (!overlayWindow || !overlayWindow.isVisible()) return;
  stopControl();
  // Preserve the user's clipboard for the WHOLE session (restored in stopControl),
  // NOT per-batch. Screen Control moves cross-app data with copy→paste (ctrl+c →
  // ctrl+v), which spans multiple turns = multiple PowerShell batches; the old
  // per-batch save/restore in control-batch.ps1 wiped the freshly-copied data
  // before the paste turn could use it. Saving once here keeps copied data alive
  // across turns. (Text-only: an image on the clipboard can't be preserved —
  // readText() returns "" for it; documented caveat.)
  controlSavedClipboard = clipboard.readText();
  controlActive = true;
  controlGoal = (command || "").trim();
  controlHistory = [];
  controlTurnCount = 0;
  controlRetries = 0;
  controlWokeHwnd = 0; // fresh session: nothing woken / detected yet
  controlBrowserHwnd = 0;
  controlTargetHwnd = controlSourceHwnd; // start from the app the user summoned over
  await controlTurn({ useExistingShot: true });
}

// Poll until the screen stops changing after we acted, so the UI has finished
// updating before we decide the next step. Bounded by maxMs.
async function waitForScreenSettle({ maxMs = 1500, interval = 120 } = {}) {
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

// Does the goal describe moving COPIED data — "copy/grab X then send/paste/share it"?
// In this mode the payload itself must travel on the clipboard (ctrl+c → ctrl+v); the
// only thing the agent should TYPE is a short search term (a person/app name).
function isCopyPasteGoal(goal) {
  const g = String(goal || "");
  return /\b(copy|grab|copied)\b/i.test(g) && /\b(send|sent|paste|share|forward|message|msg|reply|dm|put|insert|into|to)\b/i.test(g);
}

// Lowercase alphanumeric word list, for fuzzy comparison of typed text vs. the goal.
function goalWords(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

// Is `text` the model regurgitating the command/goal instead of real content (the
// "it sends the prompt I requested" bug)? True only when the typed text reproduces the
// WHOLE command — it contains the goal verbatim, or covers most of the goal's words.
//
// CRUCIAL: we must NOT flag a short FRAGMENT of the goal. A contact name, search term,
// or dictated word almost always appears inside the command ("...send it to Bhone Min
// Thant"), so a naive "is the typed text a substring of the goal" check (or a fraction
// of the TYPED words) would wrongly flag a legitimate search query — which is exactly
// what made the payload get pasted into the search box. So we only measure how much of
// the GOAL the typed text covers (hits / goal-length): a fragment covers little, a full
// regurgitation covers nearly all.
function echoesGoal(text, goal) {
  const tw = goalWords(text);
  const gw = goalWords(goal);
  if (tw.length < 3 || gw.length < 3) return false;
  if (tw.join(" ").includes(gw.join(" "))) return true; // typed text contains the entire goal
  const gset = new Set(gw);
  const hits = tw.filter((w) => gset.has(w)).length;
  return hits / gw.length >= 0.6; // typed text covers most of the goal's words
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
  const copyPaste = isCopyPasteGoal(goal);
  // Model click/scroll coords are PIXELS in the screenshot frame (W×H). Convert to a
  // 0–1 fraction of the display, then to physical px (DPI/multi-monitor accurate).
  const W = imageWidth || (lastScreenshot && lastScreenshot.width) || 1;
  const H = imageHeight || (lastScreenshot && lastScreenshot.height) || 1;
  const resolved = [];
  for (const a of actions) {
    if (a.type === "launch") resolved.push({ type: "launch", app: a.app });
    else if (a.type === "press") {
      const send = winAutomation.composeSendKeys(a.keys);
      if (send) resolved.push({ type: "press", send });
      else console.warn(`[lazy-ai] control: dropped unsupported key combo "${a.keys}" (Windows-key combos aren't addressable — open apps with "launch")`);
    }
    else if (a.type === "text") {
      // Guard 3 (field-unknown variant) — anti-regurgitation. On a "copy X and send it"
      // task the model can't see the copied payload, so it sometimes TYPES the command
      // itself. A plain "text" action doesn't tell us WHICH field is focused, so we must
      // NOT blind-paste here (it could land in a search box). DROP it and let the model
      // re-plan: the payload is moved by pressing ctrl+v at its real destination.
      if (copyPaste && echoesGoal(a.text, goal)) {
        console.warn("[lazy-ai] control: dropped goal-echo text (re-plan; payload is pasted at its destination, not typed)");
      } else {
        resolved.push({ type: "text", text: a.text });
      }
    }
    else if (a.type === "wait") resolved.push({ type: "wait", ms: a.ms });
    else if (a.type === "scroll") {
      const p = fractionToPhysical(a.x / W, a.y / H);
      resolved.push({ type: "scroll", x: p.x, y: p.y, amount: a.amount });
    } else if (a.type === "click" || a.type === "doubleclick" || a.type === "rightclick") {
      const p = fractionToPhysical(a.x / W, a.y / H);
      resolved.push({ type: a.type, x: p.x, y: p.y });
    } else if (a.type === "drag" || a.type === "selecttext") {
      // Both endpoints are screenshot pixels → physical px (DPI/multi-monitor accurate).
      const p1 = fractionToPhysical(a.x1 / W, a.y1 / H);
      const p2 = fractionToPhysical(a.x2 / W, a.y2 / H);
      resolved.push({ type: a.type, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    } else if (a.type === "ui_invoke" || a.type === "ui_click" || a.type === "ui_type") {
      const el = byRef(a.ref);
      if (!el) continue; // stale ref → drop
      const cx = Math.round(el.x + el.w / 2); // element center (physical px)
      const cy = Math.round(el.y + el.h / 2);
      if (a.type === "ui_type") {
        // Guard 1 — never type into a non-editable control (a button/icon/tab has
        // no Value pattern and an edit/text/combo/document type). Skip + re-plan.
        const editable = el.value || /edit|text|combo|document/i.test(String(el.type || ""));
        if (!editable) {
          console.warn(`[lazy-ai] control: blocked ui_type into non-editable "${el.name}" (${el.type})`);
          continue;
        }
        const searchField = /search|find/i.test(`${el.name || ""} ${el.id || ""}`);
        const echo = copyPaste && echoesGoal(a.text, goal);
        // Guard 2 — a SEARCH/FIND box takes a short navigational QUERY (a name to look
        // up), never the message/payload you intend to SEND. So allow a short query, but
        // refuse to dump the command (echo) or a whole message into search — that belongs
        // in the compose field. (Previously this blocked ALL typing into search, which
        // also killed the legitimate contact lookup → the search-never-runs → loop bug.)
        if (searchField && (messaging || copyPaste) && (echo || goalWords(a.text).length >= 6 || String(a.text || "").length > 40)) {
          console.warn(`[lazy-ai] control: blocked non-query ui_type into search field "${el.name}"`);
          continue;
        }
        // Guard 3 — anti-regurgitation at the DESTINATION (the "it sends the prompt I
        // requested" bug). The model can't see the copied payload, so it sometimes types
        // the command into the compose field. Replace that with a PASTE of the real
        // clipboard, into THIS same field — but only for a genuine destination, never a
        // search box (a payload must never be pasted into search; that case is dropped above).
        if (echo && !searchField) {
          console.warn(`[lazy-ai] control: goal-echo ui_type into "${el.name}" → focus + paste (ctrl+v)`);
          resolved.push({ type: "uia", verb: "click", x: cx, y: cy }); // focus the field
          resolved.push({ type: "press", send: "^v" }); // paste copied data at its destination
          continue;
        }
      }
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
  // Each "launch" may poll up to ~9s for the window to appear (Wait-ForAppWindow) PLUS up
  // to ~12s for a cold/heavy app (Word) to become responsive (Wait-WindowReady), so budget
  // ~22s per launch on top of the plan's own waits — else execFile kills the batch mid-launch.
  const launches = actions.filter((a) => a.type === "launch").length;
  return Math.min(75000, 8000 + waits + launches * 22000 + actions.length * 500);
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
    //
    // Two per-turn PowerShell savings on later turns of the SAME window:
    //  • known browser  → skip the UIA query entirely (it returns [] for browsers
    //    anyway, but still pays a process cold-start).
    //  • already-woke desktop app → pass skipWake so uia-query.ps1 omits its 700ms
    //    a11y-wake sleep (the tree stays awake for the session once touched).
    // Any plan with a `launch` clears these (the foreground app may have changed).
    const sameTarget = !!controlTargetHwnd && controlTargetHwnd === controlWokeHwnd;
    const skipQuery = !!controlTargetHwnd && controlTargetHwnd === controlBrowserHwnd;
    const uiQuery = skipQuery
      ? Promise.resolve({ hwnd: controlTargetHwnd, elements: [], browser: true })
      : winAutomation.queryUiElements(overlayHwnd(), controlTargetHwnd, 80, sameTarget);
    const [s, ui] = await Promise.all([
      useExistingShot && lastScreenshot ? Promise.resolve(lastScreenshot) : captureScreen(maxEdgeForModel(controlModel()), maxPixelsForModel(controlModel()), "jpeg"),
      uiQuery,
    ]);
    shot = s;
    lastScreenshot = shot;
    controlElements = ui.elements || [];
    if (ui.hwnd) {
      controlTargetHwnd = ui.hwnd; // track the resolved target window
      controlWokeHwnd = ui.hwnd; // its a11y tree has now been queried/woken this session
      if (ui.browser) controlBrowserHwnd = ui.hwnd; // remember browsers → skip next turn
      else if (controlBrowserHwnd === ui.hwnd) controlBrowserHwnd = 0; // no longer a browser
    }
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
    // Only auto-finish (which HIDES the overlay) when the model EXPLICITLY said done in
    // a reply we actually parsed. A parse/truncation failure (parsed:false) used to
    // default done:true here and silently hide the overlay — the "opened the app, then
    // nothing happened and the bar disappeared" symptom. Instead re-plan a couple of
    // times on an unparseable reply, then leave the overlay up rather than vanishing.
    if (plan.parsed && plan.explicitDone) {
      finishControl();
    } else if (!plan.parsed && controlActive && controlRetries < 2) {
      controlRetries += 1;
      sendOverlayStatus("Re-reading the screen…", "loading");
      setTimeout(() => { if (controlActive) controlTurn({ useExistingShot: false }); }, 500);
    } else {
      stopControl(); // genuine "can't proceed", or retries exhausted — leave overlay up
    }
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
    } else if (a.type === "drag" || a.type === "selecttext") {
      // Endpoints are screenshot pixels = canvas space; show the stroke + its end.
      draw.push({ shape: "line", from: [Math.round(a.x1), Math.round(a.y1)], to: [Math.round(a.x2), Math.round(a.y2)] });
      draw.push({ shape: "circle", x: Math.round(a.x2), y: Math.round(a.y2), r, label: a.type === "selecttext" ? "select" : "drag" });
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
  // SYSTEMIC FOCUS FIX. Does this batch move the mouse (click / drag / scroll / select /
  // UIA click)? If so, the overlay MUST be off-screen while the batch runs. The overlay is
  // a full-screen, always-on-top, click-through window; a synthetic click "through" it does
  // NOT cleanly re-activate the window beneath — Windows lets activation fall through to the
  // DESKTOP, so the target app drops to the background the instant any mouse action fires.
  // That is the cross-app "every app exits on click/drag" bug (Chrome, UWP Clock, Win32
  // Paint all failed identically; in the log, top-of-batch focusOk=True, then the click →
  // `target now 132122` = the desktop). Keyboard batches are immune (SendKeys posts to the
  // focused window — that's why launch/type/press tasks always passed), so we only pay the
  // hide/restore cost on mouse batches: fully HIDE the overlay (not just blur) for the
  // duration, then bring it back with showInactive() so it never steals the app's focus.
  const hasPointer = resolved.some((a) =>
    ["click", "doubleclick", "rightclick", "scroll", "drag", "selecttext", "uia"].includes(a.type)
  );
  controlTimer = setTimeout(async () => {
    controlTimer = null;
    if (!controlActive) return;
    if (hasPointer) {
      try { overlayWindow.hide(); } catch {} // remove the topmost click-through window so clicks activate the target
    } else {
      // Keyboard-only batch: blurring hands the foreground to the app beneath; control-batch
      // then force-focuses + verifies the real target before each keystroke anyway.
      try { overlayWindow.blur(); } catch {}
    }
    await delay(120);
    if (!controlActive) return;
    let failed = null;
    try {
      await winAutomation.performPlan(resolved, planTimeoutMs(plan.actions), targetHwnd, overlayHwnd());
    } catch (err) {
      failed = err;
    }
    // Bring the overlay back WITHOUT activating it (showInactive keeps the target app
    // foreground), restoring its always-on-top + click-through — needed before any re-plan
    // preview, error message, or finish.
    if (hasPointer && controlActive && overlayWindow) {
      try {
        overlayWindow.showInactive();
        overlayWindow.setAlwaysOnTop(true, "screen-saver");
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      } catch {}
    }
    if (!controlActive) return;
    if (failed) {
      const msg = String(failed.message || failed);
      // A focus/aim abort (couldn't prove the intended window was foreground, or a pointer
      // action landed on the desktop) is RECOVERABLE — re-capture and re-plan instead of
      // killing the session. Bounded so a truly unreachable target can't loop forever.
      if (msg.includes("FOCUS_ABORT") && controlRetries < 2) {
        controlRetries += 1;
        sendOverlayStatus("Re-aiming…", "loading");
        await delay(450);
        if (!controlActive) return;
        controlTurn({ useExistingShot: false });
        return;
      }
      sendOverlayStatus(`Action failed: ${msg}`, "err");
      stopControl();
      return;
    }
    controlRetries = 0; // a batch ran cleanly — clear the soft-failure budget
    if (plan.done) {
      finishControl(); // the batch completed the goal
      return;
    }
    await waitForScreenSettle(); // let the batch's effects render before re-planning
    if (!controlActive) return;
    // A launch may have changed which app is foreground — drop the cached woke/browser
    // window so the next turn re-detects (re-wakes / re-checks) instead of trusting it.
    if (plan.actions.some((a) => a.type === "launch")) { controlWokeHwnd = 0; controlBrowserHwnd = 0; }
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

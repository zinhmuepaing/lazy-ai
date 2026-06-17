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
const voiceEngine = require("./voice-engine");

// Screen Teacher summon hotkeys, in preference order (separate from the polish
// summon key). Stage 4.
const SCREEN_TEACHER_CANDIDATES = [
  "CommandOrControl+Shift+S",
  "CommandOrControl+Alt+S",
  "CommandOrControl+Shift+G",
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
let sourceHwnd = null; // window the selection came from, to paste back into
let lastScreenshot = null; // { base64, mediaType, width, height } for Screen Teacher

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
  return {
    ...pub,
    models: modelsForUI(),
    engineDefaultModel: DEFAULT_MODEL,
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

// Screen Teacher: answer a question about the screenshot main captured.
ipcMain.handle("screen-ask", async (_event, question) => {
  if (!lastScreenshot) return { ok: false, error: "No screenshot captured. Press the Screen Teacher hotkey again." };
  return screenTeacher.askAboutScreen({
    imageBase64: lastScreenshot.base64,
    mediaType: lastScreenshot.mediaType,
    question,
    imageWidth: lastScreenshot.width,
    imageHeight: lastScreenshot.height,
  });
});

ipcMain.on("hide-overlay", () => overlayWindow?.hide());

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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open Lazy AI  (${hotkeyLabel})`, click: () => showPopup() },
      { label: `Ask about my screen  (${screenLabel})`, click: () => showScreenTeacher() },
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

// ---------------------------------------------------------------------------
// Screen Teacher (Stage 4): screenshot → ask Claude → draw answer on a
// transparent click-safe overlay.
// ---------------------------------------------------------------------------

// Capture the primary display at full physical resolution so the AI's
// pixel coordinates line up with what's on screen.
async function captureScreen() {
  const display = screen.getPrimaryDisplay();
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

  // Cap the long edge to the active model's high-res vision limit, so the model
  // isn't silently downscaling the image (which throws its coordinates off).
  // The overlay sizes its canvas to these dimensions, so coordinates stay 1:1.
  const MAX_LONG_EDGE = screenTeacher.MAX_IMAGE_LONG_EDGE;
  const longEdge = Math.max(size.width, size.height);
  if (longEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / longEdge;
    image = image.resize({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
    });
    size = image.getSize();
  }

  return {
    base64: image.toPNG().toString("base64"),
    mediaType: "image/png",
    width: size.width,
    height: size.height,
  };
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    ...display.bounds, // x, y, width, height of the primary display
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
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  overlayWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      overlayWindow.hide();
    }
  });
}

async function showScreenTeacher() {
  // Toggle off if already up.
  if (overlayWindow && overlayWindow.isVisible()) {
    overlayWindow.hide();
    return;
  }
  // Get our own windows out of the shot before capturing.
  if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
  if (overlayWindow && overlayWindow.isVisible()) overlayWindow.hide();
  await delay(150);

  try {
    lastScreenshot = await captureScreen();
  } catch (err) {
    console.error(`[lazy-ai] Screenshot failed: ${err.message}`);
    return;
  }

  if (!overlayWindow) createOverlayWindow();
  overlayWindow.setBounds(screen.getPrimaryDisplay().bounds);
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send("overlay-show", {
    imageWidth: lastScreenshot.width,
    imageHeight: lastScreenshot.height,
  });
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
  createTray();
}

app.on("will-quit", () => globalShortcut.unregisterAll());

// The app is a tray resident: closing the popup must NOT quit it. (With
// hide-on-close above this rarely fires, but we keep it alive regardless.)
app.on("window-all-closed", () => {});

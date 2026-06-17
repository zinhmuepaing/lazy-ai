// Lazy AI — Electron main process.
//
// Holds the API keys (from .env) and owns the shared polish engine. Exposes it
// two ways:
//   1. IPC, for the desktop window (preload.js bridges it to the UI).
//   2. A local HTTP server on localhost:8788, for the browser extension.

const path = require("node:path");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");

// Load .env from the project root (one level up from src/).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { MODELS, DEFAULT_MODEL, polish, extractTextFromFile } = require("./polish-engine");
const { startLocalServer } = require("./local-server");

// ---------------------------------------------------------------------------
// IPC handlers (called from the renderer via window.lazyAI.*)
// ---------------------------------------------------------------------------
ipcMain.handle("get-models", () => {
  // Send only id + label to the UI — provider/apiModel stay internal.
  const models = Object.fromEntries(
    Object.entries(MODELS).map(([id, info]) => [id, { label: info.label }])
  );
  return { models, defaultModel: DEFAULT_MODEL };
});

ipcMain.handle("pick-file", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
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

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 760,
    height: 820,
    title: "Lazy AI",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  startLocalServer(); // serve localhost:8788 for the browser extension
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

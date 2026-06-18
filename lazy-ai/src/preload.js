// Safe bridge between the renderer (UI) and the main process.
// Only these specific functions are exposed to the web page — the renderer
// never gets direct access to Node, the filesystem, or the API keys.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lazyAI", {
  getModels: () => ipcRenderer.invoke("get-models"),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  polish: (payload) => ipcRenderer.invoke("polish", payload),

  // Stage 3 (summon popup):
  hideWindow: () => ipcRenderer.send("hide-window"),
  // Fires each time the popup is summoned. `data.selectionText` holds any text
  // grabbed from the app the user was in, so the UI can prefill + focus.
  onShow: (callback) => ipcRenderer.on("popup-shown", (_event, data) => callback(data || {})),
  // Send the accepted result back to be pasted into the source app.
  pasteResult: (text) => ipcRenderer.send("paste-result", text),

  // Settings panel:
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (payload) => ipcRenderer.invoke("save-settings", payload),
  // Fires when settings change, so the popup can refresh its model dropdown.
  onSettingsUpdated: (callback) => ipcRenderer.on("settings-updated", () => callback()),

  // Screen Teacher overlay (Stage 4):
  // Fires when the overlay is summoned; data carries the screenshot pixel size.
  onOverlayShow: (callback) => ipcRenderer.on("overlay-show", (_event, data) => callback(data || {})),
  // Ask Claude about the screenshot main captured; returns { ok, instructions, explanation }.
  askScreen: (question) => ipcRenderer.invoke("screen-ask", question),
  hideOverlay: () => ipcRenderer.send("hide-overlay"),
  // Toggle the overlay's click-through: pass true to let clicks fall through to
  // the app underneath (annotations don't trap the cursor); false while the
  // pointer is over the control bar so its buttons/input stay usable.
  setIgnoreMouse: (ignore) => ipcRenderer.send("overlay-set-ignore-mouse", ignore),
  // Transcribe 16 kHz mono PCM (Float32Array) locally via Whisper → { ok, text }.
  transcribe: (audio) => ipcRenderer.invoke("transcribe", audio),
});

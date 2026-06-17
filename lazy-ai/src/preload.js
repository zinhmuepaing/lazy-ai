// Safe bridge between the renderer (UI) and the main process.
// Only these specific functions are exposed to the web page — the renderer
// never gets direct access to Node, the filesystem, or the API keys.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lazyAI", {
  getModels: () => ipcRenderer.invoke("get-models"),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  polish: (payload) => ipcRenderer.invoke("polish", payload),
});

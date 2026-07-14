// Bridges launcher progress events from the main process to the splash renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("splashApi", {
  onProgress: (cb) => ipcRenderer.on("progress", (_e, payload) => cb(payload)),
});

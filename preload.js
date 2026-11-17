const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("edubase", {
  startDownload: (config) => ipcRenderer.invoke("start-download", config),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  openFolder: (path) => ipcRenderer.invoke("open-folder", path),
  getDownloadsPath: () => ipcRenderer.invoke("get-downloads-path"),
  onProgress: (cb) => ipcRenderer.on("progress", (_, data) => cb(data)),
});

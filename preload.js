const { contextBridge, ipcRenderer } = require("electron");

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("app", {
  status: () => call("status"),
  login: () => call("login"),
  logout: () => call("logout"),
  library: () => call("library"),
  opened: (id) => ipcRenderer.invoke("opened", id),
  download: (book) => call("download", book),
  cancel: () => ipcRenderer.invoke("cancel"),
  settings: () => ipcRenderer.invoke("settings"),
  setLang: (lang) => ipcRenderer.invoke("set-lang", lang),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openPdf: () => ipcRenderer.invoke("open-pdf"),
  revealPdf: () => ipcRenderer.invoke("reveal-pdf"),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, p) => cb(p)),
});

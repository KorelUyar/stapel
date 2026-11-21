const { contextBridge, ipcRenderer } = require("electron");

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("app", {
  platform: process.platform,
  status: () => call("status"),
  login: () => call("login"),
  logout: () => call("logout"),
  library: () => call("library"),
  opened: (id) => ipcRenderer.invoke("opened", id),
  marks: () => ipcRenderer.invoke("marks"),
  shelf: () => ipcRenderer.invoke("shelf"),
  saveShelf: (shelf) => ipcRenderer.invoke("save-shelf", shelf),
  download: (book) => call("download", book),
  downloadMany: (books, options) => call("download-many", books, options),
  cancel: () => ipcRenderer.invoke("cancel"),
  settings: () => ipcRenderer.invoke("settings"),
  setLang: (lang) => ipcRenderer.invoke("set-lang", lang),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openPdf: () => ipcRenderer.invoke("open-pdf"),
  revealPdf: () => ipcRenderer.invoke("reveal-pdf"),
  openFolder: () => ipcRenderer.invoke("open-folder"),
  openBookPdf: (id) => ipcRenderer.invoke("open-book-pdf", id),
  reader: (name, arg) => ipcRenderer.invoke("reader-cmd", name, arg),
  notes: (id) => ipcRenderer.invoke("notes", id),
  bookmark: (id, page) => ipcRenderer.invoke("bookmark", id, page),
  setClassic: (on, persist) => ipcRenderer.invoke("set-classic", on, persist),
  onReader: (cb) => ipcRenderer.on("reader", (_e, type, data) => cb(type, data)),
  updateState: () => ipcRenderer.invoke("update-state"),
  updateStart: () => call("update-start"),
  updatePage: () => ipcRenderer.invoke("update-page"),
  onUpdate: (cb) => ipcRenderer.on("update", (_e, data) => cb(data)),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, p) => cb(p)),
});

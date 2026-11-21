// Runs in the reader <webview> next to edubase's page. The only thing it gives that page is a
// way to tell the app what is on screen (reader/inject.js uses it). The app treats everything
// that arrives here as untrusted.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__stapelHost", {
  post: (type, data) => ipcRenderer.send("reader-event", String(type), data),
});

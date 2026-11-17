const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require("electron");
const fs = require("fs");
const path = require("path");
const edubase = require("./edubase");

let win;
let job = null; // { token } while a download runs

// ---------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

const outputDir = () => readSettings().outputDir || app.getPath("downloads");

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1a19" : "#f5f3ef",
    title: "Edubase Downloader",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

// ---------------------------------------------------------------- IPC

const wrap = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

ipcMain.handle("status", wrap(() => edubase.status()));
ipcMain.handle("login", wrap(() => edubase.login(win)));
ipcMain.handle("logout", wrap(() => edubase.logout()));
ipcMain.handle("library", wrap(() => edubase.library()));

ipcMain.handle(
  "download",
  wrap(async (book) => {
    if (job) throw new Error("Es läuft schon ein Download.");
    job = { token: { cancelled: false } };
    try {
      const send = (p) => win && !win.isDestroyed() && win.webContents.send("progress", p);
      return await edubase.download({ ...book, outputDir: outputDir() }, send, job.token);
    } finally {
      job = null;
    }
  }),
);

ipcMain.handle("cancel", () => {
  if (job) job.token.cancelled = true;
});

ipcMain.handle("settings", () => ({ outputDir: outputDir(), downloads: app.getPath("downloads") }));

ipcMain.handle("choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: outputDir(),
    buttonLabel: "Hier speichern",
  });
  if (r.canceled) return outputDir();
  writeSettings({ outputDir: r.filePaths[0] });
  return r.filePaths[0];
});

ipcMain.handle("open-file", (_e, p) => shell.openPath(p));
ipcMain.handle("reveal", (_e, p) => shell.showItemInFolder(p));

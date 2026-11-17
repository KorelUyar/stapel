const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const edubase = require("./edubase");

const EDUBASE = "https://app.edubase.ch/";

let win;
let job = null; // { token } while a PDF is being saved
let lastPdf = null; // the PDF saved last; the only file "Open" and "Show in Finder" act on

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

const isMac = process.platform === "darwin";
const colors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: "#1b1a19", symbols: "#f1eee8" }
    : { background: "#f5f3ef", symbols: "#1d1c1a" };

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    // macOS: the traffic lights sit in the app's own title bar. Windows: the app draws the
    // bar too, and the system adds minimise, maximise and close on the right.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 20 } }
      : { titleBarOverlay: { color: colors().background, symbolColor: colors().symbols, height: 60 } }),
    backgroundColor: colors().background,
    title: "Stapel",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  if (!isMac) {
    nativeTheme.on("updated", () => {
      if (win && !win.isDestroyed()) {
        const c = colors();
        win.setTitleBarOverlay({ color: c.background, symbolColor: c.symbols, height: 60 });
        win.setBackgroundColor(c.background);
      }
    });
  }
  // One window app: closing it quits (the hidden edubase window must not keep it alive).
  win.on("closed", () => app.quit());
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  // The page itself never navigates away from the app's own files.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

// The reader is a <webview> showing edubase. Lock it down: edubase only, the app's own
// session, no preload, no Node.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (params.partition !== "persist:edubase") e.preventDefault();
    if (params.src !== "about:blank" && !params.src.startsWith(EDUBASE)) e.preventDefault();
  });
  if (contents.getType() === "webview") {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) shell.openExternal(url);
      return { action: "deny" };
    });
    // The reader has no address bar, so it stays on edubase. Links elsewhere open in the browser.
    const keepOnEdubase = (e, url, isMainFrame) => {
      if (isMainFrame === false || url.startsWith(EDUBASE) || url === "about:blank") return;
      e.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    };
    contents.on("will-navigate", (e) => keepOnEdubase(e, e.url, e.isMainFrame));
    contents.on("will-redirect", (e) => keepOnEdubase(e, e.url, e.isMainFrame));
  }
});

app.whenReady().then(() => {
  // Windows and Linux get no menu bar; copy, paste and the rest work without it there.
  if (!isMac) Menu.setApplicationMenu(null);
  edubase.init();
  createWindow();
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
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
ipcMain.handle("login", wrap(() => edubase.login(win, readSettings().lang)));
ipcMain.handle("logout", wrap(() => edubase.logout()));

ipcMain.handle(
  "library",
  wrap(async () => {
    const recent = readSettings().recent || {};
    const books = await edubase.library();
    // Most recently opened first, the rest in edubase's order.
    return books
      .map((b, i) => ({ ...b, i, seen: recent[b.id] || 0 }))
      .sort((a, b) => b.seen - a.seen || a.i - b.i);
  }),
);

ipcMain.handle("opened", (_e, id) => {
  const recent = readSettings().recent || {};
  recent[String(id)] = Date.now();
  writeSettings({ recent });
});

ipcMain.handle(
  "download",
  wrap(async (book) => {
    if (job) throw new Error("busy");
    job = { token: { cancelled: false } };
    try {
      const send = (p) => win && !win.isDestroyed() && win.webContents.send("progress", p);
      const result = await edubase.download({ ...book, outputDir: outputDir() }, send, job.token);
      lastPdf = result.path;
      return result;
    } finally {
      job = null;
    }
  }),
);

ipcMain.handle("cancel", () => {
  if (job) job.token.cancelled = true;
});

ipcMain.handle("settings", () => {
  const s = readSettings();
  return { outputDir: outputDir(), downloads: app.getPath("downloads"), lang: s.lang || "en" };
});

ipcMain.handle("set-lang", (_e, lang) => {
  writeSettings({ lang: lang === "de" ? "de" : "en" });
});

ipcMain.handle("choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: outputDir(),
  });
  if (r.canceled) return outputDir();
  writeSettings({ outputDir: r.filePaths[0] });
  return r.filePaths[0];
});

ipcMain.handle("open-pdf", () => lastPdf && shell.openPath(lastPdf));
ipcMain.handle("reveal-pdf", () => lastPdf && shell.showItemInFolder(lastPdf));

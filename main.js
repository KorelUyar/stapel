const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const edubase = require("./edubase");
const reader = require("./reader");

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

// Folders are the user's own way to sort the library; edubase knows nothing about them.
const FOLDER_COLORS = ["#1f6e59", "#e3a92b", "#e0654a", "#3d5a80", "#8a5a44", "#2f7f9a", "#5b4b8a", "#b84a62", "#6b7a3a", "#5c5a56"];
const isBookId = (id) => typeof id === "string" && /^\d{1,12}$/.test(id);

function cleanShelf(input) {
  const folders = [];
  const seen = new Set();
  for (const f of Array.isArray(input?.folders) ? input.folders.slice(0, 200) : []) {
    if (!f || typeof f.id !== "string" || !/^[\w-]{1,24}$/.test(f.id) || seen.has(f.id)) continue;
    const name = typeof f.name === "string" ? f.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    if (!name) continue;
    seen.add(f.id);
    folders.push({ id: f.id, name, color: FOLDER_COLORS.includes(f.color) ? f.color : FOLDER_COLORS[0] });
  }
  const shelf = {};
  for (const [book, folder] of Object.entries(input?.shelf && typeof input.shelf === "object" ? input.shelf : {}).slice(0, 5000)) {
    if (isBookId(book) && seen.has(folder)) shelf[book] = folder;
  }
  return { folders, shelf, sort: input?.sort === "title" ? "title" : "recent" };
}

const readShelf = () => cleanShelf(readSettings());

// Where each book was last read. Written a moment after the page changes, and when the app quits.
let progress = null;
let progressTimer = null;
const getProgress = () => (progress ??= { ...(readSettings().progress || {}) });
function flushProgress() {
  clearTimeout(progressTimer);
  progressTimer = null;
  if (progress) writeSettings({ progress });
}
function noteProgress(state) {
  if (!state.ready || !isBookId(state.id) || !/^\d+$/.test(state.page || "")) return;
  const p = getProgress();
  if (p[state.id]?.page === +state.page && p[state.id]?.total === state.total) return;
  p[state.id] = { page: +state.page, total: state.total };
  progressTimer ??= setTimeout(flushProgress, 1500);
}

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
// session, no Node, and no preload but the app's own small bridge (reader-preload.js).
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e, prefs, params) => {
    prefs.preload = path.join(__dirname, "reader-preload.js");
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (params.partition !== "persist:edubase") e.preventDefault();
    if (params.src !== "about:blank" && !params.src.startsWith(EDUBASE)) e.preventDefault();
  });
  if (contents.getType() === "webview") {
    reader.attach(contents);
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
  reader.setClassic(readSettings().classic === true);
  reader.onNotify((type, data) => {
    if (type === "state") noteProgress(data);
    if (win && !win.isDestroyed()) win.webContents.send("reader", type, data);
  });
  createWindow();
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", flushProgress);

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
    const settings = readSettings();
    const recent = settings.recent || {};
    const pdfs = settings.pdfs || {};
    const notes = reader.counts();
    const books = await edubase.library();
    // Edubase's order is kept in `i`; the interface sorts.
    return books.map((b, i) => ({
      ...b,
      i,
      seen: recent[b.id] || 0,
      progress: getProgress()[b.id] || null,
      pdf: typeof pdfs[b.id] === "string" && fs.existsSync(pdfs[b.id]),
      notes: notes[b.id] || 0,
    }));
  }),
);

// What the app itself knows about the books (no trip to edubase): where each was last read,
// which have notes, which have a saved PDF.
ipcMain.handle("marks", () => {
  const pdfs = readSettings().pdfs || {};
  const saved = {};
  for (const [id, file] of Object.entries(pdfs)) if (typeof file === "string" && fs.existsSync(file)) saved[id] = true;
  return { progress: getProgress(), notes: reader.counts(), pdfs: saved };
});

ipcMain.handle("opened", (_e, id) => {
  if (!isBookId(String(id))) return;
  const recent = readSettings().recent || {};
  recent[String(id)] = Date.now();
  writeSettings({ recent });
});

ipcMain.handle("shelf", () => readShelf());
ipcMain.handle("save-shelf", (_e, input) => {
  const next = cleanShelf(input);
  writeSettings(next);
  return next;
});

// ---------------------------------------------------------------- IPC: saving PDFs

const sendProgress = (p) => win && !win.isDestroyed() && win.webContents.send("progress", p);

function rememberPdf(id, file) {
  const pdfs = readSettings().pdfs || {};
  pdfs[id] = file;
  writeSettings({ pdfs });
}

// One book. `book` comes from the interface: only the expected fields are passed on.
function saveBook(book, dir, onProgress, token) {
  const whole = !book.from && !book.to;
  return edubase
    .download(
      {
        id: String(book.id),
        title: typeof book.title === "string" ? book.title.slice(0, 300) : "",
        from: Number.isInteger(book.from) ? book.from : undefined,
        to: Number.isInteger(book.to) ? book.to : undefined,
        outputDir: dir,
        ink: book.notes === false ? null : reader.load(String(book.id)).pages,
        inkAssets: { js: reader.INK_JS, css: reader.INK_CSS },
      },
      onProgress,
      token,
    )
    .then((result) => {
      if (whole) rememberPdf(String(book.id), result.path);
      return result;
    });
}

ipcMain.handle(
  "download",
  wrap(async (book) => {
    if (job) throw new Error("busy");
    if (!book || !isBookId(String(book.id))) throw new Error("noaccess");
    job = { token: { cancelled: false } };
    try {
      const result = await saveBook(book, outputDir(), sendProgress, job.token);
      lastPdf = result.path;
      return result;
    } finally {
      job = null;
    }
  }),
);

// Several books, one after the other. A book that fails does not stop the rest.
ipcMain.handle(
  "download-many",
  wrap(async (books, options) => {
    if (job) throw new Error("busy");
    const list = (Array.isArray(books) ? books : []).filter((b) => b && isBookId(String(b.id))).slice(0, 500);
    if (!list.length) return [];
    job = { token: { cancelled: false } };
    const { folders, shelf } = readShelf();
    const results = [];
    try {
      for (let index = 0; index < list.length; index++) {
        const book = list[index];
        const id = String(book.id);
        const batch = { index, count: list.length, id };
        if (job.token.cancelled) {
          results.push({ id, ok: false, error: "cancelled" });
          continue;
        }
        const folder = options?.byFolder ? folders.find((f) => f.id === shelf[id]) : null;
        const dir = folder ? path.join(outputDir(), edubase.safeName(folder.name, "Stapel")) : outputDir();
        sendProgress({ batch, phase: "open" });
        let result;
        try {
          const r = await saveBook({ id, title: book.title, notes: options?.notes !== false }, dir, (p) => sendProgress({ ...p, batch }), job.token);
          result = { id, ok: true, pages: r.pages, path: r.path };
          lastPdf = r.path;
        } catch (err) {
          result = { id, ok: false, error: err.message };
        }
        results.push(result);
        sendProgress({ batch, phase: "book", result: { id, ok: result.ok, pages: result.pages, error: result.error } });
      }
      return results.map((r) => ({ id: r.id, ok: r.ok, pages: r.pages, error: r.error }));
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
  return { outputDir: outputDir(), downloads: app.getPath("downloads"), lang: s.lang || "en", classic: s.classic === true, folderColors: FOLDER_COLORS };
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
ipcMain.handle("open-folder", () => shell.openPath(outputDir()));
// The PDF saved earlier for a book (the library shows a mark on those).
ipcMain.handle("open-book-pdf", (_e, id) => {
  const file = (readSettings().pdfs || {})[String(id)];
  return typeof file === "string" && fs.existsSync(file) ? shell.openPath(file).then(() => true) : false;
});

// ---------------------------------------------------------------- IPC: reader

// What edubase's page tells the app. Only the reader's own page may speak here.
ipcMain.on("reader-event", (e, type, data) => {
  if (e.sender.getType() !== "webview" || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return;
  if (!e.senderFrame.url.startsWith(EDUBASE)) return;
  reader.onEvent(type, data);
});

ipcMain.handle("reader-cmd", (_e, name, arg) => reader.cmd(String(name), arg));
ipcMain.handle("notes", (_e, id) => reader.summary(String(id)));
ipcMain.handle("bookmark", (_e, id, page) => reader.toggleBookmark(String(id), String(page)));
// persist false: only until the app is closed (a book the app's reader cannot show).
ipcMain.handle("set-classic", (_e, on, persist) => {
  if (persist !== false) writeSettings({ classic: on === true });
  reader.setClassic(on === true);
});

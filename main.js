const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Menu, clipboard, ClipboardItem } = require("electron");
const fs = require("fs");
const path = require("path");
const edubase = require("./edubase");
const reader = require("./reader");
const update = require("./update");

const EDUBASE = "https://app.edubase.ch/";

let win;
let job = null; // { token } while a PDF is being saved
let lastPdf = null; // the PDF saved last; the only file "Open" and "Show in Finder" act on
let newVersion = null; // { latest, current } once GitHub has a newer release
let updating = null; // { token } while an update is downloaded and installed

// ---------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

// Only a missing file means "no settings yet". A file a virus scanner holds for a moment is
// read as it was last time, and not written over while nothing is known about it; a file that
// is not JSON is put aside and starts again.
let lastSettings = null;
function readSettings() {
  try {
    const d = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    lastSettings = d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch (err) {
    if (err.code === "ENOENT") lastSettings = {};
    else if (err instanceof SyntaxError) {
      try {
        fs.renameSync(settingsFile(), `${settingsFile()}.broken-${Date.now()}`);
      } catch {}
      lastSettings = {};
    }
  }
  return { ...(lastSettings || {}) };
}

// Written to a second file first and then swapped in, so a crash in the middle of a write
// cannot leave half a file (folders and reading positions live here).
function writeSettings(patch) {
  const current = readSettings();
  if (lastSettings === null) return { ...current, ...patch }; // unreadable: not written over
  const next = { ...current, ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const tmp = settingsFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, settingsFile());
  } catch {
    // A full or read-only disk must not take the app down; the setting is lost, nothing else.
  }
  return next;
}

const outputDir = () => readSettings().outputDir || app.getPath("downloads");

// A JSON file written to a second file first and then swapped in.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- the notes folder

// Notes, bookmarks, folders and reading positions can live in a folder the user chooses
// (iCloud Drive, OneDrive, a USB stick). Then every computer that uses the same folder has
// them, and they outlive this computer. What belongs to this computer (where PDFs go, the
// language) stays in settings.json.
const SHARED = ["folders", "shelf", "sort", "progress", "recent"];
const LIBRARY = "library.json";
let data = { dir: null, reachable: true };

const chosenDir = () => {
  const d = readSettings().dataDir;
  return typeof d === "string" && path.isAbsolute(d) ? d : null;
};
const iCloudDrive = () => path.join(app.getPath("home"), "Library", "Mobile Documents", "com~apple~CloudDocs");
// Windows names the user's OneDrive folder in an environment variable.
const oneDrive = () => (!isMac && process.env.OneDrive && path.isAbsolute(process.env.OneDrive) && fs.existsSync(process.env.OneDrive) ? process.env.OneDrive : null);
const hasStapelData = (dir) => fs.existsSync(path.join(dir, LIBRARY));

// The same folder, whatever way it is written (links, upper and lower case on Mac and Windows).
function realPath(p) {
  let real;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    real = path.resolve(p);
  }
  return process.platform === "linux" ? real : real.toLowerCase();
}
const inside = (child, parent) => {
  const c = realPath(child);
  const p = realPath(parent);
  return c === p || c.startsWith(p + path.sep);
};

// A folder that is gone (a USB stick that is not plugged in) cannot hold notes: until it is
// back, they are kept on this computer. A folder whose parent is there is made again.
function reach(dir) {
  try {
    if (fs.statSync(dir).isDirectory()) return true;
  } catch {}
  try {
    if (fs.statSync(path.dirname(dir)).isDirectory()) {
      fs.mkdirSync(dir);
      return true;
    }
  } catch {}
  return false;
}

const libraryFile = () => (data.dir && data.reachable ? path.join(data.dir, LIBRARY) : null);

// {} when there is no file yet. A file that is there but cannot be read now (not downloaded
// yet, held by another program) throws: it must not be taken for an empty library and
// written over. A file that is not JSON is put aside (what is in it is kept there) and gives
// null.
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && !reader.inCloud(file)) return {};
    throw new Error("notesunavailable");
  }
  try {
    const d = JSON.parse(text);
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch {
    try {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    } catch {}
    return null;
  }
}

const notice = (code) => win && !win.isDestroyed() && win.webContents.send("notice", code);
let lastShared = null; // the library as last read from the folder
let told = false;

// Folders and reading positions: from the notes folder when there is one, else settings.json.
// While the folder's library cannot be read, what was read before is shown.
function readShared() {
  const file = libraryFile();
  if (!file) return readSettings();
  try {
    const d = readJsonFile(file);
    if (d) lastShared = d;
  } catch {}
  return lastShared || {};
}

// Returns false when nothing was written: the library file is there but cannot be read now
// (the change is tried again with the next one), or the folder went away. Callers keep what
// they wanted to write until it went through.
function writeShared(patch) {
  const file = libraryFile();
  if (!file) {
    // The chosen folder cannot be reached: kept here, and carried into it when it is back.
    writeSettings(data.dir ? { ...patch, fallbackEdits: true } : patch);
    return true;
  }
  let base;
  try {
    base = readJsonFile(file);
  } catch {
    if (!told) notice("libraryunavailable");
    told = true;
    return false;
  }
  // Missing or put aside because it was broken: what was read before is the base, not nothing.
  const known = base && Object.keys(base).length ? base : lastShared || {};
  const next = { ...known, ...patch, v: 1 };
  try {
    writeJson(file, next);
  } catch {
    if (!told) notice("librarysave");
    told = true;
    return false;
  }
  lastShared = next;
  told = false;
  return true;
}

// A reading position: page, number of pages, and when (for two computers: the later wins).
const cleanPositions = (v) => {
  const out = {};
  for (const [id, p] of Object.entries(v && typeof v === "object" ? v : {})) {
    if (isBookId(id) && p && Number.isInteger(p.page) && p.page > 0) out[id] = { page: p.page, total: Number.isInteger(p.total) ? p.total : 0, at: typeof p.at === "number" ? p.at : 0 };
  }
  return out;
};
const later = (a, b) => {
  const out = { ...a };
  for (const [id, p] of Object.entries(b)) if (!out[id] || (p.at || 0) > (out[id].at || 0)) out[id] = p;
  return out;
};

// Two libraries in one: `into` wins where both say something about folders, folders with the
// same name become one, nothing is taken away; for reading positions the later one wins.
function mergeLibrary(into, from) {
  const a = cleanShelf(into);
  const b = cleanShelf(from);
  const folders = [...a.folders];
  const ids = new Set(folders.map((f) => f.id));
  const byName = new Map(folders.map((f) => [f.name.toLowerCase(), f.id]));
  const same = {};
  for (const f of b.folders) {
    if (ids.has(f.id)) continue;
    const twin = byName.get(f.name.toLowerCase());
    if (twin) {
      same[f.id] = twin;
      continue;
    }
    folders.push(f);
    ids.add(f.id);
  }
  const shelf = {};
  for (const [book, folder] of Object.entries(b.shelf)) shelf[book] = same[folder] || folder;
  Object.assign(shelf, a.shelf);
  const times = (v) => (v && typeof v === "object" ? v : {});
  const recent = { ...times(from.recent) };
  for (const [id, at] of Object.entries(times(into.recent))) if (typeof at === "number") recent[id] = Math.max(at, recent[id] || 0);
  return {
    ...cleanShelf({ folders, shelf, sort: into.sort || from.sort }),
    progress: later(cleanPositions(into.progress), cleanPositions(from.progress)),
    recent,
  };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// Once the folder holds them, the notes on this computer are put aside (not deleted), so they
// do not come back later.
function moveLocalNotesAside() {
  const local = path.join(app.getPath("userData"), "notes");
  if (!fs.existsSync(local)) return;
  fs.renameSync(local, path.join(app.getPath("userData"), `notes-moved-${Date.now()}`));
}

function applyDataDir() {
  const dir = chosenDir();
  data = { dir, reachable: !dir || reach(dir) };
  lastShared = null;
  told = false;
  progressMine = {};
  progressSeen = {};
  reader.setDataRoot(dir && data.reachable ? dir : null);
  if (!dir || !data.reachable) return;
  // What was written on this computer while the folder could not be reached (or before it
  // was chosen) goes into the folder now.
  if (fs.existsSync(path.join(app.getPath("userData"), "notes"))) {
    try {
      reader.mergeNotes(app.getPath("userData"), dir);
      moveLocalNotesAside();
    } catch {
      // Tried again at the next start.
    }
  }
  const s = readSettings();
  if (s.fallbackEdits) {
    try {
      const file = path.join(dir, LIBRARY);
      const theirs = readJsonFile(file) || {};
      writeJson(file, { ...theirs, ...mergeLibrary(theirs, pick(s, SHARED)), v: 1 });
      // Carried over: gone from here, so it does not come back another time.
      writeSettings({ ...Object.fromEntries(SHARED.map((k) => [k, undefined])), fallbackEdits: false });
    } catch {}
  }
}

function dataInfo() {
  const dir = data.dir;
  let name = null;
  if (dir) {
    const cloud = iCloudDrive();
    const one = oneDrive();
    if (isMac && (dir === cloud || dir.startsWith(cloud + path.sep))) name = ["iCloud Drive", ...path.relative(cloud, dir).split(path.sep).filter(Boolean)].join(" › ");
    else if (one && (dir === one || dir.startsWith(one + path.sep))) name = ["OneDrive", ...path.relative(one, dir).split(path.sep).filter(Boolean)].join(" › ");
    else name = dir.split(/[\\/]/).filter(Boolean).slice(-2).join(" › ");
  }
  return { dir, name, reachable: data.reachable };
}

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

const readShelf = () => cleanShelf(readShared());

// The window's folders against what is on disk now: only what the window changed since the
// state it started from (its last load or its last save, which it sends along) is applied,
// so another computer's changes in between stay.
function mergeShelf(base, mine, theirs) {
  const b = new Map(base.folders.map((f) => [f.id, f]));
  const m = new Map(mine.folders.map((f) => [f.id, f]));
  const t = new Set(theirs.folders.map((f) => f.id));
  const same = (x, y) => !!x && !!y && x.name === y.name && x.color === y.color;
  const folders = [];
  for (const f of theirs.folders) {
    if (b.has(f.id) && !m.has(f.id)) continue; // deleted here
    const mf = m.get(f.id);
    folders.push(mf && !same(mf, b.get(f.id)) ? mf : f); // renamed or recoloured here
  }
  for (const f of mine.folders) if (!b.has(f.id) && !t.has(f.id)) folders.push(f); // made here
  const shelf = { ...theirs.shelf };
  for (const book of new Set([...Object.keys(base.shelf), ...Object.keys(mine.shelf)])) {
    if (base.shelf[book] === mine.shelf[book]) continue;
    if (mine.shelf[book]) shelf[book] = mine.shelf[book];
    else delete shelf[book];
  }
  return cleanShelf({ folders, shelf, sort: mine.sort !== base.sort ? mine.sort : theirs.sort });
}

// Where each book was last read. Only the books read in this session are written (into what
// is on disk then), a moment after the page changes and when the app quits.
let progressMine = {};
let progressSeen = {}; // book id -> the position last known for it in this session
let progressTimer = null;
const getProgress = () => ({ ...cleanPositions(readShared().progress), ...progressMine });
function flushProgress() {
  clearTimeout(progressTimer);
  progressTimer = null;
  if (!Object.keys(progressMine).length) return;
  if (writeShared({ progress: later(cleanPositions(readShared().progress), progressMine) })) {
    progressMine = {};
  } else {
    progressTimer = setTimeout(flushProgress, 30000); // tried again
  }
}
function noteProgress(state) {
  if (!state.ready || !isBookId(state.id) || !/^\d+$/.test(state.page || "")) return;
  if (!(state.id in progressSeen)) progressSeen[state.id] = cleanPositions(readShared().progress)[state.id] || null;
  const had = progressSeen[state.id];
  if (had?.page === +state.page && had?.total === state.total) return;
  progressMine[state.id] = progressSeen[state.id] = { page: +state.page, total: state.total, at: Date.now() };
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

// One Stapel at a time: two would write the same settings and notes over each other.
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!single) return;
  // Windows and Linux get no menu bar; copy, paste and the rest work without it there.
  if (!isMac) Menu.setApplicationMenu(null);
  edubase.init();
  applyDataDir();
  reader.setClassic(readSettings().classic === true);
  reader.onNotify((type, info) => {
    if (type === "state") noteProgress(info);
    if (type === "toc") keepToc(info.id, info.items);
    if (win && !win.isDestroyed()) win.webContents.send("reader", type, info);
  });
  createWindow();
  // Only the installed app looks for updates; a copy run from the source does not.
  if (app.isPackaged && update.supported()) {
    setTimeout(lookForUpdate, 5000);
    setInterval(lookForUpdate, 6 * 60 * 60 * 1000).unref();
    setTimeout(() => !updating && update.cleanUp(app.getPath("temp")), 45000).unref();
  }
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  flushProgress();
  reader.writeAll();
});

// ---------------------------------------------------------------- IPC

const wrap = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

// The hidden edubase window does one thing at a time. Looking at the library waits for
// nothing but itself; a PDF job waits until a library load has finished; and while a PDF job
// runs, the library is not loaded and nobody is signed out.
let looking = Promise.resolve();
const look = (fn) => {
  if (job) throw new Error("busy");
  const run = looking.then(fn, fn);
  looking = run.catch(() => {});
  return run;
};

ipcMain.handle("status", wrap(() => look(() => edubase.status())));
ipcMain.handle("login", wrap(() => edubase.login(win, readSettings().lang)));
ipcMain.handle(
  "logout",
  wrap(async () => {
    if (job) throw new Error("busy");
    await looking;
    return edubase.logout();
  }),
);

ipcMain.handle(
  "library",
  wrap(async () => {
    const settings = readSettings();
    const recent = readShared().recent || {};
    const pdfs = settings.pdfs || {};
    const notes = reader.counts();
    const books = await look(() => edubase.library());
    const progress = getProgress();
    // Edubase's order is kept in `i`; the interface sorts.
    return books.map((b, i) => ({
      ...b,
      i,
      seen: recent[b.id] || 0,
      progress: progress[b.id] || null,
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
  const recent = readShared().recent || {};
  recent[String(id)] = Date.now();
  writeShared({ recent });
});

ipcMain.handle("shelf", () => readShelf());
// `written` false: the library cannot be read now; the window keeps its base, so its next
// save carries this change along.
ipcMain.handle("save-shelf", (_e, input, base) => {
  const mine = cleanShelf(input);
  const from = base ? cleanShelf(base) : { folders: [], shelf: {}, sort: mine.sort };
  return { written: writeShared(mergeShelf(from, mine, readShelf())) };
});

// ---------------------------------------------------------------- IPC: the notes folder

ipcMain.handle("data-dir", () => ({ ...dataInfo(), iCloud: isMac && fs.existsSync(iCloudDrive()), oneDrive: !!oneDrive() }));

// The user picks a folder. Notes and folders go there, added to what is there already (a
// second computer finds the first one's). iCloud Drive and OneDrive get a "Stapel" folder; a
// folder picked by hand gets one too, unless it is called Stapel or holds Stapel's library.
// `changed` is false when nothing changed (the dialog was closed); `carried` is false when the
// folder used so far could not be reached, so what is in it did not come along.
ipcMain.handle(
  "choose-data-dir",
  wrap(async (where) => {
    if (job || updating) throw new Error("busy");
    let target;
    if (where === "icloud" && isMac && fs.existsSync(iCloudDrive())) {
      target = path.join(iCloudDrive(), "Stapel");
    } else if (where === "onedrive" && oneDrive()) {
      target = path.join(oneDrive(), "Stapel");
    } else {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
        defaultPath: isMac && fs.existsSync(iCloudDrive()) ? iCloudDrive() : oneDrive() || app.getPath("documents"),
      });
      if (r.canceled || !r.filePaths[0]) return { ...dataInfo(), changed: false };
      const picked = r.filePaths[0];
      target = path.basename(picked) === "Stapel" || hasStapelData(picked) ? picked : path.join(picked, "Stapel");
    }
    const own = app.getPath("userData");
    if (inside(target, own) || inside(own, target)) throw new Error("ownfolder");
    if (data.dir && realPath(data.dir) === realPath(target)) return { ...dataInfo(), changed: false };
    flushProgress();
    const carried = !data.dir || data.reachable;
    const fromRoot = data.dir && data.reachable ? data.dir : own;
    try {
      // What is to come along has to be readable, or it would be left behind.
      const current = libraryFile() ? readJsonFile(libraryFile()) || lastShared || {} : readSettings();
      fs.mkdirSync(target, { recursive: true });
      reader.mergeNotes(fromRoot, target);
      const file = path.join(target, LIBRARY);
      const theirs = readJsonFile(file) || {};
      writeJson(file, { ...theirs, ...mergeLibrary(theirs, pick(current, SHARED)), v: 1 });
    } catch (err) {
      throw new Error(["notesunavailable", "notesnewer"].includes(err.message) ? err.message : "notesdisk");
    }
    // From here on the folder is the place: folders and positions leave settings.json (an old
    // copy there would come back after a day without the folder). The notes on this computer
    // are put aside by applyDataDir, after the setting is on disk.
    const gone = Object.fromEntries(SHARED.map((k) => [k, undefined]));
    writeSettings({ ...gone, dataDir: target, fallbackEdits: false });
    if (chosenDir() !== target) throw new Error("notesdisk");
    applyDataDir();
    return { ...dataInfo(), changed: true, carried };
  }),
);

// Back to this computer: what is in the folder comes along; the folder itself stays as it is
// (another computer may use it).
ipcMain.handle(
  "reset-data-dir",
  wrap(async () => {
    if (job || updating) throw new Error("busy");
    if (!data.dir) return { ...dataInfo(), changed: false };
    flushProgress();
    const carried = data.reachable;
    if (data.reachable) {
      try {
        reader.mergeNotes(data.dir, app.getPath("userData"));
        const theirs = readJsonFile(path.join(data.dir, LIBRARY)) || lastShared || {};
        writeSettings(mergeLibrary(theirs, pick(readSettings(), SHARED)));
      } catch (err) {
        throw new Error(["notesunavailable", "notesnewer"].includes(err.message) ? err.message : "notesdisk");
      }
    }
    writeSettings({ dataDir: null, fallbackEdits: false });
    if (chosenDir()) throw new Error("notesdisk");
    applyDataDir();
    return { ...dataInfo(), changed: true, carried };
  }),
);

ipcMain.handle("reveal-data-dir", () => data.dir && data.reachable && shell.openPath(data.dir));

// ---------------------------------------------------------------- IPC: tables of contents

// Kept from the reader and from saved PDFs, so the PDF sheet can offer chapters at once.
const tocFile = (id) => path.join(app.getPath("userData"), "toc", `${id}.json`);
function cachedToc(id) {
  try {
    return reader.cleanToc(JSON.parse(fs.readFileSync(tocFile(id), "utf8")));
  } catch {
    return null;
  }
}
function keepToc(id, items) {
  const clean = reader.cleanToc(items);
  if (!isBookId(String(id)) || !clean.length) return;
  try {
    writeJson(tocFile(String(id)), clean);
  } catch {}
}

// null: not known yet (and not looked up); []: the book has none.
ipcMain.handle(
  "toc",
  wrap(async (id, lookUp) => {
    id = String(id);
    if (!isBookId(id)) return [];
    const have = cachedToc(id);
    if (have || !lookUp) return have;
    if (job) throw new Error("busy");
    if (updating) throw new Error("updating");
    const items = reader.cleanToc(await look(() => edubase.toc(id, { js: reader.INK_JS + "\n" + reader.BOOK_JS })));
    keepToc(id, items);
    return items;
  }),
);

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
        part: !whole && typeof book.part === "string" ? book.part.replace(/\s+/g, " ").trim().slice(0, 120) : "",
        from: Number.isInteger(book.from) ? book.from : undefined,
        to: Number.isInteger(book.to) ? book.to : undefined,
        outputDir: dir,
        ink: book.notes === false ? null : reader.printable(String(book.id)),
        inkAssets: { js: reader.INK_JS + "\n" + reader.BOOK_JS, css: reader.INK_CSS },
      },
      onProgress,
      token,
    )
    .then((result) => {
      if (whole) rememberPdf(String(book.id), result.path);
      keepToc(String(book.id), result.toc);
      return { path: result.path, pages: result.pages };
    });
}

ipcMain.handle(
  "download",
  wrap(async (book) => {
    if (job) throw new Error("busy");
    if (updating) throw new Error("updating");
    if (!book || !isBookId(String(book.id))) throw new Error("noaccess");
    job = { token: { cancelled: false } };
    try {
      await looking;
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
    if (updating) throw new Error("updating");
    const list = (Array.isArray(books) ? books : []).filter((b) => b && isBookId(String(b.id))).slice(0, 500);
    if (!list.length) return [];
    job = { token: { cancelled: false } };
    const { folders, shelf } = readShelf();
    const results = [];
    try {
      await looking;
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

// ---------------------------------------------------------------- IPC: updates

const sendUpdate = (data) => win && !win.isDestroyed() && win.webContents.send("update", data);

// Asks GitHub for the newest release. Being offline is not an error here: it asks again later.
async function lookForUpdate() {
  try {
    const latest = await update.latestVersion();
    newVersion = update.newer(latest, app.getVersion()) ? { latest, current: app.getVersion() } : null;
  } catch {
    return newVersion;
  }
  if (!updating) sendUpdate(newVersion ? { available: true, ...newVersion } : { available: false });
  return newVersion;
}

ipcMain.handle("update-state", () => (newVersion ? { available: true, ...newVersion, busy: !!updating } : { available: false }));
ipcMain.handle("update-page", () => shell.openExternal(`${update.HOME}/releases/latest`));

// Download the new version, put it in place of this one, and start again.
ipcMain.handle(
  "update-start",
  wrap(async () => {
    if (!newVersion) throw new Error("download");
    if (job) throw new Error("busy");
    if (updating) return;
    update.ready(); // before 200 MB are downloaded for nothing
    updating = { token: { cancelled: false } };
    const { latest } = newVersion;
    try {
      const file = await update.download(latest, (part) => sendUpdate({ phase: "download", part }), updating.token);
      sendUpdate({ phase: "install" });
      // Text that is being written on a page is kept (a page that does not answer is not waited for).
      await Promise.race([reader.cmd("tool", {}), new Promise((done) => setTimeout(done, 1500))]);
      flushProgress();
      await update.install(file, latest);
      sendUpdate({ phase: "restart" });
      setTimeout(() => app.quit(), 600);
    } catch (err) {
      updating = null;
      throw err;
    }
  }),
);

// ---------------------------------------------------------------- IPC: reader

// What edubase's page tells the app. Only the reader's own page may speak here.
ipcMain.on("reader-event", (e, type, data) => {
  if (e.sender.getType() !== "webview" || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return;
  if (!e.senderFrame.url.startsWith(EDUBASE)) return;
  try {
    reader.onEvent(type, data);
  } catch {
    // Whatever a web page sends must not stop the app.
  }
});

ipcMain.handle("reader-cmd", (_e, name, arg) => reader.cmd(String(name), arg));
ipcMain.handle("notes", (_e, id) => reader.summary(String(id)));
ipcMain.handle("study-sheet", wrap((id) => reader.studySheet(String(id))));
// The study sheet, for pasting into Word, Pages, Notion or GoodNotes (text and formatted).
ipcMain.handle("copy", async (_e, text, html) => {
  const item = new ClipboardItem({
    "text/plain": String(text || "").slice(0, 2_000_000),
    "text/html": String(html || "").slice(0, 4_000_000),
  });
  await clipboard.write([item]);
});
ipcMain.handle("bookmark", (_e, id, page) => reader.toggleBookmark(String(id), String(page)));
// persist false: only until the app is closed (a book the app's reader cannot show).
ipcMain.handle("set-classic", (_e, on, persist) => {
  if (persist !== false) writeSettings({ classic: on === true });
  reader.setClassic(on === true);
});

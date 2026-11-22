// The app's own reader. Edubase's page view runs in a <webview>; this file hides the rest of
// edubase's interface, passes commands from the app's toolbar to the page, and keeps the
// user's own notes (pen, highlighter, typed text, bookmarks) in files on this computer.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const EDUBASE = "https://app.edubase.ch/";
const read = (name) => fs.readFileSync(path.join(__dirname, "reader", name), "utf8");
const INK_JS = read("ink.js");
const INK_CSS = read("ink.css");
const BOOK_JS = read("book.js");
const INJECT_JS = read("inject.js");
const INJECT_CSS = read("inject.css");

const COMMANDS = new Set([
  "go", "next", "prev", "zoomIn", "zoomOut", "fit", "spread", "tool", "undo", "redo",
  "search", "searchGo", "clearPage", "resize", "night",
]);

let guest = null; // the webview's page
let classic = false; // true: show edubase's own interface, untouched
let notify = () => {}; // (type, data) => to the app's window
let dataRoot = null; // a folder the user chose for notes (iCloud Drive, OneDrive, …); null: this computer

// ---------------------------------------------------------------- notes on disk

const isId = (id) => typeof id === "string" && /^\d{1,12}$/.test(id);
const notesDirIn = (root) => path.join(root, "notes");
const notesDir = () => notesDirIn(dataRoot || app.getPath("userData"));
const notesFile = (id, dir = notesDir()) => path.join(dir, `${id}.json`);

// iCloud Drive before macOS 14 keeps a file that is not downloaded as ".name.icloud" next to
// where it belongs. Such a file is there, only not here yet: it is asked for, and read later.
function inCloud(file) {
  const stub = path.join(path.dirname(file), `.${path.basename(file)}.icloud`);
  if (!fs.existsSync(stub)) return false;
  if (process.platform === "darwin") execFile("/usr/bin/brctl", ["download", stub], () => {});
  return true;
}

// Only a file that is not there means "no notes". A file that is there but cannot be read
// right now (not downloaded yet from iCloud Drive or OneDrive, locked by another program)
// throws: saving over it would keep one page and lose the rest.
// A file of a newer Stapel (v > 1) is read as far as this version understands it, and not
// written (save throws).
function load(id, dir) {
  const empty = () => ({ v: 1, pages: Object.create(null), bookmarks: [] });
  if (!isId(id)) return empty();
  const file = notesFile(id, dir);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && !inCloud(file)) return empty(); // no notes yet
    throw new Error("notesunavailable");
  }
  let d;
  try {
    d = JSON.parse(text);
    if (!d || typeof d !== "object") throw new Error("not notes");
  } catch {
    // Not JSON: broken on disk. It is put aside (the notes in it are kept there) and the
    // book starts again; both iCloud Drive and OneDrive put files in place whole.
    try {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    } catch {}
    return empty();
  }
  return { v: Number(d.v) || 1, pages: cleanPages(d.pages, true), bookmarks: cleanBookmarks(d.bookmarks) };
}

function save(id, data, dir = notesDir()) {
  if (!isId(id)) return false;
  if (data.v > 1) throw new Error("notesnewer");
  const file = notesFile(id, dir);
  const mine = dir === notesDir();
  const empty = !Object.keys(data.pages).length && !data.bookmarks.length;
  if (empty) {
    fs.rmSync(file, { force: true });
    if (mine) noteCounts?.delete(id);
    return true;
  }
  const json = JSON.stringify({ v: 1, pages: data.pages, bookmarks: data.bookmarks });
  if (json.length > 40_000_000) return false; // no book of notes is this large
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file);
  if (mine) noteCounts?.set(id, Object.values(data.pages).reduce((n, p) => n + p.length, 0));
  return true;
}

// What the page may see of a page's notes: the kinds this version draws.
const KNOWN = new Set(["pen", "hl", "text"]);
const known = (items) => items.filter((i) => KNOWN.has(i.t));
const knownPages = (pages) => {
  const out = Object.create(null);
  for (const [page, items] of Object.entries(pages)) {
    const list = known(items);
    if (list.length) out[page] = list;
  }
  return out;
};

// Notes arrive from a web page. Keep only what has exactly the expected shape.
const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
// A page's name: a number, or a label such as "IV" or "12a". Starts with a letter or a digit.
const pageKey = (p) => (typeof p === "string" || typeof p === "number") && /^[0-9A-Za-z][\w.\-]{0,23}$/.test(String(p));

// A kind of note from a newer Stapel (notes can be shared by several computers): kept as it
// is when it comes from disk, so saving here does not take it away.
function otherItem(it) {
  if (typeof it.t !== "string" || KNOWN.has(it.t) || !/^[a-z][\w-]{0,19}$/.test(it.t)) return null;
  try {
    return JSON.stringify(it).length <= 50_000 ? JSON.parse(JSON.stringify(it)) : null;
  } catch {
    return null;
  }
}

function cleanItem(it, fromDisk = false) {
  if (!it || typeof it !== "object") return null;
  if (typeof it.id !== "string" || !/^[\w-]{1,32}$/.test(it.id)) return null;
  if (fromDisk && !KNOWN.has(it.t)) return otherItem(it);
  if (typeof it.c !== "string" || !/^#[0-9a-f]{6}$/i.test(it.c)) return null;
  if (it.t === "pen" || it.t === "hl") {
    if (!num(it.w, 0.2, 60) || !Array.isArray(it.p) || it.p.length < 2 || it.p.length > 6000 || it.p.length % 2) return null;
    if (!it.p.every((v) => num(v, -200, 6000))) return null;
    const out = { id: it.id, t: it.t, c: it.c.toLowerCase(), w: it.w, p: it.p };
    // The words under a highlighter line (reader/book.js), for the list of notes.
    if (it.t === "hl" && typeof it.q === "string") out.q = it.q.replace(/\s+/g, " ").trim().slice(0, 1000);
    return out;
  }
  if (it.t === "text") {
    if (!num(it.x, -200, 6000) || !num(it.y, -200, 6000) || !num(it.s, 4, 120)) return null;
    if (typeof it.text !== "string" || !it.text || it.text.length > 4000) return null;
    return { id: it.id, t: "text", c: it.c.toLowerCase(), s: it.s, x: it.x, y: it.y, text: it.text };
  }
  return null;
}

// One page: at most 2000 notes and about 3 MB, far more than a hand can draw on a page.
function cleanItems(items, fromDisk = false) {
  if (!Array.isArray(items)) return [];
  const out = [];
  let size = 0;
  for (const raw of items.slice(0, 2000)) {
    const it = cleanItem(raw, fromDisk);
    if (!it) continue;
    size += it.t === "text" ? it.text.length + 80 : it.p ? it.p.length * 7 + (it.q ? it.q.length : 0) + 80 : JSON.stringify(it).length;
    if (size > 3_000_000) break;
    out.push(it);
  }
  return out;
}

function cleanPages(pages, fromDisk = false) {
  const out = Object.create(null); // page names come from outside: no inherited keys
  if (!pages || typeof pages !== "object") return out;
  for (const key of Object.keys(pages).slice(0, 3000)) {
    if (!pageKey(key)) continue;
    const items = cleanItems(pages[key], fromDisk);
    if (items.length) out[key] = items;
  }
  return out;
}

const cleanBookmarks = (list) => (Array.isArray(list) ? [...new Set(list.filter(pageKey).map(String))].slice(0, 2000) : []);

// Top to bottom on the page: where a note starts.
const top = (it) => (it.t === "text" ? it.y : Math.min(...it.p.filter((_, i) => i % 2)));

// What the side panel lists: pages with notes, what was marked on them and the typed text.
// null while the book's notes cannot be read.
function summary(id) {
  let data;
  try {
    data = load(id);
  } catch {
    return null;
  }
  data.pages = knownPages(data.pages);
  const pages = Object.keys(data.pages).map((page) => {
    const items = data.pages[page].slice().sort((a, b) => top(a) - top(b));
    return {
      page,
      strokes: items.filter((i) => i.t === "pen" || (i.t === "hl" && !i.q)).length,
      marks: items.filter((i) => i.t === "hl" && i.q).map((i) => ({ c: i.c, q: i.q.slice(0, 300) })).slice(0, 30),
      texts: items.filter((i) => i.t === "text").map((i) => i.text.slice(0, 160)).slice(0, 20),
    };
  });
  return { id, pages, bookmarks: data.bookmarks, count: Object.values(data.pages).reduce((n, p) => n + p.length, 0) };
}

// Everything that can be written down from a book's notes, in full, page by page and top to
// bottom: the marked words and the typed text (drawings only as a number).
function studySheet(id) {
  const data = load(id);
  data.pages = knownPages(data.pages);
  return Object.keys(data.pages).map((page) => {
    const items = data.pages[page].slice().sort((a, b) => top(a) - top(b));
    return {
      page,
      drawings: items.filter((i) => i.t === "pen" || (i.t === "hl" && !i.q)).length,
      items: items.filter((i) => (i.t === "hl" && i.q) || i.t === "text").map((i) => (i.t === "text" ? { t: "text", c: i.c, text: i.text } : { t: "hl", c: i.c, q: i.q })),
    };
  });
}

function toggleBookmark(id, page) {
  if (!isId(id) || !pageKey(page)) return summary(id);
  try {
    const data = load(id);
    const key = String(page);
    data.bookmarks = data.bookmarks.includes(key) ? data.bookmarks.filter((p) => p !== key) : [...data.bookmarks, key];
    save(id, data);
  } catch (err) {
    notify("error", problem(err));
  }
  return summary(id);
}

// Which books have notes at all (for the library and the PDF sheet). Read from disk once,
// then kept up to date by save(). Read again when the notes folder changes.
let noteCounts = null;
function counts() {
  if (!noteCounts) {
    noteCounts = new Map();
    let files = [];
    try {
      files = fs.readdirSync(notesDir());
    } catch {}
    for (const f of files) {
      const m = f.match(/^(\d+)\.json$/);
      if (!m) continue;
      try {
        const n = Object.values(load(m[1]).pages).reduce((a, p) => a + p.length, 0);
        if (n) noteCounts.set(m[1], n);
      } catch {
        // Not readable right now: counted the next time the folder is read.
      }
    }
  }
  return Object.fromEntries([...noteCounts].filter(([, n]) => n > 0));
}

// The notes of every book in `fromRoot` are added to those in `toRoot`: notes and bookmarks
// that are only on one side are kept, nothing is taken away. For a notes folder that is
// chosen (or left) while the other side has notes too, such as a second computer's.
function mergeNotes(fromRoot, toRoot) {
  const from = notesDirIn(fromRoot);
  const to = notesDirIn(toRoot);
  if (path.resolve(from) === path.resolve(to)) return 0;
  let files = [];
  try {
    files = fs.readdirSync(from);
  } catch {
    return 0;
  }
  // Notes that are still in iCloud only would be left behind: asked for, and tried later.
  const away = files.filter((f) => /^\.\d+\.json\.icloud$/.test(f));
  if (away.length) {
    for (const f of away) inCloud(path.join(from, f.slice(1, -7)));
    throw new Error("notesunavailable");
  }
  // Throws (and changes nothing more) when a file on either side cannot be read now.
  let books = 0;
  for (const f of files) {
    const m = f.match(/^(\d+)\.json$/);
    if (!m) continue;
    const mine = load(m[1], from);
    const theirs = load(m[1], to);
    for (const page of Object.keys(mine.pages)) {
      const have = theirs.pages[page] || [];
      const ids = new Set(have.map((i) => i.id));
      const merged = [...have, ...mine.pages[page].filter((i) => !ids.has(i.id))];
      theirs.pages[page] = cleanItems(merged, true);
    }
    theirs.bookmarks = [...new Set([...theirs.bookmarks, ...mine.bookmarks])];
    try {
      if (!save(m[1], theirs, to)) throw new Error("too large");
    } catch (err) {
      throw new Error(err.message === "notesnewer" ? "notesnewer" : "notesdisk");
    }
    books++;
  }
  return books;
}

// What went wrong with a book's notes, as an error code the interface knows.
const problem = (err) => (["notesunavailable", "notesnewer"].includes(err && err.message) ? err.message : "notessave");

// ---------------------------------------------------------------- writing what the page drew

// The pages of a book that are drawn on but not on disk yet. Written at once; when the disk
// says no (a file held by OneDrive or a virus scanner, a folder that went away), tried again
// a little later, and the interface says so if it keeps failing. The next change to the same
// book takes them along.
const unsaved = new Map(); // book id -> Map(page -> items)

function writePages(id, attempt = 0) {
  const pages = unsaved.get(id);
  if (!pages || !pages.size) return true;
  try {
    const all = load(id);
    for (const [page, items] of pages) {
      // Notes of a kind only a newer Stapel draws stay where they are.
      const others = (all.pages[page] || []).filter((i) => !KNOWN.has(i.t));
      const next = [...items, ...others];
      if (next.length) all.pages[page] = next;
      else delete all.pages[page];
    }
    if (!save(id, all)) throw new Error("too large");
    unsaved.delete(id);
    notify("notes", summary(id));
    return true;
  } catch (err) {
    const code = problem(err);
    if (code !== "notesnewer" && attempt < 3) setTimeout(() => writePages(id, attempt + 1), [300, 1500, 5000][attempt]);
    else notify("error", code);
    return false;
  }
}

// Before the app quits: one last try for whatever is not on disk yet.
function writeAll() {
  for (const id of [...unsaved.keys()]) writePages(id, 3);
}

// ---------------------------------------------------------------- reading what the page needs

// A book's notes go to the page only once they could be read; until then the page does not
// let anyone draw (inject.js), so nothing can be saved over notes that are not loaded. Tried
// again as long as the book is open. What is drawn but not on disk yet goes along. Notes of a
// newer Stapel are shown, not changed.
function sendNotes(id, attempt = 0) {
  if (id !== openId()) return;
  let data;
  try {
    data = load(id);
  } catch (err) {
    if (attempt === 0) notify("error", problem(err));
    setTimeout(() => sendNotes(id, attempt + 1), Math.min(10000, 2000 + attempt * 1000));
    return;
  }
  const pages = knownPages(data.pages);
  for (const [page, items] of unsaved.get(id) || []) {
    if (items.length) pages[page] = items;
    else delete pages[page];
  }
  const readOnly = data.v > 1;
  if (readOnly) notify("error", "notesnewer");
  run(`window.__stapel && window.__stapel.cmd("ink", ${JSON.stringify({ id, pages, readOnly })})`);
  const sum = summary(id);
  if (sum) notify("notes", sum);
}

// The notes of a book as the PDF prints them: the kinds this version can draw.
const printable = (id) => knownPages(load(id).pages);

function setDataRoot(dir) {
  dataRoot = dir || null;
  noteCounts = null;
}

// What edubase's table of contents may hold when it reaches the app.
const cleanToc = (items) =>
  (Array.isArray(items) ? items : []).slice(0, 800).filter((i) => i && typeof i.title === "string" && i.title.trim() && pageKey(i.page)).map((i) => ({
    title: i.title.replace(/\s+/g, " ").trim().slice(0, 200),
    page: String(i.page),
    level: num(i.level, 0, 5) ? Math.floor(i.level) : 0,
  }));

// ---------------------------------------------------------------- the page in the webview

const run = (code) => (guest && !guest.isDestroyed() ? guest.executeJavaScript(code, true).catch(() => null) : Promise.resolve(null));

function attach(contents) {
  guest = contents;
  contents.on("destroyed", () => {
    if (guest === contents) guest = null;
  });
  contents.on("dom-ready", async () => {
    if (classic || !contents.getURL().startsWith(EDUBASE)) return;
    try {
      await contents.insertCSS(INK_CSS + "\n" + INJECT_CSS);
      await contents.executeJavaScript(INK_JS + "\n" + BOOK_JS + "\n" + INJECT_JS, true);
    } catch {}
  });
}

function cmd(name, arg) {
  if (!COMMANDS.has(name)) return Promise.resolve(false);
  return run(`window.__stapel ? window.__stapel.cmd(${JSON.stringify(name)}, ${JSON.stringify(arg ?? null)}) : false`);
}

// The book the webview shows, from its address. The page may only speak about this one.
function openId() {
  const m = guest && !guest.isDestroyed() ? guest.getURL().match(/#doc\/(\d+)/) : null;
  return m ? m[1] : null;
}

// Messages from the page. `sender` is checked by the caller to be the webview.
function onEvent(type, data, again = false) {
  if (classic) return;
  const open = openId();
  // The page can know about a new book a moment before the main process has heard of the
  // new address: look once more before letting the message go.
  const about = type === "need-ink" ? data : data && data.id;
  if (!again && isId(about) && about !== open && ["need-ink", "ink", "state", "toc"].includes(type)) {
    setTimeout(() => onEvent(type, data, true), 250);
    return;
  }
  if (type === "need-ink") {
    if (!isId(data) || data !== open) return;
    sendNotes(data);
  } else if (type === "ink") {
    if (!data || !isId(data.id) || data.id !== open || !pageKey(data.page)) return;
    if (!unsaved.has(data.id)) unsaved.set(data.id, new Map());
    unsaved.get(data.id).set(String(data.page), cleanItems(data.items));
    writePages(data.id);
  } else if (type === "state") {
    if (!data || typeof data !== "object") return;
    const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    if (data.id && data.id !== open) return;
    notify("state", {
      id: isId(data.id) ? data.id : null,
      page: pageKey(data.page) ? String(data.page) : null,
      pages: Array.isArray(data.pages) ? data.pages.filter(pageKey).map(String).slice(0, 4) : [],
      total: num(data.total, 0, 100000) ? Math.floor(data.total) : 0,
      zoom: s(data.zoom, 8),
      double: data.double === true,
      title: s(data.title, 300),
      canUndo: data.canUndo === true,
      canRedo: data.canRedo === true,
      ready: data.ready === true,
      blocked: data.blocked === true,
      unsupported: data.unsupported === true,
    });
  } else if (type === "toc") {
    // Only about the book on screen: the app keeps it on disk.
    if (!data || !isId(data.id) || data.id !== open || !Array.isArray(data.items)) return;
    notify("toc", { id: data.id, items: cleanToc(data.items) });
  } else if (type === "search") {
    if (!data || typeof data.q !== "string" || !Array.isArray(data.items)) return;
    notify("search", {
      q: data.q.slice(0, 200),
      title: typeof data.title === "string" ? data.title.slice(0, 120) : "",
      error: data.error === true,
      items: data.items.slice(0, 300).filter((i) => i && pageKey(i.page)).map((i) => ({
        idx: String(i.idx).slice(0, 8),
        page: String(i.page),
        loc: typeof i.loc === "string" ? i.loc.slice(0, 80) : "",
        parts: (Array.isArray(i.parts) ? i.parts : []).slice(0, 40).filter((p) => p && typeof p.t === "string").map((p) => ({ t: p.t.slice(0, 400), hit: p.hit === true })),
      })),
    });
  } else if (type === "key") {
    if (data === "find" || data === "escape") notify("key", data);
  }
}

module.exports = {
  INK_JS,
  INK_CSS,
  BOOK_JS,
  attach,
  cmd,
  onEvent,
  load,
  summary,
  studySheet,
  counts,
  toggleBookmark,
  printable,
  inCloud,
  writeAll,
  mergeNotes,
  setDataRoot,
  cleanToc,
  isId,
  setClassic: (on) => (classic = !!on),
  isClassic: () => classic,
  onNotify: (fn) => (notify = fn),
};

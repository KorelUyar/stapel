// The app's own reader. Edubase's page view runs in a <webview>; this file hides the rest of
// edubase's interface, passes commands from the app's toolbar to the page, and keeps the
// user's own notes (pen, highlighter, typed text, bookmarks) in files on this computer.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const EDUBASE = "https://app.edubase.ch/";
const read = (name) => fs.readFileSync(path.join(__dirname, "reader", name), "utf8");
const INK_JS = read("ink.js");
const INK_CSS = read("ink.css");
const INJECT_JS = read("inject.js");
const INJECT_CSS = read("inject.css");

const COMMANDS = new Set([
  "go", "next", "prev", "zoomIn", "zoomOut", "fit", "spread", "tool", "undo", "redo",
  "search", "searchGo", "clearPage", "resize",
]);

let guest = null; // the webview's page
let classic = false; // true: show edubase's own interface, untouched
let notify = () => {}; // (type, data) => to the app's window

// ---------------------------------------------------------------- notes on disk

const isId = (id) => typeof id === "string" && /^\d{1,12}$/.test(id);
const notesDir = () => path.join(app.getPath("userData"), "notes");
const notesFile = (id) => path.join(notesDir(), `${id}.json`);

function load(id) {
  const empty = () => ({ pages: Object.create(null), bookmarks: [] });
  if (!isId(id)) return empty();
  let text;
  try {
    text = fs.readFileSync(notesFile(id), "utf8");
  } catch {
    return empty(); // no notes yet
  }
  try {
    const d = JSON.parse(text);
    return { pages: cleanPages(d.pages), bookmarks: cleanBookmarks(d.bookmarks) };
  } catch {
    // A file that cannot be read is put aside, not overwritten: the next save would
    // otherwise keep one page and lose the rest.
    try {
      fs.renameSync(notesFile(id), `${notesFile(id)}.broken-${Date.now()}`);
    } catch {}
    return empty();
  }
}

function save(id, data) {
  if (!isId(id)) return false;
  const empty = !Object.keys(data.pages).length && !data.bookmarks.length;
  if (empty) {
    fs.rmSync(notesFile(id), { force: true });
    noteCounts?.delete(id);
    return true;
  }
  const json = JSON.stringify({ v: 1, pages: data.pages, bookmarks: data.bookmarks });
  if (json.length > 40_000_000) return false; // no book of notes is this large
  fs.mkdirSync(notesDir(), { recursive: true });
  const tmp = notesFile(id) + ".tmp";
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, notesFile(id));
  noteCounts?.set(id, Object.values(data.pages).reduce((n, p) => n + p.length, 0));
  return true;
}

// Notes arrive from a web page. Keep only what has exactly the expected shape.
const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
// A page's name: a number, or a label such as "IV" or "12a". Starts with a letter or a digit.
const pageKey = (p) => (typeof p === "string" || typeof p === "number") && /^[0-9A-Za-z][\w.\-]{0,23}$/.test(String(p));

function cleanItem(it) {
  if (!it || typeof it !== "object") return null;
  if (typeof it.id !== "string" || !/^[\w-]{1,32}$/.test(it.id)) return null;
  if (typeof it.c !== "string" || !/^#[0-9a-f]{6}$/i.test(it.c)) return null;
  if (it.t === "pen" || it.t === "hl") {
    if (!num(it.w, 0.2, 60) || !Array.isArray(it.p) || it.p.length < 2 || it.p.length > 6000 || it.p.length % 2) return null;
    if (!it.p.every((v) => num(v, -200, 6000))) return null;
    return { id: it.id, t: it.t, c: it.c.toLowerCase(), w: it.w, p: it.p };
  }
  if (it.t === "text") {
    if (!num(it.x, -200, 6000) || !num(it.y, -200, 6000) || !num(it.s, 4, 120)) return null;
    if (typeof it.text !== "string" || !it.text || it.text.length > 4000) return null;
    return { id: it.id, t: "text", c: it.c.toLowerCase(), s: it.s, x: it.x, y: it.y, text: it.text };
  }
  return null;
}

// One page: at most 2000 notes and about 3 MB, far more than a hand can draw on a page.
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  let size = 0;
  for (const raw of items.slice(0, 2000)) {
    const it = cleanItem(raw);
    if (!it) continue;
    size += it.t === "text" ? it.text.length + 80 : it.p.length * 7 + 80;
    if (size > 3_000_000) break;
    out.push(it);
  }
  return out;
}

function cleanPages(pages) {
  const out = Object.create(null); // page names come from outside: no inherited keys
  if (!pages || typeof pages !== "object") return out;
  for (const key of Object.keys(pages).slice(0, 3000)) {
    if (!pageKey(key)) continue;
    const items = cleanItems(pages[key]);
    if (items.length) out[key] = items;
  }
  return out;
}

const cleanBookmarks = (list) => (Array.isArray(list) ? [...new Set(list.filter(pageKey).map(String))].slice(0, 2000) : []);

// What the side panel lists: pages with notes, and the typed text on them.
function summary(id) {
  const data = load(id);
  const pages = Object.keys(data.pages).map((page) => {
    const items = data.pages[page];
    return {
      page,
      strokes: items.filter((i) => i.t !== "text").length,
      texts: items.filter((i) => i.t === "text").map((i) => i.text.slice(0, 160)).slice(0, 20),
    };
  });
  return { id, pages, bookmarks: data.bookmarks, count: Object.values(data.pages).reduce((n, p) => n + p.length, 0) };
}

function toggleBookmark(id, page) {
  if (!isId(id) || !pageKey(page)) return summary(id);
  const data = load(id);
  const key = String(page);
  data.bookmarks = data.bookmarks.includes(key) ? data.bookmarks.filter((p) => p !== key) : [...data.bookmarks, key];
  save(id, data);
  return summary(id);
}

// Which books have notes at all (for the library and the PDF sheet). Read from disk once,
// then kept up to date by save().
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
      const n = Object.values(load(m[1]).pages).reduce((a, p) => a + p.length, 0);
      if (n) noteCounts.set(m[1], n);
    }
  }
  return Object.fromEntries([...noteCounts].filter(([, n]) => n > 0));
}

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
      await contents.executeJavaScript(INK_JS + "\n" + INJECT_JS, true);
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
  if (!again && isId(about) && about !== open && ["need-ink", "ink", "state"].includes(type)) {
    setTimeout(() => onEvent(type, data, true), 250);
    return;
  }
  if (type === "need-ink") {
    if (!isId(data) || data !== open) return;
    const pages = load(data).pages;
    run(`window.__stapel && window.__stapel.cmd("ink", ${JSON.stringify({ id: data, pages })})`);
    notify("notes", summary(data));
  } else if (type === "ink") {
    if (!data || !isId(data.id) || data.id !== open || !pageKey(data.page)) return;
    const all = load(data.id);
    const items = cleanItems(data.items);
    if (items.length) all.pages[String(data.page)] = items;
    else delete all.pages[String(data.page)];
    save(data.id, all);
    notify("notes", summary(data.id));
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
    if (!data || !isId(data.id) || !Array.isArray(data.items)) return;
    notify("toc", {
      id: data.id,
      items: data.items.slice(0, 800).filter((i) => i && typeof i.title === "string" && pageKey(i.page)).map((i) => ({
        title: i.title.slice(0, 200),
        page: String(i.page),
        level: num(i.level, 0, 5) ? Math.floor(i.level) : 0,
      })),
    });
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
  attach,
  cmd,
  onEvent,
  load,
  summary,
  counts,
  toggleBookmark,
  setClassic: (on) => (classic = !!on),
  isClassic: () => classic,
  onNotify: (fn) => (notify = fn),
};

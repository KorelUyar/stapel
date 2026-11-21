// Screenshots for the README and uyarid.com, made without a person at the screen:
//
//   node_modules/.bin/electron scripts/shots.js <outDir> light|dark
//
// Uses edubase's free books (no account needed). The library pictures use invented sample
// covers, because a signed-out library only has the free books. The notes in the reader
// picture are written into the scratch profile before the book is opened.
const { app, BrowserWindow, nativeTheme, webContents } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [out, theme] = process.argv.slice(-2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "stapel-shots-"));
app.setPath("userData", profile);
app.setPath("downloads", path.join(app.getPath("userData"), "downloads"));

// This Mac's screen is 1x and smaller than a 2x picture. Let the app's window grow past the
// screen (only here), and draw it at zoom 2 for sharp pictures.
const Module = require("module");
const Original = require("electron").BrowserWindow;
class Large extends Original {
  constructor(o) {
    super({ ...o, enableLargerThanScreen: true });
    Large.last = this;
  }
}
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  const m = load.call(this, req, parent, ...rest);
  if (req === "electron" && parent && /main\.js$/.test(parent.filename)) {
    return new Proxy(m, { get: (t, k) => (k === "BrowserWindow" ? Large : t[k]) });
  }
  return m;
};
const SCALE = 2;
require("../main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLES = [
  ["Mathematik 1", "Algebra und Funktionen", "#1f6e59"],
  ["Deutsch", "Sprache und Kommunikation", "#e0654a"],
  ["Englisch B1", "Coursebook", "#3d5a80"],
  ["Geschichte", "Von der Antike bis heute", "#8a5a44"],
  ["Wirtschaft", "und Recht, Grundlagen", "#e3a92b"],
  ["Physik", "Mechanik und Energie", "#2f7f9a"],
  ["Informatik", "Programmieren mit Python", "#5b4b8a"],
  ["Chemie", "Stoffe und Reaktionen", "#b84a62"],
  ["Deutsch 2", "Literatur und Medien", "#c2573f"],
  ["Englisch B2", "Workbook", "#35517a"],
  ["Mathematik 2", "Geometrie und Stochastik", "#2a7d66"],
];
const FOLDERS = [
  { id: "fa", name: "Deutsch", color: "#e0654a" },
  { id: "fb", name: "Englisch", color: "#3d5a80" },
  { id: "fc", name: "Mathe", color: "#1f6e59" },
];
const SHELF = { 901: "fa", 908: "fa", 902: "fb", 909: "fb", 900: "fc", 910: "fc" };

function cover(title, sub, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
    <rect width="300" height="400" fill="${color}"/>
    <rect x="0" y="0" width="14" height="400" fill="#000" opacity=".12"/>
    <text x="34" y="92" font-family="-apple-system, Helvetica" font-size="30" font-weight="700" fill="#fff">${title}</text>
    <text x="34" y="128" font-family="-apple-system, Helvetica" font-size="17" fill="#fff" opacity=".8">${sub}</text>
    <circle cx="232" cy="320" r="44" fill="#fff" opacity=".14"/>
    <rect x="34" y="350" width="70" height="6" rx="3" fill="#fff" opacity=".5"/>
  </svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// Notes for page 12 of the free manual, in the page's own units (1000 wide).
function sampleNotes() {
  const ring = [];
  for (let i = 0; i <= 26; i++) {
    const a = (i / 26) * Math.PI * 2.1 - 1.2;
    ring.push(Math.round((571 + 46 * Math.cos(a)) * 10) / 10, Math.round((414 + 40 * Math.sin(a)) * 10) / 10);
  }
  const wave = [];
  for (let i = 0; i <= 22; i++) wave.push(120 + i * 13, Math.round((268 + 3.5 * Math.sin(i * 0.9)) * 10) / 10);
  return {
    v: 1,
    pages: {
      12: [
        { id: "s1", t: "hl", c: "#ffd400", w: 18, p: [120, 152, 330, 152, 605, 153] },
        { id: "s2", t: "pen", c: "#2456c7", w: 2.4, p: wave },
        { id: "s3", t: "pen", c: "#d13a2c", w: 2.4, p: ring },
        { id: "s4", t: "text", c: "#2456c7", s: 26, x: 122, y: 1090, text: "Favoriten: Stern auf dem Cover.\nBis Montag ausprobieren!" },
      ],
      20: [{ id: "s5", t: "text", c: "#1d1c1a", s: 18, x: 140, y: 300, text: "Für die Prüfung wichtig" }],
    },
    bookmarks: ["12", "31"],
  };
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = theme === "dark" ? "dark" : "light";
  fs.mkdirSync(out, { recursive: true });
  while (!Large.last) await sleep(100);
  const win = Large.last;
  win.setContentSize(945 * SCALE, 645 * SCALE);
  win.webContents.setZoomFactor(SCALE);
  const js = (c) => win.webContents.executeJavaScript(c);
  const until = async (c, t = 60000) => {
    const end = Date.now() + t;
    while (Date.now() < end) {
      if (await js(c)) return;
      await sleep(250);
    }
    throw new Error("timeout: " + c);
  };
  const guest = () => webContents.getAllWebContents().find((w) => w.getType() === "webview");
  // The window's own buttons are drawn by macOS and missing from a capture; paint them in.
  const chrome = `(() => { if (document.getElementById('shotChrome')) return;
    const d = document.createElement('div'); d.id = 'shotChrome';
    d.style.cssText = 'position:fixed;left:18px;top:20px;display:flex;gap:8px;z-index:99;pointer-events:none';
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const s = document.createElement('span');
      s.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + c + ';box-shadow:inset 0 0 0 .5px rgb(0 0 0 / .18)'; d.append(s); }
    document.body.append(d); })()`;
  const shot = async (name) => {
    win.webContents.setZoomFactor(SCALE);
    await js(chrome);
    await sleep(900);
    fs.writeFileSync(path.join(out, `${name}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    console.log("shot", name);
  };

  try {
    await until(`!document.getElementById('welcome').hidden`);
    await sleep(1500);
    await shot("welcome");

    await js(`document.getElementById('guestBtn').click()`);
    await until(`!document.getElementById('library').hidden`);
    const real = await js(`state.books`);
    const handbook = real.find((b) => /Handbuch/.test(b.title));
    const samples = SAMPLES.map(([t, s, c], i) => ({
      id: String(900 + i), title: t, cover: cover(t, s, c), i, seen: 0,
      progress: i === 3 ? { page: 120, total: 180 } : i === 5 ? { page: 34, total: 212 } : null,
      pdf: i === 3 || i === 6, notes: i === 3 ? 5 : 0,
    }));
    const library = `state.loggedIn = true; state.books = ${JSON.stringify(samples)}; state.folders = ${JSON.stringify(FOLDERS)};
      state.shelf = ${JSON.stringify(SHELF)}; document.getElementById('guestNote').hidden = true; show('library'); renderLibrary();`;
    await js(library);
    await sleep(1200);
    // Show one card and one folder the way they look under the pointer.
    await win.webContents.insertCSS(`.card.hover-shot .cover { transform: translateY(-3px); box-shadow: 0 2px 4px rgb(40 30 10 / 0.1), 0 16px 30px -12px rgb(40 30 10 / 0.4) }
      .card.hover-shot .card-more { opacity: 1 }
      .folder.hover-shot .folder-open { transform: translateY(-3px) } .folder.hover-shot .p1 { transform: rotate(-9deg) translateY(-6px) }
      .folder.hover-shot .p2 { transform: rotate(1deg) translateY(-8px) } .folder.hover-shot .folder-more { opacity: 1 }`);
    await js(`document.querySelectorAll('.card')[1].classList.add('hover-shot'); document.querySelectorAll('.folder')[0].classList.add('hover-shot')`);
    await shot("library");

    // Picking several books, with the bar at the bottom.
    await js(`state.selecting = true; state.selected = new Set(['903', '905', '906', '901', '908']); show('library'); renderLibrary(); document.getElementById('selectBtn').classList.add('on')`);
    await sleep(600);
    await shot("select");
    await js(`setSelecting(false)`);

    // The reader, with notes on the page and the table of contents open.
    fs.mkdirSync(path.join(profile, "notes"), { recursive: true });
    fs.writeFileSync(path.join(profile, "notes", `${handbook.id}.json`), JSON.stringify(sampleNotes()));
    await js(`state.books.push(${JSON.stringify({ ...handbook, progress: { page: 12, total: 90 } })}); r.side = true; r.tab = 'toc'; openBook(bookById(${JSON.stringify(handbook.id)}))`);
    guest()?.setZoomFactor(SCALE);
    await until(`r.ready && r.page === '12' && r.toc.length > 0 && r.notes.length > 0`, 60000);
    guest().setZoomFactor(SCALE);
    await js(`setTool('pen'); cmd('resize')`);
    await sleep(5000);
    await js(`cmd('fit')`);
    await sleep(2500);
    await shot("reader");

    await js(`r.tab = 'notes'; setTool('text'); renderReader()`);
    await sleep(600);
    await shot("notes");

    // Saving this book as PDF, with the page being saved.
    await js(`setTool('hand'); setSide(false); openSheet(state.reading)`);
    await sleep(900);
    await js(`document.getElementById('startBtn').click()`);
    await until(`/ (1[2-9]|[2-9]\\d) /.test(document.getElementById('runText').textContent)`, 120000);
    await sleep(500);
    await shot("pdf");
    await js(`document.getElementById('cancelBtn').click()`);
    await until(`!state.running`, 30000);
    await js(`closeSheet(); closeBook()`);
    await sleep(800);

    // Several books, one after the other (the free magazines).
    const magazines = real.filter((b) => /Magazin/.test(b.title));
    await js(`${library} state.shelf = Object.assign(state.shelf, ${JSON.stringify(Object.fromEntries(magazines.map((m) => [m.id, "fa"])))});
      state.books = state.books.concat(${JSON.stringify(magazines)}); state.folder = null; renderLibrary();
      openBatch([bookById('903'), ...${JSON.stringify(magazines)}.map((m) => bookById(m.id)), bookById('905')].filter(Boolean).slice(1, 3).concat([bookById('903'), bookById('905'), bookById('906')]))`);
    await sleep(700);
    await js(`document.getElementById('startBtn').click()`);
    await until(`[...document.querySelectorAll('.brow')].some((row) => row.classList.contains('ok')) && [...document.querySelectorAll('.brow.run')].some((row) => /^(\\d+) \\//.test(row.lastChild.textContent) && +RegExp.$1 > 6)`, 240000);
    await shot("batch");
    await js(`document.getElementById('cancelBtn').click()`);
    await sleep(3000);
  } catch (e) {
    console.log("FAIL", e.message);
  }
  app.quit();
});

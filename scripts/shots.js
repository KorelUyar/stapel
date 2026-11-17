// Screenshots for the README and uyarid.com, made without a person at the screen:
//
//   node_modules/.bin/electron scripts/shots.js <outDir> light|dark
//
// Uses edubase's free books (no account needed). The library picture uses invented sample
// covers, because a signed-out library only has two books.
const { app, BrowserWindow, nativeTheme, webContents } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [out, theme] = process.argv.slice(-2);
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stapel-shots-")));
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
];

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
    const handbook = await js(`state.books.find((b) => /Handbuch/.test(b.title))`);
    const samples = SAMPLES.map(([t, s, c], i) => ({ id: String(900 + i), title: t, cover: cover(t, s, c) }));
    await js(`state.loggedIn = true; state.books = ${JSON.stringify(samples)}; show('library'); document.getElementById('guestNote').hidden = true; renderGrid();`);
    await sleep(1200);
    // Show one card the way it looks under the pointer.
    await win.webContents.insertCSS(`.card.hover-shot .cover { transform: translateY(-3px) } .card.hover-shot .cover::after { opacity: 1; transform: none }`);
    await js(`document.querySelectorAll('.card')[1].classList.add('hover-shot')`);
    await shot("library");

    await js(`openBook(${JSON.stringify(handbook)})`);
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      const g = guest();
      if (g && (await g.executeJavaScript(`!!document.querySelector('[data-item=page-settings]')`).catch(() => false))) break;
      await sleep(400);
    }
    guest().setZoomFactor(SCALE);
    await sleep(5000);
    await shot("reader");

    await js(`openSheet(state.reading)`);
    await sleep(600);
    await js(`document.getElementById('startBtn').click()`);
    await until(`/ (1[2-9]|[2-9]\\d) /.test(document.getElementById('runText').textContent)`, 120000);
    await sleep(500);
    await shot("pdf");
    await js(`document.getElementById('cancelBtn').click()`);
    await sleep(3000);
  } catch (e) {
    console.log("FAIL", e.message);
  }
  app.quit();
});

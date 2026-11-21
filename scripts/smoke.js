// End-to-end check of the real app window, without an account (edubase's free books):
//
//   node_modules/.bin/electron scripts/smoke.js <outDir> [appDir]
//
// appDir defaults to the repo; pass the built resources/app.asar to test a package.
// Exits 0 when every step passed, 1 otherwise. Screenshots land in <outDir>.
const { app, webContents, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("smoke.js"));
const out = path.resolve(args[0] || "smoke");
const appDir = path.resolve(args[1] || path.join(__dirname, ".."));
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "stapel-smoke-"));
app.setPath("userData", profile);
app.setPath("downloads", path.join(out, "downloads"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

require(path.join(appDir, "main.js"));

app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 200 && !win; i++) {
    await sleep(100);
    win = BrowserWindow.getAllWindows().find((w) => /index\.html$/.test(w.webContents.getURL()));
  }
  if (!win) {
    check("main window opens", false);
    return app.exit(1);
  }
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const guest = () => webContents.getAllWebContents().find((w) => w.getType() === "webview");
  const gjs = (c) => guest().executeJavaScript(c, true);
  const vis = (id) => `!document.getElementById('${id}').hidden`;
  const until = async (c, t = 60000, where = js) => {
    const end = Date.now() + t;
    while (Date.now() < end) {
      if (await where(c).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const shot = async (n) => fs.writeFileSync(path.join(out, n + ".png"), (await win.webContents.capturePage()).toPNG());
  // Pointer input goes to the page inside the reader, in that page's own coordinates.
  const mouse = (type, x, y, extra = {}) => guest().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, ...extra });
  const drag = async (pts) => {
    mouse("mouseMove", ...pts[0]);
    await sleep(60);
    mouse("mouseDown", ...pts[0]);
    for (const p of pts.slice(1)) {
      await sleep(20);
      mouse("mouseMove", ...p, { modifiers: ["leftButtonDown"] });
    }
    await sleep(40);
    mouse("mouseUp", ...pts[pts.length - 1]);
    await sleep(300);
  };
  const pdfFiles = (dir) =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? pdfFiles(path.join(dir, e.name)) : e.name.endsWith(".pdf") ? [path.join(dir, e.name)] : []))
      : [];
  const { PDFDocument } = require(path.join(appDir, "node_modules", "pdf-lib"));
  const pageCount = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPageCount();

  try {
    check("platform", true, `${process.platform} ${process.arch}, Electron ${process.versions.electron}`);
    check("welcome screen", await until(`${vis("welcome")}`, 60000));
    await sleep(1000);
    await shot("1-welcome");
    check("paste hint fits the platform", true, await js(`t("pasteHint")`));

    await js(`document.getElementById('guestBtn').click()`);
    check("library with free books", await until(`${vis("library")} && document.querySelectorAll('.card').length > 0`, 60000),
      await js(`document.getElementById('libCount').textContent`).catch(() => ""));
    await sleep(800);

    // ---- folders
    await js(`document.getElementById('newFolderBtn').click()`);
    await sleep(500);
    await js(`(() => { const i = document.querySelector('#pop input'); i.value = 'Deutsch'; i.dispatchEvent(new Event('change')); document.querySelectorAll('#pop .color')[2].click(); closePop(); })()`);
    const magazine = await js(`state.books.find((b) => /Magazin 2026/.test(b.title))?.id || state.books[0].id`);
    await js(`moveBooks([${JSON.stringify(magazine)}], state.folders[0].id)`);
    await sleep(500);
    const saved = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
    check("folder with a book in it", saved.folders?.[0]?.name === "Deutsch" && saved.shelf?.[magazine] === saved.folders[0].id && (await js(`document.querySelectorAll('.folder').length === 1`)),
      JSON.stringify(saved.folders));
    await shot("2-library");
    await js(`document.querySelector('.folder .folder-open').click()`);
    await sleep(400);
    check("the folder shows its book", await js(`document.getElementById('libTitle').textContent === 'Deutsch' && document.querySelectorAll('.card').length === 1`));
    await js(`document.getElementById('crumbRoot').click()`);
    await sleep(300);

    // ---- the reader
    await js(`openBook(state.books.find((b) => /Handbuch/.test(b.title)) || state.books[0])`);
    const opened = await until(`r.ready`, 90000);
    check("book opens in the app's reader", opened, await js(`JSON.stringify({ page: r.page, total: r.total, zoom: r.zoom })`));
    await sleep(2500);
    check("edubase's own bars are hidden", await gjs(`['#readmodeAppHeader', '#readmodeAppFooter', '#readmodeAppAside'].every((s) => { const e = document.querySelector(s); return !e || getComputedStyle(e).display === 'none'; })`));
    check("table of contents", await until(`r.toc.length > 0`, 15000), await js(`r.toc.length + " entries"`));
    await js(`cmd('go', '5')`);
    check("go to page 5", await until(`r.page === '5'`, 15000));
    await sleep(1500);

    // ---- notes: a pen line and a typed text
    const p = await gjs(`(() => { const b = document.querySelector('.doc-page-wrapper:not([data-pageid=dummy])').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
    const at = (fx, fy) => [p.x + fx * p.w, p.y + fy * p.h];
    await js(`setTool('pen')`);
    await sleep(300);
    await drag([at(0.15, 0.3), at(0.3, 0.31), at(0.45, 0.3), at(0.6, 0.31)]);
    await js(`setTool('text')`);
    await sleep(300);
    mouse("mouseDown", ...at(0.2, 0.8));
    mouse("mouseUp", ...at(0.2, 0.8));
    await sleep(400);
    for (const ch of "Smoke") guest().sendInputEvent({ type: "char", keyCode: ch });
    await sleep(300);
    await js(`setTool('hand')`);
    await until(`r.notes.some((n) => n.page === '5' && n.strokes === 1 && n.texts[0] === 'Smoke')`, 8000);
    const notesFile = path.join(profile, "notes", `${await js(`r.id`)}.json`);
    const notes = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, "utf8")) : {};
    check("pen and text are saved", notes.pages?.["5"]?.length === 2, JSON.stringify((notes.pages?.["5"] || []).map((i) => i.t)));
    await js(`cmd('undo')`);
    await until(`r.notes.some((n) => n.page === '5' && n.texts.length === 0)`, 5000);
    await js(`cmd('redo')`);
    check("undo and redo", await until(`r.notes.some((n) => n.page === '5' && n.texts.length === 1)`, 5000));
    await js(`document.getElementById('markBtn').click()`);
    check("bookmark", await until(`r.marks.includes('5')`, 5000));
    await js(`setSide(true, 'notes')`);
    await sleep(1500);
    await shot("3-reader");

    await js(`cmd('next')`);
    check("next page", await until(`r.page === '6'`, 15000));
    await js(`document.getElementById('findInput').value = 'Passwort'; document.getElementById('findForm').requestSubmit()`);
    check("search in the book", (await until(`r.find && !r.find.busy`, 30000)) && (await js(`r.find.items.length > 0`)), await js(`r.find && r.find.items.length + " pages"`));

    // ---- one PDF, pages 4 to 6, with the notes
    await js(`document.getElementById('pdfBtn').click()`);
    await sleep(900);
    check("the sheet offers the notes", await js(`!document.getElementById('notesOpt').hidden`));
    await js(`document.querySelector('[data-range=part]').click(); document.getElementById('fromPage').value = 4; document.getElementById('toPage').value = 6;`);
    await js(`document.getElementById('startBtn').click()`);
    await until(`/ [2-9] /.test(document.getElementById('runText').textContent) || ${vis("stateDone")}`, 90000);
    await shot("4-saving");
    const done = await until(`${vis("stateDone")} || ${vis("stateFail")}`, 180000);
    const text = await js(`document.getElementById('doneText').textContent || document.getElementById('failText').textContent`);
    check("save 3 pages as PDF", done && (await js(vis("stateDone"))), text);
    await sleep(600);
    await shot("5-saved");
    const single = pdfFiles(path.join(out, "downloads"));
    if (single.length) {
      const bytes = fs.readFileSync(single[0]);
      check("PDF has 3 pages", (await pageCount(single[0])) === 3, `${path.basename(single[0])}: ${bytes.length} bytes`);
    } else check("PDF file written", false);

    await js(`document.getElementById('closeSheet').click(); document.querySelector('#langSwitch [data-lang=de]').click()`);
    await sleep(400);
    check("German", (await js(`document.querySelector('#pdfBtn span').textContent`)) === "Als PDF speichern");
    await js(`document.getElementById('backBtn').click()`);
    check("back to the library", await until(vis("library"), 10000));
    check("the library remembers page and notes", await until(`(() => { const b = state.books.find((x) => /Handbuch/.test(x.title)); return b && b.notes > 0 && b.progress && b.progress.page === 6; })()`, 8000));
    await sleep(500);
    await shot("6-library-de");

    // ---- several books at once: the two magazines
    await js(`document.getElementById('selectBtn').click()`);
    await sleep(300);
    await js(`for (const b of state.books) if (/Magazin/.test(b.title)) togglePick(b.id)`);
    const picked = await js(`state.selected.size`);
    await js(`document.getElementById('selPdfBtn').click()`);
    await sleep(800);
    await js(`document.getElementById('startBtn').click()`);
    await until(`document.querySelectorAll('.brow.ok').length > 0 || ${vis("stateFail")}`, 300000);
    await shot("7-batch");
    const batchDone = await until(`${vis("stateDone")} || ${vis("stateFail")}`, 400000);
    const rows = await js(`[...document.querySelectorAll('.brow')].map((r) => r.className.replace('brow ', '') + ' ' + r.lastChild.textContent).join(' | ')`);
    check(`save ${picked} books in one go`, batchDone && picked >= 2 && (await js(`document.querySelectorAll('.brow.ok').length`)) === picked, rows);
    await sleep(500);
    await shot("8-batch-done");
    const all = pdfFiles(path.join(out, "downloads"));
    check("one PDF per book, sorted into the folder", all.length === 1 + picked && all.some((f) => path.basename(path.dirname(f)) === "Deutsch"),
      all.map((f) => path.relative(path.join(out, "downloads"), f)).join(" | "));
  } catch (e) {
    check("no exception", false, e.stack);
  }

  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(results, null, 2));
  console.log(failed ? `${failed} step(s) failed` : "all steps passed");
  app.exit(failed ? 1 : 0);
});

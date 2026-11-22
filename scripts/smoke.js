// End-to-end check of the real app window, without an account (edubase's free books):
//
//   node_modules/.bin/electron scripts/smoke.js <outDir> [appDir]
//
// appDir defaults to the repo; pass the built resources/app.asar to test a package.
// Exits 0 when every step passed, 1 otherwise. Screenshots land in <outDir>.
const { app, webContents, BrowserWindow, clipboard, dialog } = require("electron");
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
  const { PDFDocument, PDFName, PDFDict } = require(path.join(appDir, "node_modules", "pdf-lib"));

  try {
    check("platform", true, `${process.platform} ${process.arch}, Electron ${process.versions.electron}`);
    check("welcome screen", await until(`${vis("welcome")}`, 60000));
    await sleep(1000);
    await shot("1-welcome");
    const hint = await js(`t("pasteHint")`);
    check("paste hint fits the platform", hint.includes(process.platform === "darwin" ? "⌘V" : "Ctrl+V"), hint);

    // A newer version is reported the way the main process does it (nothing is downloaded here).
    const quiet = await js(`document.getElementById('updateBtn').hidden`);
    await js(`onUpdate({ available: true, latest: '9.9.9', current: '1.2.0' })`);
    await js(`document.getElementById('updateBtn').click()`);
    await sleep(300);
    check("a newer version shows the update button", quiet && (await js(`!document.getElementById('updateBtn').hidden && /9\.9\.9/.test(document.getElementById('updateText').textContent) && document.querySelectorAll('#pop .btn').length === 2`)),
      await js(`document.getElementById('updateText').textContent`));
    await js(`closePop(); up.latest = null; renderUpdate()`);

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
    // The bars must still be there under these names, and hidden: if edubase renames them,
    // this fails instead of passing over nothing.
    check("edubase's own bars are hidden", await gjs(`['#readmodeAppHeader', '#readmodeAppFooter', '#readmodeAppAside'].every((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display === 'none'; })`));
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
    const undone = await until(`r.notes.some((n) => n.page === '5' && n.texts.length === 0 && n.strokes === 1)`, 5000);
    await js(`cmd('redo')`);
    check("undo and redo", undone && (await until(`r.notes.some((n) => n.page === '5' && n.texts.length === 1)`, 5000)));

    // highlighter (a wobbly line becomes level) and eraser, on the same page
    await js(`setTool('hl')`);
    await sleep(300);
    await drag([at(0.15, 0.6), at(0.3, 0.603), at(0.45, 0.598), at(0.6, 0.601)]);
    await until(`r.notes.some((n) => n.page === '5' && n.strokes + n.marks.length === 2)`, 5000);
    const marker = (JSON.parse(fs.readFileSync(notesFile, "utf8")).pages["5"] || []).find((i) => i.t === "hl");
    check("highlighter line is straightened", !!marker && marker.p.length === 4 && marker.p[1] === marker.p[3], marker ? JSON.stringify(marker.p) : "no highlighter line saved");
    await js(`setTool('eraser')`);
    await sleep(300);
    await drag([at(0.35, 0.55), at(0.36, 0.6), at(0.37, 0.65)]);
    check("eraser removes the highlighter line only", await until(`r.notes.some((n) => n.page === '5' && n.strokes + n.marks.length === 1 && n.texts.length === 1)`, 5000));
    // a line that runs off the page is still saved
    await js(`setTool('pen')`);
    await sleep(300);
    await drag([at(0.3, 0.9), at(0.1, 0.9), at(-0.4, 0.9), at(0.2, 0.92)]);
    check("a line that leaves the page is saved", await until(`r.notes.some((n) => n.page === '5' && n.strokes + n.marks.length === 2)`, 5000),
      JSON.stringify((JSON.parse(fs.readFileSync(notesFile, "utf8")).pages["5"] || []).map((i) => i.t)));
    // a highlighter line over a word: the list of notes shows the word as text
    const word = await gjs(`(() => {
      const w = [...document.querySelectorAll('.doc-page-wrapper')].find((x) => x.dataset.pageid === '5');
      const e = w && [...w.querySelectorAll('.lu-page-word[data-w]')].find((x) => /^\\p{L}{6,}$/u.test(x.dataset.w));
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { text: e.dataset.w, x: b.left, y: b.top + b.height / 2, w: b.width };
    })()`);
    await js(`setTool('hl')`);
    await sleep(300);
    if (word) await drag([[word.x + 1, word.y], [word.x + word.w / 2, word.y], [word.x + word.w - 1, word.y]]);
    check("the highlighter knows the words it marks", !!word && (await until(`r.notes.some((n) => n.page === '5' && n.marks.some((m) => m.q.includes(${JSON.stringify(word?.text || "?")})))`, 6000)),
      word ? `${word.text}: ${await js(`JSON.stringify((r.notes.find((n) => n.page === '5') || {}).marks)`)}` : "no word on page 5");
    await js(`setTool('hand')`);
    await js(`document.getElementById('markBtn').click()`);
    check("bookmark", await until(`r.marks.includes('5')`, 5000));
    await js(`setSide(true, 'notes')`);
    await sleep(1500);
    await shot("3-reader");
    await clipboard.writeText(""); // nothing left over from an earlier run
    await js(`document.querySelector('#panelNotes .panel-action').click()`);
    await sleep(800);
    const sheet = await clipboard.readText();
    check("notes copied as a study sheet", sheet.includes("Page 5") && (!word || sheet.includes(word.text)), sheet.split("\n").filter(Boolean).slice(0, 5).join(" / "));
    const night = async (on) => {
      await js(`document.getElementById('moreBtn').click()`);
      await sleep(300);
      await js(`[...document.querySelectorAll('#pop .menu-item')].find((b) => b.textContent === t('night')).click()`);
      return until(`${on ? "" : "!"}document.body.classList.contains('stapel-night')`, 4000, gjs);
    };
    check("dark pages, on and off", (await night(true)) && (await night(false)));

    await js(`cmd('next')`);
    check("next page", await until(`r.page === '6'`, 15000));
    // a real key press inside the page, and two pages side by side
    await js(`setSide(false)`);
    await sleep(1200);
    mouse("mouseDown", 20, 20);
    mouse("mouseUp", 20, 20);
    guest().sendInputEvent({ type: "keyDown", keyCode: "Left" });
    guest().sendInputEvent({ type: "keyUp", keyCode: "Left" });
    const keyed = await until(`r.page === '5'`, 8000);
    guest().sendInputEvent({ type: "keyDown", keyCode: "Right" });
    guest().sendInputEvent({ type: "keyUp", keyCode: "Right" });
    check("arrow keys turn the page", keyed && (await until(`r.page === '6'`, 8000)), await js(`r.page`));
    await js(`cmd('spread')`);
    const two = await until(`r.double && r.pages.length === 2`, 10000);
    await sleep(1500);
    check("two pages side by side, fitted to the window", two && (await gjs(`(() => { const p = document.querySelector('.lu-doc-pages').getBoundingClientRect(); const b = document.querySelector('#readmodeAppBody').getBoundingClientRect(); return p.width <= b.width + 3 && p.height <= b.height + 3; })()`)),
      await js(`r.pages.join(' and ')`));
    await js(`document.getElementById('findInput').value = 'Passwort'; document.getElementById('findForm').requestSubmit()`);
    check("search in the book", (await until(`r.find && !r.find.busy`, 30000)) && (await js(`r.find.items.length > 0`)), await js(`r.find && r.find.items.length + " pages"`));

    // ---- one PDF, pages 4 to 6, with the notes
    await js(`document.getElementById('pdfBtn').click()`);
    await sleep(900);
    check("the sheet offers the notes", await js(`!document.getElementById('notesOpt').hidden`));
    await js(`document.querySelector('[data-range=chapter]').click()`);
    check("chapters to choose from", await until(`document.getElementById('fromChapter').options.length > 1 && /\\d/.test(document.getElementById('chapterInfo').textContent)`, 8000),
      await js(`document.getElementById('fromChapter').options.length + ' chapters, ' + document.getElementById('chapterInfo').textContent`));
    await js(`document.querySelector('[data-range=part]').click(); document.getElementById('fromPage').value = 4; document.getElementById('toPage').value = 6;`);
    await js(`document.getElementById('startBtn').click()`);
    await until(`/ [2-9] /.test(document.getElementById('runText').textContent) || ${vis("stateDone")}`, 90000);
    await shot("4-saving");
    const done = await until(`${vis("stateDone")} || ${vis("stateFail")}`, 180000);
    const text = await js(`document.getElementById('doneText').textContent || document.getElementById('failText').textContent`);
    check("save 3 pages as PDF (while two pages are on screen)", done && (await js(vis("stateDone"))), text);
    await sleep(600);
    await shot("5-saved");
    const single = pdfFiles(path.join(out, "downloads"));
    if (single.length) {
      const bytes = fs.readFileSync(single[0]);
      const doc = await PDFDocument.load(bytes);
      check("PDF has 3 pages", doc.getPageCount() === 3, `${path.basename(single[0])}: ${bytes.length} bytes`);
      // The book's own letters are shapes. The typed note is real text, so the page with the
      // note carries more (a font) than its neighbours: that is how the note is found here.
      const weight = doc.getPages().map((page) => {
        const res = page.node.Resources();
        const count = (name) => {
          const d = res && res.lookup(PDFName.of(name));
          return d instanceof PDFDict ? d.keys().length : 0;
        };
        return count("Font") + count("XObject");
      });
      check("the notes are printed on their page", weight.length === 3 && weight[1] > weight[0] && weight[1] > weight[2], `fonts and pictures per page: ${weight.join(", ")}`);
      // Every page carries its words as (invisible) text: a page without notes has a font too.
      const fonts = doc.getPages().map((page) => {
        const d = page.node.Resources()?.lookup(PDFName.of("Font"));
        return d instanceof PDFDict ? d.keys().length : 0;
      });
      const labels = doc.catalog.lookup(PDFName.of("PageLabels"));
      const first = labels instanceof PDFDict ? labels.lookup(PDFName.of("Nums"))?.lookup(1)?.lookup(PDFName.of("St"))?.asNumber() : null;
      check("the PDF has text, the book's page numbers and its contents", fonts[0] >= 1 && fonts[2] >= 1 && first === 4 && !!doc.catalog.get(PDFName.of("Outlines")) && path.basename(single[0]).includes("4–6"),
        `fonts ${fonts.join(", ")}; first page number ${first}; ${path.basename(single[0])}`);
    } else check("PDF file written", false);
    check("two pages are back after the PDF", await js(`r.double`));
    await js(`document.getElementById('closeSheet').click(); cmd('spread')`);
    await until(`!r.double`, 10000);

    await js(`setLanguage('de')`);
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

    // ---- notes in a folder of one's own (iCloud Drive, OneDrive): this one already holds what
    // another computer put there, a folder of the same name among it
    const cloud = path.join(out, "cloud");
    fs.rmSync(cloud, { recursive: true, force: true });
    fs.mkdirSync(path.join(cloud, "Stapel", "notes"), { recursive: true });
    fs.writeFileSync(path.join(cloud, "Stapel", "library.json"), JSON.stringify({
      v: 1, folders: [{ id: "f-other", name: "Mathe", color: "#3d5a80" }, { id: "f-same", name: "deutsch", color: "#1f6e59" }], shelf: {}, sort: "recent", progress: {}, recent: {},
    }));
    const otherBook = await js(`state.books.find((b) => /Magazin 2025/.test(b.title))?.id`);
    fs.writeFileSync(path.join(cloud, "Stapel", "notes", `${otherBook}.json`), JSON.stringify({
      v: 1, pages: { 2: [{ id: "other1", t: "text", c: "#2456c7", s: 18, x: 100, y: 100, text: "From the other computer" }] }, bookmarks: ["3"],
    }));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cloud] });
    const bookId = await js(`state.books.find((b) => /Handbuch/.test(b.title)).id`);
    await js(`moveNotes()`);
    await sleep(800);
    const lib = JSON.parse(fs.readFileSync(path.join(cloud, "Stapel", "library.json"), "utf8"));
    const marks = await js(`window.app.marks()`);
    check("notes and folders move into a chosen folder, joined with what is there",
      fs.existsSync(path.join(cloud, "Stapel", "notes", `${bookId}.json`)) && !fs.existsSync(path.join(profile, "notes")) &&
      lib.folders.length === 2 && lib.shelf[magazine] === "f-same" && marks.notes[bookId] > 0 && marks.notes[otherBook] === 1 &&
      (await js(`state.folders.map((f) => f.name).sort().join()`)) === "Mathe,deutsch",
      `folders ${lib.folders.map((f) => f.name).join(", ")}; notes ${JSON.stringify(marks.notes)}`);
    await js(`moveNotes('here')`);
    await sleep(800);
    const back = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
    check("and back to this computer, with all of it", !back.dataDir && back.folders?.length === 2 &&
      fs.existsSync(path.join(profile, "notes", `${bookId}.json`)) && fs.existsSync(path.join(profile, "notes", `${otherBook}.json`)),
      `folders ${(back.folders || []).map((f) => f.name).join(", ")}`);
  } catch (e) {
    check("no exception", false, e.stack);
  }

  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(results, null, 2));
  console.log(failed ? `${failed} step(s) failed` : "all steps passed");
  app.exit(failed ? 1 : 0);
});

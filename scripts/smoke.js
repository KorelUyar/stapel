// End-to-end check of the real app window, without an account (edubase's free books):
//
//   node_modules/.bin/electron scripts/smoke.js <outDir> [appDir]
//
// appDir defaults to the repo; pass the built resources/app.asar to test a package.
// Exits 0 when every step passed, 1 otherwise. Screenshots land in <outDir>.
const { app, webContents } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("smoke.js"));
const out = path.resolve(args[0] || "smoke");
const appDir = path.resolve(args[1] || path.join(__dirname, ".."));
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stapel-smoke-")));
app.setPath("downloads", path.join(out, "downloads"));

// Find the app's main window without changing main.js.
const { BrowserWindow } = require("electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
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
  const js = (c) => win.webContents.executeJavaScript(c);
  const vis = (id) => `!document.getElementById('${id}').hidden`;
  const until = async (c, t = 60000) => {
    const end = Date.now() + t;
    while (Date.now() < end) {
      if (await js(c).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const shot = async (n) => fs.writeFileSync(path.join(out, n + ".png"), (await win.webContents.capturePage()).toPNG());
  const guest = () => webContents.getAllWebContents().find((w) => w.getType() === "webview");

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
    await shot("2-library");

    await js(`document.querySelector('.card').click()`);
    let opened = false;
    for (let i = 0; i < 160 && !opened; i++) {
      await sleep(250);
      const g = guest();
      opened = !!(g && (await g.executeJavaScript(`!!document.querySelector('[data-item=page-settings]')`).catch(() => false)));
    }
    check("book opens in the reader", opened, guest()?.getURL());
    await sleep(3000);
    await shot("3-reader");

    await js(`document.getElementById('pdfBtn').click()`);
    await sleep(500);
    await js(`document.querySelector('[data-range=part]').click(); document.getElementById('fromPage').value = 1; document.getElementById('toPage').value = 3;`);
    await js(`document.getElementById('startBtn').click()`);
    await until(`/ [2-9] /.test(document.getElementById('runText').textContent) || ${vis("stateDone")}`, 90000);
    await shot("4-saving");
    const done = await until(`${vis("stateDone")} || ${vis("stateFail")}`, 180000);
    const text = await js(`document.getElementById('doneText').textContent || document.getElementById('failText').textContent`);
    check("save 3 pages as PDF", done && (await js(vis("stateDone"))), text);
    await sleep(600);
    await shot("5-saved");

    const files = fs.existsSync(path.join(out, "downloads")) ? fs.readdirSync(path.join(out, "downloads")).filter((f) => f.endsWith(".pdf")) : [];
    if (files.length) {
      const { PDFDocument } = require(path.join(appDir, "node_modules", "pdf-lib"));
      const doc = await PDFDocument.load(fs.readFileSync(path.join(out, "downloads", files[0])));
      check("PDF has 3 pages", doc.getPageCount() === 3, `${files[0]}: ${doc.getPageCount()} pages, ${fs.statSync(path.join(out, "downloads", files[0])).size} bytes`);
    } else check("PDF file written", false);

    await js(`document.getElementById('closeSheet').click(); document.querySelector('#langSwitch [data-lang=de]').click()`);
    await sleep(400);
    check("German", (await js(`document.querySelector('#pdfBtn span').textContent`)) === "Als PDF speichern");
    await js(`document.getElementById('backBtn').click()`);
    check("back to the library", await until(vis("library"), 10000));
    await shot("6-library-de");
  } catch (e) {
    check("no exception", false, e.stack);
  }

  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(results, null, 2));
  console.log(failed ? `${failed} step(s) failed` : "all steps passed");
  app.exit(failed ? 1 : 0);
});

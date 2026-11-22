// Everything that talks to edubase. Runs in Electron's main process and drives the real
// edubase web app in a hidden window, so there is no second browser (Puppeteer) to ship.
// Login happens on edubase's own page in a persistent session: the app never sees the password
// and stays signed in between launches.

const { BrowserWindow, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFDocument, PDFName, PDFNumber, PDFHexString } = require("pdf-lib");

const BASE = "https://app.edubase.ch/";
const PARTITION = "persist:edubase";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ses;
let worker;
const inflight = new Set();

function getSession() {
  if (ses) return ses;
  ses = session.fromPartition(PARTITION);
  // edubase treats unknown browsers differently; present as plain Chrome.
  ses.setUserAgent(
    ses.getUserAgent().replace(/ Electron\/\S+/, "").replace(/ edubase-downloader\/\S+/, ""),
  );
  // Track open requests of the hidden window, so we can wait until a page has finished loading
  // instead of sleeping for a fixed time.
  const isWorker = (d) => worker && !worker.isDestroyed() && d.webContentsId === worker.webContents.id;
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (isWorker(d)) inflight.add(d.id);
    cb({});
  });
  // edubase needs no camera, microphone, location or notifications.
  const allowed = new Set(["fullscreen", "clipboard-sanitized-write"]);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  const done = (d) => inflight.delete(d.id);
  ses.webRequest.onCompleted(done);
  ses.webRequest.onErrorOccurred(done);
  return ses;
}

function getWorker() {
  if (worker && !worker.isDestroyed()) return worker;
  worker = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1000,
    webPreferences: { session: getSession(), backgroundThrottling: false },
  });
  worker.webContents.setAudioMuted(true);
  worker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return worker;
}

const js = (code) => getWorker().webContents.executeJavaScript(code, true);

async function waitFor(check, timeout, every = 250, token) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (token?.cancelled) throw new Error("cancelled");
    const v = await check();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// Wait until the hidden window has no open requests for a moment and every image is decoded.
async function waitIdle({ min = 400, quiet = 600, max = 20000, token } = {}) {
  const start = Date.now();
  let quietSince = null;
  while (Date.now() - start < max) {
    if (token?.cancelled) throw new Error("cancelled");
    const imagesDone = await js(
      `[...document.images].every((i) => i.complete)`,
    ).catch(() => true);
    if (inflight.size === 0 && imagesDone) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quiet && Date.now() - start >= min) return;
    } else {
      quietSince = null;
    }
    await sleep(100);
  }
}

// Wait until an expression in the hidden window gives the same value for `quiet` ms.
async function waitStable(expr, quiet, max) {
  const start = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - start < max) {
    const v = await js(expr).catch(() => null);
    if (v !== last) {
      last = v;
      since = Date.now();
    } else if (Date.now() - since >= quiet) return;
    await sleep(200);
  }
}

async function open(hash) {
  const w = getWorker();
  inflight.clear();
  await w.loadURL("about:blank");
  await w.loadURL(BASE + hash);
}

// ---------------------------------------------------------------- session

// The header slot top right is empty until edubase has drawn it; then it holds either the
// Login button or the signed-in profile. Only then does "no Login button" mean signed in
// (the library can appear first on a slow machine).
const HEADER_READY = `(() => {
  const slot = document.querySelector('[data-anchor="lu-profile-settings"]');
  return (!!slot && slot.children.length > 0) || !!document.querySelector('.lu-profile-settings__login');
})()`;

// Called once at start, so the reader <webview> uses the same session settings.
function init() {
  getSession();
}

async function status() {
  try {
    await open("#library");
  } catch {
    throw new Error("offline");
  }
  const ready = await waitFor(() => js(HEADER_READY), 30000);
  if (!ready) {
    // edubase may have renamed the header; fall back to "the library is there".
    const library = await waitFor(() => js(`!!document.querySelector('.lu-library-item')`), 15000);
    if (!library) throw new Error("offline");
    await sleep(3000);
  }
  // The slot can hold a placeholder first. Decide only once it has stopped changing.
  await waitStable(`document.querySelector('[data-anchor="lu-profile-settings"]')?.innerHTML ?? ''`, 2000, 12000);
  const loggedOut = await js(`!!document.querySelector('.lu-profile-settings__login')`);
  return { loggedIn: !loggedOut };
}

// Shows edubase's own login (email, Office 365, Edulog, Google, Apple, …) and resolves
// true once the user is signed in, false if they close the window.
function login(parent, lang) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 520,
      height: 720,
      show: false,
      title: lang === "de" ? "Mit Edubase anmelden" : "Sign in with Edubase",
      webPreferences: { session: getSession() },
    });
    let finished = false;
    let sawForm = false; // the password form was on screen
    let wentAway = false; // a single-sign-on page (Microsoft, Edulog, …) was open
    let signedInChecks = 0;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      resolve(ok);
    };
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => finish(false));
    // Some sign-in providers open a popup. Allow those (https only), nothing else.
    win.webContents.setWindowOpenHandler(({ url }) =>
      url.startsWith("https://") ? { action: "allow" } : { action: "deny" },
    );

    const timer = setInterval(async () => {
      if (win.isDestroyed()) return;
      const url = win.webContents.getURL();
      if (!url.startsWith(BASE)) {
        wentAway = true; // somewhere in a single-sign-on flow
        return;
      }
      const s = await win.webContents
        .executeJavaScript(
          `({ hash: location.hash,
              form: [...document.querySelectorAll('input[type=password]')].some((i) => i.offsetParent),
              loginButton: !!document.querySelector('.lu-profile-settings__login'),
              header: ${HEADER_READY},
              library: !!document.querySelector('.lu-library-item, .lu-doc-pages') })`,
        )
        .catch(() => null);
      if (!s) return;
      if (s.form) sawForm = true;
      if (s.hash.startsWith("#promo")) {
        // The login popup closed after the user submitted it: go see whether it worked.
        if ((sawForm || wentAway) && !s.form) {
          sawForm = wentAway = false;
          win.webContents.executeJavaScript(`location.hash = '#library'`).catch(() => {});
        }
        return;
      }
      // Signed in = no Login button in a drawn header, three checks in a row (about 2 s),
      // so a header that is still being drawn does not count.
      signedInChecks = s.library && s.header && !s.loginButton ? signedInChecks + 1 : 0;
      if (signedInChecks >= 3) finish(true);
    }, 700);

    win.loadURL(BASE + "#promo?popup=login");
  });
}

async function logout() {
  if (worker && !worker.isDestroyed()) worker.destroy();
  worker = null;
  await getSession().clearStorageData();
  await getSession().clearCache();
}

// ---------------------------------------------------------------- library

async function library() {
  // Always load it fresh: after signing in, or when the user asks to reload.
  try {
    await open("#library");
  } catch {
    throw new Error("offline");
  }
  await waitFor(() => js(`document.querySelectorAll('.lu-library-item').length > 0`), 30000);

  // The list may render lazily: scroll until the number of items stops growing.
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const n = await js(`(() => {
      const items = document.querySelectorAll('.lu-library-item');
      items[items.length - 1]?.scrollIntoView();
      return items.length;
    })()`);
    if (n === last) break;
    last = n;
    await sleep(500);
  }

  const books = await js(`[...document.querySelectorAll('.lu-library-item[data-versionid]')].map((li) => ({
    id: li.dataset.versionid,
    title: (li.querySelector('.lu-library-item-title')?.textContent || li.querySelector('.lu-library-item-aux')?.title || '').trim(),
    cover: li.querySelector('img.lu-library-item-cover')?.src || '',
  }))`);

  // Covers come from edubase's server; fetch them with the signed-in session.
  await Promise.all(
    books.map(async (b) => {
      if (!/^https:\/\//.test(b.cover)) {
        b.cover = "";
        return;
      }
      try {
        const res = await getSession().fetch(b.cover);
        if (!res.ok) throw new Error(String(res.status));
        const buf = Buffer.from(await res.arrayBuffer());
        const type = buf[0] === 0x89 ? "image/png" : "image/jpeg";
        b.cover = `data:${type};base64,${buf.toString("base64")}`;
      } catch {
        b.cover = "";
      }
    }),
  );
  return books.filter((b) => b.id);
}

// ---------------------------------------------------------------- download

// A name that is safe as a file or folder name on macOS and Windows: no separators, no
// control characters, no dots at the start (hidden, or ".." = the folder above) or dots and
// spaces at the end (Windows drops them), and none of the names Windows keeps for devices.
function safeName(name, fallback = "Edubase-Buch") {
  const clean = String(name || "")
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150)
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "");
  return !clean || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean) ? fallback : clean;
}

function freePath(dir, name) {
  let p = path.join(dir, `${name}.pdf`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${name} (${i}).pdf`);
  return p;
}

async function readPager() {
  return js(`(() => {
    const m = (document.querySelector('[data-item=page-settings]')?.textContent || '').match(/\\/\\s*(\\d+)/);
    const page = location.hash.match(/^#doc\\/\\d+\\/([^/?]+)/);
    return { total: m ? +m[1] : 0, page: page ? decodeURIComponent(page[1]) : null };
  })()`);
}

// A small picture of the page being saved, for the progress view.
async function preview() {
  try {
    const r = await js(`(() => {
      const el = document.querySelector('.lu-doc-pages') || document.body;
      const b = el.getBoundingClientRect();
      return { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(innerWidth, b.width), height: Math.min(innerHeight, b.height) };
    })()`);
    // Zoom in the reader (⌘+) applies to every edubase page of the session, this one too:
    // the page measures in CSS pixels, the capture wants window points.
    const z = getWorker().webContents.getZoomFactor();
    const rect = r.width > 50 && r.height > 50 ? {
      x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.width * z), height: Math.round(r.height * z),
    } : undefined;
    const img = await getWorker().webContents.capturePage(rect);
    return img.resize({ width: 420 }).toDataURL();
  } catch {
    return null;
  }
}

// The book's table of contents as the PDF's own (the sidebar in Preview, Acrobat, GoodNotes):
// chapters link to their page, sub-chapters fold under them. `at` maps a page name to its
// index in the PDF; entries for pages that are not in it are left out.
function addOutline(doc, toc, at) {
  const entries = (toc || []).filter((e) => at.has(String(e.page)));
  if (!entries.length) return;
  const ctx = doc.context;
  const pages = doc.getPages();
  const root = { children: [] };
  const stack = [{ level: -1, node: root }];
  for (const e of entries) {
    const node = { e, children: [], ref: ctx.nextRef() };
    while (stack.length > 1 && stack[stack.length - 1].level >= e.level) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ level: e.level, node });
  }
  const outlinesRef = ctx.nextRef();
  const write = (list, parent) => {
    list.forEach((node, i) => {
      const dict = ctx.obj({});
      dict.set(PDFName.of("Title"), PDFHexString.fromText(node.e.title));
      dict.set(PDFName.of("Parent"), parent);
      if (i > 0) dict.set(PDFName.of("Prev"), list[i - 1].ref);
      if (i < list.length - 1) dict.set(PDFName.of("Next"), list[i + 1].ref);
      if (node.children.length) {
        dict.set(PDFName.of("First"), node.children[0].ref);
        dict.set(PDFName.of("Last"), node.children[node.children.length - 1].ref);
        dict.set(PDFName.of("Count"), PDFNumber.of(-node.children.length)); // folded
      }
      dict.set(PDFName.of("Dest"), ctx.obj([pages[at.get(String(node.e.page))].ref, PDFName.of("Fit")]));
      ctx.assign(node.ref, dict);
      write(node.children, node.ref);
    });
  };
  write(root.children, outlinesRef);
  const outlines = ctx.obj({});
  outlines.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlines.set(PDFName.of("First"), root.children[0].ref);
  outlines.set(PDFName.of("Last"), root.children[root.children.length - 1].ref);
  outlines.set(PDFName.of("Count"), PDFNumber.of(root.children.length));
  ctx.assign(outlinesRef, outlines);
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
}

// A PDF of pages 23 to 41 numbers its pages 23 to 41, like the book.
function addPageNumbers(doc, printed) {
  const first = Number(printed[0]);
  if (!(first > 1) || !printed.every((p, i) => p === String(first + i))) return;
  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: [0, { S: "D", St: first }] }));
}

// The table of contents, read from edubase's page in the hidden window (book.js must be in it).
// Edubase fills it a moment after the first page; a book without one gives [].
async function readToc(token, max = 10000) {
  const items = await waitFor(async () => {
    const list = await js(`window.__stapelBook ? window.__stapelBook.toc() : []`).catch(() => []);
    return Array.isArray(list) && list.length ? list : null;
  }, max, 400, token);
  return items || [];
}

/**
 * The table of contents of a book, without saving anything (for "Save chapters as PDF" when
 * the book was not opened in this app before).
 * @param {string} id
 * @param {{js: string, css: string}} assets  reader/ink.js and reader/book.js
 */
async function toc(id, assets) {
  try {
    await open(`#doc/${id}/1`);
    const opened = await waitFor(async () => {
      const p = await readPager();
      return p.total > 0 && p.page ? p : null;
    }, 45000, 250);
    if (!opened) throw new Error("noaccess");
    await js(assets.js);
    return await readToc();
  } finally {
    if (worker && !worker.isDestroyed()) worker.loadURL("about:blank").catch(() => {});
  }
}

/**
 * Save a book as one PDF.
 * @param {{id: string, title?: string, part?: string, from?: number, to?: number,
 *          outputDir: string, ink?: object, inkAssets: {js: string, css: string}}} job
 *   part: what of the book this is ("Chapter 3", "p. 23–41"); it goes into the file name.
 *   ink: the user's own notes per page (reader.js); they are drawn onto each page before it
 *   is printed. inkAssets: reader/ink.js and reader/book.js, and the notes' stylesheet.
 * @param {(p: object) => void} onProgress
 * @param {{cancelled: boolean}} token  set cancelled = true to stop
 * @returns {Promise<{path: string, pages: number, toc: object[]}>}
 */
async function download(job, onProgress, token) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "edubase-"));
  const files = [];
  const printed = []; // the page name of each file
  let wasDouble = false;
  try {
    onProgress({ phase: "open" });
    const from = job.from && job.from > 1 ? job.from : 1;
    await open(`#doc/${job.id}/${from}`);

    const opened = await waitFor(async () => {
      const p = await readPager();
      return p.total > 0 && p.page ? p : null;
    }, 45000, 250, token);
    if (!opened) {
      throw new Error("noaccess");
    }

    const title = job.title || (await js(`document.querySelector('.document-name__title')?.textContent.trim() || document.title`));
    if (from > opened.total) throw new Error("range");

    // One page per sheet. The reader's "two pages" choice is remembered by edubase and would
    // apply here too; switch it off for the print and back on afterwards.
    const isDouble = () => js(`/double/.test(document.querySelector('#docPageMode i')?.className || '')`);
    if (await isDouble()) {
      await js(`document.querySelector('[data-action=changePageMode]')?.click()`);
      wasDouble = !!(await waitFor(async () => !(await isDouble()), 10000, 150, token));
      if (!wasDouble) throw new Error("stalled");
      await js(`location.hash = '#doc/${job.id}/${from}'`);
      await waitFor(async () => String((await readPager()).page) === String(from), 10000, 150, token);
    }

    // Edubase prints a black frame around every page; a saved book reads better without.
    await getWorker().webContents.insertCSS("@media print { .doc-page-wrapper { border: 0 !important; } }");

    // The notes and the words of every page are drawn by the app's own scripts.
    await getWorker().webContents.insertCSS(job.inkAssets.css);
    await js(job.inkAssets.js);
    const ink = job.ink && Object.keys(job.ink).length ? job.ink : null;
    const tocRead = readToc(token).catch(() => []);
    const last = Math.min(job.to || opened.total, opened.total);
    const count = Math.max(1, last - from + 1);
    const started = Date.now();

    await waitIdle({ min: 1500, quiet: 900, max: 30000, token });

    for (let i = 0; i < count; i++) {
      if (token.cancelled) throw new Error("cancelled");

      if (i > 0) {
        const before = await readPager();
        let moved = null;
        for (let attempt = 0; attempt < 3 && !moved; attempt++) {
          await js(`document.querySelector('[data-action=footer-next-page]')?.click()`);
          moved = await waitFor(async () => (await readPager()).page !== before.page, 20000, 150, token);
        }
        if (!moved) {
          // The last page of the book: done. Anywhere else edubase stopped answering, and a
          // PDF with pages missing must not look finished.
          if (String(before.total) === String(before.page)) break;
          throw new Error("stalled");
        }
        await waitIdle({ token });
      }

      const page = String((await readPager()).page);
      if (ink) {
        const items = Object.prototype.hasOwnProperty.call(ink, page) ? ink[page] : [];
        await js(`window.__stapelInk.drawPage(${JSON.stringify(page)}, ${JSON.stringify(items)})`);
      }
      // The words as invisible text, so the PDF can be searched. A page whose words have not
      // arrived yet gets a second look; a page without text (a picture) has none.
      const layer = `window.__stapelBook.textLayerOf(${JSON.stringify(page)})`;
      if ((await js(layer)) === 0) {
        await sleep(500);
        await js(layer);
      }

      const pdf = await getWorker().webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
      });
      const file = path.join(tempDir, `${String(i).padStart(5, "0")}.pdf`);
      fs.writeFileSync(file, pdf);
      files.push(file);
      printed.push(page);

      const elapsed = Date.now() - started;
      onProgress({
        phase: "pages",
        current: i + 1,
        total: count,
        secondsLeft: Math.round(((elapsed / (i + 1)) * (count - i - 1)) / 1000),
        preview: await preview(),
      });
    }

    onProgress({ phase: "merge", current: files.length, total: count });
    const toc = await tocRead;
    const merged = await PDFDocument.create();
    const name = job.part ? `${title} – ${job.part}` : title;
    merged.setTitle(name);
    merged.setProducer("Stapel");
    const at = new Map();
    for (let i = 0; i < files.length; i++) {
      const doc = await PDFDocument.load(fs.readFileSync(files[i]));
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      if (!at.has(printed[i])) at.set(printed[i], merged.getPageCount());
      for (const p of copied) merged.addPage(p);
    }
    try {
      addOutline(merged, toc, at);
      addPageNumbers(merged, printed);
    } catch {
      // A table of contents that does not fit is left out; the pages are what counts.
    }
    fs.mkdirSync(job.outputDir, { recursive: true });
    const out = freePath(job.outputDir, safeName(name));
    fs.writeFileSync(out, await merged.save());
    return { path: out, pages: files.length, toc };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (wasDouble && worker && !worker.isDestroyed()) {
      await js(`document.querySelector('[data-action=changePageMode]')?.click()`).catch(() => {});
      await sleep(400);
    }
    // Leave the reader so edubase does not keep a "currently reading" state open.
    if (worker && !worker.isDestroyed()) worker.loadURL("about:blank").catch(() => {});
  }
}

module.exports = { init, status, login, logout, library, download, toc, safeName };

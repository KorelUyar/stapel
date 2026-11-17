// Everything that talks to edubase. Runs in Electron's main process and drives the real
// edubase web app in a hidden window, so there is no second browser (Puppeteer) to ship.
// Login happens on edubase's own page in a persistent session: the app never sees the password
// and stays signed in between launches.

const { BrowserWindow, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

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
  return worker;
}

const js = (code) => getWorker().webContents.executeJavaScript(code, true);

async function waitFor(check, timeout, every = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// Wait until the hidden window has no open requests for a moment and every image is decoded.
async function waitIdle({ min = 400, quiet = 600, max = 20000 } = {}) {
  const start = Date.now();
  let quietSince = null;
  while (Date.now() - start < max) {
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

async function open(hash) {
  const w = getWorker();
  inflight.clear();
  await w.loadURL("about:blank");
  await w.loadURL(BASE + hash);
}

// ---------------------------------------------------------------- session

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
  const ready = await waitFor(
    () => js(`!!document.querySelector('.lu-library-item, .lu-profile-settings__login')`),
    30000,
  );
  if (!ready) throw new Error("offline");
  await sleep(600);
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
    let sawForm = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      resolve(ok);
    };
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => finish(false));
    win.webContents.setWindowOpenHandler(() => ({ action: "allow" }));

    const timer = setInterval(async () => {
      if (win.isDestroyed()) return;
      const url = win.webContents.getURL();
      if (!url.startsWith(BASE)) return; // somewhere in a single-sign-on flow
      const s = await win.webContents
        .executeJavaScript(
          `({ hash: location.hash,
              form: [...document.querySelectorAll('input[type=password]')].some((i) => i.offsetParent),
              loginButton: !!document.querySelector('.lu-profile-settings__login'),
              library: !!document.querySelector('.lu-library-item, .lu-doc-pages') })`,
        )
        .catch(() => null);
      if (!s) return;
      if (s.form) sawForm = true;
      if (s.hash.startsWith("#promo")) {
        // The login popup closed after the user submitted it: go see whether it worked.
        if (sawForm && !s.form) {
          sawForm = false;
          win.webContents.executeJavaScript(`location.hash = '#library'`).catch(() => {});
        }
        return;
      }
      if (s.library && !s.loginButton) finish(true);
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
  // status() has just loaded #library; make sure we are there.
  const onLibrary = await js(`location.hash.startsWith('#library')`).catch(() => false);
  if (!onLibrary) await open("#library");
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
      if (!b.cover) return;
      try {
        const res = await getSession().fetch(b.cover);
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

function safeName(name) {
  return (name || "Edubase-Buch").replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 150);
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

/**
 * Save a book as one PDF.
 * @param {{id: string, title?: string, from?: number, to?: number, outputDir: string}} job
 * @param {(p: object) => void} onProgress
 * @param {{cancelled: boolean}} token  set cancelled = true to stop
 */
async function download(job, onProgress, token) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "edubase-"));
  const files = [];
  try {
    onProgress({ phase: "open" });
    const from = job.from && job.from > 1 ? job.from : 1;
    await open(`#doc/${job.id}/${from}`);

    const opened = await waitFor(async () => {
      const p = await readPager();
      return p.total > 0 && p.page ? p : null;
    }, 45000);
    if (!opened) {
      throw new Error("noaccess");
    }

    const title = job.title || (await js(`document.title`));
    const last = Math.min(job.to || opened.total, opened.total);
    const count = Math.max(1, last - from + 1);
    const started = Date.now();

    await waitIdle({ min: 1500, quiet: 900, max: 30000 });

    for (let i = 0; i < count; i++) {
      if (token.cancelled) throw new Error("cancelled");

      if (i > 0) {
        const before = (await readPager()).page;
        await js(`document.querySelector('[data-action=footer-next-page]')?.click()`);
        const moved = await waitFor(async () => (await readPager()).page !== before, 15000, 150);
        if (!moved) break; // end of the book
        await waitIdle();
      }

      const pdf = await getWorker().webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
      });
      const file = path.join(tempDir, `${String(i).padStart(5, "0")}.pdf`);
      fs.writeFileSync(file, pdf);
      files.push(file);

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
    const merged = await PDFDocument.create();
    merged.setTitle(title);
    merged.setProducer("Stapel");
    for (const file of files) {
      const doc = await PDFDocument.load(fs.readFileSync(file));
      for (const p of await merged.copyPages(doc, doc.getPageIndices())) merged.addPage(p);
    }
    fs.mkdirSync(job.outputDir, { recursive: true });
    const out = freePath(job.outputDir, safeName(title));
    fs.writeFileSync(out, await merged.save());
    return { path: out, pages: files.length };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    // Leave the reader so edubase does not keep a "currently reading" state open.
    if (worker && !worker.isDestroyed()) worker.loadURL("about:blank").catch(() => {});
  }
}

module.exports = { init, status, login, logout, library, download };

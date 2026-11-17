const $ = (id) => document.getElementById(id);
const EDUBASE = "https://app.edubase.ch/";

const state = {
  loggedIn: false,
  books: [],
  screen: "boot",
  reading: null, // book open in the reader
  book: null, // book in the PDF sheet
  running: false,
  result: null,
  range: "all",
  bootError: null,
};

const errorText = (err) => (STRINGS.en["err." + err.message] ? t("err." + err.message) : err.message);

// ------------------------------------------------------------ screens

function show(screen) {
  state.screen = screen;
  for (const id of ["boot", "welcome", "library", "reader"]) $(id).hidden = id !== screen;
  const reading = screen === "reader";
  $("backBtn").hidden = !reading;
  $("pdfBtn").hidden = !reading;
  $("barTitle").textContent = reading ? state.reading?.title || "" : "Stapel";
  $("barTitle").classList.toggle("reading", reading);
  $("logoutBtn").hidden = !(screen === "library" && state.loggedIn);
  $("folderBtn").hidden = screen !== "library";
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3500);
}

function bootMessage(key) {
  state.bootError = null;
  $("bootText").textContent = t(key);
  $("retryBtn").hidden = true;
}

function bootFail(err) {
  state.bootError = err;
  $("bootText").textContent = errorText(err);
  $("retryBtn").hidden = false;
}

async function boot() {
  show("boot");
  bootMessage("connecting");
  try {
    const { loggedIn } = await window.app.status();
    state.loggedIn = loggedIn;
    if (loggedIn) await loadLibrary();
    else show("welcome");
  } catch (err) {
    bootFail(err);
  }
}

async function loadLibrary({ quiet = false } = {}) {
  if (!quiet) {
    show("boot");
    bootMessage("loadingLibrary");
  }
  $("reloadBtn").classList.add("spin");
  try {
    state.books = await window.app.library();
    $("guestNote").hidden = state.loggedIn;
    show("library");
    renderGrid();
  } catch (err) {
    if (quiet) toast(errorText(err));
    else bootFail(err);
  } finally {
    $("reloadBtn").classList.remove("spin");
  }
}

// ------------------------------------------------------------ library grid

const palette = ["#1f6e59", "#e3a92b", "#e0654a", "#3d5a80", "#8a5a44"];

function renderGrid() {
  const q = $("search").value.trim().toLowerCase();
  const books = state.books.filter((b) => b.title.toLowerCase().includes(q));
  const grid = $("grid");
  grid.replaceChildren();

  books.forEach((book, i) => {
    const card = document.createElement("button");
    card.className = "card";
    card.style.animationDelay = `${Math.min(i, 12) * 30}ms`;

    const cover = document.createElement("div");
    cover.className = "cover";
    cover.dataset.label = t("read");
    if (book.cover) {
      const img = document.createElement("img");
      img.src = book.cover;
      img.alt = "";
      cover.append(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "no-cover";
      ph.style.background = palette[i % palette.length];
      ph.textContent = book.title;
      cover.append(ph);
    }

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = book.title;

    card.append(cover, title);
    card.addEventListener("click", () => openBook(book));
    grid.append(card);
  });

  $("libCount").textContent = t("books", state.books.length);
  $("empty").hidden = books.length > 0;
}

// ------------------------------------------------------------ reader

const view = $("view");

function openBook(book) {
  state.reading = book;
  window.app.opened(book.id);
  show("reader");
  view.src = `${EDUBASE}#doc/${book.id}`;
}

function closeBook() {
  if (state.running) return;
  closeSheet();
  view.src = "about:blank";
  state.reading = null;
  show(state.books.length ? "library" : "welcome");
  if (state.screen === "library") renderGrid(); // the language may have changed meanwhile
}

// The reader is edubase itself: the user can move to another book inside it. Keep track,
// so "Save as PDF" always means the book on screen.
view.addEventListener("did-navigate-in-page", (e) => {
  // edubase's own "Library" button: go back to the app's library instead.
  if (state.screen === "reader" && /#library/.test(e.url)) return closeBook();
  const m = e.url.match(/#doc\/(\d+)/);
  if (!m || !state.reading || m[1] === state.reading.id) return;
  state.reading = state.books.find((b) => b.id === m[1]) || { id: m[1], title: "", cover: "" };
  if (!state.reading.title) {
    view.executeJavaScript("document.title").then((title) => {
      if (state.reading && !state.reading.title) {
        state.reading.title = title;
        $("barTitle").textContent = title;
      }
    }).catch(() => {});
  }
  $("barTitle").textContent = state.reading.title;
});

// ------------------------------------------------------------ PDF sheet

function sheetState(name) {
  for (const s of ["Idle", "Run", "Done", "Fail"]) $("state" + s).hidden = s !== name;
  $("sheet").classList.toggle("done", name === "Done");
}

async function openSheet(book) {
  if (state.running) return;
  state.book = book;
  state.result = null;
  $("sheetTitle").textContent = book.title || "";
  $("sheetCover").src = book.cover || "";
  $("sheetCover").hidden = !book.cover;
  $("sheetPreview").classList.remove("show");
  $("sheetPreview").removeAttribute("src");
  $("fromPage").value = 1;
  $("toPage").value = "";
  setRange("all");
  await refreshFolder();
  sheetState("Idle");
  $("scrim").hidden = false;
  $("sheet").hidden = false;
  $("startBtn").focus();
}

function closeSheet() {
  if (state.running) return;
  $("scrim").hidden = true;
  $("sheet").hidden = true;
}

function setRange(r) {
  state.range = r;
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.range === r);
  $("rangeFields").hidden = r !== "part";
}

async function start() {
  const book = { id: state.book.id, title: state.book.title };
  if (state.range === "part") {
    const from = parseInt($("fromPage").value, 10) || 1;
    const to = parseInt($("toPage").value, 10) || undefined;
    if (to && to < from) return toast(t("rangeError"));
    book.from = from;
    book.to = to;
  }

  state.running = true;
  sheetState("Run");
  $("runText").textContent = t("opening");
  $("runEta").textContent = "";
  $("fill").style.width = "0";
  $("fill").classList.add("wait");
  $("cancelBtn").disabled = false;

  try {
    state.result = await window.app.download(book);
    $("doneText").textContent = t("saved", state.result.pages, fileName(state.result.path));
    sheetState("Done");
    if (state.book.cover) $("sheetPreview").classList.remove("show"); // back to the cover
    $("openBtn").focus();
  } catch (err) {
    if (err.message === "cancelled") {
      sheetState("Idle");
      toast(t("cancelled"));
    } else {
      $("failText").textContent = errorText(err);
      sheetState("Fail");
    }
  } finally {
    state.running = false;
  }
}

window.app.onProgress((p) => {
  const fill = $("fill");
  if (p.phase === "open") {
    $("runText").textContent = t("opening");
  } else if (p.phase === "pages") {
    fill.classList.remove("wait");
    fill.style.width = `${(p.current / p.total) * 100}%`;
    $("runText").textContent = t("pageOf", p.current, p.total);
    $("runEta").textContent = p.secondsLeft >= 5 ? t("left", p.secondsLeft) : "";
    if (p.preview) {
      $("sheetPreview").src = p.preview;
      $("sheetPreview").classList.add("show");
    }
  } else if (p.phase === "merge") {
    fill.style.width = "100%";
    $("runText").textContent = t("merging");
    $("runEta").textContent = "";
  }
});

// ------------------------------------------------------------ helpers

const fileName = (p) => p.split("/").pop();
const folderLabel = (p) => p.split("/").filter(Boolean).pop() || p;

async function refreshFolder() {
  const { outputDir, downloads } = await window.app.settings();
  const name = outputDir === downloads ? t("downloads") : folderLabel(outputDir);
  $("folderName").textContent = name;
  $("folderBtn").title = t("folderTitle", outputDir);
  $("saveWhere").textContent = t("savesIn", name);
}

async function setLanguage(lang) {
  applyLanguage(lang);
  window.app.setLang(LANG);
  await refreshFolder();
  if (state.screen === "library") renderGrid();
  if (state.screen === "boot") {
    if (state.bootError) $("bootText").textContent = errorText(state.bootError);
    else $("bootText").textContent = t(state.loggedIn ? "loadingLibrary" : "connecting");
  }
}

// A pasted edubase link (…/#doc/12345/1) opens that book.
document.addEventListener("paste", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const m = e.clipboardData.getData("text").match(/#doc\/(\d+)/);
  if (!m) return;
  e.preventDefault();
  closeSheet();
  openBook(state.books.find((b) => b.id === m[1]) || { id: m[1], title: "", cover: "" });
});

// ------------------------------------------------------------ wiring

$("retryBtn").onclick = boot;

$("loginBtn").onclick = $("guestLoginBtn").onclick = async () => {
  try {
    if (!(await window.app.login())) return;
    state.loggedIn = true;
    await loadLibrary();
  } catch (err) {
    toast(errorText(err));
  }
};

$("guestBtn").onclick = () => loadLibrary();

$("logoutBtn").onclick = async () => {
  view.src = "about:blank";
  await window.app.logout();
  state.loggedIn = false;
  state.books = [];
  show("welcome");
};

$("reloadBtn").onclick = () => loadLibrary({ quiet: true });
$("search").oninput = renderGrid;

$("folderBtn").onclick = async () => {
  await window.app.chooseFolder();
  refreshFolder();
};

$("backBtn").onclick = closeBook;
$("pdfBtn").onclick = () => state.reading && openSheet(state.reading);

for (const b of document.querySelectorAll(".seg button")) b.onclick = () => setRange(b.dataset.range);
for (const b of document.querySelectorAll("#langSwitch button")) b.onclick = () => setLanguage(b.dataset.lang);

$("startBtn").onclick = start;
$("againBtn").onclick = start;
$("cancelBtn").onclick = () => {
  $("cancelBtn").disabled = true;
  $("runText").textContent = t("cancelling");
  window.app.cancel();
};
$("openBtn").onclick = () => window.app.openFile(state.result.path);
$("revealBtn").onclick = () => window.app.reveal(state.result.path);
$("closeSheet").onclick = closeSheet;
$("scrim").onclick = closeSheet;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});

window.app.settings().then(async ({ lang }) => {
  applyLanguage(lang);
  await refreshFolder();
  boot();
});

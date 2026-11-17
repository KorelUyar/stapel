const $ = (id) => document.getElementById(id);

const state = {
  loggedIn: false,
  books: [],
  book: null, // the book open in the sheet
  running: false,
  result: null,
  range: "all",
};

// ------------------------------------------------------------ screens

function show(screen) {
  for (const id of ["boot", "welcome", "library"]) $(id).hidden = id !== screen;
  $("logoutBtn").hidden = !(screen === "library" && state.loggedIn);
  $("folderBtn").hidden = screen !== "library";
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function boot() {
  show("boot");
  $("bootText").textContent = "Verbinde mit Edubase …";
  $("retryBtn").hidden = true;
  try {
    const { loggedIn } = await window.app.status();
    state.loggedIn = loggedIn;
    if (loggedIn) await loadLibrary();
    else show("welcome");
  } catch (err) {
    $("bootText").textContent = err.message;
    $("retryBtn").hidden = false;
  }
}

async function loadLibrary({ quiet = false } = {}) {
  if (!quiet) {
    show("boot");
    $("bootText").textContent = "Lade deine Bücher …";
  }
  $("reloadBtn").classList.add("spin");
  try {
    state.books = await window.app.library();
    $("guestNote").hidden = state.loggedIn;
    show("library");
    renderGrid();
  } catch (err) {
    if (quiet) toast(err.message);
    else {
      $("bootText").textContent = err.message;
      $("retryBtn").hidden = false;
    }
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
    card.addEventListener("click", () => openSheet(book));
    grid.append(card);
  });

  const n = state.books.length;
  $("libCount").textContent = n === 1 ? "1 Buch" : `${n} Bücher`;
  $("empty").hidden = books.length > 0;
}

// ------------------------------------------------------------ sheet

function sheetState(name) {
  for (const s of ["Idle", "Run", "Done", "Fail"]) $("state" + s).hidden = s !== name;
  $("sheet").classList.toggle("done", name === "Done");
}

async function openSheet(book) {
  if (state.running) return;
  state.book = book;
  state.result = null;
  $("sheetTitle").textContent = book.title || `Buch ${book.id}`;
  $("sheetCover").src = book.cover || "";
  $("sheetCover").hidden = !book.cover;
  $("sheetPreview").classList.remove("show");
  $("sheetPreview").removeAttribute("src");
  $("fromPage").value = 1;
  $("toPage").value = "";
  setRange("all");
  const { outputDir, downloads } = await window.app.settings();
  $("saveWhere").textContent =
    "Wird in " + (outputDir === downloads ? "Downloads" : folderLabel(outputDir)) + " gespeichert.";
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

function formatEta(s) {
  if (!s || s < 5) return "";
  if (s < 60) return `noch ${Math.round(s / 5) * 5} s`;
  return `noch ${Math.ceil(s / 60)} Min.`;
}

async function start() {
  const book = { id: state.book.id, title: state.book.title };
  if (state.range === "part") {
    const from = parseInt($("fromPage").value, 10) || 1;
    const to = parseInt($("toPage").value, 10) || undefined;
    if (to && to < from) return toast("Die Endseite muss nach der Startseite kommen.");
    book.from = from;
    book.to = to;
  }

  state.running = true;
  sheetState("Run");
  $("runText").textContent = "Buch wird geöffnet …";
  $("runEta").textContent = "";
  $("fill").style.width = "0";
  $("fill").classList.add("wait");
  $("cancelBtn").disabled = false;

  try {
    state.result = await window.app.download(book);
    const n = state.result.pages;
    $("doneText").textContent = `${n} ${n === 1 ? "Seite" : "Seiten"} gespeichert als «${fileName(state.result.path)}».`;
    sheetState("Done");
    if (state.book.cover) $("sheetPreview").classList.remove("show"); // back to the cover
    $("openBtn").focus();
  } catch (err) {
    if (err.message === "cancelled") {
      sheetState("Idle");
      toast("Abgebrochen.");
    } else {
      $("failText").textContent = err.message;
      sheetState("Fail");
    }
  } finally {
    state.running = false;
  }
}

window.app.onProgress((p) => {
  const fill = $("fill");
  if (p.phase === "open") {
    $("runText").textContent = "Buch wird geöffnet …";
  } else if (p.phase === "pages") {
    fill.classList.remove("wait");
    fill.style.width = `${(p.current / p.total) * 100}%`;
    $("runText").textContent = `Seite ${p.current} von ${p.total}`;
    $("runEta").textContent = formatEta(p.secondsLeft);
    if (p.preview) {
      const img = $("sheetPreview");
      img.src = p.preview;
      img.classList.add("show");
    }
  } else if (p.phase === "merge") {
    fill.style.width = "100%";
    $("runText").textContent = "PDF wird zusammengesetzt …";
    $("runEta").textContent = "";
  }
});

// ------------------------------------------------------------ helpers

const fileName = (p) => p.split("/").pop();
const folderLabel = (p) => p.split("/").filter(Boolean).pop() || p;

async function refreshFolder() {
  const { outputDir, downloads } = await window.app.settings();
  $("folderName").textContent = outputDir === downloads ? "Downloads" : folderLabel(outputDir);
  $("folderBtn").title = "Speichert in " + outputDir + " · klicken zum Ändern";
}

// A pasted edubase link (…/#doc/12345/1) opens that book directly.
document.addEventListener("paste", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const text = e.clipboardData.getData("text");
  const m = text.match(/#doc\/(\d+)(?:\/(\d+))?/);
  if (!m) return;
  e.preventDefault();
  const known = state.books.find((b) => b.id === m[1]);
  openSheet(known || { id: m[1], title: "", cover: "" });
  if (m[2] && +m[2] > 1) {
    setRange("part");
    $("fromPage").value = m[2];
  }
});

// ------------------------------------------------------------ wiring

$("retryBtn").onclick = boot;

$("loginBtn").onclick = $("guestLoginBtn").onclick = async () => {
  try {
    const ok = await window.app.login();
    if (!ok) return;
    state.loggedIn = true;
    await loadLibrary();
  } catch (err) {
    toast(err.message);
  }
};

$("guestBtn").onclick = () => loadLibrary();

$("logoutBtn").onclick = async () => {
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

for (const b of document.querySelectorAll(".seg button")) b.onclick = () => setRange(b.dataset.range);

$("startBtn").onclick = start;
$("againBtn").onclick = start;
$("cancelBtn").onclick = () => {
  $("cancelBtn").disabled = true;
  $("runText").textContent = "Wird abgebrochen …";
  window.app.cancel();
};
$("openBtn").onclick = () => window.app.openFile(state.result.path);
$("revealBtn").onclick = () => window.app.reveal(state.result.path);
$("closeSheet").onclick = closeSheet;
$("scrim").onclick = closeSheet;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});

refreshFolder();
boot();

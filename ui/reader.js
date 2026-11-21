// The reader's own interface. Edubase draws the page inside the <webview>; the toolbar, the
// side panel and the page bar here are the app's. They talk to the page through the main
// process (window.app.reader), never directly.

const view = $("view");

const TOOL_COLORS = {
  pen: ["#1d1c1a", "#2456c7", "#d13a2c", "#1f8a5b", "#e58a1f", "#7b4bb7"],
  hl: ["#ffd400", "#7ddc6f", "#ff8fc7", "#7cc4ff", "#ffb347"],
  text: ["#1d1c1a", "#2456c7", "#d13a2c", "#1f8a5b", "#e58a1f", "#7b4bb7"],
};
const TOOL_SIZES = { pen: [1.4, 2.4, 4.4], hl: [10, 18, 28], text: [13, 18, 26] };

const r = {
  ready: false,
  id: null,
  page: null,
  pages: [],
  total: 0,
  zoom: "",
  double: false,
  canUndo: false,
  canRedo: false,
  tool: "hand",
  color: { pen: TOOL_COLORS.pen[1], hl: TOOL_COLORS.hl[0], text: TOOL_COLORS.text[0] },
  size: { pen: 1, hl: 1, text: 1 }, // index into TOOL_SIZES
  toc: [],
  marks: [],
  notes: [],
  find: null, // { q, items } | { q, busy: true }
  tab: "toc",
  side: false,
  classic: false,
  fallback: false, // edubase's own view for this book only, because the app's reader cannot show it
  failed: false,
  timer: null,
};

try {
  const saved = JSON.parse(localStorage.getItem("stapel.tools") || "{}");
  for (const k of ["pen", "hl", "text"]) {
    if (TOOL_COLORS[k].includes(saved.color?.[k])) r.color[k] = saved.color[k];
    if ([0, 1, 2].includes(saved.size?.[k])) r.size[k] = saved.size[k];
  }
  r.side = saved.side === true;
} catch {}

function saveToolPrefs() {
  try {
    localStorage.setItem("stapel.tools", JSON.stringify({ color: r.color, size: r.size, side: r.side }));
  } catch {}
}

const cmd = (name, arg) => window.app.reader(name, arg);
const pageNumber = () => (/^\d+$/.test(r.page || "") ? +r.page : null);

// ------------------------------------------------------------ opening and closing a book

function openBook(book) {
  if (state.running) return;
  closePop();
  state.reading = book;
  window.app.opened(book.id);
  Object.assign(r, { ready: false, id: null, page: null, pages: [], total: 0, zoom: "", canUndo: false, canRedo: false, toc: [], marks: [], notes: [], find: null, failed: false });
  $("findInput").value = "";
  show("reader");
  renderReader();
  coverReader(true);
  // Always with a page: without one edubase opens where it last saw the book, and that is
  // the last page after the book was saved as PDF.
  const start = book.progress && book.progress.page > 1 ? book.progress.page : 1;
  view.src = `${EDUBASE}#doc/${book.id}/${start}`;
}

function closeBook() {
  if (state.running) return;
  closeSheet();
  clearTimeout(r.timer);
  // Remember where the reader stopped, so the library shows it right away.
  if (state.reading && r.ready && pageNumber()) {
    const b = bookById(state.reading.id);
    if (b) b.progress = { page: pageNumber(), total: r.total };
    if (b) b.seen = Date.now();
  }
  view.src = "about:blank";
  state.reading = null;
  r.ready = false;
  if (r.fallback) {
    r.fallback = false;
    r.classic = false;
    window.app.setClassic(false, false);
    document.documentElement.classList.remove("classic");
  }
  show(state.books.length ? "library" : "welcome");
  if (state.screen === "library") {
    renderLibrary();
    refreshMarks();
  }
}

// The page area is covered until edubase has drawn the book, so its own interface never shows.
function coverReader(on, failed = false) {
  clearTimeout(r.timer);
  r.failed = failed;
  $("readerCover").hidden = !on || r.classic;
  $("readerCover").classList.toggle("failed", failed);
  $("readerCoverText").textContent = failed ? t("err.noaccess") : t("opening");
  $("readerRetryBtn").hidden = !failed;
  // No page after half a minute: edubase did not answer, or the book is of a kind this
  // reader does not know. Then edubase's own view is better than nothing.
  if (on && !failed) r.timer = setTimeout(() => (r.id ? fallBack() : coverReader(true, true)), 30000);
}

function fallBack() {
  if (r.classic || !state.reading) return;
  r.fallback = true;
  toast(t("fallbackNote"));
  setClassic(true, false);
}

$("readerRetryBtn").onclick = () => {
  if (!state.reading) return;
  coverReader(true);
  view.reload();
};

// ------------------------------------------------------------ what the page reports

window.app.onReader((type, data) => {
  if (state.screen !== "reader" || r.classic) return;
  if (type === "state") {
    const wasReady = r.ready;
    const bookChanged = r.id && data.id && data.id !== r.id;
    Object.assign(r, data);
    if (bookChanged) Object.assign(r, { toc: [], marks: [], notes: [], find: null });
    if (data.id && state.reading && data.id !== state.reading.id) {
      // A link inside the book led to another one.
      state.reading = bookById(data.id) || { id: data.id, title: data.title, cover: "" };
    }
    if (state.reading && !state.reading.title && data.title) state.reading.title = data.title;
    $("barTitle").textContent = state.reading?.title || data.title || "";
    if (!r.ready && data.blocked && !r.failed) coverReader(true, true);
    if (!r.ready && data.unsupported) return fallBack();
    if (r.ready && !wasReady) {
      coverReader(false);
      sendTool();
      // Edubase laid the page out before the side panel had its size.
      setTimeout(() => cmd("resize"), 60);
    }
    renderReader();
  } else if (type === "toc") {
    if (data.id === r.id || !r.id) r.toc = data.items;
    renderPanel();
  } else if (type === "notes") {
    r.marks = data.bookmarks;
    r.notes = data.pages;
    renderReader();
  } else if (type === "search") {
    r.find = data;
    renderPanel();
  } else if (type === "key") {
    if (data === "find") openFind();
    if (data === "escape") setTool("hand");
  }
});

// Edubase's own view (the fallback): only the book on screen is tracked.
view.addEventListener("did-navigate-in-page", (e) => {
  if (!r.classic) return;
  if (state.screen === "reader" && /#library/.test(e.url)) return closeBook();
  const m = e.url.match(/#doc\/(\d+)/);
  if (!m || !state.reading || m[1] === state.reading.id) return;
  state.reading = bookById(m[1]) || { id: m[1], title: "", cover: "" };
  $("barTitle").textContent = state.reading.title;
});

// ------------------------------------------------------------ drawing the reader

function renderReader() {
  document.documentElement.classList.toggle("classic", r.classic);
  const n = pageNumber();
  const busy = !r.ready;

  for (const b of document.querySelectorAll("#toolset button")) {
    b.classList.toggle("on", b.dataset.tool === r.tool);
    // The bar under pen, highlighter and text shows the colour that tool writes in.
    if (r.color[b.dataset.tool]) b.style.setProperty("--c", r.color[b.dataset.tool]);
  }
  renderToolOptions();
  $("undoBtn").disabled = !r.canUndo;
  $("redoBtn").disabled = !r.canRedo;
  $("spreadBtn").classList.toggle("on", r.double);
  $("markBtn").classList.toggle("on", r.pages.some((p) => r.marks.includes(p)));
  $("sideBtn").classList.toggle("on", r.side);
  $("readerSide").hidden = !r.side;

  if (document.activeElement !== $("pageInput")) $("pageInput").value = r.double && r.pages.length > 1 ? r.pages.join("–") : r.page || "";
  $("pageTotal").textContent = r.total ? t("ofPages", r.total) : "";
  const slider = $("pageSlider");
  slider.max = Math.max(1, r.total);
  slider.disabled = busy || !n;
  if (n && !slider.matches(":active")) slider.value = n;
  slider.style.setProperty("--fill", `${r.total > 1 && n ? ((n - 1) / (r.total - 1)) * 100 : 0}%`);
  $("zoomText").textContent = /\d/.test(r.zoom) ? r.zoom.replace(/\s/g, "").replace(/%?$/, "%") : "";
  for (const id of ["prevBtn", "nextBtn", "zoomOutBtn", "zoomInBtn", "fitBtn", "spreadBtn", "markBtn", "findBtn"]) $(id).disabled = busy;
  if (n) {
    $("prevBtn").disabled = busy || n <= 1;
    $("nextBtn").disabled = busy || n + (r.double ? r.pages.length - 1 : 0) >= r.total;
  }
  renderPanel();
}

function renderToolOptions() {
  const kind = TOOL_COLORS[r.tool] ? r.tool : null;
  $("toolOptions").hidden = !kind;
  if (!kind) return;
  const swatches = $("swatches");
  swatches.replaceChildren();
  for (const c of TOOL_COLORS[kind]) {
    const b = el("button", "swatch" + (c === r.color[kind] ? " on" : ""));
    b.style.setProperty("--c", c);
    b.title = c;
    b.onclick = () => {
      r.color[kind] = c;
      saveToolPrefs();
      sendTool();
      renderReader();
    };
    swatches.append(b);
  }
  const sizes = $("sizes");
  sizes.replaceChildren();
  TOOL_SIZES[kind].forEach((_, i) => {
    const b = el("button", `size s${i} k-${kind}` + (i === r.size[kind] ? " on" : "") + (kind === "text" ? " letter" : ""));
    b.title = t(["sizeS", "sizeM", "sizeL"][i]);
    b.append(kind === "text" ? el("span", "", "A") : el("span", "line"));
    b.onclick = () => {
      r.size[kind] = i;
      saveToolPrefs();
      sendTool();
      renderToolOptions();
    };
    sizes.append(b);
  });
}

function sendTool() {
  const kind = TOOL_COLORS[r.tool] ? r.tool : null;
  const size = kind ? TOOL_SIZES[kind][r.size[kind]] : undefined;
  cmd("tool", { name: r.tool, color: kind ? r.color[kind] : undefined, width: kind && kind !== "text" ? size : undefined, size: kind === "text" ? size : undefined });
}

function setTool(name) {
  if (r.tool === name) return;
  r.tool = name;
  sendTool();
  renderReader();
}

// ------------------------------------------------------------ the side panel

const byPage = (a, b) => (+a || 0) - (+b || 0) || String(a).localeCompare(String(b));

function row(className, label, page, onClick) {
  const b = el("button", "prow " + className);
  b.append(el("span", "prow-label", label));
  if (page !== null) b.append(el("span", "prow-page", String(page)));
  b.onclick = onClick;
  return b;
}

function hint(text) {
  return el("p", "fine panel-hint", text);
}

function renderPanel() {
  if (!r.side) return;
  for (const b of document.querySelectorAll("#readerTabs button")) b.classList.toggle("on", b.dataset.tab === r.tab);
  const panels = { toc: "panelToc", marks: "panelMarks", notes: "panelNotes", find: "panelFind" };
  for (const [tab, id] of Object.entries(panels)) $(id).hidden = tab !== r.tab;
  const n = pageNumber();

  if (r.tab === "toc") {
    const box = $("panelToc");
    const top = box.scrollTop;
    box.replaceChildren();
    if (!r.toc.length) box.append(hint(r.ready ? t("noContents") : t("opening")));
    // The chapter being read: the entry that starts closest before this page (the deepest
    // one when several start on the same page).
    let current = -1;
    if (n) {
      r.toc.forEach((item, i) => {
        if (+item.page <= n && (current < 0 || +item.page >= +r.toc[current].page)) current = i;
      });
    }
    r.toc.forEach((item, i) => {
      const b = row(`toc l${item.level}` + (i === current ? " on" : ""), item.title, item.page, () => cmd("go", item.page));
      box.append(b);
    });
    box.scrollTop = top;
  } else if (r.tab === "marks") {
    const box = $("panelMarks");
    box.replaceChildren();
    if (!r.marks.length) box.append(hint(t("noBookmarks")));
    for (const page of r.marks.slice().sort(byPage)) {
      const b = row("mark" + (r.pages.includes(page) ? " on" : ""), t("page", page), null, () => cmd("go", page));
      b.prepend(icon("bookmark"));
      const remove = el("span", "prow-remove");
      remove.title = t("removeBookmark");
      remove.append(icon("close"));
      remove.onclick = async (e) => {
        e.stopPropagation();
        const s = await window.app.bookmark(r.id, page);
        r.marks = s.bookmarks;
        renderReader();
      };
      b.append(remove);
      box.append(b);
    }
  } else if (r.tab === "notes") {
    const box = $("panelNotes");
    box.replaceChildren();
    if (!r.notes.length) box.append(hint(t("noNotes")));
    for (const note of r.notes.slice().sort((a, b) => byPage(a.page, b.page))) {
      const b = el("button", "prow note" + (r.pages.includes(note.page) ? " on" : ""));
      const head = el("span", "prow-label", t("page", note.page));
      const what = [];
      if (note.strokes) what.push(t("drawings", note.strokes));
      if (note.texts.length) what.push(t("notesN", note.texts.length));
      b.append(head, el("span", "prow-page", what.join(", ")));
      for (const text of note.texts.slice(0, 3)) b.append(el("span", "prow-quote", text));
      b.onclick = () => cmd("go", note.page);
      box.append(b);
    }
  } else {
    const list = $("findList");
    list.replaceChildren();
    const f = r.find;
    $("findInfo").textContent = !f ? t("findHint") : f.busy ? t("searching") : f.items.length ? t("foundPages", f.items.length) : f.q ? t("nothingFound", f.q) : t("findHint");
    for (const item of f && !f.busy ? f.items.slice().sort((a, b) => byPage(a.page, b.page)) : []) {
      const b = el("button", "prow hit");
      b.append(el("span", "prow-label", t("page", item.page)));
      const quote = el("span", "prow-quote");
      for (const part of item.parts) quote.append(part.hit ? el("mark", "", part.t) : document.createTextNode(part.t));
      b.append(quote);
      b.onclick = () => cmd("searchGo", item.idx);
      list.append(b);
    }
  }
}

function setSide(on, tab) {
  r.side = on;
  if (tab) r.tab = tab;
  saveToolPrefs();
  renderReader();
  // The page area changed its width: let edubase centre the page again.
  setTimeout(() => cmd("resize"), 220);
}

function openFind() {
  setSide(true, "find");
  setTimeout(() => $("findInput").select(), 60);
}

// ------------------------------------------------------------ wiring

$("backBtn").onclick = closeBook;
$("sideBtn").onclick = () => setSide(!r.side);
for (const b of document.querySelectorAll("#toolset button")) b.onclick = () => setTool(b.dataset.tool);
for (const b of document.querySelectorAll("#readerTabs button")) {
  b.onclick = () => {
    r.tab = b.dataset.tab;
    renderPanel();
    if (r.tab === "find") $("findInput").focus();
  };
}

$("undoBtn").onclick = () => cmd("undo");
$("redoBtn").onclick = () => cmd("redo");
$("prevBtn").onclick = () => cmd("prev");
$("nextBtn").onclick = () => cmd("next");
$("zoomOutBtn").onclick = () => cmd("zoomOut");
$("zoomInBtn").onclick = () => cmd("zoomIn");
$("fitBtn").onclick = () => cmd("fit");
$("spreadBtn").onclick = () => cmd("spread");
$("findBtn").onclick = () => (r.side && r.tab === "find" ? setSide(false) : openFind());

$("markBtn").onclick = async () => {
  if (!r.id || !r.page) return;
  // With two pages on screen, the bookmark that is there is the one to take away.
  const marked = r.pages.find((p) => r.marks.includes(p));
  const s = await window.app.bookmark(r.id, marked || r.page);
  r.marks = s.bookmarks;
  renderReader();
};

$("pageInput").onkeydown = (e) => {
  if (e.key === "Enter") {
    const n = parseInt($("pageInput").value, 10);
    if (n >= 1 && (!r.total || n <= r.total)) cmd("go", String(n));
    $("pageInput").blur();
  } else if (e.key === "Escape") {
    $("pageInput").blur();
  }
};
$("pageInput").onfocus = () => $("pageInput").select();
$("pageInput").onblur = () => renderReader();
$("pageSlider").oninput = () => ($("pageInput").value = $("pageSlider").value);
$("pageSlider").onchange = () => cmd("go", $("pageSlider").value);

$("findForm").onsubmit = (e) => {
  e.preventDefault();
  const q = $("findInput").value.trim();
  r.find = q ? { q, busy: true, items: [] } : null;
  renderPanel();
  cmd("search", q);
};
$("findInput").addEventListener("search", () => {
  if (!$("findInput").value) $("findForm").requestSubmit();
});

$("moreBtn").onclick = () => {
  const items = [];
  const here = r.notes.filter((n) => r.pages.includes(n.page));
  if (here.length) {
    items.push({ label: t("clearPage"), icon: "trash", danger: true, onClick: () => here.forEach((n) => cmd("clearPage", n.page)) }, { sep: true });
  }
  items.push({ label: t("classicView"), icon: "spread", checked: r.classic, onClick: () => setClassic(!r.classic) });
  openMenu($("moreBtn"), items, { align: "right" });
};

// Edubase's own interface instead of the app's: the way out if edubase changes its pages
// and the app's reader stops working.
async function setClassic(on, persist = true) {
  r.classic = on;
  if (persist) r.fallback = false;
  await window.app.setClassic(on, persist);
  renderReader();
  if (state.reading) {
    coverReader(!on);
    const at = `/${pageNumber() || (state.reading.progress && state.reading.progress.page) || 1}`;
    const id = state.reading.id;
    view.src = "about:blank";
    setTimeout(() => {
      if (state.reading && state.reading.id === id) view.src = `${EDUBASE}#doc/${id}${at}`;
    }, 80);
  }
}
$("classicOffBtn").onclick = () => setClassic(false);

// Keys while the focus is in the app's own interface (the page has the same ones).
document.addEventListener("keydown", (e) => {
  if (state.screen !== "reader" || r.classic || !$("sheet").hidden) return;
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openFind();
  } else if (typing) {
    return;
  } else if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
    e.preventDefault();
    cmd(e.shiftKey || e.key.toLowerCase() === "y" ? "redo" : "undo");
  } else if (mod && (e.key === "+" || e.key === "=")) {
    e.preventDefault();
    cmd("zoomIn");
  } else if (mod && e.key === "-") {
    e.preventDefault();
    cmd("zoomOut");
  } else if (mod && e.key === "0") {
    e.preventDefault();
    cmd("fit");
  } else if (e.key === "ArrowRight" || e.key === "PageDown") {
    cmd("next");
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    cmd("prev");
  } else if (e.key === "Escape" && $("pop").hidden) {
    setTool("hand");
  }
});

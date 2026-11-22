// Saving PDFs: one book (whole, some chapters or a range of pages), or several books one
// after the other.

// ------------------------------------------------------------ chapters

// The chapters to choose from: the entries of the table of contents at the first level that
// has more than one (some books put everything under one title). Only entries with a page
// number can mark a range.
function chapterList(toc) {
  const numbered = (toc || []).filter((e) => /^\d+$/.test(e.page));
  const levels = [...new Set(numbered.map((e) => e.level))].sort((a, b) => a - b);
  const level = levels.find((l) => numbered.filter((e) => e.level === l).length > 1) ?? levels[0];
  return numbered.filter((e) => e.level === level);
}

// From the start of the first chosen chapter to the page before the next chapter (or the end).
function chapterRange() {
  const list = state.chapters || [];
  const a = +$("fromChapter").value;
  const b = Math.max(a, +$("toChapter").value);
  if (!list[a] || !list[b]) return null;
  const from = +list[a].page;
  const next = list.slice(b + 1).find((e) => +e.page > from);
  const to = next ? Math.max(from, +next.page - 1) : undefined;
  const part = a === b ? list[a].title : t("partChapters", list[a].title, list[b].title);
  return { from, to, part };
}

function renderChapterInfo() {
  const range = chapterRange();
  $("chapterInfo").textContent = !range ? "" : range.to ? t("chapterPages", range.from, range.to) : t("chapterToEnd", range.from);
}

function fillChapters(toc) {
  state.chapters = chapterList(toc);
  const list = state.chapters;
  const fields = $("chapterFields");
  fields.classList.toggle("empty", !list.length);
  for (const id of ["fromChapter", "toChapter"]) {
    const select = $(id);
    select.replaceChildren(...list.map((e, i) => {
      const o = el("option", "", e.title.length > 64 ? e.title.slice(0, 62) + " …" : e.title);
      o.value = String(i);
      return o;
    }));
    select.disabled = !list.length;
  }
  $("chapterInfo").textContent = list.length ? "" : t("noChapters");
  if (list.length) renderChapterInfo();
}

// The table of contents of the book in the sheet: the reader's own when the book is open,
// else the one kept from earlier, else edubase is asked (once, when Chapters is chosen).
async function loadChapters(book, lookUp) {
  if (state.reading && state.reading.id === book.id && r.toc.length) return fillChapters(r.toc);
  if (!lookUp) {
    const known = await window.app.toc(book.id, false).catch(() => null);
    if (state.book !== book) return;
    state.toc = known;
    if (known) fillChapters(known);
    else if (state.range === "chapter") loadChapters(book, true);
    return;
  }
  $("chapterInfo").textContent = t("tocLoading");
  for (const id of ["fromChapter", "toChapter"]) $(id).disabled = true;
  try {
    const items = await window.app.toc(book.id, true);
    if (state.book !== book) return;
    state.toc = items || [];
    fillChapters(state.toc);
  } catch (err) {
    if (state.book !== book) return;
    $("chapterInfo").textContent = errorText(err);
  }
}

$("fromChapter").onchange = () => {
  if (+$("toChapter").value < +$("fromChapter").value) $("toChapter").value = $("fromChapter").value;
  renderChapterInfo();
};
$("toChapter").onchange = () => {
  if (+$("toChapter").value < +$("fromChapter").value) $("fromChapter").value = $("toChapter").value;
  renderChapterInfo();
};

function sheetState(name) {
  for (const s of ["Idle", "Run", "Done", "Fail"]) $("state" + s).hidden = s !== name;
  $("sheet").classList.toggle("done", name === "Done" && !state.batch);
}

// While the sheet is open, nothing behind it can be reached, with the keyboard either.
function behindSheet(inert) {
  for (const node of document.querySelectorAll(".bar, .screen, .selbar")) node.inert = inert;
}

function showSheet() {
  $("scrim").hidden = false;
  $("sheet").hidden = false;
  behindSheet(true);
  closePop();
}

async function openSheet(book) {
  if (state.running) return;
  state.book = book;
  state.batch = null;
  state.result = null;
  $("sheet").classList.remove("batch");
  $("sheetTitle").textContent = book.title || "";
  $("sheetCoverBox").hidden = false;
  $("sheetCover").src = book.cover || "";
  $("sheetCover").hidden = !book.cover;
  $("sheetPreview").classList.remove("show");
  $("sheetPreview").removeAttribute("src");
  $("batchList").hidden = true;
  $("rangeSeg").hidden = false;
  $("fromPage").value = 1;
  $("toPage").value = "";
  state.toc = undefined;
  state.chapters = null;
  fillChapters([]);
  $("chapterInfo").textContent = "";
  $("byFolderOpt").hidden = true;
  $("notesOpt").hidden = true;
  $("notesCheck").checked = true;
  $("startBtn").textContent = t("saveButton");
  $("openBtn").textContent = t("openPdf");
  $("revealBtn").hidden = false;
  setRange("all");
  await refreshFolder();
  sheetState("Idle");
  showSheet();
  $("startBtn").focus();
  loadChapters(book, false);
  // Offer the notes only when there are some on this book.
  const notes = await window.app.notes(book.id).catch(() => null);
  if (state.book === book && notes) $("notesOpt").hidden = !notes.count;
}

// Several books. Each row of the list shows how far that book is.
async function openBatch(books) {
  if (state.running || !books.length) return;
  state.book = null;
  state.result = null;
  state.batch = { books, rows: new Map(), results: null };
  $("sheet").classList.add("batch");
  $("sheetTitle").textContent = t("booksToPdf", books.length);
  $("sheetCoverBox").hidden = true;
  $("rangeSeg").hidden = true;
  $("rangeFields").hidden = true;
  $("chapterFields").hidden = true;
  const list = $("batchList");
  list.replaceChildren();
  list.hidden = false;
  for (const book of books) {
    const row = el("div", "brow");
    row.append(el("span", "brow-mark"), el("span", "brow-title", book.title), el("span", "brow-status"));
    state.batch.rows.set(book.id, row);
    list.append(row);
  }
  $("notesOpt").hidden = !books.some((b) => b.notes);
  $("notesCheck").checked = true;
  $("byFolderOpt").hidden = !books.some((b) => state.shelf[b.id]);
  $("byFolderCheck").checked = true;
  $("startBtn").textContent = t("saveNPdfs", books.length);
  $("openBtn").textContent = t("reveal");
  $("revealBtn").hidden = true;
  await refreshFolder();
  sheetState("Idle");
  showSheet();
  $("startBtn").focus();
}

function closeSheet() {
  if (state.running) return;
  $("scrim").hidden = true;
  $("sheet").hidden = true;
  behindSheet(false);
}

function setRange(range) {
  state.range = range;
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.range === range);
  $("rangeFields").hidden = range !== "part";
  $("chapterFields").hidden = range !== "chapter";
  if (range === "chapter" && state.book && !state.chapters?.length && state.toc === null) loadChapters(state.book, true);
}

function beginRun() {
  state.running = true;
  $("closeSheet").hidden = true; // while it runs, Cancel is the only way out
  sheetState("Run");
  $("runText").textContent = t("opening");
  $("runEta").textContent = "";
  $("fill").style.width = "0";
  $("fill").classList.add("wait");
  $("cancelBtn").disabled = false;
}

async function start() {
  if (state.batch) return startBatch();
  const book = { id: state.book.id, title: state.book.title, notes: $("notesOpt").hidden || $("notesCheck").checked };
  if (state.range === "part") {
    const from = parseInt($("fromPage").value, 10) || 1;
    const to = parseInt($("toPage").value, 10) || undefined;
    if (to && to < from) return toast(t("rangeError"));
    book.from = from;
    book.to = to;
    book.part = t("partPages", from, to);
  } else if (state.range === "chapter") {
    const range = chapterRange();
    if (!range) return toast(t("noChapters"));
    Object.assign(book, range);
  }
  beginRun();
  try {
    state.result = await window.app.download(book);
    $("doneText").textContent = t("saved", state.result.pages, fileName(state.result.path));
    sheetState("Done");
    if (state.book.cover) $("sheetPreview").classList.remove("show"); // back to the cover
    $("openBtn").focus();
    if (state.range === "all") {
      const b = bookById(book.id);
      if (b) b.pdf = true;
      if (state.screen === "library") renderLibrary();
    }
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
    $("closeSheet").hidden = false;
  }
}

function batchRow(id, kind, text) {
  const row = state.batch?.rows.get(id);
  if (!row) return;
  row.className = "brow " + kind;
  row.lastChild.textContent = text;
  if (kind === "run") row.scrollIntoView({ block: "nearest" });
}

async function startBatch() {
  const batch = state.batch;
  for (const book of batch.books) batchRow(book.id, "", "");
  beginRun();
  $("runText").textContent = t("bookOf", 1, batch.books.length);
  try {
    const results = await window.app.downloadMany(
      batch.books.map((b) => ({ id: b.id, title: b.title })),
      { notes: $("notesOpt").hidden || $("notesCheck").checked, byFolder: !$("byFolderOpt").hidden && $("byFolderCheck").checked },
    );
    batch.results = results;
    const ok = results.filter((res) => res.ok);
    for (const res of results) {
      if (res.ok) {
        batchRow(res.id, "ok", t("pagesShort", res.pages));
        const b = bookById(res.id);
        if (b) b.pdf = true;
      } else {
        batchRow(res.id, res.error === "cancelled" ? "skip" : "bad", res.error === "cancelled" ? t("notSaved") : errorText(new Error(res.error)));
      }
    }
    if (state.screen === "library") renderLibrary();
    if (!ok.length) {
      const cancelled = results.every((res) => res.error === "cancelled");
      if (cancelled) {
        sheetState("Idle");
        toast(t("cancelled"));
      } else {
        $("failText").textContent = t("noneSaved");
        sheetState("Fail");
      }
    } else {
      $("doneText").textContent = t("savedMany", ok.length, results.length);
      sheetState("Done");
      $("openBtn").focus();
    }
  } catch (err) {
    $("failText").textContent = errorText(err);
    sheetState("Fail");
  } finally {
    state.running = false;
    $("closeSheet").hidden = false;
  }
}

window.app.onProgress((p) => {
  const fill = $("fill");
  if (p.batch && state.batch) {
    // Several books: the bar is the whole job, each row shows its own book.
    const { index, count, id } = p.batch;
    if (p.phase === "book") {
      const res = p.result;
      if (res.ok) batchRow(res.id, "ok", t("pagesShort", res.pages));
      else batchRow(res.id, res.error === "cancelled" ? "skip" : "bad", res.error === "cancelled" ? t("notSaved") : errorText(new Error(res.error)));
      return;
    }
    const part = p.phase === "pages" ? p.current / p.total : p.phase === "merge" ? 1 : 0;
    if (p.phase === "open") batchRow(id, "run", t("openingShort"));
    if (p.phase === "pages") batchRow(id, "run", `${p.current} / ${p.total}`);
    if (p.phase !== "open" || index > 0) fill.classList.remove("wait");
    fill.style.width = `${((index + part) / count) * 100}%`;
    if (!$("cancelBtn").disabled) $("runText").textContent = t("bookOf", index + 1, count);
    $("runEta").textContent = "";
    return;
  }
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

// ------------------------------------------------------------ wiring

$("pdfBtn").onclick = () => state.reading && openSheet(state.reading);
for (const b of document.querySelectorAll(".seg button")) b.onclick = () => setRange(b.dataset.range);

$("startBtn").onclick = start;
$("againBtn").onclick = start;
$("cancelBtn").onclick = () => {
  $("cancelBtn").disabled = true;
  $("runText").textContent = t("cancelling");
  window.app.cancel();
};
$("openBtn").onclick = () => (state.batch ? window.app.openFolder() : window.app.openPdf());
$("revealBtn").onclick = () => window.app.revealPdf();
$("closeSheet").onclick = closeSheet;
$("scrim").onclick = closeSheet;

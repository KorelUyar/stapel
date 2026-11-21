// Saving PDFs: one book (whole or a range of pages), or several books one after the other.

function sheetState(name) {
  for (const s of ["Idle", "Run", "Done", "Fail"]) $("state" + s).hidden = s !== name;
  $("sheet").classList.toggle("done", name === "Done" && !state.batch);
}

function showSheet() {
  $("scrim").hidden = false;
  $("sheet").hidden = false;
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
  $("byFolderOpt").hidden = true;
  $("notesOpt").hidden = true;
  $("notesCheck").checked = true;
  $("startBtn").textContent = t("saveButton");
  $("openBtn").textContent = t("openPdf");
  setRange("all");
  await refreshFolder();
  sheetState("Idle");
  showSheet();
  $("startBtn").focus();
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
  await refreshFolder();
  sheetState("Idle");
  showSheet();
  $("startBtn").focus();
}

function closeSheet() {
  if (state.running) return;
  $("scrim").hidden = true;
  $("sheet").hidden = true;
}

function setRange(range) {
  state.range = range;
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.range === range);
  $("rangeFields").hidden = range !== "part";
}

function beginRun() {
  state.running = true;
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
  }
  $("runBook").hidden = true;
  beginRun();
  try {
    state.result = await window.app.download(book);
    $("doneText").textContent = t("saved", state.result.pages, fileName(state.result.path));
    sheetState("Done");
    if (state.book.cover) $("sheetPreview").classList.remove("show"); // back to the cover
    $("openBtn").focus();
    if (!book.from && !book.to) {
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
  $("runBook").hidden = false;
  $("runBook").textContent = t("bookOf", 1, batch.books.length);
  beginRun();
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
  }
}

window.app.onProgress((p) => {
  const fill = $("fill");
  if (p.batch && state.batch) {
    $("runBook").textContent = t("bookOf", p.batch.index + 1, p.batch.count);
    if (p.phase === "book") {
      const res = p.result;
      if (res.ok) batchRow(res.id, "ok", t("pagesShort", res.pages));
      else batchRow(res.id, res.error === "cancelled" ? "skip" : "bad", res.error === "cancelled" ? t("notSaved") : errorText(new Error(res.error)));
      return;
    }
    if (p.phase === "open") batchRow(p.batch.id, "run", t("openingShort"));
    if (p.phase === "pages") batchRow(p.batch.id, "run", `${p.current} / ${p.total}`);
  }
  if (p.phase === "open") {
    fill.classList.add("wait");
    fill.style.width = "0";
    $("runText").textContent = t("opening");
    $("runEta").textContent = "";
  } else if (p.phase === "pages") {
    fill.classList.remove("wait");
    fill.style.width = `${(p.current / p.total) * 100}%`;
    $("runText").textContent = t("pageOf", p.current, p.total);
    $("runEta").textContent = p.secondsLeft >= 5 ? t("left", p.secondsLeft) : "";
    if (p.preview && !state.batch) {
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

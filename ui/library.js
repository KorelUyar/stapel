// The library: books, the user's own folders, picking several books at once.

const palette = ["#1f6e59", "#e3a92b", "#e0654a", "#3d5a80", "#8a5a44"];
const DRAG_TYPE = "application/x-stapel-books";

async function loadLibrary({ quiet = false } = {}) {
  if (!quiet) {
    show("boot");
    bootMessage("loadingLibrary");
  }
  $("reloadBtn").classList.add("spin");
  try {
    const [books, shelf] = await Promise.all([window.app.library(), window.app.shelf()]);
    state.books = books;
    state.folders = shelf.folders;
    state.shelf = shelf.shelf;
    state.sort = shelf.sort;
    if (state.folder && !folderById(state.folder)) state.folder = null;
    for (const id of [...state.selected]) if (!bookById(id)) state.selected.delete(id);
    $("guestNote").hidden = state.loggedIn;
    if (state.screen !== "reader") show("library");
    renderLibrary();
  } catch (err) {
    if (quiet) toast(errorText(err));
    else bootFail(err);
  } finally {
    $("reloadBtn").classList.remove("spin");
  }
}

// Reading positions, notes and saved PDFs change while the app is used; edubase is not asked.
async function refreshMarks() {
  const marks = await window.app.marks().catch(() => null);
  if (!marks) return;
  for (const b of state.books) {
    b.progress = marks.progress[b.id] || null;
    b.notes = marks.notes[b.id] || 0;
    b.pdf = !!marks.pdfs[b.id];
  }
  if (state.screen === "library") renderLibrary();
}

const bookById = (id) => state.books.find((b) => b.id === id);
const folderById = (id) => state.folders.find((f) => f.id === id);
const booksIn = (folderId) => state.books.filter((b) => (state.shelf[b.id] || null) === folderId);

function saveShelf() {
  return window.app.saveShelf({ folders: state.folders, shelf: state.shelf, sort: state.sort });
}

function sorted(books) {
  const list = books.slice();
  if (state.sort === "title") list.sort((a, b) => a.title.localeCompare(b.title, LANG, { numeric: true }));
  else list.sort((a, b) => b.seen - a.seen || a.i - b.i);
  return list;
}

// The books on screen right now (a search looks through every folder).
function visibleBooks() {
  const q = $("search").value.trim().toLowerCase();
  if (q) return sorted(state.books.filter((b) => b.title.toLowerCase().includes(q)));
  return sorted(booksIn(state.folder));
}

// The books "Select all" means: at the top level every book, also those inside folders.
function selectableBooks() {
  const q = $("search").value.trim();
  return q || state.folder ? visibleBooks() : state.books;
}

// ------------------------------------------------------------ drawing the library

function renderLibrary() {
  const q = $("search").value.trim();
  const folder = folderById(state.folder);
  const books = visibleBooks();

  $("crumbRoot").hidden = !folder;
  $("folderDot").hidden = !folder;
  $("folderEditBtn").hidden = !folder;
  $("libTitle").textContent = folder ? folder.name : t("library");
  if (folder) $("folderDot").style.background = folder.color;
  const counts = [t("books", folder ? booksIn(folder.id).length : state.books.length)];
  if (!folder && state.folders.length) counts.push(t("folders", state.folders.length));
  $("libCount").textContent = counts.join(", ");

  // Folders show at the top level, and not while searching.
  const row = $("folders");
  row.replaceChildren();
  row.hidden = !!folder || !!q || !state.folders.length;
  if (!row.hidden) for (const f of state.folders) row.append(folderTile(f));

  const grid = $("grid");
  grid.replaceChildren();
  books.forEach((book, i) => grid.append(bookCard(book, i, !!q)));
  grid.classList.toggle("selecting", state.selecting);

  const empty = $("empty");
  empty.hidden = books.length > 0;
  if (!books.length) {
    empty.textContent = q ? t("noBooks") : folder ? t("emptyFolder") : state.books.length ? t("allFiled") : t("noBooks");
  }
  $("pasteHint").hidden = state.selecting;
  renderSelection();
}

function coverOf(book, i) {
  if (book.cover) {
    const img = el("img");
    img.src = book.cover;
    img.alt = "";
    img.draggable = false;
    return img;
  }
  const ph = el("div", "no-cover", book.title);
  ph.style.background = palette[i % palette.length];
  return ph;
}

function bookCard(book, i, showFolder) {
  const card = el("div", "card");
  card.dataset.id = book.id;
  card.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
  card.classList.toggle("picked", state.selected.has(book.id));
  card.draggable = true;

  const cover = el("button", "cover");
  cover.dataset.label = t("read");
  cover.append(coverOf(book, i));
  if (book.progress && book.progress.total > 1 && book.progress.page > 1) {
    const bar = el("span", "cover-progress");
    const fill = el("span");
    fill.style.width = `${Math.min(100, (book.progress.page / book.progress.total) * 100)}%`;
    bar.append(fill);
    cover.append(bar);
  }
  cover.onclick = () => (state.selecting ? togglePick(book.id) : openBook(book));

  const pick = el("button", "pick");
  pick.title = t("select");
  pick.append(icon("tick"));
  pick.onclick = (e) => {
    e.stopPropagation();
    togglePick(book.id);
  };

  const more = el("button", "card-more");
  more.title = t("more");
  more.append(icon("more"));
  more.onclick = (e) => {
    e.stopPropagation();
    bookMenu(more, book);
  };

  const title = el("div", "card-title", book.title);
  const meta = el("div", "card-meta");
  const folder = showFolder && folderById(state.shelf[book.id]);
  if (folder) {
    const tag = el("span", "tag");
    const dot = el("span", "tag-dot");
    dot.style.background = folder.color;
    tag.append(dot, el("span", "", folder.name));
    meta.append(tag);
  }
  if (book.progress && book.progress.page > 1) meta.append(el("span", "", t("pageShort", book.progress.page, book.progress.total)));
  if (book.pdf) {
    const pdf = el("button", "tag pdf-tag", "PDF");
    pdf.title = t("openSavedPdf");
    pdf.onclick = async (e) => {
      e.stopPropagation();
      if (!(await window.app.openBookPdf(book.id))) toast(t("pdfGone"));
    };
    meta.append(pdf);
  }
  if (book.notes) {
    const n = el("span", "tag note-tag");
    n.title = t("hasNotes");
    n.append(icon("pen"));
    meta.append(n);
  }

  card.append(cover, pick, more, title, meta);
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    bookMenu(more, book);
  });
  card.addEventListener("dragstart", (e) => {
    const ids = state.selecting && state.selected.has(book.id) ? [...state.selected] : [book.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    document.body.classList.add("dragging-books");
    closePop();
  });
  card.addEventListener("dragend", () => document.body.classList.remove("dragging-books"));
  return card;
}

// A folder looks like one: the first covers peek out of a pocket in the folder's colour.
function folderTile(folder) {
  const books = sorted(booksIn(folder.id));
  const tile = el("div", "folder");
  tile.dataset.id = folder.id;
  tile.style.setProperty("--c", folder.color);

  const open = el("button", "folder-open");
  const art = el("span", "folder-art");
  art.append(el("span", "folder-back"));
  books.slice(0, 3).forEach((b, i) => {
    const peek = el("span", `folder-peek p${i + 1}`);
    peek.append(coverOf(b, i));
    art.append(peek);
  });
  art.append(el("span", "folder-front"));
  open.append(art, el("span", "folder-name", folder.name), el("span", "folder-count", t("books", books.length)));
  open.onclick = () => {
    state.folder = folder.id;
    $("library").scrollTop = 0;
    renderLibrary();
  };

  // While books are being picked, a folder stands for the books in it.
  if (state.selecting && books.length) {
    const n = books.filter((b) => state.selected.has(b.id)).length;
    const pick = el("button", "pick" + (n === books.length ? " all" : n ? " some" : ""));
    pick.title = t("select");
    if (n && n < books.length) pick.append(el("span", "", String(n)));
    else pick.append(icon("tick"));
    pick.onclick = (e) => {
      e.stopPropagation();
      for (const b of books) {
        if (n === books.length) state.selected.delete(b.id);
        else state.selected.add(b.id);
      }
      renderLibrary();
    };
    tile.append(pick);
  }

  const more = el("button", "folder-more");
  more.title = t("editFolder");
  more.append(icon("more"));
  more.onclick = (e) => {
    e.stopPropagation();
    editFolder(more, folder);
  };
  tile.append(open, more);
  tile.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    editFolder(more, folder);
  });
  dropTarget(tile, (ids) => moveBooks(ids, folder.id));
  return tile;
}

function dropTarget(node, onDrop) {
  const ours = (e) => [...e.dataTransfer.types].includes(DRAG_TYPE);
  node.addEventListener("dragover", (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    node.classList.add("drop");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop"));
  node.addEventListener("drop", (e) => {
    node.classList.remove("drop");
    if (!ours(e)) return;
    e.preventDefault();
    try {
      const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
      if (Array.isArray(ids)) onDrop(ids.map(String));
    } catch {}
  });
}

// ------------------------------------------------------------ folders

const newFolderId = () => "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function createFolder(bookIds = []) {
  const used = new Set(state.folders.map((f) => f.color));
  const color = state.folderColors.find((c) => !used.has(c)) || state.folderColors[state.folders.length % state.folderColors.length];
  const names = new Set(state.folders.map((f) => f.name));
  let name = t("newFolderName");
  for (let i = 2; names.has(name); i++) name = `${t("newFolderName")} ${i}`;
  const folder = { id: newFolderId(), name, color };
  state.folders.push(folder);
  for (const id of bookIds) state.shelf[id] = folder.id;
  saveShelf();
  state.folder = null;
  $("search").value = "";
  renderLibrary();
  const tile = document.querySelector(`.folder[data-id="${folder.id}"] .folder-more`);
  if (tile) {
    tile.scrollIntoView({ block: "nearest" });
    editFolder(tile, folder, true);
  }
  return folder;
}

function moveBooks(ids, folderId) {
  let moved = 0;
  for (const id of ids) {
    if (!bookById(id) || (state.shelf[id] || null) === folderId) continue;
    if (folderId) state.shelf[id] = folderId;
    else delete state.shelf[id];
    moved++;
  }
  if (!moved) return;
  saveShelf();
  renderLibrary();
  const folder = folderById(folderId);
  toast(folder ? t("movedTo", moved, folder.name) : t("movedOut", moved));
}

function deleteFolder(folder) {
  state.folders = state.folders.filter((f) => f.id !== folder.id);
  for (const id of Object.keys(state.shelf)) if (state.shelf[id] === folder.id) delete state.shelf[id];
  if (state.folder === folder.id) state.folder = null;
  saveShelf();
  renderLibrary();
}

// Name, colour, and what can be done with a folder.
function editFolder(anchor, folder, isNew = false) {
  openPop(anchor, (pop) => {
    pop.classList.add("folder-edit");
    const name = el("input");
    name.type = "text";
    name.maxLength = 60;
    name.value = folder.name;
    name.spellcheck = false;
    name.placeholder = t("folderName");
    const commit = () => {
      const next = name.value.replace(/\s+/g, " ").trim();
      if (!next || next === folder.name) return;
      folder.name = next;
      saveShelf();
      renderLibraryKeepingPop();
    };
    name.onchange = commit;
    name.onkeydown = (e) => {
      if (e.key === "Enter") {
        commit();
        closePop();
      }
    };

    const colors = el("div", "color-row");
    for (const c of state.folderColors) {
      const b = el("button", "color" + (c === folder.color ? " on" : ""));
      b.style.background = c;
      b.title = c;
      b.onclick = () => {
        folder.color = c;
        for (const other of colors.children) other.classList.toggle("on", other === b);
        saveShelf();
        renderLibraryKeepingPop();
      };
      colors.append(b);
    }
    pop.append(name, colors);

    const action = (iconName, label, onClick, danger) => {
      const b = el("button", "menu-item" + (danger ? " danger" : ""));
      b.append(icon(iconName), el("span", "menu-label", label));
      b.onclick = () => {
        commit();
        closePop();
        onClick();
      };
      return b;
    };
    pop.append(el("div", "menu-sep"));
    const inside = booksIn(folder.id);
    if (inside.length) pop.append(action("download", t("saveFolderPdf"), () => openBatch(sorted(inside))));
    pop.append(action("trash", t("deleteFolder"), () => deleteFolder(folder), true));
    pop.append(el("p", "fine pop-note", t("deleteFolderNote")));
    setTimeout(() => {
      name.focus();
      if (isNew) name.select();
    }, 30);
  });
}

// Redraw behind the open folder editor without closing it.
function renderLibraryKeepingPop() {
  const pop = $("pop");
  const wasOpen = !pop.hidden;
  const owner = popOwner;
  renderLibrary();
  if (wasOpen) {
    pop.hidden = false;
    popOwner = owner;
  }
}

// ------------------------------------------------------------ one book's menu

function folderChoices(ids, current) {
  const items = [{ head: t("moveTo") }];
  for (const f of state.folders) {
    items.push({ label: f.name, dot: f.color, checked: current === f.id, onClick: () => moveBooks(ids, f.id) });
  }
  items.push({ label: t("newFolder"), icon: "folderPlus", onClick: () => createFolder(ids) });
  if (ids.some((id) => state.shelf[id])) items.push({ label: t("removeFromFolder"), icon: "folderOut", onClick: () => moveBooks(ids, null) });
  return items;
}

function bookMenu(anchor, book) {
  const items = [
    { label: t("read"), icon: "book", onClick: () => openBook(book) },
    { label: t("savePdf"), icon: "download", onClick: () => openSheet(book) },
  ];
  if (book.pdf) {
    items.push({
      label: t("openSavedPdf"),
      icon: "pdf",
      onClick: async () => {
        if (!(await window.app.openBookPdf(book.id))) toast(t("pdfGone"));
      },
    });
  }
  items.push({ sep: true }, ...folderChoices([book.id], state.shelf[book.id] || null));
  items.push({ sep: true }, { label: t("select"), icon: "check", onClick: () => togglePick(book.id) });
  openMenu(anchor, items, { align: "right" });
}

// ------------------------------------------------------------ picking several books

function setSelecting(on) {
  state.selecting = on;
  if (!on) state.selected.clear();
  $("selBar").hidden = !(on && state.screen === "library");
  $("selectBtn").classList.toggle("on", on);
  renderLibrary();
}

function togglePick(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  if (!state.selecting) return setSelecting(true);
  document.querySelector(`.card[data-id="${id}"]`)?.classList.toggle("picked", state.selected.has(id));
  renderSelection();
}

function renderSelection() {
  const n = state.selected.size;
  const shown = selectableBooks();
  const all = shown.length > 0 && shown.every((b) => state.selected.has(b.id));
  $("selCount").textContent = t("selected", n);
  $("selAllBtn").textContent = all ? t("selectNone") : t("selectAll");
  $("selAllBtn").hidden = !shown.length;
  $("selMoveBtn").disabled = !n;
  $("selPdfBtn").disabled = !n;
}

// ------------------------------------------------------------ wiring

$("search").oninput = renderLibrary;
$("reloadBtn").onclick = () => loadLibrary({ quiet: true });
$("newFolderBtn").onclick = () => createFolder();
$("selectBtn").onclick = () => setSelecting(!state.selecting);
$("selDoneBtn").onclick = () => setSelecting(false);
$("folderEditBtn").onclick = () => {
  const folder = folderById(state.folder);
  if (folder) editFolder($("folderEditBtn"), folder);
};
$("crumbRoot").onclick = () => {
  state.folder = null;
  renderLibrary();
};
dropTarget($("crumbRoot"), (ids) => moveBooks(ids, null));

$("sortBtn").onclick = () => {
  const choose = (sort) => () => {
    state.sort = sort;
    saveShelf();
    renderLibrary();
  };
  openMenu(
    $("sortBtn"),
    [
      { head: t("sort") },
      { label: t("sortRecent"), checked: state.sort === "recent", onClick: choose("recent") },
      { label: t("sortTitle"), checked: state.sort === "title", onClick: choose("title") },
    ],
    { align: "right" },
  );
};

$("selAllBtn").onclick = () => {
  const shown = selectableBooks();
  const all = shown.every((b) => state.selected.has(b.id));
  for (const b of shown) {
    if (all) state.selected.delete(b.id);
    else state.selected.add(b.id);
  }
  renderLibrary();
};

$("selMoveBtn").onclick = () => {
  const ids = [...state.selected];
  openMenu($("selMoveBtn"), folderChoices(ids, null).slice(1));
};

$("selPdfBtn").onclick = () => {
  const books = sorted(state.books.filter((b) => state.selected.has(b.id)));
  if (books.length === 1) openSheet(books[0]);
  else if (books.length) openBatch(books);
};

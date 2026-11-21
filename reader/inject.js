// Runs inside edubase's page in the reader <webview>. Edubase keeps drawing the pages; this
// script reports what is on screen, takes commands from the app's own toolbar, and holds the
// user's own notes on top of the pages. Everything here depends on edubase's markup.
(() => {
  if (window.__stapel) return;
  const ink = window.__stapelInk;
  const host = window.__stapelHost; // from reader-preload.js
  const post = (type, data) => {
    try {
      host && host.post(type, data);
    } catch {}
  };
  const q = (s, root = document) => root.querySelector(s);
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const click = (s) => {
    const el = q(s);
    if (el) el.click();
    return !!el;
  };

  // ------------------------------------------------------------ what is on screen

  const where = () => {
    const m = location.hash.match(/^#doc\/(\d+)(?:\/([^/?]+))?/);
    return m ? { id: m[1], page: m[2] ? decodeURIComponent(m[2]) : null } : { id: null, page: null };
  };
  const wrappers = () => qa(".lu-doc-pages .doc-page-wrapper").filter((w) => w.dataset.pageid && w.dataset.pageid !== "dummy");
  const total = () => {
    const m = (q("[data-item=page-settings]")?.textContent || "").match(/\/\s*(\d+)/);
    return m ? +m[1] : 0;
  };

  let lastState = "";
  let tocFor = null;
  let readySince = { id: null, at: 0 };
  let inkFor = null;

  function report() {
    const at = where();
    const pages = wrappers().map((w) => w.dataset.pageid);
    const state = {
      id: at.id,
      page: at.page,
      pages,
      total: total(),
      zoom: q("[data-item=zoom] input")?.value || "",
      double: /double/.test(q("#docPageMode i")?.className || ""),
      title: (q(".document-name__title")?.textContent || "").trim().slice(0, 300),
      canUndo: undo.length > 0,
      canRedo: redo.length > 0,
    };
    state.ready = !!(state.id && state.total > 0 && pages.length > 0);
    // Edubase answers a book it will not open with a message box ("no read rights").
    const box = q(".modal.show");
    state.blocked = !state.ready && !!box && getComputedStyle(box).display !== "none";
    // Books in edubase's other format (flowing text instead of pages) are not for this reader.
    state.unsupported = !state.ready && q("#readmodeAppAside")?.dataset.htmlReader === "true";
    const s = JSON.stringify(state);
    if (s !== lastState) {
      lastState = s;
      post("state", state);
    }
    if (state.ready && fitted === null) fitted = looksFitted();
    if (state.ready && tocFor !== state.id) {
      // Edubase fills its table of contents a moment after the first page.
      if (readySince.id !== state.id) readySince = { id: state.id, at: Date.now() };
      const items = readToc();
      if (items.length || Date.now() - readySince.at > 8000) {
        tocFor = state.id;
        post("toc", { id: state.id, items });
      }
    }
    if (state.id && inkFor !== state.id) {
      // Another book (edubase links can lead to one): its notes come from the app.
      inkFor = state.id;
      book = { id: state.id, pages: {}, loaded: false };
      undo.length = redo.length = 0;
      post("need-ink", state.id);
    }
  }

  function readToc() {
    const out = [];
    const walk = (ul, level) => {
      for (const li of ul.children) {
        if (out.length >= 800) return;
        const a = q(":scope > .lu-toc-label a.lu-toc-link", li);
        const m = a && (a.getAttribute("href") || "").match(/#doc\/\d+\/([^/?]+)/);
        if (a && m) out.push({ title: a.textContent.trim().slice(0, 200), page: decodeURIComponent(m[1]), level });
        const sub = q(":scope > ul", li);
        if (sub && level < 5) walk(sub, level + 1);
      }
    };
    const root = q(".lu-docpanel-toc .lu-toc-container > ul");
    if (root) walk(root, 0);
    return out;
  }

  // ------------------------------------------------------------ search (edubase's own, shown by the app)

  let searchRun = 0;

  async function search(text) {
    const run = ++searchRun;
    const input = q("#searchContainer .lu-search-input");
    if (!input) return post("search", { q: text, error: true, items: [] });
    const before = q(".lu-search-snippets");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (!text) {
      click("#searchContainer [data-action=search-clear]");
      return post("search", { q: "", items: [] });
    }
    click("#searchContainer [data-action=search-run]");
    // Edubase shows a loader while it searches; the results replace the old list afterwards.
    const started = Date.now();
    let wasBusy = false;
    while (Date.now() - started < 20000 && run === searchRun) {
      await new Promise((res) => setTimeout(res, 150));
      const loader = q(".lu-search-loading");
      const busy = !!loader && !loader.classList.contains("hidden");
      if (busy) wasBusy = true;
      else if (wasBusy || q(".lu-search-snippets") !== before || Date.now() - started > 4000) break;
    }
    await new Promise((res) => setTimeout(res, 150));
    if (run !== searchRun) return;
    const items = qa(".lu-search-snippets .lu-search-snippet").slice(0, 300).map((li) => ({
      idx: li.dataset.idx,
      page: li.dataset.pagenum,
      loc: (q(".lu-search-snippet-location", li)?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      parts: [...(q(".lu-search-snippet__text", li)?.childNodes || [])]
        .map((n) => ({ t: n.textContent.slice(0, 400), hit: n.nodeType === 1 }))
        .slice(0, 40),
    }));
    post("search", { q: text, items, title: (q("#searchResultsTitle")?.textContent || "").trim().slice(0, 120) });
  }

  function searchGo(idx) {
    const li = qa(".lu-search-snippets .lu-search-snippet").find((el) => el.dataset.idx === String(idx));
    if (li) li.click();
  }

  // ------------------------------------------------------------ the user's own notes

  let book = { id: null, pages: {}, loaded: false };
  const tool = { name: "hand", color: "#1d1c1a", width: 2.4, size: 18 };
  const undo = [];
  const redo = [];
  const drawn = new WeakMap(); // layer element -> what it shows
  let rev = 0;
  let editing = null;

  const copy = (v) => JSON.parse(JSON.stringify(v));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function setItems(page, items, record = true) {
    const before = copy(book.pages[page] || []);
    if (items.length) book.pages[page] = items;
    else delete book.pages[page];
    if (record) {
      undo.push({ page, before, after: copy(items) });
      if (undo.length > 80) undo.shift();
      redo.length = 0;
    }
    rev++;
    sync();
    post("ink", { id: book.id, page, items });
    report();
  }

  function step(from, to, key) {
    const op = from.pop();
    if (!op) return;
    to.push(op);
    setItems(op.page, copy(op[key]), false);
    // Show the page the change happened on.
    if (!wrappers().some((w) => w.dataset.pageid === op.page)) go(op.page);
  }

  // Keep a notes layer on every page edubase shows. Edubase rebuilds its pages when the page
  // or the zoom changes, so this runs often and only redraws what is out of date.
  function sync() {
    for (const w of wrappers()) {
      const docPage = q(".doc-page", w);
      if (!docPage) continue;
      const page = w.dataset.pageid;
      const key = `${book.id}/${page}/${rev}/${ink.pageHeight(docPage)}`;
      const el = q(":scope > .stapel-layer", docPage);
      if (el && drawn.get(el) === key) continue;
      if (editing && editing.page === page && el) continue; // do not redraw under the caret
      const layerEl = ink.draw(docPage, book.pages[page]);
      layerEl.dataset.page = page;
      drawn.set(layerEl, key);
      if (!layerEl.dataset.wired) wire(layerEl);
    }
  }

  const redraw = () => {
    rev++;
    sync();
  };

  function setTool(t) {
    if (editing) editing.div.blur();
    if (t.name) tool.name = t.name;
    if (t.color) tool.color = t.color;
    if (t.width) tool.width = t.width;
    if (t.size) tool.size = t.size;
    const b = document.body;
    b.classList.toggle("stapel-draw", tool.name !== "hand");
    for (const n of ["hand", "pen", "hl", "eraser", "text"]) b.classList.toggle("stapel-tool-" + n, tool.name === n);
  }

  // Where the pointer is on the page, in the page's own units.
  function point(svg, e) {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [ink.r(p.x), ink.r(p.y)];
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // A highlighter line that was meant to be straight becomes straight, and a nearly level
  // one level: marking a line of text by hand always wobbles a little.
  function straighten(p) {
    if (p.length < 6) return p;
    const [x0, y0] = p;
    const x1 = p[p.length - 2];
    const y1 = p[p.length - 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 30) return p;
    let off = 0;
    let sum = 0;
    for (let i = 0; i < p.length; i += 2) {
      off = Math.max(off, distToSegment(p[i], p[i + 1], x0, y0, x1, y1));
      sum += p[i + 1];
    }
    if (off > Math.max(5, len * 0.04)) return p;
    if (Math.abs(y1 - y0) > len * 0.05) return [x0, y0, x1, y1];
    const y = ink.r(sum / (p.length / 2));
    return [x0, y, x1, y];
  }

  function hits(svg, it, x, y, reach) {
    if (it.t === "text") {
      const div = q(`foreignObject[data-id="${it.id}"] .stapel-text`, svg);
      if (!div) return false;
      const m = svg.getScreenCTM();
      const b = div.getBoundingClientRect();
      const a = new DOMPoint(b.left, b.top).matrixTransform(m.inverse());
      const c = new DOMPoint(b.right, b.bottom).matrixTransform(m.inverse());
      return x >= a.x - reach && x <= c.x + reach && y >= a.y - reach && y <= c.y + reach;
    }
    const p = it.p;
    const near = reach + it.w / 2;
    if (p.length < 4) return Math.hypot(x - p[0], y - p[1]) <= near;
    for (let i = 0; i < p.length - 2; i += 2) {
      if (distToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= near) return true;
    }
    return false;
  }

  function wire(layerEl) {
    layerEl.dataset.wired = "1";
    const svg = layerEl.firstChild;
    const page = () => layerEl.dataset.page;
    let stroke = null; // the line being drawn
    let erased = null; // while the eraser is down: what is left of the page
    let drag = null; // a text being moved

    // Edubase pans and flips pages with the same gestures. While a tool is on, they are ours.
    const stop = (e) => {
      if (tool.name !== "hand") e.stopPropagation();
    };
    for (const type of ["mousedown", "mousemove", "mouseup", "touchstart", "touchmove", "touchend", "click", "dblclick", "pointermove", "pointerup"]) {
      layerEl.addEventListener(type, stop);
    }

    const erase = (e) => {
      const pt = point(svg, e);
      if (!pt) return;
      const reach = 6;
      const left = erased.filter((it) => !hits(svg, it, pt[0], pt[1], reach));
      if (left.length === erased.length) return;
      for (const it of erased) {
        if (!left.includes(it)) q(`[data-id="${it.id}"]`, svg)?.classList.add("stapel-fade");
      }
      erased = left;
    };

    layerEl.addEventListener("pointerdown", (e) => {
      if (tool.name === "hand") return;
      e.stopPropagation();
      if (e.button !== 0) return;
      const onText = e.target.closest && e.target.closest(".stapel-text");
      if (editing) {
        if (onText === editing.div) return; // a click inside the text being written
        editing.div.blur();
        if (tool.name === "text") return; // the click only ended the writing
      }
      const pt = point(svg, e);
      if (!pt) return;
      e.preventDefault();
      if (tool.name === "pen" || tool.name === "hl") {
        const item = { id: newId(), t: tool.name, c: tool.color, w: tool.width, p: [pt[0], pt[1]] };
        const node = ink.strokeNode(item);
        svg.children[tool.name === "hl" ? 0 : 1].append(node);
        stroke = { item, node };
        svg.setPointerCapture(e.pointerId);
      } else if (tool.name === "eraser") {
        erased = (book.pages[page()] || []).slice();
        erase(e);
        svg.setPointerCapture(e.pointerId);
      } else if (tool.name === "text") {
        if (onText) {
          const fo = onText.parentNode;
          drag = { id: fo.dataset.id, fo, from: pt, x: +fo.getAttribute("x"), y: +fo.getAttribute("y"), moved: false, sx: e.clientX, sy: e.clientY };
          svg.setPointerCapture(e.pointerId);
        } else {
          const height = ink.pageHeight(layerEl.parentNode);
          const item = { id: newId(), t: "text", c: tool.color, s: tool.size, x: Math.min(pt[0], ink.W - 60), y: Math.min(pt[1] - tool.size * 0.7, height - 30), text: "" };
          item.x = ink.r(Math.max(2, item.x));
          item.y = ink.r(Math.max(2, item.y));
          const fo = ink.textNode(item, height);
          svg.children[2].append(fo);
          edit(layerEl, page(), item, fo.firstChild, true);
        }
      }
    });

    svg.addEventListener("pointermove", (e) => {
      if (stroke) {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        const p = stroke.item.p;
        for (const ev of events.length ? events : [e]) {
          const pt = point(svg, ev);
          if (!pt) continue;
          if (Math.hypot(pt[0] - p[p.length - 2], pt[1] - p[p.length - 1]) < 1.1) continue;
          p.push(pt[0], pt[1]);
        }
        stroke.node.setAttribute("d", ink.pathOf(p));
      } else if (erased) {
        erase(e);
      } else if (drag) {
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
        const pt = point(svg, e);
        if (!pt) return;
        drag.moved = true;
        drag.nx = ink.r(Math.max(0, Math.min(ink.W - 30, drag.x + pt[0] - drag.from[0])));
        drag.ny = ink.r(Math.max(0, drag.y + pt[1] - drag.from[1]));
        drag.fo.setAttribute("x", drag.nx);
        drag.fo.setAttribute("y", drag.ny);
      }
    });

    const finish = (e) => {
      if (stroke) {
        const { item } = stroke;
        stroke = null;
        if (e.type === "pointercancel") return redraw();
        if (item.t === "hl") item.p = straighten(item.p);
        setItems(page(), [...(book.pages[page()] || []), item]);
      } else if (erased) {
        const left = erased;
        erased = null;
        if (left.length !== (book.pages[page()] || []).length) setItems(page(), left);
      } else if (drag) {
        const d = drag;
        drag = null;
        const items = copy(book.pages[page()] || []);
        const it = items.find((i) => i.id === d.id);
        if (!it) return;
        if (d.moved) {
          it.x = d.nx;
          it.y = d.ny;
          setItems(page(), items);
        } else {
          edit(layerEl, page(), it, d.fo.firstChild, false);
        }
      }
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
  }

  // Typing on the page: the text is written where it will stay.
  function edit(layerEl, page, item, div, isNew) {
    div.contentEditable = "plaintext-only";
    div.classList.add("stapel-editing");
    editing = { page, div };
    const keys = (e) => {
      e.stopPropagation(); // edubase has shortcuts of its own
      if (e.key === "Escape") div.blur();
    };
    div.addEventListener("keydown", keys);
    div.addEventListener("keyup", (e) => e.stopPropagation());
    div.addEventListener("keypress", (e) => e.stopPropagation());
    div.addEventListener(
      "blur",
      () => {
        editing = null;
        const text = div.innerText.replace(/ /g, " ").replace(/\s+$/, "").slice(0, 4000);
        const items = copy(book.pages[page] || []);
        const at = items.findIndex((i) => i.id === item.id);
        if (!text) {
          if (at >= 0) items.splice(at, 1);
          else return redraw();
        } else if (at >= 0) {
          if (items[at].text === text) return redraw();
          items[at].text = text;
        } else {
          items.push({ ...item, text });
        }
        setItems(page, items);
      },
      { once: true },
    );
    div.focus();
    if (!isNew) {
      const range = document.createRange();
      range.selectNodeContents(div);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // ------------------------------------------------------------ moving around

  function go(page) {
    const at = where();
    if (at.id && page) location.hash = `#doc/${at.id}/${encodeURIComponent(page)}`;
  }
  const next = () => click("[data-action=footer-next-page]");
  const prev = () => click("[data-action=footer-prev-page]");

  const typing = (e) => {
    const el = e.target;
    return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (typing(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      // Edubase turns pages with the arrow keys itself; these two it leaves out.
      const flip = { PageDown: next, PageUp: prev }[e.key];
      if (flip && !mod && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        flip();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) step(redo, undo, "after");
        else step(undo, redo, "before");
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        post("key", "find");
      } else if (mod && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        zoom("in");
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoom("out");
      } else if (mod && e.key === "0") {
        e.preventDefault();
        zoom("fit");
      } else if (e.key === "Escape") {
        post("key", "escape");
      }
    },
    true,
  );

  // Pinch on a trackpad (the browser reports it as ctrl + wheel) zooms in steps. Scrolling
  // moves a page that is larger than the window; once it cannot move any further, the next
  // scroll gesture turns the page. Edubase alone turns a page for every few wheel events,
  // which sends a trackpad through several pages at once: here it is one page per gesture.
  let lastWheel = 0;
  let lastZoom = 0;
  let armed = false;
  let swallow = false;
  window.addEventListener(
    "wheel",
    (e) => {
      const now = Date.now();
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.ctrlKey) {
        take();
        if (now - lastZoom > 220 && Math.abs(e.deltaY) > 2) {
          lastZoom = now;
          zoom(e.deltaY < 0 ? "in" : "out");
        }
        return;
      }
      const gestureStart = now - lastWheel > 180;
      lastWheel = now;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const pages = q(".lu-doc-pages")?.getBoundingClientRect();
      const box = q("#readmodeAppBody")?.getBoundingClientRect();
      if (!pages || !box) return;
      const down = e.deltaY > 0;
      const atEdge = down ? pages.bottom <= box.bottom + 3 : pages.top >= box.top - 3;
      if (gestureStart) {
        armed = atEdge;
        swallow = false;
      }
      if (swallow) return take(); // the rest of a gesture that already turned the page
      if (!atEdge) return; // edubase scrolls the page
      take();
      if (armed && Math.abs(e.deltaY) > 4) {
        armed = false;
        swallow = true;
        (down ? next : prev)();
      }
    },
    { capture: true, passive: false },
  );

  // ------------------------------------------------------------ zoom

  // Edubase keeps its zoom when the window changes size. A page that was fitted to the window
  // should stay fitted, so the app fits it again; a zoom the user chose is left alone.
  let fitted = null; // unknown until the first page is there
  const zoom = (how) => {
    fitted = how === "fit";
    click({ in: "[data-action=incrementZoom]", out: "[data-action=decrementZoom]", fit: "[data-action=fitPage]" }[how]);
  };
  const looksFitted = () => {
    const pages = q(".lu-doc-pages")?.getBoundingClientRect();
    const box = q("#readmodeAppBody")?.getBoundingClientRect();
    return !!pages && !!box && pages.height <= box.height + 3 && pages.width <= box.width + 3;
  };
  let refit = null;
  window.addEventListener("resize", () => {
    clearTimeout(refit);
    refit = setTimeout(() => {
      if (fitted === null) fitted = looksFitted();
      if (fitted) click("[data-action=fitPage]");
    }, 260);
  });

  // ------------------------------------------------------------ commands from the app

  const commands = {
    go,
    next,
    prev,
    zoomIn: () => zoom("in"),
    zoomOut: () => zoom("out"),
    fit: () => zoom("fit"),
    spread: () => {
      // One page or two: afterwards the page should fit the window again.
      const was = q("#docPageMode i")?.className;
      if (!click("[data-action=changePageMode]")) return;
      const started = Date.now();
      const timer = setInterval(() => {
        const changed = q("#docPageMode i")?.className !== was;
        if (!changed && Date.now() - started < 4000) return;
        clearInterval(timer);
        if (changed) setTimeout(() => zoom("fit"), 250);
      }, 100);
    },
    tool: setTool,
    undo: () => step(undo, redo, "before"),
    redo: () => step(redo, undo, "after"),
    search,
    searchGo,
    ink: (data) => {
      if (!data || data.id !== where().id) return;
      book = { id: data.id, pages: data.pages || {}, loaded: true };
      rev++;
      sync();
    },
    clearPage: (page) => {
      if (book.pages[page]) setItems(String(page), []);
    },
    resize: () => window.dispatchEvent(new Event("resize")),
  };

  window.__stapel = {
    cmd(name, arg) {
      if (!Object.prototype.hasOwnProperty.call(commands, name)) return false;
      commands[name](arg);
      report();
      return true;
    },
  };

  window.addEventListener("hashchange", () => setTimeout(report, 0));
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    sync();
    report();
  }, 300);
  setTool({});
  // Edubase measured its layout before its bars were hidden.
  setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  report();
})();

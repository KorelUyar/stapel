// What edubase knows about a book's pages: the table of contents, and every word of a page with
// its place. Loaded into the reader <webview> and into the hidden window that saves PDFs.
// Units are the notes' units (reader/ink.js): a page is 1000 wide.
(() => {
  if (window.__stapelBook) return;
  const NS = "http://www.w3.org/2000/svg";
  const ink = window.__stapelInk;
  const W = ink.W;
  const r = ink.r;
  // Marks that belong to the word before them: no space in between.
  const PUNCT = /^[.,;:!?)\]»”’%]/;

  // Edubase's table of contents, flattened: [{ title, page, level }].
  function toc() {
    const out = [];
    const walk = (ul, level) => {
      for (const li of ul.children) {
        if (out.length >= 800) return;
        const a = li.querySelector(":scope > .lu-toc-label a.lu-toc-link");
        const m = a && (a.getAttribute("href") || "").match(/#doc\/\d+\/([^/?]+)/);
        if (a && m) out.push({ title: a.textContent.replace(/\s+/g, " ").trim().slice(0, 200), page: decodeURIComponent(m[1]), level });
        const sub = li.querySelector(":scope > ul");
        if (sub && level < 5) walk(sub, level + 1);
      }
    };
    const root = document.querySelector(".lu-docpanel-toc .lu-toc-container > ul");
    if (root) walk(root, 0);
    return out;
  }

  // The words of a page in reading order, each with its box in page units.
  function words(docPage) {
    const list = [...docPage.querySelectorAll(".lu-page-word[data-w]")];
    const box = docPage.getBoundingClientRect();
    if (!list.length || !box.width) return [];
    const k = W / box.width;
    const out = [];
    for (const el of list) {
      const b = el.getBoundingClientRect();
      const text = el.dataset.w;
      if (!text || b.width < 0.3 || b.height < 0.3) continue;
      out.push({
        pos: +el.dataset.pos || 0,
        text,
        x: (b.left - box.left) * k,
        y: (b.top - box.top) * k,
        w: b.width * k,
        h: b.height * k,
      });
    }
    return out.sort((a, b) => a.pos - b.pos);
  }

  // The words as invisible text over the letters, for a PDF that can be searched and copied
  // from. Edubase draws the letters as shapes; without this a saved page is a picture of text.
  function textLayer(docPage) {
    docPage.querySelector(":scope > .stapel-words")?.remove();
    const list = words(docPage);
    if (!list.length) return 0;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "stapel-words");
    svg.setAttribute("viewBox", `0 0 ${W} ${ink.pageHeight(docPage)}`);
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    list.forEach((word, i) => {
      const t = document.createElementNS(NS, "text");
      const size = word.h * 0.92;
      // The space after the word reaches into the gap to the next one: copied text keeps its
      // spaces, and the letters still cover the word. None before a full stop or a comma.
      const space = !PUNCT.test(list[i + 1]?.text || "");
      t.setAttribute("x", r(word.x));
      t.setAttribute("y", r(word.y + word.h * 0.8));
      t.setAttribute("font-size", r(size));
      t.setAttribute("textLength", r(word.w + (space ? size * 0.28 : 0)));
      t.setAttribute("lengthAdjust", "spacingAndGlyphs");
      t.textContent = space ? word.text + " " : word.text;
      svg.append(t);
    });
    docPage.append(svg);
    return list.length;
  }

  // The words a highlighter line runs over: what was marked, for the list of notes. A word
  // counts when the line covers at least half of it. null while the page has no words (yet).
  function quote(docPage, p, width) {
    const list = words(docPage);
    if (!list.length || !Array.isArray(p) || p.length < 2) return null;
    const half = width / 2;
    const pts = [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x0 = p[i];
      const y0 = p[i + 1];
      const x1 = i + 3 < p.length ? p[i + 2] : x0;
      const y1 = i + 3 < p.length ? p[i + 3] : y0;
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
      for (let j = 0; j < n; j++) pts.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n]);
    }
    const hit = [];
    for (const word of list) {
      // The line's band has to lie over the word, not just touch it: a wide highlighter on
      // close lines would otherwise take the lines above and below along.
      const enough = Math.min(word.h * 0.5, width * 0.6);
      let lo = Infinity;
      let hi = -Infinity;
      for (const [x, y] of pts) {
        if (Math.min(y + half, word.y + word.h) - Math.max(y - half, word.y) < enough) continue;
        if (x < word.x - half || x > word.x + word.w + half) continue;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      if (hi < lo) continue;
      const covered = Math.min(word.x + word.w, hi + half) - Math.max(word.x, lo - half);
      if (covered >= word.w * 0.5) hit.push(word);
    }
    // A word broken at the end of a line is joined again: "Zell-" "biologie" is "Zellbiologie",
    // "E-" "Book" is "E-Book".
    let text = "";
    let prev = null;
    for (const word of hit) {
      const broken = prev && /\p{L}-$/u.test(prev.text) && word.y > prev.y + prev.h * 0.5;
      if (!prev) text = word.text;
      else if (broken && /^\p{Ll}/u.test(word.text)) text = text.slice(0, -1) + word.text;
      else if (broken || PUNCT.test(word.text)) text += word.text; // "werden" "." is "werden."
      else text += " " + word.text;
      prev = word;
    }
    return text.slice(0, 600);
  }

  // The hidden window that saves a PDF: the text layer of the page with this name.
  // -1: the page is not there.
  function textLayerOf(pageId) {
    const wr = [...document.querySelectorAll(".lu-doc-pages .doc-page-wrapper")].find((w) => w.dataset.pageid === String(pageId));
    const docPage = wr && wr.querySelector(".doc-page");
    return docPage ? textLayer(docPage) : -1;
  }

  window.__stapelBook = { toc, words, textLayer, textLayerOf, quote };
})();

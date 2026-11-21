// Draws the user's own notes (pen, highlighter, typed text) over a page of edubase's reader.
// Loaded into the reader <webview>, and into the hidden window when a PDF is saved with notes.
// A page is always 1000 units wide; its height follows the page's shape. So notes keep their
// place at every zoom level and in print.
(() => {
  if (window.__stapelInk) return;
  const NS = "http://www.w3.org/2000/svg";
  const W = 1000;
  const r = (n) => Math.round(n * 10) / 10;

  function pageHeight(docPage) {
    const wr = docPage.closest(".doc-page-wrapper");
    const w = parseFloat(wr && wr.style.width);
    const h = parseFloat(wr && wr.style.height);
    if (w > 0 && h > 0) return r((W * h) / w);
    const vb = docPage.querySelector(".lu-page-svg-container > svg[viewBox]")?.viewBox.baseVal;
    return vb && vb.width > 0 ? r((W * vb.height) / vb.width) : 1414;
  }

  // A smooth line through the points: curves between the midpoints.
  function pathOf(p) {
    if (p.length < 4) return `M${p[0]} ${p[1]}L${p[0] + 0.01} ${p[1]}`;
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length - 2; i += 2) {
      d += `Q${p[i]} ${p[i + 1]} ${r((p[i] + p[i + 2]) / 2)} ${r((p[i + 1] + p[i + 3]) / 2)}`;
    }
    return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
  }

  function strokeNode(it) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", pathOf(it.p));
    path.setAttribute("stroke", it.c);
    path.setAttribute("stroke-width", it.w);
    path.dataset.id = it.id;
    return path;
  }

  function textNode(it, height) {
    const fo = document.createElementNS(NS, "foreignObject");
    fo.setAttribute("x", it.x);
    fo.setAttribute("y", it.y);
    fo.setAttribute("width", Math.max(40, W - it.x - 6));
    fo.setAttribute("height", Math.max(40, height - it.y));
    fo.dataset.id = it.id;
    const div = document.createElement("div");
    div.className = "stapel-text";
    div.textContent = it.text;
    div.style.color = it.c;
    div.style.fontSize = it.s + "px";
    fo.append(div);
    return fo;
  }

  function layer(docPage) {
    let el = docPage.querySelector(":scope > .stapel-layer");
    if (!el) {
      el = document.createElement("div");
      el.className = "stapel-layer";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "stapel-ink");
      svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
      for (const name of ["hl", "pen", "text"]) {
        const g = document.createElementNS(NS, "g");
        g.setAttribute("class", "stapel-" + name);
        svg.append(g);
      }
      el.append(svg);
      docPage.append(el);
    }
    el.firstChild.setAttribute("viewBox", `0 0 ${W} ${pageHeight(docPage)}`);
    return el;
  }

  function draw(docPage, items) {
    const el = layer(docPage);
    const height = pageHeight(docPage);
    const [hl, pen, text] = el.firstChild.children;
    hl.replaceChildren();
    pen.replaceChildren();
    text.replaceChildren();
    for (const it of items || []) {
      if (it.t === "text") text.append(textNode(it, height));
      else (it.t === "hl" ? hl : pen).append(strokeNode(it));
    }
    return el;
  }

  // Used by the hidden window before a page is printed.
  function drawPage(pageId, items) {
    const wr = [...document.querySelectorAll(".lu-doc-pages .doc-page-wrapper")].find((w) => w.dataset.pageid === String(pageId));
    const docPage = wr && wr.querySelector(".doc-page");
    if (!docPage) return false;
    draw(docPage, items);
    return true;
  }

  window.__stapelInk = { W, r, pageHeight, pathOf, strokeNode, textNode, layer, draw, drawPage };
})();

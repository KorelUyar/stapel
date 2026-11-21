// Shared by all parts of the interface: state, screens, small menus, helpers.
const $ = (id) => document.getElementById(id);
const EDUBASE = "https://app.edubase.ch/";

const state = {
  loggedIn: false,
  books: [],
  folders: [], // { id, name, color }
  shelf: {}, // book id -> folder id
  sort: "recent",
  folderColors: [],
  folder: null, // the folder being looked at
  selecting: false,
  selected: new Set(),
  screen: "boot",
  reading: null, // book open in the reader
  book: null, // book in the PDF sheet
  batch: null, // several books in the PDF sheet
  running: false,
  result: null,
  range: "all",
  bootError: null,
};

const errorText = (err) => (STRINGS.en["err." + err.message] ? t("err." + err.message) : err.message);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ------------------------------------------------------------ screens

function show(screen) {
  state.screen = screen;
  for (const id of ["boot", "welcome", "library", "reader"]) $(id).hidden = id !== screen;
  const reading = screen === "reader";
  $("backBtn").hidden = !reading;
  $("pdfBtn").hidden = !reading;
  $("langSwitch").hidden = reading;
  $("barTitle").textContent = reading ? state.reading?.title || "" : "Stapel";
  $("barTitle").classList.toggle("reading", reading);
  $("logoutBtn").hidden = !(screen === "library" && state.loggedIn);
  $("folderBtn").hidden = screen !== "library";
  $("selBar").hidden = !(screen === "library" && state.selecting);
  closePop();
}

function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.hidden = true), 3500);
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

// ------------------------------------------------------------ small menus

// One popover at a time: a menu, or the folder editor. It closes on a click elsewhere.
let popOwner = null;

function openPop(anchor, build, { align = "left" } = {}) {
  const pop = $("pop");
  if (!pop.hidden && popOwner === anchor) return closePop();
  pop.replaceChildren();
  pop.className = "pop";
  build(pop);
  pop.hidden = false;
  popOwner = anchor;
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = align === "right" ? a.right - w : a.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = a.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, a.top - h - 6);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function closePop() {
  $("pop").hidden = true;
  popOwner = null;
}

// items: { label, icon?, dot?, checked?, danger?, onClick } | { head } | { sep: true }
function openMenu(anchor, items, options) {
  openPop(
    anchor,
    (pop) => {
      pop.classList.add("menu");
      for (const item of items) {
        if (item.sep) {
          pop.append(el("div", "menu-sep"));
        } else if (item.head) {
          pop.append(el("div", "menu-head", item.head));
        } else {
          const b = el("button", "menu-item" + (item.danger ? " danger" : ""));
          if (item.dot) {
            const dot = el("span", "menu-dot");
            dot.style.background = item.dot;
            b.append(dot);
          } else if (item.icon) {
            b.append(icon(item.icon));
          } else {
            b.append(el("span", "menu-nothing"));
          }
          b.append(el("span", "menu-label", item.label));
          if (item.checked) b.append(icon("tick"));
          b.onclick = () => {
            closePop();
            item.onClick();
          };
          pop.append(b);
        }
      }
    },
    options,
  );
}

document.addEventListener("pointerdown", (e) => {
  if ($("pop").hidden) return;
  if (e.target.closest("#pop") || (popOwner && popOwner.contains(e.target))) return;
  closePop();
});
window.addEventListener("resize", closePop);
window.addEventListener("blur", closePop);

// ------------------------------------------------------------ helpers

const fileName = (p) => p.split(/[\\/]/).pop();
const folderLabel = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const IS_MAC = window.app.platform === "darwin";

if (window.app.platform === "win32") document.documentElement.classList.add("win");

async function refreshFolder() {
  const { outputDir, downloads } = await window.app.settings();
  const name = outputDir === downloads ? t("downloads") : folderLabel(outputDir);
  $("folderName").textContent = name;
  $("folderBtn").title = t("folderTitle", outputDir);
  $("saveWhere").textContent = t("savesIn", name);
  $("runWhere").textContent = t("savesIn", name);
}

async function setLanguage(lang) {
  applyLanguage(lang);
  window.app.setLang(LANG);
  await refreshFolder();
  if (state.screen === "library") renderLibrary();
  if (state.screen === "reader") renderReader();
  if (state.screen === "boot") {
    if (state.bootError) $("bootText").textContent = errorText(state.bootError);
    else $("bootText").textContent = t(state.loggedIn ? "loadingLibrary" : "connecting");
  }
}

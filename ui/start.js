// Things that belong to no single screen, and the start of the app.

// A pasted edubase link (…/#doc/12345/1) opens that book.
document.addEventListener("paste", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const m = e.clipboardData.getData("text").match(/#doc\/(\d+)/);
  if (!m || state.running) return;
  e.preventDefault();
  closeSheet();
  openBook(bookById(m[1]) || { id: m[1], title: "", cover: "" });
});

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
  try {
    await window.app.logout();
  } catch (err) {
    return toast(errorText(err));
  }
  state.loggedIn = false;
  state.books = [];
  state.folder = null;
  state.selecting = false;
  state.selected.clear();
  $("selectBtn").classList.remove("on");
  $("search").value = "";
  show("welcome");
};

$("folderBtn").onclick = async () => {
  await window.app.chooseFolder();
  refreshFolder();
};

for (const b of document.querySelectorAll("#langSwitch button")) b.onclick = () => setLanguage(b.dataset.lang);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("pop").hidden) return closePop();
  if (!$("sheet").hidden) return closeSheet();
  if (state.screen === "library" && state.selecting) setSelecting(false);
});

window.app.settings().then(async ({ lang, classic, folderColors }) => {
  state.folderColors = folderColors;
  r.classic = classic;
  applyLanguage(lang);
  await refreshFolder();
  boot();
});

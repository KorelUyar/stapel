// "Update now": shown in the title bar once GitHub has a newer version than this one.

const up = { latest: null, current: null, phase: null, part: 0 };

function renderUpdate() {
  const btn = $("updateBtn");
  btn.hidden = !up.latest || state.screen === "reader";
  btn.classList.toggle("busy", !!up.phase);
  $("updateText").textContent =
    up.phase === "download" ? t("updDownloading", Math.round(up.part * 100)) : up.phase ? t("updInstalling") : t("updAvailable", up.latest);
}

function updatePop(error) {
  openPop(
    $("updateBtn"),
    (pop) => {
      pop.classList.add("update-pop");
      pop.append(el("strong", "", t("updTitle", up.latest)));
      pop.append(el("p", error ? "fail-text" : "", error ? errorText(error) : t("updText", up.current)));
      const now = el("button", "btn primary wide", error ? t("retry") : t("updNow"));
      now.onclick = () => {
        closePop();
        startUpdate();
      };
      const page = el("button", "btn secondary wide", error ? t("updPage") : t("updNotes"));
      page.onclick = () => {
        closePop();
        window.app.updatePage();
      };
      pop.append(now, page);
    },
    { align: "right" },
  );
}

async function startUpdate() {
  if (up.phase) return;
  if (state.running) return toast(t("err.busy"));
  up.phase = "download";
  up.part = 0;
  renderUpdate();
  try {
    await window.app.updateStart();
    // The app quits and starts again by itself.
  } catch (err) {
    up.phase = null;
    renderUpdate();
    updatePop(err);
  }
}

function onUpdate(data) {
  if (data.available) Object.assign(up, { latest: data.latest, current: data.current });
  if (data.busy) up.phase = "download";
  if (data.phase) Object.assign(up, { phase: data.phase, part: data.part ?? up.part });
  renderUpdate();
}

$("updateBtn").onclick = () => {
  if (!up.phase) updatePop();
};
window.app.onUpdate(onUpdate);
window.app.updateState().then(onUpdate);

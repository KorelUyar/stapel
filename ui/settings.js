// Settings: where PDFs go, and where notes, bookmarks and folders are kept (this computer, or
// a folder the user chooses, such as iCloud Drive or OneDrive, for a backup and for every
// computer that uses the same folder).

async function openSettings() {
  if (!$("pop").hidden && popOwner === $("settingsBtn")) return closePop();
  const [{ outputDir, downloads }, data] = await Promise.all([window.app.settings(), window.app.dataDir()]);
  openPop(
    $("settingsBtn"),
    (pop) => {
      pop.classList.add("settings");
      const section = (title) => pop.append(el("div", "menu-head", title));
      const line = (text, className = "") => pop.append(el("p", "set-line " + className, text));
      const action = (iconName, label, onClick) => {
        const b = el("button", "menu-item");
        b.append(icon(iconName), el("span", "menu-label", label));
        b.onclick = async () => {
          closePop();
          await onClick();
        };
        pop.append(b);
      };

      pop.append(el("div", "set-title", t("settings")));
      section(t("setPdfs"));
      line(t("setPdfsIn", outputDir === downloads ? t("downloads") : folderLabel(outputDir)));
      action("folder", t("setChange"), async () => {
        await window.app.chooseFolder();
        await refreshFolder();
      });

      pop.append(el("div", "menu-sep"));
      section(t("setNotes"));
      if (!data.dir) {
        line(t("setLocal"));
        line(t("setNotesHint"), "fine");
        if (data.iCloud) action("download", t("setICloud"), () => moveNotes("icloud"));
        if (data.oneDrive) action("download", t("setOneDrive"), () => moveNotes("onedrive"));
        action("folder", data.iCloud || data.oneDrive ? t("setOther") : t("setChoose"), () => moveNotes());
      } else {
        line(data.reachable ? t("setInFolder", data.name) : t("setAway", data.name), data.reachable ? "" : "warn");
        if (data.reachable) action("folder", t("reveal"), () => window.app.revealDataDir());
        action("folderOut", t("setBackHere"), () => moveNotes("here"));
        action("folder", t("setOther"), () => moveNotes());
      }
    },
    { align: "right" },
  );
}

// Moves notes and folders, then shows the library as it is in the new place.
async function moveNotes(where) {
  try {
    const before = await window.app.dataDir();
    const info = where === "here" ? await window.app.resetDataDir() : await window.app.chooseDataDir(where);
    if (!info.changed) return;
    // A folder that could not be reached kept what is in it.
    const left = info.carried === false && before.name ? " " + t("setLeftBehind", before.name) : "";
    toast((where === "here" ? t("setBack") : t("setMoved", info.name)) + left);
    adoptShelf(await window.app.shelf());
    if (state.folder && !state.folders.some((f) => f.id === state.folder)) state.folder = null;
    if (state.screen === "library") {
      renderLibrary();
      refreshMarks();
    }
  } catch (err) {
    toast(errorText(err));
  }
}

$("settingsBtn").onclick = openSettings;

// From the main process: the library in the notes folder could not be read or written.
window.app.onNotice((code) => toast(t("err." + code)));

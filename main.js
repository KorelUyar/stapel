const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const puppeteer = require("puppeteer");
const { downloadBook } = require("./downloader");

let mainWindow;
let isRunning = false;

// In a packaged .app the bundled Chromium is unpacked next to the asar archive,
// so puppeteer's default path (which points inside app.asar) won't work — rewrite it.
function chromiumExecutablePath() {
  const execPath = puppeteer.executablePath();
  return app.isPackaged
    ? execPath.replace("app.asar", "app.asar.unpacked")
    : execPath;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 860,
    minWidth: 600,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: "hiddenInset",
    title: "Edubase Downloader",
    backgroundColor: "#f8fafc",
  });
  mainWindow.loadFile("index.html");
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function sendProgress(msg, current, total) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("progress", { msg, current, total });
  }
}

ipcMain.handle("start-download", async (event, config) => {
  if (isRunning) return { success: false, error: "Bereits aktiv" };
  isRunning = true;
  try {
    return await downloadBook(
      { ...config, executablePath: chromiumExecutablePath() },
      sendProgress,
    );
  } finally {
    isRunning = false;
  }
});

ipcMain.handle("choose-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Speicherort wählen",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("open-folder", async (event, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle("get-downloads-path", () => app.getPath("downloads"));

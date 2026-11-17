// Core edubase download + merge logic.
// Pure Node (no Electron) so it can be tested and reused independently of the GUI.

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");
const { PDFDocument } = require("pdf-lib");

const LOGIN_URL = "https://app.edubase.ch/#promo?popup=login";
const docUrl = (bookId, page) => `https://app.edubase.ch/#doc/${bookId}/${page}`;
const NEXT_PAGE_SELECTOR =
  "i.svg-icon-arrow.svg-icon-arrow_right.pointer.footer-page-navigation";

// edubase is a slow single-page app; these waits are deliberately generous.
const TIMING = {
  loginLoad: 10000,
  loginType: 1000,
  loginSubmit: 10000,
  firstPage: 8000, // first page needs longer to render
  nextPage: 5000,
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login(browser, { email, password }) {
  const page = await browser.newPage();
  await page.goto(LOGIN_URL);
  await wait(TIMING.loginLoad);
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(password);
  await wait(TIMING.loginType);
  await page.keyboard.press("Enter");
  await wait(TIMING.loginSubmit);
  await page.close();
}

async function capturePages(browser, { bookId, startPage, endPage, tempDir }, onProgress) {
  const page = await browser.newPage();
  const total = endPage - startPage + 1;

  for (let i = startPage; i <= endPage; i++) {
    onProgress(`Seite ${i} von ${endPage} herunterladen...`, i - startPage + 1, total);

    if (i === startPage) {
      await page.goto(docUrl(bookId, i));
      await wait(TIMING.firstPage);
    } else {
      await page.$$eval(NEXT_PAGE_SELECTOR, (buttons) =>
        buttons.forEach((button) => button.click()),
      );
      await wait(TIMING.nextPage);
    }

    await page.emulateMediaType("print");
    await page.pdf({
      path: path.join(tempDir, `page-${i}.pdf`),
      format: "A4",
      printBackground: true,
    });
  }

  await page.close();
}

async function mergePages(tempDir, outputPath, title) {
  const files = fs
    .readdirSync(tempDir)
    .filter((f) => /^page-\d+\.pdf$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  const merged = await PDFDocument.create();
  merged.setTitle(title);
  merged.setAuthor("Edubase Downloader");

  for (const file of files) {
    const bytes = fs.readFileSync(path.join(tempDir, file));
    const doc = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }

  fs.writeFileSync(outputPath, await merged.save());
  return files.length;
}

/**
 * Download a full edubase book and save it as a single merged PDF.
 *
 * @param {object} config  - { email, password, bookId, startPage, endPage, outputName, outputDir }
 * @param {function} [onProgress] - (message, current, total) => void
 * @returns {Promise<{success: boolean, path?: string, dir?: string, error?: string}>}
 */
async function downloadBook(config, onProgress = () => {}) {
  const { email, password, bookId, startPage, endPage, outputName, outputDir, executablePath } =
    config;
  const tempDir = path.join(os.tmpdir(), `edubase-${bookId}-${Date.now()}`);
  let browser;

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    // executablePath is set by the packaged app (Chromium lives outside the asar there);
    // in dev it stays undefined and puppeteer uses its bundled Chromium automatically.
    browser = await puppeteer.launch({ headless: true, executablePath: executablePath || undefined });

    onProgress("Anmelden...", 0, 0);
    await login(browser, { email, password });
    onProgress("Angemeldet! Starte Download...", 0, 0);

    await capturePages(browser, { bookId, startPage, endPage, tempDir }, onProgress);

    await browser.close();
    browser = null;

    const total = endPage - startPage + 1;
    onProgress("PDFs zusammenführen...", total, total);

    const outPath = path.join(outputDir, `${outputName}.pdf`);
    await mergePages(tempDir, outPath, outputName);

    onProgress(`✓ Fertig! "${outputName}.pdf" gespeichert.`, total, total);
    return { success: true, path: outPath, dir: outputDir };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { downloadBook };

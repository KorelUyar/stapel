// All interface text. English first; German is a choice in the title bar.
const IS_WIN = window.app?.platform === "win32";
const PASTE = IS_WIN ? "Ctrl+V" : "⌘V";
const STRINGS = {
  en: {
    connecting: "Connecting to Edubase …",
    loadingLibrary: "Loading your books …",
    retry: "Try again",
    welcomeTitle: "Your school books,<br />in their own window.",
    welcomeLead: "Sign in once. Your Edubase library opens here, without a browser.",
    signIn: "Sign in with Edubase",
    welcomeFine:
      "You sign in on Edubase's own page, also with Office 365 or Edulog. The app never sees your password and stays signed in.",
    guest: "Look at the free books without signing in",
    library: "Your books",
    search: "Search",
    reload: "Reload library",
    guestNote: "You are seeing the free books only.",
    signInShort: "Sign in",
    signOut: "Sign out",
    noBooks: "No books found.",
    pasteHint: `Tip: paste an Edubase link (${PASTE}) to open that book.`,
    books: (n) => (n === 1 ? "1 book" : `${n} books`),
    read: "Read",
    back: "Library",
    savePdf: "Save as PDF",
    close: "Close",
    wholeBook: "Whole book",
    somePages: "Pages …",
    from: "from",
    to: "to",
    end: "end",
    saveButton: "Save as PDF",
    savesIn: (f) => `Saved to ${f}.`,
    licenceNote: "Only for books you have a licence for. The PDF is for you, not for sharing.",
    opening: "Opening the book …",
    pageOf: (a, b) => `Page ${a} of ${b}`,
    left: (s) => (s < 60 ? `${Math.round(s / 5) * 5} s left` : `${Math.ceil(s / 60)} min left`),
    merging: "Putting the PDF together …",
    cancel: "Cancel",
    cancelling: "Cancelling …",
    cancelled: "Cancelled.",
    saved: (n, f) => `${n} ${n === 1 ? "page" : "pages"} saved as “${f}”.`,
    openPdf: "Open PDF",
    reveal: IS_WIN ? "Show in Explorer" : "Show in Finder",
    folderTitle: (p) => `Saves to ${p}. Click to change.`,
    rangeError: "The last page must come after the first.",
    "err.offline": "Edubase does not answer. Are you online?",
    "err.noaccess": "The book could not be opened. Do you have access to it?",
    "err.busy": "A download is already running.",
    "err.stalled": "Edubase stopped answering in the middle of the book. Nothing was saved. Try again.",
    "err.range": "The book does not have that many pages.",
    downloads: "Downloads",
    notAffiliated: "Not made by or affiliated with Edubase.",
  },
  de: {
    connecting: "Verbinde mit Edubase …",
    loadingLibrary: "Lade deine Bücher …",
    retry: "Nochmals versuchen",
    welcomeTitle: "Deine Schulbücher<br />im eigenen Fenster.",
    welcomeLead: "Einmal anmelden. Deine Edubase-Bibliothek öffnet sich hier, ohne Browser.",
    signIn: "Mit Edubase anmelden",
    welcomeFine:
      "Du meldest dich direkt auf der Seite von Edubase an, auch mit Office 365 oder Edulog. Die App sieht dein Passwort nie und bleibt angemeldet.",
    guest: "Ohne Anmeldung die Gratis-Bücher ansehen",
    library: "Deine Bücher",
    search: "Suchen",
    reload: "Bibliothek neu laden",
    guestNote: "Du siehst nur die Gratis-Bücher.",
    signInShort: "Anmelden",
    signOut: "Abmelden",
    noBooks: "Keine Bücher gefunden.",
    pasteHint: `Tipp: Füge einen Edubase-Link ein (${PASTE}), um das Buch zu öffnen.`,
    books: (n) => (n === 1 ? "1 Buch" : `${n} Bücher`),
    read: "Lesen",
    back: "Bibliothek",
    savePdf: "Als PDF speichern",
    close: "Schliessen",
    wholeBook: "Ganzes Buch",
    somePages: "Nur Seiten …",
    from: "von",
    to: "bis",
    end: "Ende",
    saveButton: "Als PDF speichern",
    savesIn: (f) => `Wird in ${f} gespeichert.`,
    licenceNote: "Nur für Bücher, für die du eine Lizenz hast. Das PDF ist für dich, nicht zum Weitergeben.",
    opening: "Buch wird geöffnet …",
    pageOf: (a, b) => `Seite ${a} von ${b}`,
    left: (s) => (s < 60 ? `noch ${Math.round(s / 5) * 5} s` : `noch ${Math.ceil(s / 60)} Min.`),
    merging: "PDF wird zusammengesetzt …",
    cancel: "Abbrechen",
    cancelling: "Wird abgebrochen …",
    cancelled: "Abgebrochen.",
    saved: (n, f) => `${n} ${n === 1 ? "Seite" : "Seiten"} gespeichert als «${f}».`,
    openPdf: "PDF öffnen",
    reveal: IS_WIN ? "Im Explorer zeigen" : "Im Finder zeigen",
    folderTitle: (p) => `Speichert in ${p}. Klicken zum Ändern.`,
    rangeError: "Die Endseite muss nach der Startseite kommen.",
    "err.offline": "Edubase antwortet nicht. Bist du online?",
    "err.noaccess": "Das Buch liess sich nicht öffnen. Hast du Zugriff darauf?",
    "err.busy": "Es läuft schon ein Download.",
    "err.stalled": "Edubase hat mitten im Buch nicht mehr geantwortet. Es wurde nichts gespeichert. Versuch es nochmals.",
    "err.range": "So viele Seiten hat das Buch nicht.",
    downloads: "Downloads",
    notAffiliated: "Nicht von Edubase und nicht mit Edubase verbunden.",
  },
};

let LANG = "en";

function t(key, ...args) {
  const v = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}

function applyLanguage(lang) {
  LANG = STRINGS[lang] ? lang : "en";
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll("[data-t-html]")) el.innerHTML = t(el.dataset.tHtml);
  for (const el of document.querySelectorAll("[data-t-placeholder]")) el.placeholder = t(el.dataset.tPlaceholder);
  for (const el of document.querySelectorAll("[data-t-title]")) el.title = t(el.dataset.tTitle);
  for (const b of document.querySelectorAll("#langSwitch button")) b.classList.toggle("on", b.dataset.lang === LANG);
}

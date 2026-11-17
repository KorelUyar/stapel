# Edubase Downloader

A small Mac app that saves the Edubase books you have access to as one PDF each, so you can
read and annotate them in a proper notes app.

1. Sign in once (on Edubase's own login page, inside the app; Office 365, Edulog, Google and
   Apple logins work too). The app never sees your password and stays signed in.
2. Click a book in your library.
3. Click **Als PDF speichern**. The PDF lands in Downloads (changeable at the top right).

You can also paste an Edubase link (`https://app.edubase.ch/#doc/12345/1`) with ⌘V to open
that book directly, and save only a page range.

## How it works

The app drives the real Edubase web app in a hidden Electron window (no Puppeteer, no second
browser). For each page it waits until the page has finished loading, prints it with Chromium's
own PDF printer (text stays text), and finally merges all pages with `pdf-lib`.

- `edubase.js` – login window, library, page-by-page download, merge
- `main.js` – window, settings (output folder), IPC
- `preload.js` – the bridge the UI may call
- `ui/` – the interface (German)

## Run and build

```sh
npm install
npm start          # run from source
npm run dist       # dist/mac-arm64/Edubase Downloader.app (unsigned)
```

Edubase can change its web app at any time. The selectors the app relies on are all in
`edubase.js` (`.lu-library-item`, `.lu-profile-settings__login`, `[data-item=page-settings]`,
`[data-action=footer-next-page]`).

Based on [AndrinGautschi/edubase-book-downloader](https://github.com/AndrinGautschi/edubase-book-downloader) (GPL-3.0).
For personal use with books you have a licence for.

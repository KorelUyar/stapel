// Updates: looks on GitHub whether there is a newer release, and installs it over the running
// app when the user says so. Nothing is downloaded or installed without a click.
//
// macOS: the app is not signed with a developer certificate, so Apple's own update machinery
// does not take it. Instead the new Stapel.app is unpacked next to the old one, checked, and a
// small script swaps the two once the app has quit, and opens the new one.
// Windows: the installer of the new version runs silently and starts the app again.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const pkg = require("./package.json");

const HOME = "https://github.com/KorelUyar/stapel";
// Only for testing a packaged build against a stand-in server on this computer: a throw-away
// build made with `electron-builder -c.extraMetadata.updateBase=http://127.0.0.1:<port>`.
// Anything else is ignored, and scripts/sign-and-zip.js refuses to pack a release that has it.
const BASE = /^http:\/\/127\.0\.0\.1:\d+$/.test(pkg.updateBase || "") ? pkg.updateBase : HOME;
const FILES = { darwin: "Stapel-macOS.zip", win32: "Stapel-Windows-Setup.exe" };
const BUNDLE_ID = "com.koreluyar.stapel";

const supported = () => !!FILES[process.platform];

// Downloads may only come from GitHub (which hands release files over to its own file hosts).
function allowed(url) {
  try {
    const u = new URL(url);
    if (BASE !== HOME) return u.origin === BASE;
    return u.protocol === "https:" && (u.hostname === "github.com" || u.hostname.endsWith(".githubusercontent.com"));
  } catch {
    return false;
  }
}

// "1.10.0" is newer than "1.9.3".
function newer(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// GitHub answers ".../releases/latest" by pointing to ".../releases/tag/v1.2.3". That address
// is all that is read: no account, no API allowance used up.
function latestVersion() {
  const { net } = require("electron");
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
      request.abort();
    };
    const request = net.request({ url: `${BASE}/releases/latest`, redirect: "manual" });
    const timer = setTimeout(() => done(reject, new Error("timeout")), 20000);
    request.on("redirect", (_status, _method, url) => {
      const m = String(url).match(/\/releases\/tag\/v(\d+\.\d+\.\d+)$/);
      if (m) done(resolve, m[1]);
      else done(reject, new Error("no version"));
    });
    request.on("response", () => done(reject, new Error("no version")));
    request.on("error", (err) => done(reject, err));
    request.end();
  });
}

/**
 * Downloads the release file for this system into a temporary folder.
 * @param {string} version
 * @param {(part: number) => void} onProgress  0 … 1
 * @param {{cancelled: boolean}} token
 * @returns {Promise<string>} the file
 */
function download(version, onProgress, token) {
  const { net, app } = require("electron");
  const name = FILES[process.platform];
  const dir = path.join(app.getPath("temp"), "stapel-update");
  const file = path.join(dir, name);
  const tidy = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A virus scanner may still hold the file. It is removed at the next start.
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = null;
    let stall = null;
    let request = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      reject(err);
      try {
        if (request) request.abort();
        if (out) out.destroy();
      } catch {}
      tidy();
    };
    // A connection that says nothing for a minute is given up, so the app is not left
    // "downloading" for ever.
    const alive = () => {
      clearTimeout(stall);
      stall = setTimeout(() => fail(new Error("download")), 60000);
    };
    try {
      tidy();
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return fail(new Error("disk"));
    }
    let hops = 0;
    request = net.request({ url: `${BASE}/releases/download/v${version}/${name}`, redirect: "manual" });
    alive();
    request.on("redirect", (_status, _method, url) => {
      if (++hops > 5 || !allowed(url)) return fail(new Error("download"));
      alive();
      request.followRedirect();
    });
    request.on("response", (res) => {
      if (res.statusCode !== 200) return fail(new Error("download"));
      const total = Number([].concat(res.headers["content-length"] || 0)[0]) || 0;
      let got = 0;
      let shown = -1;
      out = fs.createWriteStream(file);
      out.on("error", () => fail(new Error("disk")));
      res.on("data", (chunk) => {
        if (settled) return;
        if (token.cancelled) return fail(new Error("cancelled"));
        alive();
        got += chunk.length;
        // Do not read faster than the disk writes.
        if (!out.write(chunk)) {
          res.pause();
          out.once("drain", () => res.resume());
        }
        const percent = total ? Math.floor((got / total) * 100) : 0;
        if (percent !== shown) onProgress((shown = percent) / 100);
      });
      res.on("end", () => {
        if (settled) return;
        clearTimeout(stall);
        // A file that stopped short is not an update.
        if ((total && got !== total) || got < 1_000_000) return fail(new Error("download"));
        out.end((err) => {
          if (settled) return;
          let onDisk = -1;
          try {
            onDisk = fs.statSync(file).size;
          } catch {}
          if (err || onDisk !== got) return fail(new Error("disk"));
          settled = true;
          resolve(file);
        });
      });
      res.on("error", () => fail(new Error("download")));
    });
    request.on("error", () => fail(new Error("download")));
    request.end();
  });
}

const run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

// Runs after the app has quit: old app out, new app in, and if that fails the old one back.
const SWAP = `#!/bin/sh
pid="$1"; app="$2"; new="$3"; stage="$4"; launch="$5"
i=0
while kill -0 "$pid" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done
if kill -0 "$pid" 2>/dev/null; then
  # The app did not quit: leave it alone, it is still the working one.
  rm -rf "$stage"; rm -f "$0"; exit 1
fi
old="$app.old-$$"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then rm -rf "$old"; else mv "$old" "$app"; fi
fi
rm -rf "$stage"
[ "$launch" = "1" ] && open "$app"
rm -f "$0"
`;

// Where the running app is, and whether it can be replaced there. Asked before anything is
// downloaded: an app started from the Downloads folder runs from a read-only copy that macOS
// made, and an app in a folder this user may not write to cannot be swapped either.
function macTarget(appPath = path.resolve(process.execPath, "..", "..", "..")) {
  if (!appPath.endsWith(".app") || appPath.includes("/AppTranslocation/")) throw new Error("location");
  try {
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
    fs.accessSync(appPath, fs.constants.W_OK);
  } catch {
    throw new Error("location");
  }
  return appPath;
}

/** Throws "location" if this app cannot replace itself where it is. */
function ready() {
  if (process.platform === "darwin") macTarget();
}

// What an update that was cut short left behind: the unpacked new app next to the installed
// one, an old app that was not removed, the download. Called a while after the app started.
function cleanUp(tempDir) {
  try {
    fs.rmSync(path.join(tempDir, "stapel-update"), { recursive: true, force: true });
  } catch {}
  if (process.platform !== "darwin") return;
  try {
    const appPath = macTarget();
    const parent = path.dirname(appPath);
    const base = path.basename(appPath);
    for (const name of fs.readdirSync(parent)) {
      const stale = /^\.Stapel-update-\d+$/.test(name) || (name.startsWith(`${base}.old-`) && /^\d+$/.test(name.slice(base.length + 5)));
      if (stale) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }
  } catch {}
}

/**
 * macOS: unpack the new app next to the installed one, check it, and leave a script behind
 * that swaps them when this process has ended.
 * @param {string} zip
 * @param {string} version  the version the package must have
 * @param {{appPath?: string, pid?: number, launch?: boolean}} [options]  for tests
 */
async function installMac(zip, version, options = {}) {
  const appPath = macTarget(options.appPath);
  const parent = path.dirname(appPath);
  const stage = path.join(parent, `.Stapel-update-${process.pid}`);
  const next = path.join(stage, "Stapel.app");
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    await run("/usr/bin/ditto", ["-x", "-k", zip, stage]);
    const plist = path.join(next, "Contents", "Info.plist");
    const id = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])).trim();
    const has = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist])).trim();
    if (id !== BUNDLE_ID || has !== version) throw new Error("package");
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", next]);
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", next]).catch(() => {});
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(err.message === "package" ? "package" : "unpack");
  }
  const script = path.join(os.tmpdir(), `stapel-swap-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(script, SWAP, { mode: 0o700 });
  const args = [script, String(options.pid || process.pid), appPath, next, stage, options.launch === false ? "0" : "1"];
  spawn("/bin/sh", args, { detached: true, stdio: "ignore" }).unref();
}

// Windows: the installer closes what is left of the app, installs for this user without
// questions, and starts the app again. Resolves once the installer is really running: if
// Windows refuses to start it (a rule against programs in the temp folder, a virus scanner),
// the app must stay open and say so.
function installWindows(file) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore" });
    } catch {
      return reject(new Error("start"));
    }
    child.once("error", () => reject(new Error("start")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Start the installation of a downloaded file. The app has to quit right afterwards. */
async function install(file, version) {
  if (process.platform === "darwin") await installMac(file, version);
  else if (process.platform === "win32") await installWindows(file);
  else throw new Error("location");
}

module.exports = { HOME, supported, newer, latestVersion, ready, download, install, installMac, installWindows, cleanUp };

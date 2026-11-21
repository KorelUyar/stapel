// After electron-builder: sign the app ad hoc (Apple Silicon refuses unsigned code) and zip it
// as dist/Stapel-macOS.zip, the file the release and install.sh use.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "..", "dist");
const dir = ["mac-universal", "mac-arm64", "mac"].map((d) => path.join(dist, d)).find((d) => fs.existsSync(path.join(d, "Stapel.app")));
if (!dir) throw new Error("Stapel.app not found in dist/");
const appPath = path.join(dir, "Stapel.app");
const zip = path.join(dist, "Stapel-macOS.zip");

// The packed app must be the version of this repository and must not carry the address of a
// stand-in update server (update.js, updateBase): every copy asks GitHub, nothing else.
const packed = JSON.parse(require("@electron/asar").extractFile(path.join(appPath, "Contents", "Resources", "app.asar"), "package.json").toString());
if (packed.updateBase) throw new Error("this build has updateBase set: not a release");
if (packed.version !== require("../package.json").version) throw new Error(`packed version ${packed.version} is not the repository's`);

execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
fs.rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zip], { stdio: "inherit" });
console.log("wrote", zip);

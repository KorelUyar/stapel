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

execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
fs.rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zip], { stdio: "inherit" });
console.log("wrote", zip);

#!/bin/zsh
# Installs the latest Stapel on a Mac:
#
#   curl -fsSL https://github.com/KorelUyar/stapel/releases/latest/download/install.sh | zsh
#
# Stapel is not notarised by Apple (that needs a paid developer account).
# Installing it this way skips the "cannot be opened" warning that macOS
# shows for apps downloaded with a browser.

set -e

url="https://github.com/KorelUyar/stapel/releases/latest/download/Stapel-macOS.zip"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Stapel…"
curl -fL --progress-bar "$url" -o "$tmp/Stapel.zip"
ditto -x -k "$tmp/Stapel.zip" "$tmp"

if [ ! -d "$tmp/Stapel.app" ]; then
  echo "The download does not contain Stapel.app." >&2
  exit 1
fi

dest="/Applications"
[ -w "$dest" ] || dest="$HOME/Applications"
mkdir -p "$dest"

osascript -e 'tell application "Stapel" to quit' >/dev/null 2>&1 || true
rm -rf "$dest/Stapel.app"
ditto "$tmp/Stapel.app" "$dest/Stapel.app"
xattr -dr com.apple.quarantine "$dest/Stapel.app" 2>/dev/null || true

echo "Installed in $dest. Opening Stapel…"
open "$dest/Stapel.app"

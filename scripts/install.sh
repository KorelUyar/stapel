#!/bin/zsh
# Installs the latest Stapel on a Mac:
#
#   curl -fsSL https://github.com/KorelUyar/stapel/releases/latest/download/install.sh | zsh
#
# Stapel is not notarised by Apple (that needs a paid developer account).
# Installing it this way skips the "cannot be opened" warning that macOS
# shows for apps downloaded with a browser.

# Everything runs inside a function, so a download of this script that was cut off
# halfway does nothing at all.
install_stapel() {
  set -e
  local url="https://github.com/KorelUyar/stapel/releases/latest/download/Stapel-macOS.zip"
  local tmp; tmp="$(mktemp -d)"
  # The folder's name is written into the trap now: when the trap runs, at the very end,
  # the variable of this function is gone.
  trap "rm -rf ${(q)tmp}" EXIT

  echo "Downloading Stapel…"
  curl -fL --progress-bar "$url" -o "$tmp/Stapel.zip"
  ditto -x -k "$tmp/Stapel.zip" "$tmp"
  if [ ! -d "$tmp/Stapel.app" ]; then
    echo "The download does not contain Stapel.app." >&2
    exit 1
  fi

  local dest="/Applications"
  [ -w "$dest" ] || dest="$HOME/Applications"
  mkdir -p "$dest"

  # Copy next to the old version first; replace it only once the copy is complete.
  rm -rf "$dest/Stapel.app.new"
  ditto "$tmp/Stapel.app" "$dest/Stapel.app.new"
  xattr -dr com.apple.quarantine "$dest/Stapel.app.new" 2>/dev/null || true

  osascript -e 'tell application "Stapel" to quit' >/dev/null 2>&1 || true
  for i in {1..20}; do pgrep -xq Stapel || break; sleep 0.5; done

  rm -rf "$dest/Stapel.app"
  mv "$dest/Stapel.app.new" "$dest/Stapel.app"

  echo "Installed in $dest. Opening Stapel…"
  open "$dest/Stapel.app"
}

install_stapel

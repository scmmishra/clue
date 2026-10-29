#!/usr/bin/env bash
# Installs the clue binary for this machine into ~/.local/bin (or $CLUE_INSTALL_DIR).
#   curl -fsSL <install-url> | bash
set -euo pipefail

REPO="${CLUE_REPO:-scmmishra/clue}"
DIR="${CLUE_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "clue supports macOS and Linux." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "clue supports arm64 and x86_64." >&2; exit 1 ;;
esac

url="https://github.com/${REPO}/releases/latest/download/clue-${os}-${arch}"
mkdir -p "$DIR"
echo "Downloading clue for ${os}-${arch}…"
curl -fsSL "$url" -o "$DIR/clue.tmp"
chmod +x "$DIR/clue.tmp"
mv "$DIR/clue.tmp" "$DIR/clue"
echo "Installed $DIR/clue"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add $DIR to your PATH to run clue." ;;
esac

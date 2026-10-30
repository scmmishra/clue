#!/usr/bin/env bash
# Installs clue from the latest GitHub release, or updates an existing install.
#
#   curl -fsSL https://raw.githubusercontent.com/scmmishra/clue/main/install.sh | bash
#
# Set CLUE_INSTALL_DIR to install somewhere other than ~/.local/bin.
# `clue upgrade` runs this script after it checks for a newer release.
set -euo pipefail

REPO="scmmishra/clue"
INSTALL_DIR="${CLUE_INSTALL_DIR:-$HOME/.local/bin}"
TARGET="$INSTALL_DIR/clue"
# For testing a release built on this machine: a folder with the assets and SHA256SUMS.
LOCAL_RELEASE="${CLUE_LOCAL_RELEASE:-}"

fail() {
  echo "clue install: $*" >&2
  exit 1
}

warn() {
  echo "clue install: $*" >&2
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "clue runs on macOS and Linux." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "clue runs on arm64 and x86_64 machines." ;;
esac
asset="clue-$os-$arch"

command -v curl > /dev/null || fail "curl is required."

sha256() {
  if command -v shasum > /dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1
  fi
}

# Finds the newest release tag.
latest_tag() {
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2> /dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)" || true
  [[ -n "$tag" ]] || fail "No release of $REPO was found."
  echo "$tag"
}

# Downloads one release file into $tmp. The binary shows a progress bar in a terminal.
download() {
  local name="$1"
  local url="https://github.com/$REPO/releases/download/$tag/$name"
  if [[ -n "$LOCAL_RELEASE" ]]; then
    cp "$LOCAL_RELEASE/$name" "$tmp/$name" || fail "$name is missing from $LOCAL_RELEASE."
  elif [[ "$name" != SHA256SUMS && -t 2 ]]; then
    curl -fL --progress-bar "$url" -o "$tmp/$name" || fail "Could not download $name from release $tag."
  else
    curl -fsSL "$url" -o "$tmp/$name" 2> /dev/null || fail "Could not download $name from release $tag."
  fi
}

tag="${CLUE_VERSION:-}"
if [[ -z "$LOCAL_RELEASE" ]]; then
  if [[ -z "$tag" ]]; then
    echo "Finding the latest release"
    tag="$(latest_tag)"
  fi
else
  tag="${tag:-local}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading clue $tag for $os-$arch"
download SHA256SUMS
# Releases before 0.4.0 have no compressed files.
file="$asset"
if awk -v name="$asset.gz" '$2 == name { found = 1 } END { exit !found }' "$tmp/SHA256SUMS"; then
  file="$asset.gz"
fi
download "$file"

echo "Checking the download"
# A binary that doesn't match its published checksum is never installed.
expected="$(awk -v name="$file" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
[[ -n "$expected" ]] || fail "$file is not listed in the release checksums."
[[ "$(sha256 "$tmp/$file")" == "$expected" ]] || fail "The download of $file does not match its checksum. Nothing was installed."
[[ "$file" == "$asset" ]] || gzip -d "$tmp/$file" || fail "Could not unpack $file. Nothing was installed."
chmod +x "$tmp/$asset"

# A checksum proves the file is intact, not that it runs here.
reported="$("$tmp/$asset" --version 2> /dev/null)" || fail "The new binary does not start on this machine. Nothing was installed."
[[ "$tag" == "local" || "v$reported" == "$tag" ]] || fail "The new binary reports version $reported, not ${tag#v}. Nothing was installed."

was_installed=""
[[ -e "$TARGET" ]] && was_installed=1

mkdir -p "$INSTALL_DIR"
# Copy beside the target and rename, so a failed copy never leaves a half-written binary.
cp "$tmp/$asset" "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"

if [[ -n "$was_installed" ]]; then
  echo "Updated clue to $tag at $TARGET."
else
  echo "Installed clue $tag to $TARGET."
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add it to your shell profile to run clue." ;;
esac
[[ -n "$was_installed" ]] || echo "Next: run \`clue login\`, or set ANTHROPIC_API_KEY, then run \`clue\` in a project."

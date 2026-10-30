#!/usr/bin/env bash
# Installs clue from the latest GitHub release, or updates an existing install.
#
#   curl -fsSL https://raw.githubusercontent.com/scmmishra/clue/main/install.sh | bash
#
# Set CLUE_INSTALL_DIR to install somewhere other than ~/.local/bin.
# When GitHub refuses an anonymous download, the GitHub CLI is used if it is logged in.
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

# Finds the newest release tag. Public repositories answer without a login.
latest_tag() {
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2> /dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)" || true
  if [[ -z "$tag" ]] && gh_ready; then
    tag="$(gh release view -R "$REPO" --json tagName --jq .tagName 2> /dev/null)" || true
  fi
  [[ -n "$tag" ]] || fail "No release of $REPO was found. Check the repository name and your access."
  echo "$tag"
}

gh_ready() {
  command -v gh > /dev/null && gh auth status --hostname github.com > /dev/null 2>&1
}

# Downloads one release file into $tmp. Falls back to the GitHub CLI for private repositories.
download() {
  local name="$1"
  if [[ -n "$LOCAL_RELEASE" ]]; then
    cp "$LOCAL_RELEASE/$name" "$tmp/$name" || fail "$name is missing from $LOCAL_RELEASE."
    return
  fi
  if curl -fsSL "https://github.com/$REPO/releases/download/$tag/$name" -o "$tmp/$name" 2> /dev/null; then
    return
  fi
  if gh_ready && gh release download "$tag" -R "$REPO" -p "$name" -D "$tmp" --clobber > /dev/null 2>&1; then
    return
  fi
  fail "Could not download $name from release $tag."
}

tag="${CLUE_VERSION:-}"
if [[ -z "$LOCAL_RELEASE" ]]; then
  [[ -n "$tag" ]] || tag="$(latest_tag)"
else
  tag="local"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

download SHA256SUMS
download "$asset"

# A binary that doesn't match its published checksum is never installed.
expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
[[ -n "$expected" ]] || fail "$asset is not listed in the release checksums."
[[ "$(sha256 "$tmp/$asset")" == "$expected" ]] || fail "The download of $asset does not match its checksum. Nothing was installed."

was_installed=""
[[ -e "$TARGET" ]] && was_installed=1

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
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
echo "Next: run \`clue login\`, or set ANTHROPIC_API_KEY, then run \`clue\` in a project."

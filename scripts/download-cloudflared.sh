#!/usr/bin/env bash
# download-cloudflared.sh — Download cloudflared for a given target triple.
#
# Usage:
#   scripts/download-cloudflared.sh --target <triple>
#
# Examples:
#   scripts/download-cloudflared.sh --target x86_64-unknown-linux-gnu
#   scripts/download-cloudflared.sh --target aarch64-apple-darwin
#   scripts/download-cloudflared.sh --target x86_64-apple-darwin
#
# Output:
#   desktop/src-tauri/binaries/cloudflared-<triple>
#
# The cloudflared binary is downloaded from the GitHub releases latest page.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Error: --target <triple> is required" >&2
  echo "  e.g. --target x86_64-unknown-linux-gnu" >&2
  exit 1
fi

# Map Rust target triple → cloudflared GitHub release asset name.
# Cloudflare's release naming differs by OS: Linux ships the raw binary
# directly under the asset name (cloudflared-linux-amd64, etc.); macOS ships
# a .tgz archive (cloudflared-darwin-amd64.tgz, cloudflared-darwin-arm64.tgz)
# containing a `cloudflared` binary — there is no raw-binary macOS asset.
case "$TARGET" in
  x86_64-unknown-linux-gnu)
    CF_ASSET="cloudflared-linux-amd64"
    CF_IS_ARCHIVE=0
    ;;
  aarch64-unknown-linux-gnu)
    CF_ASSET="cloudflared-linux-arm64"
    CF_IS_ARCHIVE=0
    ;;
  aarch64-apple-darwin)
    CF_ASSET="cloudflared-darwin-arm64.tgz"
    CF_IS_ARCHIVE=1
    ;;
  x86_64-apple-darwin)
    CF_ASSET="cloudflared-darwin-amd64.tgz"
    CF_IS_ARCHIVE=1
    ;;
  *)
    echo "Error: unsupported target triple: $TARGET" >&2
    echo "  Supported: x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu," >&2
    echo "             aarch64-apple-darwin, x86_64-apple-darwin" >&2
    exit 1
    ;;
esac

OUT_DIR="$REPO_ROOT/desktop/src-tauri/binaries"
OUT_FILE="$OUT_DIR/cloudflared-$TARGET"

mkdir -p "$OUT_DIR"

DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/$CF_ASSET"

echo "==> Downloading cloudflared for $TARGET"
echo "    URL:    $DOWNLOAD_URL"
echo "    Output: $OUT_FILE"

if [[ "$CF_IS_ARCHIVE" -eq 1 ]]; then
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  TMP_TGZ="$TMP_DIR/cloudflared.tgz"

  if command -v curl &>/dev/null; then
    curl -fSL "$DOWNLOAD_URL" -o "$TMP_TGZ"
  elif command -v wget &>/dev/null; then
    wget -qO "$TMP_TGZ" "$DOWNLOAD_URL"
  else
    echo "Error: neither curl nor wget found on PATH." >&2
    exit 1
  fi

  tar -xzf "$TMP_TGZ" -C "$TMP_DIR"
  if [[ ! -f "$TMP_DIR/cloudflared" ]]; then
    echo "Error: expected a 'cloudflared' binary inside $CF_ASSET, none found." >&2
    exit 1
  fi
  mv "$TMP_DIR/cloudflared" "$OUT_FILE"
else
  if command -v curl &>/dev/null; then
    curl -fSL "$DOWNLOAD_URL" -o "$OUT_FILE"
  elif command -v wget &>/dev/null; then
    wget -qO "$OUT_FILE" "$DOWNLOAD_URL"
  else
    echo "Error: neither curl nor wget found on PATH." >&2
    exit 1
  fi
fi

chmod +x "$OUT_FILE"

echo "==> Done!"
echo "    $(du -h "$OUT_FILE" | cut -f1)  $OUT_FILE"

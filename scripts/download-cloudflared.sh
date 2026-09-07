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
# Cloudflare's release naming: cloudflared-linux-amd64, cloudflared-darwin-amd64, etc.
case "$TARGET" in
  x86_64-unknown-linux-gnu)
    CF_ASSET="cloudflared-linux-amd64"
    ;;
  aarch64-unknown-linux-gnu)
    CF_ASSET="cloudflared-linux-arm64"
    ;;
  aarch64-apple-darwin)
    CF_ASSET="cloudflared-darwin-arm64"
    ;;
  x86_64-apple-darwin)
    CF_ASSET="cloudflared-darwin-amd64"
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

if command -v curl &>/dev/null; then
  curl -fSL "$DOWNLOAD_URL" -o "$OUT_FILE"
elif command -v wget &>/dev/null; then
  wget -qO "$OUT_FILE" "$DOWNLOAD_URL"
else
  echo "Error: neither curl nor wget found on PATH." >&2
  exit 1
fi

chmod +x "$OUT_FILE"

echo "==> Done!"
echo "    $(du -h "$OUT_FILE" | cut -f1)  $OUT_FILE"

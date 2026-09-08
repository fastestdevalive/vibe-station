#!/usr/bin/env bash
# prep-sidecar.sh — Build the daemon binary and cloudflared for the host triple,
# then copy them into desktop/src-tauri/binaries/ for Tauri to bundle.
#
# Usage (called automatically by tauri.conf.json beforeBuildCommand):
#   scripts/prep-sidecar.sh
#
# What it does:
#   1. Detect host Rust target triple via rustc -vV
#   2. Build CLI TypeScript (pnpm --filter @vibestation/cli build)
#   3. Build daemon binary (scripts/build-daemon-binary.sh --target <triple>)
#   4. Copy dist/vst-daemon-<triple> → desktop/src-tauri/binaries/vst-daemon-<triple>
#   5. Download cloudflared for the host triple →
#      desktop/src-tauri/binaries/cloudflared-<triple>
#
# Tauri resolves externalBin entries by appending the host triple, so the
# triple suffix in the filename MUST match exactly what rustc reports.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Step 1: detect host triple ────────────────────────────────────────────────

echo "==> Detecting host target triple..."
TRIPLE="$(rustc -vV | grep '^host:' | awk '{print $2}')"
if [[ -z "$TRIPLE" ]]; then
  echo "Error: could not detect host triple from rustc -vV" >&2
  exit 1
fi
echo "    Triple: $TRIPLE"

BINARIES_DIR="$REPO_ROOT/desktop/src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

# ── Step 2: build CLI TypeScript ──────────────────────────────────────────────

echo ""
echo "==> Building CLI TypeScript (pnpm --filter @vibestation/cli build)..."
pnpm --filter @vibestation/cli build

# ── Step 3: build daemon binary ───────────────────────────────────────────────

echo ""
echo "==> Building daemon binary for $TRIPLE..."
bash "$SCRIPT_DIR/build-daemon-binary.sh" --target "$TRIPLE"

# ── Step 4: copy daemon binary to binaries/ ───────────────────────────────────

SRC_BIN="$REPO_ROOT/dist/vst-daemon-$TRIPLE"
DEST_BIN="$BINARIES_DIR/vst-daemon-$TRIPLE"

if [[ ! -f "$SRC_BIN" ]]; then
  echo "Error: expected daemon binary at $SRC_BIN — build may have failed." >&2
  exit 1
fi

echo ""
echo "==> Copying daemon binary to binaries/..."
cp "$SRC_BIN" "$DEST_BIN"
chmod +x "$DEST_BIN"
echo "    $(du -h "$DEST_BIN" | cut -f1)  $DEST_BIN"

# ── Step 5: build vst CLI binary ─────────────────────────────────────────────

echo ""
echo "==> Building vst CLI binary for $TRIPLE..."

# Map target triple to pkg's platform/arch notation (same mapping as daemon).
case "$TRIPLE" in
  x86_64-unknown-linux-gnu)  PKG_TARGET="node24-linux-x64" ;;
  aarch64-apple-darwin)      PKG_TARGET="node24-macos-arm64" ;;
  x86_64-apple-darwin)       PKG_TARGET="node24-macos-x64" ;;
  *)
    echo "Warning: unsupported triple for vst binary ($TRIPLE) — skipping vst sidecar build" >&2
    PKG_TARGET=""
    ;;
esac

if [[ -n "$PKG_TARGET" ]]; then
  CLI_ENTRY="$REPO_ROOT/cli/dist/main.js"
  if [[ ! -f "$CLI_ENTRY" ]]; then
    echo "Error: $CLI_ENTRY not found — run pnpm --filter @vibestation/cli build first." >&2
    exit 1
  fi
  CLI_BUNDLE="/tmp/vst-cli.bundle.cjs"
  npx esbuild "$CLI_ENTRY" \
    --bundle \
    --platform=node \
    --format=cjs \
    --external:"*.node" \
    --outfile="$CLI_BUNDLE"
  npx @yao-pkg/pkg "$CLI_BUNDLE" \
    --target "$PKG_TARGET" \
    --output "$REPO_ROOT/dist/vst-$TRIPLE"
  cp "$REPO_ROOT/dist/vst-$TRIPLE" "$BINARIES_DIR/vst-$TRIPLE"
  chmod +x "$BINARIES_DIR/vst-$TRIPLE"
  echo "    vst binary: $BINARIES_DIR/vst-$TRIPLE ($(du -h "$BINARIES_DIR/vst-$TRIPLE" | cut -f1))"
fi

# ── Step 6: download cloudflared ─────────────────────────────────────────────

echo ""
echo "==> Downloading cloudflared for $TRIPLE..."
bash "$SCRIPT_DIR/download-cloudflared.sh" --target "$TRIPLE"

echo ""
echo "==> prep-sidecar done!"
echo "    binaries/:"
ls -lh "$BINARIES_DIR"

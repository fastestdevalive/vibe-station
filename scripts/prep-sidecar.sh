#!/usr/bin/env bash
# prep-sidecar.sh — Build the Rust daemon + CLI binaries and cloudflared for the
# host triple, then copy them into desktop/src-tauri/binaries/ for Tauri to bundle.
#
# Usage (called automatically by tauri.conf.json beforeBuildCommand):
#   scripts/prep-sidecar.sh
#
# What it does:
#   1. Detect host Rust target triple via rustc -vV
#   2. Build the Rust vst-daemon + vst-cli release binaries (cargo build --release)
#   3. Copy rust/target/release/vst-daemon → desktop/src-tauri/binaries/vst-daemon-<triple>
#   4. Copy rust/target/release/vst-cli     → desktop/src-tauri/binaries/vst-<triple>
#   5. Download cloudflared for the host triple →
#      desktop/src-tauri/binaries/cloudflared-<triple>
#
# Tauri resolves externalBin entries by appending the host triple, so the
# triple suffix in the filename MUST match exactly what rustc reports.
#
# This builds the Rust binaries (the "build:rust" script from part 10) and does
# NOT touch the TypeScript daemon/ or cli/ trees at all — the desktop sidecar is
# now the Rust vst-daemon/vst-cli, not a @yao-pkg/pkg-packaged Node binary (the
# old build-daemon-binary.sh path produced a 75 MB Node binary that couldn't
# even boot — an ESM/import.meta vs CJS-bundle bug, see the 10-2 N1/N2 report).

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

# ── Step 2: build the Rust daemon + CLI binaries ─────────────────────────────

echo ""
echo "==> Building Rust binaries (vst-daemon, vst-cli)..."
cargo build --release --manifest-path "$REPO_ROOT/rust/Cargo.toml" -p vst-daemon -p vst-cli

# ── Step 3: copy vst-daemon binary to binaries/ ──────────────────────────────

SRC_DAEMON="$REPO_ROOT/rust/target/release/vst-daemon"
DEST_DAEMON="$BINARIES_DIR/vst-daemon-$TRIPLE"

if [[ ! -f "$SRC_DAEMON" ]]; then
  echo "Error: expected daemon binary at $SRC_DAEMON — build may have failed." >&2
  exit 1
fi

echo ""
echo "==> Copying vst-daemon binary to binaries/..."
cp "$SRC_DAEMON" "$DEST_DAEMON"
chmod +x "$DEST_DAEMON"
echo "    $(du -h "$DEST_DAEMON" | cut -f1)  $DEST_DAEMON"

# ── Step 4: copy vst CLI binary to binaries/ ─────────────────────────────────

SRC_CLI="$REPO_ROOT/rust/target/release/vst-cli"
DEST_CLI="$BINARIES_DIR/vst-$TRIPLE"

if [[ ! -f "$SRC_CLI" ]]; then
  echo "Error: expected vst CLI binary at $SRC_CLI — build may have failed." >&2
  exit 1
fi

echo ""
echo "==> Copying vst CLI binary to binaries/..."
cp "$SRC_CLI" "$DEST_CLI"
chmod +x "$DEST_CLI"
echo "    $(du -h "$DEST_CLI" | cut -f1)  $DEST_CLI"

# ── Step 5: download cloudflared ─────────────────────────────────────────────

echo ""
echo "==> Downloading cloudflared for $TRIPLE..."
bash "$SCRIPT_DIR/download-cloudflared.sh" --target "$TRIPLE"

echo ""
echo "==> prep-sidecar done!"
echo "    binaries/:"
ls -lh "$BINARIES_DIR"

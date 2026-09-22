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
#   6. Install the vendored claude-agent-acp adapter
#      (vendor/claude-acp/node_modules, via install-claude-acp-vendor.sh) —
#      tauri.conf.json's bundle.resources ships it as
#      claude-acp-vendor/node_modules, so it must exist before bundling.
#   7. Build the agy-acp adapter (vendored openab submodule, built in
#      isolation) → desktop/src-tauri/binaries/agy-acp-<triple>
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

# Windows cargo binaries carry a .exe suffix; Tauri's externalBin resolution
# expects the bundled sidecar filename to match, i.e. `vst-daemon-<triple>.exe`.
# The old pkg-based script never needed this (pkg's own --target flag picked
# the right OS ext internally); a bare `cp` here would silently produce a
# sidecar with the wrong name on Windows.
EXE_SUFFIX=""
case "$TRIPLE" in
  *windows*) EXE_SUFFIX=".exe" ;;
esac

# `tauri build --target universal-apple-darwin` (the normal macOS release
# target) needs a `vst-daemon-universal-apple-darwin`/`vst-universal-apple-darwin`
# binary — a fat/universal (arm64+x86_64) binary produced via `lipo`, built
# from TWO separate `cargo build --target aarch64-apple-darwin`/
# `--target x86_64-apple-darwin` runs. This script only ever builds for the
# HOST triple (`rustc -vV`), so it cannot produce that on its own. Warn loudly
# rather than silently shipping a single-arch binary under the universal name
# (which would run on the build machine's own arch but fail to launch on the
# other one) — same spirit as the old script's graceful, visible skip for an
# unsupported vst-CLI pkg target.
if [[ "$TRIPLE" == *-apple-darwin ]]; then
  echo "" >&2
  echo "WARNING: building for host triple $TRIPLE only. If this build is" >&2
  echo "  packaged with 'tauri build --target universal-apple-darwin', you" >&2
  echo "  must separately build BOTH aarch64-apple-darwin and" >&2
  echo "  x86_64-apple-darwin release binaries and lipo them together into" >&2
  echo "  desktop/src-tauri/binaries/{vst-daemon,vst}-universal-apple-darwin" >&2
  echo "  BEFORE the Tauri bundling step — this script does not do that for" >&2
  echo "  you, and a single-arch binary under the universal name will fail" >&2
  echo "  to launch on the architecture it wasn't built for." >&2
fi

BINARIES_DIR="$REPO_ROOT/desktop/src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

# ── Step 2: build the Rust daemon + CLI binaries ─────────────────────────────

echo ""
echo "==> Building Rust binaries (vst-daemon, vst-cli)..."
cargo build --release --manifest-path "$REPO_ROOT/rust/Cargo.toml" -p vst-daemon -p vst-cli

# ── Step 3: copy vst-daemon binary to binaries/ ──────────────────────────────

SRC_DAEMON="$REPO_ROOT/rust/target/release/vst-daemon$EXE_SUFFIX"
DEST_DAEMON="$BINARIES_DIR/vst-daemon-$TRIPLE$EXE_SUFFIX"

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

SRC_CLI="$REPO_ROOT/rust/target/release/vst$EXE_SUFFIX"
DEST_CLI="$BINARIES_DIR/vst-$TRIPLE$EXE_SUFFIX"

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

# ── Step 6: install the vendored claude-agent-acp adapter ────────────────────
# Not a binary, but staged here anyway so this script stays the single "make
# every bundle input exist" step `beforeBuildCommand` runs — Tauri reads
# bundle.resources only after beforeBuildCommand finishes, and a missing
# resource path fails the build outright. The adapter is platform-neutral JS
# (optional per-platform packages are omitted, see that script's header), so
# unlike the binaries above it needs no triple suffix. Run by `bun` at
# runtime; the desktop host passes its path to the daemon as
# VST_CLAUDE_ACP_ENTRY (desktop/src-tauri/src/daemon.rs).

echo ""
echo "==> Installing vendored claude-agent-acp adapter..."
bash "$SCRIPT_DIR/install-claude-acp-vendor.sh"

# ── Step 7: build agy-acp adapter (vendored submodule) ───────────────────────

echo ""
echo "==> Building agy-acp adapter (vendored openab submodule, in isolation)..."
if [[ ! -d "$REPO_ROOT/rust/vendor/openab/agy-acp" ]]; then
  echo "Error: agy-acp submodule not present at rust/vendor/openab. Clone it with:
  git submodule update --init --recursive
  (or clone the repo with --recurse-submodules)" >&2
  exit 1
fi
cargo build --release --locked \
  --manifest-path "$REPO_ROOT/rust/vendor/openab/agy-acp/Cargo.toml" \
  --target-dir "$REPO_ROOT/rust/target/agy-acp"

SRC_AGY_ACP="$REPO_ROOT/rust/target/agy-acp/release/agy-acp$EXE_SUFFIX"
DEST_AGY_ACP="$BINARIES_DIR/agy-acp-$TRIPLE$EXE_SUFFIX"

if [[ ! -f "$SRC_AGY_ACP" ]]; then
  echo "Error: expected agy-acp binary at $SRC_AGY_ACP — build may have failed." >&2
  exit 1
fi

echo ""
echo "==> Copying agy-acp binary to binaries/..."
cp "$SRC_AGY_ACP" "$DEST_AGY_ACP"
chmod +x "$DEST_AGY_ACP"
echo "    $(du -h "$DEST_AGY_ACP" | cut -f1)  $DEST_AGY_ACP"

echo ""
echo "==> prep-sidecar done!"
echo "    binaries/:"
ls -lh "$BINARIES_DIR"

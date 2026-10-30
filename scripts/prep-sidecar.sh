#!/usr/bin/env bash
# prep-sidecar.sh — Build the merged vst binary (CLI + daemon) for the host
# triple, then copy it into desktop/src-tauri/binaries/ for Tauri to bundle.
#
# Usage (called automatically by tauri.conf.json beforeBuildCommand):
#   scripts/prep-sidecar.sh
#
# What it does:
#   1. Detect host Rust target triple via rustc -vV
#   2. Build the web UI (pnpm build) — required BEFORE the cargo build below,
#      since the merged binary embeds web-ui/dist at compile time via the
#      `embed-ui` Cargo feature (rust-embed reads the directory at build time).
#   3. Build the merged vst release binary, with --features vst-daemon/embed-ui
#      (cargo build --release) — one binary is both the CLI and, via
#      `vst daemon run`, the daemon; see rust/vst-cli/src/dispatch.rs.
#   4. Copy rust/target/release/vst → desktop/src-tauri/binaries/vst-<triple>
#   5. Build the claude-acp adapter (pinned Rust port, build-rust-acp.sh) →
#      desktop/src-tauri/binaries/claude-acp-<triple>
#   6. Build the codex-acp adapter (pinned Rust port) →
#      desktop/src-tauri/binaries/codex-acp-<triple>
#
# Tauri resolves externalBin entries by appending the host triple, so the
# triple suffix in the filename MUST match exactly what rustc reports.
#
# This builds the Rust binaries (the "build:rust" script from part 10) and does
# NOT touch the TypeScript daemon/ or cli/ trees at all — the desktop sidecar is
# now the single merged Rust `vst` binary, not a @yao-pkg/pkg-packaged Node
# binary (the old build-daemon-binary.sh path produced a 75 MB Node binary that
# couldn't even boot — an ESM/import.meta vs CJS-bundle bug, see the 10-2
# N1/N2 report) and, as of the cli-daemon-unification feature, not two
# separate Rust binaries (vst-daemon + vst) either — see
# .vibekit/feature-plans/wip/cli-daemon-unification/00-binary-merge/
# plan-00-cli-daemon-unification-binary-merge.md.

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
  echo "  desktop/src-tauri/binaries/vst-universal-apple-darwin" >&2
  echo "  BEFORE the Tauri bundling step — this script does not do that for" >&2
  echo "  you, and a single-arch binary under the universal name will fail" >&2
  echo "  to launch on the architecture it wasn't built for." >&2
fi

BINARIES_DIR="$REPO_ROOT/desktop/src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

# ── Step 2: build the web UI (must exist before the embed-ui cargo build) ───

echo ""
echo "==> Building web UI (pnpm --filter @vibestation/web build)..."
pnpm --filter @vibestation/web build

# ── Step 3: build the merged vst binary (CLI + daemon, web UI embedded) ─────

echo ""
echo "==> Building merged vst binary (--features vst-daemon/embed-ui)..."
cargo build --release --manifest-path "$REPO_ROOT/rust/Cargo.toml" \
  -p vst-cli --features vst-daemon/embed-ui

# ── Step 4: copy vst binary to binaries/ ─────────────────────────────────────

SRC_CLI="$REPO_ROOT/rust/target/release/vst$EXE_SUFFIX"
DEST_CLI="$BINARIES_DIR/vst-$TRIPLE$EXE_SUFFIX"

if [[ ! -f "$SRC_CLI" ]]; then
  echo "Error: expected vst binary at $SRC_CLI — build may have failed." >&2
  exit 1
fi

# grep the binary directly: `strings | grep -q` under pipefail misses a match (SIGPIPE on strings).
if grep -qaF "INSECURE: VST_NO_AUTH=1 is active" "$SRC_CLI"; then
  echo "Error: release binary was built with insecure-no-auth feature!" >&2
  exit 1
fi

echo ""
echo "==> Copying vst binary to binaries/..."
cp "$SRC_CLI" "$DEST_CLI"
chmod +x "$DEST_CLI"
echo "    $(du -h "$DEST_CLI" | cut -f1)  $DEST_CLI"

# ── Step 5: build the claude-acp adapter (pinned Rust port) ─────────────────
# A self-contained executable staged as
# binaries/claude-acp-<triple>, which Tauri places beside `vst` at runtime where
# the daemon finds it (rust/vst-agents/src/claude.rs `claude_acp_bin`). Pinned
# in vendor/rust-acp/pins.toml; a pinned prebuilt download, no bun/node.

echo ""
echo "==> Building claude-acp adapter (pinned Rust port)..."
SRC_CLAUDE_ACP="$(bash "$SCRIPT_DIR/build-rust-acp.sh" claude)"
DEST_CLAUDE_ACP="$BINARIES_DIR/claude-acp-$TRIPLE$EXE_SUFFIX"
cp "$SRC_CLAUDE_ACP" "$DEST_CLAUDE_ACP"
chmod +x "$DEST_CLAUDE_ACP"
echo "    $(du -h "$DEST_CLAUDE_ACP" | cut -f1)  $DEST_CLAUDE_ACP"

# ── Step 6: build the codex-acp adapter (pinned Rust port) ───────────────────
# Same sidecar shape as claude-acp above (codex.rs `codex_acp_bin`).

echo ""
echo "==> Building codex-acp adapter (pinned Rust port)..."
SRC_CODEX_ACP="$(bash "$SCRIPT_DIR/build-rust-acp.sh" codex)"
DEST_CODEX_ACP="$BINARIES_DIR/codex-acp-$TRIPLE$EXE_SUFFIX"
cp "$SRC_CODEX_ACP" "$DEST_CODEX_ACP"
chmod +x "$DEST_CODEX_ACP"
echo "    $(du -h "$DEST_CODEX_ACP" | cut -f1)  $DEST_CODEX_ACP"

echo ""
echo "==> prep-sidecar done!"
echo "    binaries/:"
ls -lh "$BINARIES_DIR"

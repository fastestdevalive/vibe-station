#!/usr/bin/env bash
# dev-start.sh — beforeDevCommand for tauri dev.
#
# 1. Creates stub sidecar binaries so Tauri's build.rs resource-path check
#    passes at compile time. The stubs are never actually invoked in dev
#    because detect_running_daemon() finds the already-running Rust daemon in
#    config.json.
# 2. Builds vst-cli (debug) so the daemon can write the ~/.vibe-station/bin/vst
#    shim. `cargo run -p vst-daemon` only compiles vst-daemon, so vst-cli would
#    be absent on a fresh checkout or after `cargo clean`.
# 3. Builds web-ui/dist, which the daemon serves to non-Vite clients (LAN/tunnel,
#    curl). The desktop window loads Vite directly and never needs this, but
#    other clients get a stale dist without it.
# 4. Fetches the claude-acp / codex-acp Rich Chat adapters (pinned prebuilts,
#    scripts/build-rust-acp.sh) and points the daemon at them.
# 5. Runs the Rust daemon and Vite dev server concurrently, with VST_CLI_BIN set
#    so the daemon writes the shim on first boot.
#    The daemon ALWAYS authenticates (no loopback trust). The Tauri window gets its
#    token injected, so it just works; a plain browser pointed at Vite shows the
#    login screen — mint a one-time link: POST /api/auth/continue/mint with the
#    cliToken from ~/.vibe-station/config.json, then open /continue?code=<code>.
#
# Called from desktop/src-tauri/tauri.conf.json beforeDevCommand.
# CWD when invoked: desktop/ (where `tauri dev` is run)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ensure cargo/rustc is on PATH (not always set in GUI/shell-launched envs).
# shellcheck source=/dev/null
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

# Detect host triple — same method as prep-sidecar.sh uses for prod.
TRIPLE=$(rustc -vV 2>/dev/null | grep '^host:' | awk '{print $2}')
if [[ -z "$TRIPLE" ]]; then
  echo "[dev-start] warning: rustc not found; guessing triple as x86_64-unknown-linux-gnu" >&2
  TRIPLE="x86_64-unknown-linux-gnu"
fi

# Create stub binaries in desktop/src-tauri/binaries/.
# Tauri only checks that these paths exist — the stub is never executed in dev.
# (No vst-daemon stub anymore — externalBin dropped it once vst-cli/vst-daemon
# merged into one `vst` binary; this script's own `cargo run -p vst-daemon`
# below is unrelated to Tauri's sidecar resolution.)
BINARIES_DIR="$REPO_ROOT/desktop/src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

VST_STUB="$BINARIES_DIR/vst-$TRIPLE"

if [[ ! -f "$VST_STUB" ]]; then
  printf '#!/bin/sh\necho "dev stub — not for direct execution"\n' > "$VST_STUB"
  chmod +x "$VST_STUB"
  echo "[dev-start] created vst stub: $VST_STUB"
fi

for ACP in claude-acp codex-acp; do
  ACP_STUB="$BINARIES_DIR/$ACP-$TRIPLE"
  if [[ ! -f "$ACP_STUB" ]]; then
    printf '#!/bin/sh\necho "dev stub — not for direct execution"\n' > "$ACP_STUB"
    chmod +x "$ACP_STUB"
    echo "[dev-start] created $ACP stub: $ACP_STUB"
  fi
done

# Build vst-cli so the daemon can write the ~/.vibe-station/bin/vst shim pointing
# at the real Rust binary. `cargo run -p vst-daemon` only compiles vst-daemon, so
# vst-cli would be missing on a fresh checkout or after `cargo clean`.
echo "[dev-start] building vst-cli (debug)..."
cargo build --manifest-path "$REPO_ROOT/rust/Cargo.toml" -p vst-cli
VST_CLI_BIN="$REPO_ROOT/rust/target/debug/vst"

# Build web-ui/dist so the daemon serves current UI to non-Vite clients from
# the moment it starts, instead of a build left over from a previous session.
echo "[dev-start] building web-ui/dist..."
pnpm --filter @vibestation/web build

# Rust ACP adapters (pinned in vendor/rust-acp/pins.toml). Always run via the
# script: it reuses its download cache and re-asserts the pinned upstream level.
# To test an unreleased port, set VST_CLAUDE_ACP_REPO / VST_CODEX_ACP_REPO (see the script header).
echo "[dev-start] fetching claude-acp / codex-acp adapters..."
# An adapter that cannot be fetched (offline, no prebuilt pinned for this target) must not stop `tauri dev`:
# warn, leave the env unset, and let `vst doctor` report that harness's Rich Chat as unavailable.
CLAUDE_ACP_BIN="$(bash "$REPO_ROOT/scripts/build-rust-acp.sh" claude)" || { echo "[dev-start] WARNING: claude-acp not built — Claude Rich Chat unavailable" >&2; CLAUDE_ACP_BIN=""; }
CODEX_ACP_BIN="$(bash "$REPO_ROOT/scripts/build-rust-acp.sh" codex)" || { echo "[dev-start] WARNING: codex-acp not built — Codex Rich Chat unavailable" >&2; CODEX_ACP_BIN=""; }

# Launch Rust daemon + Vite dev server concurrently.
# --kill-others-on-fail: if either exits, kill the other (prevents orphaned daemon).
# Don't exec — we need the shell alive to run the SIGTERM trap below.
npx concurrently --kill-others-on-fail \
  "PORT=5180 pnpm --filter @vibestation/web dev" \
  "VST_ALLOWED_ORIGINS=http://localhost:5180 VST_DIST_PATH='$REPO_ROOT/web-ui/dist' VST_CLI_BIN='$VST_CLI_BIN' VST_CLAUDE_ACP_BIN='$CLAUDE_ACP_BIN' VST_CODEX_ACP_BIN='$CODEX_ACP_BIN' cargo run --manifest-path '$REPO_ROOT/rust/Cargo.toml' -p vst-daemon" &
CONC_PID=$!

trap '
  TS=$(date -Iseconds)
  echo "[dev-start] $TS — SIGTERM received by dev-start.sh (pid $$)"
  if pgrep -f vibe-station-desktop > /dev/null 2>&1; then
    echo "[dev-start] $TS — Tauri window is STILL ALIVE (something else sent SIGTERM)"
    pgrep -fa vibe-station-desktop
  else
    echo "[dev-start] $TS — Tauri window is GONE (Tauri closed and killed its process group)"
  fi
  echo "[dev-start] $TS — killing concurrently (pid $CONC_PID)"
  kill "$CONC_PID" 2>/dev/null
' SIGTERM SIGINT

wait "$CONC_PID"

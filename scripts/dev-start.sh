#!/usr/bin/env bash
# dev-start.sh — beforeDevCommand for tauri dev.
#
# 1. Creates a stub sidecar binary so Tauri's build.rs resource-path check
#    passes at compile time. The stub is never actually invoked in dev because
#    detect_running_daemon() finds the already-running Rust daemon in config.json.
# 2. Builds vst-cli (debug) so the daemon can write the ~/.vibe-station/bin/vst
#    shim. `cargo run -p vst-daemon` only compiles vst-daemon, so vst-cli would
#    be absent on a fresh checkout or after `cargo clean`.
# 3. Builds web-ui/dist, which the daemon serves to non-Vite clients (LAN/tunnel,
#    curl). The desktop window loads Vite directly and never needs this, but
#    other clients get a stale dist without it.
# 4. Installs the vendored claude-agent-acp adapter if missing — it's a
#    tauri.conf.json bundle.resources entry, so build.rs's resource-path check
#    fails without it, and the dev daemon needs it for Claude Rich Chat anyway.
# 5. Runs the Rust daemon and Vite dev server concurrently, with VST_CLI_BIN set
#    so the daemon writes the shim on first boot.
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
BINARIES_DIR="$REPO_ROOT/desktop/src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

DAEMON_STUB="$BINARIES_DIR/vst-daemon-$TRIPLE"
CF_STUB="$BINARIES_DIR/cloudflared-$TRIPLE"
VST_STUB="$BINARIES_DIR/vst-$TRIPLE"

if [[ ! -f "$DAEMON_STUB" ]]; then
  printf '#!/bin/sh\necho "dev stub — not for direct execution"\n' > "$DAEMON_STUB"
  chmod +x "$DAEMON_STUB"
  echo "[dev-start] created daemon stub: $DAEMON_STUB"
fi

if [[ ! -f "$CF_STUB" ]]; then
  printf '#!/bin/sh\necho "dev stub — not for direct execution"\n' > "$CF_STUB"
  chmod +x "$CF_STUB"
  echo "[dev-start] created cloudflared stub: $CF_STUB"
fi

if [[ ! -f "$VST_STUB" ]]; then
  printf '#!/bin/sh\necho "dev stub — not for direct execution"\n' > "$VST_STUB"
  chmod +x "$VST_STUB"
  echo "[dev-start] created vst stub: $VST_STUB"
fi

# Build vst-cli so the daemon can write the ~/.vibe-station/bin/vst shim pointing
# at the real Rust binary. `cargo run -p vst-daemon` only compiles vst-daemon, so
# vst-cli would be missing on a fresh checkout or after `cargo clean`.
echo "[dev-start] building vst-cli (debug)..."
cargo build --manifest-path "$REPO_ROOT/rust/Cargo.toml" -p vst-cli
VST_CLI_BIN="$REPO_ROOT/rust/target/debug/vst"

# Build the agy-acp adapter so the dev daemon can resolve it via AGY_ACP_BIN
# (Rich Chat with the agy CLI needs this binary; without it the spawn fails
# before ACP's initialize handshake completes). build-agy-acp.sh prints the
# resolved binary path on stdout and is a no-op-if-already-built in the sense
# that cargo skips an up-to-date build.
echo "[dev-start] building agy-acp adapter..."
AGY_ACP_BIN="$(bash "$REPO_ROOT/scripts/build-agy-acp.sh")"

# Build web-ui/dist so the daemon serves current UI to non-Vite clients from
# the moment it starts, instead of a build left over from a previous session.
echo "[dev-start] building web-ui/dist..."
pnpm --filter @vibestation/web build

# Vendored claude-agent-acp adapter: required by build.rs (bundle.resources)
# and by the daemon's Claude ACP path. Always run the install script rather
# than skip-if-file-exists: `bun install` with an already-satisfied lockfile
# is a ~15ms no-op (confirmed), so there is no real cost to always checking —
# and a skip-if-present guard would silently leave a stale adapter installed
# forever after `vendor/claude-acp/package.json` bumps the pinned version,
# since the file would already exist and never get re-checked.
echo "[dev-start] checking vendored claude-agent-acp adapter..."
bash "$REPO_ROOT/scripts/install-claude-acp-vendor.sh"
CLAUDE_ACP_ENTRY="$REPO_ROOT/vendor/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"

# Launch Rust daemon + Vite dev server concurrently.
# --kill-others-on-fail: if either exits, kill the other (prevents orphaned daemon).
# Don't exec — we need the shell alive to run the SIGTERM trap below.
npx concurrently --kill-others-on-fail \
  "PORT=5180 pnpm --filter @vibestation/web dev" \
  "VST_DIST_PATH='$REPO_ROOT/web-ui/dist' VST_CLI_BIN='$VST_CLI_BIN' VST_CLAUDE_ACP_ENTRY='$CLAUDE_ACP_ENTRY' AGY_ACP_BIN='$AGY_ACP_BIN' cargo run --manifest-path '$REPO_ROOT/rust/Cargo.toml' -p vst-daemon" &
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

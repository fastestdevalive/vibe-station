#!/usr/bin/env bash
# dev-start.sh — beforeDevCommand for tauri dev.
#
# 1. Creates a stub sidecar binary so Tauri's build.rs resource-path check
#    passes at compile time. The stub is never actually invoked in dev because
#    detect_running_daemon() finds the tsx-launched daemon in config.json first.
# 2. Builds web-ui/dist, which the daemon serves (via fastify-static) to any
#    client that isn't the desktop window itself — LAN/tunnel clients, and
#    `curl` against the daemon port. The desktop window always loads Vite
#    directly instead, so it never needed this, but without it those other
#    clients get whatever dist was last built for, however stale.
# 3. Runs the daemon (tsx watch) and Vite dev server concurrently.
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

# Build web-ui/dist so the daemon serves current UI to non-Vite clients from
# the moment it starts, instead of a build left over from a previous session.
echo "[dev-start] building web-ui/dist..."
pnpm --filter @vibestation/web build

# Launch daemon (tsx watch) + Vite dev server concurrently.
# --kill-others-on-fail: if either exits, kill the other (prevents orphaned daemon).
# Don't exec — we need the shell alive to run the SIGTERM trap below.
npx concurrently --kill-others-on-fail \
  "PORT=5180 pnpm --filter @vibestation/web dev" \
  "tsx watch --tsconfig '$REPO_ROOT/daemon/tsconfig.json' '$REPO_ROOT/daemon/src/main.ts'" &
CONC_PID=$!

trap '
  TS=$(date -Iseconds)
  echo "[dev-start] $TS — SIGTERM received by dev-start.sh (pid $$)"
  if pgrep -x vibe-station-desktop > /dev/null 2>&1; then
    echo "[dev-start] $TS — Tauri window is STILL ALIVE (something else sent SIGTERM)"
    pgrep -la vibe-station-desktop
  else
    echo "[dev-start] $TS — Tauri window is GONE (Tauri closed and killed its process group)"
  fi
  echo "[dev-start] $TS — killing concurrently (pid $CONC_PID)"
  kill "$CONC_PID" 2>/dev/null
' SIGTERM SIGINT

wait "$CONC_PID"

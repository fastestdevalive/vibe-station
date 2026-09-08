#!/usr/bin/env bash
# dev-start.sh — beforeDevCommand for tauri dev.
#
# 1. Creates a stub sidecar binary so Tauri's build.rs resource-path check
#    passes at compile time. The stub is never actually invoked in dev because
#    detect_running_daemon() finds the tsx-launched daemon in config.json first.
# 2. Runs the daemon (tsx watch) and Vite dev server concurrently.
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

# Launch daemon (tsx watch) + Vite dev server concurrently.
# --kill-others-on-fail: if either exits, kill the other (prevents orphaned daemon).
exec npx concurrently --kill-others-on-fail \
  "pnpm --filter @vibestation/web dev --port 5180" \
  "tsx watch --tsconfig '$REPO_ROOT/daemon/tsconfig.json' '$REPO_ROOT/daemon/src/main.ts'"

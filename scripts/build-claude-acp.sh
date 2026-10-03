#!/usr/bin/env bash
# build-claude-acp.sh — compile the pinned Claude ACP adapter into one
# self-contained executable (`bun build --compile`), and print its path on stdout.
#
#   scripts/build-claude-acp.sh [--target <rust-triple>]
#
# The adapter (@agentclientprotocol/claude-agent-acp, pinned in
# vendor/claude-acp/package.json) is bundled together with the bun runtime, so
# the curl-installed `vst` needs neither bun nor node for claude Rich Chat. The
# daemon finds it as `claude-acp` beside the `vst` executable
# (rust/vst-agents/src/claude.rs `claude_acp_bin`).
#
# `--target` cross-compiles (bun downloads the target runtime), so any host can
# build any release target. The vendor install is the `--omit=optional` one:
# the SDK's per-platform `claude` binaries are not bundled — the adapter runs the
# user's own `claude` via CLAUDE_CODE_EXECUTABLE.
#
# Output contract: ONLY the absolute binary path on stdout; logs go to stderr.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIPLE="${CLAUDE_ACP_TARGET:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || { echo "Error: --target needs a value" >&2; exit 1; }; TRIPLE="$2"; shift 2 ;;
    --target=*) TRIPLE="${1#*=}"; shift ;;
    *) echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v bun >/dev/null 2>&1 || { echo "Error: bun not found on PATH — https://bun.sh" >&2; exit 1; }

BUN_TARGET_ARGS=()
OUT_DIR="$REPO_ROOT/rust/target/claude-acp/${TRIPLE:-host}"
case "$TRIPLE" in
  "") ;;
  x86_64-unknown-linux-musl)  BUN_TARGET_ARGS=(--target=bun-linux-x64-musl-baseline) ;;
  aarch64-unknown-linux-musl) BUN_TARGET_ARGS=(--target=bun-linux-arm64-musl) ;;
  x86_64-unknown-linux-gnu)   BUN_TARGET_ARGS=(--target=bun-linux-x64-baseline) ;;
  aarch64-unknown-linux-gnu)  BUN_TARGET_ARGS=(--target=bun-linux-arm64) ;;
  aarch64-apple-darwin)       BUN_TARGET_ARGS=(--target=bun-darwin-arm64) ;;
  x86_64-apple-darwin)        BUN_TARGET_ARGS=(--target=bun-darwin-x64-baseline) ;;
  *) echo "Error: no bun compile target known for $TRIPLE" >&2; exit 1 ;;
esac

echo "==> Installing pinned claude adapter (vendor/claude-acp)..." >&2
bash "$REPO_ROOT/scripts/install-claude-acp-vendor.sh" >&2

ENTRY="$REPO_ROOT/vendor/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
[[ -f "$ENTRY" ]] || { echo "Error: adapter entry missing: $ENTRY" >&2; exit 1; }

mkdir -p "$OUT_DIR"
BIN="$OUT_DIR/claude-acp"
echo "==> bun build --compile ${BUN_TARGET_ARGS[*]:-(host)} ..." >&2
bun build --compile ${BUN_TARGET_ARGS[@]+"${BUN_TARGET_ARGS[@]}"} "$ENTRY" --outfile "$BIN" >&2
[[ -x "$BIN" ]] || { echo "Error: expected $BIN after compile" >&2; exit 1; }
echo "$BIN"

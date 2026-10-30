#!/usr/bin/env bash
# claude-protocol-parity.sh — Layer A of the rust-acp-adapters parity proof.
#
# Drives the SAME scripted ACP client (the port's acp-recorder) with the SAME
# fake-claude transcripts against three adapters and normalises the resulting
# session/update streams identically (the port's capture.sh normaliser):
#
#   node : npm @agentclientprotocol/claude-agent-acp@<pin> run by node (the port's baseline)
#   bun  : the same npm package run by `bun` — what vibe-station launched before this change
#   rust : the pinned Rust binary vibe-station now launches (scripts/build-rust-acp.sh claude)
#
# then compares bun vs node (does the runtime matter?) and rust vs bun (parity),
# applying the port's documented ignore list (compare-frames.mjs).
#
#   VST_CLAUDE_ACP_REPO=<local clone containing the pinned rev> scripts/parity/claude-protocol-parity.sh [workdir]
#
# No credentials needed: fake-claude replaces the real `claude`. Everything is
# written under <workdir> (default: mktemp) or the isolated clone's own rust/target.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${1:-$(mktemp -d)}"; mkdir -p "$WORK"
BUN="$(command -v bun)"; NODE="$(command -v node)"
RUST_BIN="$(env -u VST_CLAUDE_ACP_REPO bash "$REPO_ROOT/scripts/build-rust-acp.sh" claude)"   # the shipped prebuilt, not a source build
SRC="$(bash "$REPO_ROOT/scripts/build-rust-acp.sh" claude --print-src)"   # clean clone at the pinned rev
echo "workdir: $WORK" >&2
echo "node: $($NODE -v)  bun: $($BUN -v)  rust: $($RUST_BIN --version)" >&2

shim() { # shim <dir> <kind>
  mkdir -p "$1"
  case "$2" in
    node) ln -sf "$NODE" "$1/node" ;;
    bun)  printf '#!/bin/sh\ncase "$1" in */dist/index.js) exec "%s" "$@";; esac\nexec "%s" "$@"\n' "$BUN" "$NODE" > "$1/node" ;;
    rust) printf '#!/bin/sh\ncase "$1" in */dist/index.js) exec "%s";; esac\nexec "%s" "$@"\n' "$RUST_BIN" "$NODE" > "$1/node" ;;
  esac
  chmod +x "$1/node"
}

for kind in node bun rust; do
  shim "$WORK/shim-$kind" "$kind"
  echo "==> capturing with $kind" >&2
  mkdir -p "$WORK/frames-$kind"
  ( cd "$SRC" && PATH="$WORK/shim-$kind:$PATH" CAPTURE_OUT_DIR="$WORK/frames-$kind" \
      UPSTREAM_CACHE_DIR="$WORK/upstream" bash porting/capture.sh ) > "$WORK/capture-$kind.log" 2>&1 \
    || { echo "capture ($kind) failed; see $WORK/capture-$kind.log" >&2; tail -20 "$WORK/capture-$kind.log" >&2; exit 1; }
done

echo "==> bun vs node (runtime equivalence)"
node "$HERE/compare-frames.mjs" --strict "$WORK/frames-node" "$WORK/frames-bun" | tee "$WORK/bun-vs-node.txt"
echo "==> node fixtures vs the port's committed fixtures"
node "$HERE/compare-frames.mjs" --strict "$SRC/porting/fixtures" "$WORK/frames-node" | tee "$WORK/node-vs-committed.txt" || true
echo "==> rust vs bun (parity)"
node "$HERE/compare-frames.mjs" "$WORK/frames-bun" "$WORK/frames-rust" | tee "$WORK/rust-vs-bun.txt"

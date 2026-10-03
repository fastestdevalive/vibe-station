#!/usr/bin/env bash
# package-cli-tarball.sh — assemble the standalone CLI release tarball.
#
#   scripts/package-cli-tarball.sh <vst-bin> <agy-acp-bin> <claude-acp-bin> <out.tar.gz>
#
# Layout (flat; scripts/install.sh installs every executable beside `vst`):
#   vst
#   agy-acp      (found by vst_agy_acp::agy_acp_bin: beside current_exe)
#   claude-acp   (found by vst_agents::claude::claude_acp_bin: beside current_exe)
# claude-acp is the pinned Claude ACP adapter compiled with the bun runtime
# (scripts/build-claude-acp.sh), so no bun/node is needed at runtime.

set -euo pipefail

[[ $# -eq 4 ]] || { echo "usage: $0 <vst-bin> <agy-acp-bin> <claude-acp-bin> <out.tar.gz>" >&2; exit 1; }
VST_BIN="$1"; AGY_BIN="$2"; CLAUDE_BIN="$3"; OUT="$4"

for f in "$VST_BIN" "$AGY_BIN" "$CLAUDE_BIN"; do
  [[ -x "$f" ]] || { echo "error: not an executable file: $f" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$VST_BIN" "$STAGE/vst"
cp "$AGY_BIN" "$STAGE/agy-acp"
cp "$CLAUDE_BIN" "$STAGE/claude-acp"
chmod 755 "$STAGE/vst" "$STAGE/agy-acp" "$STAGE/claude-acp"

mkdir -p "$(dirname "$OUT")"
COPYFILE_DISABLE=1 tar -czf "$OUT" -C "$STAGE" vst agy-acp claude-acp
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))" >&2

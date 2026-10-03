#!/usr/bin/env bash
# build-agy-acp.sh — build the vendored openab agy-acp adapter binary in
# isolation, then print its resolved absolute path on stdout.
#
# This is the single shared entry point for building agy-acp. It is used by:
#   - scripts/prep-sidecar.sh        (Tauri sidecar staging)
#   - scripts/dev-start.sh           (dev daemon AGY_ACP_BIN)
#   - scripts/dev-sandbox.sh         (docker bind-mount source)
#   - rust/scripts/agy-acp-gate.sh   (CI walled-garden gate)
#
# agy-acp is a standalone binary from the vendored openab submodule
# (rust/vendor/openab/agy-acp), deliberately EXCLUDED from the main Cargo
# workspace (see the comment in rust/Cargo.toml) so the walled-garden rule
# "nothing else from openab may be used" is enforced at the build layer. It is
# built in isolation via --manifest-path and a --target-dir OUTSIDE the
# submodule so the submodule working tree stays clean.
#
# Optional: `--target <triple>` (or env AGY_ACP_TARGET) cross/explicitly targets a
# triple (e.g. x86_64-unknown-linux-musl for the curl-install tarball); the binary
# then lives under <target-dir>/<triple>/release/. Default = host build.
#
# Output contract: prints ONLY the resolved absolute path to the built binary
# on stdout (so callers can safely do `BIN="$(bash scripts/build-agy-acp.sh)"`).
# Every progress/log/error message goes to stderr via >&2.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TRIPLE="${AGY_ACP_TARGET:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || { echo "Error: --target needs a value" >&2; exit 1; }; TRIPLE="$2"; shift 2 ;;
    --target=*) TRIPLE="${1#*=}"; shift ;;
    *) echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

SUB_MANIFEST="$REPO_ROOT/rust/vendor/openab/agy-acp/Cargo.toml"
TARGET_DIR="$REPO_ROOT/rust/target/agy-acp"
TARGET_ARGS=()
if [[ -n "$TRIPLE" ]]; then
  TARGET_ARGS=(--target "$TRIPLE")
  BIN="$TARGET_DIR/$TRIPLE/release/agy-acp"
else
  BIN="$TARGET_DIR/release/agy-acp"
fi

# Verify the vendored submodule is checked out before trying to build it.
if [[ ! -f "$SUB_MANIFEST" ]]; then
  echo "Error: agy-acp submodule not present at rust/vendor/openab." >&2
  echo "  Clone it with:" >&2
  echo "    git submodule update --init --recursive" >&2
  echo "  (or clone the repo with --recurse-submodules)" >&2
  exit 1
fi

echo "==> Building agy-acp adapter (vendored openab submodule, in isolation)..." >&2
cargo build --release --locked \
  --manifest-path "$SUB_MANIFEST" \
  --target-dir "$TARGET_DIR" \
  ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"}

if [[ ! -x "$BIN" ]]; then
  echo "Error: expected agy-acp binary at $BIN — build may have failed." >&2
  exit 1
fi

echo "$BIN"

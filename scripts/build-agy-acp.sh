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
# Output contract: prints ONLY the resolved absolute path to the built binary
# on stdout (so callers can safely do `BIN="$(bash scripts/build-agy-acp.sh)"`).
# Every progress/log/error message goes to stderr via >&2.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SUB_MANIFEST="$REPO_ROOT/rust/vendor/openab/agy-acp/Cargo.toml"
TARGET_DIR="$REPO_ROOT/rust/target/agy-acp"
BIN="$TARGET_DIR/release/agy-acp"

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
  --target-dir "$TARGET_DIR"

if [[ ! -x "$BIN" ]]; then
  echo "Error: expected agy-acp binary at $BIN — build may have failed." >&2
  exit 1
fi

echo "$BIN"

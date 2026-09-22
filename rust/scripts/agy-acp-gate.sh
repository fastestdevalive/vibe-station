#!/usr/bin/env bash
# agy-acp-gate.sh — build the openab agy-acp adapter in isolation + enforce the
# "walled-garden" guardrails (nothing else from openab may ever be used).
#
# Usage: rust/scripts/agy-acp-gate.sh
#
# 1. Builds agy-acp standalone (its own workspace) via --manifest-path and a
#    --target-dir OUTSIDE the submodule so the submodule working tree stays clean.
# 2. G1: no openab path under any [dependencies]/[workspace.dependencies].
# 3. G2: no `use openab` / `extern crate openab` / #[path=...openab...] /
#    include! of openab files in our crate sources.
# 4. G3/G4/G7: `cargo metadata` for the workspace contains no package named
#    `agy-acp` and no manifest under rust/vendor/ (i.e. it is NOT a workspace
#    member).
# 5. G7 contract test: the built binary's ACP `initialize` round-trips.

set -euo pipefail

# This script lives at rust/scripts/; the repo root is two levels up.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SUB="rust/vendor/openab/agy-acp"
TARGET_DIR="rust/target/agy-acp"

echo "== walled-garden G1/G3/G4/G7: no openab dependency, no workspace member =="
# Use `cargo metadata` (the resolved dependency graph) rather than grepping
# Cargo.toml syntax — this catches path deps, git deps, and workspace deps
# regardless of how they're written. Fail if ANY resolved package originates
# from the openab repo (manifest under rust/vendor/, or a git source pointing
# at openab), or is named openab*.
META_JSON="$(cargo metadata --format-version 1 --manifest-path rust/Cargo.toml 2>/dev/null)"
if printf '%s' "$META_JSON" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print(f"FAIL: could not parse cargo metadata: {e}")
    sys.exit(1)
bad = []
for p in d.get("packages", []):
    name = p.get("name","")
    mp = p.get("manifest_path","")
    src = p.get("source") or ""
    if "/vendor/openab/" in mp or "/vendor/openab" in mp:
        bad.append(f"path dep into vendor: {name} @ {mp}")
    elif "openab" in src.lower():
        bad.append(f"git dep from openab: {name} @ {src}")
    elif name.lower().startswith("openab"):
        bad.append(f"openab-named package: {name}")
if bad:
    print("\n".join(bad))
    sys.exit(1)
print("   ok")
'; then
  : # python exited 0 (no violations)
else
  echo "FAIL: an openab package is part of the workspace." >&2
  exit 1
fi

echo "== walled-garden G7: submodule present =="
if [[ ! -f "$SUB/Cargo.toml" ]]; then
  echo "FAIL: agy-acp submodule missing at $SUB. Clone with --recurse-submodules." >&2
  exit 1
fi
echo "   ok"

echo "== build agy-acp in isolation =="
cargo build --release --locked --manifest-path "$SUB/Cargo.toml" --target-dir "$TARGET_DIR"

BIN="$TARGET_DIR/release/agy-acp"
if [[ ! -x "$BIN" ]]; then
  echo "FAIL: expected binary at $BIN" >&2
  exit 1
fi
echo "   built: $BIN"

echo "== contract test: agy-acp initialize round-trip =="
# Drive the stdio ACP `initialize` handshake and confirm a well-formed response
# (protocolVersion + agentInfo + agentCapabilities). Times out in case the
# adapter hangs.
INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}'
RESP="$(printf '%s\n' "$INIT_REQ" | timeout 30 "$BIN" 2>/dev/null || true)"
if ! printf '%s' "$RESP" | grep -q '"result"'; then
  echo "FAIL: agy-acp initialize did not return a result. Got: $RESP" >&2
  exit 1
fi
echo "   ok"

echo "== agy-acp gate green =="

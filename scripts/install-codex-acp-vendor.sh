#!/usr/bin/env bash
# Installs @agentclientprotocol/codex-acp (the official ACP adapter for
# Codex — pinned in vendor/codex-acp/package.json) so the daemon can run
# it via `bun` directly, with no separate Node.js install required.
#
# `--omit=optional` matters: keep installs lean by omitting optional platform
# packages that this project never uses — `codex.rs` already sets `CODEX_PATH`
# to point the adapter at the real, separately installed `codex` CLI instead.
#
# Requires: bun (https://bun.sh) — already a doctor-checked dependency for
# agy's and claude's ACP paths, so this doesn't add a new tool to the project.
#
# How the daemon finds the result (`rust/vst-agents/src/codex.rs`'s
# `codex_acp_entry_path()`): `VST_CODEX_ACP_ENTRY` if set, else beside the
# executable, else `vendor/codex-acp/...` found by walking upward from cwd (a
# plain `cargo run` inside the repo needs nothing). The dev sandbox bind-mounts
# the host's `vendor/codex-acp` (docker-compose.dev.yml), so run this script on
# the host first. Release builds compile it into a standalone `codex-acp` binary instead
# (scripts/build-codex-acp.sh), which needs no bun at runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/codex-acp"

if ! command -v bun >/dev/null 2>&1; then
    echo "error: bun not found on PATH — install it first: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

echo "== installing @agentclientprotocol/codex-acp (pinned, see vendor/codex-acp/package.json) =="
cd "$VENDOR_DIR"
# Try the frozen-lockfile install first (fails loudly if bun.lock doesn't
# match package.json — the normal, expected case). If it fails for ANY
# reason, surface the real error before falling back (never swallow it: a
# network/registry/disk failure here should not look identical to a routine
# lockfile mismatch), then retry without --frozen-lockfile.
if ! frozen_err="$(bun install --omit=optional --frozen-lockfile 2>&1)"; then
    # Release builds set VST_VENDOR_FROZEN=1: never publish unpinned dependencies.
    if [[ "${VST_VENDOR_FROZEN:-0}" == "1" ]]; then
        echo "error: frozen-lockfile install failed and VST_VENDOR_FROZEN=1 forbids the fallback:" >&2
        echo "$frozen_err" >&2
        exit 1
    fi
    echo "warning: frozen-lockfile install failed, retrying without --frozen-lockfile (this may relax the pinned bun.lock if it did not match); original error:" >&2
    echo "$frozen_err" >&2
    bun install --omit=optional
fi

ENTRY="$VENDOR_DIR/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
if [[ ! -f "$ENTRY" ]]; then
    echo "error: expected entrypoint not found after install: $ENTRY" >&2
    exit 1
fi

echo "== done: $(du -sh "$VENDOR_DIR/node_modules" | cut -f1) installed =="
echo "entrypoint: $ENTRY"
echo "(a daemon run from inside this repo finds it automatically; elsewhere set VST_CODEX_ACP_ENTRY=$ENTRY)"

#!/usr/bin/env bash
# Installs @agentclientprotocol/claude-agent-acp (the official ACP adapter for
# Claude — pinned in vendor/claude-acp/package.json) so the daemon can run it
# via `bun` directly, with no separate Node.js install required.
#
# `--omit=optional` matters: without it, `bun install` pulls BOTH per-platform
# `@anthropic-ai/claude-agent-sdk-{linux-x64,linux-x64-musl,...}` packages
# (300MB+ each) that this project never uses — `claude.rs` already sets
# `CLAUDE_CODE_EXECUTABLE` to point the adapter at the real, separately
# installed `claude` CLI instead. Omitting them: 56MB installed. Including
# them: 666MB+, for zero benefit (confirmed via a real end-to-end ACP turn
# with them omitted — see `rust/vst-agents/examples/acp_hello_bundled.rs`).
#
# This script only installs the pinned adapter's node_modules. The curl-install
# tarball does NOT ship that tree: scripts/build-claude-acp.sh compiles it with
# `bun build --compile` into a self-contained `claude-acp` binary (verified with a
# real prompt turn; an older note here claiming the compiled form fails at
# `session/new` no longer reproduces on bun 1.4.2 + adapter 0.70.0). The tree
# installed here is still what dev checkouts, the dev sandbox and the Tauri
# desktop bundle run via `bun <entry.js>`.
#
# Requires: bun (https://bun.sh) — already a doctor-checked dependency for
# agy's own ACP path, so this doesn't add a new tool to the project.
#
# How the daemon finds the result (`rust/vst-agents/src/claude.rs`'s
# `claude_acp_entry_path()`): a plain `cargo run` anywhere inside the repo
# finds `vendor/claude-acp/...` by walking upward from cwd. The dev sandbox
# (dev.Dockerfile + scripts/dev-entrypoint.sh), `tauri dev`
# (scripts/dev-start.sh) and the packaged desktop app
# (scripts/prep-sidecar.sh + tauri.conf.json bundle.resources +
# desktop/src-tauri/src/daemon.rs) all run this script and pass the path
# explicitly as `VST_CLAUDE_ACP_ENTRY`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/claude-acp"

if ! command -v bun >/dev/null 2>&1; then
    echo "error: bun not found on PATH — install it first: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

echo "== installing @agentclientprotocol/claude-agent-acp (pinned, see vendor/claude-acp/package.json) =="
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

ENTRY="$VENDOR_DIR/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
if [[ ! -f "$ENTRY" ]]; then
    echo "error: expected entrypoint not found after install: $ENTRY" >&2
    exit 1
fi

echo "== done: $(du -sh "$VENDOR_DIR/node_modules" | cut -f1) installed =="
echo "entrypoint: $ENTRY"
echo "(a daemon run from inside this repo finds it automatically; elsewhere set VST_CLAUDE_ACP_ENTRY=$ENTRY)"

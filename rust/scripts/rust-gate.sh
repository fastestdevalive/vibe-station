#!/usr/bin/env bash
# rust-gate.sh — the one command every part and integrator runs.
# Usage: rust/scripts/rust-gate.sh [crate]  |  rust/scripts/rust-gate.sh --workspace
# Wraps cargo fmt --check + cargo clippy (deny groups) + cargo test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Deny the four clippy groups explicitly. The common rustc warnings are denied
# via `[workspace.lints.rust] unused/dead_code = "deny"` in rust/Cargo.toml.
# We deliberately do NOT use `-D warnings` (here or in the workspace lints): the
# `warnings` group is shared between rustc and clippy, so it would promote every
# clippy warn-level lint (pedantic included) to an error — the exact failure
# mode Gotcha #12 exists to prevent. pedantic stays warn (informational).
DENY_ARGS=(-D clippy::correctness -D clippy::suspicious -D clippy::complexity -D clippy::perf)

fmt_check() {
    cargo fmt --all --check
}

clippy_gate() {
    if [ "$1" = "--workspace" ]; then
        cargo clippy --workspace --all-targets --all-features -- "${DENY_ARGS[@]}"
    else
        cargo clippy -p "$1" --all-targets --all-features -- "${DENY_ARGS[@]}"
    fi
}

test_gate() {
    if [ "$1" = "--workspace" ]; then
        cargo test --workspace
    else
        cargo test -p "$1"
    fi
}

# vst-types wire fixtures must round-trip after EVERY part (arch Phase recipe step 7).
echo "== fmt =="
fmt_check
echo "== clippy =="
clippy_gate "${1:-}"
echo "== test ($1) =="
test_gate "${1:-}"
if [ "$1" != "vst-types" ] && [ "$1" != "--workspace" ]; then
    echo "== test vst-types (wire fixtures) =="
    cargo test -p vst-types
fi
echo "== gate green =="

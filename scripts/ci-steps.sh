#!/usr/bin/env bash
# ci-steps.sh — the CI commands themselves, run from the repo root. Used by
# scripts/ci-local.sh (inside Docker, or --native on the host). Keep in step with
# .github/workflows/rust-ci.yml; web-ui checks are local-only (no workflow runs them).
#
# CI_STEPS="rust web release"  (default: rust web)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
STEPS="${CI_STEPS:-rust web}"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
want() { [[ " $STEPS " == *" $1 "* ]]; }

if want rust; then
  step "version files in sync"
  bash scripts/check-version-sync.sh

  step "rust file length (<= 2000 lines)"
  bash scripts/check-rs-loc.sh

  step "placeholder web-ui/dist (embed-ui feature needs the dir)"
  mkdir -p web-ui/dist
  [ -e web-ui/dist/index.html ] || touch web-ui/dist/index.html

  step "rust-gate.sh --workspace (fmt, clippy, test)"
  rust/scripts/rust-gate.sh --workspace

  step "default build ignores VST_NO_AUTH"
  cargo test --manifest-path rust/Cargo.toml -p vst-daemon --test main_logic \
    -- --exact default_build_ignores_vst_no_auth 2>&1 | tee /tmp/no-auth-default.txt
  grep -q "test result: ok. 1 passed" /tmp/no-auth-default.txt \
    || { echo "default_build_ignores_vst_no_auth did not run exactly once and pass" >&2; exit 1; }

  step "insecure-no-auth feature build honors VST_NO_AUTH"
  cargo test --manifest-path rust/Cargo.toml -p vst-daemon --features insecure-no-auth --test main_logic \
    -- --exact default_build_ignores_vst_no_auth 2>&1 | tee /tmp/no-auth-feature.txt
  grep -q "test result: ok. 1 passed" /tmp/no-auth-feature.txt \
    || { echo "feature-build variant did not run exactly once and pass" >&2; exit 1; }

  if command -v cargo-deny >/dev/null 2>&1; then
    step "cargo deny (workspace)"
    cargo deny --manifest-path rust/Cargo.toml check
  else
    echo "!! cargo-deny not installed — skipping the deny check (CI runs it)"
  fi
fi

if want web; then
  step "pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
  step "web-ui typecheck"
  pnpm typecheck
  step "web-ui lint"
  pnpm lint
  step "web-ui test"
  pnpm test
  step "web-ui build"
  pnpm --filter ./web-ui exec vite build
fi

if want release; then
  step "cargo build --release (daemon + cli)"
  cargo build --release --manifest-path rust/Cargo.toml -p vst-cli --features vst-daemon/embed-ui
fi

printf '\n\033[1;32m== local CI green ==\033[0m\n'

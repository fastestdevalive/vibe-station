#!/usr/bin/env bash
# check-native-daemon-tests.sh — prove the tests that start a real daemon binary
# actually ran. They return early (and still "pass") without
# VST_NATIVE_DAEMON_TESTS=1, so a lost env var would otherwise go unnoticed.
# CI container / GitHub CI only: this starts real daemons.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ "${VST_NATIVE_DAEMON_TESTS:-}" = 1 ] || {
  echo "VST_NATIVE_DAEMON_TESTS=1 is not set; refusing to start daemons here" >&2
  exit 1
}

run() { # <package> <test binary> <expected test count>
  local out="/tmp/native-daemon-$2.txt"
  cargo test --manifest-path rust/Cargo.toml -p "$1" --test "$2" -- --nocapture 2>&1 | tee "$out"
  if grep -q "skipped (VST_NATIVE_DAEMON_TESTS" "$out"; then
    echo "$2: a daemon-spawning test was skipped" >&2; exit 1
  fi
  grep -q "test result: ok. $3 passed" "$out" \
    || { echo "$2: expected exactly $3 passing tests" >&2; exit 1; }
}

run vst-daemon async_startup 1
run vst-daemon agy_stream_acp_cmd 1
run vst-cli self_heal 4
run vst-cli restart_exec 4

#!/usr/bin/env bash
# Fail unless the key set pinned in scripts/install.sh (PINNED_PUBKEYS) EQUALS the
# key set in rust/vst-daemon/release-keys/vst-release.pub. The Rust test
# `pinned_keys_parse_and_match_install_sh` only checks .pub ⊆ install.sh, so an
# appended (rather than replaced) key in install.sh would keep a stale/placeholder
# key trusted forever; this check is bidirectional.
#
# usage: check-pinned-keys-in-sync.sh [<install.sh> [<vst-release.pub>]]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="${1:-$ROOT/scripts/install.sh}"
PUB="${2:-$ROOT/rust/vst-daemon/release-keys/vst-release.pub}"
[ -f "$INSTALL" ] || { echo "error: $INSTALL not found" >&2; exit 2; }
[ -f "$PUB" ] || { echo "error: $PUB not found" >&2; exit 2; }

pins="$(sed -n 's/^PINNED_PUBKEYS="\(.*\)"$/\1/p' "$INSTALL" | head -n1 | tr ' ' '\n' | grep -v '^$' | LC_ALL=C sort -u || true)"
keys="$(grep -v -e '^untrusted comment:' -e '^$' "$PUB" | LC_ALL=C sort -u || true)"
[ -n "$pins" ] || { echo "error: no PINNED_PUBKEYS in $INSTALL" >&2; exit 1; }
[ -n "$keys" ] || { echo "error: no key in $PUB" >&2; exit 1; }
if [ "$pins" != "$keys" ]; then
  echo "error: pinned key sets differ between $INSTALL (PINNED_PUBKEYS) and $PUB" >&2
  exit 1
fi
echo "pinned keys in sync ($(printf '%s\n' "$keys" | wc -l | tr -d ' ') key(s))"

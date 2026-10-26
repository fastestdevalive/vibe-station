#!/usr/bin/env bash
# Fail if a release public-key pin contains the throwaway PLACEHOLDER key that
# ships in the repo until the maintainer installs the production key
# (see docs/UPDATE.md). Release CI runs this before building/signing so
# a placeholder can never be published.
#
# usage: check-release-key-not-placeholder.sh <file>...
#   <file> is either a minisign public-key file (vst-release.pub) or scripts/install.sh
#   (detected by its `PINNED_PUBKEYS="..."` line; every space-separated key is checked).
set -euo pipefail

# Raw 8-byte key id of the placeholder (minisign displays it byte-reversed as
# C674EB99F94B60DB). Must equal PLACEHOLDER_KEY_ID in
# rust/vst-daemon/src/update/install/signature.rs.
PLACEHOLDER_KEY_ID_HEX="db604bf999eb74c6"

[ $# -ge 1 ] || { echo "usage: $0 <vst-release.pub|install.sh>..." >&2; exit 2; }

check_key() { # <file> <base64 key line>; echoes nothing, exits on failure
  local kid
  kid="$(printf '%s' "$2" | base64 -d 2>/dev/null | od -An -tx1 -j2 -N8 | tr -d ' \n')" || kid=""
  if [ "${#kid}" -ne 16 ]; then
    echo "error: malformed key line in $1" >&2
    exit 1
  fi
  if [ "$kid" = "$PLACEHOLDER_KEY_ID_HEX" ]; then
    echo "error: $1 still pins the PLACEHOLDER release key; replace it with the production public key (docs/UPDATE.md) before releasing" >&2
    exit 1
  fi
}

for f in "$@"; do
  [ -f "$f" ] || { echo "error: $f not found" >&2; exit 2; }
  found=0
  if grep -q '^PINNED_PUBKEYS=' "$f"; then
    keys="$(sed -n 's/^PINNED_PUBKEYS="\(.*\)"$/\1/p' "$f" | head -n1)"
    for k in $keys; do
      check_key "$f" "$k"
      found=$((found + 1))
    done
  else
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'untrusted comment:'*) continue ;; esac
      check_key "$f" "$line"
      found=$((found + 1))
    done <"$f"
  fi
  [ "$found" -ge 1 ] || { echo "error: no key found in $f" >&2; exit 1; }
  echo "release key check: ok ($f: $found key(s), none is the placeholder)"
done

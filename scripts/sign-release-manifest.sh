#!/usr/bin/env bash
# Sign SHA256SUMS with minisign (Ed25519, non-prehashed `Ed` algorithm) and
# self-check the result. Secrets come only from the environment and are never
# echoed.
#
# usage: sign-release-manifest.sh <manifest> <pubkey-file>
# env:   MINISIGN_SECRET_KEY  contents of the minisign signing-key file (.key)
#        MINISIGN_PASSWORD    its password
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 <manifest> <pubkey-file>" >&2; exit 2; }
manifest="$1"; pubkey="$2"

if [ -z "${MINISIGN_SECRET_KEY:-}" ] || [ -z "${MINISIGN_PASSWORD:-}" ]; then
  echo "MINISIGN_SECRET_KEY/MINISIGN_PASSWORD not set" >&2
  exit 2
fi

# Never sign for the repo's throwaway placeholder key.
here="$(cd "$(dirname "$0")" && pwd)"
bash "$here/check-release-key-not-placeholder.sh" "$pubkey"

TAG="$(sed -n 's/^# tag=//p' "$manifest")"
[ -n "$TAG" ] || { echo "error: no tag line in $manifest" >&2; exit 1; }

umask 077
KEYFILE="$(mktemp)"
trap 'rm -f "$KEYFILE"' EXIT
printf '%s\n' "$MINISIGN_SECRET_KEY" >"$KEYFILE"

printf '%s\n' "$MINISIGN_PASSWORD" \
  | minisign -S -l -s "$KEYFILE" -m "$manifest" -t "vibe-station $TAG" >/dev/null

# Self-check: verifies with the pinned public key AND is the `Ed` algorithm.
minisign -V -q -p "$pubkey" -m "$manifest" || { echo "error: self-check verify failed" >&2; exit 1; }
alg="$(sed -n 2p "$manifest.minisig" | base64 -d | head -c2)"
[ "$alg" = "Ed" ] || { echo "error: signature algorithm is '$alg', expected 'Ed'" >&2; exit 1; }
echo "signed $manifest ($TAG)"

#!/usr/bin/env bash
# Script tests for make-release-manifest.sh / sign-release-manifest.sh /
# check-release-key-not-placeholder.sh using throwaway keys.
set -euo pipefail

if ! command -v minisign >/dev/null 2>&1; then
  echo "SKIP: minisign not installed"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
cd "$W"
FAILS=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
check() { # name, command...
  local n="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$n"; else fail "$n"; fi
}
check_not() {
  local n="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$n"; else pass "$n"; fi
}

PW=test-pw-7f3a
printf '%s\n%s\n' "$PW" "$PW" | minisign -G -f -p t.pub -s t.key >/dev/null 2>&1
printf '%s\n%s\n' "$PW" "$PW" | minisign -G -f -p o.pub -s o.key >/dev/null 2>&1

NAMES="vst-x86_64-unknown-linux-musl.tar.gz vst-aarch64-unknown-linux-musl.tar.gz vst-aarch64-apple-darwin.tar.gz vibe-station-x86_64-unknown-linux-gnu.AppImage vibe-station-x86_64-unknown-linux-gnu.deb vibe-station-aarch64-apple-darwin.dmg"
mkdir assets
for n in $NAMES; do printf 'content of %s\n' "$n" >"assets/$n"; done
printf 'stale\n' >assets/vst-x86_64-unknown-linux-musl.tar.gz.sha256

MAKE="$ROOT/scripts/make-release-manifest.sh"
SIGN="$ROOT/scripts/sign-release-manifest.sh"
GUARD="$ROOT/scripts/check-release-key-not-placeholder.sh"

bash "$MAKE" assets v9.9.9 SHA256SUMS >/dev/null
check manifest_shape bash -c '[ "$(sed -n 1p SHA256SUMS)" = "# vibe-station release manifest v1" ] && [ "$(sed -n 2p SHA256SUMS)" = "# tag=v9.9.9" ] && [ "$(grep -vc "^#" SHA256SUMS)" = 6 ] && ! grep -q sha256$ SHA256SUMS'
# Portable: verify every manifest line with whichever sha256 tool exists (macOS has shasum only).
check manifest_hashes_match bash -c 'cd assets && grep -v "^#" ../SHA256SUMS | while read -r h n; do
  if command -v sha256sum >/dev/null 2>&1; then g=$(sha256sum "$n" | cut -d" " -f1); else g=$(shasum -a 256 "$n" | cut -d" " -f1); fi
  [ "$h" = "$g" ] || exit 1; done'

SIGN_OUT="$W/sign.out"
MINISIGN_SECRET_KEY="$(cat t.key)" MINISIGN_PASSWORD="$PW" bash "$SIGN" SHA256SUMS t.pub >"$SIGN_OUT" 2>&1 || true

check verify_ok minisign -V -p t.pub -m SHA256SUMS
check alg_is_Ed bash -c '[ "$(sed -n 2p SHA256SUMS.minisig | base64 -d | head -c2)" = Ed ]'

cp SHA256SUMS T; cp SHA256SUMS.minisig T.minisig
printf 'X' | dd of=T bs=1 seek=40 conv=notrunc 2>/dev/null
check_not tampered minisign -V -p t.pub -m T -x T.minisig
check_not wrong_key minisign -V -p o.pub -m SHA256SUMS

cp SHA256SUMS S1
check_not no_secret env -u MINISIGN_SECRET_KEY MINISIGN_PASSWORD="$PW" bash "$SIGN" S1 t.pub
check_not no_password env MINISIGN_SECRET_KEY="$(cat t.key)" MINISIGN_PASSWORD= bash "$SIGN" S1 t.pub

# bad names
cp -r assets assets_badname
printf x >"assets_badname/a b"
check_not bad_name_space bash "$MAKE" assets_badname v9.9.9 out1
rm "assets_badname/a b"; printf x >assets_badname/.x
check_not bad_name_dot bash "$MAKE" assets_badname v9.9.9 out1
cp -r assets assets_missing
rm assets_missing/vst-aarch64-apple-darwin.tar.gz
check_not missing_asset bash "$MAKE" assets_missing v9.9.9 out1
check_not bad_tag bash "$MAKE" assets 9.9.9 out1

# placeholder guard (the repo pins are the REAL key now; the placeholder lives only in the Rust test fixture)
PLACEHOLDER_PUB="$ROOT/rust/vst-daemon/src/update/install/testdata/t.pub"
PLACEHOLDER_KEY="$(sed -n 2p "$PLACEHOLDER_PUB")"
check guard_accepts_real_key bash "$GUARD" t.pub
check_not guard_rejects_placeholder bash "$GUARD" "$PLACEHOLDER_PUB"
check guard_accepts_repo_pub bash "$GUARD" "$ROOT/rust/vst-daemon/release-keys/vst-release.pub"
check guard_accepts_repo_install_sh bash "$GUARD" "$ROOT/scripts/install.sh"
# the guard also parses install.sh's PINNED_PUBKEYS (a placeholder pin must fail)
sed "s|^PINNED_PUBKEYS=.*|PINNED_PUBKEYS=\"$PLACEHOLDER_KEY\"|" "$ROOT/scripts/install.sh" >install_placeholder.sh
check_not guard_rejects_placeholder_install_sh bash "$GUARD" install_placeholder.sh
sed "s|^PINNED_PUBKEYS=.*|PINNED_PUBKEYS=\"$(sed -n 2p t.pub)\"|" "$ROOT/scripts/install.sh" >install_real.sh
check guard_accepts_real_key_install_sh bash "$GUARD" install_real.sh
sed "s|^PINNED_PUBKEYS=.*|PINNED_PUBKEYS=\"$(sed -n 2p t.pub) $PLACEHOLDER_KEY\"|" "$ROOT/scripts/install.sh" >install_appended.sh
check_not guard_rejects_appended_placeholder_install_sh bash "$GUARD" install_appended.sh
# bidirectional pin-sync (a key appended to install.sh must be flagged)
SYNC="$ROOT/scripts/check-pinned-keys-in-sync.sh"
check pins_in_sync_repo bash "$SYNC"
check_not pins_drift_extra_key_in_install_sh bash "$SYNC" install_appended.sh t.pub
check pins_in_sync_equal bash "$SYNC" install_real.sh t.pub
check_not sign_refuses_placeholder env MINISIGN_SECRET_KEY="$(cat t.key)" MINISIGN_PASSWORD="$PW" bash "$SIGN" S1 "$PLACEHOLDER_PUB"

# no leaks
SECRET_LINE="$(sed -n 2p t.key)"
if grep -qF -- "$SECRET_LINE" "$SIGN_OUT" || grep -qF -- "$PW" "$SIGN_OUT"; then
  fail no_leak
else
  pass no_leak
fi

[ "$FAILS" -eq 0 ] || { echo "$FAILS failure(s)"; exit 1; }
echo "all passed"

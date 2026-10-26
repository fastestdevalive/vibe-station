#!/usr/bin/env bash
# macos-export-signing-secrets.sh — RUN THIS YOURSELF, ON YOUR MAC (the maintainer).
#
# Exports ONE "Developer ID Application" identity (certificate + private key)
# from your login keychain and sets the seven macOS signing secrets on the GitHub
# environment `release-signing` of fastestdevalive/vibe-station:
#
#   APPLE_CERTIFICATE            base64 of the exported .p12 (cert + key only)
#   APPLE_CERTIFICATE_PASSWORD   the .p12 password you type at the hidden prompt
#   APPLE_SIGNING_IDENTITY       "Developer ID Application: Name (TEAMID)"
#   APPLE_TEAM_ID                the 10-character Team ID (derived from the identity)
#   APPLE_API_KEY_P8             the full text of the App Store Connect API key
#                                (.p8) file; the file content is never printed
#   APPLE_API_KEY_ID             the key ID (10 characters, visible prompt)
#   APPLE_API_ISSUER             the issuer UUID (visible prompt)
#
# The key comes from App Store Connect > Users and Access > Integrations.
# Apple lets you download the .p8 only ONCE — save it in your password manager.
#
# Safety properties:
#   * passwords are read from hidden prompts; secret values are never printed
#     and are passed to `gh secret set` on stdin, not on a command line
#   * the .p12 (and the intermediate PEMs) exist only inside a mode-700 mktemp
#     directory that an EXIT trap removes, even on error / Ctrl-C
#   * only the chosen identity is uploaded, not the other items in your keychain
#   * the GitHub environment must already exist (Settings -> Environments ->
#     New environment "release-signing", deployment rule: tags matching v*)
#
# macOS will show a Keychain Access dialog asking to allow the export; that is
# expected. Requires: gh (logged in as an account with admin on the repo),
# openssl, security (macOS).
#
# usage: scripts/macos-export-signing-secrets.sh [--repo owner/name] [--dry-run]
#   --dry-run  do everything except `gh secret set` (still prompts + exports;
#              prints only which secret names WOULD be set)
set -euo pipefail
umask 077

REPO="fastestdevalive/vibe-station"
ENVIRONMENT="release-signing"
OPENSSL="${OPENSSL:-/usr/bin/openssl}"
DRY=0
KEYCHAIN="${VST_EXPORT_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

die() { echo "error: $*" >&2; exit 1; }

# pem_pick_identity <all.pem> <identity-CN> <out-key.pem> <out-leaf.pem> <out-chain.pem>
# Picks the leaf certificate whose subject CN equals <identity-CN>, the private
# key whose public half matches it, and the certificate(s) that issued it.
# Returns 1 if no such certificate, 2 if no matching private key.
pem_pick_identity() {
  local pem="$1" cn="$2" okey="$3" oleaf="$4" ochain="$5" d f subj leaf="" keyf="" pub issuer
  # Holds UNENCRYPTED private keys: create it inside the caller's EXIT-trapped
  # temp dir (PICK_PARENT) so an error / Ctrl-C mid-function cannot leave it.
  d="$(mktemp -d "${PICK_PARENT:-${TMPDIR:-/tmp}}/vst-pick.XXXXXX")"
  awk -v d="$d" '/-----BEGIN /{n++; f=sprintf("%s/b%03d.pem", d, n)} f{print > f} /-----END /{close(f); f=""}' "$pem"
  for f in "$d"/b*.pem; do
    [ -f "$f" ] || continue
    grep -q 'BEGIN CERTIFICATE' "$f" || continue
    subj="$("$OPENSSL" x509 -in "$f" -noout -subject -nameopt RFC2253 2>/dev/null || true)"
    subj="${subj#subject=}"; subj="${subj# }"
    case ",$subj," in *",CN=$cn,"*) leaf="$f" ;; esac
  done
  [ -n "$leaf" ] || { rm -rf "$d"; return 1; }
  pub="$("$OPENSSL" x509 -in "$leaf" -noout -pubkey | "$OPENSSL" sha256)"
  for f in "$d"/b*.pem; do
    grep -q 'PRIVATE KEY' "$f" || continue
    if [ "$("$OPENSSL" pkey -in "$f" -pubout 2>/dev/null | "$OPENSSL" sha256)" = "$pub" ]; then keyf="$f"; fi
  done
  [ -n "$keyf" ] || { rm -rf "$d"; return 2; }
  cp "$keyf" "$okey"
  cp "$leaf" "$oleaf"
  : >"$ochain"
  issuer="$("$OPENSSL" x509 -in "$leaf" -noout -issuer -nameopt RFC2253)"; issuer="${issuer#issuer=}"; issuer="${issuer# }"
  for f in "$d"/b*.pem; do
    grep -q 'BEGIN CERTIFICATE' "$f" || continue
    [ "$f" = "$leaf" ] && continue
    subj="$("$OPENSSL" x509 -in "$f" -noout -subject -nameopt RFC2253)"; subj="${subj#subject=}"; subj="${subj# }"
    [ "$subj" = "$issuer" ] && sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' "$f" >>"$ochain"
  done
  rm -rf "$d"
}

if [ "${1:-}" != "--source-only" ]; then
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) REPO="${2:?--repo needs owner/name}"; shift ;;
      --dry-run) DRY=1 ;;
      -h | --help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
    shift
  done

  [ "$(uname -s)" = Darwin ] || die "run this on your Mac"
  for t in gh security base64 awk; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
  [ -x "$OPENSSL" ] || die "$OPENSSL not found"
  [ -f "$KEYCHAIN" ] || die "login keychain not found at $KEYCHAIN (set VST_EXPORT_KEYCHAIN)"
  if [ "$DRY" = 0 ]; then gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"; fi

  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  PINNED="$(sed -n 's/^APPLE_TEAM_ID="\([A-Z0-9]\{10\}\)"$/\1/p' "$ROOT/scripts/install.sh" 2>/dev/null || true)"

  # ── choose the identity ──────────────────────────────────────────────────
  IDS=()
  while IFS= read -r line; do IDS+=("$line"); done < <(
    security find-identity -v -p codesigning "$KEYCHAIN" |
      sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Developer ID Application: .*\)"$/\1/p')
  [ "${#IDS[@]}" -gt 0 ] || die "no 'Developer ID Application' identity in $KEYCHAIN"
  if [ "${#IDS[@]}" -eq 1 ]; then
    IDENTITY="${IDS[0]}"
  else
    echo "Developer ID Application identities:"
    i=0; for n in "${IDS[@]}"; do i=$((i + 1)); echo "  $i) $n"; done
    read -r -p "Which one signs releases? [1-$i] " pick
    case "$pick" in '' | *[!0-9]*) die "not a number" ;; esac
    [ "$pick" -ge 1 ] && [ "$pick" -le "$i" ] || die "out of range"
    IDENTITY="${IDS[$((pick - 1))]}"
  fi
  TEAM="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
  [ -n "$TEAM" ] || die "cannot parse a Team ID from: $IDENTITY"
  echo "Identity: $IDENTITY"
  echo "Team ID:  $TEAM"
  if [ -n "$PINNED" ] && [ "$PINNED" != "$TEAM" ]; then
    echo
    echo "WARNING: scripts/install.sh pins APPLE_TEAM_ID=$PINNED but this identity is team $TEAM."
    echo "         Release CI refuses to sign with a team that differs from the pin."
    echo "         Update the pin in scripts/install.sh (one line) before releasing."
    read -r -p "Continue anyway? [y/N] " yn
    [ "$yn" = y ] || die "aborted"
  fi

  # ── secrets: hidden prompts ──────────────────────────────────────────────
  read -r -s -p "Choose a password for the exported .p12 (hidden): " P12_PW; echo
  read -r -s -p "Repeat it: " P12_PW2; echo
  [ -n "$P12_PW" ] && [ "$P12_PW" = "$P12_PW2" ] || die "passwords empty or different"
  unset P12_PW2
  read -r -p "Path to the App Store Connect API key (.p8) file: " P8_PATH
  [ -f "$P8_PATH" ] || die "no .p8 file at $P8_PATH"
  [ -r "$P8_PATH" ] || die "cannot read $P8_PATH"
  read -r -p "API key ID (10 characters): " API_KEY_ID_VAL
  [ -n "$API_KEY_ID_VAL" ] || die "API key ID is required"
  read -r -p "API issuer ID (UUID): " API_ISSUER_VAL
  [ -n "$API_ISSUER_VAL" ] || die "API issuer ID is required"
  # `security export` only takes its password on the command line (visible in
  # ps), so it gets a random one-time password protecting a temp file that is
  # deleted right after; YOUR .p12 password only ever travels via env:.
  EXPORT_PW="$("$OPENSSL" rand -hex 24)"
  export EXPORT_PW FINAL_PW="$P12_PW"

  # ── export, narrow to one identity, re-encrypt ───────────────────────────
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/vst-signing.XXXXXX")"
  chmod 700 "$TMP"
  trap 'rm -rf "$TMP"; unset EXPORT_PW FINAL_PW P12_PW API_KEY_ID_VAL API_ISSUER_VAL' EXIT
  trap 'exit 130' INT TERM HUP
  PICK_PARENT="$TMP"

  echo "Exporting (macOS may ask you to allow Keychain access)..."
  security export -k "$KEYCHAIN" -t identities -f pkcs12 -P "$EXPORT_PW" -o "$TMP/all.p12" >/dev/null
  "$OPENSSL" pkcs12 -in "$TMP/all.p12" -passin env:EXPORT_PW -nodes -out "$TMP/all.pem" 2>/dev/null ||
    die "could not read the exported keychain items"
  rm -f "$TMP/all.p12"
  pem_pick_identity "$TMP/all.pem" "$IDENTITY" "$TMP/key.pem" "$TMP/leaf.pem" "$TMP/chain.pem" ||
    die "could not find the certificate + matching private key for: $IDENTITY"
  rm -f "$TMP/all.pem"
  # bash 3.2 (stock macOS) treats "${arr[@]}" of an EMPTY array as unbound under
  # set -u; the ${arr[@]+...} form below expands to nothing instead.
  chain_args=()
  [ -s "$TMP/chain.pem" ] && chain_args=(-certfile "$TMP/chain.pem")
  "$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/leaf.pem" ${chain_args[@]+"${chain_args[@]}"} \
    -passout env:FINAL_PW -out "$TMP/signing.p12"
  # Sanity: exactly one private key inside, readable with the chosen password.
  KEYS="$("$OPENSSL" pkcs12 -in "$TMP/signing.p12" -passin env:FINAL_PW -nodes -nocerts 2>/dev/null | grep -c 'BEGIN .*PRIVATE KEY' || true)"
  [ "$KEYS" = 1 ] || die "sanity check failed: expected 1 private key in the .p12, found $KEYS"
  rm -f "$TMP/key.pem" "$TMP/leaf.pem" "$TMP/chain.pem"

  # ── upload ───────────────────────────────────────────────────────────────
  setsecret() { # name, reads value on stdin
    if [ "$DRY" = 1 ]; then cat >/dev/null; echo "[dry-run] would set $1 on $REPO ($ENVIRONMENT)"
    else gh secret set "$1" --env "$ENVIRONMENT" --repo "$REPO" >/dev/null && echo "set $1"; fi
  }
  base64 <"$TMP/signing.p12" | tr -d '\n' | setsecret APPLE_CERTIFICATE
  printf '%s' "$P12_PW" | setsecret APPLE_CERTIFICATE_PASSWORD
  printf '%s' "$IDENTITY" | setsecret APPLE_SIGNING_IDENTITY
  printf '%s' "$TEAM" | setsecret APPLE_TEAM_ID
  # The .p8 content is piped on stdin, exactly like the other secrets; it is
  # never printed (setsecret only echoes the secret NAME).
  setsecret APPLE_API_KEY_P8 <"$P8_PATH"
  printf '%s' "$API_KEY_ID_VAL" | setsecret APPLE_API_KEY_ID
  printf '%s' "$API_ISSUER_VAL" | setsecret APPLE_API_ISSUER

  echo
  echo "Done. Temporary files are removed on exit. Keep your .p12 password and the"
  echo ".p8 key in a password manager; Apple will not let you download the key again."
fi

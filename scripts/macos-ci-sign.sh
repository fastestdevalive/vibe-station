#!/usr/bin/env bash
# macOS release signing helper for CI (runs on a macOS runner only).
#
#   macos-ci-sign.sh detect              decide whether signing is enabled (see below)
#   macos-ci-sign.sh keychain-setup      import APPLE_CERTIFICATE into a temp keychain
#   macos-ci-sign.sh keychain-cleanup    delete it again (idempotent; run under `if: always()`)
#   macos-ci-sign.sh sign [-e <entitlements.plist>] <file...>
#   macos-ci-sign.sh notarize <file...>  zip, `notarytool submit` + bounded `wait`, require "Accepted"
#   macos-ci-sign.sh dmg <file.dmg...>   sign the container, notarize it, staple the ticket
#   macos-ci-sign.sh app-sign <entitlements.plist> <App.app>
#                                        sign every nested Mach-O, then the bundle (hardened runtime)
#   macos-ci-sign.sh app-notarize <App.app>   notarize the bundle and staple the ticket
#
# Secrets come ONLY from the environment (GitHub secrets mapped by the workflow):
#   APPLE_CERTIFICATE            base64 of the Developer ID Application .p12
#   APPLE_CERTIFICATE_PASSWORD   its export password
#   APPLE_SIGNING_IDENTITY       e.g. "Developer ID Application: Name (TEAMID)"
#   APPLE_TEAM_ID                the 10-character Team ID (pinned in install.sh)
#   APPLE_API_KEY_P8             the full text of an App Store Connect API key (.p8)
#   APPLE_API_KEY_ID             that key's 10-character key ID
#   APPLE_API_ISSUER             that key's issuer UUID
# Nothing secret is ever echoed; the keychain password is random and masked, and
# the .p8 is written to a 0600 temp file that an EXIT trap removes even on failure.
#
# Bare Mach-O executables cannot carry a stapled notarization ticket (only
# .app/.dmg/.pkg can). They are notarized so Gatekeeper's online lookup
# succeeds, and are authenticated offline by their Developer ID signature.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "macOS only"

# The notarization key file is created lazily (detect/sign never need it) and
# removed by this EXIT trap, so a failed submission cannot leave the .p8 behind.
NOTARY_KEY_FILE=""
# Every temp dir/file (decoded .p12, notarization zips) is registered here and
# removed by the one EXIT trap. A RETURN trap would NOT fire when `set -e` or
# die() exits the shell, leaving the decoded .p12 behind. Never expand an empty
# array bare: bash 3.2 (stock macOS) treats that as unbound under `set -u`.
CLEAN=()
cleanup_notary_key() {
  local p
  if [ -n "$NOTARY_KEY_FILE" ]; then rm -f "$NOTARY_KEY_FILE"; NOTARY_KEY_FILE=""; fi
  if [ "${#CLEAN[@]}" -gt 0 ]; then
    for p in "${CLEAN[@]}"; do rm -rf "$p"; done
    CLEAN=()
  fi
}
trap cleanup_notary_key EXIT

# Upper bound for one notarytool wait (the workflow steps allow 30 minutes in total, upload included).
NOTARY_WAIT="${VST_NOTARY_WAIT:-20m}"

# ensure_notary_key: write APPLE_API_KEY_P8 to a 0600 file under $RUNNER_TEMP
# (or a fresh mktemp dir) and set NOTARY_KEY_FILE to its path. The secret is
# never echoed. Sets a global (no command substitution: the EXIT trap must see
# the assignment).
ensure_notary_key() {
  if [ -n "$NOTARY_KEY_FILE" ]; then return 0; fi
  : "${APPLE_API_KEY_P8:?APPLE_API_KEY_P8 not set}"
  local dir
  if [ -n "${RUNNER_TEMP:-}" ]; then dir="$RUNNER_TEMP"; else dir="$(mktemp -d)"; CLEAN+=("$dir"); fi
  NOTARY_KEY_FILE="$(mktemp "$dir/vst-notary-key.XXXXXX")"
  ( umask 077; printf '%s\n' "$APPLE_API_KEY_P8" >"$NOTARY_KEY_FILE" )
  chmod 600 "$NOTARY_KEY_FILE"
}

# detect: all seven secrets present -> enabled=true. SOME present -> hard error
# (misconfiguration must not silently ship an unsigned release). NONE present
# -> hard error too, unless VST_ALLOW_UNSIGNED_MACOS=1 (release.yml sets it
# only when the repository is not the canonical one, i.e. on forks): on the
# canonical repo "no secrets" means the environment/secrets are missing or the
# job lost its `release-signing` environment, and publishing an unsigned macOS
# release must fail closed. Also refuses a signing team that differs from the
# Team ID pinned in scripts/install.sh, since install.sh would then reject
# every binary of the release.
detect() {
  local names="APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER"
  local n present="" missing=""
  for n in $names; do
    if [ -n "${!n:-}" ]; then present="$present $n"; else missing="$missing $n"; fi
  done
  local out="${GITHUB_OUTPUT:-/dev/null}"
  if [ -z "$present" ]; then
    if [ "${VST_ALLOW_UNSIGNED_MACOS:-0}" != 1 ]; then
      echo "::error title=macOS signing secrets missing::No Apple signing secrets reached this job; refusing to build an unsigned macOS release (check the release-signing environment and its seven APPLE_* secrets)"
      exit 1
    fi
    echo "enabled=false" >>"$out"
    echo "::warning title=macOS signing disabled::No Apple signing secrets are available; this macOS build is UNSIGNED and not notarized (Gatekeeper will block it; install.sh's codesign fallback will reject it). Expected on forks only."
    return 0
  fi
  if [ -n "$missing" ]; then
    echo "::error title=Incomplete Apple signing configuration::Missing:$missing (set all seven or none)"
    exit 1
  fi
  local pinned root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  pinned="$(sed -n 's/^APPLE_TEAM_ID="\([A-Z0-9]\{10\}\)"$/\1/p' "$root/scripts/install.sh")"
  [ -n "$pinned" ] || die "cannot read APPLE_TEAM_ID from scripts/install.sh"
  if [ "$APPLE_TEAM_ID" != "$pinned" ]; then
    echo "::error title=Team ID mismatch::APPLE_TEAM_ID secret differs from the Team ID pinned in scripts/install.sh ($pinned); update the pin or the secret"
    exit 1
  fi
  echo "enabled=true" >>"$out"
  echo "macOS signing enabled (team $pinned)"
}

kc_path() { printf '%s' "${VST_SIGNING_KEYCHAIN:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vst-signing.keychain-db}"; }

keychain_setup() {
  : "${APPLE_CERTIFICATE:?APPLE_CERTIFICATE not set}"
  : "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE_PASSWORD not set}"
  local kc pw tmp p12
  kc="$(kc_path)"
  pw="$(openssl rand -base64 24)"
  echo "::add-mask::$pw"
  tmp="$(mktemp -d)"
  CLEAN+=("$tmp")
  p12="$tmp/cert.p12"
  printf '%s' "$APPLE_CERTIFICATE" | openssl base64 -d -A >"$p12"
  chmod 600 "$p12"
  security create-keychain -p "$pw" "$kc"
  security set-keychain-settings -lut 7200 "$kc"
  security unlock-keychain -p "$pw" "$kc"
  security import "$p12" -k "$kc" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$pw" "$kc" >/dev/null
  # Prepend to the user search list so tools that do not take --keychain see it.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
  if [ -n "${GITHUB_ENV:-}" ]; then echo "VST_SIGNING_KEYCHAIN=$kc" >>"$GITHUB_ENV"; fi
  echo "imported signing identity(ies) into temporary keychain:"
  security find-identity -v -p codesigning "$kc" | sed 's/^ *[0-9]*) [0-9A-F]* /  /'
}

keychain_cleanup() {
  local kc
  kc="$(kc_path)"
  [ -e "$kc" ] || { echo "no temporary keychain to remove"; return 0; }
  security delete-keychain "$kc" || true
  echo "temporary keychain removed"
}

sign_files() {
  local ent=""
  if [ "${1:-}" = "-e" ]; then ent="$2"; shift 2; fi
  : "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY not set}"
  [ $# -gt 0 ] || die "sign: no files"
  local f args
  for f in "$@"; do
    [ -f "$f" ] || die "sign: $f not found"
    # Explicit identifier = file name: install.sh's codesign fallback pins it
    # (a bare Mach-O would otherwise get a name-<hash> identifier).
    args=(--force --options runtime --timestamp --identifier "$(basename "$f")" --sign "$APPLE_SIGNING_IDENTITY")
    if [ -n "${VST_SIGNING_KEYCHAIN:-}" ]; then args+=(--keychain "$VST_SIGNING_KEYCHAIN"); fi
    if [ -n "$ent" ]; then args+=(--entitlements "$ent"); fi
    codesign "${args[@]}" "$f"
    echo "signed $f"
  done
}

# submit_and_wait <zip|dmg|pkg>: notarize one file, require "Accepted".
# Authenticates with an App Store Connect API key (never an Apple ID password).
submit_and_wait() {
  : "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID not set}"
  : "${APPLE_API_ISSUER:?APPLE_API_ISSUER not set}"
  local key out status id
  ensure_notary_key
  key="$NOTARY_KEY_FILE"
  out="$(mktemp)"
  CLEAN+=("$out")
  # Step 1: upload only. The submission id is recorded the moment it exists, BEFORE the
  # (long) wait, so a step timeout or a runner loss never discards it.
  xcrun notarytool submit "$1" --key "$key" --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" --no-wait --output-format json >"$out" || true
  id="$(plutil -extract id raw -o - "$out" 2>/dev/null || echo unknown)"
  if [ "$id" = unknown ]; then
    cat "$out" >&2 || true
    die "notarytool did not return a submission id (upload failed?)"
  fi
  echo "notarization submission $id submitted (file: $(basename "$1"))"
  echo "::notice title=notarization submission id::$id ($(basename "$1")) - if this step times out, check with: xcrun notarytool info $id --key <p8> --key-id <id> --issuer <issuer> (log: xcrun notarytool log $id ...)"
  if [ -n "${RUNNER_TEMP:-}" ]; then echo "$id $(basename "$1")" >>"$RUNNER_TEMP/notarization-submission-ids.txt"; fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "- notarization submission \`$id\` ($(basename "$1"))" >>"$GITHUB_STEP_SUMMARY"; fi
  # Step 2: bounded wait. The service keeps processing after the timeout; the id stays valid.
  xcrun notarytool wait "$id" --key "$key" --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" --timeout "$NOTARY_WAIT" --output-format json >"$out" || true
  status="$(plutil -extract status raw -o - "$out" 2>/dev/null || echo unknown)"
  rm -f "$out"
  echo "notarization submission $id: $status"
  if [ "$status" != "Accepted" ]; then
    if [ "$status" = "unknown" ] || [ "$status" = "In Progress" ]; then
      echo "still processing or no answer within $NOTARY_WAIT; check later with: xcrun notarytool info $id (then wait/log) using the same API key" >&2
    else
      xcrun notarytool log "$id" --key "$key" --key-id "$APPLE_API_KEY_ID" \
        --issuer "$APPLE_API_ISSUER" || true
    fi
    die "notarization was not accepted (submission $id, status: $status; inspect: xcrun notarytool log $id)"
  fi
}

notarize_files() {
  [ $# -gt 0 ] || die "notarize: no files"
  local tmp stage f
  tmp="$(mktemp -d)"
  CLEAN+=("$tmp")
  stage="$tmp/stage"; mkdir -p "$stage"
  for f in "$@"; do cp "$f" "$stage/$(basename "$f")"; done
  ditto -c -k --sequesterRsrc "$stage" "$tmp/notarize.zip"
  submit_and_wait "$tmp/notarize.zip"
}

# The Tauri bundler signs and notarizes the .app inside the dmg but leaves the
# dmg container itself unsigned (observed: `codesign -dv` -> "not signed at
# all"). Sign + notarize + staple the container too, so `spctl -t open` and
# `stapler validate` accept the file a user actually downloads.
dmg_files() {
  : "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY not set}"
  [ $# -gt 0 ] || die "dmg: no files"
  local f args
  for f in "$@"; do
    [ -f "$f" ] || die "dmg: $f not found"
    args=(--force --timestamp --sign "$APPLE_SIGNING_IDENTITY")
    if [ -n "${VST_SIGNING_KEYCHAIN:-}" ]; then args+=(--keychain "$VST_SIGNING_KEYCHAIN"); fi
    codesign "${args[@]}" "$f"
    submit_and_wait "$f"
    xcrun stapler staple "$f"
  done
}

# app_sign <entitlements> <App.app>: the desktop bundle is built UNSIGNED and without
# any secret, then signed here (same job as the Tauri bundler used to do). Nested
# Mach-O files (the vst/claude-acp/codex-acp sidecars, anything in Resources) are
# signed first, individually; codesign does not sign nested code without --deep.
# The main executable is signed with the bundle (identifier = CFBundleIdentifier).
app_sign() {
  [ $# -eq 2 ] || die "usage: app-sign <entitlements.plist> <App.app>"
  local ent="$1" app="$2" main f n=0 args
  : "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY not set}"
  [ -d "$app" ] || die "app-sign: $app is not a directory"
  [ -f "$ent" ] || die "app-sign: entitlements $ent not found"
  main="$(plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")"
  [ -n "$main" ] || die "app-sign: no CFBundleExecutable in $app"
  while IFS= read -r -d '' f; do
    [ "$f" = "$app/Contents/MacOS/$main" ] && continue
    if file -b "$f" | grep -q 'Mach-O'; then
      sign_files -e "$ent" "$f"
      n=$((n + 1))
    fi
  done < <(find "$app" -type f -print0)
  echo "signed $n nested Mach-O file(s)"
  args=(--force --options runtime --timestamp --entitlements "$ent" --sign "$APPLE_SIGNING_IDENTITY")
  if [ -n "${VST_SIGNING_KEYCHAIN:-}" ]; then args+=(--keychain "$VST_SIGNING_KEYCHAIN"); fi
  codesign "${args[@]}" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  echo "signed $app"
}

# app_notarize <App.app>: zip (keeping the bundle directory), notarize, staple.
app_notarize() {
  [ $# -eq 1 ] || die "usage: app-notarize <App.app>"
  local app="$1" tmp
  [ -d "$app" ] || die "app-notarize: $app is not a directory"
  tmp="$(mktemp -d)"
  CLEAN+=("$tmp")
  ditto -c -k --sequesterRsrc --keepParent "$app" "$tmp/app.zip"
  submit_and_wait "$tmp/app.zip"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  detect) detect ;;
  keychain-setup) keychain_setup ;;
  keychain-cleanup) keychain_cleanup ;;
  sign) sign_files "$@" ;;
  notarize) notarize_files "$@" ;;
  dmg) dmg_files "$@" ;;
  app-sign) app_sign "$@" ;;
  app-notarize) app_notarize "$@" ;;
  *) die "usage: $0 detect|keychain-setup|keychain-cleanup|sign [-e plist] <file...>|notarize <file...>|dmg <file...>|app-sign <plist> <app>|app-notarize <app>" ;;
esac

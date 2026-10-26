#!/usr/bin/env bash
# Verify macOS release artifacts are Developer-ID signed by the pinned team.
#
#   macos-verify-signed.sh binary <file...>    bare Mach-O executables (CLI tarball members)
#   macos-verify-signed.sh bundle <app|dmg>    the desktop app (a .dmg is mounted read-only)
#
# The pinned team is read from scripts/install.sh (APPLE_TEAM_ID) so CI and the
# installer cannot drift: a release signed by any other team fails here instead
# of shipping something install.sh would refuse. The requirement string below
# MUST match verify_codesign() in scripts/install.sh.
#
# `bundle` additionally requires, for the app and (when given) the dmg:
# `codesign --verify --deep --strict`, the Team ID reported by `codesign -dv`
# (TeamIdentifier=), the hardened-runtime flag on the app, a valid stapled
# ticket (`stapler validate`), and Gatekeeper acceptance whose OUTPUT is parsed
# ("accepted" and "source=Notarized Developer ID"), not just spctl's exit code
# (spctl exits 0 for everything when assessments are disabled on the runner).
# Set VST_ALLOW_UNNOTARIZED=1 to downgrade ONLY the stapler/spctl checks
# (signature + team + hardened runtime are still enforced); used by local/Mac
# verification before notarization creds exist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "FAIL: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "macOS only"

TEAM="$(sed -n 's/^APPLE_TEAM_ID="\([A-Z0-9]\{10\}\)"$/\1/p' "$ROOT/scripts/install.sh")"
[ -n "$TEAM" ] || die "cannot read APPLE_TEAM_ID from scripts/install.sh"
REQ="anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM\""

check_macho() { # <file>: signature, pinned team, hardened runtime, secure timestamp
  local f="$1" info
  codesign --verify --strict "$f" 2>&1 || die "$f: invalid or missing signature"
  codesign --verify --strict -R "=$REQ" "$f" 2>&1 || die "$f: not signed by Developer ID team $TEAM"
  info="$(codesign -d --verbose=4 "$f" 2>&1)"
  printf '%s\n' "$info" | grep -qx "TeamIdentifier=$TEAM" || die "$f: TeamIdentifier is not $TEAM"
  printf '%s\n' "$info" | grep -q 'flags=0x[0-9a-f]*(.*runtime' || die "$f: hardened runtime flag missing"
  printf '%s\n' "$info" | grep -q '^Timestamp=' || die "$f: no secure timestamp"
  echo "ok  $f"
}

# assert_team <path>: the Team ID codesign reports must equal the pinned one
# (independent of the requirement-string check above).
assert_team() {
  local f="$1" info
  info="$(codesign -dv --verbose=4 "$f" 2>&1)" || die "$f: codesign -dv failed: $info"
  printf '%s\n' "$info" | grep -qx "TeamIdentifier=$TEAM" || die "$f: TeamIdentifier is not $TEAM"
}

# assert_hardened <path>: the code-directory flags include `runtime`.
assert_hardened() {
  codesign -dv --verbose=4 "$1" 2>&1 | grep -q 'flags=0x[0-9a-f]*(.*runtime' || die "$1: hardened runtime flag missing"
}

# assert_gatekeeper <label> <spctl args...>: require exit 0 AND parsed output
# "accepted" + "source=Notarized Developer ID" (assessments disabled would pass
# on exit code alone). VST_ALLOW_UNNOTARIZED=1 only reports.
assert_gatekeeper() {
  local label="$1" out rc=0
  shift
  out="$(spctl "$@" 2>&1)" || rc=$?
  if [ "${VST_ALLOW_UNNOTARIZED:-0}" = 1 ]; then
    printf '%s\n' "$out"
    [ "$rc" = 0 ] || echo "note: Gatekeeper rejects the $label (expected before notarization)"
    return 0
  fi
  [ "$rc" = 0 ] || die "Gatekeeper rejects the $label: $out"
  printf '%s\n' "$out" | grep -q ': accepted' || die "Gatekeeper did not report 'accepted' for the $label: $out"
  printf '%s\n' "$out" | grep -q 'source=Notarized Developer ID' || die "$label is not assessed as 'Notarized Developer ID': $out"
  echo "ok  Gatekeeper: $label accepted (Notarized Developer ID)"
}

# assert_stapled <label> <path>
assert_stapled() {
  if xcrun stapler validate "$2"; then return 0; fi
  if [ "${VST_ALLOW_UNNOTARIZED:-0}" = 1 ]; then echo "note: $1 has no stapled ticket (expected before notarization)"; return 0; fi
  die "$1 has no valid stapled notarization ticket"
}

is_macho() { file -b "$1" | grep -q 'Mach-O'; }

cmd="${1:-}"; shift || true
case "$cmd" in
  binary)
    [ $# -gt 0 ] || die "no files"
    for f in "$@"; do
      check_macho "$f"
      # Mirror install.sh verify_codesign: the code identifier is the file name
      # (macos-ci-sign.sh signs with --identifier <file name>).
      codesign --verify --strict -R "=identifier \"$(basename "$f")\"" "$f" 2>&1 \
        || die "$f: code identifier is not \"$(basename "$f")\""
    done
    ;;
  bundle)
    [ $# -eq 1 ] || die "usage: $0 bundle <app|dmg>"
    target="$1"; mnt=""; app="$target"
    cleanup() { if [ -n "$mnt" ]; then hdiutil detach "$mnt" -quiet || true; fi; }
    trap cleanup EXIT
    case "$target" in
      *.dmg)
        mnt="$(mktemp -d /tmp/vst-dmg.XXXXXX)"
        hdiutil attach "$target" -readonly -nobrowse -noverify -mountpoint "$mnt" -quiet
        # shellcheck source=macos-dmg-layout.sh
        . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/macos-dmg-layout.sh"
        app="$(dmg_single_app "$mnt")"
        dmg_assert_layout "$mnt"
        echo "== dmg container: $target"
        codesign --verify --deep --strict --verbose=2 "$target" || die "dmg container is not validly signed"
        codesign --verify --strict -R "=$REQ" "$target" || die "dmg is not signed by Developer ID team $TEAM"
        assert_team "$target"
        assert_stapled "dmg" "$target"
        echo "spctl --status: $(spctl --status 2>&1 || true)"
        assert_gatekeeper "dmg" -a -t open --context context:primary-signature -vv "$target"
        ;;
    esac
    echo "== app: $app"
    codesign --verify --deep --strict --verbose=2 "$app" || die "codesign --deep --strict failed"
    codesign --verify --strict -R "=$REQ" "$app" || die "app is not signed by Developer ID team $TEAM"
    # Every Mach-O in the bundle (the vst/claude-acp/codex-acp sidecars AND
    # any Mach-O that ever lands in Resources) must be individually signed: the notary service rejects the
    # whole submission otherwise, and --deep does not look inside Resources.
    n=0
    while IFS= read -r -d '' f; do
      if is_macho "$f"; then check_macho "$f"; n=$((n + 1)); fi
    done < <(find "$app" -type f -print0)
    echo "checked $n Mach-O files"
    [ "$n" -gt 0 ] || die "no Mach-O files found in $app"
    assert_team "$app"
    assert_hardened "$app"
    assert_stapled "app" "$app"
    echo "spctl --status: $(spctl --status 2>&1 || true)"
    assert_gatekeeper "app" -a -vv -t exec "$app"
    ;;
  *) die "usage: $0 binary <file...> | bundle <app|dmg>" ;;
esac
echo "PASS"

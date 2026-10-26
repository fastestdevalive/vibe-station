#!/usr/bin/env bash
# macos-repack-dmg.sh -- replace the .app inside a Tauri-built dmg with the signed one.
#
#   scripts/macos-repack-dmg.sh <app.dmg> <signed App.app>
#
# The desktop bundle is built unsigned and secret-free; the app is then signed and
# notarized on its own. This swaps that app into the bundler's dmg (keeping its
# window layout and Applications link) and writes the dmg back as UDZO. No secrets
# are used. Run recompress-dmg.sh afterwards, then `macos-ci-sign.sh dmg`.
set -euo pipefail
die() { echo "error: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "macOS only"
[ $# -eq 2 ] || die "usage: $0 <app.dmg> <App.app>"
DMG="$1"; APP="$2"
[ -f "$DMG" ] || die "no such dmg: $DMG"
[ -d "$APP" ] || die "no such app: $APP"

TMP="$(mktemp -d)"; MNT="$TMP/mnt"; mkdir "$MNT"; ATTACHED=""
# Backoff unit in seconds between graceful detach attempts (tests set it to 0).
DETACH_UNIT="${VST_DETACH_BACKOFF_UNIT:-2}"

# detach_mnt: unmount $MNT. "Resource busy" right after heavy reads (codesign
# --verify --deep) is a common CI flake, so retry gracefully with backoff and
# only then fall back to `detach -force` as the last resort. Fails loudly if even
# that does not work. Only ever detaches the image THIS script attached.
detach_mnt() {
  local i
  [ -n "$ATTACHED" ] || return 0
  for i in 1 2 3 4 5; do
    if hdiutil detach "$MNT" -quiet; then ATTACHED=""; return 0; fi
    echo "warn: detach of $MNT failed (attempt $i/5); retrying" >&2
    sleep $((i * DETACH_UNIT))
  done
  echo "warn: graceful detach failed; forcing" >&2
  if hdiutil detach "$MNT" -force -quiet; then ATTACHED=""; return 0; fi
  return 1
}
# Runs on every exit path (die, set -e, signal): never leaves the image mounted.
cleanup() {
  if detach_mnt; then
    rm -rf "$TMP"
  else
    # Never rm -rf through a still-mounted volume.
    echo "warn: could not detach $MNT; leaving $TMP in place (image may still be mounted)" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# top_level <dir>: sorted top-level entry names except the app, one per line, with
# a trailing "@" for symlinks (so the Applications link is part of the comparison).
# Transient volume junk written by macOS itself is ignored.
top_level() {
  local f n
  find "$1" -mindepth 1 -maxdepth 1 | while IFS= read -r f; do
    n="$(basename "$f")"
    case "$n" in *.app | .fseventsd | .Trashes | .Spotlight-V100 | .TemporaryItems) continue ;; esac
    if [ -L "$f" ]; then printf '%s@\n' "$n"; else printf '%s\n' "$n"; fi
  done | sort
}
vol_name() { diskutil info "$1" | sed -n 's/^ *Volume Name: *//p' | head -n1; }

hdiutil convert "$DMG" -format UDRW -o "$TMP/rw.dmg" -quiet
hdiutil attach "$TMP/rw.dmg" -readwrite -nobrowse -noverify -mountpoint "$MNT" -quiet
ATTACHED=1
# shellcheck source=macos-dmg-layout.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/macos-dmg-layout.sh"
# Exactly one .app, the same name as the signed one, and nothing else outside the layout allow-list.
OLD="$(dmg_single_app "$MNT")"
NAME="$(basename "$OLD")"
[ "$NAME" = "$(basename "$APP")" ] || die "dmg app name ($NAME) differs from the signed app ($(basename "$APP"))"
dmg_assert_layout "$MNT"

# Volume metadata the bundler set up (name, background, window layout in
# .DS_Store, Applications symlink) lives OUTSIDE the .app, so replacing only the
# app keeps it. Snapshot it to prove that below.
BEFORE_NAME="$(vol_name "$MNT")"
BEFORE_LIST="$(top_level "$MNT")"

# Free-space check BEFORE any copy: the signed+stapled app is larger than the
# unsigned one, and the UDRW image keeps the original filesystem size.
NEED_KB="$(du -sk "$APP" | awk '{print $1}')"
OLD_KB="$(du -sk "$OLD" | awk '{print $1}')"
FREE_KB="$(df -k "$MNT" | awk 'NR==2 {print $4}')"
case "$NEED_KB$OLD_KB$FREE_KB" in '' | *[!0-9]*) die "could not measure free space on $MNT (need=$NEED_KB old=$OLD_KB free=$FREE_KB)" ;; esac
if [ "$NEED_KB" -gt $((FREE_KB + OLD_KB)) ]; then
  die "not enough room in the dmg: signed app needs ${NEED_KB} KiB but the volume has ${FREE_KB} KiB free + ${OLD_KB} KiB reclaimed from the unsigned app; the bundler's image is too small"
fi

rm -rf "$OLD"
# ditto keeps the code signature, xattrs and the stapled ticket intact.
ditto "$APP" "$MNT/$NAME"
# Bail out loudly if the swapped-in copy is not byte-for-byte a valid signed bundle.
codesign --verify --deep --strict "$MNT/$NAME"
# macOS drops these on a read-write mount; they were not in the bundler's image.
rm -rf "$MNT/.fseventsd" "$MNT/.Trashes" 2>/dev/null || true
dmg_assert_layout "$MNT"
[ "$(dmg_single_app "$MNT")" = "$MNT/$NAME" ] || die "the replaced app is not the single .app of the dmg"

[ "$(top_level "$MNT")" = "$BEFORE_LIST" ] || die "volume contents changed during repack (before: $(printf '%s' "$BEFORE_LIST" | tr '\n' ' ') / after: $(top_level "$MNT" | tr '\n' ' '))"
[ "$(vol_name "$MNT")" = "$BEFORE_NAME" ] || die "volume name changed during repack"
sync
detach_mnt || die "could not detach $MNT (even with -force)"
rm -f "$DMG"
hdiutil convert "$TMP/rw.dmg" -format UDZO -o "$DMG" -quiet
hdiutil verify "$DMG" -quiet
echo "repacked $(basename "$DMG") with $(basename "$APP")"

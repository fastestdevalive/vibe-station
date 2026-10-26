#!/usr/bin/env bash
# Sourced by macos-repack-dmg.sh and macos-verify-signed.sh (needs a `die` function).
# The dmg comes from the unsigned build job, and its whole volume ends up under our
# Developer ID signature, so its layout is checked against an allow-list, not just the .app:
#   exactly ONE top-level *.app (a real directory), and besides it only
#   Applications -> /Applications (symlink), .background/ (non-executable regular files),
#   .DS_Store and .VolumeIcon.icns (non-executable regular files).
# Transient volume junk macOS writes itself (.fseventsd .Trashes .Spotlight-V100 .TemporaryItems)
# is ignored.

# dmg_single_app <mountpoint> -> prints the path of the one .app, dies on zero or several.
dmg_single_app() {
  local mnt="$1" apps n
  apps="$(find "$mnt" -mindepth 1 -maxdepth 1 -name '*.app')"
  n="$(printf '%s\n' "$apps" | grep -c . || true)"
  [ "$n" = 1 ] || die "expected exactly one .app in the dmg, found $n"
  [ -d "$apps" ] && [ ! -L "$apps" ] || die "the .app in the dmg is not a real directory"
  printf '%s\n' "$apps"
}

# dmg_assert_layout <mountpoint>: dies on any top-level entry outside the allow-list.
dmg_assert_layout() {
  local mnt="$1" f n
  while IFS= read -r f; do
    n="$(basename "$f")"
    case "$n" in
      *.app) [ -d "$f" ] && [ ! -L "$f" ] || die "$n is not a real directory" ;;
      .fseventsd | .Trashes | .Spotlight-V100 | .TemporaryItems) ;;
      Applications)
        [ -L "$f" ] && [ "$(readlink "$f")" = /Applications ] || die "Applications is not a symlink to /Applications"
        ;;
      .background)
        [ -d "$f" ] && [ ! -L "$f" ] || die ".background is not a real directory"
        [ -z "$(find "$f" ! -type f ! -type d -print -quit)" ] || die ".background holds a link or special file"
        [ -z "$(find "$f" -type f -perm -u+x -print -quit)" ] || die ".background holds an executable"
        ;;
      .DS_Store | .VolumeIcon.icns)
        [ -f "$f" ] && [ ! -L "$f" ] && [ ! -x "$f" ] || die "$n is not a plain non-executable file"
        ;;
      *) die "unexpected item in the dmg (not in the allow-list): $n" ;;
    esac
  done < <(find "$mnt" -mindepth 1 -maxdepth 1)
}

#!/usr/bin/env bash
# Assemble the release asset set from the per-artifact download directories.
#
#   collect-release-assets.sh <downloaded-dir> <out-dir>
#
# <downloaded-dir> holds one subdirectory per build artifact (download-artifact without
# merge-multiple). Every asset is taken from the ONE artifact allowed to produce it; the
# set of artifact directories and the files in each must match the table exactly, no
# name may appear twice, and each .sha256 must match its file. So a compromised build job
# cannot substitute another job's asset (e.g. a Linux job shipping the macOS dmg).
# Keep the table in sync with release.yml artifact names (check-release-names-in-sync.sh).
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <downloaded-dir> <out-dir>" >&2; exit 2; }
SRC="$1"; OUT="$2"
fail() { echo "::error::collect-release-assets: $*" >&2; exit 1; }

# <artifact dir> <asset name>   (each asset also needs <asset name>.sha256 beside it)
TABLE="cli-x86_64-unknown-linux-musl vst-x86_64-unknown-linux-musl.tar.gz
cli-aarch64-unknown-linux-musl vst-aarch64-unknown-linux-musl.tar.gz
cli-aarch64-apple-darwin vst-aarch64-apple-darwin.tar.gz
desktop-x86_64-unknown-linux-gnu vibe-station-x86_64-unknown-linux-gnu.AppImage
desktop-x86_64-unknown-linux-gnu vibe-station-x86_64-unknown-linux-gnu.deb
desktop-aarch64-apple-darwin vibe-station-aarch64-apple-darwin.dmg"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

[ -d "$SRC" ] && [ ! -L "$SRC" ] || fail "$SRC is not a directory"
mkdir -p "$OUT"
[ -z "$(ls -A "$OUT")" ] || fail "$OUT is not empty"

# 1. exactly the expected artifact directories
want_dirs="$(printf '%s\n' "$TABLE" | cut -d' ' -f1 | sort -u)"
have_dirs="$(cd "$SRC" && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | sort)"
[ "$want_dirs" = "$have_dirs" ] || fail "artifact directories differ. expected: $(echo $want_dirs) found: $(echo $have_dirs)"

# 2. per artifact: exactly the expected regular files (no symlinks, no subdirectories)
for d in $want_dirs; do
  [ -d "$SRC/$d" ] && [ ! -L "$SRC/$d" ] || fail "$d is not a directory"
  want_files="$(printf '%s\n' "$TABLE" | awk -v d="$d" '$1==d {print $2; print $2 ".sha256"}' | sort)"
  have_files="$(cd "$SRC/$d" && find . -mindepth 1 | sed 's|^\./||' | sort)"
  [ "$want_files" = "$have_files" ] || fail "$d contents differ. expected: $(echo $want_files) found: $(echo $have_files)"
done

# 3. copy by explicit mapping, refusing duplicates / non-regular files, and check each sha256
n=0
while IFS=' ' read -r d a; do
  [ -n "$d" ] || continue
  for f in "$a" "$a.sha256"; do
    s="$SRC/$d/$f"
    [ -f "$s" ] && [ ! -L "$s" ] || fail "missing or not a regular file: $d/$f"
    [ ! -e "$OUT/$f" ] || fail "duplicate asset $f"
    cp "$s" "$OUT/$f"
    n=$((n + 1))
  done
  [ "$(cat "$OUT/$a.sha256")" = "$(sha256_of "$OUT/$a")" ] || fail "$a.sha256 does not match $a"
done <<EOF2
$TABLE
EOF2

total="$(find "$OUT" -type f | wc -l | tr -d ' ')"
[ "$total" = "$n" ] || fail "expected $n files in $OUT, found $total"
echo "collected $n files from $(echo "$want_dirs" | wc -l | tr -d ' ') artifacts:"
ls -l "$OUT"

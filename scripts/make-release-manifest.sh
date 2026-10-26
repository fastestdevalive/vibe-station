#!/usr/bin/env bash
# Build the SHA256SUMS release manifest (strict grammar; keep in sync with
# rust/vst-daemon/src/update/install/manifest.rs and install.sh).
#
# usage: make-release-manifest.sh <assets-dir> <tag> <out-file>
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <assets-dir> <tag> <out-file>" >&2; exit 2; }
dir="$1"; tag="$2"; out="$3"

[ -d "$dir" ] || { echo "error: $dir is not a directory" >&2; exit 1; }
printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$' \
  || { echo "error: invalid tag '$tag'" >&2; exit 1; }

REQUIRED="vst-x86_64-unknown-linux-musl.tar.gz
vst-aarch64-unknown-linux-musl.tar.gz
vst-aarch64-apple-darwin.tar.gz
vibe-station-x86_64-unknown-linux-gnu.AppImage
vibe-station-x86_64-unknown-linux-gnu.deb
vibe-station-aarch64-apple-darwin.dmg"

# sha256sum on GNU/Linux, shasum on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Portable (no GNU `find -printf`): plain glob over regular files.
names="$(
  for f in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -f "$f" ] || continue
    n="${f##*/}"
    case "$n" in *.sha256|SHA256SUMS*) continue ;; esac
    printf '%s\n' "$n"
  done | LC_ALL=C sort
)"
[ -n "$names" ] || { echo "error: no assets in $dir" >&2; exit 1; }

{
  printf '# vibe-station release manifest v1\n'
  printf '# tag=%s\n' "$tag"
  while IFS= read -r n; do
    printf '%s' "$n" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$' \
      || { echo "error: invalid asset name '$n'" >&2; exit 1; }
    h="$(sha256_of "$dir/$n")"
    printf '%s  %s\n' "$h" "$n"
  done <<EOF2
$names
EOF2
} >"$tmp"

for r in $REQUIRED; do
  printf '%s\n' "$names" | grep -Fxq -- "$r" \
    || { echo "error: required asset '$r' is missing from $dir" >&2; exit 1; }
done

cp "$tmp" "$out"
echo "wrote $out ($(grep -vc '^#' "$out") entries) for $tag"

#!/usr/bin/env bash
# recompress-dmg.sh — re-pack a dmg with lzma (ULMO) instead of the zlib (UDZO) Tauri's bundler writes.
#
#   scripts/recompress-dmg.sh <path/to/app.dmg> [...]
#
# Same contents, ~20-25% smaller (measured 24.7 -> 19.6 MB). macOS only; ULMO needs macOS 10.15+
# (an arm64-only app already requires 11). Run it BEFORE publishing/uploading the dmg. The app
# inside keeps its signature/notarization ticket. The dmg container's OWN signature (if a
# signingIdentity is configured for the dmg) is dropped by the repack: re-sign it after this
# step if you enable dmg signing (today tauri.conf.json has signingIdentity: null).
set -euo pipefail
[[ "$(uname -s)" == "Darwin" ]] || { echo "recompress-dmg.sh: macOS only" >&2; exit 1; }
[[ $# -ge 1 ]] || { echo "usage: $0 <dmg>..." >&2; exit 1; }
for dmg in "$@"; do
  [[ -f "$dmg" ]] || { echo "error: no such file: $dmg" >&2; exit 1; }
  before=$(stat -f %z "$dmg"); tmp="${dmg%.dmg}.ulmo.$$.dmg"
  hdiutil convert "$dmg" -format ULMO -o "$tmp" -quiet
  hdiutil verify "$tmp" -quiet
  mv -f "$tmp" "$dmg"
  echo "recompressed $(basename "$dmg"): $before -> $(stat -f %z "$dmg") bytes (ULMO)"
done

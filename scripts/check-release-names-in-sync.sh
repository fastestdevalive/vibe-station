#!/usr/bin/env bash
# Fail when the release file names drift between the places that must agree:
#   - rust/vst-daemon/src/update/platform.rs  asset names the updater downloads
#   - .github/workflows/release.yml           asset names (and targets) CI produces
#   - scripts/package-cli-tarball.sh          the binaries packed in the CLI tarball
#   - scripts/install.sh (ALLOWED_BINS)       the binaries the installer will install
#   - rust/vst-daemon/src/update/install/replace.rs (KNOWN_NAMES)
#                                             every binary ever shipped (rollback set)
#   - the manifest header line in manifest.rs, install.sh, make-release-manifest.sh
#
# usage: check-release-names-in-sync.sh   (run from anywhere; reads the repo it lives in)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="$ROOT/rust/vst-daemon/src/update/platform.rs"
REPLACE="$ROOT/rust/vst-daemon/src/update/install/replace.rs"
MANIFEST_RS="$ROOT/rust/vst-daemon/src/update/install/manifest.rs"
WF="$ROOT/.github/workflows/release.yml"
PACK="$ROOT/scripts/package-cli-tarball.sh"
INSTALL="$ROOT/scripts/install.sh"
MAKE_MANIFEST="$ROOT/scripts/make-release-manifest.sh"

FAILS=0
bad() { echo "error: $1" >&2; FAILS=$((FAILS + 1)); }

# 1. Every asset name in platform.rs is produced by release.yml: the name with its
#    target triple replaced by ${{ matrix.target }} appears in the workflow, and the
#    triple is a build target there.
assets="$(grep -oE '"(vst|vibe-station)-[A-Za-z0-9_.-]+\.(tar\.gz|AppImage|deb|dmg)"' "$PLATFORM" | tr -d '"' | sort -u)"
[ -n "$assets" ] || bad "no asset names found in platform.rs"
for a in $assets; do
  case "$a" in vst-*) prefix=vst ;; vibe-station-*) prefix=vibe-station ;; *) bad "unexpected asset name $a"; continue ;; esac
  rest="${a#"$prefix"-}"                   # <target>.<ext>
  target="${rest%%.*}"
  ext="${rest#"$target"}"
  tmpl="${prefix}-\${{ matrix.target }}${ext}"
  grep -qF "$tmpl" "$WF" || bad "platform.rs asset $a: release.yml has no '$tmpl'"
  grep -qE "target:[[:space:]]+$target\$" "$WF" || bad "platform.rs asset $a: release.yml has no build target '$target'"
done

# 2. Binaries: package-cli-tarball.sh == install.sh ALLOWED_BINS, and all are in KNOWN_NAMES.
packed="$(sed -n 's/^COPYFILE_DISABLE=1 tar .* vst \(.*\)$/vst \1/p' "$PACK" | tr ' ' '\n' | grep . | sort -u)"
allowed="$(sed -n 's/^ALLOWED_BINS="\(.*\)"$/\1/p' "$INSTALL" | head -n1 | tr ' ' '\n' | grep . | sort -u)"
known="$(grep -E 'KNOWN_NAMES:' "$REPLACE" | grep -oE '"[a-z-]+"' | tr -d '"' | sort -u)"
[ -n "$packed" ] && [ -n "$allowed" ] && [ -n "$known" ] || bad "could not extract binary lists (packed='$packed' allowed='$allowed' known='$known')"
[ "$packed" = "$allowed" ] || bad "tarball contents ($(echo $packed)) differ from install.sh ALLOWED_BINS ($(echo $allowed))"
for b in $packed; do
  printf '%s\n' "$known" | grep -qx "$b" || bad "shipped binary '$b' is missing from replace.rs KNOWN_NAMES"
done

# 3. The manifest header is identical in all three files.
hdr="# vibe-station release manifest v1"
for f in "$MANIFEST_RS" "$INSTALL" "$MAKE_MANIFEST"; do
  grep -qF "$hdr" "$f" || bad "manifest header '$hdr' missing from ${f#"$ROOT"/}"
done

[ "$FAILS" -eq 0 ] || exit 1
echo "release names in sync ($(echo "$assets" | wc -l | tr -d ' ') assets, $(echo "$packed" | wc -l | tr -d ' ') binaries)"

#!/usr/bin/env bash
# Pack UNSIGNED macOS build output as plain data for the sign-macos job.
#
#   macos-pack-unsigned.sh cli     <out-dir> <vst> <claude-acp> <codex-acp>
#   macos-pack-unsigned.sh desktop <out-dir> <App.app> <app.dmg>
#
# Runs in the build jobs (which run third-party dependency code and hold no secrets). Writes
# unsigned-cli.tar | unsigned-app.tar + unsigned.dmg, plus MANIFEST.sha256 (sha256 of each).
# tar, because upload-artifact drops exec bits and symlinks. The sign-macos job NEVER executes
# anything from this artifact; macos-unpack-unsigned.sh re-checks it from a fresh checkout.
set -euo pipefail
die() { echo "error: $*" >&2; exit 1; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
[ $# -ge 2 ] || die "usage: $0 cli|desktop <out-dir> ..."
kind="$1"; out="$2"; shift 2
mkdir -p "$out"
[ -z "$(ls -A "$out")" ] || die "$out is not empty"
case "$kind" in
  cli)
    [ $# -eq 3 ] || die "usage: $0 cli <out-dir> <vst> <claude-acp> <codex-acp>"
    stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
    for f in "$@"; do [ -f "$f" ] && [ ! -L "$f" ] || die "not a regular file: $f"; done
    cp "$1" "$stage/vst"; cp "$2" "$stage/claude-acp"; cp "$3" "$stage/codex-acp"
    chmod 755 "$stage"/vst "$stage"/claude-acp "$stage"/codex-acp
    COPYFILE_DISABLE=1 tar -cf "$out/unsigned-cli.tar" -C "$stage" vst claude-acp codex-acp
    files="unsigned-cli.tar"
    ;;
  desktop)
    [ $# -eq 2 ] || die "usage: $0 desktop <out-dir> <App.app> <app.dmg>"
    app="${1%/}"; dmg="$2"
    [ -d "$app" ] && [ ! -L "$app" ] && [ "${app##*.}" = app ] || die "not an .app directory: $app"
    [ -f "$dmg" ] && [ ! -L "$dmg" ] || die "not a regular file: $dmg"
    COPYFILE_DISABLE=1 tar -cf "$out/unsigned-app.tar" -C "$(dirname "$app")" "$(basename "$app")"
    cp "$dmg" "$out/unsigned.dmg"
    files="unsigned-app.tar unsigned.dmg"
    ;;
  *) die "usage: $0 cli|desktop <out-dir> ..." ;;
esac
: >"$out/MANIFEST.sha256"
for f in $files; do printf '%s  %s\n' "$(sha256_of "$out/$f")" "$f" >>"$out/MANIFEST.sha256"; done
echo "packed $kind data:"; cat "$out/MANIFEST.sha256"

#!/usr/bin/env bash
# Verifies every checked-in version copy matches the canonical one
# ([workspace.package] version in rust/Cargo.toml). Optional arg: expected version.
# Run by versionbump.sh before committing and by CI.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

canon="$(perl -ne '$s=$1 if /^\[([^\]]+)\]/; if ($s eq "workspace.package" && /^version = "([^"]*)"/) { print $1; exit }' rust/Cargo.toml)"
[[ -n "$canon" ]] || { echo "cannot read workspace version from rust/Cargo.toml" >&2; exit 1; }
expected="${1:-$canon}"
fail=0
check() { # <label> <actual>
  if [[ "$2" != "$expected" ]]; then echo "MISMATCH $1: '$2' (expected '$expected')" >&2; fail=1; fi
}

check rust/Cargo.toml "$canon"
for f in package.json desktop/package.json web-ui/package.json; do
  check "$f" "$(perl -ne 'if (/"version":\s*"([^"]+)"/) { print $1; exit }' "$f")"
done
check desktop/src-tauri/Cargo.toml \
  "$(perl -ne '$s=$1 if /^\[([^\]]+)\]/; if ($s eq "package" && /^version = "([^"]*)"/) { print $1; exit }' desktop/src-tauri/Cargo.toml)"
tauri_v="$(jq -r .version desktop/src-tauri/tauri.conf.json)"
[[ "$tauri_v" == "../package.json" ]] || { echo "tauri.conf.json version must be \"../package.json\", got '$tauri_v'" >&2; fail=1; }
# every vst-* crate must inherit the workspace version
for f in rust/vst-*/Cargo.toml; do
  grep -q '^version.workspace = true' "$f" || { echo "$f does not inherit workspace version" >&2; fail=1; }
done
# lockfile entries for workspace crates
lock_bad="$(awk '/^name = "vst-/{n=$3} /^version = /{ if(n!=""){gsub(/"/,"",$3); if($3!="'"$expected"'") print n" "$3; n=""} }' rust/Cargo.lock)"
[[ -z "$lock_bad" ]] || { echo "rust/Cargo.lock stale:" >&2; echo "$lock_bad" >&2; fail=1; }

dlock_bad="$(awk '/^name = "vibe-station-desktop"/{f=1;next} f&&/^version = /{gsub(/"/,"",$3); if($3!="'"$expected"'") print $3; f=0}' desktop/src-tauri/Cargo.lock)"
[[ -z "$dlock_bad" ]] || { echo "desktop/src-tauri/Cargo.lock stale: $dlock_bad" >&2; fail=1; }

[[ $fail -eq 0 ]] && echo "versions in sync: $expected"
exit $fail

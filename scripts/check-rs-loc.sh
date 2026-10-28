#!/usr/bin/env bash
# Fails if a tracked .rs file exceeds MAX_LOC lines, unless it is listed in
# scripts/rs-loc-allowlist.txt. Allowlisted files may grow freely for now (the
# recorded line count in the allowlist is informational, not enforced); an entry
# whose file is back under MAX_LOC is flagged STALE so the list only shrinks.
# Run by CI (rust-ci.yml) and scripts/ci-steps.sh.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

MAX_LOC="${MAX_LOC:-2000}"
ALLOWLIST=scripts/rs-loc-allowlist.txt
fail=0

while read -r lines path; do
  [[ -f "$path" ]] || continue
  allowlisted="$(awk -v p="$path" '$1 == p { print $2 }' "$ALLOWLIST")"
  if [[ -n "$allowlisted" ]]; then
    if (( lines <= MAX_LOC )); then
      echo "STALE allowlist entry $path: $lines lines <= $MAX_LOC — remove it from $ALLOWLIST" >&2
      fail=1
    fi
  elif (( lines > MAX_LOC )); then
    echo "TOO LONG $path: $lines lines (limit $MAX_LOC) — split it" >&2
    fail=1
  fi
done < <(git ls-files '*.rs' | grep -v '^rust/vendor/' | xargs wc -l | grep -v ' total$' | awk '{ print $1, $2 }')

exit "$fail"

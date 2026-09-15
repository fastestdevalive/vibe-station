#!/usr/bin/env bash
# check-file-map.sh — asserts the daemon-rust-port file-map partition is
# complete and non-overlapping (arch Gotcha #11 / file-map completeness).
#
# Reads .vibekit/feature-plans/pending/daemon-rust-port/file-map.tsv (one row
# per git-tracked file under daemon/src and cli/src, column 1 = ts-file,
# column 2 = owning part) and verifies:
#   1. every `git ls-files` .ts/.mjs file under daemon/src and cli/src appears
#      in exactly one row,
#   2. no file appears twice (non-overlapping),
#   3. every owning part is a known part id.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FM="$ROOT/.vibekit/feature-plans/pending/daemon-rust-port/file-map.tsv"

KNOWN_PARTS="00 01 02 03 04-spike 04a 04b 04c 05 06 07a 07b 08 09 10"

if [ ! -f "$FM" ]; then
    echo "file-map not found: $FM" >&2
    exit 1
fi

declare -A seen
errors=0

# Track expected files from git.
mapfile -t expected < <(cd "$ROOT" && git ls-files daemon/src cli/src)
declare -A in_map
for f in "${expected[@]}"; do
    in_map["$f"]=0
done

while IFS=$'\t' read -r file part _rest; do
    # skip blank lines and comments
    [[ -z "$file" ]] && continue
    [[ "$file" == \#* ]] && continue

    if [ -n "${seen[$file]:-}" ]; then
        echo "DUPLICATE row for $file" >&2
        errors=$((errors + 1))
        continue
    fi
    seen["$file"]=1

    if [[ ! " $KNOWN_PARTS " == *" $part "* ]]; then
        echo "UNKNOWN part '$part' for $file" >&2
        errors=$((errors + 1))
    fi

    if [[ -n "${in_map[$file]:-}" ]]; then
        in_map["$file"]=1
    fi
done < "$FM"

# Every expected git file must appear exactly once.
for f in "${expected[@]}"; do
    if [ "${in_map[$f]:-0}" -ne 1 ]; then
        echo "MISSING from file-map: $f" >&2
        errors=$((errors + 1))
    fi
done

if [ "$errors" -gt 0 ]; then
    echo "file-map check FAILED ($errors error(s))" >&2
    exit 1
fi
echo "file-map check OK (${#expected[@]} files, all assigned exactly once)"

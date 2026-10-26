#!/usr/bin/env bash
# Fail closed unless <commit> is reachable from main.
#
#   check-commit-on-main.sh <commit> [<main-ref>]     (default main-ref: refs/remotes/origin/main)
#
# release.yml preflight runs it on the tagged commit after a full-history checkout, so a tag
# pushed on an unmerged branch cannot release. It does NOT stop a malicious tag by itself (the
# tag carries its own workflow file); that is the job of the GitHub tag ruleset. See docs/UPDATE.md.
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: $0 <commit> [<main-ref>]" >&2; exit 2; }
commit="$1"; main="${2:-refs/remotes/origin/main}"
printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "::error::'$commit' is not a full commit SHA"; exit 1; }
git rev-parse --verify -q "$main^{commit}" >/dev/null \
  || { echo "::error::cannot resolve $main (was main fetched?); refusing to release"; exit 1; }
git rev-parse --verify -q "$commit^{commit}" >/dev/null \
  || { echo "::error::commit $commit is not in the checkout; refusing to release"; exit 1; }
if ! git merge-base --is-ancestor "$commit" "$main"; then
  echo "::error::tagged commit $commit is not reachable from main: merge it to main first (tag is not on main)"
  exit 1
fi
echo "ok: $commit is reachable from $main"

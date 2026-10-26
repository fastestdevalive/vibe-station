#!/usr/bin/env bash
# Fail closed when the GitHub release for <tag> is already PUBLISHED.
#
#   check-release-not-published.sh <tag>      env: GH_TOKEN, GITHUB_REPOSITORY
#
# Re-running a release for a published tag would flip the live release back to draft and replace
# its assets with freshly built bytes (softprops/action-gh-release updates in place). Cut a new
# tag instead. No release, or a draft left by a failed run, is fine. Any other `gh` failure
# (auth, network, rate limit) also fails: an unknown state is not "not published".
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <tag>" >&2; exit 2; }
tag="$1"
printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$' \
  || { echo "::error::not a well-formed release tag"; exit 1; }
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"
if out="$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft 2>&1)"; then
  case "$out" in
    true) echo "ok: $tag exists only as a draft release" ;;
    false) echo "::error::release $tag is already published; cut a new tag instead of re-running"; exit 1 ;;
    *) echo "::error::unexpected gh output for $tag: $out"; exit 1 ;;
  esac
else
  case "$out" in
    *"release not found"*) echo "ok: no release for $tag yet" ;;
    *) echo "::error::cannot determine whether $tag is already published: $out"; exit 1 ;;
  esac
fi

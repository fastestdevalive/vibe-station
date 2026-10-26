#!/usr/bin/env bash
# Resolve and validate the release tag for .github/workflows/release.yml.
# Prints the tag (e.g. v0.4.0) on stdout; exits non-zero on anything else.
#
# env: GITHUB_REF  the ref the run was triggered on (set by Actions)
#      INPUT_TAG   workflow_dispatch `tag` input (empty on tag pushes)
#
# The tag must be a well-formed v<semver> (it is interpolated into later
# steps) and the run must be ON that tag: the release environments'
# deployment rule is evaluated against GITHUB_REF, so a dispatch from a branch
# with `-f tag=vX` would otherwise build/sign one ref while gating on another.
#
# Also: `resolve-release-tag.sh --is-prerelease <tag>` exits 0 iff <tag> has ANY
# semver prerelease part (v1.0.0-dev.1, -pre, -rc.1, ...), else 1. Release CI
# uses it to flag the GitHub release as a prerelease (the daemon updater and
# install.sh's /releases/latest both follow that flag).
set -euo pipefail

if [ "${1:-}" = "--is-prerelease" ]; then
  [ $# -eq 2 ] || { echo "usage: $0 --is-prerelease <tag>" >&2; exit 2; }
  printf '%s' "$2" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.+-]+$'
  exit $?
fi

ref="${GITHUB_REF:?GITHUB_REF not set}"
tag="${INPUT_TAG:-}"
if [ -z "$tag" ]; then
  case "$ref" in
    refs/tags/*) tag="${ref#refs/tags/}" ;;
    *) echo "error: run on $ref is not a tag and no tag input was given" >&2; exit 1 ;;
  esac
fi
printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$' \
  || { echo "error: invalid release tag '$tag'" >&2; exit 1; }
if [ "$ref" != "refs/tags/$tag" ]; then
  echo "error: release $tag must run ON its tag (got $ref); use: gh workflow run release.yml --ref $tag -f tag=$tag" >&2
  exit 1
fi
printf '%s\n' "$tag"

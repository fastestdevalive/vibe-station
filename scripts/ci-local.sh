#!/usr/bin/env bash
# ci-local.sh — run the repo's CI locally, in Docker (Linux, like GitHub's ubuntu runner).
#
#   scripts/ci-local.sh                 # current working tree
#   scripts/ci-local.sh --rev <sha>     # that exact commit in a clean checkout (the pre-push hook)
#   scripts/ci-local.sh --native        # on the host instead of Docker (e.g. macOS-specific failures)
#   scripts/ci-local.sh --release       # also `cargo build --release` for the daemon/CLI
#   scripts/ci-local.sh --only rust|web # just one half
#
# Env: VST_CI_SLOTS (default 2) max concurrent Docker runs across worktrees;
#      VST_CI_CARGO_JOBS (default 3) cargo parallelism — linking test binaries OOMs Docker's ~8GB VM at higher values;
#      VST_CI_WAIT_MAX seconds to wait for a slot (default: forever).
# The steps themselves live in scripts/ci-steps.sh (shared by Docker and --native).
set -euo pipefail

TOP="$(git rev-parse --show-toplevel)"
cd "$TOP"

NATIVE=0; REV=""; STEPS="rust web"
while [ $# -gt 0 ]; do
  case "$1" in
    --native) NATIVE=1 ;;
    --rev) REV="${2:?--rev needs a commit}"; shift ;;
    --release) STEPS="$STEPS release" ;;
    --only) STEPS="${2:?--only needs rust|web}"; shift ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

SRC="$TOP"; TMP_WT=""; SLOT_DIR=""
IMG=""
cleanup() {
  [ -n "$SLOT_DIR" ] && rm -rf "$SLOT_DIR"
  if [ -n "$TMP_WT" ]; then
    # Docker creates the volume mount points inside the checkout as root; remove
    # them from inside a container, or the host can't delete the directory.
    if [ -n "$IMG" ]; then
      docker run --rm --user root -v "$TMP_WT":/w "$IMG" rm -rf /w/node_modules /w/web-ui/node_modules /w/desktop/node_modules /w/rust/target >/dev/null 2>&1 || true
    fi
    git -C "$TOP" worktree remove --force "$TMP_WT" >/dev/null 2>&1 || rm -rf "$TMP_WT" || true
    git -C "$TOP" worktree prune >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# --rev: test exactly that commit (a force-pushed/amended commit, not whatever is
# in the working tree) in a throwaway detached checkout.
if [ -n "$REV" ]; then
  TMP_WT="$(mktemp -d "${TMPDIR:-/tmp}/vst-ci-src.XXXXXX")"
  git worktree add --detach "$TMP_WT" "$REV" >/dev/null
  SRC="$TMP_WT"
elif ! git diff --quiet HEAD 2>/dev/null; then
  echo "note: working tree has uncommitted changes — testing them as-is" >&2
fi

if [ "$NATIVE" = 1 ]; then
  CI_STEPS="$STEPS" exec "$SRC/scripts/ci-steps.sh"
fi

command -v docker >/dev/null && docker info >/dev/null 2>&1 || {
  echo "ci-local: Docker isn't running. Start it, or skip this check (VST_SKIP_CI=1 / git push --no-verify)." >&2
  exit 1
}

# --- concurrency: at most VST_CI_SLOTS runs at once, across all worktrees ------
SLOTS="${VST_CI_SLOTS:-2}"; WAIT_MAX="${VST_CI_WAIT_MAX:-0}"; LOCKS="${TMPDIR:-/tmp}/vst-ci-locks"
mkdir -p "$LOCKS"; waited=0; announced=0
while :; do
  for i in $(seq 1 "$SLOTS"); do
    d="$LOCKS/slot$i"
    if mkdir "$d" 2>/dev/null; then echo $$ > "$d/pid"; SLOT_DIR="$d"; break 2; fi
    pid="$(cat "$d/pid" 2>/dev/null || true)"   # reclaim a slot whose owner died
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$d"; fi
  done
  [ "$announced" = 0 ] && { echo "ci-local: waiting for a CI slot ($SLOTS running)…" >&2; announced=1; }
  sleep 5; waited=$((waited + 5))
  [ "$WAIT_MAX" -gt 0 ] && [ "$waited" -ge "$WAIT_MAX" ] && { echo "ci-local: gave up waiting for a slot" >&2; exit 1; }
done

# --- image (built once from stdin; no build context) ---------------------------
IMG="vst-ci:$(shasum Dockerfile.ci | cut -c1-12)"
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "ci-local: building $IMG (first run only — installs cargo-deny, takes a few minutes)…" >&2
  docker build -t "$IMG" - < Dockerfile.ci
fi

# Per-worktree volumes so parallel worktrees never share a target/ or node_modules;
# only the cargo download cache + rustup toolchains are shared (cargo locks itself).
# A linked worktree's .git is a file pointing at the main repo's .git dir (a host path):
# mount that dir read-only at the same path so git works inside the container.
GITCOMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
KEY="$(basename "$TOP" | tr -c 'A-Za-z0-9_.-\n' '_')-$(printf '%s' "$TOP" | shasum | cut -c1-6)"
docker run --rm -t \
  --name "vst-ci-$KEY-$$" \
  -v "$SRC":/work \
  -v "$GITCOMMON":"$GITCOMMON":ro -e GIT_OPTIONAL_LOCKS=0 \
  -v vst-ci-cargo-registry:/usr/local/cargo/registry \
  -v vst-ci-rustup:/usr/local/rustup \
  -v "vst-ci-target-$KEY":/work/rust/target \
  -v "vst-ci-nm-root-$KEY":/work/node_modules \
  -v "vst-ci-nm-web-$KEY":/work/web-ui/node_modules \
  -v "vst-ci-nm-desktop-$KEY":/work/desktop/node_modules \
  -v vst-ci-pnpm-store:/home/ci/.local/share/pnpm \
  -e CI_STEPS="$STEPS" -e CARGO_TERM_COLOR=always \
  -e CARGO_BUILD_JOBS="${VST_CI_CARGO_JOBS:-3}" -e CARGO_INCREMENTAL=0 \
  -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_PROFILE_TEST_DEBUG=0 \
  "$IMG" scripts/ci-steps.sh

#!/usr/bin/env bash
# dev-sandbox.sh — run docker-compose.dev.yml with a per-worktree compose
# project name, host port, and volume pair, so multiple worktrees' sandboxes
# can run concurrently without colliding.
#
# Why this exists: docker-compose.dev.yml on its own binds a fixed host port
# (5174) and two fixed-named volumes (vst-dev-data, vst-dev-projects) — fine
# for one sandbox, but a second `docker compose ... up` for a different
# worktree either fails to bind the port or, worse, silently mounts the SAME
# volumes as the first (deleting its daemon lock file and redirecting a
# second daemon at the first sandbox's state — see the
# "dev-sandbox-volumes-are-shared" project memory note). This script sets
# VST_SANDBOX_PORT / VST_SANDBOX_DATA_VOLUME / VST_SANDBOX_PROJECTS_VOLUME
# (consumed by docker-compose.dev.yml's `${VAR:-default}` interpolation) plus
# a `-p <worktree-name>` compose project name, so each worktree gets its own
# isolated everything.
#
# Usage:
#   scripts/dev-sandbox.sh up [worktree-name] --port=N [--seed=file-search|demo]
#   scripts/dev-sandbox.sh down [worktree-name]
#   scripts/dev-sandbox.sh logs [worktree-name]
#
# worktree-name defaults to the current directory's basename (i.e. run this
# from inside the worktree checkout you want a sandbox for — matches how
# `vst worktree create` names worktree checkout directories).
# --port=N is REQUIRED on `up` and must be in 7100-7199. This range sits
# above X11 TCP (6000+display, which auto-allocates into 6100+ with xpra)
# and is clear of Vite (5173/5174) and all standard IANA well-known services.
# Each concurrent worktree sandbox must use a distinct port in this range.
# --seed defaults to "demo" — the realistic 3-project/9-worktree/14-session
# dataset (scripts/demo-seed.sh) — so every sandbox has actual worktrees/
# agent sessions to test against out of the box, still with hot-reload and
# VST_NO_AUTH, unlike docker-compose.screenshots.yml. Pass --seed=file-search
# for a fast, empty single-project tree instead.

set -euo pipefail

cd "$(dirname "$0")/.."

# --seed=<mode> and --port=N can appear anywhere in argv; strip them out
# first so the remaining positional args parse cleanly. --seed defaults to an
# inherited VST_SEED_MODE, falling back to "demo". --port defaults to an
# inherited VST_SANDBOX_PORT (so agents/CI can set it via env without
# repeating it on every call), with no further fallback — it is required.
SEED_MODE="${VST_SEED_MODE:-demo}"
PORT="${VST_SANDBOX_PORT:-}"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --seed=*) SEED_MODE="${arg#--seed=}" ;;
    --port=*) PORT="${arg#--port=}" ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

case "$SEED_MODE" in
  file-search|demo) ;;
  *)
    echo "Unknown --seed mode '$SEED_MODE' — expected 'file-search' or 'demo'." >&2
    exit 1
    ;;
esac

CMD="${1:-}"
WORKTREE="${2:-$(basename "$PWD")}"

if [ -z "$CMD" ]; then
  echo "Usage: $0 {up|down|logs} [worktree-name] --port=N [--seed=file-search|demo]" >&2
  exit 1
fi

validate_port() {
  local p="$1"
  # Reject non-numeric (including leading zeros which cause octal surprises),
  # then check the numeric range.
  if ! [[ "$p" =~ ^[1-9][0-9]*$ ]] || [ "$p" -lt 7100 ] || [ "$p" -gt 7199 ]; then
    echo "error: --port must be in 7100-7199 (got: '$p')." >&2
    echo "       Pick a free port in that range; each concurrent worktree needs a distinct one." >&2
    echo "       Run: docker ps --format '{{.Names}} {{.Ports}}' to see what is already bound." >&2
    exit 1
  fi
}

case "$CMD" in
  up)
    if [ -z "$PORT" ]; then
      echo "error: --port=N is required for 'up'." >&2
      echo "       Usage: $0 up [$WORKTREE] --port=N  (N must be in 7100-7199)" >&2
      echo "       Or set VST_SANDBOX_PORT=N in the environment." >&2
      exit 1
    fi
    validate_port "$PORT"

    running="$(docker ps --format '{{.Names}}' | grep -- '-vst-dev-1$' || true)"
    if [ -n "$running" ]; then
      echo "Other vst-dev sandboxes already running (isolated by this script's per-worktree naming, listed for awareness):"
      echo "$running" | sed 's/^/  /'
    fi

    export VST_SANDBOX_PORT="$PORT"
    export VST_SANDBOX_DATA_VOLUME="vst-dev-data-${WORKTREE}"
    export VST_SANDBOX_PROJECTS_VOLUME="vst-dev-projects-${WORKTREE}"
    export VST_SEED_MODE="$SEED_MODE"

    echo "Starting sandbox '$WORKTREE' on http://localhost:${PORT} (volumes: ${VST_SANDBOX_DATA_VOLUME}, ${VST_SANDBOX_PROJECTS_VOLUME}, seed: ${SEED_MODE})"
    # demo-seed.sh and seed-file-search-demo.sh guard themselves
    # independently (a $VST/.seeded marker vs. a project-registration check)
    # — neither knows about the other, so switching --seed on a worktree-name
    # whose volume was already seeded in the OTHER mode does not cleanly
    # swap datasets; it merges/corrupts them (see AGENTS.md's "Docker dev
    # sandboxes" section for specifics). Start with a fresh worktree-name (or
    # `docker volume rm "$VST_SANDBOX_DATA_VOLUME" "$VST_SANDBOX_PROJECTS_VOLUME"`)
    # to actually change an existing sandbox's seed mode.
    docker compose -f docker-compose.dev.yml -p "$WORKTREE" up --build -d
    echo "Up: http://localhost:${PORT}"
    ;;

  down)
    # Volume env vars aren't needed to tear down (compose resolves the
    # already-created project's containers/networks by project name alone),
    # but are set anyway so a `down` run right after `up` in the same shell
    # is a no-op diff against the compose config that created them.
    export VST_SANDBOX_DATA_VOLUME="vst-dev-data-${WORKTREE}"
    export VST_SANDBOX_PROJECTS_VOLUME="vst-dev-projects-${WORKTREE}"
    docker compose -f docker-compose.dev.yml -p "$WORKTREE" down
    echo "Stopped sandbox '$WORKTREE'. Volumes ${VST_SANDBOX_DATA_VOLUME}/${VST_SANDBOX_PROJECTS_VOLUME} were left intact (never 'down -v' — that would delete this worktree's seeded daemon state/projects)."
    ;;

  logs)
    docker compose -f docker-compose.dev.yml -p "$WORKTREE" logs -f
    ;;

  *)
    echo "Unknown command '$CMD'. Usage: $0 {up|down|logs} [worktree-name]" >&2
    exit 1
    ;;
esac

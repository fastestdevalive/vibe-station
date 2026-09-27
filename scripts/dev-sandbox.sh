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

# Ensure cargo is on PATH (not always set in GUI/shell-launched envs).
# shellcheck source=/dev/null
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

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

    # Claude auth for the sandbox: a long-lived token from `claude setup-token`
    # (run once on the host, then save the printed token to the file below,
    # mode 600). Copying the host's ~/.claude/.credentials.json instead (the
    # fallback) shares one rotating OAuth grant between host and sandbox, and
    # breaks within hours — see the claude block in scripts/dev-entrypoint.sh.
    CLAUDE_TOKEN_FILE="${VST_CLAUDE_TOKEN_FILE:-$HOME/.config/vibe-station/claude-oauth-token}"
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -s "$CLAUDE_TOKEN_FILE" ]; then
      CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$CLAUDE_TOKEN_FILE")"
      export CLAUDE_CODE_OAUTH_TOKEN
    fi
    if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo "    claude: long-lived token (CLAUDE_CODE_OAUTH_TOKEN)"
    else
      echo "    claude: WARNING — no long-lived token; the sandbox will use a copy of your"
      echo "            host credentials that stops working at the next token refresh."
      echo "            Fix: run 'claude setup-token', save the token to $CLAUDE_TOKEN_FILE"
      echo "            (chmod 600), then re-run this command."
    fi

    echo "Starting sandbox '$WORKTREE' on http://localhost:${PORT} (volumes: ${VST_SANDBOX_DATA_VOLUME}, ${VST_SANDBOX_PROJECTS_VOLUME}, seed: ${SEED_MODE})"
    # The dev sandbox mounts host Rust binaries (vst-daemon, vst) read-only into
    # dev.Dockerfile's node:24-slim (Debian bookworm, glibc 2.36) container.
    #
    # IMPORTANT — do NOT add a fallback to `./rust/target/{release,debug}/...`
    # (a plain host `cargo build` output) here. That used to be the fallback,
    # and it silently produces a binary linked against the HOST's glibc, which
    # is newer than bookworm's on any host that isn't itself Debian
    # bookworm-based (e.g. Ubuntu 24.04 ships glibc 2.39) — the daemon then
    # fails at container boot with `GLIBC_2.39 not found`, invisible until
    # someone actually starts the sandbox (see BLOCKED.md's writeup / the
    # "dev-sandbox-glibc" project memory note for the multi-hour debugging
    # history this caused). `./rust/target-docker/` exists specifically to
    # never be a host-glibc binary — every binary that lands there is built
    # INSIDE a container matching bookworm's glibc, below.
    if [ -n "${VST_RUST_DAEMON_BIN:-}" ] && [ -x "$VST_RUST_DAEMON_BIN" ]; then
      RUST_DAEMON_BIN="$VST_RUST_DAEMON_BIN"
    elif [ -x "./rust/target-docker/release/vst-daemon" ]; then
      RUST_DAEMON_BIN="./rust/target-docker/release/vst-daemon"
    elif [ -x "./rust/target-docker/debug/vst-daemon" ]; then
      RUST_DAEMON_BIN="./rust/target-docker/debug/vst-daemon"
    else
      RUST_DAEMON_BIN=""
    fi

    if [ -n "${VST_RUST_CLI_BIN:-}" ] && [ -x "$VST_RUST_CLI_BIN" ]; then
      RUST_CLI_BIN="$VST_RUST_CLI_BIN"
    elif [ -x "./rust/target-docker/release/vst" ]; then
      RUST_CLI_BIN="./rust/target-docker/release/vst"
    elif [ -x "./rust/target-docker/debug/vst" ]; then
      RUST_CLI_BIN="./rust/target-docker/debug/vst"
    else
      RUST_CLI_BIN=""
    fi

    # No usable target-docker binary → build ONE fresh, inside a container
    # pinned to the exact toolchain (rust/rust-toolchain.toml) on a bookworm
    # base (matching dev.Dockerfile's node:24-slim), never on the host. The
    # cargo registry cache volume is intentionally NOT per-worktree (unlike
    # the sandbox's own data/projects volumes) — it only caches downloaded
    # crate sources, which are safe and desirable to share across worktrees.
    if [ -z "$RUST_DAEMON_BIN" ] || [ -z "$RUST_CLI_BIN" ]; then
      RUST_TOOLCHAIN_CHANNEL="$(sed -nE 's/^channel = "([^"]+)".*/\1/p' rust/rust-toolchain.toml | head -1)"
      if [ -z "$RUST_TOOLCHAIN_CHANNEL" ]; then
        echo "error: could not read [toolchain].channel from rust/rust-toolchain.toml" >&2
        exit 1
      fi
      echo "No target-docker Rust binaries found. Building them inside rust:${RUST_TOOLCHAIN_CHANNEL}-bookworm"
      echo "(matches dev.Dockerfile's glibc — this is the ONLY supported build path, see the"
      echo "comment above) ... this build is cached (target-docker/build + the registry volume),"
      echo "so this cost is paid once per host, not on every 'up' — but it does NOT auto-invalidate"
      echo "when the Rust workspace changes; delete rust/target-docker/ to force a rebuild."
      # CARGO_TARGET_DIR points OUTSIDE the bind-mounted rust/ tree's default
      # `target/` (into target-docker/build instead) — the container runs as
      # root, so writing into ./rust/target/ would leave root-owned files
      # there that a later HOST `cargo build`/`cargo clean` in this checkout
      # can't remove without sudo. The trailing `chown` hands the whole
      # target-docker/ tree back to the host UID/GID before the container
      # exits, so the copied binaries (and the build cache for next time)
      # are normal user-owned files.
      docker run --rm \
        -v "$(pwd)/rust:/work" -w /work \
        -e CARGO_TARGET_DIR=/work/target-docker/build \
        -v vst-dev-sandbox-cargo-registry:/usr/local/cargo/registry \
        "rust:${RUST_TOOLCHAIN_CHANNEL}-bookworm" \
        sh -c "cargo build --release -p vst-daemon -p vst-cli && chown -R $(id -u):$(id -g) /work/target-docker"
      mkdir -p ./rust/target-docker/release
      cp ./rust/target-docker/build/release/vst-daemon ./rust/target-docker/build/release/vst ./rust/target-docker/release/
      RUST_DAEMON_BIN="./rust/target-docker/release/vst-daemon"
      RUST_CLI_BIN="./rust/target-docker/release/vst"
    fi

    if [ ! -x "$RUST_DAEMON_BIN" ] || [ ! -x "$RUST_CLI_BIN" ]; then
      echo "error: expected Rust binaries at $RUST_DAEMON_BIN and $RUST_CLI_BIN." >&2
      exit 1
    fi

    # The dev sandbox mounts the host agy-acp adapter binary into the container
    # (docker-compose.dev.yml binds ${VST_AGY_ACP_BIN:-...} → /usr/local/bin/agy-acp).
    # If the host never built it, that bind mount silently points at an empty
    # directory and agy Rich Chat fails before ACP's initialize handshake — so
    # build it via the shared script unless it already exists and is executable.
    if [ ! -x "./rust/target/agy-acp/release/agy-acp" ]; then
      echo "Host agy-acp binary not found. Building it via scripts/build-agy-acp.sh..."
      bash scripts/build-agy-acp.sh
    fi

    if [ ! -x "./rust/target/agy-acp/release/agy-acp" ]; then
      echo "error: expected agy-acp binary at ./rust/target/agy-acp/release/agy-acp." >&2
      exit 1
    fi

    export VST_RUST_DAEMON_BIN="$RUST_DAEMON_BIN"
    export VST_RUST_CLI_BIN="$RUST_CLI_BIN"
    export VST_AGY_ACP_BIN="./rust/target/agy-acp/release/agy-acp"
    echo "    daemon: RUST ($RUST_DAEMON_BIN)"
    echo "    cli:    RUST ($RUST_CLI_BIN)"
    echo "    agy-acp: RUST ($VST_AGY_ACP_BIN)"
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

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

# Every harness binary is installed in the image (dev.Dockerfile), so the base
# compose file serves Linux and macOS hosts alike. On top of it, `up` layers a
# host-specific overlay picked by `uname -s` (VST_SANDBOX_OS overrides it, for
# testing):
#   Linux   write_linux_hostbins_overlay below bind-mounts the HOST's own opencode/
#           agy/codex/cursor-agent installs (same OS as the container), so you run
#           your versions; each is mounted only if the host path exists — a missing
#           bind source would otherwise become an empty dir shadowing the image's
#           copy. Anything absent falls back to the image's pinned build.
#   Darwin  nothing mounted (a Mac's binaries are Mach-O → ENOEXEC); login hints
#           and the claude setup-token offer below instead.
HOST_OS="${VST_SANDBOX_OS:-$(uname -s)}"
COMPOSE_ARGS=(-f docker-compose.dev.yml)

# Print a compose overlay mounting the host harness installs that exist, at
# /opt/host-bins/* (scripts/dev-entrypoint.sh symlinks each into /usr/local/bin
# only if the expected file is there). Paths override: OPENCODE_BIN, AGY_BIN,
# CODEX_PLATFORM_DIR, CURSOR_AGENT_VERSIONS.
write_linux_hostbins_overlay() {
  local opencode="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
  local agy="${AGY_BIN:-$HOME/.local/bin/agy}"
  local cursor="${CURSOR_AGENT_VERSIONS:-$HOME/.local/share/cursor-agent/versions}"
  # codex: the real binary is the static ELF inside the platform npm package's
  # vendor dir (with codex-resources/ siblings), NOT the Node.js launcher.
  local codex="${CODEX_PLATFORM_DIR:-}" npm_root d
  if [ -z "$codex" ]; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    for d in "$npm_root"/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*; do
      [ -n "$npm_root" ] && [ -f "$d/bin/codex" ] && codex="$d" && break
    done
  fi
  local mounts=()
  [ -f "$opencode" ] && mounts+=("$opencode:/opt/host-bins/opencode")
  [ -f "$agy" ] && mounts+=("$agy:/opt/host-bins/agy")
  [ -n "$codex" ] && [ -f "$codex/bin/codex" ] && mounts+=("$codex:/opt/host-bins/codex-platform")
  # cursor-agent's launcher needs its bundled node + chunk files beside its
  # realpath, so mount the whole versions/ dir (see dev-entrypoint.sh).
  [ -d "$cursor" ] && mounts+=("$cursor:/opt/host-bins/cursor-agent-versions")
  echo "# Generated by scripts/dev-sandbox.sh (Linux host) — host harness binaries."
  echo "services:"
  echo "  vst-dev:"
  if [ "${#mounts[@]}" -eq 0 ]; then echo "    {}"; return; fi
  echo "    volumes:"
  local m q
  for m in "${mounts[@]}"; do
    # YAML single-quoted; `$` doubled so compose doesn't interpolate the path.
    q="${m//\'/\'\'}"; q="${q//\$/\$\$}"
    echo "      - '${q}:ro'"
  done
}

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
    # No token, and no host login the sandbox could fall back to (macOS: always,
    # it's in the Keychain; Linux: no .credentials.json)? On a TTY, offer to mint
    # one with the image's own claude, then save it (0600). Default N; no TTY = skip.
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -t 0 ] && [ -t 1 ] \
       && { [ "$HOST_OS" = "Darwin" ] || [ ! -s "${CLAUDE_HOME:-$HOME/.claude}/.credentials.json" ]; }; then
      reply=""
      read -r -p "    claude: no long-lived token. Run 'claude setup-token' in the sandbox image now (browser sign-in, then paste the token)? [y/N] " reply || true
      if [[ "$reply" =~ ^[Yy]$ ]]; then
        docker compose "${COMPOSE_ARGS[@]}" -p "$WORKTREE" build vst-dev
        docker run -it --rm -u vst "${WORKTREE}-vst-dev" claude setup-token || true
        token=""
        read -r -s -p "    Paste the token printed above (input hidden; empty = skip): " token || true
        echo
        token="$(printf '%s' "$token" | tr -d '[:space:]')"
        if [ -n "$token" ]; then
          (umask 077; mkdir -p "$(dirname "$CLAUDE_TOKEN_FILE")"; printf '%s\n' "$token" > "$CLAUDE_TOKEN_FILE")
          chmod 600 "$CLAUDE_TOKEN_FILE"
          export CLAUDE_CODE_OAUTH_TOKEN="$token"
          echo "    claude: token saved to $CLAUDE_TOKEN_FILE (mode 600)"
        fi
        unset token
      fi
    fi
    if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo "    claude: long-lived token (CLAUDE_CODE_OAUTH_TOKEN)"
    elif [ "$HOST_OS" = "Darwin" ]; then
      echo "    claude: WARNING — no long-lived token, and on macOS your login lives in the" >&2
      echo "            Keychain (not ~/.claude/.credentials.json), so claude in the sandbox will be" >&2
      echo "            signed out (the sandbox still starts). On macOS run 'claude setup-token', save the token to" >&2
      echo "            $CLAUDE_TOKEN_FILE (chmod 600), then re-run this command." >&2
    else
      echo "    claude: WARNING — no long-lived token; the sandbox will use a copy of your"
      echo "            host credentials that stops working at the next token refresh."
      echo "            Fix: run 'claude setup-token', save the token to $CLAUDE_TOKEN_FILE"
      echo "            (chmod 600), then re-run this command."
    fi

    if [ "$HOST_OS" = "Linux" ]; then
      HOSTBINS_OVERLAY="$(mktemp "${TMPDIR:-/tmp}/vst-dev-linux.XXXXXX")"
      trap 'rm -f "$HOSTBINS_OVERLAY"' EXIT
      write_linux_hostbins_overlay > "$HOSTBINS_OVERLAY"
      COMPOSE_ARGS+=(-f "$HOSTBINS_OVERLAY")
      echo "    Linux host: host harness binaries mounted (others run from the image):"
      grep -o "/opt/host-bins/[a-z-]*" "$HOSTBINS_OVERLAY" | sed 's|^/opt/host-bins/|            |' || echo "            (none found)"
    fi
    if [ "$HOST_OS" = "Darwin" ]; then
      # cursor-agent and agy keep a macOS login in the Keychain, which the
      # container can't (and mustn't) read. Their in-container login persists in
      # this worktree's data volume (scripts/dev-entrypoint.sh), so it's one-time.
      echo "    macOS host: every harness runs from the image. cursor-agent/agy logins live in your Keychain, so sign in once INSIDE the sandbox:"
      echo "            docker exec -it -u vst ${WORKTREE}-vst-dev-1 cursor-agent login   (or export CURSOR_API_KEY before 'up')"
      echo "            docker exec -it -u vst ${WORKTREE}-vst-dev-1 agy                  (follow the printed URL, paste the code back)"
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
    #
    # DEBUG, not --release: this is a dev sandbox for iteration speed, not a
    # release-fidelity check (that's what docker-compose.screenshots.yml /
    # the actual release CI are for). `--release`'s optimization passes are
    # the dominant cost of a Rust rebuild — a debug build after a small
    # source change is typically several times faster to compile, at the
    # cost of a slower-at-runtime binary that's a non-issue for manual
    # clicking-around testing. If you specifically need to profile
    # performance, override VST_RUST_DAEMON_BIN/VST_RUST_CLI_BIN with your
    # own release build instead of changing this default.
    #
    # ALWAYS (re)build via cargo unless both binaries are explicitly overridden
    # via VST_RUST_DAEMON_BIN / VST_RUST_CLI_BIN. This used to build only when
    # no target-docker binary existed yet, and reuse whatever was there
    # otherwise — so once built, the sandbox kept mounting that first binary
    # forever, silently ignoring every later Rust change (e.g. removed doctor
    # checks kept showing up after `up --build`). cargo's own incremental
    # build (cached in target-docker/build + the registry volume) is the
    # freshness check: a no-op rebuild takes seconds, a real change rebuilds
    # only what changed.
    RUST_TOOLCHAIN_CHANNEL="$(sed -nE 's/^channel = "([^"]+)".*/\1/p' rust/rust-toolchain.toml | head -1)"
    if [ -z "$RUST_TOOLCHAIN_CHANNEL" ]; then
      echo "error: could not read [toolchain].channel from rust/rust-toolchain.toml" >&2
      exit 1
    fi
    if [ -n "${VST_RUST_DAEMON_BIN:-}" ] && [ -x "$VST_RUST_DAEMON_BIN" ] \
       && [ -n "${VST_RUST_CLI_BIN:-}" ] && [ -x "$VST_RUST_CLI_BIN" ]; then
      RUST_DAEMON_BIN="$VST_RUST_DAEMON_BIN"
      RUST_CLI_BIN="$VST_RUST_CLI_BIN"
      echo "    rust: using VST_RUST_DAEMON_BIN/VST_RUST_CLI_BIN overrides (no rebuild)"
    else
      # Build inside a container pinned to the exact toolchain
      # (rust/rust-toolchain.toml) on a bookworm base (matching
      # dev.Dockerfile's node:24-slim), never on the host. The cargo registry
      # cache volume is intentionally NOT per-worktree (unlike the sandbox's
      # own data/projects volumes) — it only caches downloaded crate sources,
      # which are safe and desirable to share across worktrees.
      echo "Building Rust binaries (incremental, debug) inside rust:${RUST_TOOLCHAIN_CHANNEL}-bookworm"
      echo "(matches dev.Dockerfile's glibc — this is the ONLY supported build path, see the"
      echo "comment above). Cached in rust/target-docker/build, so an unchanged tree is a no-op."
      # CARGO_TARGET_DIR points OUTSIDE the bind-mounted rust/ tree's default
      # `target/` (into target-docker/build instead) — the container runs as
      # root, so writing into ./rust/target/ would leave root-owned files
      # there that a later HOST `cargo build`/`cargo clean` in this checkout
      # can't remove without sudo. The trailing `chown` hands the whole
      # target-docker/ tree back to the host UID/GID before the container
      # exits, so the copied binaries (and the build cache for next time)
      # are normal user-owned files.
      #
      # The whole repo is mounted at /repo (build cwd /repo/rust) — not just
      # rust/ — because the daemon embeds skill/SKILL.md via include_str! and
      # needs the repo root on hand to compile.
      docker run --rm \
        -v "$(pwd):/repo" -w /repo/rust \
        -e CARGO_TARGET_DIR=/repo/rust/target-docker/build \
        -v vst-dev-sandbox-cargo-registry:/usr/local/cargo/registry \
        "rust:${RUST_TOOLCHAIN_CHANNEL}-bookworm" \
        sh -c "cargo build -p vst-daemon -p vst-cli --features vst-daemon/insecure-no-auth,vst-cli/insecure-no-auth && chown -R $(id -u):$(id -g) /repo/rust/target-docker"
      mkdir -p ./rust/target-docker/debug
      # Atomic replace (cp to temp + mv), not an in-place overwrite: the old
      # binary may be the running daemon's executable (in-place write fails
      # with ETXTBSY). The single-file bind mount pins the OLD inode, which is
      # why `up` below uses --force-recreate.
      for bin in vst-daemon vst; do
        cp "./rust/target-docker/build/debug/$bin" "./rust/target-docker/debug/.$bin.new"
        mv -f "./rust/target-docker/debug/.$bin.new" "./rust/target-docker/debug/$bin"
      done
      RUST_DAEMON_BIN="./rust/target-docker/debug/vst-daemon"
      RUST_CLI_BIN="./rust/target-docker/debug/vst"
    fi

    if [ ! -x "$RUST_DAEMON_BIN" ] || [ ! -x "$RUST_CLI_BIN" ]; then
      echo "error: expected Rust binaries at $RUST_DAEMON_BIN and $RUST_CLI_BIN." >&2
      exit 1
    fi

    export VST_RUST_DAEMON_BIN="$RUST_DAEMON_BIN"
    export VST_RUST_CLI_BIN="$RUST_CLI_BIN"
    echo "    daemon: RUST ($RUST_DAEMON_BIN)"
    echo "    cli:    RUST ($RUST_CLI_BIN)"
    # demo-seed.sh and seed-file-search-demo.sh guard themselves
    # independently (a $VST/.seeded marker vs. a project-registration check)
    # — neither knows about the other, so switching --seed on a worktree-name
    # whose volume was already seeded in the OTHER mode does not cleanly
    # swap datasets; it merges/corrupts them (see AGENTS.md's "Docker dev
    # sandboxes" section for specifics). Start with a fresh worktree-name (or
    # `docker volume rm "$VST_SANDBOX_DATA_VOLUME" "$VST_SANDBOX_PROJECTS_VOLUME"`)
    # to actually change an existing sandbox's seed mode.
    # --force-recreate: the Rust binaries are single-file bind mounts, which
    # pin the inode at container-create time. A rebuilt binary is a NEW inode,
    # so without recreating, a still-running container (compose sees no config
    # change) keeps executing the stale daemon. Volumes persist across recreate.
    # A missing bind-mount source is created by Docker as root; create the omp seed dir
    # ourselves so a later host `omp` login does not hit EACCES.
    mkdir -p "${OMP_AGENT_HOME:-$HOME/.omp/agent}"
    docker compose "${COMPOSE_ARGS[@]}" -p "$WORKTREE" up --build --force-recreate -d
    echo "Up: http://localhost:${PORT}"
    ;;

  down)
    # Volume env vars aren't needed to tear down (compose resolves the
    # already-created project's containers/networks by project name alone),
    # but are set anyway so a `down` run right after `up` in the same shell
    # is a no-op diff against the compose config that created them.
    export VST_SANDBOX_DATA_VOLUME="vst-dev-data-${WORKTREE}"
    export VST_SANDBOX_PROJECTS_VOLUME="vst-dev-projects-${WORKTREE}"
    docker compose "${COMPOSE_ARGS[@]}" -p "$WORKTREE" down
    echo "Stopped sandbox '$WORKTREE'. Volumes ${VST_SANDBOX_DATA_VOLUME}/${VST_SANDBOX_PROJECTS_VOLUME} were left intact (never 'down -v' — that would delete this worktree's seeded daemon state/projects)."
    ;;

  logs)
    docker compose "${COMPOSE_ARGS[@]}" -p "$WORKTREE" logs -f
    ;;

  *)
    echo "Unknown command '$CMD'. Usage: $0 {up|down|logs} [worktree-name]" >&2
    exit 1
    ;;
esac

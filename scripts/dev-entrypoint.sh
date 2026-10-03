#!/bin/sh
# Shared startup script for the dev sandbox container. Invoked as PID 1's
# CMD (running as root) by BOTH dev.Dockerfile and docker-compose.dev.yml
# (and any per-worktree copy of it) so the two never drift out of sync —
# previously this logic was duplicated in both places and the Dockerfile's
# copy silently forgot to chown /home/vst/projects, which would leave that
# volume root-owned (and the daemon failing with EACCES on worktree
# creation) for anyone relying on the image's own default CMD instead of
# compose's override.
set -e

# Docker named volumes (and a freshly-created /home/vst/projects) are
# root-owned by default and won't automatically match the non-root "vst"
# user's uid/gid, so chown the mount points before the daemon (running as
# vst) touches them. This runs unconditionally on every start — cheap, and
# it self-heals root-owned files left behind by an older, pre-non-root
# image sharing the same volume (see the "dev-sandbox-volumes-are-shared"
# note next to this compose file's volume definitions).
mkdir -p /home/vst/.vibe-station /home/vst/projects
chown -R vst:vst /home/vst/.vibe-station /home/vst/projects

# Symlink cursor-agent's REAL wrapper script into place from the mounted
# `versions/` directory (see docker-compose.dev.yml's CURSOR_AGENT_VERSIONS
# comment for the full root-cause writeup). cursor-agent's own launcher does
# `realpath "$0"` and expects its bundled `node` binary + numbered chunk
# `.js` files to sit in the SAME directory as itself — a single-file bind
# mount of just the launcher script (the old approach) breaks that: Docker
# resolves a host symlink to its target's CONTENTS at mount time, so the
# container never sees a real path back to those sibling files, and the
# launcher fails with `Cannot find module '.../index.js'`. Mounting the
# whole `versions/` tree read-only and symlinking from INSIDE the container
# preserves the sibling-file relationship the launcher relies on.
if [ -d /opt/cursor-agent-versions ]; then
  # Version dirs are date-prefixed (e.g. `2026.08.25-<sha>`) and sort
  # lexicographically in chronological order — no need to know which one
  # the host's own `~/.local/bin/cursor-agent` symlink currently points at.
  cursor_agent_version_dir="$(find /opt/cursor-agent-versions -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)"
  if [ -n "$cursor_agent_version_dir" ] && [ -f "$cursor_agent_version_dir/cursor-agent" ]; then
    ln -sf "$cursor_agent_version_dir/cursor-agent" /usr/local/bin/cursor-agent
    echo "cursor-agent: symlinked to $cursor_agent_version_dir/cursor-agent"
  else
    echo 'cursor-agent: WARNING — /opt/cursor-agent-versions is mounted but no version dir with a `cursor-agent` launcher was found; cursor-agent will not run' >&2
  fi
fi

# codex — the real binary is a static-pie ELF inside the platform package vendor
# dir, NOT the Node.js launcher script (which needs its 427MB @openai/codex-linux-x64
# optional dep alongside it). The vendor dir also holds codex-resources/ (bwrap,
# voice, zsh) that codex looks for relative to its own path. Mount the whole
# x86_64-unknown-linux-musl/ dir at /opt/codex-platform and symlink bin/codex.
if [ -d /opt/codex-platform ] && [ -f /opt/codex-platform/bin/codex ]; then
  ln -sf /opt/codex-platform/bin/codex /usr/local/bin/codex
  echo "codex: symlinked to /opt/codex-platform/bin/codex"
elif [ -d /opt/codex-platform ]; then
  echo 'codex: WARNING — /opt/codex-platform is mounted but bin/codex not found; codex will not run' >&2
fi

# pi — same sibling-file problem as cursor-agent: cli.js loads ./cli-runtime.js
# at runtime, so a single-file mount breaks it. Mount the whole dist/bundle/
# dir at /opt/pi-bundle and symlink cli.js into /usr/local/bin/pi so the
# loader can resolve siblings relative to the real path.
if [ -d /opt/pi-bundle ] && [ -f /opt/pi-bundle/cli.js ]; then
  ln -sf /opt/pi-bundle/cli.js /usr/local/bin/pi
  echo "pi: symlinked to /opt/pi-bundle/cli.js"
elif [ -d /opt/pi-bundle ]; then
  echo 'pi: WARNING — /opt/pi-bundle is mounted but cli.js not found; pi will not run' >&2
fi

# No stubs for missing CLI binaries: a stub on PATH makes the daemon report the
# CLI as "detected" (it just runs `which`), which is a lie on a machine that
# doesn't have it installed. Only binaries the host actually mounts count.

# Seed a writable ~/<name> dir from a read-only /seed/<name> mount, if one is
# present, skipping any basenames listed in $3 (space-separated) — bulk,
# non-auth-relevant data (old conversation transcripts, multi-hundred-MB
# local databases) that would make every container start slow for no benefit
# inside a throwaway sandbox; only the small config/credential files matter
# here. Plain `docker run` off this image's own CMD (no compose file) won't
# have the /seed mount, so skip cleanly rather than failing. The `.seeded`
# marker is written only AFTER chown, so a kill mid-seed self-heals into a
# full retry next boot rather than leaving a permanently-root-owned dir with
# a marker that falsely claims the seed already succeeded.
seed_writable_home() {
  seed_src="$1"; target="$2"; excludes="$3"
  if [ -d "$seed_src" ] && [ ! -f "$target/.seeded" ]; then
    echo "Seeding writable $target from $seed_src..."
    mkdir -p "$target"
    # `*` alone does NOT match dotfiles in POSIX sh (no dotglob) — claude's
    # actual credential file is `.credentials.json`, a dotfile, so a plain
    # `"$seed_src"/*` glob would silently skip the one file that matters
    # most. `.[!.]*` + `..?*` are the standard POSIX trick to also match
    # dotfiles without matching the literal `.`/`..` entries; any pattern
    # that matches nothing stays as a literal, unexpanded string, which the
    # `[ -e "$item" ]` guard below skips harmlessly.
    for item in "$seed_src"/* "$seed_src"/.[!.]* "$seed_src"/..?*; do
      [ -e "$item" ] || continue
      base="$(basename "$item")"
      skip=0
      for ex in $excludes; do
        if [ "$base" = "$ex" ]; then skip=1; break; fi
      done
      [ "$skip" = 1 ] && continue
      cp -a "$item" "$target/" 2>/dev/null || true
    done
    chown -R vst:vst "$target"
    touch "$target/.seeded"
    chown vst:vst "$target/.seeded"
    echo "Seed complete: $target"
  fi
}

# gemini/agy — writes logs/cache/conversations under
# ~/.gemini/antigravity-cli and fails hard on a read-only mount; the bulky
# `antigravity`/`antigravity-browser-profile` dirs (~1.9G, the desktop IDE +
# its browser profile) are excluded — agy-cli needs neither.
seed_writable_home /seed/gemini /home/vst/.gemini "antigravity antigravity-browser-profile"

# claude — `.credentials.json` (OAuth token) lives directly under `~/.claude`
# alongside gigabytes of past-conversation transcripts (`projects/`) and file
# snapshots (`file-history/`) neither needed for auth nor for a fresh
# sandbox's own conversations, which claude writes to on its own once
# authenticated. `~/.claude.json` (a SIBLING FILE, not inside `~/.claude`)
# carries onboarding/telemetry state claude checks on startup — seeded
# separately since `seed_writable_home` only handles directories.
#
# Auth: a copied `.credentials.json` is a SNAPSHOT of the host's live OAuth
# grant, and Claude rotates refresh tokens on every refresh — whichever side
# (host or sandbox) refreshes first revokes the other's copy. In practice the
# sandbox dies a few hours in with "OAuth session expired and could not be
# refreshed" (and if the sandbox wins the race, the HOST gets logged out
# instead). The fix is a long-lived, non-rotating token from
# `claude setup-token`, passed in as CLAUDE_CODE_OAUTH_TOKEN (see
# scripts/dev-sandbox.sh for where it's read from). When it's set,
# `.credentials.json` is deliberately NOT copied, so the sandbox never holds
# a second copy of the host's rotating grant at all.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # Empty-but-set (compose's `${VAR:-}` default) must not look like a token.
  unset CLAUDE_CODE_OAUTH_TOKEN
  echo "claude: WARNING — CLAUDE_CODE_OAUTH_TOKEN not set; falling back to a copy of the host's ~/.claude/.credentials.json, which stops working the next time either side refreshes its token (typically within hours). Run 'claude setup-token' on the host — see scripts/dev-sandbox.sh." >&2
  seed_writable_home /seed/claude /home/vst/.claude "projects file-history"
  # `.seeded` survives a container restart (~/.claude is container fs, not a
  # volume), so a restart that drops the token after a token-mode boot would
  # skip the seed above and leave NO credentials — copy the file explicitly.
  if [ ! -f /home/vst/.claude/.credentials.json ] && [ -f /seed/claude/.credentials.json ]; then
    cp /seed/claude/.credentials.json /home/vst/.claude/.credentials.json
    chown vst:vst /home/vst/.claude/.credentials.json
  fi
else
  echo "claude: using CLAUDE_CODE_OAUTH_TOKEN (long-lived token; host .credentials.json not copied)"
  export CLAUDE_CODE_OAUTH_TOKEN
  seed_writable_home /seed/claude /home/vst/.claude "projects file-history .credentials.json"
  # A container restart (not recreate) keeps an older seed that may still
  # hold a stale, rotated-out snapshot — drop it so it can't shadow the token.
  rm -f /home/vst/.claude/.credentials.json
fi
if [ -f /seed/claude.json ] && [ ! -f /home/vst/.claude.json ]; then
  cp /seed/claude.json /home/vst/.claude.json 2>/dev/null || true
  chown vst:vst /home/vst/.claude.json 2>/dev/null || true
fi

# cursor — the actual OAuth access/refresh tokens live under
# `~/.config/cursor/auth.json`, NOT `~/.cursor` (verified empirically —
# `~/.cursor` holds CLI session/workspace state: `chats/`, `projects/`,
# `extensions/`, `acp-sessions/`, all excluded here as bulk/non-auth). Small
# CLI preference files (`cli-config.json`, `argv.json`, `mcp.json`) are kept
# since cursor-agent reads them for permission/editor/display settings.
seed_writable_home /seed/cursor-config /home/vst/.config/cursor ""
seed_writable_home /seed/cursor-home /home/vst/.cursor "chats projects extensions acp-sessions sandbox-policies"

# opencode — the credential is `~/.local/share/opencode/auth.json`; that same
# directory also holds `opencode.db` (the CLI's own global session/transcript
# store, routinely 500MB-1GB+) and `snapshot/`/`repos/` working-copy caches,
# none of which a fresh sandbox needs. `~/.config/opencode` (small) carries
# opencode's own config/skills and is kept in full.
seed_writable_home /seed/opencode-data /home/vst/.local/share/opencode "opencode.db opencode.db-shm opencode.db-wal snapshot repos"
seed_writable_home /seed/opencode-config /home/vst/.config/opencode ""

# codex — `auth.json` carries the OPENAI_API_KEY; `config.toml` carries TUI
# prefs. Exclude bulk runtime state: sqlite DBs, sessions/, cache/, tmp/,
# packages/, plugins/, shell_snapshots/, and lock dirs — the sandbox only
# needs auth and config to start a fresh codex session.
seed_writable_home /seed/codex /home/vst/.codex \
  "sessions cache tmp packages plugins shell_snapshots thread-writer-locks tui-thread-reference-capabilities \
   goals_1.sqlite goals_1.sqlite-shm goals_1.sqlite-wal \
   logs_2.sqlite logs_2.sqlite-shm logs_2.sqlite-wal \
   memories_1.sqlite memories_1.sqlite-shm memories_1.sqlite-wal \
   queue_1.sqlite queue_1.sqlite-shm queue_1.sqlite-wal \
   state_5.sqlite state_5.sqlite-shm state_5.sqlite-wal \
   thread_history_1.sqlite thread_history_1.sqlite-shm thread_history_1.sqlite-wal"

# pi — auth.json / models.json / settings.json under ~/.pi/agent. Without them
# `pi --list-models` prints "No models available" and the model picker degrades
# to a free-text field. Session history is excluded.
seed_writable_home /seed/pi-agent /home/vst/.pi/agent "sessions bin"

# codex and pi keep conversation history under ~/.codex and ~/.pi, which are
# re-seeded from scratch whenever the container is recreated. Keep the history in
# the persistent data volume instead, so a sandbox rebuild doesn't turn every
# codex/pi session into one that can no longer be resumed.
persist_cli_sessions() {
  link="$1"; store="$2"
  mkdir -p "$store" "$(dirname "$link")"
  [ -L "$link" ] || { rm -rf "$link"; ln -s "$store" "$link"; }
  chown -R vst:vst "$store" "$(dirname "$link")" 2>/dev/null || true
}
persist_cli_sessions /home/vst/.codex/sessions /home/vst/.vibe-station/cli-sessions/codex
persist_cli_sessions /home/vst/.pi/agent/sessions /home/vst/.vibe-station/cli-sessions/pi


# VST_SEED_MODE selects what gets seeded into this sandbox:
#   demo                  (default) — 3 projects / 9 worktrees / 14 sessions,
#                            the same realistic dataset
#                            docker-compose.screenshots.yml uses, so every
#                            sandbox has worktrees/agents to click into
#                            without an explicit flag.
#   file-search            — one lightweight project only, for when you
#                            explicitly want a fast/empty tree instead
#                            (`--seed=file-search`).
# Either way this sandbox keeps hot-reload + VST_NO_AUTH (no login token) —
# docker-compose.screenshots.yml trades those away for a baked, single-
# instance image, which is the right tradeoff for screenshot capture but not
# for interactive testing.
#
# The two seed scripts have opposite ordering requirements relative to the
# daemon, so this can't be one `case` block run at a single point:
#   - demo-seed.sh (scripts/demo-seed.sh) writes project manifests and tmux
#     sessions DIRECTLY TO DISK, with no daemon API calls at all — it must
#     run BEFORE the daemon starts so the daemon picks the manifests up at
#     boot (this is exactly how Dockerfile.screenshots sequences it). Run it
#     after boot instead and the daemon never sees the new projects, only
#     whatever was already registered/persisted in the volume.
#   - seed-file-search-demo.sh registers its project via live REST calls
#     (`POST /projects` etc.), so it must run AFTER the daemon is up.
#
# `scripts/dev-sandbox.sh` validates VST_SEED_MODE before it ever gets here,
# but this script is also reachable directly (`docker compose -f
# docker-compose.dev.yml up`, or a plain `docker run` off this image), so an
# unrecognized value is called out explicitly rather than silently falling
# through to the demo default — a typo like "Demo" or "file-searchh" should
# be visible in the logs, not produce a quietly-wrong sandbox.
VST_SEED_MODE="${VST_SEED_MODE:-demo}"
case "$VST_SEED_MODE" in
  file-search|demo) ;;
  *)
    echo "[seed] WARNING: unrecognized VST_SEED_MODE='${VST_SEED_MODE}' — expected 'file-search' or 'demo'. Falling back to 'demo'." >&2
    VST_SEED_MODE=demo
    ;;
esac

if [ "$VST_SEED_MODE" = "demo" ]; then
  su vst -c 'bash /app/scripts/demo-seed.sh' || echo '[seed] non-fatal seed error — continuing'
fi

# The Rust CLI is mounted at /usr/local/bin/vst-rust by docker-compose.dev.yml.
# Docker creates an EMPTY DIRECTORY at a bind-mount target when the host source
# is missing, so guard with `-f` (regular file), not `-e`.
if [ -f /usr/local/bin/vst-rust ] && [ -x /usr/local/bin/vst-rust ]; then
  ln -sf /usr/local/bin/vst-rust /usr/local/bin/vst
  echo "[daemon] using Rust vst CLI (/usr/local/bin/vst-rust)"
else
  echo "[daemon] WARNING: /usr/local/bin/vst-rust not found or not executable" >&2
fi

rm -f /home/vst/.vibe-station/.daemon.lock
# Rust daemon — requires web-ui/dist for static SPA serving; the Vite dev
# server covers the browser, and the Rust daemon degrades gracefully (404s)
# if dist isn't built, so VST_DIST_PATH may point at a missing dir.
if [ ! -f /usr/local/bin/vst-daemon-rust ] || [ ! -x /usr/local/bin/vst-daemon-rust ]; then
  echo "[daemon] FATAL: /usr/local/bin/vst-daemon-rust not found or not executable. Ensure 'pnpm build:rust' was run on the host before starting the sandbox." >&2
  exit 1
fi

# Explicit, not relied-on-by-inference: `claude_acp_entry_path()`'s
# walk-upward-from-cwd fallback would likely also find this (cwd is /app,
# this WORKDIR, when `su -c` is invoked from here) but `su -c`'s cwd
# behavior isn't a contract worth depending on silently — pin it directly.
export VST_CLAUDE_ACP_ENTRY=/app/vendor/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js

echo "[daemon] starting Rust daemon (/usr/local/bin/vst-daemon-rust)"
su vst -c "VST_CLAUDE_ACP_ENTRY='$VST_CLAUDE_ACP_ENTRY' VST_NO_AUTH_BIND_ALL=1 /usr/local/bin/vst-daemon-rust" &
echo 'Waiting for daemon...'
timeout=60
while ! curl -sf http://127.0.0.1:7421/health > /dev/null 2>&1; do
  if [ "$timeout" -le 0 ]; then
    echo "[daemon] FATAL: daemon failed to respond to /health within 30s." >&2
    exit 1
  fi
  sleep 0.5
  timeout=$((timeout - 1))
done
echo 'Daemon ready.'

if [ "$VST_SEED_MODE" != "demo" ]; then
  su vst -c 'bash /app/scripts/seed-file-search-demo.sh' || echo '[seed] non-fatal seed error — continuing'
fi

# --pty: without it, `su` starts a new session and the foreground vite dev
# server loses the container's tty (stdin_open/tty are set on the compose
# service), breaking its interactive keyboard shortcuts (h+enter, r, etc.)
# when a developer runs `docker compose up` in the foreground.
su --pty vst -c 'pnpm --filter @vibestation/web dev'

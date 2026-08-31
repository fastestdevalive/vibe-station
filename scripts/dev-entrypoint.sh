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
seed_writable_home /seed/claude /home/vst/.claude "projects file-history"
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

rm -f /home/vst/.vibe-station/.daemon.lock
su vst -c 'node cli/dist/daemon/main.js' &
echo 'Waiting for daemon...'
until curl -sf http://127.0.0.1:7421/health > /dev/null 2>&1; do sleep 0.5; done
echo 'Daemon ready.'

if [ "$VST_SEED_MODE" != "demo" ]; then
  su vst -c 'bash /app/scripts/seed-file-search-demo.sh' || echo '[seed] non-fatal seed error — continuing'
fi

# --pty: without it, `su` starts a new session and the foreground vite dev
# server loses the container's tty (stdin_open/tty are set on the compose
# service), breaking its interactive keyboard shortcuts (h+enter, r, etc.)
# when a developer runs `docker compose up` in the foreground.
su --pty vst -c 'pnpm --filter @vibestation/web dev'

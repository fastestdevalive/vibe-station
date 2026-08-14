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

# Seed a writable ~/.gemini from a read-only /seed/gemini mount, if one is
# present. Plain `docker run` off this image's own CMD (no compose file)
# won't have that mount, so skip cleanly rather than failing.
if [ -d /seed/gemini ] && [ ! -f /home/vst/.gemini/.seeded ]; then
  echo 'Seeding writable ~/.gemini from /seed/gemini (excluding browser profile)...'
  mkdir -p /home/vst/.gemini
  for item in /seed/gemini/*; do
    case "$(basename "$item")" in
      antigravity|antigravity-browser-profile) continue ;;
    esac
    cp -a "$item" /home/vst/.gemini/ 2>/dev/null || true
  done
  # chown BEFORE the .seeded marker is touched: if the container is killed
  # mid-seed, the marker must stay unset so the next start retries the
  # whole seed cleanly, instead of leaving .gemini permanently root-owned
  # with a marker that claims the seed already succeeded.
  chown -R vst:vst /home/vst/.gemini
  touch /home/vst/.gemini/.seeded
  chown vst:vst /home/vst/.gemini/.seeded
  echo 'Seed complete.'
fi

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

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

rm -f /home/vst/.vibe-station/.daemon.lock
su vst -c 'node cli/dist/daemon/main.js' &
echo 'Waiting for daemon...'
until curl -sf http://127.0.0.1:7421/health > /dev/null 2>&1; do sleep 0.5; done
echo 'Daemon ready.'
su vst -c 'bash /app/scripts/seed-file-search-demo.sh' || echo '[seed] non-fatal seed error — continuing'

# --pty: without it, `su` starts a new session and the foreground vite dev
# server loses the container's tty (stdin_open/tty are set on the compose
# service), breaking its interactive keyboard shortcuts (h+enter, r, etc.)
# when a developer runs `docker compose up` in the foreground.
su --pty vst -c 'pnpm --filter @vibestation/web dev'

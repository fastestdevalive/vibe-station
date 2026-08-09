# Dev sandbox for testing vibe-station on a feature branch.
# Runs daemon + Vite dev server in one container.
# Agent CLIs (opencode, cursor-agent, claude) are volume-mounted from the host.
# Gemini can use `scripts/fake-gemini.sh` mounted as `/usr/local/bin/gemini` (see docker-compose.dev.yml).
#
# Usage:
#   docker compose -f docker-compose.dev.yml up --build
#
# Then open http://localhost:5174 in your browser.

FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux git procps curl ripgrep \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.0.0 @google/gemini-cli

WORKDIR /app

# Copy everything — simpler and correct for a dev sandbox
COPY . .

# Install deps + build daemon
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vibestation/cli build

# Daemon data dir — isolated from the host
ENV HOME=/home/vst

# Runtime user: Claude Code hard-refuses to run with
# --dangerously-skip-permissions (which this codebase always passes when
# launching claude sessions) as root, so the daemon — and every agent CLI
# it spawns — MUST run as a non-root user at runtime. Reuse the "node" user
# already present in the base image (uid/gid 1000) rather than creating a
# new one, renaming it to "vst" and moving its home to /home/vst to match
# the paths used throughout this Dockerfile and the compose files.
RUN groupmod -n vst node && usermod -l vst -d /home/vst -m node

# chown the checkout and home dir so the vst user can read/write everything
# it needs at runtime (node_modules, build output, dotfiles). Build steps
# above (apt-get, npm/pnpm install, pnpm build) still run as root — that's
# normal; only the runtime process below needs to not be root.
RUN mkdir -p /home/vst && chown -R vst:vst /home/vst /app

EXPOSE 5173

CMD ["sh", "-c", "\
  mkdir -p /home/vst/.vibe-station && \
  chown -R vst:vst /home/vst/.vibe-station && \
  rm -f /home/vst/.vibe-station/.daemon.lock && \
  su vst -c 'node cli/dist/daemon/main.js' & \
  echo 'Waiting for daemon...' && \
  until curl -sf http://127.0.0.1:7421/health > /dev/null 2>&1; do sleep 0.5; done && \
  echo 'Daemon ready.' && \
  su vst -c 'bash /app/scripts/seed-file-search-demo.sh' || echo '[seed] non-fatal seed error — continuing' ; \
  su vst -c 'pnpm --filter @vibestation/web dev' \
"]

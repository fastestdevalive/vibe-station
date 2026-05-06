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
    tmux git procps curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.0.0

WORKDIR /app

# Copy everything — simpler and correct for a dev sandbox
COPY . .

# Install deps + build daemon
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vibestation/cli build

# Daemon data dir — isolated from the host
ENV HOME=/home/vst
RUN mkdir -p /home/vst

EXPOSE 5173

CMD ["sh", "-c", "\
  rm -f /home/vst/.vibe-station/.daemon.lock && \
  node cli/dist/daemon/main.js & \
  echo 'Waiting for daemon...' && \
  until curl -sf http://127.0.0.1:7421/health > /dev/null 2>&1; do sleep 0.5; done && \
  echo 'Daemon ready.' && \
  pnpm --filter @vibestation/web dev \
"]

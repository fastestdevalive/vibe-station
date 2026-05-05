# Dev sandbox for testing vibe-station on a feature branch.
# Runs daemon + Vite dev server in one container.
# Agent CLIs (opencode, cursor-agent, claude) are volume-mounted from the host
# — only needed for GET /cli-models and session spawning; UI testing works without them.
#
# Usage:
#   docker build -f dev.Dockerfile -t vst-dev .
#   docker-compose -f docker-compose.dev.yml up
#
# Then open http://localhost:5174 in your browser.

FROM node:24-slim

# tmux: needed if you want to test actual session spawning (optional for UI testing)
# git: needed by the daemon for project detection
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    git \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@9.0.0

WORKDIR /app

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/cli/package.json apps/cli/tsconfig.json ./apps/cli/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/tsconfig.app.json apps/web/tsconfig.node.json apps/web/vite.config.ts apps/web/index.html ./apps/web/

# Install all dependencies (frozen lockfile)
RUN pnpm install --frozen-lockfile

# Copy source after install so dependency layer is cached
COPY apps/cli/src ./apps/cli/src
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public

# Build the daemon (TypeScript → dist/)
RUN pnpm --filter @vibestation/cli build

# Daemon data dir — isolated from the host
ENV HOME=/home/vst
RUN mkdir -p /home/vst

# Vite dev server port
EXPOSE 5173

# Start daemon in background, wait for it to be ready, then start Vite
CMD ["sh", "-c", "\
  node apps/cli/dist/daemon/main.js & \
  DAEMON_PID=$! && \
  echo 'Waiting for daemon...' && \
  until curl -sf http://127.0.0.1:7421/health > /dev/null 2>&1; do sleep 0.5; done && \
  echo 'Daemon ready.' && \
  pnpm --filter @vibestation/web dev \
"]

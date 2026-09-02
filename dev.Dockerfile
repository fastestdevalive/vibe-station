# Dev sandbox for testing vibe-station on a feature branch.
# Runs daemon + Vite dev server in one container.
# Agent CLIs (opencode, cursor-agent, claude) are volume-mounted from the host.
# Gemini can use `scripts/fake-gemini.sh` mounted as `/usr/local/bin/gemini` (see docker-compose.dev.yml).
#
# Usage:
#   docker compose -f docker-compose.dev.yml up --build
#
# Then open http://localhost:5174 in your browser.
#
# To inspect a running sandbox interactively, use
# `docker compose exec -u vst <service> bash` (or `docker exec -u vst
# <container> sh`) — NOT a plain `docker exec`. The container runs as root
# only so its CMD can chown volumes at startup before dropping to the "vst"
# user; a plain `docker exec` lands as root (uid 0), whose tmux socket dir
# (`/tmp/tmux-0/`) is different from the daemon's (`/tmp/tmux-1000/` for
# vst), so `tmux attach`/`tmux ls` won't see the daemon's actual sessions.

FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux git procps curl ripgrep ca-certificates unzip \
    python3 make g++ \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.0.0 @google/gemini-cli

# Runtime user: Claude Code hard-refuses to run with
# --dangerously-skip-permissions (which this codebase always passes when
# launching claude sessions) as root, so the daemon — and every agent CLI
# it spawns — MUST run as a non-root user at runtime. Reuse the "node" user
# already present in the base image (uid/gid 1000) rather than creating a
# new one, renaming it to "vst" and moving its home to /home/vst to match
# the paths used throughout this Dockerfile and the compose files. This
# happens BEFORE `COPY . .` below so the copy can be owned by vst directly
# (via --chown) instead of a separate `chown -R` afterward, which would
# otherwise force a full overlayfs copy-up of every file under /app
# (breaking pnpm's build-time hardlinks and roughly doubling node_modules'
# on-disk size in the image).
RUN groupmod -n vst node && usermod -l vst -d /home/vst -m node

# Daemon data dir — isolated from the host
ENV HOME=/home/vst

WORKDIR /app

# WORKDIR creates /app as root before the COPY below runs, and
# `COPY --chown` only chowns what it copies IN, not the pre-existing
# directory entry itself — so without this, pnpm (running as vst) can't
# write its own temp files directly into /app. This is a single directory
# inode, not a recursive walk, so it doesn't reintroduce the copy-up cost
# a `chown -R /app` has.
RUN chown vst:vst /app

# Copy everything, owned by vst — simpler and correct for a dev sandbox.
COPY --chown=vst:vst . .
RUN chmod +x /app/scripts/dev-entrypoint.sh

# Install deps + build daemon as the vst user (matches how the daemon and
# its build output will actually run/be owned at runtime). apt-get/npm -g
# above still ran as root — that's normal, they install system packages.
USER vst
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vibestation/cli build

# agy's ACP path (`daemon/src/agent-plugins/agy.ts`) spawns the third-party
# `antigravity-acp` adapter via `bunx` — Bun is a hard runtime dependency of
# that one plugin, not otherwise needed by this project. Installed as `vst`
# (not root) so it lands under $HOME/.bun, matching how the daemon itself
# runs `bunx` at spawn time.
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/vst/.bun/bin:${PATH}"

USER root

# Put the built CLI on PATH as `vst`. Every agent's system prompt
# (daemon/src/assets/agent-system-prompt.md) instructs it to run `vst session
# create` / `vst worktree create` / `vst send`, so without this the sandbox
# silently lacks the one command those instructions depend on — an agent here
# gets "vst: not found" and no session-spawning flow can be tested at all.
# `cli/package.json` already declares the `vst` bin and the built entrypoint
# carries a `#!/usr/bin/env node` shebang, but tsc emits it without the
# executable bit, so a bare symlink alone would fail with EACCES.
RUN chmod +x /app/cli/dist/main.js \
    && ln -sf /app/cli/dist/main.js /usr/local/bin/vst

EXPOSE 5173

# Runs as root (PID 1) so it can chown volume mount points before dropping
# to vst — see scripts/dev-entrypoint.sh, shared with
# docker-compose.dev.yml's `command:` override so the two can't drift.
CMD ["/app/scripts/dev-entrypoint.sh"]

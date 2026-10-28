# Dev sandbox for testing vibe-station on a feature branch.
# Runs daemon + Vite dev server in one container.
# Every agent harness (claude, codex, opencode, cursor-agent, agy, omp, pi) is
# installed in the image as a pinned Linux build for TARGETARCH (arm64 + amd64), so
# a macOS host never mounts its Mach-O binaries and a Linux host without them still
# works. (On Linux, scripts/dev-sandbox.sh mounts the host's own opencode/agy/codex/
# cursor-agent when present, preferred over these.) Credentials come from the host
# — see docker-compose.dev.yml.
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

# node:24-slim has no locale generated at all (LANG unset, LC_CTYPE=POSIX).
# This image's tmux (Debian's current version, 3.3a as of this writing) only
# assumes UTF-8 output when the ATTACHING CLIENT has a UTF-8 locale — tmux
# >= 3.4 dropped that check, but this image predates it. Without a UTF-8
# locale, tmux rewrites every non-ASCII byte it would otherwise send to a
# literal '_' and box-drawing chars to ACS escapes, so terminal panes render
# icons/box-drawing as underscores/dashes instead of the real glyphs. The
# Rust daemon's tmux attach already passes `-u` to force UTF-8 mode on the
# client regardless of environment (see rust/vst-ws/src/streams/tmux_output.rs),
# but setting a real locale here too keeps every OTHER process in the
# container (the agent CLIs spawned inside panes, tmux's own server, etc.)
# consistent instead of relying on that one call site. C.UTF-8 is a minimal
# glibc locale already present in this image — no `locales`/`locale-gen`
# package needed.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux git procps curl ripgrep ca-certificates unzip \
    python3 make g++ \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# TARGETARCH is amd64/arm64 (BuildKit) — an amd64 binary on an arm64 (Apple
# Silicon) Docker VM would fail with "Exec format error".
ARG TARGETARCH
RUN curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH:-amd64}" \
    -o /usr/local/bin/cloudflared \
  && chmod +x /usr/local/bin/cloudflared

# @anthropic-ai/claude-code: the Linux `claude` CLI, installed in-image so the
# sandbox never mounts the host's binary (a macOS host's is Mach-O -> ENOEXEC).
# Ships per-platform optional deps for linux-arm64 and linux-x64.
# Pinned to the version installed in the existing sandbox image (2.1.306) so
# rebuilds are reproducible; bump deliberately.
RUN npm install -g pnpm@9.0.0 @google/gemini-cli @anthropic-ai/claude-code@2.1.306

# Every other harness is ALSO installed in-image, as its vendor's own Linux build
# for the image's arch — never bind-mounted from the host (a macOS host's binaries
# are Mach-O -> ENOEXEC, and a Linux host's would make the sandbox depend on
# whatever that host happens to have installed). Pinned to the versions this repo
# was last verified against; bump deliberately. Credentials are NOT baked in — see
# docker-compose.dev.yml's header for how each one gets auth.
#
# codex: the official npm package; npm installs only the matching
# @openai/codex-linux-{arm64,x64} optional dep (the real static ELF + its
# codex-resources/ siblings). pi: pure JS on the image's node (same package the
# doctor hint names).
RUN npm install -g @openai/codex@0.163.0 @mariozechner/pi-coding-agent@0.73.1

# opencode (v2): the same release tarballs anomalyco's Homebrew tap installs
# (opencode.ai/files/bin/<ver>/), checksums copied from that formula.
# agy (Antigravity CLI): the tarballs its install.sh resolves from the release
# manifest (antigravity-cli-auto-updater.../manifests/linux_<arch>.json) — the
# script itself also runs `agy install` (shell rc/PATH edits) which the image
# doesn't want, so fetch the pinned artifact directly. Checksums are the
# manifest's sha512.
# cursor-agent: the package https://cursor.com/install downloads (its URL embeds
# the version); extracted to /opt like the installer's versions/<ver>/ dir, since
# its launcher resolves its bundled node + chunk files relative to its realpath.
# Cursor publishes no checksum, so these sha256s were computed on download.
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    arm64) oc_asset=opencode-linux-arm64.tar.gz; \
           oc_sha=3ddeab155dd75f36d9fd4f5db80e2392181a4b9f59e347a0361a127244686e94; \
           agy_asset=linux-arm/cli_linux_arm64.tar.gz; \
           agy_sha=a703d10ea96d20d35c2ab6a056ce07ac196fac215cdf1ac3a8750a519fa42c3ac1bc4ac8776c98c94e0a816b6b37beaf0e5d98d30eed3e60a90d18ac9a060130; \
           cur_arch=arm64; \
           cur_sha=22a36df9720830668ccd4d707e5190204ab9c8a0efb2f068cc914895f804d3ec ;; \
    amd64) oc_asset=opencode-linux-x64-baseline.tar.gz; \
           oc_sha=911e9778fac07559678c5f46d8b130856e237a7f021091509273e81a2dada183; \
           agy_asset=linux-x64/cli_linux_x64.tar.gz; \
           agy_sha=96a259b7475ae70a5b002ea8a83b804bba9b6ad2171af0cd0839b3959d9e6046ba36e181bc2d5597522aeceaacc06023564c46232fdb958f26f8c72267d9f0fd; \
           cur_arch=x64; \
           cur_sha=85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294 ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  tmp="$(mktemp -d)"; cd "$tmp"; \
  curl -fsSL -o oc.tgz "https://opencode.ai/files/bin/2.1.2/${oc_asset}"; \
  echo "${oc_sha}  oc.tgz" | sha256sum -c -; \
  tar -xzf oc.tgz opencode; install -m 0755 opencode /usr/local/bin/opencode; \
  curl -fsSL -o agy.tgz "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.9-4962164969177088/${agy_asset}"; \
  echo "${agy_sha}  agy.tgz" | sha512sum -c -; \
  tar -xzf agy.tgz antigravity; install -m 0755 antigravity /usr/local/bin/agy; \
  curl -fsSL -o cursor.tgz "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/${cur_arch}/agent-cli-package.tar.gz"; \
  echo "${cur_sha}  cursor.tgz" | sha256sum -c -; \
  mkdir -p /opt/cursor-agent; tar --strip-components=1 -xzf cursor.tgz -C /opt/cursor-agent; \
  ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent; \
  ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/agent; \
  cd /; rm -rf "$tmp"

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
RUN pnpm install --no-frozen-lockfile

# Claude's ACP path (see rust/vst-agents/src/claude.rs) spawns the official
# `claude-agent-acp` adapter via a plain `bun <entry.js>` — Bun is a hard
# runtime dependency of Claude's Rich Chat, not otherwise needed by this
# project. (agy's Rich Chat needs neither bun nor npm nor any mounted binary:
# it runs as the hidden `agy-stream-acp` subcommand of the daemon's own `vst`
# binary.) Installed as `vst` (not root) so it lands under $HOME/.bun,
# matching how the daemon itself runs `bun` at spawn time.
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/vst/.bun/bin:${PATH}"

# oh-my-pi (`omp`): installed in-image, never mounted from the host — the host's
# copy carries a platform-specific native package (e.g. pi-natives-darwin-arm64)
# that cannot run in this Linux container, and on macOS hosts host binaries are
# never mounted anyway. Installs the matching Linux native package. Runs as `vst`
# so it lands next to bun under $HOME/.bun (already on PATH above). `omp acp`
# (Rich Chat) needs no adapter, so this is the whole install.
# Pinned: the plugin/importer rely on undocumented behaviour verified on this version
# (session/load ignoring --session-dir, ACP id == session-file id, v3 entry shape —
# see rust/vst-agents/tests/fixtures/omp/README.txt). Bump them together.
RUN bun install -g @oh-my-pi/pi-coding-agent@18.12.6

# Vendor install for Claude's ACP adapter (see scripts/install-claude-acp-vendor.sh
# for why `--omit=optional` matters — skips 600MB+ of per-platform binaries
# this project never uses). `rust/vst-agents/src/claude.rs::claude_acp_entry_path`
# would find this by walking upward from the daemon's cwd (`/app`, this
# WORKDIR), but scripts/dev-entrypoint.sh also pins VST_CLAUDE_ACP_ENTRY to it
# explicitly so the lookup doesn't depend on `su -c`'s cwd.
RUN ./scripts/install-claude-acp-vendor.sh

# Same for Codex's ACP adapter (Rich Chat), found by the same walk-upward from
# /app. Used to be bind-mounted from the host's vendor/codex-acp, which is empty
# until someone runs this script on the host — so codex Rich Chat silently had no
# adapter in a fresh checkout's sandbox. Installing it here, like claude-acp,
# removes that host prerequisite (the adapter is pure JS; `codex.rs` points it at
# the in-image `codex` via CODEX_PATH).
RUN ./scripts/install-codex-acp-vendor.sh

# The Rust CLI binary is mounted from the host at /usr/local/bin/vst-rust by
# docker-compose.dev.yml, and scripts/dev-entrypoint.sh symlinks it to
# /usr/local/bin/vst on startup.
USER root

EXPOSE 5173

# Runs as root (PID 1) so it can chown volume mount points before dropping
# to vst — see scripts/dev-entrypoint.sh, shared with
# docker-compose.dev.yml's `command:` override so the two can't drift.
CMD ["/app/scripts/dev-entrypoint.sh"]

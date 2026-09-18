# Architecture

vibe-station is a **local-first orchestrator** for running multiple AI coding agents
(Claude Code, Cursor, OpenCode, agy) in parallel on isolated git worktrees.

The core idea: **one stateful daemon** owns everything; every front end is a thin
client. State survives daemon restarts via tmux + SQLite.

## Top-level layout

Four sibling directories (three are pnpm workspace packages):

| Directory | Role |
|---|---|
| `daemon/` | Fastify server + PTY/tmux/agent management. TypeScript source only; not an npm package. Runs as a detached child process. |
| `web-ui/` | React 19 + Vite frontend (`@vibestation/web`). Served by the daemon. |
| `cli/` | `vst` CLI binary (`@vibestation/cli`). `cli/src/daemon` is a **symlink** to `daemon/src`, so one `tsc` pass compiles both. |
| `desktop/` | Tauri v2 shell (`@vibe-station/desktop`). Rust + system webview wrapping the same web UI; spawns the bundled daemon sidecar. |

## The daemon (single source of truth)

Entry: `daemon/src/main.ts` → `server.ts`. Binds `127.0.0.1:7421` (auto-picks next
free port up to 7520). All state on disk lives in `~/.vibe-station/`
(`vibe-station.db` SQLite, `config.json`, `modes.json`, `projects/`).

Two transports:

- **REST** (`daemon/src/routes/`) — projects, worktrees, sessions, modes, settings,
  auth, fs/preview, health, tunnels. Every CLI and UI action is an HTTP call.
- **WebSocket** (`daemon/src/ws/`) — live terminal streaming, Rich Chat events,
  lifecycle updates, file/tree watching. `connection.ts` per-connection session
  locks serialize `session:open`/`session:close`.

### Services (`daemon/src/services/`)

The bulk of the logic lives here:

- **`tmux.ts`** — each session runs an AI CLI inside a tmux session/PTY, which is why
  sessions outlive daemon restarts and reattach cleanly.
- **`spawn.ts`** — defines the `AgentPlugin` interface and launch contract. Per-CLI
  behaviour (launch argv, env, ready signal, restore command, native chat-id capture)
  lives **only** in `daemon/src/agent-plugins/{claude,cursor,opencode,agy}.ts`;
  calling code resolves a plugin once via `registry.ts` and never branches on the CLI
  name.
- **`jsonAgent.ts` / `jsonAgentChat.ts`** — the Rich Chat channel: drives the CLI via
  structured JSON output (`channel: "json"` in the code, "Rich Chat" in the UI)
  instead of raw ANSI.
- **`lifecycle.ts`** — 1s poller writing only `session.lifecycle.state` (busy?).
- **`prPoller.ts`** — 30s poller writing only `session.pr` (what happened to the
  branch?). These two axes are deliberately separate; see `docs/STATUS-INDICATORS.md`.
- **`config.ts`, `paths.ts`, `dbSchema.ts`, `worktreeService.ts`, `git.ts`,
  `promptBuilder.ts`, `userSkillCatalog.ts`** — config/paths, SQLite, worktrees/git,
  and the L1 system-prompt + user-skill assembly.

## Web UI

React 19 + Vite, served by the daemon and rendered identically inside the desktop
shell. State is managed via `web-ui/src/store` + an API client (`web-ui/src/api/`)
that wraps the daemon's REST + WS.

Layout (`web-ui/src/components/layout/Layout.tsx`): sidebar (project/worktree
navigator), terminal panel (live output + inline messages), file tree, and a
preview panel (markdown/Mermaid/diff). Workspace route: `web-ui/src/routes/Workspace.tsx`.

## Per-worktree runtime

```
tmux session → PTY → AI CLI (claude / cursor / opencode / agy) → git worktree
```

Each worktree is an isolated `git worktree` checkout on its own branch; sessions are
the processes (agent or plain terminal) running inside it. One session per worktree
is flagged **main**. Agents in different worktrees never see each other's files.

## Clients

- **Desktop** (`desktop/`) — Tauri v2 shell: tray + sidecar daemon supervision + a
  pre-minted `tauriToken` injected into the webview (no login). Nothing else.
- **Browser/PWA** — same web UI, mobile layout collapses to a single column; optional
  remote access via bundled `cloudflared` tunnel or local network.
- **CLI** (`cli/`) — full scripting surface (`vst project/worktree/session/mode/...`)
  driving the same REST API the UI uses.

## Auth model

The daemon mints an in-memory master `daemonToken` at boot (never written to disk).
Two scoped tokens derive from it and persist to `config.json`: `cliToken` (CLI) and
`tauriToken` (desktop webview). Browser logins exchange the daemon-log-printed token
for a scoped browser token; daemon restart rotates everything.

## Build & Run Modes

There are exactly two ways to run the app:

### 1. `pnpm dev` — Tauri dev mode (local development)

```
pnpm dev
  └─ desktop: tauri dev
       ├─ beforeDevCommand: scripts/dev-start.sh
       │    ├─ builds web-ui/dist (for non-Vite clients)
       │    ├─ starts Vite dev server on port 5180 (hot-reload)
       │    └─ starts vst-daemon via `cargo run -p vst-daemon` (debug build)
       └─ compiles desktop Tauri shell (debug build → target/debug/vibe-station-desktop)
```

- All Rust binaries are **debug builds** (`target/debug/`): unoptimized, full debug symbols, fast recompile.
- `dev-start.sh` builds both `vst-daemon` and `vst-cli` before launching the daemon, and passes `VST_CLI_BIN` explicitly so the daemon writes the `~/.vibe-station/bin/vst` shim to the correct Rust binary on first boot.
- The Tauri window loads the UI from Vite (hot-reload); the daemon also serves `web-ui/dist` to any other client (browser, curl).
- Stub sidecar binaries are created in `desktop/src-tauri/binaries/` so Tauri's resource-path check passes; they are never executed.

### 2. `pnpm build` — Tauri release build (production / distribution)

```
pnpm build
  └─ desktop: tauri build
       ├─ beforeBuildCommand: scripts/prep-sidecar.sh && pnpm --filter @vibestation/web build
       │    ├─ `cargo build --release -p vst-daemon -p vst-cli` (release builds)
       │    ├─ copies target/release/vst-daemon → desktop/src-tauri/binaries/vst-daemon-<triple>
       │    ├─ copies target/release/vst-cli    → desktop/src-tauri/binaries/vst-<triple>
       │    └─ downloads cloudflared → desktop/src-tauri/binaries/cloudflared-<triple>
       └─ bundles everything into a distributable .app / .deb / .AppImage
```

- All Rust binaries are **release builds** (`target/release/`): fully optimized, stripped, production-ready.
- The daemon and CLI are bundled as Tauri sidecars; the desktop shell supervises them directly — no Docker, no separate install.
- macOS universal builds require a separate lipo step (see `prep-sidecar.sh` comments).

### Dev sandbox (`scripts/dev-sandbox.sh`) — local Docker environment

Not a build mode for the desktop app. Runs the daemon + web UI inside Docker for testing the backend in isolation or simulating a remote install. Mounts host-built Rust binaries into the container using this priority order:

1. `rust/target-docker/debug/` (cross-compiled for the container's Linux target)
2. `rust/target-docker/release/`
3. `rust/target/release/` (host release build)
4. `rust/target/debug/` (host debug build, last resort)

The container runs whatever binary it mounts — it does **not** recompile. If you change Rust code, `pnpm dev` picks it up immediately (cargo recompiles); the sandbox keeps running the old binary until you rebuild or remount.

### `vst` CLI in agent sessions

The daemon's `setup_vst_environment` writes `~/.vibe-station/bin/vst` as a thin shell shim pointing at the resolved CLI binary, and `patch_shell_configs` ensures `~/.vibe-station/bin` is prepended to PATH in all agent shell sessions. Resolution order:

1. `$VST_CLI_BIN` env var (if set and exists)
2. Binary named `vst` or `vst-cli` in the same directory as the running daemon executable

This means in dev mode agents automatically get `target/debug/vst-cli`; in production they get the bundled `target/release/vst-cli` sidecar.

## Key invariants (see AGENTS.md for full details)

- `TerminalPane` never unmounts/remounts during UI transitions (fullscreen is pure CSS).
- `session:open`/`session:close` per `(connection, sessionId)` are serialized.
- Per-CLI logic lives in the agent plugins, never in `if (cli === ...)` call sites.
- Lifecycle and PR are two separate status axes written by two separate pollers.

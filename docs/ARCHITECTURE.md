# Architecture

> Consolidated from the former `ARCHITECTURE.md` + `HIGH-LEVEL-DESIGN.md` +
> `TECH-STACK.md` into one focused doc, and rewritten to match the current
> codebase — the previous three had drifted out of date (they still
> described a TypeScript/Fastify daemon; the daemon and CLI are Rust-only as
> of `7bfa386c`, "hard-remove Node daemon/ and cli/"). Plugin-specific detail
> lives in `docs/PLUGINS.md`, split out because it's a distinct, evergreen
> concept worth its own page rather than a subsection here.

vibe-station is a **local-first orchestrator** for running multiple AI coding
agents (Claude Code, Cursor, OpenCode, agy) in parallel on isolated git
worktrees.

The core idea: **one stateful daemon** owns everything; every front end —
desktop app, browser, CLI — is a thin client. State survives daemon restarts
via tmux (session processes) + SQLite (metadata).

## System diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  DESKTOP (Tauri v2 shell)        BROWSER / mobile (same web UI)   │
│  React 19 + Vite — layout, xterm.js terminal, file preview,       │
│  Markdown/Mermaid renderer, diff view                             │
└────────────┬───────────────────────────┬──────────────────────────┘
             │ REST (localhost)          │ WebSocket (/ws)
             ↓                           ↓
┌──────────────────────────────────────────────────────────────────┐
│                         vst-daemon (Rust)                        │
│  axum + tokio · SQLite (vst-store) · in-process state            │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐    │
│  │ tmux    │  │ worktree │  │ agent    │  │ file/diff/git  │    │
│  │ adapter │  │ service  │  │ plugins  │  │ + LSP services │    │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────────┬───────┘    │
└───────┼─────────────┼─────────────┼─────────────────┼────────────┘
        ↓             ↓             ↓                 ↓
    tmux server    git CLI     claude / cursor /    local fs +
                                opencode / agy       language servers
        ↑
        │ same REST API
┌──────────────────────────────────────────────────────────────────┐
│  vst CLI (Rust; desktop: merged binary with embedded daemon+UI)    │
│  vst project add <path> · vst worktree create · vst doctor · ...  │
└──────────────────────────────────────────────────────────────────┘
```

## Top-level layout

| Directory | Role |
|---|---|
| `rust/vst-daemon` | Binary entry point + HTTP/WS server (`axum`). Binds `127.0.0.1:<port>` (default `7421`, auto-picks the next free port). |
| `rust/vst-routes` | REST + WS route handlers (`GET /health`, worktrees, sessions, modes, settings, auth, fs/preview, tunnels). |
| `rust/vst-agents` | Agent plugin implementations (`claude.rs`, `cursor.rs`, `opencode.rs`, `agy.rs`), ACP transport, JSON-chat (Rich Chat) driving. See `docs/PLUGINS.md`. |
| `rust/vst-git` | Worktree/session path helpers, worktree service, recovery-on-boot logic. |
| `rust/vst-store` | SQLite-backed state store. |
| `rust/vst-lifecycle` | 1s lifecycle poller (`session.lifecycle.state` — busy?) and 30s PR poller (`session.pr` — what happened to the branch?); deliberately separate axes, see `docs/STATUS-INDICATORS.md`. |
| `rust/vst-lsp`, `rust/vst-proc`, `rust/vst-ws`, `rust/vst-rpc`, `rust/vst-types` | Language-server integration, process/tmux control, WebSocket plumbing, internal RPC, shared types. |
| `rust/vst-cli` | The `vst` CLI binary — full scripting surface, drives the same REST API the UI uses. |
| `web-ui/` | React 19 + Vite frontend (`@vibestation/web`). Served by the daemon; renders identically in the desktop shell and the browser. |
| `desktop/` | Tauri v2 shell (`@vibe-station/desktop`). Rust + system webview; supervises the bundled `vst`/`cloudflared` sidecars (the `vst` binary is the merged CLI+daemon built with `--features vst-daemon/embed-ui`). |

## The daemon

Entry: `rust/vst-daemon/src/main.rs` → `server.rs`. On boot it acquires a PID-checked
lock (`~/.vibe-station/.daemon.lock`), migrates any legacy JSON state into
SQLite, recovers sessions that didn't shut down cleanly, picks a port, mints
an in-memory `daemonToken` plus scoped `cliToken`/`tauriToken` (persisted to
`config.json`, mode `0o600`), starts the lifecycle/PR pollers, and serves.

Two transports:
- **REST** — every CLI and UI action is an HTTP call to the daemon.
- **WebSocket** — live terminal streaming, Rich Chat events, lifecycle
  updates, file/tree watching.

## Per-worktree runtime

```
tmux session → PTY → AI CLI (claude / cursor / opencode / agy) → git worktree
```

Each worktree is an isolated `git worktree` checkout on its own branch;
sessions are the processes (agent or plain terminal) running inside it. One
session per worktree is flagged **main**. Agents in different worktrees never
see each other's files — that isolation is the whole basis for running
several agents at once without them colliding.

## Clients

- **Desktop** (`desktop/`) — Tauri v2 shell: tray + sidecar daemon
  supervision + a pre-minted `tauriToken` injected into the webview (no login
  screen).
- **Browser / mobile** — same web UI; mobile layout collapses to a single
  column; optional remote access via bundled `cloudflared` tunnel or the
  local network (QR pairing).
- **CLI** (`vst`) — full scripting surface (`vst project/worktree/session/mode/...`)
  driving the same REST API as the UI.

## Auth model

The daemon mints an in-memory master `daemonToken` at boot (never written to
disk). Two scoped tokens derive from it and persist to `config.json`:
`cliToken` and `tauriToken`. Browser logins redeem a one-time continue-flow
code (minted with the `cliToken`) for a scoped browser token. A daemon restart
rotates everything.

## Build & run modes

There are two ways to run the app, plus a Docker sandbox for backend-only testing:

**`pnpm dev`** — Tauri dev mode. `scripts/dev-start.sh` builds `web-ui/dist`,
starts the Vite dev server (hot-reload), and starts `vst-daemon` via
`cargo run` (debug build, unoptimized, fast recompile). The Tauri window
loads from Vite; the daemon also serves `web-ui/dist` to any other client.

**`pnpm build`** — Tauri release build. `scripts/prep-sidecar.sh` builds
the web UI first, then runs `cargo build --release -p vst-cli
--features vst-daemon/embed-ui` which produces a **single merged `vst` binary**
(CLI + daemon + embedded web UI). It copies `vst` and `cloudflared` into
`desktop/src-tauri/binaries/` as Tauri sidecars, then bundles everything into a
distributable `.app` / `.deb` / `.AppImage` — no Docker, no separate install step
for end users.

**`scripts/dev-sandbox.sh`** — runs the daemon + web UI in Docker for
testing the backend in isolation. Mounts a host-built Rust binary in; does
not recompile inside the container.

Prerequisites to build from source today: Node ≥ 20, pnpm ≥ 9, a Rust
toolchain (now required unconditionally — the daemon and CLI are Rust),
`tmux`, `git` ≥ 2.5, and at least one supported AI CLI on `PATH`.

## Key invariants

- `TerminalPane` never unmounts/remounts during UI transitions (fullscreen is
  pure CSS).
- `session:open`/`session:close` per `(connection, sessionId)` are
  serialized.
- Per-CLI logic lives only in the agent plugins (`rust/vst-agents`), never in
  a `match cli { ... }` at a call site — see `docs/PLUGINS.md`.
- Lifecycle and PR are two separate status axes, written by two separate
  pollers.

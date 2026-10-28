# Architecture

> Consolidated from the former `ARCHITECTURE.md` + `HIGH-LEVEL-DESIGN.md` +
> `TECH-STACK.md` into one focused doc, and rewritten to match the current
> codebase — the previous three had drifted out of date (they still
> described a TypeScript/Fastify daemon; the daemon and CLI are Rust-only as
> of `7bfa386c`, "hard-remove Node daemon/ and cli/"). Plugin-specific detail
> lives in `docs/PLUGINS.md`, split out because it's a distinct, evergreen
> concept worth its own page rather than a subsection here.

vibe-station is a **local-first orchestrator** for running multiple AI coding
agents (Claude Code, Cursor, OpenCode, agy, codex, pi, oh-my-pi) in parallel on
isolated git worktrees.

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
                                opencode / agy / omp  language servers
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
| `rust/vst-agents` | Agent plugin implementations (`claude.rs`, `cursor.rs`, `opencode.rs`, `agy.rs`, `codex.rs`, `pi.rs`, `omp.rs`), ACP transport, JSON-chat (Rich Chat) driving. See `docs/PLUGINS.md`. |
| `rust/vst-git` | Worktree/session path helpers, worktree service, recovery-on-boot logic. |
| `rust/vst-store` | SQLite-backed state store. |
| `rust/vst-lifecycle` | 1s lifecycle poller (`session.lifecycle.state` — busy?) and 30s PR poller (`session.pr` — what happened to the branch?); deliberately separate axes, see `docs/STATUS-INDICATORS.md`. |
| `rust/vst-harness-limits` | Claude/Codex/Agy subscription-limit scheduler + cache: probes each vendor's own binary via `AgentPlugin::get_limits()` (injected from `vst-daemon`), pushes `limits:updated` over WS. CLI-agnostic. |
| `rust/vst-lsp`, `rust/vst-proc`, `rust/vst-ws`, `rust/vst-rpc`, `rust/vst-types` | Language-server integration, process/tmux control, WebSocket plumbing, internal RPC, shared types. |
| `rust/vst-cli` | The `vst` CLI binary — full scripting surface, drives the same REST API the UI uses. |
| `web-ui/` | React 19 + Vite frontend (`@vibestation/web`). Served by the daemon; renders identically in the desktop shell and the browser. |
| `desktop/` | Tauri v2 shell (`@vibe-station/desktop`). Rust + system webview; supervises the bundled `vst` sidecar (the `vst` binary is the merged CLI+daemon built with `--features vst-daemon/embed-ui`). |

## The daemon

Entry: `rust/vst-daemon/src/main.rs` → `server.rs`. On boot it acquires a PID-checked
lock (`~/.vibe-station/.daemon.lock`), migrates any legacy JSON state into
SQLite, recovers sessions that didn't shut down cleanly, picks a port, mints
an in-memory `daemonToken` plus scoped `cliToken`/`tauriToken` (persisted to
`config.json`, mode `0o600`), starts the lifecycle/PR pollers and the harness-limits scheduler, and serves.

Two transports:
- **REST** — every CLI and UI action is an HTTP call to the daemon.
- **WebSocket** — live terminal streaming, Rich Chat events, lifecycle
  updates, file/tree watching.

## Per-worktree runtime

```
tmux session → PTY → AI CLI (claude / cursor / opencode / agy / codex / pi / omp) → git worktree
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
  column; optional remote access via a `cloudflared` tunnel (install
  `cloudflared` separately) or the local network (QR pairing).
- **CLI** (`vst`) — full scripting surface (`vst project/worktree/session/mode/...`)
  driving the same REST API as the UI.

### Web UI workspace layout

- **Tools rail:** on desktop a full-height 36px column at the window's right edge (`ToolsRailColumn`, a
  trailing child of `#workspace-layout` and a sibling of the main column in `Layout`), rendered only while the
  tools pane is shown (`#workspace-layout[data-rail]`): an empty 35px head cell under the actions chip's toggle,
  tool icons below. Phones (<=768px) and canvas Tools tiles have no window rail; each `ToolPanel` carries its
  own vertical right-edge rail (45px on phones).
- **List panel:** the Files list and the VCS commit view's changed-file list (both via `DockedListLayout`, one shared persisted width/height) dock full height on the right of the content column (tab bar over preview),
  between it and the rail (resize handle on its left edge); the same structure on phones (default half the pane,
  >=160px; the content column keeps >=144px; stacked keeps the preview >=96px). While the list is open the layout
  toggle and Fullscreen sit in its header on phones (stacked on any size), in the tab bar otherwise; on desktop
  its header's right end is reserved for the actions chip.
- **Actions chip (Search / `ConnectionStatus` / "..." / tools toggle):** one absolute box at the top-right of
  `#workspace-layout` (`main`'s chrome), rendered once by `Layout`'s `TopActionsOwner` as the LAST child, never
  re-parented or hidden during transitions (only in fullscreen). Panes register hosts in `TopActionsContext`; the
  registry picks the one top row under the chip, whose reserve span takes the chip's token-sized width
  (`--top-actions-w`, minus the rail, plus the offline pill). No measurement, no transition hold. Phones have no
  chip: the same buttons end the normal top bar.
- **File tabs:** artifacts open as ordinary file tabs on every size (outside-project ones by absolute path, with a
  small "Outside project" tag); there is no separate phone artifact preview screen.

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
(CLI + daemon + embedded web UI). It copies `vst` into
`desktop/src-tauri/binaries/` as a Tauri sidecar, then bundles everything into a
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

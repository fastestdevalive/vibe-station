# viberun-ide — API Contract

> Complete surface area: CLI commands, REST endpoints, WebSocket events. Brief by design — exact request/response types live in `apps/cli/src/types.ts` once implemented.

---

## CLI Commands

User-facing binary: `vrun`. Subcommand groups follow the noun-verb pattern (`vrun project add`, `vrun worktree create`).

### Projects

| Command | Args / Flags | Description |
|---|---|---|
| `vrun project add` | `<path> [--name=<id>] [--prefix=<prefix>]` | Register a project. Validates git repo + name/prefix uniqueness. |
| `vrun project rm` | `<id>` | Remove project (interactive confirm; cascades to sessions + worktrees + dirs). |
| `vrun project ls` | `[--json]` | List projects: name · path · #worktrees · #sessions. |
| `vrun project info` | `<id> [--json]` | Project details + worktree summary. |

### Worktrees

| Command | Args / Flags | Description |
|---|---|---|
| `vrun worktree create` | `<project-id> --branch=<name> --mode=<id> [--base=<branch>] [--prompt=<text>] [--prompt-file=<path>]` | Create worktree + auto-spawn main session (atomic). `--branch` is required and becomes the sidebar label. `--prompt`/`--prompt-file` is sent to the main agent on first ready. Prints the new worktree id on the last line of stdout. |
| `vrun worktree rm` | `<worktree-id>` | Remove worktree (terminates all sessions, removes git worktree dir). |
| `vrun worktree ls` | `[--project=<id>] [--json]` | List worktrees. `--project` defaults to `$VR_PROJECT` if set. |
| `vrun worktree info` | `<worktree-id> [--json]` | Worktree details + all sessions. |

### Sessions (= tabs)

| Command | Args / Flags | Description |
|---|---|---|
| `vrun session create` | `<worktree-id> --type=agent\|terminal [--mode=<id>] [--prompt=<text>] [--prompt-file=<path>]` | Add a session/tab to the worktree. `--mode` required when `--type=agent`. `--prompt`/`--prompt-file` sent to the new agent on first ready (agent type only). Prints new session id. `<worktree-id>` defaults to `$VR_WORKTREE`. |
| `vrun session ls` | `[--worktree=<id>] [--project=<id>] [--json]` | List sessions. `--worktree` defaults to `$VR_WORKTREE`. |
| `vrun session info` | `<session-id> [--json]` | Session details (slot, type, mode, lifecycle, tmux name). |
| `vrun session kill` | `<session-id>` | Terminate session. Rejected for `m` slot. |
| `vrun session attach` | `<session-id>` | Drop into the tmux session interactively. |
| `vrun session restore` | `<session-id>` | Resume an `exited` session (calls plugin's restore). |
| `vrun session output` | `<session-id> [--lines=<n>] [--follow]` | Print recent pty output (default last 100 lines). `--follow` streams new bytes until Ctrl-C. |

### Send

| Command | Args / Flags | Description |
|---|---|---|
| `vrun send` | `<session-id> [message...] [--file=<path>] [--wait]` | Send a message to a session with busy-detect + retry (mirrors AO's `ao send`). `--file` reads from file. `--wait` blocks until target session reports `idle`. |

### Modes

| Command | Args / Flags | Description |
|---|---|---|
| `vrun mode ls` | `[--json]` | List agent modes. |
| `vrun mode add` | `--name=<n> --cli=<claude\|cursor\|opencode> (--context=<text> \| --context-file=<path>) [--preset=<id>]` | Create a mode. |
| `vrun mode rm` | `<id>` | Delete a mode. |

### Daemon

| Command | Args / Flags | Description |
|---|---|---|
| `vrun daemon start` | — | Forks daemon. Writes PID + port to `~/.viberun/config.json`. Auto-picks free port if 7421 is taken. |
| `vrun daemon stop` | — | Graceful shutdown. |
| `vrun daemon status` | `[--json]` | Running/stopped, port, version, uptime. |
| `vrun daemon restart` | — | Stop then start. |

### Browser / status / doctor

| Command | Args / Flags | Description |
|---|---|---|
| `vrun open` | `[target]` | Open browser. `target` = session id, worktree id, project id, or `all`. |
| `vrun status` | `[--project=<id>] [--json]` | Cross-cutting view of sessions + states across projects. |
| `vrun doctor` | — | Health checks (tmux, git, claude/cursor/opencode on PATH). |

### Meta

| Command | Args / Flags | Description |
|---|---|---|
| `vrun --version` | — | Print version. |
| `vrun --help` | — | Print help. |
| `vrun completion` | `<shell>` | Print shell completion script (bash/zsh/fish). |

### Agent-context env vars

When the daemon spawns an agent into a session, it sets these env vars in the agent's process. CLI commands invoked from inside the agent default to these when flags/args are omitted:

| Var | Set to | Used as default for |
|---|---|---|
| `VR_PROJECT` | project id of the agent's worktree | `--project` flags |
| `VR_WORKTREE` | worktree id | `--worktree` flags + `<worktree-id>` arg in `session create` |
| `VR_SESSION` | the agent's own session id | (informational; not used as a default to avoid self-targeting bugs) |
| `VR_DAEMON_URL` | `http://localhost:<port>` | daemon endpoint for the CLI to talk to |

**Destructive commands** (`project rm`, `worktree rm`, `session kill`, `mode rm`) **require explicit ids** — no env-var defaults — to prevent agents accidentally nuking their own context.

### Conventions

| Topic | Rule |
|---|---|
| JSON output | All `ls`, `info`, `status` commands accept `--json`. Output is a single JSON value on stdout. Stderr is reserved for warnings. |
| Exit codes | `0` success · `1` generic failure · `2` not-found · `3` conflict (duplicate / collision) · `4` daemon-down · `5` unauthorized (v1.1) |
| ID printing | `worktree create` and `session create` print the new id as the **last line of stdout** for easy `id=$(vrun worktree create ...)` capture. |

---

## REST API

Base URL: `http://localhost:<port>` (default `7421`). v1 is **localhost-bound, no auth**. JSON in/out.

### Health

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/health` | — | `{ ok, version, port, uptime }` | Used by SPA on boot to detect daemon-down state. |

### Projects

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/projects` | — | `Project[]` | |
| POST | `/projects` | `{ path, name?, prefix? }` | `Project` | **CLI-only.** Browser does not call this. |
| DELETE | `/projects/:id` | — | `{ ok }` | Cascade: terminates all sessions, removes worktrees. |

### Worktrees

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/worktrees` | `?project=<id>` | `Worktree[]` | |
| POST | `/worktrees` | `{ projectId, modeId, branch, baseBranch?, prompt? }` | `Worktree` | **`branch` required** (validated git-safe; 409 if already exists; sidebar displays it as the worktree's label). `baseBranch` defaults to project default. **Always spawns the main session** atomically. `prompt?` is the user's task message delivered to the agent on first ready. |
| DELETE | `/worktrees/:id` | — | `{ ok }` | Cascade: terminates all sessions, removes the worktree dir. |
| GET | `/worktrees/:id/tree` | `?path=` | `TreeEntry[]` | Lazy-loaded folder; respects `.gitignore`. |
| GET | `/worktrees/:id/files/*path` | — | file content | 422 if too large or refused binary. |
| GET | `/worktrees/:id/diff/*path` | `?scope=local\|branch` | unified diff text | `local` = working tree vs HEAD; `branch` = vs configured base branch. |

### Sessions (= Tabs)

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/sessions` | `?worktree=<id>` | `Session[]` | |
| POST | `/sessions` | `{ worktreeId, type, modeId?, prompt? }` | `Session` | `type`: `agent` (requires `modeId`) or `terminal`. `prompt?` (agent only) delivered to the new agent via the plugin's `promptDelivery` mode. |
| DELETE | `/sessions/:id` | — | `{ ok }` | Rejected with 400 for the `m` slot (main is un-closeable). |
| POST | `/sessions/:id/resume` | — | `Session` | Spawns new tmux + plugin's restore command for an `exited` session. |
| POST | `/sessions/:id/input` | `{ data, sendEnter? }` | `{ ok }` | **Full-message send** with busy-detect + retry. Used by CLI (`vrun send`). The browser uses WS `session:input` for per-keystroke typing, NOT this endpoint. Implementation uses a named tmux paste buffer (`tmux load-buffer -b _vrun_send-<sid>` + `paste-buffer -b ... -d`) so it does not stomp on the user's clipboard. |

### Modes

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/modes` | — | `Mode[]` | Max 10 per user. |
| POST | `/modes` | `{ name, cli, context, presetId? }` | `Mode` | 409 on duplicate name. |
| PUT | `/modes/:id` | `{ name?, context? }` | `Mode` | `cli` is **immutable** post-create (cli switch would invalidate every session that's already running this mode). |
| DELETE | `/modes/:id` | — | `{ ok }` | 409 if any session currently references this mode. Caller must kill those sessions first. |

### Error codes

| Status | Meaning | Body shape |
|---|---|---|
| 400 | Validation error | `{ error, details }` |
| 404 | Entity not found | `{ error }` |
| 409 | Conflict (duplicate name or prefix) | `{ error, conflictWith }` |
| 422 | File too large / binary refused / preview unavailable | `{ error, reason }` |
| 500 | Internal | `{ error }` |

---

## WebSocket — `/ws`

One connection per browser tab. JSON text frames. Same-origin endpoint.

Two distinct subscription models multiplexed on one socket:
1. **State subscription** (`subscribe`) — receive lifecycle and broadcast events for chosen sessions.
2. **Output stream** (`session:open` / `session:close`) — actively stream pty bytes for a session and accept its keystrokes/resize. Independent of state subscription so a background tab can stay subscribed to state changes without paying the bandwidth cost of output.
3. **File / tree watching** (`file:watch`, `tree:watch`) — push notifications when a watched file or tree mutates on disk. v1 server impl uses `chokidar` with `ignore` for gitignore. Falls back to client-side ETag polling for filesystems where chokidar is unreliable (NFS, SMB, certain Docker mounts).

### Stream attach / scrollback / backpressure

When the client sends `session:open { sessionId, cols, rows }`:
1. Server attaches to the tmux pane (or rejects with `session:error`).
2. Server emits `session:opened { sessionId }`.
3. **Server immediately emits a `session:output` containing `tmux capture-pane -p -S -10000 -e`** — last ~10k lines of scrollback, ANSI-preserving. Without this xterm.js renders blank until the next byte. The client should `term.write()` this chunk just like any other.
4. Then live output streams as `session:output` frames.

Backpressure: if the server's WS write buffer exceeds ~1 MB queued (slow consumer), it disconnects with WS close code `1009 (Message Too Big)`. Client reconnects + re-opens to recover. v1 does not implement application-level flow control.

### Client → Server

| Event | Payload sketch | Purpose |
|---|---|---|
| `subscribe` | `{ sessionIds: [] }` | Receive **state** events (lifecycle, structural) for these sessions. |
| `unsubscribe` | `{ sessionIds: [] }` | |
| `session:open` | `{ sessionId, cols, rows }` | Start streaming **output** for this session; declare initial pty size. |
| `session:input` | `{ sessionId, data }` | Keystrokes → pty stdin. |
| `session:resize` | `{ sessionId, cols, rows }` | Viewport changed → server applies `TIOCSWINSZ`. |
| `session:close` | `{ sessionId }` | Stop streaming output (state subscription unaffected). |
| `file:watch` | `{ worktreeId, path }` | Watch one file (preview pane just opened it). |
| `file:unwatch` | `{ worktreeId, path }` | |
| `tree:watch` | `{ worktreeId, path? }` | Watch tree under `path` (default = worktree root). |
| `tree:unwatch` | `{ worktreeId, path? }` | |
| `ping` | — | Server replies `pong`. |

### Server → Client — per-session (subscribers / open streams, high-frequency)

| Event | Payload sketch | Purpose |
|---|---|---|
| `session:created` | `{ sessionId, worktreeId, type, mode }` | Also delivered when daemon auto-creates main. |
| `session:state` | `{ sessionId, state, reason? }` | `state`: `not_started \| working \| idle \| done \| exited`. |
| `session:opened` | `{ sessionId }` | Stream attached after `session:open`. |
| `session:output` | `{ sessionId, chunk }` | Streaming pty bytes. Encoding TBD (utf8 vs base64-fallback). |
| `session:exited` | `{ sessionId, exitCode? }` | Triggers UI Resume banner. |
| `session:resumed` | `{ sessionId, restoredFromHistory }` | Emitted after `POST /sessions/:id/resume`. |
| `session:deleted` | `{ sessionId }` | |
| `session:error` | `{ sessionId, message }` | Attach / stream failure. |

### Server → Client — file / tree (file or tree watchers only)

| Event | Payload sketch | Purpose |
|---|---|---|
| `file:changed` | `{ worktreeId, path }` | File contents changed → client refetches via REST. |
| `file:deleted` | `{ worktreeId, path }` | File removed. |
| `tree:changed` | `{ worktreeId, path, kind, from?, to? }` | `kind`: `added \| deleted \| renamed`. `from/to` filled for renames. |

Coalescing: server debounces rapid changes (~200ms) so 5 saves in a burst → 1 event. Watchers torn down automatically on socket disconnect.

### Server → Client — broadcast (all clients, low-frequency)

| Event | Payload sketch |
|---|---|
| `project:created` | `{ project }` |
| `project:deleted` | `{ projectId }` |
| `worktree:created` | `{ worktree }` |
| `worktree:deleted` | `{ worktreeId }` |
| `mode:created` | `{ mode }` |
| `mode:updated` | `{ mode }` |
| `mode:deleted` | `{ modeId }` |
| `pong` | — |

---

## Conventions

| Topic | Rule |
|---|---|
| Path params | `:id` = single segment; `*path` = any remaining segments (URL-encoded client-side). |
| Slot identifiers | `m` (main, fixed first), `a{n}` (additional agent), `t{n}` (terminal). `n` series monotonic per worktree per type. |
| ID alphabet | `[a-zA-Z0-9_-]`; project IDs additionally allow `.`. |
| Event scoping | Per-session events go to subscribers only; structural events broadcast to all. |
| Auth | None in v1. v1.1 adds `Authorization: Bearer <token>` on REST + token on WS handshake. |

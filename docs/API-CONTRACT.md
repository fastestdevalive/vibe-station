# vibe-station — API Contract

> Complete surface area: CLI commands, REST endpoints, WebSocket events. Brief by design — exact request/response types live in `apps/cli/src/types.ts` once implemented.

---

## CLI Commands

User-facing binary: `vst`. Subcommand groups follow the noun-verb pattern (`vst project add`, `vst worktree create`).

### Projects

| Command | Args / Flags | Description |
|---|---|---|
| `vst project add` | `<path> [--name=<id>] [--prefix=<prefix>]` | Register a project. Validates git repo + name/prefix uniqueness. |
| `vst project rm` | `<id>` | Remove project (interactive confirm; cascades to sessions + worktrees + dirs). |
| `vst project ls` | `[--json]` | List projects: name · path · #worktrees · #sessions. |
| `vst project info` | `<id> [--json]` | Project details + worktree summary. |

### Worktrees

| Command | Args / Flags | Description |
|---|---|---|
| `vst worktree create` | `<project-id> --branch=<name> --mode=<id> [--base=<branch>] [--prompt=<text>] [--prompt-file=<path>] [--json]` | Create worktree + auto-spawn main session (atomic). `--branch` is required and becomes the sidebar label. `--prompt`/`--prompt-file` is sent to the main agent on first ready. `--json` runs the main agent on the JSON agent-chat channel (`channel: "json"`). Prints the new worktree id on the last line of stdout. |
| `vst worktree rm` | `<worktree-id>` | Remove worktree (terminates all sessions, removes git worktree dir). |
| `vst worktree ls` | `[--project=<id>] [--json]` | List worktrees. `--project` defaults to `$VST_PROJECT` if set. |
| `vst worktree info` | `<worktree-id> [--json]` | Worktree details + all sessions. |

### Sessions (= tabs)

| Command | Args / Flags | Description |
|---|---|---|
| `vst session create` | `<worktree-id> --type=agent\|terminal [--mode=<id>] [--prompt=<text>] [--prompt-file=<path>] [--json]` | Add a session/tab to the worktree. `--mode` required when `--type=agent`. `--prompt`/`--prompt-file` sent to the new agent on first ready (agent type only). `--json` selects the JSON agent-chat channel (`channel: "json"`). Prints new session id. `<worktree-id>` defaults to `$VST_WORKTREE`. |
| `vst session ls` | `[--worktree=<id>] [--project=<id>] [--json]` | List sessions. `--worktree` defaults to `$VST_WORKTREE`. |
| `vst session info` | `<session-id> [--json]` | Session details (slot, type, mode, lifecycle, tmux name). |
| `vst session terminate` | `[session-id]` | Terminate session. Rejected for `m` slot. `<session-id>` defaults to `$VST_SESSION` — the one destructive command that self-targets by default. |
| `vst session attach` | `<session-id>` | Drop into the tmux session interactively. |
| `vst session restore` | `<session-id>` | Resume an `exited` session (calls plugin's restore). |
| `vst session output` | `<session-id> [--lines=<n>]` | Print recent output — pane text (tmux/pty) or assistant prose (Rich Chat/json). Default last 100 lines. Not an event log — see `session transcript`. |
| `vst session transcript` | `<session-id> [--json]` | Print a Rich Chat (json) session's normalized event log (roles, tool calls, turn ids) — not prose. 404s on a tmux/pty session, which has no event log. `--json` emits raw NDJSON events. |
| `vst session send` | `<session-id> [message...] [--file=<path>] [--attach=<path>...] [--queue] [--wait] [--timeout=<ms>]` | Send a message to a session (channel-agnostic). Steers a running Rich Chat turn by default; `--queue` opts out and enqueues FIFO instead. `--attach` stages a file for a Rich Chat turn (repeatable; errors on tmux/pty targets — not silently dropped). `--wait` blocks until the session settles (`idle`/`waiting_for_human`) and prints the reply. |
| `vst session stop` | `<session-id>` | Abort the active Rich Chat turn (queued turns are kept). |

### Modes

| Command | Args / Flags | Description |
|---|---|---|
| `vst mode ls` | `[--json]` | List agent modes. |
| `vst mode add` | `--name=<n> --cli=<claude\|cursor\|opencode> (--context=<text> \| --context-file=<path>) [--preset=<id>]` | Create a mode. |
| `vst mode rm` | `<id>` | Delete a mode. |

### Daemon

| Command | Args / Flags | Description |
|---|---|---|
| `vst daemon start` | — | Forks daemon. Writes PID + port to `~/.vibe-station/config.json`. Auto-picks free port if 7421 is taken. |
| `vst daemon stop` | — | Graceful shutdown. |
| `vst daemon status` | `[--json]` | Running/stopped, port, version, uptime. |
| `vst daemon restart` | — | Stop then start. |

### Browser / status / doctor

| Command | Args / Flags | Description |
|---|---|---|
| `vst open` | `[target]` | Open browser. `target` = session id, worktree id, project id, or `all`. |
| `vst status` | `[--project=<id>] [--json]` | Cross-cutting view of sessions + states across projects. |
| `vst doctor` | — | Health checks (tmux, git, claude/cursor/opencode on PATH). |

### Meta

| Command | Args / Flags | Description |
|---|---|---|
| `vst --version` | — | Print version. |
| `vst --help` | — | Print help. |
| `vst completion` | `<shell>` | Print shell completion script (bash/zsh/fish). |

### Agent-context env vars

When the daemon spawns an agent into a session, it sets these env vars in the agent's process. CLI commands invoked from inside the agent default to these when flags/args are omitted:

| Var | Set to | Used as default for |
|---|---|---|
| `VST_PROJECT` | project id of the agent's worktree | `--project` flags |
| `VST_WORKTREE` | worktree id | `--worktree` flags + `<worktree-id>` arg in `session create` |
| `VST_SESSION` | the agent's own session id | `session terminate`'s `[session-id]` arg — the one deliberate self-targeting exception, see below |
| `VST_DAEMON_URL` | `http://localhost:<port>` | daemon endpoint for the CLI to talk to |

**Destructive commands** (`project rm`, `worktree rm`, `mode rm`) **require explicit ids** — no env-var defaults — to prevent agents accidentally nuking their own context. `session terminate` is the one deliberate exception: it defaults to `$VST_SESSION` so an agent can end itself; the daemon's `isMain` guard (`DELETE /sessions/:id`) still rejects a worktree's main-slot session regardless of how the id was supplied.

### Conventions

| Topic | Rule |
|---|---|
| JSON output | All `ls`, `info`, `status` commands accept `--json`. Output is a single JSON value on stdout. Stderr is reserved for warnings. |
| Exit codes | `0` success · `1` generic failure · `2` not-found · `3` conflict (duplicate / collision) · `4` daemon-down · `5` unauthorized (v1.1) |
| ID printing | `worktree create` and `session create` print the new id as the **last line of stdout** for easy `id=$(vst worktree create ...)` capture. |

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
| POST | `/worktrees` | `{ projectId, modeId, branch, baseBranch?, prompt?, channel? }` | `Worktree` | **`branch` required** (validated git-safe; 409 if already exists; sidebar displays it as the worktree's label). `baseBranch` defaults to project default. **Always spawns the main session** atomically. `prompt?` is the user's task message delivered to the agent on first ready. `channel?: "tmux"\|"pty"\|"json"` selects the main agent's execution channel (`json` = agent chat). |
| DELETE | `/worktrees/:id` | — | `{ ok }` | Cascade: terminates all sessions, removes the worktree dir. |
| GET | `/worktrees/:id/tree` | `?path=` | `TreeEntry[]` | Lazy-loaded folder; respects `.gitignore`. |
| GET | `/worktrees/:id/file-list` | — | `{ files: string[], truncated: boolean, source: "ripgrep" \| "node" }` | Flat file list for Quick Open / fuzzy search. Uses `rg --files` when available (respects nested `.gitignore`); falls back to a Node walker that reads only the root `.gitignore`. Caps at 100k entries; sets `truncated: true` on overflow. |
| GET | `/worktrees/:id/files/*path` | — | file content | 422 if too large or refused binary. |
| GET | `/worktrees/:id/diff/*path` | `?scope=local\|branch` | unified diff text | `local` = working tree vs HEAD; `branch` = vs configured base branch. |

### Sessions (= Tabs)

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/sessions` | `?worktree=<id>` | `Session[]` | |
| POST | `/sessions` | `{ worktreeId \| (target:"direct", projectId), type, modeId?, prompt?, channel? }` | `Session` | `type`: `agent` (requires `modeId`) or `terminal`. `prompt?` (agent only) delivered to the new agent via the plugin's `promptDelivery` mode. `channel?: "tmux"\|"pty"\|"json"` — `json` forces `useTmux=false` and renders as agent chat. |
| DELETE | `/sessions/:id` | — | `{ ok }` | Rejected with 400 for the `m` slot (main is un-closeable). For a JSON session, aborts any active turn + kills its process group before purge. |
| POST | `/sessions/:id/resume` | — | `Session` | Spawns new tmux + plugin's restore command for an `exited` session. |
| POST | `/sessions/:id/send` | `{ data, sendEnter?, attachmentIds?, queue? }` | `{ ok }` | **Full-message send**, channel-agnostic: tmux/pty → named paste buffer (`tmux load-buffer -b _vst_send-<sid>` + `paste-buffer -b ... -d`, so it does not stomp on the user's clipboard); json → enqueues/steers a chat turn (steers by default unless `queue: true`). `attachmentIds` json-only — 400 on a tmux/pty target. Used by CLI (`vst session send`). There is no `/input` alias; the browser's WS `session:input` (per-keystroke typing) is a separate path. |
| GET | `/sessions/:id/output` | `?lines=<n>` | `{ id, output: string }` | Recent output, channel-agnostic: tmux/pty pane capture, or json assistant prose (bounded by turns, not lines). Default `lines=100`, capped at 10000. Not an event log — see `/sessions/:id/transcript`. |

### JSON agent chat (`channel: "json"` sessions)

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| POST | `/sessions/:id/chat` | `{ message, attachmentIds? }` | `202 { turnId, queuePosition }` | **Always accepted** — never 409. Queued FIFO behind a running turn. 400 on empty message / unknown attachment; 404 unknown session. |
| POST | `/sessions/:id/chat/stop` | — | `{ ok }` | Aborts the **active** turn (queued turns kept). 409 if no JSON agent has run; no-op 200 when only queued turns exist. |
| DELETE | `/sessions/:id/chat/queue/:turnId` | — | `{ ok }` | Cancels one not-yet-started queued turn. 404 if not queued. |
| POST | `/sessions/:id/attachments` | `multipart/form-data` `files[]` | `201 { attachments: Attachment[] }` | Saved under `sessionDataDir/uploads/` (outside the checkout). 413 too big; 400 no files. |
| GET | `/sessions/:id/transcript` | — | `{ events: NormalizedEvent[] }` | Full normalized history (replay / fallback). **404** if the target session's channel is not `json` (a tmux/pty session has no event log — was previously a convincing empty `200 {events:[]}`). |
| GET | `/sessions/:id/meta` | — | `SessionMeta` | Latest tokens/model/turn-state/queueDepth; rebuilt from the transcript tail after a restart. `meta.commands?: { name, description, argumentHint? }[]` is the session's slash-command/skill catalog — the CLI's own ACP `available_commands_update` (full-replace, captured in-turn AND out-of-band) merged per-field with the directories scanned from `skillPaths`: on a name collision ACP wins `description`/`argumentHint`, and directory-only entries are withheld from CLIs whose plugin cannot dispatch them. Absent until either source has answered; `[]` once one has and the catalog is genuinely empty. |

### Settings & Skills

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/settings` | — | `{ defaultProjectsDir, homeDir, skillPaths }` | User settings from `~/.vibe-station/config.json`, with defaults filled in for missing fields (`skillPaths` defaults to `~/.claude/skills` + `~/.gemini/skills`). |
| PATCH | `/settings` | `{ defaultProjectsDir?, skillPaths? }` | `{ ok }` | Both fields must be absolute paths — 400 otherwise. `skillPaths` is deduped on write and triggers an immediate rescan + rewatch of the new directory set (awaited, so a following `GET /skills` sees the fresh scan). |
| GET | `/skills` | — | `{ skills: Skill[], directories: SkillDirectory[] }` | Settings-panel view of the DIRECTORY-scanned user skill catalog (`<dir>/<name>/SKILL.md` under each `skillPaths` entry). `Skill = { name, description, argumentHint?, path }`. **Never returns a 4xx/5xx for a scan problem** — a per-directory outcome is reported in `directories[]` instead: `{ path, skillCount, error?, missing? }`, where `missing: true` (directory absent) is normal for a shipped default whose CLI is not installed and is not an error. The composer's `/` popover does NOT read this route — it reads `SessionMeta.commands`, which is the merged (ACP + directory) view. |

### Modes

| Method | Path | Query / Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/modes` | — | `Mode[]` | Max 10 per user. |
| POST | `/modes` | `{ name, cli, context, presetId? }` | `Mode` | 409 on duplicate name. |
| PUT | `/modes/:id` | `{ name?, context? }` | `Mode` | `cli` is **immutable** post-create (cli switch would invalidate every session that's already running this mode). |
| DELETE | `/modes/:id` | — | `{ ok }` | 409 if any session currently references this mode. Caller must terminate those sessions first. |

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
| `chat:open` | `{ sessionId }` | Subscribe to a JSON session's normalized event stream → triggers a `chat:replay` + initial `session:meta`. |
| `chat:close` | `{ sessionId }` | Unsubscribe from the JSON event stream. |
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
| `chat:replay` | `{ sessionId, events: NormalizedEvent[] }` | Full JSON transcript on `chat:open`. |
| `session:message` | `{ sessionId, event: NormalizedEvent }` | One live normalized JSON-chat event (user/thinking/text/tool_use/tool_result/result/error). |
| `session:meta` | `{ sessionId, meta: SessionMeta }` | JSON-chat usage/model/turn-state/queueDepth update. Also fires on a `commands_update` (and only on that event kind, including out-of-band before turn 1) so the composer's skill catalog stays current. |

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

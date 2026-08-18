# Session Execution Modes

Each session has an execution **channel**: `tmux`, `pty`, or `json`. Legacy rows carry only `useTmux: boolean` (default `true`); the daemon derives the channel via `sessionChannel(session)` (`useTmux ? "tmux" : "pty"`, or `"json"` when explicitly set). The TTY channels (`tmux`/`pty`) share the same REST/WS terminal API surface — the branching is internal to the daemon. The `json` channel is a **structured agent chat** (no TTY) with its own REST/WS surface (see below).

## tmux mode (default)

```
daemon
  └─ tmux new-session -d -s <name>
       └─ agent / shell process
            ↑ input via tmux send-keys
            ↓ output via capture-pane + pty stream
```

- Survives daemon restarts — tmux server keeps running independently.
- Resume = `tmux attach-session` on the existing session.
- Lifecycle poller uses `tmux has-session` + `capture-pane` to detect idle/done/exited.

## direct-pty mode (`useTmux: false`)

```
daemon
  └─ node-pty spawn
       └─ agent / shell process
            ↑ input via pty.write()
            ↓ output via pty data events → WS stream
```

- Process is a direct child of the daemon — dies when the daemon stops.
- No resume across daemon restarts; session goes to `exited` on boot sweep.
- Lower overhead; no tmux dependency required on the host.
- Lifecycle poller uses process exit code + pty output heuristics (no `capture-pane`).

## What changes between modes

| Concern | tmux | direct-pty |
|---|---|---|
| Spawn | `tmux new-session` | `node-pty` fork |
| Input | `tmux send-keys` | `pty.write()` |
| Output stream | `tmuxOutput.ts` | `directPtyOutput.ts` |
| Lifecycle check | `tmux has-session` | process `exitCode` |
| Survive daemon restart | yes | no |
| Resume | `getRestoreCommand` → send-keys | fresh spawn only |

The web UI and WS protocol are identical for both TTY modes — `session:open`, `session:input`, `session:resize`, `session:close` work the same way regardless of mode.

## json mode (`channel: "json"`)

```
daemon
  └─ child_process.spawn (piped stdio, no PTY/tmux)  ── one process per TURN
       └─ CLI harness --output-format stream-json
            ↑ user message on stdin (per turn), resumed via the harness chat id
            ↓ NDJSON on stdout → parsed → NormalizedEvent[] → WS + messages.jsonl
```

- **Structured, not a TTY.** Renders in the web UI's `ChatPane` (message list + composer + status bar) instead of `TerminalPane`. `channel: "json"` forces `useTmux = false`.
- **Per-turn spawn.** No live process between turns; the conversation resumes via the persisted `agentChatId`. Survives daemon restarts (stateless between turns) — a `working` JSON session reconciles to `idle` on boot; a running turn's child is killed (orphan-safe, Decision 13). How `agentChatId` is obtained/kept correct differs per CLI (pre-mint, hook, or log-file inference) and across the JSON↔terminal toggle — see [AGENT-CHAT-ID-CAPTURE.md](./AGENT-CHAT-ID-CAPTURE.md).
- **Plugin-owned normalization.** Each `AgentPlugin.runTurn()` yields provider-agnostic `NormalizedEvent`s; the daemon core never parses raw CLI JSON.
- **Transcript.** Every event is appended to `messages.jsonl` under `sessionDataDir` and replayed on `chat:open`. `SessionMeta` (tokens/model/turn-state) rebuilds from the transcript tail after a restart. How each CLI reports token usage (and which fields the daemon has to reshape vs. compute itself) differs per CLI — see [TOKEN-USAGE.md](./TOKEN-USAGE.md).
- **Attachments.** Files upload under `sessionDataDir/uploads/` (outside the checkout), cleaned automatically with the session; absolute paths are injected into the message.
- **Turn queue.** The daemon owns a per-session FIFO queue (`POST /chat` is always accepted, `202`); turns run strictly sequentially.

| Concern | tmux | direct-pty | json |
|---|---|---|---|
| Spawn | `tmux new-session` | `node-pty` fork | `child_process.spawn` per turn |
| Input | `tmux send-keys` | `pty.write()` | stdin per turn (`POST /chat`) |
| Output | `tmuxOutput.ts` | `directPtyOutput.ts` | NDJSON → `NormalizedEvent` (WS `session:message`) |
| Web pane | `TerminalPane` | `TerminalPane` | `ChatPane` |
| Survive restart | yes | no | yes (resume via chat id) |

## Retiring a session: `done` vs `delete`

Both go through one shared teardown — `releaseSessionRuntime()`
(`daemon/src/services/sessionRuntime.ts`) — which frees every LIVE resource a
session holds and touches nothing on disk:

| Freed by `releaseSessionRuntime` | Kept |
|---|---|
| tmux pane (and the agent CLI process tree under it) | `SessionRecord` in the manifest, incl. `agentChatId` |
| direct-pty child (`useTmux: false`) | session data dir (system prompt, transcript SQLite) |
| `JsonAgentSession`: in-flight turn's process group, turn queue, SQLite WAL handle (3 fds), stream listeners | the worktree checkout |
| lifecycle poller's idle-hash entry | the CLI's own history (`~/.claude/projects/<slug>/<uuid>.jsonl`) |
| staged attachments — **only** with `{ clearAttachments: true }` (delete does; done does not) | |

- `POST /sessions/:id/done` — release + mark `done`. Agent sessions only (400 for
  terminals). Idempotent.
- `POST /worktrees/:id/done` — same for every agent in the worktree, plus every
  TERMINAL session (released and marked `exited`, since terminals have no `done`
  state). Returns `{ ok, updated, terminalsReleased }`.
- `DELETE /sessions/:id` / `DELETE /worktrees/:id` — the same release, then the
  destructive part (data dir, manifest record, optionally the checkout).

### Coming back

- TTY session → `POST /sessions/:id/resume` (`getRestoreCommand` → `--resume <agentChatId>`
  in a fresh pane). The UI surfaces this as the "Session marked done. / Resume"
  banner, which `TerminalPane` renders for `done` exactly as it does for `exited`.
- JSON session → just send a message; `POST /sessions/:id/chat` re-creates the
  `JsonAgentSession` and flips the lifecycle back to `working`. Read-only paths
  (`chat:open`, `GET /transcript`, `GET /meta`) deliberately serve a done session
  from disk WITHOUT re-creating the agent, so browsing a done chat does not undo
  the release. `PATCH /chat/model` refuses with `409` for the same reason.

### What must never demote `done`

`done` is deliberate and terminal, and three code paths would otherwise write
over it — all three now check for it explicitly:

1. The lifecycle poller's dead-pane detection (`lifecycle.ts` — skips `done`).
2. `markSessionExited`, which `DirectPtyStream.onExit` fires when the release
   kills the pty child.
3. `JsonAgentSession`'s drain, whose `finally` persists a trailing `idle` as the
   aborted turn unwinds — suppressed by the `released` latch that `release()`
   sets before it aborts anything.

### Every retire path, and what it frees

| User action | Endpoint | Releases runtime? | Record kept? |
|---|---|---|---|
| Session menu → **Mark as done** (agents, worktree AND direct) | `POST /sessions/:id/done` | yes | yes — resumable |
| Session menu → **Terminate** | `DELETE /sessions/:id` | yes | no — record + data dir removed |
| Worktree menu → **Mark as done** | `POST /worktrees/:id/done` | yes, every agent + terminal | yes |
| Worktree menu / dashboard → **Dismiss (keep files)** | `DELETE /worktrees/:id` | yes, every session | no — checkout stays on disk |
| Worktree menu → **Delete worktree…** | `DELETE /worktrees/:id?purge=true` | yes | no — checkout removed too |
| Terminal/agent tab **×** (Terminate) | `DELETE /sessions/:id` | yes | no |
| Project menu → **Hide project** | `PATCH /projects/:id` | **NO** — everything keeps running | yes |

- "Terminate"/"Dismiss" are never client-side — every variant is a real daemon delete.
- `POST /sessions/:id/done` works for direct (project-level) sessions too: `findSessionContext` resolves both, and `releaseSessionRuntime` branches on `useTmux`, not on worktree-ness.
- There is no bulk retire for a project's direct sessions (no `POST /projects/:id/done`) — the only bulk path is the worktree one.

### Retiring mid-spawn

- An agent spawn takes seconds, and the user can mark done inside that window.
- Both spawn jobs (`runAgentSpawnJob`, `runDirectAgentSpawnJob`) re-check the session's CURRENT state before their completion write, via `releaseIfRetiredDuringSpawn`. If it is `done` (or the record is gone), they release whatever the spawn just created and skip the write — otherwise the job would clobber `done` with `working`/`exited` AND leak the pane it created after the release ran.
- `startJsonCreateTurn` (the auto-enqueued turn 1) is likewise suppressed for a session already marked `done`, so a retired session never starts spending tokens on its own. A deliberate `POST /chat` is still the resume path.

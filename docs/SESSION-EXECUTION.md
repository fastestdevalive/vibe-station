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
- **Per-turn spawn.** No live process between turns; the conversation resumes via the persisted `agentChatId`. Survives daemon restarts (stateless between turns) — a `working` JSON session reconciles to `idle` on boot; a running turn's child is killed (orphan-safe, Decision 13).
- **Plugin-owned normalization.** Each `AgentPlugin.runTurn()` yields provider-agnostic `NormalizedEvent`s; the daemon core never parses raw CLI JSON.
- **Transcript.** Every event is appended to `messages.jsonl` under `sessionDataDir` and replayed on `chat:open`. `SessionMeta` (tokens/model/turn-state) rebuilds from the transcript tail after a restart.
- **Attachments.** Files upload under `sessionDataDir/uploads/` (outside the checkout), cleaned automatically with the session; absolute paths are injected into the message.
- **Turn queue.** The daemon owns a per-session FIFO queue (`POST /chat` is always accepted, `202`); turns run strictly sequentially.

| Concern | tmux | direct-pty | json |
|---|---|---|---|
| Spawn | `tmux new-session` | `node-pty` fork | `child_process.spawn` per turn |
| Input | `tmux send-keys` | `pty.write()` | stdin per turn (`POST /chat`) |
| Output | `tmuxOutput.ts` | `directPtyOutput.ts` | NDJSON → `NormalizedEvent` (WS `session:message`) |
| Web pane | `TerminalPane` | `TerminalPane` | `ChatPane` |
| Survive restart | yes | no | yes (resume via chat id) |

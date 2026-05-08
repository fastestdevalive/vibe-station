# Session Execution Modes

Each session has a `useTmux: boolean` flag (default `true`). The two modes share the same REST/WS API surface — the branching is internal to the daemon.

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

The web UI and WS protocol are identical for both — `session:open`, `session:input`, `session:resize`, `session:close` work the same way regardless of mode.

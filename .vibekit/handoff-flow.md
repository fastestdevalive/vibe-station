# Session reset `--handoff` flow (as currently implemented)

Rewritten after the `--handoff-file` redesign (see
`.vibekit/feature-plans/wip/session-tab-ux-fixes/plan-session-tab-ux-fixes.md`,
Phase 1). The old self-write flow relied on the daemon and the agent
independently agreeing on a fixed filesystem path (`.vibe-station/HANDOFF.md`)
with a 30s freshness window to disambiguate a fresh write from a stale
leftover — that coordination problem no longer exists. See
`daemon/src/services/handoff.ts` and the `POST /sessions/:id/reset` /
`POST /sessions/:id/handoff` handlers in `daemon/src/routes/sessions.ts`.

```mermaid
sequenceDiagram
    participant User
    participant Agent as Outgoing agent<br/>(in the session being reset)
    participant OwnFile as Any file the agent<br/>chooses itself
    participant CLI as vst CLI
    participant Daemon
    participant NewAgent as New agent<br/>(replacement session)

    rect rgba(0,0,0,0)
    Note over User,NewAgent: Path A — in-chat "/vst reset --handoff" (self-write, no daemon coordination)
    User->>Agent: types "/vst reset --handoff"
    Note over Agent: Claude's custom /vst command instructs:<br/>write a summary to ANY file, then run<br/>`vst session reset --handoff-file <path>`
    Agent->>OwnFile: writes its summary directly<br/>(normal file-write tool call)
    Agent->>CLI: vst session reset $VST_SESSION --handoff-file <path><br/>(NOT --handoff)
    CLI->>OwnFile: reads the file locally (resolveFileOrInline)
    CLI->>Daemon: POST /sessions/:id/reset { handoffText: "..." }
    Daemon->>Daemon: handoffText used directly — no file lookup,<br/>no runHandoffTurn, no polling
    Daemon->>Agent: kill old pane/process, archive session
    Daemon->>NewAgent: spawn with taskPrompt = handoffText (+ any --prompt)<br/>name is UNCHANGED — handoffText never feeds slugifyPrompt
    NewAgent-->>User: starts already knowing the handoff summary
    end

    rect rgba(0,0,0,0)
    Note over User,NewAgent: Path B — UI "Reset with handoff" button (only remaining paste+poll case)
    User->>Daemon: POST /sessions/:id/reset { handoff: true }<br/>(no handoffText — different pane, not blocked)
    Daemon->>Daemon: generate a one-off random /tmp path<br/>(join(tmpdir(), `vst-handoff-<random>.md`))
    Daemon->>Agent: pasteBuffer(tmuxName, handoffInstruction(path))<br/>"write a summary to <path>, then reply"
    Agent->>Daemon: writes the file in response
    Daemon->>Daemon: poll the SAME path (up to 60s)
    Daemon->>Daemon: newInitialPrompt = handoffText + prompt
    Daemon->>NewAgent: spawn with taskPrompt = newInitialPrompt
    end

    rect rgba(0,0,0,0)
    Note over User,NewAgent: Path C — self-targeted --handoff (now rejected loudly, client-side)
    User->>Agent: "reset --handoff" (asked conversationally,<br/>or agent runs the CLI directly instead of self-writing)
    Agent->>CLI: vst session reset $VST_SESSION --handoff
    CLI->>CLI: opts.handoff && id === process.env.VST_SESSION<br/>-> die() immediately, exit code 1, points at --handoff-file
    Note over CLI,Daemon: No daemon call is made — the CLI is the only<br/>party that knows it's running inside the target session
    end
```

## Key facts

- The "send the summary as the new agent's initial prompt" behavior **already
  exists** and works automatically whenever `handoffText` is non-null:
  `daemon/src/routes/sessions.ts`'s reset handler builds
  `newInitialPrompt = [handoffText, prompt].filter(Boolean).join(...)` and
  passes it through as `taskPrompt` (`promptBuilder.ts`), which becomes the
  new agent's actual first message.
- `handoffText` and `prompt` are deliberately **separate** fields end to end
  (CLI flag, request body, route handling) — only `prompt` ever feeds
  `slugifyPrompt` for the new session's name. Reusing `--prompt-file` for a
  handoff summary would have produced a garbage session name; `--handoff-file`
  avoids that entirely.
- No env var and no `spawn.ts` changes anywhere in this design — the self-write
  path never needs the daemon to tell the agent a path; the agent picks its
  own and the CLI carries it over like any other `--*-file` flag
  (`cli/src/lib/text-source.ts`'s `resolveFileOrInline`, fail-loud on an
  unreadable file).
- The UI-driven paste+poll path (Path B) is the only remaining
  filesystem-based case. It generates a fresh random `/tmp` path per call and
  reads it back within the same request handler — "the file exists" is proof
  enough, no freshness window needed, since nothing else could ever have
  written to that exact random path.
- Path C fails **loudly** now: `vst session reset $VST_SESSION --handoff`
  exits non-zero with a message pointing at `--handoff-file`, before making
  any daemon call — no more silent 60s timeout producing a handoff-less reset.

## Status

All candidate follow-up fixes from the original investigation are implemented:
1. ~~Move the handoff file to a unique path under `/tmp`~~ — done for the one
   remaining filesystem-based case (Path B); the self-write case (Path A) no
   longer touches a daemon-known path at all.
2. ~~Make Path C fail loudly~~ — done via the CLI's client-side self-target
   guard in `cli/src/commands/session/reset.ts`.

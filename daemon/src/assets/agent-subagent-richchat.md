---

## Subagents (Rich Chat only)

You are running in Rich Chat, so a session you spawn shows up as a **subagent**
— a visible row above the user's composer, one they can open and watch, right
next to this conversation.

**To spawn one, run this shell command:**

```bash
vst session create $VST_WORKTREE --type=agent --prompt "the sub-task"
```

That is the whole thing. No flags to look up, no tool to find.

- **"Subagent" from the user means THIS, not your in-harness tool.** If the
  user asks you to "spawn a subagent", "create a vst subagent", "start an
  agent to do X", or corrects you with "I wanted a vst subagent" — they mean
  the shell command above. Your own `Task`/`Agent` tool is NOT a vst subagent:
  it runs inside this conversation, creates no session, and the user cannot
  see or open it. Do not go looking through your tool list for a way to spawn
  a session; there is no tool for it, only the command above.
- **When to use which.** Use `Task` for a short internal lookup whose result
  you will consume within this same turn. Spawn a vst subagent for anything
  the user might want to watch, open, or keep running — and ALWAYS when the
  user asked for a subagent by name, regardless of how small the task is.
- **Your turn ends when you stop writing, and nothing will resume it.** So
  never say "I'll check back once it's done" or "I'll report when it
  finishes" — you cannot. There is no timer, no callback, and no one wakes
  you. After you spawn a subagent you have exactly two honest options:
  - **Block on it, now, inside this turn:** poll until it stops changing.
    ```bash
    vst session output <subagent-id>      # its work so far; repeat to poll
    ```
  - **Hand off:** tell the user the subagent is running, name its id, say
    what to look for, and stop. The user can open its row and watch it.

  Pick one and say which. Silently ending your turn with a promise to follow
  up is the one thing that leaves the user waiting forever.
- **Linking is automatic.** Do NOT pass `--source-agent`/`--parent` yourself —
  `vst session create`/`vst worktree create` already default it from
  `$VST_SESSION`, which is your own id. Passing it explicitly adds nothing.
- **Mode and channel are inherited.** A subagent you spawn in your own
  worktree runs the same mode and the same Rich Chat channel as you, unless
  the user's instruction says otherwise (e.g. "review this in opus mode" —
  then pass `--mode` explicitly). You do not need to pass `--mode` or `--json`
  to get a Rich Chat sibling.
- **You own its lifecycle.** The user does not know when a subagent's work is
  done — you do. Once you've consumed a subagent's output (read its result,
  merged its change, etc.), terminate it:

  ```bash
  vst session terminate <subagent-id>
  ```

  Its row and tab disappear once you do. Leaving it running after its task is
  done is a resource leak that only you are positioned to notice.

Spawn one exactly like any other session — there is no separate command for
"spawn a subagent". What makes it a subagent is nothing more than "you
spawned it while running in Rich Chat".

**Prefer Case B** (`vst session create $VST_WORKTREE ...`). Only Case B
inherits your mode and channel, so it is the one where you can omit `--mode`
and `--json`. `vst worktree create` (Case A) does NOT inherit either — pass
`--mode=<modeId> --json` explicitly there, or you will get a terminal session
in another worktree, which cannot be opened from your subagent row.

---

## Subagents (Rich Chat only)

You are running in Rich Chat, so a session you spawn shows up as a **subagent**
— a visible row above the user's composer, one they can open and watch, right
next to this conversation.

- **Linking is automatic.** Do NOT pass `--source-agent`/`--parent` yourself —
  `vst session create`/`vst worktree create` already default it from
  `$VST_SESSION`, which is your own id. Passing it explicitly adds nothing.
- **Mode and channel are inherited.** A subagent you spawn in your own
  worktree runs the same mode and the same Rich Chat channel as you, unless
  the user's instruction says otherwise (e.g. "review this in opus mode" —
  then pass `--mode` explicitly). You do not need to pass `--mode` or `--json`
  to get a Rich Chat sibling.
- **When to delegate to a subagent vs. your own in-harness tool:** spawn a VST
  subagent for a sub-task worth the user watching independently — something
  that runs long, that the user may want to open and check on, or that should
  keep running after this conversation moves on. For a short lookup or a
  one-off internal step, use your own `Task` tool instead; that stays inside
  this conversation and never needs a session of its own.
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

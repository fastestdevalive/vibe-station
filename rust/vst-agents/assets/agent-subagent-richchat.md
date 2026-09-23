---

## Subagents (Rich Chat only)

You are running in Rich Chat, so a session you spawn shows up as a **subagent**
— a visible row above the user's composer, one they can open and watch, right
next to this conversation.

**To spawn one, run this shell command:**

```bash
vst agent create $VST_WORKTREE --prompt "the sub-task"
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
- **Automatic wake-up on completion or blocked state.** When a linked subagent
  enters `waiting_for_human` (e.g. finishes its turn, asks a question, or
  needs input), the daemon automatically wakes you once you are idle with:
  `<subagent-name> is waiting for your reply`.
  When woken up:
  1. Inspect the subagent's progress: `vst agent output <subagent-id> --lines=100`.
  2. Send further instructions if needed: `vst agent send <subagent-id> "..."`.
  3. Once the subagent's task is fully complete, terminate it: `vst agent terminate <subagent-id>`.
  4. Report back to the user on what was accomplished.
  If you need immediate results inside the current turn rather than waiting for the wake-up turn, you can poll with `vst agent output <subagent-id>`.
- **Linking is automatic.** `--parent` defaults to `$VST_SESSION` (your own id)
  when you run from an agent session, or you can pass `--parent="$VST_SESSION"`
  explicitly. To create an unlinked sibling instead, pass `--no-parent`.
- **Mode and channel are inherited.** A subagent you spawn in your own worktree
  (or project) inherits your mode and channel by default, unless the user's
  instruction specifies a different mode (e.g. "review this in opus mode" — then
  pass `--mode=<modeId>` explicitly).
- **Direct sessions and worktree sessions.** If you have `$VST_WORKTREE` set,
  spawn with `vst agent create $VST_WORKTREE ...`. If running directly in a
  project without a worktree, spawn with `vst agent create --project=$VST_PROJECT ...`.
- **You own its lifecycle.** The user does not know when a subagent's work is
  done — you do. Once you've consumed a subagent's output (read its result,
  merged its change, etc.), terminate it:

  ```bash
  vst agent terminate <subagent-id>
  ```

  Its row and tab disappear once you do. Leaving it running after its task is
  done is a resource leak that only you are positioned to notice.

Spawn one exactly like any other agent session — there is no separate command
for "spawn a subagent". What makes it a subagent is nothing more than "you
spawned it while running in Rich Chat".

**Prefer Case B** (`vst agent create $VST_WORKTREE ...`). Only Case B
inherits your mode and channel, so it is the one where you can omit `--mode`
and `--channel`. `vst worktree create` (Case A) does NOT inherit either — pass
`--mode=<modeId> --channel=json` explicitly there, or you will get a
tmux-channel session in another worktree, which cannot be opened as Rich Chat
from your subagent row.

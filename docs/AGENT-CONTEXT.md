# Agent Context Delivery

How vibe-station gets context into an agent session at spawn time and keeps it accessible during the session.

## Layered system prompt

Three layers composed at spawn:

```
L1  skill.md          — base vst CLI instructions, git workflow rules
L2  project/worktree  — project name+path, branch, baseBranch, sibling sessions,
                        mode-specific context
L3  AGENTS.md         — project-level rules read from <worktree>/AGENTS.md
```

Combined into `{ systemPrompt, taskPrompt? }` and delivered per plugin:

| Plugin | systemPrompt delivery | taskPrompt delivery |
|---|---|---|
| claude | `--system-prompt-file <tmpfile>` arg | sent post-launch via pty after ready signal |
| cursor / opencode | full blob via tmux send-keys after ready signal | appended to same blob |

The ready signal is plugin-defined: either a sentinel substring in pty output (e.g. `"Claude>"`) or a fallback timeout.

## Skill file on disk

`skill/skill.md` is copied (not symlinked) into `<worktree>/.vibe-station/skill.md` at spawn. Agents can re-read it during long sessions without a round-trip to the daemon.

For claude, a PostToolUse hook is written into `<worktree>/.claude/settings.json` so skill context is re-injected automatically on every tool call.

## Chat ID capture (for Resume)

```
daemon spawns agent
  └─ agent writes its own session file (e.g. ~/.claude/projects/.../sess.jsonl)
  └─ daemon polls getActivityState(session)
       └─ plugin reads session file → extracts chat/session UUID
       └─ daemon stores UUID in session record (transcriptRef)

On Resume:
  daemon calls getRestoreCommand(session)
    claude   → "claude --resume <UUID>"        restoredFromHistory: true
    opencode → "opencode --session <UUID>"     restoredFromHistory: true (if captured)
    cursor   → null → fresh launch             restoredFromHistory: false
```

If `restoredFromHistory: false`, the UI surfaces an inline note on the tab so the user knows history wasn't restored.

## Env vars injected on every spawn

```
VST_SESSION     session id
VST_WORKTREE    worktree id
VST_PROJECT     project id
VST_DATA_DIR    ~/.vibe-station/projects/<project-id>
VST_DAEMON_URL  http://127.0.0.1:<port>
```

Agents use these to call `vst send`, `vst session output`, etc. without needing to know their own identity.

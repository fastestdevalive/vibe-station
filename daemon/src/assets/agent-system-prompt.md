# vibe-station Agent Skill

You are a coding agent managed by **vibe-station** (`vst`).
Depending on how you were spawned, you are either working in an isolated git worktree on your own branch, or directly in the project directory (a "direct session") — check the **Context** section injected below this file for which one you are. Your job is to complete the task described in your initial prompt, then stop cleanly.

---

## Your environment

| Variable | What it is |
|---|---|
| `VST_PROJECT` | Project id you belong to |
| `VST_WORKTREE` | Your worktree id (your isolated git checkout) — **worktree sessions only**, absent for direct sessions |
| `VST_SESSION` | Your own session id |
| `VST_DATA_DIR` | `~/.vibe-station/projects/<project-id>` — daemon data dir |
| `VST_DAEMON_URL` | `http://localhost:<port>` — daemon REST API |

If you have a `$VST_WORKTREE` (see Context below), your working directory is that worktree checkout and your branch was already created for you — do not switch branches. If you don't, you're a direct session working in the project directory itself, on whatever branch is already checked out — edit files there directly.

---

## Standard workflow

Follow this sequence for every task unless the initial prompt says otherwise:

1. **Read context** — check for `AGENTS.md` or `.vibe-station/rules.md` in the project root. If present, follow all rules there first.
2. **Understand the task** — re-read your initial prompt. If it is ambiguous, make a conservative interpretation and proceed; note assumptions in your commit message.
3. **Make changes** — edit files in your working directory (the worktree checkout, or the project directory for a direct session). Run tests as you go.
4. **Verify** — run the project's test suite and linter. Fix failures before committing.
5. **Commit** — commit with a clear, descriptive message. Reference the task or issue if known.
6. **Stop when done** — when complete, your process exits, which marks the session `exited` in the UI (not `done` — `done` is a separate explicit action; see "Ending your session" below). For a worktree agent whose task is fully finished, letting the process exit naturally is still the normal way to stop.

Do not open a PR unless the task explicitly asks for one or the project's `AGENTS.md` requires it.

---

## Git rules (worktree sessions only — skip this section if you're a direct session)

- Work only on your assigned branch (`git branch --show-current` to confirm).
- Commit frequently — small, focused commits are better than one large one.
- Never force-push or push to `main`/`master`/the base branch.
- To sync with the base branch: `git fetch origin && git rebase origin/<baseBranch>`.
- If you need the base branch name: `echo $VST_WORKTREE` then `vst worktree info $VST_WORKTREE --json | jq .baseBranch`.

---

## `vst` CLI reference

Use `vst` to inspect state and coordinate with sibling sessions.

### Inspect (worktree sessions only, unless noted)

```bash
# Your worktree details (branch, baseBranch, sessions)
vst worktree info $VST_WORKTREE --json

# All sessions in your worktree
vst session ls --worktree=$VST_WORKTREE --json

# Resolve a UI-set session name to its id (e.g. before sending it a message —
# see "Send a message to a session" below). Names are set by users in the web
# UI and are not guaranteed unique; `.[0]` picks the first match.
vst session ls --worktree=$VST_WORKTREE --name="<name>" --json | jq -r '.[0].id'

# Your own session details (id, type, mode, state — ids are opaque strings
# returned by vst, not something to construct yourself)
vst session info $VST_SESSION --json

# Recent output from another session
vst session output <session-id> --lines=50

# Follow another session's output live
vst session output <session-id> --follow
```

### Spawn more work

There are two distinct operations. Pick the right one — they are not interchangeable. Direct sessions cannot spawn sibling sessions via the CLI today (`vst session create` requires a worktree id) — see Case B.

#### Case A — a NEW worktree (separate branch, isolated checkout)

```bash
# Creates the worktree AND its main agent session in ONE command.
vst worktree create $VST_PROJECT --mode=<modeId> --branch=<name> --prompt="the task"
```

**The main session is created automatically.** Do NOT follow this with
`vst session create` — that would add a redundant second session. One
`vst worktree create` call = one worktree + one ready-to-work agent.

`$VST_PROJECT` is your own project id. To target a different project, list them
with `vst project ls --json`.

#### Case B — an extra session in the PROVIDED worktree (same branch/checkout; worktree sessions only)

```bash
# Adds a sibling agent tab to the given worktree.
vst session create $VST_WORKTREE --type=agent --mode=<modeId> --prompt="your sub-task"

# Add a plain terminal tab.
vst session create $VST_WORKTREE --type=terminal
```

Use this only when the work should share an existing git checkout. Sibling
sessions coordinate via files (e.g. write a spec file, let the sibling implement it).

### Send a message to a session

If you only know a session by its UI-set display name (e.g. "send a message
to reviewer"), resolve it to an id first — don't guess or construct one:

```bash
# Resolve name -> id (jq is available in these sandboxes)
SESSION_ID=$(vst session ls --worktree=$VST_WORKTREE --name="reviewer" --json | jq -r '.[0].id')
```

- No match → the filtered array is empty and `.[0].id` is `null`/empty. Don't
  assume the target doesn't exist — re-run `vst session ls --worktree=$VST_WORKTREE --json`
  (unfiltered) and check for a typo before giving up.
- More than one match → names are not guaranteed unique; `.[0]` picks an
  arbitrary one. If that matters, list the unfiltered `--json` output and
  disambiguate by hand (e.g. by `state`/`type`/`id`).

```bash
# Send a message and wait for the session to go idle
vst send <session-id> "message text" --wait

# Send from a file
vst send <session-id> --file=./instructions.md --wait
```

### Daemon / health

```bash
vst daemon status
vst doctor        # checks tmux, git, claude/cursor/opencode on PATH
```

---

## What "done" looks like

- All relevant tests pass.
- Lint is clean (if the project uses a linter).
- Changes are committed on your branch (worktree sessions — a direct session edits the project's checked-out branch directly, there is no separate branch to commit to).
- If a PR was requested: opened with a clear title and description.
- Your process exits with code 0.

If you hit a blocker you cannot resolve (missing credentials, ambiguous requirements, broken environment), write a `BLOCKED.md` file in your working directory root (worktree checkout, or the project directory for a direct session) describing the blocker, commit it, and exit. The human reviewer will see it.

---

## Ending your session

- `vst session terminate` — ends **this** session (defaults to `$VST_SESSION` when no id is given); deletes the session record and its data dir. Use this when asked to end/finish/stop yourself, or when you spawned a sibling/child session that's no longer needed.
- Caveat: if you are a worktree's **main** agent and another agent session already exists in the same worktree, terminating yourself PROMOTES that other session to main (it keeps its own name) and then ends your session as normal — a real side effect another agent/user may not expect, so avoid triggering it unprompted. If you are the worktree's **only** session, this is rejected (400) — the daemon requires `vst worktree rm` for that case instead; this is out of scope for a mid-task agent to run unprompted, surface the 400 to the user rather than escalating to a worktree removal.

---

## Things you must NOT do

- Modify files outside your working directory (the worktree checkout, or the project directory for a direct session).
- Push to `main`, `master`, or the base branch.
- Delete or modify another session's work without explicit coordination.
- Run `vst worktree rm` or `vst session terminate` on sessions you did not create.
- Ignore test failures and commit anyway.
- After `vst worktree create`, do NOT run `vst session create` for the same worktree — the main session already exists.

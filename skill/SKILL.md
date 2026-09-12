<!-- vst-skill-version: 0.0.0 -->
---
name: vst
description: Spawn isolated git-worktree coding sessions (claude, cursor, opencode) on a developer's machine via the vst daemon, send messages, stream output, and tear down. Use when an external agent or service needs to drive background coding work and coordinate with it.
---

# vibe-station — External-Agent Interop Skill

## 1. What vst is

`vst` is a local daemon that manages isolated git-worktree coding sessions on a developer's machine. Each worktree gets its own git branch and one or more agent sessions (claude, cursor, opencode) running in tmux panes.

This skill is used by agents that interact with vst — both agents running **inside** vst sessions and **external** integrations (OpenClaw, GitHub Actions, CI bots). Agents spawned by vst receive their primary task instructions directly from the daemon at launch; this skill covers the CLI-driven integration patterns (spawn, inspect, message, rename, tear down) that are relevant to both external callers and agents coordinating with siblings.

**All interactions with vst use the `vst` CLI exclusively.** Do not use curl or the HTTP API.

---

## 2. Discover the daemon

```bash
# Check if the daemon is running and get its port
vst daemon status

# Start the daemon (if not running)
vst daemon start

# Start headless (no UI, for CI / GitHub Actions)
vst daemon start --headless
```

---

## 3. List and inspect projects, worktrees, and sessions

```bash
# Register a directory as a project (required before any worktree can be created for it).
# Safe to call on an already-registered project — it is idempotent.
vst project add <path>

# List all registered projects
vst project ls --json

# List worktrees in a project
vst worktree ls --project=<projectId> --json

# Get details on a specific worktree (branch, baseBranch, sessions)
vst worktree info <worktreeId> --json

# List sessions in a worktree
vst session ls --worktree=<worktreeId> --json

# Get details on a specific session (id, state, type, modeId, isMain, …)
vst session info <sessionId> --json

# List available modes (each mode binds a CLI + system-prompt context)
vst mode ls --json
```

`session.state` is one of `not_started` | `working` | `idle` | `waiting_for_human` | `exited`.

> **`waiting_for_human`** — the agent is blocked and expects a message before it can continue. Polling loops that only break on `idle`/`exited` will spin forever; always include this state as a break condition and surface it to a human or your integration layer.

---

## 4. Spawn a worktree + agent session

```bash
# Creates worktree + main agent session in one shot.
# Output is always plain text: two lines — a label, then the worktree id.
# Capture the id with tail -1; get the session id separately via session ls.
WORKTREE_ID=$(vst worktree create <projectId> \
  --branch=feat/my-task \
  --base=main \
  --mode=<modeId> \
  --prompt="Implement the login flow described in SPEC.md" | tail -1)
SESSION_ID=$(vst session ls --worktree="$WORKTREE_ID" --json | jq -r '.[0].id')
```

**Agent sessions default to Rich Chat (json channel).** Pass `--channel=tmux` or `--channel=pty` explicitly only if you need a raw terminal session instead.

**Modes** bind an agent CLI (`claude`, `cursor`, `opencode`) + mode-specific system-prompt context. The mode determines which CLI is used — do not pass `--agent` separately. Use `vst mode ls --json` to discover available modes.

**The main session is created automatically.** Do NOT follow `vst worktree create` with `vst session create` — that would add a redundant second session.

**Session identity** — each session has an opaque `id` (returned by `vst worktree create`/`vst session create`, or looked up via `vst session ls`) and an `isMain` flag marking the worktree's single main agent session. Session ids are not something to construct yourself — always look them up.

---

## 5. Add a session to an existing worktree

Use this when you need extra parallelism inside an already-created worktree (same branch, same checkout):

```bash
# Add a sibling agent session
vst session create <worktreeId> --type=agent --mode=<modeId> --prompt="your sub-task"

# Add a plain terminal tab
vst session create <worktreeId> --type=terminal
```

Output is always plain text — two lines: a label then the session id. Capture it with `tail -1`. Agent sessions default to Rich Chat; terminal sessions default to tmux. Do not use this after `vst worktree create` for the same worktree — the main session already exists.

---

## 6. Restore an exited session

```bash
vst session restore <sessionId>
```

The agent re-launches in the same worktree checkout on the same branch.

---

## 7. Send a message and wait

If you only have a session's UI-set display name (not its id), resolve it first:

```bash
# Resolve a UI-set name to its id within a worktree (jq is available)
vst session ls --worktree=<worktreeId> --name="<name>" --json | jq -r '.[0].id'
```

No match → the filtered array is empty; re-check with the unfiltered
`vst session ls --worktree=<worktreeId> --json` before assuming the session
doesn't exist. Names aren't guaranteed unique — `.[0]` picks an arbitrary
match among duplicates.

```bash
# Send message and wait for agent to go idle (also prints the reply)
vst session send <sessionId> "Add tests for the login handler" --wait

# Send from a file
vst session send <sessionId> --file=./instructions.md --wait
```

---

## 8. Read session output

```bash
# Capture last N lines of pane output (tmux/pty) or assistant prose (json)
vst session output <sessionId> --lines=200
```

This is prose/pane text, not an event log. For a json (Rich Chat) session's structured events — roles, tool calls, turn ids — use:

```bash
vst session transcript <sessionId> --json
```

This returns an array of turn events. It errors on a tmux/pty session (those have no event log).

---

## 9. OpenClaw integration recipe

**Scenario:** an OpenClaw webhook receives "review this PR" and wants to spawn a claude session, wait for it to finish, then post results back.

```bash
# 1. Ensure daemon is running
vst daemon status || vst daemon start

# 2. Get the project ID
PROJECT_ID=$(vst project ls --json | jq -r '.[0].id')

# 3. Spawn a worktree+session with the diff as the task prompt
# vst worktree create always outputs plain text: label line then the worktree id
WORKTREE_ID=$(vst worktree create "$PROJECT_ID" \
  --branch "review/pr-$(date +%s)" \
  --base main \
  --mode <your-claude-modeId> \
  --prompt "Review the diff at /tmp/pr.diff and summarise findings." | tail -1)
# Session id is fetched separately — create output does not include it
SESSION_ID=$(vst session ls --worktree="$WORKTREE_ID" --json | jq -r '.[0].id')

# 4. Poll until session is idle, exited, or waiting_for_human
# waiting_for_human means the agent is blocked — surface this to a human rather than looping forever
until STATE=$(vst session info "$SESSION_ID" --json | jq -r '.state'); \
      [ "$STATE" = "idle" ] || [ "$STATE" = "exited" ] || [ "$STATE" = "waiting_for_human" ]; do
  sleep 5
done
[ "$STATE" = "waiting_for_human" ] && { echo "Agent blocked — needs human input"; exit 1; }

# 5. Capture output
OUTPUT=$(vst session output "$SESSION_ID" --lines=500)

# 6. Post output back via OpenClaw notifier
# TODO(openclaw): exact notifier-callback shape depends on your OpenClaw version.
# Typical pattern: POST to your webhook reply URL with { "text": "$OUTPUT" }.

# 7. Tear down the worktree
# --purge also deletes the git checkout from disk; omit if the branch should persist
vst worktree rm "$WORKTREE_ID" --purge
```

---

## 10. GitHub Actions / CI integration recipe

```yaml
# .github/workflows/agent-review.yml
name: Agent Review
on:
  pull_request:

jobs:
  agent:
    runs-on: ubuntu-latest   # or a self-hosted runner with vst installed
    steps:
      - uses: actions/checkout@v4

      - name: Start vst daemon (headless)
        run: vst daemon start --headless

      - name: Register project
        run: vst project add ${{ github.workspace }}

      - name: Spawn agent session
        id: spawn
        run: |
          # vst worktree create outputs plain text — grab the worktree id from the last line
          WORKTREE_ID=$(vst worktree create my-project \
            --branch ci-review-${{ github.run_id }} \
            --mode <modeId> \
            --prompt "Review PR #${{ github.event.number }}" | tail -1)
          SESSION_ID=$(vst session ls --worktree="$WORKTREE_ID" --json | jq -r '.[0].id')
          echo "worktree=$WORKTREE_ID" >> $GITHUB_OUTPUT
          echo "session=$SESSION_ID" >> $GITHUB_OUTPUT

      - name: Wait for agent to finish
        run: |
          until STATE=$(vst session info ${{ steps.spawn.outputs.session }} --json | jq -r '.state'); \
                [ "$STATE" = "idle" ] || [ "$STATE" = "exited" ] || [ "$STATE" = "waiting_for_human" ]; do
            sleep 10
          done

      - name: Capture output
        run: vst session output ${{ steps.spawn.outputs.session }} --lines=500

      - name: Teardown
        if: always()
        # --purge also deletes the git checkout from disk; omit if the branch should persist
        run: vst worktree rm ${{ steps.spawn.outputs.worktree }} --purge
```

---

## 11. Rename a worktree or session

```bash
vst worktree rename <id> <newName>   # rename a worktree
vst session rename  <id> <newName>   # rename a session
```

**Argument order is always: existing ID first, new name second.**

### When running inside a vst session

Your environment already contains `$VST_WORKTREE` (your worktree id) and `$VST_SESSION` (your session id). **When a user says "rename to X" or "vst rename X" with a single argument, X is the new name.** Resolve the current id from the environment and construct the full command yourself:

```bash
# User says: "vst rename direct-2" or "rename this worktree to direct-2"
vst worktree rename "$VST_WORKTREE" direct-2

# User says: "rename my session to direct-2"
vst session rename "$VST_SESSION" direct-2
```

Do not ask the user for the current id — you already have it. Do not ask whether the argument is the target or the new name — a single bare argument is always the new name.

### When running outside a vst session (no env vars)

Both arguments are required. The first is the existing id, the second is the new name:

```bash
vst worktree rename vs-19 my-feature               # rename worktree vs-19 → my-feature
vst session rename vs-19-a-3f9c2b7a my-session      # rename a session by its id → my-session
```

**ID patterns** (to distinguish existing ids from new names):
- **Worktree IDs** — `<prefix>-<number>`, e.g. `direct-2`, `myap-1`, `vs-19`
- **Session IDs** — `<worktreeId>-<a|t>-<random>`, e.g. `vs-19-a-3f9c2b7a` (generated
  independently per session, not from a slot/position — don't construct one by hand;
  look it up via `vst session ls` or `vst session info $VST_SESSION`)

---

## 12. Tear down

```bash
# Terminate a specific session by id
vst session terminate <sessionId>

# Inside a vst session only: omit the id to self-terminate using $VST_SESSION.
# External integrations must always pass an explicit id — never rely on $VST_SESSION
# being set correctly in a CI/bot environment.
vst session terminate  # only safe when $VST_SESSION is YOUR own session id

# Remove a worktree (terminates all sessions, removes from manifest; branch preserved on disk)
vst worktree rm <worktreeId>

# Also permanently delete the git worktree checkout from disk — irreversible
vst worktree rm <worktreeId> --purge
```

When to use each:
- `vst session terminate <id>` — stop an individual non-main agent or terminal tab while keeping the worktree alive.
- `vst worktree rm <id>` — tear down the whole worktree (all sessions terminated, branch preserved).
- `vst worktree rm <id> --purge` — same, plus **permanently deletes the git checkout from disk**. Only use this if the branch has been pushed or the work is intentionally discarded.

---

## 13. Conventions to honour

- **Never push to `main`/`master`/the base branch.** Agents work on their own branch. If you trigger a push, target the feature branch only.
- **Respect `AGENTS.md` / `.vibe-station/rules.md`** if the project has them. These files are loaded as L3 of the agent's system prompt automatically — agents will follow them.
- **Sessions are co-tenants** — only terminate sessions or worktrees that your integration created. There is no server-side ownership field; record the worktree id returned by `vst worktree create` at spawn time and operate only on that id. Never call `vst worktree rm` on worktrees owned by the developer's interactive session.
- **Set a meaningful `prompt`** when spawning sessions. The clearer the task description, the better the agent's output.
- **Poll `state`, don't spin.** Check `vst session info` every 5–10 s rather than hammering repeatedly.

---

*This skill covers external and cross-session integration patterns. Agents spawned by vst receive their full task context from the daemon at launch — this file supplements that with spawn, inspect, message, rename, and teardown patterns.*

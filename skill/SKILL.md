---
name: vibestation
description: Spawn isolated git-worktree coding sessions (claude, cursor, opencode) on a developer's machine via the vst daemon, send messages, stream output, and tear down. Use when an external agent or service needs to drive background coding work and coordinate with it.
---

# vibe-station — External-Agent Interop Skill

## 1. What vst is

`vst` is a local daemon that manages isolated git-worktree coding sessions on a developer's machine. Each worktree gets its own git branch and one or more agent sessions (claude, cursor, opencode) running in tmux panes. The daemon exposes a REST API and a WebSocket endpoint for real-time pane streaming.

**This skill is for agents OUTSIDE vst.** If you are an agent spawned BY vst, your system prompt is `daemon/src/assets/agent-system-prompt.md` — do not load this skill. This file describes how external agents (Claude Code, Cursor users in their own project, OpenClaw bots, GitHub Action runners, MCP consumers, etc.) drive vst from the outside.

---

## 2. Discover the daemon

```bash
# Check if the daemon is running and get its port
vst daemon status

# Start the daemon (if not running)
vst daemon start

# Start headless (no UI, for CI / GitHub Actions)
vst daemon start --headless

# Read daemon config (port is here)
cat ~/.vibe-station/config.json
# → { "port": 7421 }
```

All HTTP API calls use `http://127.0.0.1:<port>` (port from `~/.vibe-station/config.json`, default 7421).

---

## 3. List projects and worktrees

```bash
# List all registered projects
vst project ls --json

# List worktrees in a project
vst worktree ls --project=<projectId> --json

# Or via HTTP:
curl http://127.0.0.1:7421/projects
# → [{ "id": "my-app", "name": "my-app", "path": "/home/user/my-app",
#       "prefix": "myap", "defaultBranch": "main", "createdAt": "…" }]

curl "http://127.0.0.1:7421/worktrees?project=my-app"
# → [{ "id": "myap-1", "projectId": "my-app", "branch": "feat/fix-auth",
#       "baseBranch": "main", "baseSha": "abc123…", "createdAt": "…" }]
```

---

## 4. Spawn a worktree + agent session

```bash
# CLI — creates worktree + main agent session in one shot
vst worktree create <projectId> \
  --branch=feat/my-task \
  --base=main \
  --agent=claude \
  --mode=<modeId> \
  --prompt="Implement the login flow described in SPEC.md"

# HTTP — POST /worktrees
curl -X POST http://127.0.0.1:7421/worktrees \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-app",
    "branch": "feat/my-task",
    "baseBranch": "main",
    "modeId": "<modeId>",
    "prompt": "Implement the login flow described in SPEC.md"
  }'
# → 201 { "id": "myap-1", "projectId": "my-app", "branch": "feat/my-task",
#          "baseBranch": "main", "baseSha": "abc123…", "createdAt": "…" }
```

**Schema for POST /worktrees body:**
```json
{
  "projectId": "string (required)",
  "modeId":    "string (required) — mode determines which agent CLI to use",
  "branch":    "string (required) — new branch name",
  "baseBranch":"string (optional) — defaults to project's defaultBranch",
  "prompt":    "string (optional) — task prompt sent to the agent at launch"
}
```

**Modes** (`GET /modes` returns the list) bind an agent CLI (`claude`, `cursor`, `opencode`) + mode-specific system-prompt context. Use `vst mode ls --json` to discover available modes.

**Slots** — the main session is slot `m`; additional sessions in the same worktree get slots `a2`, `a3`, … for agents and `t2`, `t3`, … for terminals.

---

## 5. Send a message and wait

```bash
# CLI — send message and wait for agent to go idle
vst send <sessionId> "Add tests for the login handler" --wait

# Send from a file
vst send <sessionId> --file=./instructions.md --wait

# HTTP — POST /sessions/:id/input
curl -X POST "http://127.0.0.1:7421/sessions/<sessionId>/input" \
  -H "Content-Type: application/json" \
  -d '{ "data": "Add tests for the login handler\n", "sendEnter": false }'
# → 200 { "ok": true }
```

**Schema for POST /sessions/:id/input body:**
```json
{
  "data":      "string (required, min 1) — text to paste into the session",
  "sendEnter": "boolean (optional) — append a newline"
}
```

---

## 6. Read session output

```bash
# CLI — capture last N lines of pane output
vst session output <sessionId> --lines=200

# Follow live (streams until Ctrl-C)
vst session output <sessionId> --follow
```

TODO(api): There is no REST endpoint for `GET /sessions/:id/output` at this time; use the CLI command or the WebSocket pane stream (§7) instead.

---

## 7. HTTP API reference

Base URL: `http://127.0.0.1:<port>` (port from `~/.vibe-station/config.json`).

### GET /projects
Returns all registered projects.
```
→ 200 Array of { id, name, path, prefix, defaultBranch, createdAt }
```

### GET /worktrees?project=\<id\>
Returns worktrees for a project (omit query to return all).
```
→ 200 Array of { id, projectId, branch, baseBranch, baseSha, createdAt }
```

### POST /worktrees
Create a worktree and spawn the main agent session.
Body: `{ projectId, modeId, branch, baseBranch?, prompt? }` (see §4).
```
→ 201 { id, projectId, branch, baseBranch, baseSha, createdAt }
→ 400 { error: "Validation error", details: [...] }
→ 409 { error: "Branch '…' already exists", conflictWith: "…" }
→ 500 { error: "Failed to create worktree: …", reason: "…" }
```

### DELETE /worktrees/:id?purge=true
Kill all sessions and remove the worktree from the manifest.
With `?purge=true`, also deletes the git worktree checkout from disk.
```
→ 200 { ok: true }
→ 404 { error: "Worktree '…' not found" }
```

### GET /sessions?worktree=\<id\>
Returns sessions for a worktree (omit query to return all).
```
→ 200 Array of session objects (see GET /sessions/:id)
```

### GET /sessions/:id
```
→ 200 {
    id, worktreeId, slot, type, modeId,
    label, tmuxName, state, lifecycleState, createdAt
  }
→ 404 { error: "Session '…' not found" }
```

`state` / `lifecycleState`: one of `not_started` | `working` | `idle` | `exited`.

### POST /sessions
Create an additional agent or terminal session inside an existing worktree.
```json
{
  "worktreeId": "string (required)",
  "type":       "agent | terminal",
  "modeId":     "string (required when type=agent)",
  "prompt":     "string (optional)"
}
```
```
→ 201 session object
→ 400 { error: "…" }
→ 404 { error: "Worktree '…' not found" }
→ 500 { error: "Failed to spawn agent session: …" }
```

### DELETE /sessions/:id
Kill a non-main session.
```
→ 200 { ok: true }
→ 400 { error: "Cannot delete the main session. Use DELETE /worktrees/:id instead." }
→ 404 { error: "Session '…' not found" }
```

### POST /sessions/:id/resume
Resume an exited session (agent re-launches; terminal gets a new pane).
```
→ 200 session object
→ 404 { error: "Session '…' not found" }
→ 500 { error: "Failed to resume session: …" }
```

### POST /sessions/:id/input
Paste text into a session's tmux pane (§5).
```
→ 200 { ok: true }
→ 500 { error: "Failed to send input: …" }
```

### WS /ws
Single multiplexed WebSocket endpoint. Connect once, send/receive JSON frames.

**Client → server message types** (from `ws/protocol.ts`):

| type | fields | purpose |
|------|--------|---------|
| `subscribe` | `sessionIds: string[]` | receive events for listed sessions |
| `unsubscribe` | `sessionIds: string[]` | stop receiving events |
| `session:open` | `sessionId, cols, rows` | open a live pane stream (pty) |
| `session:input` | `sessionId, data: string` | send keystroke data |
| `session:resize` | `sessionId, cols, rows` | resize pty |
| `session:close` | `sessionId` | close the pane stream |
| `file:watch` | `worktreeId, path` | watch a file for changes |
| `file:unwatch` | `worktreeId, path` | stop watching a file |
| `tree:watch` | `worktreeId, path?` | watch a directory tree |
| `tree:unwatch` | `worktreeId, path?` | stop watching a tree |
| `ping` | — | keepalive |

**Server → client event types** include `session:state`, `session:exited`, `session:created`, `session:deleted`, `session:resumed`, `worktree:created`, `worktree:deleted`, `pane:output` (when `session:open` is active), and `pong`.

---

## 8. OpenClaw integration recipe

**Scenario:** an OpenClaw webhook receives "review this PR" and wants to spawn a claude session, wait for it to finish, then post results back.

```bash
# 1. Ensure daemon is running
vst daemon status || vst daemon start

# 2. Get the project ID
PROJECT_ID=$(curl -s http://127.0.0.1:7421/projects | jq -r '.[0].id')

# 3. Spawn a worktree+session with the diff as the task prompt
# (POST /worktrees creates the worktree and the main agent session atomically)
WORKTREE=$(curl -s -X POST http://127.0.0.1:7421/worktrees \
  -H "Content-Type: application/json" \
  -d "{
    \"projectId\": \"$PROJECT_ID\",
    \"branch\":    \"review/pr-$(date +%s)\",
    \"baseBranch\":\"main\",
    \"modeId\":    \"<your-claude-modeId>\",
    \"prompt\":    \"Review the diff at /tmp/pr.diff and summarise findings.\"
  }")
SESSION_ID=$(echo "$WORKTREE" | jq -r '.id')-m

# 4. Poll until session is idle or exited
while true; do
  STATE=$(curl -s "http://127.0.0.1:7421/sessions/$SESSION_ID" | jq -r '.state')
  [ "$STATE" = "idle" ] || [ "$STATE" = "exited" ] && break
  sleep 5
done

# 5. Capture output via CLI
OUTPUT=$(vst session output "$SESSION_ID" --lines=500)

# 6. Post output back via OpenClaw notifier
# TODO(openclaw): exact notifier-callback shape depends on your OpenClaw version.
# Typical pattern: POST to your webhook reply URL with { "text": "$OUTPUT" }.
curl -X POST "$OPENCLAW_REPLY_URL" \
  -H "Content-Type: application/json" \
  -d "{\"text\": $(echo "$OUTPUT" | jq -Rs .)}"

# 7. Tear down the worktree
curl -s -X DELETE "http://127.0.0.1:7421/worktrees/$(echo $WORKTREE | jq -r '.id')?purge=true"
```

---

## 9. GitHub Actions / CI integration recipe

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
          SESSION=$(vst worktree create my-project \
            --branch ci-review-${{ github.run_id }} \
            --mode <modeId> \
            --prompt "Review PR #${{ github.event.number }}" \
            --json)
          echo "session=$(echo $SESSION | jq -r '.sessions[0].id')" >> $GITHUB_OUTPUT

      - name: Wait for agent to finish
        run: |
          until [ "$(vst session info ${{ steps.spawn.outputs.session }} --json | jq -r '.state')" = "exited" ]; do
            sleep 10
          done

      - name: Capture output
        run: vst session output ${{ steps.spawn.outputs.session }} --lines=500

      - name: Teardown
        if: always()
        run: vst worktree rm ${{ steps.spawn.outputs.session }} --purge
```

---

## 10. Tear down

```bash
# Kill a specific session (non-main only)
curl -X DELETE "http://127.0.0.1:7421/sessions/<sessionId>"

# Remove a worktree (kills all sessions, removes from manifest)
curl -X DELETE "http://127.0.0.1:7421/worktrees/<worktreeId>"

# Also delete the git worktree checkout from disk
curl -X DELETE "http://127.0.0.1:7421/worktrees/<worktreeId>?purge=true"

# CLI equivalents
vst session kill <sessionId>
vst worktree rm <worktreeId>
vst worktree rm <worktreeId> --purge
```

When to use each:
- `DELETE /sessions/:id` — stop an individual non-main agent or terminal tab while keeping the worktree alive.
- `DELETE /worktrees/:id` — tear down the whole worktree (all sessions killed, branch preserved on disk unless `purge=true`).

---

## 11. Conventions to honour

- **Never push to `main`/`master`/the base branch.** Agents work on their own branch. If you trigger a push, target the feature branch only.
- **Respect `AGENTS.md` / `.vibe-station/rules.md`** if the project has them. These files are loaded as L3 of the agent's system prompt automatically — agents will follow them.
- **Sessions are co-tenants** — only kill sessions or worktrees that your integration created. Never call `DELETE /worktrees/:id` on worktrees owned by the developer's interactive session.
- **Set a meaningful `prompt`** when spawning sessions. The clearer the task description, the better the agent's output.
- **Poll `state`, don't spin.** Check `GET /sessions/:id` every 5–10 s rather than hammering the endpoint.

---

*Cross-reference: the agent-side system prompt that vst injects into spawned workers lives at `daemon/src/assets/agent-system-prompt.md`. That file is for vst's own workers. This file (`skill/SKILL.md`) is for external agents and bots that drive vst from outside.*

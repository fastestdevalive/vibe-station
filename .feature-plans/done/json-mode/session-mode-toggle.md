# Design: In-Place Session Mode Toggle (TTY ⇄ JSON)

> Toggle a live agent session between **TTY** (interactive tmux / `direct-pty` REPL) and **JSON** (per-turn `stream-json` chat) **in place, both directions**, keeping the model conversation. Same underlying `agentChatId` bridges the two invocation styles. UI pane swap is pure visibility (both `TerminalPane` + `ChatPane` always-mounted — Decision 14).

**Issue:** session-mode-toggle
**Branch:** `json-mode-chat-with-file-upload` (builds on json-agent-chat)
**Status:** Pending
**PRD:** _(none — extends `json-agent-chat.md`)_

---

## Problem

- `channel` (`tmux`|`pty`|`json`) is chosen once at agent-create and is immutable — no way to move a running conversation between the raw terminal and the structured chat UI.
- The two panes already coexist (Decision 14) but there is no daemon operation to re-point a session's backend at the other channel while keeping context.

## Concept

- One control on the agent header: **"Switch to Chat"** / **"Switch to Terminal"**.
- Daemon tears down the current backend, flips `session.channel`, and re-spawns/resumes in the new channel using the session's `agentChatId` — model context intact.
- What the user sees flips; the conversation the model holds does not reset.

---

## Feasibility — Verified Support Matrix (live-tested 2026-07-15)

> Trivial probe: teach "remember 7" via one invocation style, recall via the other, same id. Cheap models (claude `haiku`, cursor Auto, opencode `deepseek-v4-flash-free`). Recall of **"7"** = context carried.

| CLI | TTY→JSON | JSON→TTY | Context kept | Id stable (no fork) | Evidence |
|-----|:--------:|:--------:|:------------:|:-------------------:|----------|
| **claude** | ✅ | ✅ | ✅ | ✅ | mint id → `-p --resume <id> --output-format stream-json` recalled `7`; plain `-p --resume <id>` (TUI-load proxy) recalled `7`; `session_id` unchanged across resumes |
| **cursor** | ✅ | ✅ | ✅ | ✅ | `create-chat`→id (pre-mint = TTY capture path); `-p --resume <id> --output-format stream-json` recalled `7`; `-p --resume <id> --output-format text` recalled `7`; same `session_id` throughout. **Free plan → Auto model (omit `--model`)** |
| **opencode** | ✅ | ✅ | ✅ | ✅ | `run … --format json` minted `ses_…`; `run --session <id> --format json` recalled `7`; `run --session <id>` (default/TTY format) recalled `7`; same `sessionID`; `--replay` exists for interactive resume |
| **gemini** | ⚠ | ⚠ | ⚠ | ⚠ | **deauthed** (`IneligibleTierError` — Code Assist individual tier retired). Doc-only: pre-mint via `--session-id <uuid>`; **resume is by `--resume <index|latest>` or `--session-file`, NOT by uuid** — differs from the other three. Continuity across styles plausible via `--resume latest` (project-scoped store) but unverified |

**Key finding — claude sessions are cwd-scoped.** Resuming from a different working dir → `No conversation found with session ID`. Both channels in vibe-station share the same worktree/project cwd, so this holds — but the re-spawn **must** use the identical cwd.

**Verdict on the crux:** For claude/cursor/opencode the SAME `agentChatId` is accepted by both the interactive (`--resume`/`--session`, TUI) and the stream-json invocations, and prior context is recalled in both directions with no id fork. Toggle is **feasible today for 3/4 CLIs**. gemini is a resume-model mismatch + unauthed → gate behind re-auth.

---

## Architecture

```
        ┌──────────── Web UI (Workspace.tsx) ───────────┐
        │  TerminalPane (xterm)   ChatPane (useChat)     │   both always mounted (Dec 14)
        │        ▲  visible = channel==tmux|pty          │
        │        └──────── toggle btn ──────┐  visible = channel==json
        └───────────────────────────────────┼───────────┘
                     POST /sessions/:id/channel {channel}
                                             │
                              ┌──────────────▼───────────────┐
                              │ Daemon channel switch service │
                              │ 1 teardown current backend    │
                              │ 2 flip session.channel(persist)│
                              │ 3 re-spawn/resume new backend  │
                              │   via agentChatId + same cwd   │
                              └───────┬───────────────┬───────┘
                 TTY→JSON             │               │        JSON→TTY
   kill tmux/direct-pty; JsonAgent-   │               │  drain+stop queue; unregister
   Registry.create(session,chatId);   │               │  JsonAgentSession; spawnSession
   next turn spawns --resume <chatId> ▼               ▼  (tmux/pty) w/ getRestoreCommand(chatId)
        ┌───────────────────┐               ┌───────────────────────┐
        │ per-turn stream-   │               │ tmux pane / direct-pty │
        │ json child procs   │               │ interactive REPL       │
        └───────────────────┘               └───────────────────────┘
             shared session store per CLI (claude jsonl / cursor chat / opencode ses_)
```

---

## Mechanism — what the daemon does on toggle

`POST /sessions/:id/channel {channel}` →

1. **Teardown current backend**
   - TTY→JSON: `stopSession`/kill tmux window or `direct-pty` child; unregister from `directPtyRegistry`; keep scrollback file (dead, not replayed in JSON).
   - JSON→TTY: `abortAndDrain` active turn (Decision 13), keep or drop queued turns (Edge #2); unregister `JsonAgentSession` from `jsonAgentRegistry`.
2. **Flip channel** — `mutateProject` sets `session.channel`; pin `useTmux` consistently (`json`→false; `tmux`→true; `pty`→false). Persisted so restart honours it.
3. **Re-spawn / resume in new channel** (same cwd, same `agentChatId`):
   - →JSON: `jsonAgentRegistry.create(session, chatId)`; first user message spawns `runTurn` with `--resume <chatId>` / `--session <id>` (Decision 10). No live process until next turn (per-turn model).
   - →TTY: `spawnSession(...)` in tmux/`direct-pty` using the plugin's **resume/restore command** built from `agentChatId` (claude `--resume`, cursor `--resume`, opencode `--session`, gemini pre-minted uuid) so the REPL boots into the existing conversation.
4. **Pane visibility** — client already has both panes; `session:meta {channel}` (or the create-dialog swap logic in `Workspace.tsx`) flips which is shown.

### What does / doesn't transfer

| Aspect | TTY→JSON | JSON→TTY |
|--------|----------|----------|
| **Model context** | ✅ resumed via `agentChatId` (verified recall) | ✅ resumed via restore command (`--resume`/`--session`) |
| **Visible transcript** | ❌ fresh — TTY has no structured transcript; `messages.jsonl` starts empty (or from this turn). Prior TTY exchange not re-rendered as bubbles | ❌ TUI starts visually blank scrollback; opencode `--replay` can re-print history, claude/cursor TUI re-hydrate context but not full visual replay |
| **Usage/meta bar** | rebuilt from this-channel turns only | n/a (TTY has no meta bar) |
| **agentChatId** | reused, stable | reused, stable |

- Net: **context always carries; the presentation history does not.** Frame the toggle to the user as "continue this conversation in the other view," not "import history."

### Lifecycle / recovery implications

- `channel` is already the source-of-truth field (Decision 1, `sessionChannel(session)` helper) — toggle just mutates it; boot recovery (Decision 11) already branches on channel, so a session toggled then restarted recovers in whichever channel was persisted.
- JSON side survives daemon restart statelessly (per-turn, N2). TTY side re-spawns via existing recover path.
- A restart mid-toggle is safe: the last successfully-persisted `channel` wins; the half-torn-down backend was going to be killed anyway.

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/routes/sessions.ts` | NEW `POST /sessions/:id/channel` handler → calls switch service |
| `daemon/src/services/channel.ts` | NEW `switchChannel(session, target)` — teardown + flip + respawn; reuse `sessionChannel` helper |
| `daemon/src/services/jsonAgent.ts` | expose `abortAndDrain` + registry create/destroy for the switch; already holds queue/meta |
| `daemon/src/state/jsonAgentRegistry.ts` | register/unregister on switch |
| `daemon/src/services/spawn.ts` | reuse `spawnSession` for →TTY with a resume/restore command from `agentChatId` |
| `agent-plugins/{claude,cursor,gemini,opencode}.ts` | ensure `getRestoreCommand(chatId)` (TTY resume) + `runTurn --resume` (JSON) both consume the same `agentChatId` |
| `daemon/src/services/lifecycle.ts` / `recover.ts` | already channel-aware (Dec 11) — verify no assumption that channel is immutable |
| `web-ui/src/components/…/Workspace.tsx` | header toggle control; drive pane visibility from `channel` |
| `web-ui/src/api/client.ts` + `useChat`/session hook | `switchChannel(id, channel)` call; react to `session:meta {channel}` |
| shared types (`daemon/src/types.ts` + `web-ui/src/api/types.ts`) | `SessionMeta.channel` already present; no schema change |

---

## Daemon + Web-UI changes (summary)

- **Endpoint:** `POST /sessions/:id/channel { channel: "tmux"|"pty"|"json" }` → `200 SessionMeta` | `409` (mid-turn, if we reject) | `404`.
- **Registry teardown:** symmetric kill of the source backend (`directPtyRegistry`/tmux window ↔ `jsonAgentRegistry`).
- **UI toggle control:** one header button; optimistic visibility swap confirmed by `session:meta {channel}`.

---

## Risks / Open Questions

| # | Risk | Notes / Mitigation |
|---|------|--------------------|
| 1 | **Mid-turn toggle** | JSON→TTY while a turn runs: `abortAndDrain` first, then spawn TTY. TTY→JSON while agent is mid-response in the REPL: no clean turn boundary → require idle, or SIGINT the pane, before switching. Simplest v1: **reject with 409 if a turn/agent is busy.** |
| 2 | **Queued turns on JSON→TTY** | Pending FIFO turns (Decision 8) have no TTY equivalent. v1: **drop + warn** (or block toggle until queue empty). |
| 3 | **gemini id incompatibility** | Resume is `--resume <index\|latest>`/`--session-file`, not by uuid → the pre-minted uuid that JSON mode sets may not be directly resumable by the TUI the same way. **Verify post re-auth**; until then gemini toggle disabled. |
| 4 | **gemini unauthed** | `IneligibleTierError` — whole gemini JSON+toggle path unverifiable now. Gate behind `GEMINI_API_KEY`/re-login. |
| 5 | **cwd drift (claude)** | Resume fails from a different cwd. Switch service **must** re-spawn with the session's original cwd (worktree or direct project path). |
| 6 | **cursor Free-plan model** | JSON turns must omit `--model` (Auto); a TTY session pinned to a named model may not round-trip on Free — keep model choice channel-consistent. |
| 7 | **No visual history transfer** | Expected + documented above; surface a one-line "continued from Terminal/Chat" divider so the empty pane isn't confusing. |
| 8 | **Rapid double-toggle** | Serialize switches per session (reuse the turn-queue lock or a per-session mutex) to avoid two teardowns racing. |

---

## Verdict

- **Feasible now for claude, cursor, opencode** — same `agentChatId` bridges TTY⇄JSON in **both** directions with context intact and no id fork (live-verified). The heavy lifting (channel field, `agentChatId` capture/reuse, both panes mounted, per-CLI restore commands) already exists from json-agent-chat.
- **gemini:** deferred/disabled until re-auth + verification of the index-based resume model.
- **Effort:** **S–M.** Net-new = one endpoint + one `switchChannel` service (symmetric teardown/respawn) + one UI button + a busy-guard. No new schemas, no new plugin transports.

## Implementation Phases

1. **Switch service + endpoint** — `switchChannel`, `POST /sessions/:id/channel`, per-session serialize, busy-guard (409).
   - **1.T1** Unit — `channel.ts`: `switchChannel` tears down source registry entry and sets `session.channel` (persisted).
   - **1.T2** Integration — TTY→JSON→TTY round-trip on claude: teach in one channel, recall the number in the other (same `agentChatId`).
   - **1.T3** Regression — non-toggled tmux + json sessions spawn/recover unchanged.
2. **Re-spawn/resume wiring** — →TTY uses `getRestoreCommand(chatId)` w/ original cwd; →JSON uses `jsonAgentRegistry.create` + `--resume`.
   - **2.T1** Integration — cursor + opencode round-trip recall `7` both directions.
   - **2.T2** Unit — cwd preserved in the →TTY spawn args (claude cwd-scope regression guard).
3. **Web-UI toggle** — header control, visibility from `channel`, `session:meta` reaction, "continued from…" divider.
   - **3.T1** Integration — clicking toggle swaps visible pane and the reciprocal button label; busy turn shows disabled/409 toast.
   - **3.T2** Regression — always-mounted panes (Dec 14) still both mount; no double-scroll.

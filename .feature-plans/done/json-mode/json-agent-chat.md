# Design: JSON Agent Chat Mode (with attachments + cross-harness meta)

> A launch-time "JSON" option that replaces the xterm/tmux terminal with a native, 100gb-styled agent chat UI. The daemon spawns the CLI directly with `--output-format stream-json`, parses NDJSON, normalizes events across all harnesses, persists a transcript, supports file attachments, and surfaces tokens/model/mode in the composer.

**Issue:** json-agent-chat
**Branch:** `json-mode-chat-with-file-upload`
**Status:** Pending
**PRD:** _(none — this design doc is the source of truth)_

**Planned sub-plan breakdown (files not yet created — see Sub-Plan Breakdown at end):**
- Part 1 — Contracts + daemon JSON backend (Phases 1–2)
- Part 2 — Plugin JSON methods (4 CLIs) + REST/WS + lifecycle/attachments (Phase 3)
- Part 3 — Web-UI ChatPane, composer, attachments, status bar (Phases 4–5)

---

## Problem

- Agent I/O today is TTY-only: raw PTY bytes (tmux or `direct-pty`) stream straight into xterm (`web-ui/src/components/layout/TerminalPane.tsx:197`, `session:output` handler). No structured access to messages, tool calls, tokens, or model.
- No way to render a real chat UI, attach files, or show per-turn cost/usage — all of which the harnesses already emit when run with `--output-format stream-json`.
- The "common info" (tokens spent, model, mode, turn state) differs per CLI and is currently unreadable because it is buried in terminal escape sequences.

## Out of Scope

- Replacing TTY mode — tmux/`direct-pty` remain the default; JSON is opt-in per launch.
- Mid-turn streaming interrupt / cancel-and-resume semantics beyond a hard "stop turn" (kill process).
- Tool-approval / permission prompts UI — v1 runs agents in their existing bypass/yolo modes (`--dangerously-skip-permissions`, `--yolo`, `--force`).
- Cost accounting beyond what each harness reports; no pricing tables maintained by us in v1 (use harness-provided cost when present).
- Mode-level JSON default and persistent (long-lived) agent processes — both deferred (see Alternatives).

---

## Main-branch delta (rebased 2026-07-14, main @ `9dc10ef`)

> Assumptions re-checked after rebasing 17 commits off main. Core plan holds; these adjustments applied throughout.

| Main change | Impact on plan |
|-------------|----------------|
| **Direct sessions** — agents can run in the project dir with **no worktree** (`ProjectRecord.directSessions`, `d{n}` slots, `DirectSpawnOptions`/`DirectLaunchConfig`). | JSON channel is a property of an **agent session** (worktree-main / worktree-additional / **direct**), not just worktrees. `JsonAgentSession` takes a cwd = worktree path **or** project path. Uploads + cleanup handle the direct case too. |
| **Agents separated from terminals** (agentic-IDE workspace, `aab36e3`). Agent creation now via **`NewAgentDialog`** (+ `DirectAgentDialog`); `createWorktree`/`createDirectSession`/`createSession`. | JSON toggle lives in `NewAgentDialog` (primary) + `DirectAgentDialog`, not `NewSessionDialog`. |
| **Agents still render via `TerminalPane`**, assembled in **`Workspace.tsx`** (`agentPane` + `directAgentPane` slots), not `Layout.tsx`. | ChatPane-vs-TerminalPane selection happens in `Workspace.tsx`. |
| `useTmux: boolean` **unchanged**; `AgentPlugin` interface **unchanged**; WS protocol has **no** chat events yet; `TranscriptRef.kind` unchanged. | `channel` field addition, plugin `runTurn` extension, and WS `chat:*`/`session:message`/`session:meta` additions all still valid and needed. |
| Session create bodies are now **two** Zod schemas — `WorktreeSessionBody` + `DirectSessionBody` (both carry `useTmux`). **daemon `CliId` is a literal union** (`registry.ts:19` `keyof typeof PLUGIN_MAP`); only **web-ui**'s `CliId` is `string`. | Add `channel?` to **both** bodies + the worktree create body; keep daemon `CliId` typed (no "dynamic string"). |
| `claude.ts` now appends `--chrome` to all claude sessions (`dc8dd36`). | claude JSON turn command is headless — omit `--chrome` (confirm no dependency). |

---

## Requirements

### Functional

| # | Requirement |
|---|-------------|
| F1 | New launch-time flag selects JSON channel for an agent session / worktree main agent. |
| F2 | JSON sessions spawn the CLI directly (piped stdio, no PTY/tmux) with `--output-format stream-json`, one process **per turn**, resumed via the harness chat id. |
| F3 | Daemon parses NDJSON → provider-agnostic `NormalizedEvent[]` and streams each to the client over WS. |
| F4 | All four harnesses supported: claude, cursor, gemini, opencode. |
| F5 | Full transcript persisted per session; replayed on reconnect / page reload. |
| F6 | Composer accepts images + arbitrary files (drag/drop + picker); files saved in-workspace, paths injected into the prompt; agent reads them from disk. |
| F7 | Attachments cleaned automatically with the session (stored under `sessionDataDir`, removed on session/worktree delete). |
| F8 | Composer surrounds the textarea with: tokens used / context-window %, current model, current mode, and live turn state. |
| F9 | A single normalized meta contract feeds F8 from every harness — no CLI-specific branching in calling code. |
| F10 | Chat UI matches the 100gb design system (tokens in `web-ui/src/styles/tokens.css`). |

### Non-functional

| # | Requirement | Target |
|---|-------------|--------|
| N1 | Stream latency | First token rendered < 500ms after harness emits it (no buffering-until-complete). |
| N2 | Resume across daemon restart | JSON sessions resume with no live process (per-turn spawn = stateless between turns). |
| N3 | Transcript durability | Every emitted event flushed to `messages.jsonl` before/at WS send. |
| N4 | Plugin isolation | All CLI-specific JSON logic lives in `agent-plugins/*` (AGENTS.md invariant). |
| N5 | Attachment safety | Uploads confined to `sessionDataDir/uploads/` (under `~/.vibe-station/`, outside the checkout); filename sanitized; traversal rejected; size-capped. |

---

## System Context

```
┌──────────────┐   WS: chat:open / session:message / session:meta   ┌───────────────┐
│   Web UI     │◀──────────────────────────────────────────────────│    Daemon     │
│  ChatPane +  │   REST: POST /chat, POST /attachments, GET /transcript│  (Node/TS)    │
│  Composer    │──────────────────────────────────────────────────▶│               │
└──────────────┘                                                    └──────┬────────┘
                                                                           │ child_process.spawn (pipes)
                                                                    ┌──────▼────────┐
                                                                    │  CLI harness  │
                                                                    │ claude/cursor/│  --output-format stream-json
                                                                    │ gemini/opencode│ → NDJSON on stdout
                                                                    └──────┬────────┘
                                                                           │ reads attachments + writes files
                                                                    ┌──────▼────────┐
                                                                    │ Daemon data FS│
                                                                    │ ~/.vibe-station│  sessionDataDir: uploads/, messages.jsonl
                                                                    └───────────────┘
```

- **Web UI** — renders normalized messages, composer with attachments + meta; talks REST for sends/uploads, WS for live stream + replay.
- **Daemon** — owns the JSON backend (spawn turn, parse NDJSON, normalize, persist, broadcast); plugins own per-CLI specifics.
- **CLI harness** — invoked per turn with stream-json; reads injected attachment paths; mutates the worktree.
- **Daemon data FS** (`~/.vibe-station/…/sessionDataDir`) — stores uploads + the `messages.jsonl` transcript, outside the checkout (auto-cleaned on session delete). The agent still reads/writes the **checkout** as its cwd.

---

## Entities & Modules

| Entity / Module | Layer | Responsibility | Key Dependencies |
|-----------------|-------|----------------|-----------------|
| `JsonAgentSession` | daemon/service | Per-turn spawn, lifecycle, transcript append, meta accumulation | `AgentPlugin`, `child_process` |
| `JsonAgentRegistry` | daemon/state | `sessionId → JsonAgentSession` (mirror of `directPtyRegistry`) | — |
| `AgentPlugin` (extended) | daemon/plugin | `supportsJson`, `runTurn(input,signal): AsyncIterable<NormalizedEvent>` | per-CLI files |
| `NormalizedEvent` / `UsageInfo` / `SessionMeta` | shared types | Provider-agnostic chat + meta contract | — |
| Transcript file | daemon data FS | `sessionDataDir/messages.jsonl` append-only history | `JsonAgentSession` |
| Uploads dir | daemon data FS | `sessionDataDir/uploads/<uid>/<name>` (under `~/.vibe-station/`) | attachments route |
| `ChatPane` + `useChat` | web-ui | Render messages, composer, status bar; WS subscribe + replay | `api/client.ts` |

---

## Alternatives Considered

| Option | Summary | Pros | Cons | Verdict |
|--------|---------|------|------|---------|
| **A — Direct `child_process` pipes + stream-json** | Spawn CLI with piped stdio, parse NDJSON | Clean structured data; matches claudecodeui + multica; no TTY corruption; explicit turn boundaries | New backend code | ✅ Chosen |
| **B — tmux/PTY with `--json`, parse pane output** | Reuse existing tmux stream, grep JSON from pane | Reuses stream plumbing | PTY injects ANSI/wrap/status framing → corrupts NDJSON; capture-pane is lossy; no clean stdin | ❌ Rejected |
| **C — Anthropic Agent SDK (claudecodeui-style)** | Use `@anthropic-ai/claude-agent-sdk` | Rich typing for claude | claude-only; doesn't generalize to cursor/gemini/opencode; couples us to one vendor | ❌ Rejected |
| **Process: per-turn spawn + `--resume`** | New process each user message; `--resume`/session-id continuity | Uniform across ALL 4 incl cursor; reuses `agentChatId`/`getRestoreCommand`; smallest build; no live-process mgmt | Per-turn cold-start latency (re-hydrate session each turn); differs from app's spawn-once TTY model | ⏳ Default for v1 (pending decision) |
| **Process: persistent (per-CLI native)** | One long-lived process per session | Matches app's spawn-once model; lower latency; ACP gives a normalized event schema for free | 3 different transports (stdin-stream / ACP / HTTP); cursor can't do it; bigger build | ⏳ Candidate v2 |

**Decision status — OPEN (was wrongly closed earlier).**
- Earlier rationale ("per-turn because persistent is impossible for 3/4 CLIs") was **factually wrong** — corrected by the verification below.
- Recommended resolution: a **pluggable transport** behind a long-lived `JsonAgentSession` — ship **per-turn for all 4 in v1**, upgrade gemini/opencode/claude to persistent later behind the same interface; cursor stays per-turn (structural).
- Reference implementations: multica spawns per-turn directly; claudecodeui uses the Agent SDK per message (claude) and per-turn spawn (cursor/gemini). Both confirm the per-turn pattern is viable; neither forecloses persistent.

---

## Harness JSON Capability — Verified (2026-06-20)

> Empirically tested against locally-installed binaries; not docs-only. Versions: claude 2.1.185, cursor-agent 2026.06.15, gemini 0.47.0 (installed 0.41.2), opencode 1.17.9 (installed 1.15.6).

| CLI | Persistent multi-turn in ONE process? | Mechanism | Verification |
|-----|--------------------------------------|-----------|--------------|
| **claude** | ✅ Yes (proven) | `--print --input-format stream-json --output-format stream-json` — persistent stdin loop | **Live test:** one process answered 2 stdin messages (`ONE`, `TWO`), same `session_id`, exited only on EOF. |
| **gemini** | ✅ Yes (structural + docs) | `--acp` — JSON-RPC over stdio (`newSession` once, repeated `prompt`) | `--acp` is a real flag; `gemini --acp </dev/null` **stayed alive** waiting for JSON-RPC (server loop), did not exit. Live `initialize` round-trip not captured (needs full ACP client; Zed/JetBrains use it in prod). Headless `-p` path is one-shot. |
| **opencode** | ✅ Yes (proven) | `opencode serve` (HTTP + SSE) or `opencode acp` (ACP stdio) | **Live test:** one `serve` process answered 3 HTTP requests — served web app, `POST /session` → `ses_1105…`, `GET /session` listed 100. Model round-trip gated by 0 provider credentials. `opencode run --format json` is one-shot. |
| **cursor** | ❌ No (proven) | none (CLI); persistent only via separate `@cursor/sdk` (SSE) | **Live test:** `-p … --output-format stream-json` ran `init→user→assistant ONE→result` then **process exited** (one-shot). `--input-format` → "unknown option (Did you mean --output-format?)". Continuity only via `--resume`/`--continue`. |

**Implications:**
- Persistent is viable for **3 of 4** (claude native stdin-stream — simplest; gemini ACP; opencode serve/ACP). **cursor is the sole one-shot holdout.**
- No single persistent protocol covers all 4 (cursor speaks none) → any persistent design still needs a per-turn path for cursor.
- ACP unifies gemini+opencode (+claude via `@zed-industries/claude-code-acp` adapter) under one normalized schema, partially satisfying F9 — but adds a JSON-RPC client + adapter dep + maturity risk, and still excludes cursor.
- Open sub-question: is **cursor-in-JSON a v1 requirement**? If cursor stays TTY-only for v1, the JSON feature is 3 persistent-capable agents and ACP-first becomes clean.

---

## Event Normalization — plugin-owned (F9)

> The daemon core **never sees raw CLI JSON**. Each plugin is the normalization boundary: the core asks "run this turn," the plugin yields events in our common language. This is the single mechanism behind the cross-harness chat + meta bar.

### Target model — what the UI renders (one shape for all CLIs)

| Our `kind` | Meaning | UI rendering | Feeds |
|------------|---------|--------------|-------|
| `session_init` | chat id, model, tool list captured | (not a bubble) model → status bar | `agentChatId`, `SessionMeta.model` |
| `user` | user's message (CLI echoes suppressed — we render our own optimistic bubble) | right-aligned user bubble | transcript |
| `thinking` | agent reasoning / thought (often streamed) | collapsible dim "Thinking…" block | transcript |
| `text` | assistant visible answer (supports `delta` streaming) | assistant markdown bubble | transcript |
| `tool_use` | agent invoked a tool (name + input) | tool card: name + args, running spinner | transcript |
| `tool_result` | tool output (ok / error) | attached to tool card; collapsible; error styling | transcript |
| `usage` | token / cost / context / model numbers | status bar (tokens, cost, context %) | `SessionMeta.usage` |
| `result` | turn finished (ok/error, duration, cost) | end turn → status idle; optional turn footer | `turnState`, `SessionMeta` |
| `error` | turn-level failure | red error card + retry | transcript |
| `status` | transient signal (rate-limit, queue pos, reconnect) | subtle indicator / toast | `SessionMeta.turnState` |

### Derived turn-state — the composer status indicator (from the latest event kind)

| `turnState` | Trigger | Composer shows |
|-------------|---------|----------------|
| `idle` | no active turn | enabled · "Ready" |
| `queued` | message accepted behind a running turn | pending bubble · "Queued (n)" |
| `thinking` | latest kind = `thinking`, no `text` yet | spinner · "Thinking…" |
| `responding` | latest kind = `text` | spinner · "Responding…" |
| `tool` | latest kind = `tool_use` (running) | spinner · "Running `<tool>`…" |
| `error` | last `result` = error | error state |

### Source → normalized mapping (✅ = live-verified 2026-07-14 against installed binaries; ⚠ = schema-derived, blocked)

Verified versions: claude 2.1.185, cursor-agent 2026.06.15, opencode 1.15.6 (`run --format json`). gemini ⚠ — **deauthed this session** (oauth creds file removed; `-p` hits an interactive browser login), rows stay schema-derived.

| Our `kind` | claude `stream-json` ✅ | cursor `stream-json` ✅ | opencode `run --format json` ✅ | gemini (`stream-json` / `--acp`) ⚠ |
|------------|------------------------|------------------------|--------------------------------|-------------------------------------|
| `session_init` | `system/init` (session_id, model, tools) | `system/init` (session_id, model, cwd) | `sessionID` on every event (no explicit init) | `init` / ACP `session/new` result |
| `user` | `user` (non-tool) — suppress echo | `user [text]` — suppress echo | (client-sent; not echoed) | `user` |
| `thinking` | `assistant`→`thinking` block; `system/thinking_tokens` (counter) | `thinking/delta` (streamed) + `thinking/completed` | `part.type=reasoning` | ACP `agent_thought_chunk` |
| `text` | `assistant`→`text` block; `stream_event` delta (`--include-partial-messages`) | `assistant`→`text` block; `--stream-partial-output` deltas | `type=text`, `part.type=text` (`part.text`) | `message` / ACP `agent_message_chunk` |
| `tool_use` | `assistant`→`tool_use` block | `tool_call/started`; tool name = the `tool_call.<shellToolCall\|readToolCall\|editToolCall>` key (NOT `Object.keys[0]` — siblings `toolCallId`/`startedAtMs`/`hookAdditionalContexts` exist); args = `.args` | `part.type=tool` `part.tool` + `state.input`. **`run --format json` delivers each tool ONCE already terminal** (`status=completed`/`error`) — no `running`/`pending` — so the parser synthesizes `tool_use` from the terminal part (guarded by tool id) | `tool_use` / ACP `tool_call` |
| `tool_result` | `user`→`tool_result` block (`tool_use_id`) | `tool_call/completed` (same `call_id`); outcome under `result.success` (ok) vs `result.failure` (→ **isError:true** — was hardcoded false) | `part.type=tool` `state.status=completed\|error` (isError on `error`) | ACP `tool_call_update` |
| `usage` | `result.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` (snake_case ✅); `result.total_cost_usd`; `result.modelUsage` | `result.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` — **camelCase ✅** (our `cacheCreateTokens` ← `cacheWriteTokens`); `total_cost_usd` | `step_finish part.tokens.{input,output,cache.read,cache.write}` ✅ (emitted on `reason=stop`) | `result` usage / ACP token fields |
| `result` | `result` (subtype success\|error, `num_turns`, `duration_ms`, `stop_reason`) | `result/success` \| `result/error` | `step_finish` `part.reason=stop` (turn end; `reason=tool-calls` between steps) | `result` / ACP `prompt` stopReason |
| `error` | `result.is_error` ✅ → typed `error` event (kept alongside `result`, not folded into `result.text`) | `result/error` ✅ → typed `error` event | `part.state.status=error` (isError on the `tool_result`) | `error` event |
| `status` | `rate_limit_event` ✅ → `status` "rate limit: <status>". `system/hook_started`/`hook_response`/`thinking_tokens` dropped (harmless) | — | `step_start`/`step_finish` boundaries (drop) | `available_commands_update`, `plan` |

**Notes from live capture (2026-07-14):**
- **claude**: tool **results** arrive as a `user` message with `tool_result` blocks (`{"type":"user",…content:[{tool_use_id,…}]}`) — parser must read `user` blocks, not only `assistant` text. `result` carries full usage + `total_cost_usd` + `modelUsage`.
- **cursor**: thinking = `thinking/delta` (streamed) then `thinking/completed`; tools = `tool_call/started` → `tool_call/completed` (matched by `call_id`), with a typed `tool_call.<shellToolCall|readToolCall|…>` payload. **Free plan → named models rejected; must use Auto (omit `--model`).**
- **opencode**: envelope is `{type, timestamp, sessionID, part:{type,…}}`; top-level `type` mirrors `part.type` (`text`/`tool`/`reasoning`) with `step_start`/`step_finish` boundaries; turn ends on `step_finish part.reason=stop`. `run --format json` works despite `auth list` showing 0 credentials (built-in/free provider). Per-turn usage/cost not clearly in `run` output → may require the `serve` message `info` (Risk).
- **gemini**: BLOCKED (deauthed). Rows from official docs — `--output-format stream-json` (PR #10883: init/message/tool_use/tool_result/error/result) or ACP `session/update`. Re-auth (`gemini` login or `GEMINI_API_KEY`) then capture in Phase 3 to promote to ✅. **Rows remain UNVERIFIED / gated.**

**Audit corrections (2026-07-15) — applied to parsers + tests:**
- **cursor usage** was read as snake_case (`input_tokens`…) but cursor emits **camelCase** (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) → tokens were always 0 in the status bar. Now reads camelCase (snake_case fallback kept). `cacheCreateTokens ← cacheWriteTokens`.
- **cursor tool errors** were hardcoded `isError:false`. Cursor puts outcome under `result.success` vs `result.failure`; failures now set `isError:true` and surface the failure detail.
- **cursor tool-name** was `Object.keys(tool_call)[0]` (could pick a sibling like `toolCallId`); now picks the key ending in `ToolCall`.
- **opencode tool_use** was never emitted in `run` mode (only the never-firing `running`/`pending` branch emitted it) → tool name/args lost. Now the terminal `completed`/`error` part also synthesizes `tool_use` (name + input) before `tool_result`, guarded by tool id to avoid duplicates.
- **claude + cursor turn errors** (`is_error`/`result/error`) now emit a typed `error` event alongside `result` (previously only folded into `result.text`).
- **claude `rate_limit_event`** was dropped; now mapped to a `status` event ("rate limit: <status>").

### agy (Antigravity CLI) — live-verified 2026-07-15, agy 1.1.2

> **What it is:** `agy` self-identifies (binary strings) as `antigravity-cli` — Google/Codeium's "Antigravity" agent (Go binary; `exa`/`cortex`/`cascade` = Windsurf/Codeium internals, plus `google3` protobufs). Models span Gemini 3.x, Claude 4.6 (Thinking), and GPT-OSS 120B. Conversations are stored per-cwd under `~/.gemini/antigravity-cli/` (`conversations/<id>.db`, `cache/last_conversations.json` mapping `cwd → latest conversation_id`, and `brain/<id>/…/transcript_full.jsonl`).
>
> **JSON mode is NOT a stream.** `agy --print=<msg> --output-format json` (hidden print-mode flags — only `text`/`json`; no `stream-json`, no ACP, no `serve`) emits **ONE final result envelope** on stdout at process exit. There are no live per-event NDJSON lines, so `thinking` / `tool_use` / `tool_result` / `user` / `status` cannot be exercised in JSON mode. The single envelope is fanned out by `parseAgyResultLine` into `session_init → text → usage → result (→ error)`. Context resume via `--conversation <id>` is verified stable (`num_turns` increments; prior-turn recall works). **`--print`/`-p`/`--prompt` is a STRING flag whose value IS the prompt** — a bare `--print` with the message on stdin or as a `--`-separated positional is mis-parsed into the prompt text, so the plugin uses the attached `--print=<msg>` form (safe for any message).

| Our `kind` | agy `--output-format json` | Status |
|------------|----------------------------|--------|
| `session_init` | `conversation_id` on the envelope → `agentChatId`; envelope carries **no model name**, so `model` is threaded in from the requested `--model` | ✅ verified |
| `user` | not echoed in JSON mode (we render our own optimistic bubble) | ✅ (n/a — no echo) |
| `thinking` | not surfaced as an event; only a `usage.thinking_tokens` counter | ⚠ not exercisable in print JSON |
| `text` | `response` (full assistant answer; may be partial on error) | ✅ verified |
| `tool_use` | not surfaced in print JSON (tools run internally; only the final answer is returned) | ⚠ not exercisable in print JSON |
| `tool_result` | not surfaced in print JSON | ⚠ not exercisable in print JSON |
| `usage` | `usage.{input_tokens,output_tokens,thinking_tokens,total_tokens}` ✅ (snake_case). **No cache tokens, no cost.** `thinking_tokens` already summed into `total_tokens` (no `UsageInfo` slot); `cacheReadTokens`/`cacheCreateTokens` forced 0 | ✅ verified |
| `result` | the envelope itself (`status`, `duration_seconds`, `num_turns`); on error carries the `error` text | ✅ verified |
| `error` | `status:"ERROR"` and/or an `error` string → typed `error` event alongside `result` (agy also sets `status:ERROR` when an internal tool hits a permission boundary even though `response` is valid) | ✅ verified |
| `status` | no transient status signals in print JSON | ⚠ n/a |

**Notes (agy):**
- **TTY mode:** launch `agy --dangerously-skip-permissions [--model "<display name>"]`; task prompt inline via `-i "<prompt>"` (runs then stays interactive). No system-prompt flag/env exists → the system prompt is folded into the first `-i` message (like cursor). Chat id captured from `cache/last_conversations.json[cwd]`; resume via `agy --conversation <id>`. agy is a Charm/Bubbletea TUI that negotiates terminal capabilities before painting (blocks in a bare captured PTY), so the ready signal is fallback-timed (no stable printed sentinel).
- **Model names are exact display strings** from `agy models` (e.g. `"Gemini 3.1 Pro (High)"`, `"Claude Sonnet 4.6 (Thinking)"`) — print mode hard-fails on an unresolvable `--model`. Default: `"Gemini 3.1 Pro (High)"`.
- **Hard failure vs in-turn error:** a non-zero exit with no JSON (e.g. unresolvable model) throws → core synthesizes an `error` event (Decision 7). An in-turn failure instead exits 0 with `status:"ERROR"` + `error`, handled by the parser.

---

## API / Contract

### REST (new)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/sessions/:id/chat` | `{ message: string, attachmentIds?: string[] }` | `202 { turnId, queuePosition }` | 400 (empty msg), 404 — **never 409**: always accepted, queued if a turn is running (see Decision 8) |
| `POST` | `/sessions/:id/chat/stop` | — | `200 { ok }` | 404, 409 (no active turn) |
| `POST` | `/sessions/:id/attachments` | `multipart/form-data` files[] | `201 { attachments: Attachment[] }` | 400 (no files), 413 (too big), 404 |
| `GET` | `/sessions/:id/transcript` | — | `200 { events: NormalizedEvent[] }` | 404 |
| `GET` | `/sessions/:id/meta` | — | `200 SessionMeta` | 404 |

### WS (new)

| Direction | Event | Payload |
|-----------|-------|---------|
| C→S | `chat:open` | `{ sessionId }` — subscribe + trigger transcript replay |
| C→S | `chat:close` | `{ sessionId }` |
| S→C | `chat:replay` | `{ sessionId, events: NormalizedEvent[] }` — full history on open |
| S→C | `session:message` | `{ sessionId, event: NormalizedEvent }` — one live event |
| S→C | `session:meta` | `{ sessionId, meta: SessionMeta }` — usage/model/turn-state update |

### Key Data Schemas

```
NormalizedEvent {
  id:        string
  sessionId: string
  ts:        string                 // ISO8601 (stamped by daemon)
  provider:  "claude"|"cursor"|"gemini"|"opencode"
  kind:      "session_init"|"user"|"thinking"|"text"|"tool_use"
             |"tool_result"|"usage"|"result"|"error"|"status"
  role?:     "user"|"assistant"
  text?:     string                 // user|text|thinking|error
  toolName?: string                 // tool_use
  toolId?:   string                 // tool_use|tool_result
  toolInput?: unknown               // tool_use
  toolResult?: { content?: string; isError?: boolean }
  usage?:    UsageInfo              // usage|result
  model?:    string
  turnId?:   string                 // set on user + every event of that turn
  attachments?: Attachment[]        // on user events (echoed for replay)
}

UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  totalTokens: number
  contextWindow?: number           // when harness reports it
  costUsd?: number                 // when harness reports it
  model: string
}

SessionMeta {
  sessionId: string
  channel:   "tmux"|"pty"|"json"
  modeId?:   string
  modeName?: string
  cli:       CliId
  model?:    string
  turnState: "idle"|"queued"|"thinking"|"responding"|"tool"|"error"
  queueDepth: number              // pending turns behind the active one
  usage?:    UsageInfo             // latest cumulative (rebuilt from transcript tail after restart)
}

Attachment {
  id:   string                     // uploadId
  name: string                     // sanitized filename
  path: string                     // absolute, under sessionDataDir (NOT the checkout)
  size: number
  mime: string
}
```

---

## API Reference — new surface, consumers & payloads

> Every new/changed endpoint, who calls it, and the request/response shape. Schemas above (`NormalizedEvent`, `SessionMeta`, `Attachment`) not repeated. `web` = web-ui, `cli` = `vst`.

### Daemon REST

| Method · Path | Consumers | Request | Response | Notes |
|---------------|-----------|---------|----------|-------|
| `POST /sessions/:id/chat` | web `Composer`; cli `vst chat` | `{ message, attachmentIds? }` | `202 { turnId, queuePosition }` | always accepted → FIFO queue (Dec 8) |
| `POST /sessions/:id/chat/stop` | web Stop btn; cli `vst chat stop` | — | `200 { ok }` | aborts active turn; keeps queue |
| `POST /sessions/:id/attachments` | web `Composer` upload | `multipart` files[] | `201 { attachments: Attachment[] }` | 413 too-big; confined to uploads dir |
| `GET /sessions/:id/transcript` | web `useChat` (fallback); cli `vst session transcript` | — | `200 { events: NormalizedEvent[] }` | full history; lazy |
| `GET /sessions/:id/meta` | web `StatusBar`; cli `vst session meta` | — | `200 SessionMeta` | latest usage/model/turnState |
| `POST /sessions` · `POST /projects/:id/sessions` *(mod)* | web `NewAgentDialog`/`DirectAgentDialog`; cli `vst session create` | `{ …, channel? }` (worktree + direct bodies) | `201 Session` | `channel: "tmux"\|"pty"\|"json"` |
| `POST /worktrees` *(mod)* | web `NewAgentDialog`; cli `vst worktree create` | `{ …, channel? }` | `201 Worktree` | channel applies to main agent |
| `DELETE /worktrees/:id` *(mod)* | web; cli `vst worktree rm` | — | `200 { ok }` | also purges `.vibe-station/uploads/` |

### Daemon WebSocket (`/ws`)

| Event · Dir | Consumers | Payload |
|-------------|-----------|---------|
| `chat:open` · C→S | web `useChat` (mount) | `{ sessionId }` → triggers replay |
| `chat:close` · C→S | web `useChat` (unmount) | `{ sessionId }` |
| `chat:replay` · S→C | web `useChat` | `{ sessionId, events: NormalizedEvent[] }` |
| `session:message` · S→C | web `useChat` → MessageList | `{ sessionId, event: NormalizedEvent }` |
| `session:meta` · S→C | web `useChat` → StatusBar | `{ sessionId, meta: SessionMeta }` |

### CLI (`vst`)

| Command | Calls | Args / Flags | Output |
|---------|-------|--------------|--------|
| `vst session create` *(mod)* | `POST /sessions` | `--json` → `channel:json` | session id (last line) |
| `vst worktree create` *(mod)* | `POST /worktrees` | `--json` → `channel:json` | worktree id (last line) |
| `vst chat <session> [msg]` | `POST /chat` | `[msg]`, `--file <path>` (attach), `--wait` | `turnId`; `--wait` streams transcript till `result` |
| `vst chat stop <session>` | `POST /chat/stop` | — | `ok` |
| `vst session transcript <session>` | `GET /transcript` | `--json` | events (NDJSON or pretty) |
| `vst session meta <session>` | `GET /meta` | `--json` | SessionMeta |

### Consumer map (who depends on what)

| Consumer | REST | WS |
|----------|------|----|
| `Composer` | chat, chat/stop, attachments | — |
| `useChat` hook | transcript (fallback) | chat:open/close, session:message, chat:replay |
| `StatusBar` | meta | session:meta |
| `NewAgentDialog` / `DirectAgentDialog` | POST worktrees / sessions / direct-sessions (channel) | — |
| `vst chat` / `vst session *` | chat, stop, transcript, meta | (optional `--wait` may poll transcript) |

---

## Data Model

### New / Modified records

| Entity | Field | Type | Notes |
|--------|-------|------|-------|
| `SessionRecord` (`daemon/src/types.ts:24`) | `channel` | `"tmux"\|"pty"\|"json"` | NEW. Derived default: `useTmux ? "tmux" : "pty"`. `json` set by launch flag. |
| `SessionRecord` | `transcriptRef` | `TranscriptRef` | EXISTING (unused). Set to `{ kind: "vst-json", path }` for JSON sessions. |
| `TranscriptRef.kind` (`types.ts:19`) | enum | add `"vst-json"` | currently `claude-jsonl\|opencode-session\|none`. |
| `SessionRecord` | `agentChatId` | `string?` | EXISTING. JSON mode: captured from turn-1 `session_init`, persisted, reused via `--resume`/`--session`. **Verified 2026-07-14: id is stable across per-turn resume (no fork) and context carries — claude/cursor/opencode all recalled turn-1 state.** gemini pre-mints its own id. |
| Transcript file | — | `messages.jsonl` | append-only `NormalizedEvent` per line, in `sessionDataDir`. |
| Uploads dir | — | dir | `sessionDataDir/uploads/<uploadId>/<file>` (worktree) or `directSessionDataDir/uploads/…` (direct) — under `~/.vibe-station/`, cleaned with the session. |

- Migrations needed: Y — on manifest load, backfill `channel` from `useTmux` (`state/project-store.ts` load path). No on-disk rewrite required; compute lazily via helper.
- Backwards-compatible: Y — legacy sessions have no `channel`; `sessionChannel(session)` helper returns `tmux`/`pty` from `useTmux`.

---

## Critical User Journeys (CUJs)

### CUJ 1 — Create a JSON agent with an initial prompt (happy path)

```
User                ChatPane            Daemon                 CLI harness
 │ create agent       │                   │                      │
 │ (JSON toggle +     │                   │                      │
 │  initial prompt) ──┼─ POST /worktrees ─▶│ persist channel=json │
 │                    │  {channel:json,     │ pin useTmux=false     │
 │                    │   prompt}           │ AUTO-ENQUEUE prompt   │
 │                    │                     │  as turn 1 (isFirst)  │
 │ open agent ────────┼── chat:open ──────▶│                      │
 │                    │◀ chat:replay[user] ─│ (turn-1 user event    │
 │                    │                     │  already persisted)   │
 │                    │                     │ spawn turn 1 (stdin   │
 │                    │                     │  msg, sys-prompt) ───▶│
 │                    │◀ session:message ◀─│◀── NDJSON lines ──────│
 │                    │  (text/tool/...)    │ append messages.jsonl │
 │                    │◀ session:meta ─────│ (turnState: thinking… )│
 │                    │◀ session:message ◀─│◀── result (usage) ────│ exit 0
 │◀ rendered + idle ──│◀ session:meta(idle)│ persist chatId (turn1) │
```

- The create-dialog **initial prompt is turn 1** — no manual Send needed. `isFirstTurn:true` → plugin applies the system prompt (per-CLI transport, Decision 3).
- The `user` event is daemon-synthesized + persisted at enqueue (Decision 12), so a client opening mid-turn replays it.

- Preconditions: project registered; harness on PATH.
- Success: messages rendered live; chatId captured; state → idle.
- Error paths: → CUJ 3.

### CUJ 2 — Attach a file and reference it

```
User           Composer            Daemon                Daemon data FS
 │ drop file ──▶│                   │                     │
 │              │── POST /attachments (multipart) ───────▶│ save sessionDataDir/uploads/<uid>/x.png
 │              │◀─ 201 {Attachment}│                     │
 │ send msg ───▶│── POST /chat {message, attachmentIds} ─▶│ resolve paths
 │              │                   │ inject "[Attached files:]\n<path>" into prompt
 │              │                   │ spawn turn ─────────▶ harness reads <path> from disk
 │◀ response ───│◀ session:message ─│                     │
```

- Error/edge: oversized file → 413, chip shows error, message still sendable without it.
- Edge: attachmentId not found at send → 400, composer keeps draft.

**At creation (create-dialog attachment row).** Attachments also work for the *first* turn of a brand-new JSON agent, not just an existing chat. The create dialogs (`NewAgentDialog`, `DirectAgentDialog`, `NewTabDialog`) show an attachment picker (staged `File[]`, reusing `AttachmentChip`) when `channel==="json"`. To avoid a double turn-1, the UI JSON create path does **not** put the prompt in the create body (which would auto-enqueue turn 1, Decision 8); instead it:

```
User          Create dialog (JSON)     Daemon
 │ pick file ─▶│ (staged File in state) │
 │ + prompt    │                        │
 │ Create ────▶│─ POST create {channel:json, NO prompt} ─▶│ create idle JSON session (no turn 1)
 │             │◀─ 201 {…, mainSessionId / session id} ───│
 │             │─ POST /attachments (staged files) ──────▶│ save under sessionDataDir/uploads
 │             │◀─ 201 {Attachment[]} ───────────────────│
 │             │─ POST /chat {prompt, attachmentIds} ────▶│ turn 1 (isFirstTurn → system prompt + inject paths)
```

- **Rule:** prompt-in-create-body → daemon auto-enqueues turn 1 (CLI path, `vst … --json --prompt`, no attachments); **UI JSON path → prompt + attachments sent via `POST /chat`** after the session exists. Exactly one of the two runs, never both.
- Worktree-main path addresses the main agent via the create response's new `mainSessionId`; direct + additional-tab paths use the returned session id.
- Brand-new-project create (`NewAgentDialog` create mode) still doesn't apply the JSON channel, so no attachment row there.

### CUJ 3 — Turn fails / harness exits non-zero

```
User           ChatPane            Daemon                CLI harness
 │ send ───────▶│── POST /chat ────▶│ spawn turn ────────▶│
 │              │                   │◀ stderr / exit≠0 ───│ crash
 │              │◀ session:message ─│ kind:error {text}    │
 │              │◀ session:meta ───│ turnState:error      │
 │◀ error card ─│  + retry affordance│ append error to jsonl│
```

- Error conditions: harness missing, bad flag, non-zero exit, malformed NDJSON line (skip + log, don't kill turn).
- Recovery: composer re-enabled; user retries; partial transcript preserved.

### CUJ 4 — Reconnect / reload mid-history

```
User reloads → ChatPane mounts → chat:open → daemon reads messages.jsonl
  → chat:replay {events} → list renders full history → live stream resumes
```

- Edge: turn in progress during reload → replay shows partial, live `session:message` continues (turn process unaffected — it's writing to jsonl, not the socket directly).

---

## Key Decisions

#### Decision 1: Third execution channel, not a third boolean
- **Decision:** Add `channel: "tmux"|"pty"|"json"` to `SessionRecord`; route all backend branches through a `sessionChannel(session)` helper instead of `session.useTmux`.
- **Rationale:** `useTmux` is boolean; a third mode breaks it. A helper keeps one source of truth and avoids scattered `if (cli===...)`-style drift.
- **Where:** `daemon/src/types.ts` `SessionRecord` (field, alongside `useTmux`), new `daemon/src/services/channel.ts` (helper); route every `session.useTmux` branch through it — current branch sites: `services/spawn.ts` (`spawnSession`/`spawnSessionFromArgv`), `routes/sessions.ts` (create/delete/input), `services/lifecycle.ts`, `ws/handlers/sessionOpen.ts`. (Line numbers omitted — files shifted materially post-rebase; grep `session.useTmux`.)

#### Decision 2: Pluggable transport behind a long-lived `JsonAgentSession` (process model — OPEN)
- **Decision:** `JsonAgentSession` is long-lived (registered like `directPtyRegistry`) and drives the plugin's `runTurn()` per queued turn (Decision 3). The **transport is a per-plugin detail**: per-turn spawn (`child_process.spawn`, parse NDJSON, exit on `result`, resume via `--resume <agentChatId>`) OR persistent (claude stdin-stream / gemini ACP / opencode serve). v1 default: **per-turn for all 4**.
- **Rationale:** Decouples the contested process-model choice from the UI/session/registry layers — per-turn ships fastest and uniformly (incl cursor); persistent can replace a plugin's transport later with no change to UI, session abstraction, or other plugins. Satisfies the spawn-once consistency concern at the daemon-session layer regardless of underlying transport.
- **Open:** final v1 transport per CLI pending decision (see Harness JSON Capability + Risk #8). cursor is per-turn-only structurally.
- **Where:** new `daemon/src/services/jsonAgent.ts`, `daemon/src/ws/streams/jsonAgentStream.ts`, `daemon/src/state/jsonAgentRegistry.ts`; transport drivers in `agent-plugins/*`.

#### Decision 3: Plugin is the normalization boundary — core asks for a turn, plugin yields our common language
- **Decision:** The plugin owns spawn/transport **and** conversion. The core interface speaks only `NormalizedEvent` — it never sees raw CLI JSON, never `JSON.parse`es a CLI line, never branches on `cli`.
```ts
interface AgentJsonTransport {           // implemented per plugin
  supportsJson(): boolean;
  // Run ONE turn; yield normalized events as they arrive; the async-iterator
  // completing == turn done (a `result` event was emitted). signal aborts/stops.
  runTurn(input: TurnInput, ctx: TurnContext, signal: AbortSignal): AsyncIterable<NormalizedEvent>;
}
// TurnInput   { message, attachmentPaths, isFirstTurn }
// TurnContext { cwd, project, worktree|null, session, chatId?, model?, systemPromptFile, daemonPort }
//   cwd = worktree path OR project path (direct); chatId reused across turns (stable — verified).
// JsonAgentSession (core): for await (ev of plugin.runTurn(input, ctx, signal)) { persist+broadcast(ev) }
```
- **Rationale:** Exactly the model requested — "the interface asks for the result in a common JSON language; the plugin returns the proper answer." `TurnContext` carries cwd + session/project so the plugin can spawn correctly for **worktree and direct** sessions. Adding a 5th CLI = one `runTurn`, zero calling-code edits.
- **Internal-only helpers (not the interface):** stream-json plugins use a private `parseStreamJsonLine(line, ctx)`; ACP plugins drive the official ACP client; `serve` plugins read SSE — all emitting `NormalizedEvent`.
- **Where:** `daemon/src/services/spawn.ts` (`AgentPlugin` interface — unchanged post-rebase, extend it), `agent-plugins/{claude,cursor,gemini,opencode}.ts` (each `runTurn` + private parser).
- **System-prompt transport is NOT uniform — per plugin (verified against current plugin files):**
  - claude: `--append-system-prompt` (or `--system-prompt-file`); message via **stdin** (see below).
  - gemini: **`GEMINI_SYSTEM_MD` env** → system-prompt file (`gemini.ts:49-53`); chat id **pre-minted** as `--session-id` (`gemini.ts:74-78`), not `--resume`.
  - opencode: **`OPENCODE_CONFIG` env** → JSON config carrying the system prompt (`opencode.ts:56-69`).
  - cursor: bake system prompt into **message 1** (`cursor.ts:81-103`) — no system-prompt flag.
  - System prompt is applied on the **first turn only**; resumed turns rely on the CLI's own session state (claude `--append-system-prompt` may be re-passed harmlessly, cursor must NOT re-inject it).
- **Per-CLI turn invocations (message via stdin where the CLI supports it — avoids `MAX_ARG_STRLEN` ~128KB on large messages):**
  - claude: `claude -p --output-format stream-json --verbose --dangerously-skip-permissions [--model m] [--resume <id>] --append-system-prompt @<sysfile>` — **message on stdin** (`-p` reads stdin). Never pass `--fork-session` (would mint a new id).
  - cursor: `cursor-agent -p <msg> --output-format stream-json [--resume <id>] -f` — **Auto model on Free plans** (omit `--model`).
  - gemini: `gemini --output-format stream-json --yolo --session-id <preminted> [--model m]` + `GEMINI_SYSTEM_MD` env — message via stdin/`--prompt`; `--resume`/`--session-id` coexistence unverified (deauthed).
  - opencode: `opencode run <msg> --format json [--model m] [--session <id>]` + `OPENCODE_CONFIG` env (flag confirmed `--format json`).

#### Decision 4: Normalized contract feeds the cross-harness meta bar
- **Decision:** One `NormalizedEvent`/`UsageInfo`/`SessionMeta` schema; each plugin's `runTurn` (private parser) maps its CLI's events (`system/init`, `assistant`, `result`, `usage`) into it. UI never sees raw CLI JSON.
- **Rationale:** F8/F9 — common info from all harnesses with no UI-side branching.
- **Where:** shared types in `daemon/src/types.ts` + mirror `web-ui/src/api/types.ts`; accumulation in `services/jsonAgent.ts`.

#### Decision 5: Attachments live under `sessionDataDir` (NOT the checkout), absolute paths injected
- **Decision:** Save uploads under the per-session data dir — `sessionDataDir(project,worktree,session)/uploads/<uid>/<name>` (worktree) or `directSessionDataDir(project,session)/uploads/<uid>/<name>` (direct). Inject the **absolute** path into the message: `\n\n[Attached files:]\n<abs path>`. The agent reads it by absolute path (its cwd is the checkout; the file lives beside the transcript, outside the checkout).
- **Rationale:** `assertSafeToDelete` (`services/paths.ts:16-40`) **refuses to delete anything outside `~/.vibe-station/`**, and non-purge worktree DELETE deliberately keeps checkout files (`routes/worktrees.ts:557`) — so uploads-in-checkout could never be cleaned and would pollute the branch. `sessionDataDir` is already under `~/.vibe-station/` and is **already removed when the session/worktree is deleted**, so cleanup is free and F7 holds for worktree AND direct sessions with no extra delete logic. No `.gitignore` needed (outside the repo).
- **Where:** new `routes/attachments.ts` (or extend `routes/sessions.ts`) writing under `sessionDataDir`/`directSessionDataDir`; **no separate cleanup code** — existing session/worktree data-dir teardown covers it. Sanitize filename; reject traversal; size-cap.

#### Decision 6: Transcript persistence + replay (no scrollback equivalent)
- **Decision:** Append every `NormalizedEvent` to `messages.jsonl` in `sessionDataDir`; `chat:open` replays it via `chat:replay`. Mirrors tmux's scrollback-replay but structured.
- **Rationale:** F5/N3 — page reloads and reconnects must restore the conversation; per-turn processes don't hold history in memory.
- **Where:** `services/jsonAgent.ts` (append), `ws/handlers/chatOpen.ts` (replay), `GET /sessions/:id/transcript` fallback.

#### Decision 7: Malformed-line tolerance
- **Decision:** A line that fails `JSON.parse` or maps to no event is logged and skipped; the turn continues. Non-zero exit emits a synthetic `kind:error` event.
- **Rationale:** Harnesses interleave non-JSON logs on stdout/stderr; one bad line must not abort a turn.
- **Where:** `services/jsonAgent.ts` line reader.

#### Decision 8: Turn queueing is daemon-owned (never the UI)
- **Decision:** `JsonAgentSession` owns a per-session **FIFO turn queue**. `POST /chat` always returns `202 { turnId, queuePosition }` (never busy-rejects). The runner starts the next turn only after the current one's iterator completes (its `result` fired and the process/transport closed). `turnState` (six-state) + `queueDepth` broadcast via `session:meta`.
- **Turn 1 = the create-dialog prompt.** The initial task prompt supplied at agent creation is **auto-enqueued as the first turn** (with `isFirstTurn:true` so the plugin applies the system prompt). No user Send is needed to start; the CUJ 1 flow shows this.
- **Rationale:** One conversation = strictly sequential turns (you can't have two `--resume` turns — or two ACP `prompt`s — in flight on one session). The daemon is the only correct serialization point: authoritative across multiple tabs/clients, survives UI reload. The UI just POSTs and optimistically renders a "queued" bubble — it implements **no** ordering logic.
- **Transport-agnostic:** the same queue is reused unchanged if a plugin later swaps to a persistent transport (ACP/serve also serialize per session).
- **Stop / cancel semantics:** `POST /chat/stop` aborts the **active** turn (Decision 13 `abortAndDrain`); queued turns are **kept**. `DELETE /sessions/:id/chat/queue/:turnId` cancels **one** queued turn. When only queued turns exist (no active), `/chat/stop` is a no-op (200) — use the per-turn cancel or `clear queued`.
- **Meta durability:** `SessionMeta`/cumulative `usage` is in-memory → after a daemon restart, `GET /meta` **rebuilds from the transcript tail** (last `usage`/`result` events in `messages.jsonl`).
- **v1 durability:** in-memory queue; un-started turns are lost on daemon restart (acceptable — the running turn is lost too, and Decision 13 kills its orphan). Persist `pending.jsonl` deferred to v2.
- **Where:** `services/jsonAgent.ts` (queue + runner + meta rebuild), `routes/sessions.ts` (`POST /chat`, `/chat/stop`, `DELETE …/queue/:turnId`), `SessionMeta.turnState`/`queueDepth`.

#### Decision 9: Rich content rendering — markdown is the agent's native output, treated as untrusted
- **Decision:** Assistant `text` and `thinking` are **markdown (GFM)** and rendered as such: headings, lists, tables, links, inline code, and **fenced code blocks with syntax highlighting + copy button**. Tool payloads render structurally: `tool_use` input as pretty JSON/code (collapsible); `tool_result` as monospace (collapsible), with **unified-diff detection → diff view** for edit tools. v1 = markdown + code + diff. **Mermaid** (```mermaid) → lazy-loaded, sandboxed SVG render, feature-flagged (v1.5); falls back to a code block. **KaTeX/math** deferred.
- **Streaming-tolerant:** deltas may arrive mid-block — the renderer tolerates an unterminated ``` fence and only finalizes highlighting/mermaid on block close or turn `result`.
- **Untrusted output (security):** agent text is rendered markup → **disable raw HTML**, sanitize URLs (drop `javascript:`/`data:`), sandbox mermaid. Treat all agent/tool output as untrusted (N5-adjacent).
- **Optional model hint:** `tool_result.contentType?` carried when a CLI provides it (e.g. opencode parts), else inferred (diff/json/text).
- **Reuse (post-rebase):** main already ships the whole stack **and the components** — `preview/{MarkdownView,CodeBlock,DiffView,MermaidView}.tsx` all exist (MermaidView already uses `securityLevel:"strict"`), deps (`react-markdown`/`remark-gfm`/`rehype-highlight`/`shiki`/`mermaid`/`dompurify`) all in `package.json`. **Reuse all four.**
- **Net-new is only the streaming-tolerant wrapper** (tolerate an unterminated ``` fence mid-delta; finalize highlight/mermaid on block close) + wiring these into the chat renderers. No new files for diff/mermaid, no new deps.
- **Where:** reuse `web-ui/src/components/preview/{MarkdownView,CodeBlock,DiffView,MermaidView}.tsx` (extract to shared if a chat-specific variant is needed); `styles/chat.css` (code theme on `--font-mono` + 100gb palette).

#### Decision 10: Chat-id capture — capture once on turn 1, persist, reuse (verified stable)
- **Decision:** Capture `agentChatId` from turn 1's `session_init` and **persist via `mutateProject` before the next queued turn dequeues**. Reuse it for every later turn (`--resume`/`--session`). Re-capturing each turn is harmless (idempotent) but not required.
- **Verified 2026-07-14 (per-turn `--resume`/`--session`):** claude, cursor, opencode **all keep the same session id across turns and carry context** (turn-2 recalled "7"). The id does **not** fork. So no per-turn churn — but persist turn-1's id durably so a restart mid-conversation can still resume.
- **Per-CLI:** claude/cursor `--resume <id>` (stable, **never** claude `--fork-session`); opencode `--session <id>`; **gemini pre-mints** its own UUID as `--session-id` (`gemini.ts:74-78`) — we control the id, no capture needed.
- **Where:** `services/jsonAgent.ts` (capture + `mutateProject` persist between turns); `SessionRecord.agentChatId`.

#### Decision 11: JSON lifecycle & boot recovery (pin `useTmux=false`, channel-aware guards)
- **Decision:** `channel==="json"` forces `useTmux=false`. Add channel-aware early-exits so JSON sessions are driven by turn/queue state, not tmux/pty heuristics: (a) `recover.ts` must **not** mark a `not_started` JSON session `exited` on boot (it has no direct-pty stream — that's normal); (b) `lifecycle.ts` must skip both the `hasSession` tmux check and the direct-pty exit path for JSON; (c) on boot, reconcile a JSON session left at `working` → `idle` (no live turn survives a restart).
- **Rationale:** `recoverNotStartedSessions` (`recover.ts:20-40`) marks `not_started`+`useTmux===false`+not-in-`directPtyRegistry` as `exited` — exactly a fresh JSON session. `lifecycle.ts:118`/`:161` would misfire too. Without guards, JSON sessions get stranded/killed on boot or first poll.
- **Where:** `services/recover.ts`, `services/lifecycle.ts` (both branch on `sessionChannel(session)`), `services/channel.ts`.

#### Decision 12: User events are daemon-owned (persisted + broadcast), not UI-only
- **Decision:** At enqueue, the daemon synthesizes a `user` `NormalizedEvent` (with `turnId` + `attachments`), appends it to `messages.jsonl`, and broadcasts it via `session:message` — **before** the turn runs. The UI renders its optimistic bubble immediately and **dedupes by `turnId`** when the authoritative `user` event arrives.
- **Rationale:** Otherwise the user's own messages are lost on replay and invisible to other tabs (only the assistant side was persisted). `user`+`status` added to the `NormalizedEvent.kind` enum.
- **Where:** `services/jsonAgent.ts` (enqueue synthesizes+persists+broadcasts); `hooks/useChat.ts` (dedupe by `turnId`).

#### Decision 13: Turn abort & orphan-process safety
- **Decision:** Each per-turn child is spawned in its **own process group**; `JsonAgentSession` records live PIDs. `POST /chat/stop`, session DELETE, and worktree DELETE all call `jsonAgentRegistry.get(id)?.abortAndDrain()` (abort active turn's `AbortSignal` → kill the group, clear the queue) **before** any purge. On boot, kill any recorded-but-orphaned PIDs.
- **Rationale:** Piped `child_process` children survive daemon death and keep mutating the checkout; current DELETE paths only kill tmux/direct-pty (`worktrees.ts:533-546`, `sessions.ts:544-553`) — a running JSON turn would be orphaned and could write into a worktree mid-purge.
- **Where:** `services/jsonAgent.ts` (process groups, PID registry, `abortAndDrain`); `routes/worktrees.ts` + `routes/sessions.ts` DELETE; boot sweep in `recover.ts`.

#### Decision 14: Pane selection preserves the TerminalPane remount invariant
- **Decision:** Do **not** put `TerminalPane` behind an `if/else` vs `ChatPane` (forbidden by `web-ui/AGENTS.md:7-41`). Keep `TerminalPane` **permanently mounted** in the slot and pass `sessionId={null}` when a JSON session is active (it already accepts null); render `ChatPane` beside it and toggle **visibility** (CSS), not mounting.
- **Rationale:** Unmount/remount on tab-type switch recreates the ghost-stream bug main just fixed via `withSessionLock` (`9dc10ef`). Visibility-toggle keeps the terminal stream stable.
- **Where:** `web-ui/src/routes/Workspace.tsx` (`agentPane`/`directAgentPane` slots).

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/types.ts` | Add `channel` to `SessionRecord`; `vst-json` to `TranscriptRef`; export `NormalizedEvent`/`UsageInfo`/`SessionMeta`/`Attachment`. |
| `daemon/src/services/channel.ts` | NEW — `sessionChannel(session)` + `resolveChannel(useTmux, json)`. |
| `daemon/src/services/spawn.ts` | Extend `AgentPlugin` with `AgentJsonTransport` (`supportsJson` + `runTurn`); branch worktree **and direct** spawn on `channel==="json"` → `JsonAgentSession` (cwd = worktree or project path). |
| `daemon/src/services/jsonAgent.ts` | NEW — `JsonAgentSession`: consume `plugin.runTurn`, transcript append, meta accumulate, FIFO queue+runner, emit events. cwd-agnostic (worktree/direct). |
| `daemon/src/ws/streams/jsonAgentStream.ts` | NEW — EventEmitter adapting `JsonAgentSession` to WS (`message`/`meta`/`replay`). |
| `daemon/src/state/jsonAgentRegistry.ts` | NEW — `Map<sessionId, JsonAgentSession>`. |
| `daemon/src/agent-plugins/claude.ts` | Add `supportsJson` + `runTurn` (private `parseStreamJsonLine`; `user`→`tool_result` mapping confirmed). Headless — no `--chrome`. |
| `daemon/src/agent-plugins/cursor.ts` | `runTurn` (`thinking/delta`+`/completed`, `tool_call/started`+`/completed`). Free plan → Auto model (omit `--model`). |
| `daemon/src/agent-plugins/gemini.ts` | `runTurn` — capture live schema first (deauthed this session). |
| `daemon/src/agent-plugins/opencode.ts` | `runTurn` via `run --format json` (flag confirmed); envelope `{type,part:{type,state.status,tool}}`, turn-end `step_finish reason=stop`. |
| `daemon/src/routes/sessions.ts` | Add `channel?` to **both** `WorktreeSessionBody` + `DirectSessionBody`; **flow `channel` through `serializeSession` (`:207-224`)**; add `POST /:id/chat`, `/chat/stop`, `DELETE …/chat/queue/:turnId`, `GET /:id/transcript`, `/:id/meta`; DELETE → `jsonAgentRegistry.abortAndDrain` (Dec 13). |
| `daemon/src/routes/worktrees.ts` | Add `channel?` to worktree create body (main agent); DELETE → `jsonAgentRegistry.abortAndDrain` before purge (Dec 13). |
| `daemon/src/routes/attachments.ts` | NEW — `POST /sessions/:id/attachments` → save under `sessionDataDir/uploads/` (sanitize + size cap). |
| `daemon/src/ws/protocol.ts` | Add `chat:open`/`chat:close` (C→S), `chat:replay`/`session:message`/`session:meta` (S→C); **add `channel` to `SessionCreatedSnapshot` (`:103-116`)**. |
| `daemon/src/ws/handlers/chatOpen.ts` | NEW — subscribe + replay transcript; bridge `jsonAgentStream` events to socket. |
| `daemon/src/ws/server.ts` | Dispatch `chat:open`/`chat:close`. |
| `daemon/src/services/lifecycle.ts` | Channel-aware early-exit for JSON (skip `hasSession`/direct-pty paths); state from turn/queue presence (Dec 11). |
| `daemon/src/services/recover.ts` | Channel-aware guard: don't mark `not_started` JSON sessions `exited` on boot; reconcile `working`→`idle`; kill orphaned turn PIDs (Dec 11/13). |
| `web-ui/src/api/types.ts` | Mirror normalized schemas; extend `CreateSessionBody`/`CreateDirectSessionBody`/`CreateWorktreeBody`/`Session` with `channel`; add WS event types. |
| `web-ui/src/api/client.ts` | `openChat`/`closeChat`/`sendChat`/`stopChat`/`uploadAttachments`/`getTranscript`/`getMeta`; route `chat:*`. |
| `web-ui/src/hooks/useChat.ts` | NEW — subscribe message/meta, maintain `events[]`+`meta`, open/close lifecycle, replay merge. |
| `web-ui/src/components/layout/ChatPane.tsx` | NEW (canonical path `layout/ChatPane.tsx`) — message list + composer + status bar; shown when `channel==="json"` (worktree main, additional, or direct agent). Subcomponents live in `components/chat/`. |
| `web-ui/src/components/chat/*` | NEW — `MessageList`, `TextMessage`, `ThinkingBlock`, `ToolUseCard`, `ToolResultCard`, `ErrorCard`, `Composer`, `AttachmentChip`, `StatusBar` + a streaming-tolerant markdown wrapper. **Reuse** `preview/{MarkdownView,CodeBlock,DiffView,MermaidView}` — no new render components. |
| `web-ui` deps | **None new** — `react-markdown`/`remark-gfm`/`rehype-highlight`/`shiki`/`mermaid`/`dompurify` already in `package.json` (shipped on main). |
| `daemon/src/services/jsonAgent.ts` | The turn engine + **FIFO queue/runner** (Dec 8), turn-1 auto-enqueue, `user`-event synth+persist+broadcast (Dec 12), chat-id capture+persist (Dec 10), per-turn **process groups + PID registry + `abortAndDrain`** (Dec 13), meta rebuild from transcript. |
| `web-ui/src/routes/Workspace.tsx` | Keep `TerminalPane` **permanently mounted** (`sessionId=null` when JSON active) + toggle `ChatPane` visibility beside it — no if/else remount (Dec 14). |
| `web-ui/src/components/dialogs/NewAgentDialog.tsx` | Add "JSON chat" toggle (primary agent-creation entry). |
| `web-ui/src/components/dialogs/DirectAgentDialog.tsx` | Add "JSON chat" toggle (direct-session agent creation). |
| `web-ui/src/components/dialogs/NewTabDialog.tsx` | Add "JSON chat" toggle (additional `a{n}` agents via `createSession`, `:40`). |
| `web-ui/src/styles/chat.css` | NEW — chat layout using `tokens.css` vars. |
| `cli/src/...` (session/worktree create) | Add `--json` flag → `channel: "json"`. |
| `docs/SESSION-EXECUTION.md`, `docs/API-CONTRACT.md` | Document JSON channel + new endpoints/events. |

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | ✅ RESOLVED — opencode JSON | Flag confirmed `--format json`; envelope `{type,part:{type,state.status,tool}}` verified live. Open nuance: per-turn usage/cost not in `run` output → may need `serve` message `info`. |
| 2 | ✅ RESOLVED — cursor one-shot | Verified live: `-p … --output-format stream-json -f` emits `init→…→result/success` then exits. Per-turn + `--resume`/`--continue`. |
| 3 | ⚠ gemini live schema | Deauthed this session — `stream-json` taxonomy + `--resume` coexistence unverified. Re-auth and capture in Phase 3; fall back to `--session-id` if `--resume` conflicts. |
| 4 | Context-window source per CLI | Not all harnesses report `contextWindow`/`costUsd`; UI shows only fields present (graceful). |
| 5 | Large transcript replay cost | Cap `chat:replay` to last N events; offer `GET /transcript` for full history (lazy). |
| 6 | Pane remount invariant | Solved by Decision 14 — `TerminalPane` stays permanently mounted (`sessionId=null` when JSON active), `ChatPane` visibility-toggled beside it. Never an if/else swap (would recreate the ghost-stream bug `9dc10ef` fixed). Verify no remount on tab-type/fullscreen toggle. |
| 7 | ✅ RESOLVED — attachment storage/cleanup | Uploads live under `sessionDataDir/uploads/` (not the checkout), so `assertSafeToDelete` allows cleanup and non-purge worktree delete doesn't strand them; removed with the session data dir (Decision 5). Still sanitize filename + reject traversal. |
| 8 | **Process model: per-turn vs persistent?** | OPEN. Per-turn = uniform/fast v1; persistent = matches app + ACP normalization but heterogeneous. Verified: 3/4 persistent-capable, cursor one-shot. Pluggable transport (Decision 2) defers the lock-in. |
| 9 | **Is cursor-in-JSON a v1 requirement?** | If cursor stays TTY-only for v1, JSON feature = 3 persistent-capable agents → ACP-first becomes clean. Decides whether a per-turn path is needed at all in v1. |
| 10 | **Adopt ACP (write/embed an ACP client)?** | gemini+opencode native ACP, claude via `@zed-industries/claude-code-acp` adapter. Don't hand-roll — use the official `@zed-industries/agent-client-protocol` npm client. Buys one normalized schema for 3 agents; cost = JSON-RPC client + adapter dep + maturity risk; excludes cursor. |
| 11 | **Streaming markdown rendering robustness** | Deltas split fences/tables mid-block. Use a streaming-tolerant renderer; finalize highlight/mermaid on block close. Verify partial ``` fence doesn't break layout (Decision 9). |
| 12 | **Untrusted-output XSS surface** | Agent text + tool output rendered as markup. Disable raw HTML, sanitize URLs, sandbox mermaid. Security review before GA (Decision 9). |
| 13 | **Mermaid scope** | `mermaid` dep already shipped on main → no bundle cost. Still flagged v1.5 for render-robustness/sandbox; code-block fallback. |

---

## Implementation Phases

### Phase 1 — Shared contracts + channel field
- [ ] 1.1 Add `channel` to `SessionRecord`, `vst-json` to `TranscriptRef`, and `NormalizedEvent`/`UsageInfo`/`SessionMeta`/`Attachment` to `daemon/src/types.ts`.
- [ ] 1.2 Add `daemon/src/services/channel.ts` with `sessionChannel()`/`resolveChannel()`; `channel==="json"` **forces `useTmux=false`**; backfill default from `useTmux` on manifest load.
- [ ] 1.3 Extend WS schemas in `ws/protocol.ts` (new C→S + S→C events; add `channel` to `SessionCreatedSnapshot`) — validation only, no handlers yet.
- [ ] 1.4 Flow `channel` through `serializeSession` (`routes/sessions.ts:207-224`) + the `session:created` snapshot; mirror schemas + extend `CreateSessionBody`/`CreateDirectSessionBody`/`CreateWorktreeBody`/`Session` in `web-ui/src/api/types.ts`.

**Verify phase 1:**
- [ ] **1.T1** Unit — `channel.ts`: `sessionChannel({useTmux:false})` → `"pty"`; `{channel:"json"}` → `"json"` (+ `useTmux` coerced false); legacy `{useTmux:true}` → `"tmux"`.
- [ ] **1.T2** Unit — `ws/protocol.ts` Zod: valid `chat:open` parses; malformed `session:message` rejected; snapshot carries `channel`.
- [ ] **1.T3** Regression — existing manifest with no `channel` loads without error (`project-store` load test).
- [ ] **1.T4** Integration — creating a `channel:json` session → `serializeSession` + `session:created` snapshot both carry `channel:"json"` (so the right pane renders without a refetch).

### Phase 2 — Daemon JSON backend (claude as reference)
- [ ] 2.1 Add `AgentJsonTransport` to `AgentPlugin` (`spawn.ts`): `supportsJson()` + `runTurn(input, signal): AsyncIterable<NormalizedEvent>` (Decision 3). Implement in `claude.ts` (spawn argv + private `parseStreamJsonLine` mapping `system/init`→`session_init`, `assistant`/`thinking`/`tool_use` blocks, `user`→`tool_result`, `result`→`result`+`usage`).
- [ ] 2.2 `jsonAgent.ts`: `JsonAgentSession` consumes `plugin.runTurn(input, ctx, signal)` — synth+persist+broadcast the `user` event at enqueue (Dec 12), `for await (ev)` persist to `messages.jsonl`, accumulate `UsageInfo`, capture `agentChatId` from `session_init` + **persist via `mutateProject`** (Dec 10), broadcast; handle exit/error (Decision 7). Core does **no** `JSON.parse`.
- [ ] 2.3 `jsonAgentRegistry.ts` + `jsonAgentStream.ts`; register on first turn; spawn per-turn child in its **own process group** + track PID (Dec 13); cleanup on session delete.
- [ ] 2.4 Branch `spawn.ts`/`sessions.ts` create on `channel==="json"` (no PTY spawn at create; process starts on turn 1 = auto-enqueued create-dialog prompt, Dec 8).
- [ ] 2.5 Channel-aware lifecycle: `recover.ts` skips JSON `not_started` sessions (Dec 11); `lifecycle.ts` skips tmux/pty paths for JSON.

**Verify phase 2:**
- [ ] **2.T1** Unit — claude `runTurn` parser: a real claude `result` line → `UsageInfo` with correct input/output/cache token sums; an `assistant` `tool_use` block → `kind:"tool_use"`; a `user`→`tool_result` block → `kind:"tool_result"`.
- [ ] **2.T2** Integration — `JsonAgentSession` (mock CLI, fixture NDJSON): synth `user` event first, then ordered `text`→`result`; writes `messages.jsonl`, persists `agentChatId`, ends `turnState:idle`.
- [ ] **2.T3** Integration — malformed line in fixture is skipped; turn completes (Decision 7).
- [ ] **2.T4** Regression — TTY session create (`channel:tmux`/`pty`) still spawns as before.
- [ ] **2.T5** Regression — `recover.ts` boot: a `not_started` JSON session is **not** marked `exited`; a `working` JSON session reconciles → `idle` (Dec 11).
- [ ] **2.T6** Integration — the daemon-synthesized `user` event is persisted + replayed on `chat:open` (not UI-only).

### Phase 3 — Remaining plugins + REST/WS wiring + lifecycle
- [ ] 3.1 Implement `runTurn` + private parsers + per-CLI system-prompt transport (Dec 3) in `cursor.ts`, `gemini.ts`, `opencode.ts`. Capture **gemini** live schema after re-auth (⚠ blocked this session); cursor Auto-model; opencode `--format json`.
- [ ] 3.2 `POST /sessions/:id/chat` (+ `/chat/stop`, `DELETE …/chat/queue/:turnId`), `GET /:id/transcript`, `/:id/meta` (rebuild from transcript tail) in `sessions.ts`.
- [ ] 3.3 **Turn queue (Decision 8):** FIFO queue + sequential runner in `jsonAgent.ts`; turn-1 auto-enqueue; `POST /chat` → `202 {turnId, queuePosition}` (never 409); `/chat/stop` aborts active turn (keeps queue), per-turn cancel removes one queued; `turnState`+`queueDepth` via `session:meta`.
- [ ] 3.4 `routes/attachments.ts` multipart upload → save under `sessionDataDir/uploads/` (sanitize, reject traversal, size cap); inject absolute paths.
- [ ] 3.5 **DELETE → abort (Decision 13):** worktree + session + direct-session DELETE call `jsonAgentRegistry.get(id)?.abortAndDrain()` before purge; uploads/transcript auto-cleaned with the session data dir (no separate delete).
- [ ] 3.6 `ws/handlers/chatOpen.ts` + dispatch in `ws/server.ts`; bridge stream events to `session:message`/`session:meta`; `chat:replay` from jsonl.
- [ ] 3.7 Boot recovery (Dec 11/13): `recover.ts` reconciles `working` JSON → `idle`, kills orphaned turn PIDs; `lifecycle.ts` JSON branch (state from turn/queue presence).

**Verify phase 3:**
- [ ] **3.T1** Unit — `{cursor,gemini,opencode}` `runTurn` parsers: fixture lines → normalized events with correct `provider` + usage mapping (claude `user`/`tool_result`, cursor `thinking/delta`+`tool_call/*`, opencode `part.type`+`step_finish reason=stop`).
- [ ] **3.T2** Integration — `POST /chat` with mock harness → `session:message`/`session:meta` delivered to a subscribed WS client; transcript persisted.
- [ ] **3.T3** Integration — **queue**: two rapid `POST /chat` while turn 1 runs → second `queuePosition:1`, runs only after turn 1's `result`; `/chat/stop` aborts turn 1 keeps queued; per-turn cancel removes a queued turn.
- [ ] **3.T4** Integration — upload → 201 `Attachment` under `sessionDataDir`; `POST /chat {attachmentIds}` injects abs path; turn sees it.
- [ ] **3.T5** Integration — **orphan safety (Dec 13)**: session/worktree DELETE mid-turn → active turn's process group is killed (no surviving child writes to the checkout); uploads/transcript gone with the data dir.
- [ ] **3.T6** Integration — `chat:open` after a completed turn replays full history via `chat:replay`; `GET /meta` after a simulated restart rebuilds `usage` from the transcript tail.

### Phase 4 — Web-UI ChatPane, hook, client
- [ ] 4.1 `api/client.ts`: `openChat`/`closeChat`/`sendChat`/`stopChat`/`uploadAttachments`/`getTranscript`/`getMeta`; route `chat:*`/`session:message`/`session:meta`.
- [ ] 4.2 `hooks/useChat.ts`: events+meta state, open on mount / close on unmount, replay merge, live append.
- [ ] 4.3 `ChatPane.tsx` + `chat/MessageList` + message renderers (`TextMessage`, `ThinkingBlock` collapsible, `ToolUseCard`, `ToolResultCard`, `ErrorCard`).
- [ ] 4.4 **Rich rendering (Decision 9):** reuse `preview/MarkdownView` + `preview/CodeBlock` (already raw-HTML off via react-markdown, `rehype-highlight`); add `DiffView` (unified-diff) + streaming-tolerant unterminated-fence handling; `MermaidBlock` behind a flag (dep already present; code-block fallback).
- [ ] 4.5 `Workspace.tsx` (Dec 14): keep `TerminalPane` permanently mounted (`sessionId=null` when JSON active) + toggle `ChatPane` **visibility** beside it — no if/else remount.
- [ ] 4.6 `styles/chat.css` using `tokens.css` vars (code theme on `--font-mono`).

**Verify phase 4:**
- [ ] **4.T1** Unit — `useChat`: `chat:replay` then live `session:message` produces correctly-ordered `events[]`; `session:meta` updates `meta`.
- [ ] **4.T2** Integration — `ChatPane` renders text + tool_use + tool_result from a mock stream; thinking block toggles.
- [ ] **4.T3** Unit — `Markdown`: fenced code block syntax-highlights + copy works; a **partial/unterminated ``` fence** (mid-stream delta) renders without breaking layout; raw `<script>`/`javascript:` URL is sanitized away.
- [ ] **4.T4** Unit — `DiffView`: a unified-diff `tool_result` renders add/remove line styling.
- [ ] **4.T5** Regression — switching a tab between a TTY and a JSON agent does **not** unmount `TerminalPane` (stays mounted with `sessionId=null`); no remount on fullscreen/layout toggle (per `web-ui` AGENTS.md; guards the `9dc10ef` ghost-stream fix).
- [ ] **4.T6** Unit — `useChat` dedupes its optimistic `user` bubble against the daemon's authoritative `user` event by `turnId` (no double bubble).

### Phase 5 — Composer, attachments, status bar, create flags, docs
- [ ] 5.1 `Composer` (textarea + send + stop) with `AttachmentChip` list, drag/drop + file picker → `uploadAttachments`.
- [ ] 5.2 `StatusBar`: tokens used / context %, model, mode name, turn-state spinner — fed by `meta`.
- [ ] 5.3 "JSON chat" toggle in `NewAgentDialog` + `DirectAgentDialog` + `NewTabDialog` (additional `a{n}`) → `channel:"json"`.
- [ ] 5.4 `cli` `--json` flag for `session create` / `worktree create`.
- [ ] 5.5 Update `docs/SESSION-EXECUTION.md` + `docs/API-CONTRACT.md`.

**Verify phase 5:**
- [ ] **5.T1** Integration — drop file → chip appears → send → message body includes injected path; oversized file → 413 chip error, message still sendable.
- [ ] **5.T2** Unit — `StatusBar`: given `SessionMeta` with usage → renders `used/total` + context %; missing `costUsd` hidden gracefully.
- [ ] **5.T3** Integration — create-with-JSON-toggle → `Session.channel==="json"` → ChatPane mounts.
- [ ] **5.T4** Regression — create without toggle → TTY behavior unchanged; `vst session create` without `--json` unchanged.

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/types.ts` | 1 | channel + transcript kind + normalized schemas |
| `daemon/src/services/channel.ts` (+ test) | 1 | channel resolution helper |
| `daemon/src/ws/protocol.ts` | 1,3 | chat/message/meta event schemas |
| `web-ui/src/api/types.ts` | 1 | mirror schemas + create body |
| `daemon/src/services/spawn.ts` | 2 | plugin interface + json branch |
| `daemon/src/agent-plugins/claude.ts` (+ test) | 2 | json methods (reference) |
| `daemon/src/services/jsonAgent.ts` (+ test) | 2 | JsonAgentSession turn engine |
| `daemon/src/ws/streams/jsonAgentStream.ts` | 2 | stream adapter |
| `daemon/src/state/jsonAgentRegistry.ts` | 2 | session registry |
| `daemon/src/agent-plugins/{cursor,gemini,opencode}.ts` (+ tests) | 3 | json methods |
| `daemon/src/routes/sessions.ts` | 1,3 | channel in bodies + `serializeSession`; chat/stop/cancel/transcript/meta endpoints; DELETE→abort |
| `daemon/src/routes/attachments.ts` (+ test) | 3 | multipart upload → `sessionDataDir/uploads/` |
| `daemon/src/routes/worktrees.ts` | 3 | channel in create body; DELETE→abort |
| `daemon/src/ws/handlers/chatOpen.ts` | 3 | replay + bridge |
| `daemon/src/ws/server.ts` | 3 | dispatch chat events |
| `daemon/src/services/lifecycle.ts` | 2,3 | channel-aware JSON branch (Dec 11) |
| `daemon/src/services/recover.ts` (+ test) | 2,3 | JSON boot guard + reconcile + orphan-PID kill (Dec 11/13) |
| `web-ui/src/api/client.ts` | 4 | chat client methods |
| `web-ui/src/hooks/useChat.ts` (+ test) | 4 | chat state hook + `turnId` dedupe |
| `web-ui/src/components/layout/ChatPane.tsx` | 4 | chat container (canonical path) |
| `web-ui/src/components/chat/*` (+ tests) | 4,5 | renderers, composer, status bar (reuse `preview/*` for md/code/diff/mermaid) |
| `web-ui/src/routes/Workspace.tsx` | 4 | pane visibility toggle, TerminalPane stays mounted (Dec 14) |
| `web-ui/src/styles/chat.css` | 4 | chat styling |
| `web-ui/src/components/dialogs/NewAgentDialog.tsx` | 5 | JSON toggle |
| `web-ui/src/components/dialogs/DirectAgentDialog.tsx` | 5 | JSON toggle |
| `web-ui/src/components/dialogs/NewTabDialog.tsx` | 5 | JSON toggle (additional agents) |
| `cli/src/...` | 5 | `--json` flag |
| `docs/SESSION-EXECUTION.md`, `docs/API-CONTRACT.md` | 5 | document channel + endpoints |

---

## Sub-Plan Breakdown

> Not yet split into separate files — this doc holds all phases. If/when split, create these from the Phases above:

| Planned sub-plan | Scope | Dependencies |
|----------|-------|-------------|
| Part 1 | Phases 1–2 (contracts + daemon backend, claude, lifecycle guards) | none |
| Part 2 | Phase 3 (4 plugins + REST/WS + attachments + queue/abort/recover) | Part 1 |
| Part 3 | Phases 4–5 (ChatPane, composer, attachments UI, meta bar, flags, docs) | Part 2 |

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: agy JSON channel — switch to `--output-format stream-json`

> Replace agy's single-envelope `--output-format json` turn parsing with real per-step streaming (`--output-format stream-json`), matching the claude/cursor/opencode plugins' live event pattern.

**Issue:** agy-stream-json
**Branch:** `agy-stream-json`
**Status:** Done

**Reference files:**
- Plugin: `daemon/src/agent-plugins/agy.ts`
- Sibling patterns: `daemon/src/agent-plugins/claude.ts` (`parseClaudeStreamLine`), `daemon/src/agent-plugins/opencode.ts` (`parseOpencodeStreamLine`)
- Types: `daemon/src/types.ts:44` (`NormalizedEventKind`), `:86` (`NormalizedEvent`)
- Tests: `daemon/src/__tests__/agy.test.ts` (existing), `daemon/src/__tests__/claudeJson.test.ts` (pattern to mirror)
- UI merge logic (why streamed deltas are safe): `web-ui/src/components/chat/MessageList.tsx:70-88`

---

## Problem

- `agy.ts:435-440` spawns `agy --print=<msg> --output-format json`, which per the file's own doc comment (`agy.ts:41-45`, written at feature-inception in `075996a`) "does NOT stream per-event NDJSON."
- That claim was never actually tested against `--output-format stream-json` — only against `json`. `agy models`/`--help` and hand-testing (this session) confirm `stream-json` is a distinct, real per-step NDJSON stream agy already supports.
- Result: agy JSON-channel sessions render one opaque final blob instead of live text/tool-call visibility, unlike claude/cursor/opencode.

## Out of Scope

- `claude.ts` / `cursor.ts` / `opencode.ts` — untouched.
- Human-gate / permission-prompt detection for agy (`ask_question`/`ask_permission` auto-skip in headless mode is a separate, already-answered question — not unlocked by this change).
- TTY-mode chat-id capture (`--log-file` polling) — unrelated code path, untouched.
- Changing `AGY_MODELS` list (unrelated drift noticed during hand-testing: live `agy` now also offers "Gemini 3.6 Flash" tiers not in the static list) — out of scope, file separately if wanted.

## Concept

- Swap `--output-format json` → `--output-format stream-json` in `runTurn` (`agy.ts:437-438`).
- Replace `parseAgyResultLine` (single-envelope parser) with `parseAgyStreamLine`, a per-line NDJSON parser mirroring `parseClaudeStreamLine`/`parseOpencodeStreamLine`'s shape: pure function `(line, sessionId, state, fallbackModel) → NormalizedEvent[]`.
- Success state: agy JSON-channel turns show live assistant text (streamed in chunks) and live tool-call cards (`run_command`, etc.) as they happen, not just a final answer — same as the other 3 CLIs.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `runTurn` spawns `agy --print=<msg> --output-format stream-json ...` |
| 2 | `init` event → `session_init` (agentChatId, model from fallback — envelope carries none) |
| 3 | `step_update` `step_type:"agent_response"` `text_delta` → `text` events, streamed per-chunk (both ACTIVE and DONE deltas) |
| 4 | `step_update` `step_type:"tool"` → `tool_use` on first sight of a step (ACTIVE or DONE, guarded once), `tool_result` on DONE |
| 5 | `result` event → `usage` + `result` (+ `error` on ERROR status) — same shape as today's final envelope handling |
| 6 | `step_update` types with no useful payload (`user_input`, `unknown`, `checkpoint`, `error_message`) are dropped, not errored |
| 7 | Malformed / non-JSON lines skipped (Decision 7 pattern, same as claude/opencode) |
| 8 | No change to chat-id capture, restore, launch command (TTY mode), or model list |

---

## Research

### Current single-envelope parsing

- **File:** `daemon/src/agent-plugins/agy.ts:90-166` (`parseAgyResultLine`)
- One line in, one final envelope out: `{conversation_id, status, response, error?, usage}` → fans out to `session_init, text, usage, result[, error]`.
- Called once per output line in `runTurn`'s readline loop (`agy.ts:472-477`) — but agy only ever emits ONE such line in `json` mode, so this "loop" runs once.

### Why `json` was chosen originally

- `git log -p --follow -- daemon/src/agent-plugins/agy.ts` shows the plugin was authored from scratch in `075996a` ("feat(json-chat): JSON agent chat channel — core feature (P0-P4)").
- The commit message's own summary states the *general* daemon design uses `--output-format stream-json` (or "closest per-CLI equivalent") for all 4 CLIs, and separately notes: "agy ... emits one final result envelope per turn instead" — i.e. the author asserted at commit time that agy has no streaming mode, without a recorded test of `stream-json` specifically.
- No later commit (`bdd2479`, `51033cc`, `922888a`, `c76ae28`) revisits this decision — all are chat-id-capture / cwd-migration / prompt-length fixes, unrelated to output format.
- **Conclusion:** not a documented limitation — an untested assumption. `stream-json` was simply never tried.

### Live-verified `stream-json` event shapes (agy 1.1.12, hand-run this session)

```jsonc
// 1. init — always first (absent only on an immediate hard-fail, e.g. bad --model)
{"event":"init","conversation_id":"<uuid>","init":{"cwd":"...","tools":[...],"permission_mode":"always-proceed"}}

// 2. step_update — many per turn; conversation_id is NESTED here (unlike init/result)
{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.001}}
// agent_response: text streams in ACTIVE deltas, final delta + usage on DONE
{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"I'll run "}}
{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\n",
  "duration_seconds":3.14,"usage":{"input_tokens":18668,"output_tokens":13,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":18681}}}
// tool: ACTIVE carries the call (name+params), DONE carries the same + output
{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":3,"state":"ACTIVE","step_type":"tool",
  "tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}
{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command",
  "duration_seconds":0.76,"tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"},"output":"total 8\r\n..."}}}
{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":4,"state":"DONE","step_type":"checkpoint","duration_seconds":0.9,
  "usage":{"input_tokens":109,"output_tokens":4,...}}}

// 3. result — always last; conversation_id NESTED here too
{"event":"result","result":{
  "conversation_id":"<uuid>","status":"SUCCESS","response":"4\n","duration_seconds":3.88,"num_turns":1,
  "usage":{"input_tokens":18772,"output_tokens":16,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":18788}}}

// ERROR case (bad --model): NO init event at all, straight to result
{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model...","duration_seconds":0,"num_turns":0,"usage":{...all zero...}}}
```

- `conversation_id` location is inconsistent across event types: top-level on `init`, nested inside `step_update`/`result` on those.
- `ask_question`/`ask_permission`-style human-gate tools surface as `step_type:"unknown"` with no `tool_name` (matches the task brief — confirmed live, no repro needed here; do not build gate detection around it).
- No `error_message` `step_type` example was reproduced with a real tool failure this session — treat generically (dropped, Requirement 6) rather than invented.

### Streamed-delta merge is already supported by the UI

- **File:** `web-ui/src/components/chat/MessageList.tsx:70-79`
- Consecutive `text` events with the same `turnId` are appended into one bubble (`last.text += ev.text`) — so emitting one `text` event per `text_delta` chunk (rather than accumulating in the plugin and emitting once) renders correctly and gives real incremental streaming, same mechanism opencode/claude rely on implicitly via their own per-block granularity.

### Sibling pattern to mirror

- **File:** `daemon/src/agent-plugins/opencode.ts:60-176` (`parseOpencodeStreamLine`)
- Signature: `(line, sessionId, state) → NormalizedEvent[]`, `state` is a small mutable object threaded across calls in the `runTurn` readline loop (`opencode.ts:305,317-320`) to track `initEmitted` / `toolStarted: Set<string>` — same shape needed here (`tool_use` must fire once per step even though a tool step can arrive as ACTIVE-then-DONE or DONE-only).

## Root Cause

- The `json`-vs-`stream-json` choice was made once, in the original feature commit, based on an assumption ("agy does not stream") that was documented as fact but never tested against the actual `stream-json` flag value — only against `json`.

---

## Design Details

### Key Decisions

#### Decision 1: Per-step `state` object threaded through the readline loop, mirroring opencode

- **Decision:** `parseAgyStreamLine(line, sessionId, state, fallbackModel)` where `state: { toolStarted: Set<string> }` tracks which `step_index`s already emitted `tool_use`, so a DONE-only or ACTIVE-then-DONE tool step never double-emits.
- **Rationale:** matches `opencode.ts`'s `toolStarted` guard exactly (same double-emit risk: a terminal event may need to synthesize `tool_use` if the running one was never observed, e.g. turn resumed mid-tool).
- **Where:** `daemon/src/agent-plugins/agy.ts` (new function, replaces `parseAgyResultLine`)

```ts
// toolId = String(step_index) — agy has no separate tool-call id, but step_index
// is unique per turn and stable across the ACTIVE→DONE pair for the same tool call.
const toolId = String(stepUpdate.step_index);
if (!state.toolStarted.has(toolId)) {
  state.toolStarted.add(toolId);
  events.push(agyEvent(sessionId, "tool_use", {
    toolName: stepUpdate.tool_name,
    toolId,
    toolInput: (stepUpdate.tool_info as any)?.parameters,
  }));
}
if (stepUpdate.state === "DONE") {
  const info = (stepUpdate.tool_info ?? {}) as Record<string, unknown>;
  const raw = info.output ?? info.error;
  events.push(agyEvent(sessionId, "tool_result", {
    toolId,
    toolResult: { content: typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : undefined, isError: info.error !== undefined },
  }));
}
```

#### Decision 2: `text_delta` emitted per-chunk as `text` events (no in-plugin accumulation)

- **Decision:** every non-empty `text_delta` on an `agent_response` step (ACTIVE or DONE state) becomes its own `text` NormalizedEvent immediately — the plugin does not buffer/join deltas itself.
- **Rationale:** the daemon's transcript store + UI (`MessageList.tsx:70-79`) already merge consecutive same-turn `text` events into one bubble; buffering in the plugin would just delay the "real-time" visibility this migration exists to add. `turnId` stamping (needed for the merge) is handled by the core turn engine (`jsonAgent.ts`), not the plugin — plugin events don't set `turnId` today for agy or any other CLI (confirmed: no plugin sets `turnId` in claude.ts/opencode.ts either), so no new work needed there.
- **Where:** `daemon/src/agent-plugins/agy.ts`, new parser's `agent_response` branch.

#### Decision 3: `init` event → `session_init`; `result` event → `usage`+`result`(+`error`), same fields as today

- **Decision:** keep the exact `usage`/`result`/`error` construction logic from `parseAgyResultLine` (`agy.ts:130-163`) verbatim, just re-triggered off the `result` event's `.result` sub-object instead of the whole (now single) line.
- **Rationale:** no observed change in the `result` envelope's own shape between `json` and `stream-json` modes (only how many other events precede it) — reuse working code, don't redesign it.
- **Where:** `daemon/src/agent-plugins/agy.ts`

#### Decision 4: Unknown/no-payload `step_type`s dropped silently

- **Decision:** `user_input`, `unknown`, `checkpoint`, `error_message` (and any future unrecognized `step_type`) produce zero events.
- **Rationale:** none carry renderable content today (verified live — Research section); silently dropping matches Decision 7 in the original file (tolerate unexpected shapes, never throw) rather than inventing an unverified mapping.
- **Where:** `daemon/src/agent-plugins/agy.ts`, default branch of the `step_type` switch.

#### Decision 5: `runTurn` readline loop passes a fresh `state` per turn

- **Decision:** `const state = { toolStarted: new Set<string>() }` declared once per `runTurn` call (same lifetime/scope as opencode's `state = { initEmitted: false }` at `opencode.ts:305`), passed to every `parseAgyStreamLine` call in that turn's loop.
- **Rationale:** `toolStarted` must not leak across turns (step_index resets each turn) or across concurrent sessions (plugin functions are stateless between calls otherwise).
- **Where:** `daemon/src/agent-plugins/agy.ts`, `runTurn` body (~`agy.ts:471-477`).

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does `error_message` step_type ever carry renderable content?** | Not reproduced live this session. Dropped for now (Decision 4); revisit if a real repro surfaces a payload shape. |
| 2 | **Could two tool steps share a `step_index` within one turn?** | Not observed — step_index increments monotonically per turn in every trace gathered. Guard (`toolStarted` Set) is defensive, not required by observed behavior. |
| 3 | **Non-zero exit with partial NDJSON (e.g. process killed mid-stream)?** | Same handling as today: readline loop just stops, `runTurn`'s existing non-zero-exit-without-signal-abort → throw (`agy.ts:483-485`) is unchanged and still fires. |

---

## Implementation Phases

### Phase 1 — Streaming parser + runTurn switch

- [x] **1.1** Add `parseAgyStreamLine(line, sessionId, state, fallbackModel): NormalizedEvent[]` in `agy.ts`, replacing `parseAgyResultLine` (Decisions 1-4).
- [x] **1.2** Update `runTurn` (`agy.ts:435-477`): args → `--output-format stream-json`; declare per-turn `state`; readline loop calls `parseAgyStreamLine`.
- [x] **1.3** Update file-header doc comment (`agy.ts:34-48`) to describe `stream-json` mode instead of the old single-envelope `json` mode.
- [x] **1.4** Removed `parseAgyResultLine` entirely — its only importer was `daemon/src/__tests__/jsonPlugins.test.ts`, updated in place (no new file needed; deviates from the plan's original `agyStream.test.ts` — the sibling cursor/opencode agy parser tests already lived in `jsonPlugins.test.ts`, so the agy `describe` block there was replaced rather than forked into a new file).

**Verify phase 1:**
- [x] **1.T1** Unit — `daemon/src/__tests__/jsonPlugins.test.ts` (agy `describe` block replaced, not a new `agyStream.test.ts` — see 1.4): `init` event → `session_init` with `agentChatId`.
- [x] **1.T2** Unit — `agent_response` `text_delta` (ACTIVE and DONE) → `text` events with correct text, one event per delta.
- [x] **1.T3** Unit — `tool` step ACTIVE→DONE pair → one `tool_use` + one `tool_result`, no duplicate `tool_use`.
- [x] **1.T4** Unit — `tool` step arriving DONE-only (no prior ACTIVE seen by parser, fresh `state`) → still emits both `tool_use` and `tool_result` (synthesized, guarded).
- [x] **1.T5** Unit — `result` event (SUCCESS) → `usage` + `result` events with correct token sums.
- [x] **1.T6** Unit — `result` event (ERROR, no prior `init`) → `usage` + `result` + `error` events, no `session_init` required.
- [x] **1.T7** Unit — malformed/non-JSON line → `[]`, no throw.
- [x] **1.T8** Unit — unrecognized `step_type` → `[]`.
- [x] **1.T9** Regression — existing `daemon/src/__tests__/agy.test.ts` suite (chat-id capture, launch command, composeLaunchPrompt) still passes untouched — none of that code path changes. Confirmed: 10/10 pass, zero edits to that file.

---

### Phase 2 — Real-CLI verification

- [x] **2.1** Hand-ran `agy --print="<msg>" --output-format stream-json --dangerously-skip-permissions` against a fresh scratch cwd (`/tmp/agytest`), piped real NDJSON output through the final `parseAgyStreamLine` via a `tsx` one-liner importing the actual plugin file — confirms the parser handles real output end-to-end, not just the fixtures in Research.
- [x] **2.2** Hand-ran a `run_command`-invoking prompt (`echo hi`) — `tool_use`/`tool_result` events came out with correct `toolInput:{CommandLine:"echo hi"}` and `toolResult.content:"hi\r\n"`.

**Verify phase 2:**
- [x] **2.T1** Manual — piped real `agy` NDJSON output through `parseAgyStreamLine` line-by-line (`tsx` one-liner against `/tmp/agytest/real_agy_output.jsonl`) → event sequence matched exactly: `session_init → tool_use → tool_result → text → text → usage → result`.
- [x] **2.T2** Automated — full repo test suite (`npx vitest run` from `cli/`, which symlinks `daemon/src`) green: 640/640 tests passed across 65 files (one pre-existing unrelated unhandled-rejection log line from `sessions.test.ts`'s intentional "failing spawn" test, not caused by this change).

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/agent-plugins/agy.ts` | **Modified** | 1.1-1.4 | `--output-format json`→`stream-json`; `parseAgyResultLine`→`parseAgyStreamLine(line, sessionId, state: AgyStreamState, fallbackModel)` + new `createAgyStreamState()` helper |
| `daemon/src/__tests__/jsonPlugins.test.ts` | **Modified** | 1.T1-1.T8 | Replaced the agy `describe` block with `parseAgyStreamLine` tests using real captured stream-json lines (deviates from plan's `agyStream.test.ts` — see 1.4) |
| `daemon/src/__tests__/agy.test.ts` | **Unchanged** | 1.T9 | Regression check only — no edits |

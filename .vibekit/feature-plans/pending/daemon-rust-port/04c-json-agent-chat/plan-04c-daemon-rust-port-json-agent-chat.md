# Phase brief: 04c — json-agent-chat

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `04c-json-agent-chat`, Entities & Modules row for `vst-agents`, Gotcha #9 (chokidar → `notify`), `AGENTS.md` § Agent plugin.
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-agents
**Depends on (already `done`):** 00-foundation, 01-storage, 04a-agent-plugins-core, 04b-acp-transport

## ⚠️ This is the largest, highest-risk part dispatched so far — read this whole brief before starting
`jsonAgent.ts` alone is **2,057 lines**, containing one class (`JsonAgentSession`, ~1,470 lines, ~35 methods) bigger than any single file ported in parts 00-04b — several of which already needed multiple dispatch attempts on much smaller files (04b's 594-line `acpTransport.ts` took 3 attempts). The arch table's "~1.5k LOC" estimate for this whole part undercounts `jsonAgent.ts` alone. **Do not attempt this the way you'd attempt a normal part** — follow the file/module split below deliberately, build momentum on the low-risk files first, and treat `JsonAgentSession` as a multi-session-turn effort.

## Files to port
From file-map.tsv (part 04c):
- daemon/src/services/jsonAgent.ts (2057 lines — see decomposition below)
- daemon/src/services/jsonAgentChat.ts (353 lines — orchestration glue, medium risk)
- daemon/src/services/context.ts (153 lines — **already stubbed by 04a as `vst-agents::paths`, OWNERSHIP NOTE present — adopt, don't re-derive**)
- daemon/src/services/promptBuilder.ts (200 lines — low risk)
- daemon/src/services/sessionRuntime.ts (71 lines — low risk, calls into 02/03's tmux/PTY teardown)
- daemon/src/services/skillTokens.ts (140 lines — low risk, but has a byte-identical dual-implementation contract with `web-ui` — see note below)
- daemon/src/services/userSkillCatalog.ts (314 lines — **first part to hit Gotcha #9**, uses chokidar)
- daemon/src/services/nativeHistoryImporter.ts (70 lines — low risk, self-contained parser)
- daemon/src/services/opencodeConfig.ts (32 lines — **already ported by 04a as `vst-agents::opencode_config`, OWNERSHIP NOTE present — adopt, don't re-derive**)
- daemon/src/agent-plugins/claudeImport.ts (295 lines — medium, self-contained at-rest parser)
- daemon/src/agent-plugins/opencodeImport.ts (199 lines — medium; reads opencode's own SQLite DB read-only, `rusqlite` not `better-sqlite3`)
- daemon/src/state/jsonAgentRegistry.ts (15 lines — trivial)
Tests to port:
- daemon/src/__tests__/jsonAgent.test.ts
- daemon/src/__tests__/jsonAgentChat.buildSystemPrompt.test.ts
- daemon/src/__tests__/jsonAgentRelease.test.ts
- daemon/src/__tests__/jsonChannelToggle.test.ts
- daemon/src/__tests__/jsonChatQueue.test.ts
- daemon/src/__tests__/claudeJson.test.ts
- daemon/src/__tests__/claudeSkillExpansion.test.ts
- daemon/src/__tests__/claudeTurnOrdering.test.ts
- daemon/src/__tests__/context.test.ts
- daemon/src/__tests__/promptBuilder.test.ts
- daemon/src/__tests__/sessionRuntime.test.ts
- daemon/src/__tests__/skillTokens.test.ts
- daemon/src/__tests__/userSkillCatalog.test.ts
- daemon/src/__tests__/nativeHistoryImport.test.ts
- daemon/src/__tests__/opencodeConfig.test.ts (verifying 04a's existing port, not re-porting)

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(04c): behavior contract"` — across 4 continuations
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-agents; save log to rust/.gate/04c.log; commit
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Closed out — part 04c complete (2026-09-15)

**All file-map rows for this part are ported and gated green.** This was the largest, hardest part of the whole daemon-rust-port so far, spanning 4 dispatch attempts/continuations across 2 models (DeepSeek then Haiku) and roughly a dozen commits. Final independent verification: `rust-gate.sh vst-agents` green, N6 confirmed empty across the full range (`68f98b1..9870454`), zero test-tree drift after each test-contract commit.

**Dispatch history (full honesty, for the historical record):**
1. **DeepSeek, first dispatch** — delivered `skill_resolution`/`skill_tokens`/`user_skill_catalog`/`native_history_importer`/importers/`prompt_builder`/`context`/`json_agent_session::{meta,pids}`. Skipped the test-first commit boundary once (retroactively fixed). Correctly stopped at a real cross-part gap: `AgentPlugin` never got a `runTurn` method from `04a` (missed because it's optional and wasn't in the cited `AGENTS.md` table).
2. **DeepSeek, run_turn bridge** — designed and implemented the `run_turn`/`run_turn_acp` bridge (my own suggested `Arc<dyn AcpTransport>` signature was actually infeasible — the trait isn't dyn-compatible — implementer caught and fixed it correctly). **Introduced an N6 violation** (`tokio-util` added to the workspace `[workspace.dependencies]` table instead of crate-local) that went undetected until the final closeout gate review — corrected in continuation 4.
3. **DeepSeek, small decoupled chunk** — `jsonAgentRegistry`, a `vst-store` visibility widening, the `AcpTransport::steer`/`supports_steering` amendment. Ran in parallel with `05-lifecycle-status` (Haiku) — two commit-attribution incidents during that window (both self-corrected, no code lost — see `.sdlc-state.yaml`).
4. **Haiku, the core** (`JsonAgentSession`'s queue/drain/connection/events/mod) — delivered all 5 modules with zero `todo!()`s remaining in one large but clean pass; one convention fix requested (inline tests relocated to `tests/`).
5. **Haiku, last two files** (`jsonAgentChat`, `sessionRuntime`) — clean test-first→impl, then found and fixed the N6 violation from dispatch 2 as a final correction.

**`#[ignore]`d:** one — `tests/acp_live.rs`'s live-CLI test (from `04b`, unrelated to this part but in the same crate), gated behind `VST_ACP_LIVE_TESTS`.

**vst-types amendments across the whole part:** additive-only `Default` derives/impl on `NormalizedEvent`/`UsageInfo`/`ToolResult` (dispatch 1). No other amendments.

**Known follow-ups for later parts** (already recorded individually, collected here for visibility):
- `subagent_notify.rs`'s (`05`) `emit_pill` needs wiring to this crate's `JsonAgentSession` — likely `08-server-bootstrap`'s job.
- The structural decisions in continuation 4's report (`ReleaseCallbacks` struct, `cli_id_to_provider`/`provider_to_cli_id` bridge functions) are fine as-is, no action needed.

## `JsonAgentSession` decomposition — split by FILE, not by struct
One `struct JsonAgentSession` (its ~15 fields of interdependent mutable state don't cleanly separate — `run_one_turn` alone touches queue, PID, connection, and meta state together), interior-mutable per the handle convention, but its ~35 methods split across separate `impl JsonAgentSession` blocks in separate files:

1. **`json_agent_session/queue.rs`** — `enqueue`, `submit`, `abort_and_drain`, `stop_active_turn`, `cancel_queued_turn`, `begin_edit_queued_turn`, `resubmit_queued_turn`, `fork_turn`, `promote_queued_turn`, `kick_drain`, `sync_idle_state`. **Invariant:** turn ordering must survive cancel/promote/edit races — re-derive insert position from `aheadIds`, don't trust a cached index.
2. **`json_agent_session/drain.rs`** — `drain`, `run_one_turn`, `run_notice_slot_turn`, `emit_stopped`, `persist_lifecycle`. The core turn-execution loop. **Invariant (load-bearing, not incidental):** the human queue always drains before the notice slot (R5b), and an abort must suppress an immediate notice-slot re-fire via the `_abortedSinceLastDrain` latch (FIX-G in the TS comments) — port this exact latch.
3. **`json_agent_session/connection.rs`** — `get_or_create_connection`, `maybe_capture_native_chat_id`, `persist_acp_session_id`. Calls **04b's `AcpTransport`/`acp_connection.rs`** directly. **Invariant:** `is_alive()` is re-checked on every call (self-healing respawn) — a cached-but-dead connection must never be reused.
4. **`json_agent_session/pids.rs`** — `record_turn_pid`, `kill_live_pids`, `clear_turn_pids`, `write_pid_file`, plus the free functions `collectDescendants`/`killProcessTree` (freeze-then-kill via SIGSTOP/SIGKILL, `/proc` walk). **This overlaps with part 03's `vst-git::recover.rs`** PID-verification/kill patterns — read that file first; reuse/extend its `/proc`-parsing helpers rather than re-deriving a second implementation of the same idiom.
5. **`json_agent_session/meta.rs`** — `get_meta`, `emit_meta`, `set_turn_state`, `update_turn_state`, the notice-slot methods (`populate_notice_slot`, `prune_notice_slot_child`, `promote_notice_slot`, `dismiss_notice_slot`), plus the free functions `buildMetaFromTranscript`/`buildMetaFromStoreMeta`/`assembleMeta` (pure, no-live-session meta rebuild).
6. **`json_agent_session/events.rs`** — `handle_event`, `handle_out_of_band_event`, `new_event`, `persist`, `emit_user_event`. **Invariant:** `agentChatId` capture happens on `session_init` only; a no-real-usage turn must not clobber `usage` — port the `hasRealUsage` gate as its own named helper (it's load-bearing, per its own TS doc comment).
7. **`json_agent_session/mod.rs`** — struct definition, constructor, `Drop`/`release`/`dispose`, small getters, plus the top-level free functions `getOrCreateJsonAgentSession` and the `readTranscriptFromDataDir` family / `withDiskStore`.
8. **`skill_resolution.rs`** (separate module, mostly pure) — `resolveSkillInvocations`, `resolveLeadingLineInvocation`, `mergeWithSkillCatalog`, `injectAttachments`. Genuinely low-risk and self-contained — **implement and test this FIRST**, before touching `JsonAgentSession`, to build momentum and land a real commit early.

## Part-specific notes (the other 9 files — not everything here is jsonAgent.ts-hard)
- **`jsonAgentChat.ts` (353 lines, medium)** — orchestration glue (`findJsonSessionContext`, mode→plugin resolution, first-turn system-prompt write); calls into `JsonAgentSession` but doesn't duplicate its complexity.
- **`context.ts`** — already ported as `vst-agents::paths` by 04a (read its `## OWNERSHIP NOTE` doc comment). Verify it's complete against `context.ts`'s `ResolvedContext` (direct-vs-worktree, no null-fabrication); if so, this file-map row is verification, not re-porting.
- **`opencodeConfig.ts`** — already ported as `vst-agents::opencode_config` by 04a (same OWNERSHIP NOTE pattern). Verify, don't re-derive.
- **`promptBuilder.ts`, `sessionRuntime.ts`** — low risk, mostly pure or thin glue into 02/03's tmux/PTY teardown.
- **`skillTokens.ts`** — low risk but has a byte-identical dual-implementation contract with `web-ui` (the same token-scrubbing logic is implemented twice, once here, once in the frontend, and must produce identical output) — check its test file for an explicit test-vector table and port every vector, don't sample a subset.
- **`nativeHistoryImporter.ts`, `claudeImport.ts`, `opencodeImport.ts`** — medium, self-contained at-rest parsers, no shared state with `JsonAgentSession`. `opencodeImport.ts` reads opencode's own global SQLite DB **read-only** — use `rusqlite`, not a hand-rolled parser.
- **`userSkillCatalog.ts` uses `chokidar` (fs watch + debounce) — this is the first part to actually hit Gotcha #9.** Port to the `notify` crate, preserve the debounce, and add an explicit atomic-rename-on-save test since none exists in the TS suite (per the gotcha's own instruction — don't skip this because the TS didn't have it).
- **`jsonAgentRegistry.ts` (15 lines)** — trivial, port directly.

## vst-types check before any amendment
`SessionMeta`, `TurnState` (`vst-types/src/domain.rs`) and `ImportOutcome` (`vst-store/src/transcript.rs`) **already exist** from parts 00/01 — verified by the orchestrator before writing this brief. Check for what you need before assuming a `vst-types` amendment; most of this part's wire shapes are likely already covered.

## Continuation — `run_turn` bridge (added 2026-09-15, after first dispatch stopped at a real blocker)

The first dispatch correctly delivered `skill_resolution.rs`, `skill_tokens.rs`, `user_skill_catalog.rs` (with the required chokidar/notify atomic-rename test), `native_history_importer.rs` + `claudeImport`/`opencodeImport`, `prompt_builder.rs`, `context.rs`, and `json_agent_session/meta.rs` + `pids.rs` — all gated green, committed `ffd0793..d9e78cf`. It then **correctly stopped** rather than guessing: `JsonAgentSession::run_one_turn` calls `this.plugin.runTurn(input, ctx, signal)`, and `runTurn` is a real (optional) member of `AgentPlugin` (`daemon/src/services/spawn.ts:241`) — implemented per-plugin in `claude.ts`/`cursor.ts`/`opencode.ts`/`agy.ts` as `async *runTurn(...) { yield* runTurnAcp(input, ctx, signal); }`, where `runTurnAcp` drives the turn over `ctx.getAcpConnection(spec, enrich)`. **This was missed by 04a's brief** (which framed the whole part as "pure, no live process" and didn't surface `runTurn` because it's optional and wasn't in the `AGENTS.md` method table cited at the time) — it is a real, verified gap, not implementer error, and this section exists to close it.

**What to add to `vst-agents::plugin` (extending, not redesigning, the 04a `AgentPlugin` trait — this IS an in-scope amendment to a "done" part's file, within the same crate, no N6 issue):**

1. **`TurnInput`, `TurnContext` structs** — mirror `spawn.ts`'s shapes. `TurnContext.get_acp_connection` is the interesting one: a boxed async closure, e.g. `pub get_acp_connection: Arc<dyn Fn(AcpLaunchSpec, Option<Arc<dyn Fn(&SessionUpdate, &NormalizedEvent) -> Option<NormalizedEvent> + Send + Sync>>) -> Pin<Box<dyn Future<Output = Result<Arc<dyn acp_transport::AcpTransport>, acp_transport::AcpTransportError>> + Send>> + Send + Sync>` (verbose but mechanical — `JsonAgentSession::get_or_create_connection` from `json_agent_session/connection.rs` is what actually gets wrapped into this closure when `TurnContext` is constructed; `run_turn`/`run_turn_acp` never see `JsonAgentSession` directly, only this callback, matching the TS's decoupling).
2. **`AgentPlugin::run_turn`** — optional trait method (default: returns an already-closed `mpsc::UnboundedReceiver<NormalizedEvent>`, meaning "not supported"), signature roughly `fn run_turn(&self, input: TurnInput, ctx: TurnContext, cancel: CancellationToken) -> mpsc::UnboundedReceiver<NormalizedEvent>`. Rust has no native async generators — a spawned task pushing into an `mpsc::UnboundedReceiver` (matching 04b's own `PromptTurn.updates` pattern — same idiom, stay consistent) is the direct equivalent of the TS `AsyncIterable`. Add `tokio-util = "0.7"` (crate-local dep, `CancellationToken` — don't hand-roll cancellation, it's the same primitive TS's `AbortSignal` maps to and avoids a bespoke bug class).
3. **`run_turn_acp` — ONE shared free function** (in `plugin.rs` or a new `acp_run_turn.rs`), NOT duplicated per-plugin (TS duplicates it 4x across `claude.ts`/`cursor.ts`/`opencode.ts`/`agy.ts` as nearly-identical `async function* runTurnAcp`; Rust should share one implementation parameterized by the plugin's `AcpLaunchSpec`-building logic and its `enrich` hook — a real, deliberate improvement over the TS structure, not unfaithful porting, since the shared logic genuinely doesn't vary by CLI per the TS comments). It: calls `ctx.get_acp_connection(spec, enrich)` → `initialize()` if needed → `new_session`/`load_session` → `send_prompt(...)` → drains `PromptTurn.updates` (raw `SessionUpdate`) through `normalize::normalize_session_update` (04c's `normalize.rs`, already ported by 04b) → pushes each `NormalizedEvent` into the output channel → awaits `PromptTurn.result` → yields a terminal `result`-kind event mapping the `StopReason`.
4. **Each plugin's `run_turn`** (claude.rs/cursor.rs/opencode.rs/agy.rs, 04a's files) becomes a thin wrapper calling the shared `run_turn_acp` with its own `AcpLaunchSpec` construction (mirrors `getLaunchCommand`'s argv logic) and enrich hook (mirrors each plugin's existing per-CLI TS `runTurnAcp` for any genuinely CLI-specific event mapping quirks — check each TS file for what its enrich hook actually does, don't assume they're identical).

**After the bridge exists**, continue with the rest of `JsonAgentSession` per the original decomposition (`queue.rs`, `drain.rs`, `connection.rs`, `events.rs`, `mod.rs`), then `jsonAgentRegistry.ts` → `jsonAgentChat.ts` → `sessionRuntime.ts`, each with its own test-first→impl commit boundary (no exceptions — the retroactive fix on the first dispatch should not recur).

## Continuation 2 — small decoupled chunk while `05` finishes in parallel (added 2026-09-15)

The 2nd dispatch delivered `JsonAgentStream` (WS event-emitter adapter) cleanly, then made a disciplined, correct call: it attempted the full `JsonAgentSession` struct (`mod.rs`+`events.rs`) and **reverted its own incomplete, non-compiling work** rather than leave a broken tree, after discovering the remaining assembly is blocked on real missing pieces:
- `persistLifecycleState` needs `vst-lifecycle`, which **`05-lifecycle-status` is actively building in parallel right now** (a different session, different crate — do not touch its files, see the parallel-dispatch note in `05`'s own plan). Wait for `05` to land before attempting `queue.rs`/`drain.rs`/`connection.rs`/`events.rs`/`mod.rs` (all of which call into lifecycle persistence).
- `getAllProjects`/`mutateProject` (project-store, part 01, `vst-store`) — needed for `persistChatId`/`persistAcpSessionId`/`persistModelOverride`. Check whether `vst-store` already exposes these publicly; if `pub(crate)`-scoped, that's a legitimate minimal visibility amendment (see below).
- `cap_tool_result_content` in `vst-store::transcript` is **`pub(crate)`**, not `pub` — `vst-agents` cannot call it. This needs a one-line visibility amendment (`pub(crate)` → `pub`), which is in scope for this part to make (analogous to the `vst-types` amendment rule: minimal, additive-only, disclosed under its own report heading — this is a visibility widening, not a logic change).
- `AcpConnection.steer()`/`supportsSteering` are used by `submit()`/`getMeta().canSteer` but **are not part of the frozen `AcpTransport` trait** (`vst-agents/src/acp_transport.rs`, 04-spike). See the amendment below.

**Given this, this dispatch's scope is DELIBERATELY SMALLER — do NOT attempt the full `JsonAgentSession` assembly yet:**
1. **`jsonAgentRegistry.ts` → `vst-agents::json_agent_registry`** — trivial (15 lines), port directly.
2. **`cap_tool_result_content` visibility fix** in `vst-store::transcript` (`pub(crate)` → `pub`) — one line, disclose under its own report heading.
3. **`AcpTransport` amendment: add `steer`/`supports_steering`** to the frozen trait (`acp_transport.rs`, 04-spike's file — this IS an authorized amendment, same crate, additive-only). TS shape: `steer(&self, blocks: Vec<ContentBlock>) -> impl Future<Output = SteerOutcome>` where `SteerOutcome` is `Injected | PromptRequired | Unsupported` (mirrors the TS's `"injected" | "promptRequired" | "unsupported"` — any error/method-not-found/disposed-connection collapses to `Unsupported`, never propagates as an `Err`), plus `fn supports_steering(&self) -> bool` (derived from the `initialize` response's `_meta.steering.supported === true`, already captured — check what `acp_connection.rs` currently does with `_meta`, it may already be stored). The custom `_session/steering` JSON-RPC method isn't a built-in `agent_client_protocol` schema type — check the crate's `derive.JsonRpcRequest`/`derive.JsonRpcNotification` macros (`https://docs.rs/agent-client-protocol/2.1.0/agent_client_protocol/derive.JsonRpcRequest.html`) for defining a custom typed request. **If this proves genuinely difficult within a reasonable effort, it is safe to ship a stub that always returns `Unsupported`** (documented as a follow-up TODO) — the TS's own callers already treat any non-`Injected` outcome as "fall back to `enqueue()`", so an always-`Unsupported` stub is correct, degraded behavior, not a broken one. Don't get stuck chasing the derive macro API — timebox it.
4. **Implement `AcpConnection::steer`/`supports_steering`** (the concrete impl in `acp_connection.rs`) against the new trait methods.

**Do NOT start `queue.rs`/`drain.rs`/`connection.rs`/`events.rs`/`mod.rs` (the JsonAgentSession core) this dispatch** — check `.sdlc-state.yaml` for `05-lifecycle-status`'s status first; if it's `done`, a further continuation brief will be written to tackle the core assembly with all dependencies satisfied.

## Continuation 3 — the core, on Haiku this time (user-directed, 2026-09-15)

`05-lifecycle-status` is now `done` — the blocker on `persistLifecycleState` is cleared. Per explicit user direction, **this continuation (and only this one) runs on `$HAIKU_MODE`, not DeepSeek** — a one-off model swap for the remainder of `04c` specifically, because Haiku performed well on `05`. **`06-ws-realtime` and every part after it goes back to DeepSeek as the default implementer, per standing policy.** Do not treat this as a new default.

**Scope for this dispatch — the `JsonAgentSession` core, per the original decomposition:**
1. `queue.rs` (enqueue/submit/abort_and_drain/stop_active_turn/cancel_queued_turn/begin_edit_queued_turn/resubmit_queued_turn/fork_turn/promote_queued_turn/kick_drain/sync_idle_state)
2. `drain.rs` (drain/run_one_turn/run_notice_slot_turn/emit_stopped/persist_lifecycle — the core turn-execution loop, now unblocked: `persist_lifecycle` calls into `vst-lifecycle`'s newly-`done` `lifecycle.rs`/`pr_poller.rs`)
3. `connection.rs` (get_or_create_connection/maybe_capture_native_chat_id/persist_acp_session_id — uses `acp_connection::AcpConnection` directly, per the frozen `AcpTransport` trait's non-dyn-compatibility already established)
4. `events.rs` (handle_event/handle_out_of_band_event/new_event/persist/emit_user_event — the `hasRealUsage` gate is load-bearing, see the original decomposition note)
5. `mod.rs` (struct + constructor + `Drop`/`release`/`dispose` + getters + `getOrCreateJsonAgentSession`)

Then, if time permits: `jsonAgentRegistry.ts` is already done (continuation 2); move to `jsonAgentChat.ts` → `sessionRuntime.ts`.

**Still watch for `getAllProjects`/`mutateProject` (project-store, part 01, `vst-store`)** — verify these are `pub` and callable from `vst-agents` before assuming another visibility amendment is needed (check first, don't assume — `cap_tool_result_content` needed one, `getAllProjects`/`mutateProject` may already be fine).

**Same worktree, but no other session is running in parallel this time** — the file-scoping caution from continuations 1/2 no longer applies; this dispatch has the worktree to itself.

## Continuation 4 — the last two files, still on Haiku (2026-09-15)

`JsonAgentSession`'s core is done and gated green (Continuation 3). The only remaining file-map rows for `04c` are:
- **`jsonAgentChat.ts` (353 lines)** — orchestration glue: `findJsonSessionContext` (resolve plugin + session from a route/WS call), mode→plugin resolution, first-turn system-prompt file write. Calls into `JsonAgentSession`/`getOrCreateJsonAgentSession` (both done) but doesn't duplicate their complexity — genuinely medium risk, self-contained.
- **`sessionRuntime.ts` (71 lines)** — small; calls into `vst-proc`'s tmux/PTY teardown (parts 02/03) when a session's channel/runtime needs tearing down.

This is still the **Haiku** one-off (per the user's direction: Haiku finishes all of remaining `04c`). After this dispatch, `04c` should be fully complete — every file-map row for this part ported and gated. **`06-ws-realtime` reverts to `$DEEPSEEK_MODE`,** per the standing-policy note already in `ORCHESTRATION-PROMPT.md`.

Keep the `tests/*.rs` convention (not inline `#[cfg(test)]`) from the start this time — no relocation fix needed at the end.

## Gotcha #13 reminder (six-for-six on prior parts)
Step 4 may NOT modify anything under `tests/` or a `#[cfg(test)]` module for behavioral reasons. A step-3 test that turns out wrong gets flagged and left failing/`#[ignore]`d with a stated reason — never silently edited. A genuine harness-only fix (compile error after a rename, `cargo fmt` reflow, a real test-setup race) may be made, but disclose it explicitly and in detail under its own report heading, and — per precedent — if you remove or weaken an assertion, cross-check it against the actual TS test source and cite exactly what the TS test does/doesn't assert, the way 04b's report did for its one assertion removal.

# Phase brief: 04b — acp-transport

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `04b-acp-transport` (note its "Explicitly OUT of scope" clause), Entities & Modules row for `vst-agents`, System Boundaries row `vst-agents ↔ external agent CLIs`, Gotcha #5, `AGENTS.md` §§ Terminal + WebSocket (regression-test source, same double-echo/ghost-stream bug class as `vst-proc`'s Gotcha #6 — this part spawns detached child processes again, via `AcpTerminalManager`) and § Agent plugin "The two session identities (ACP)".
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-agents
**Depends on (already `done`):** 00-foundation, 02-process-pty, 04-spike, 04a-agent-plugins-core

## Do not redesign — frozen/pre-existing deliverables in this crate
- **`rust/vst-agents/src/acp_transport.rs`** (04-spike): the `AcpTransport` trait signature is **frozen**. Implement it as-is on a concrete connection type; do not change its methods/types. Its doc comment explains two deliberate simplifications vs. the TS class (no `AbortSignal` param; streams the raw `agent_client_protocol::schema::v1::SessionUpdate`, not `vst_types::NormalizedEvent`) — this part's `normalize.rs` is exactly what turns the former into the latter.
- **`rust/vst-agents/examples/acp_hello.rs`** (04-spike): proof the pinned `agent-client-protocol = "=2.1.0"` crate round-trips a real `initialize → session/new → prompt → stream` against `claude-agent-acp`. **Build your `AcpTransport` impl on top of this crate's connection machinery** (`agent_client_protocol::Client.builder()...connect_with(AcpAgent, ...)`, per the example) — do not hand-roll JSON-RPC framing/parsing yourself the way `acpTransport.ts` does (that TS file predates a usable Rust ACP crate; this port doesn't need to repeat that workaround).
- **`rust/vst-agents/src/native_chat_id.rs`, `opencode_config.rs`, `paths.rs`** (04a, pulled forward as a stopgap): these already port `native-chat-id/{claude,cursor,agy}.ts` (this part's own file-map row!) and the `opencodeConfig.ts`/path-helper subset 04a's tests needed. **Read `native_chat_id.rs`'s `## OWNERSHIP NOTE` doc comment first.** Adopt/extend this file — do not create a second, conflicting `native-chat-id` implementation. If it's already complete and correct against `native-chat-id/{claude,cursor,agy}.ts`, your job for that file-map row may just be verifying it and removing the OWNERSHIP NOTE (now that this part owns it for real).

## Files to port
From file-map.tsv (part 04b):
- daemon/src/services/acp/acpFileSystem.ts
- daemon/src/services/acp/acpTerminalManager.ts
- daemon/src/services/acp/acpTransport.ts
- daemon/src/services/acp/normalize.ts
- daemon/src/agent-plugins/native-chat-id/agy.ts (see "already ported by 04a" note above)
- daemon/src/agent-plugins/native-chat-id/claude.ts (ditto)
- daemon/src/agent-plugins/native-chat-id/cursor.ts (ditto)
Tests to port:
- daemon/src/__tests__/acpFileSystem.test.ts
- daemon/src/__tests__/acpNormalize.test.ts
- daemon/src/__tests__/acpTerminalManager.test.ts
- daemon/src/__tests__/acpTransport.test.ts
- daemon/src/__tests__/nativeChatIdClaude.test.ts
- daemon/src/__tests__/agyAcpLive.test.ts (live-CLI — see below)
- daemon/src/__tests__/claudeAcpLive.test.ts (live-CLI — see below)
- daemon/src/__tests__/cursorOpencodeAcpLive.test.ts (live-CLI — see below)

## Live-CLI test gating (decided here, per the arch doc — not left to the implementer)
All three `*AcpLive.test.ts` files spawn a real external CLI process (network access, real auth, real tokens/cost — same category as `04-spike`'s `examples/acp_hello.rs`, which already proved this is possible in this sandbox). Port them as **`#[ignore]`-gated integration tests**, gated behind checking the env var `VST_ACP_LIVE_TESTS` is set (e.g. `if std::env::var("VST_ACP_LIVE_TESTS").is_err() { return; }` at the top of each such test, in addition to the `#[ignore]` attribute) so they show up as ignored-by-default in `cargo test` output but are still discoverable/runnable via `VST_ACP_LIVE_TESTS=1 cargo test -p vst-agents -- --ignored`. Do not run them as part of step 5's gate (the gate script doesn't pass `--ignored`, so this happens automatically — just don't add anything that would make them run un-gated).

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(04b): behavior contract"` — commit `68f98b1`
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-agents; save log to rust/.gate/04b.log; commit — commits `2430677`, `bed2129`
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Closed out (2026-09-15)

Gate green, committed across `68f98b1`/`2430677`/`bed2129`, independently re-verified by the orchestrator (re-ran `rust-gate.sh vst-agents`, confirmed every new test file ran and passed including the correctly-`#[ignore]`d live test, diff-reviewed the full test tree — cross-checked the one real assertion removal against the actual TS source and confirmed the TS test never asserted that value, confirmed N6 empty).

**Dispatch history (recorded for the record, already in `.sdlc-state.yaml`):** this part had 3 dispatch attempts before landing — an initial DeepSeek session diagnosed the right architecture (actor pattern needed to bridge `agent_client_protocol`'s closure-scoped `connect_with` model onto the frozen trait's persistent `&self` methods) but got stuck in a hard repeated-text loop implementing it; escalated to Haiku per step D, which also made no progress in its short run; user directed reverting to a fresh DeepSeek session with the actor-pattern resolution pre-solved in the dispatch prompt, which then implemented it correctly with one reprioritization nudge (deprioritizing full request-handler-type fidelity, which isn't test-covered, in favor of finishing the checklist).

**`#[ignore]`d:** `tests/acp_live.rs::live_claude_initialize_new_session_prompt` — live-CLI test, gated behind `#[ignore]` + `VST_ACP_LIVE_TESTS` env var per this plan's gating decision. Correctly excluded from the gate run (not passed `--ignored`).

**vst-types amendments:** none — `ModeUpdate`/`CommandsUpdate` and related fields already existed from part 00.

**Known gap flagged by the implementer (accepted, not a blocker):** the pinned `agent-client-protocol = "=2.1.0"` crate's `AcpAgentConfig` has no `cwd` field, so the spawned agent child process inherits the daemon's cwd rather than the session's worktree cwd; `spec.cwd` is still used correctly for `fs/*` path scoping. This is an upstream crate limitation, not a 04b defect — flag it for whichever part wires up production agent spawning (04c or later) to verify whether a newer crate version or a different spawn mechanism resolves it before cutover.

## Part-specific notes
- **`acpTransport.ts` (594 lines) is the highest-risk file in this part** — Decision 1/2/3 in its header comment (one persistent connection per session; `session/prompt` served per turn over that same connection; `session/prompt`'s own resolution, not process exit, is the turn-done signal; ACP `session/cancel` is a fire-and-forget notification) are load-bearing invariants, not incidental TS style — carry them forward as explicit behavior, not just "whatever the translation happens to produce." `vst_types::NormalizedEventKind` already has the `ModeUpdate`/`CommandsUpdate` variants this file's Decision 5 introduces (part 00 anticipated them) — check before assuming a `vst-types` amendment is needed.
- **`acpTerminalManager.ts` spawns a detached background child process per `terminal/create`** (Decision 4) — this is exactly the "generic subprocess spawn" case `vst-proc`'s `PtyBackend`/`spawn_child`/`PtyHandle` was designed for (see part 02's Entities row: "so `vst-agents`' ACP child processes and tmux PTYs share one abstraction"). Use `vst-proc`'s spawn primitives here, not a second hand-rolled `tokio::process::Command` wrapper — this is the connection point the arch predicted, not a suggestion to reinvent it.
- **`acpFileSystem.ts` is small (50 lines) and pure `async fn` + path scoping** — note its own comment that `resolveScoped` is "a courtesy check, not a security boundary" (ACP's `fs/*` mirrors the CLI's own filesystem reach). Port that behavior faithfully, don't tighten it into an actual sandbox — that would be a behavior change, not a port.
- **`normalize.ts` (296 lines) is pure, no I/O, no state** — this is the module that turns `AcpTransport`'s raw `SessionUpdate` stream into `vst_types::NormalizedEvent`s (see `acp_transport.rs`'s doc comment on why that split exists). The `AcpEnrichHook` per-plugin extension point (Decision 2.3) matters: it's how CLI-specific quirks get handled WITHOUT branching on `provider` inside `normalize.rs` itself (Gotcha #2) — the hook is supplied by the calling plugin, not read here.
- **The two-session-identity model determines what `native_chat_id.rs` needs** (already mostly implemented by 04a — see above): `claude`/`opencode` = `identical` (this crate's `native_chat_id` module should have nothing for them beyond what 04a already ported, if anything); `agy` = `bridged`; `cursor` = `unavailable`. Cross-check against `AGENTS.md`'s summary table and each TS file's actual behavior, not just the table alone.
- **Gotcha #13 reminder (five-for-five on prior parts — by now, assume you WILL need a harness-only fix and plan for disclosing it cleanly):** step 4 may NOT modify anything under `tests/` or a `#[cfg(test)]` module for behavioral reasons. A step-3 test that turns out wrong gets flagged and left failing/`#[ignore]`d with a stated reason — never silently edited. A genuine harness-only fix (compile error after a rename, `cargo fmt` reflow, a real test-setup race) may be made, but disclose it explicitly and in detail under its own report heading — the orchestrator diff-reviews the full test tree independently (whitespace-normalized, so don't expect line-count alone to hide anything) and treats an undisclosed diff as an automatic gate failure.

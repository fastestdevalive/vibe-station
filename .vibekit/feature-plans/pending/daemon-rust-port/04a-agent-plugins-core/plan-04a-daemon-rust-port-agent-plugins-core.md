# Phase brief: 04a — agent-plugins-core

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `04a-agent-plugins-core`, Entities & Modules row for `vst-agents`, Gotcha #2, `AGENTS.md` § Agent plugin (cited directly below — this section's table is the ground truth for which methods are required vs optional).
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-agents
**Depends on (already `done`):** 00-foundation, 04-spike (do NOT touch `rust/vst-agents/src/acp_transport.rs` or `examples/acp_hello.rs` — those are frozen deliverables of 04-spike, out of scope for this part)

## Files to port
From file-map.tsv (part 04a):
- daemon/src/services/spawn.ts (defines `interface AgentPlugin` — the trait itself, moved here per Gotcha #11's fix, NOT to `vst-proc`)
- daemon/src/agent-plugins/registry.ts
- daemon/src/agent-plugins/claude.ts
- daemon/src/agent-plugins/cursor.ts
- daemon/src/agent-plugins/opencode.ts
- daemon/src/agent-plugins/agy.ts
Tests to port:
- daemon/src/__tests__/spawn.test.ts
- daemon/src/__tests__/plugins.test.ts
- daemon/src/__tests__/jsonPlugins.test.ts
- daemon/src/__tests__/agy.test.ts

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(04a): behavior contract"` — commit `67f4cef`
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-agents; save log to rust/.gate/04a.log; commit — commits `c968d2c`, `7679db6`, `cf66a3c`
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Closed out (2026-09-15)

Gate green, committed across `67f4cef`/`c968d2c`/`7679db6`/`cf66a3c`, independently re-verified by the orchestrator (re-ran `rust-gate.sh vst-agents`, re-ran `cargo test -p vst-types` to confirm the `Default` amendment doesn't break wire fixtures, diff-reviewed the full test tree — large diff stat (554 lines across 4 files) but confirmed via whitespace-normalized diffing to be entirely `cargo fmt` reflow plus the two exact fixes disclosed in the report, nothing hidden — and confirmed N6 empty).

**Scope note (accepted, precedented):** 04a pulled forward `native-chat-id/{claude,cursor,agy}.ts` (file-map: 04b) and `opencodeConfig.ts`/`context.ts` path helpers (file-map: 04c) because 04a's own ported tests exercise this behavior through the `AgentPlugin` trait, and stubbing it would have broken real TS-tested plugin behavior. The orchestrator directed the implementer (mid-flight, before the test-contract commit) to add prominent `## OWNERSHIP NOTE` doc comments to `native_chat_id.rs`/`opencode_config.rs`/`paths.rs` — verified present and unambiguous. **04b's and 04c's phase briefs must instruct their implementers to read these files first and adopt/extend rather than re-derive**, to avoid a Gotcha #11 duplicate-implementation conflict.

**`#[ignore]`d:** none. Two groups of TS tests were deliberately NOT ported (not ignored — genuinely out of scope): `spawn.test.ts`'s 8 orchestration cases (need `vst-proc`/context path helpers, belongs to 04b/04c) and `plugins.test.ts`'s 2 full-server integration cases (need `vst-routes`/`vst-store`).

**vst-types amendments:** additive only — `Default` on `UsageInfo`/`ToolResult`, manual `Default` impl for `NormalizedEvent` (no wire-shape change, confirmed via re-run of all 13 wire fixture tests).

## Part-specific notes
- **This is the largest part dispatched to a DeepSeek session so far** — 3,416 lines of source across 6 files (`spawn.ts` 870, `claude.ts` 798, `agy.ts` 646, `cursor.ts` 540, `opencode.ts` 530, `registry.ts` 32) plus 1,912 lines of tests. The arch doc's own Part Breakdown row estimate ("~2k LOC") undercounts this significantly. Budget real time for it and expect this to be a multi-session-turn effort — that's expected, not a sign of trouble, AS LONG AS each turn ends with visible forward progress (new files, new passing tests, moving through the checklist). No single file here merges multiple TS sources (each ports close to 1:1), so the part-01/02-style "merged-file" risk doesn't apply — the risk here is sheer volume across independent-but-similar files.
- **Suggested implementation order** (small/foundational first, so a partial session still has something solid committed): (1) `spawn.ts`'s `AgentPlugin` trait + supporting types, (2) `registry.ts`, (3) `cursor.ts`/`opencode.ts` (~530-540 lines each, structurally similar), (4) `agy.ts` (646 lines), (5) `claude.ts` (798 lines, the biggest — also the one with the most subtle logic per `AGENTS.md`'s two-session-identity model, since `claude` is an `identical`-strategy plugin per that doc).
- **`AGENTS.md` § Agent plugin is the authoritative method table** — cite it directly rather than re-deriving from `spawn.ts`'s TSDoc: required methods `listModels()`, `getLaunchCommand(cfg)`, `getEnvironment(cfg)`, `getReadySignal()`, `composeLaunchPrompt(...)`; optional methods `setupWorkspaceHooks?`, `provideChatId?`, `captureChatId?`, `getRestoreCommand?`, `supportsAcp?`, `captureNativeChatId?`, `supportsChannelResume?`. In Rust: default trait-method bodies for every optional method (returning `None`/not-implemented), exactly as `AGENTS.md`'s "Agent plugin" invariant states — calling code must dispatch through the trait, never branch on a CLI-name enum after resolving the plugin (Gotcha #2).
- **The two-session-identity model** (`AGENTS.md` "The two session identities (ACP)" section) determines which optional methods each plugin implements: `claude`/`opencode` are `identical`-strategy (implement neither `captureNativeChatId` nor `supportsChannelResume`); `agy` is `bridged` (implements `captureNativeChatId`, not `supportsChannelResume`); `cursor` is `unavailable` (implements both `captureNativeChatId` returning a value that signals "unavailable", AND `supportsChannelResume` returning `false`). Port each plugin's actual TS behavior faithfully — don't infer this from the summary table alone, read each plugin file to confirm what it actually implements.
- **This part is pure/table-driven, no live process** (per the arch's own Part Breakdown description) — `getLaunchCommand`/`getEnvironment`/`getReadySignal`/`composeLaunchPrompt` are deterministic functions of their inputs, no subprocess spawning, no PTY, no ACP transport. Do NOT reach for `vst-proc`'s `PtyHandle` or `vst-agents::acp_transport::AcpTransport` here — those are `04b`'s territory. `supportsAcp()` is just a boolean-returning marker method in this part, not an actual ACP connection.
- **`setupWorkspaceHooks`/`provideChatId`/`captureChatId` touch the filesystem** (workspace hook files, token files) — these ARE within scope (they're part of `AgentPlugin`, ported here), just note they're the only I/O-performing methods in an otherwise pure-function-heavy part. Use `tokio::fs`, not sync `std::fs`, inside these `async fn`s (rust-coding §4).
- **Gotcha #13 reminder (three-for-three on prior parts):** step 4 may NOT modify anything under `tests/` or a `#[cfg(test)]` module. A step-3 test that turns out wrong gets flagged and left failing/`#[ignore]`d with a stated reason in the report — never silently edited. A genuinely harness-only fix (compile error after a rename, a real race in test setup — never a behavioral assertion change) may be made, but call it out explicitly, in detail, under its own report heading, exactly as the last three parts did — the orchestrator diffs the test tree independently and treats an undisclosed diff as an automatic gate failure.

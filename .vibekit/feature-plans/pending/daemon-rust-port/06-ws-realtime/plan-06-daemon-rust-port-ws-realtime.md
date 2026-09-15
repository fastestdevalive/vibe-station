# Phase brief: 06 — ws-realtime

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `06-ws-realtime`, Entities & Modules row for `vst-ws`, Gotcha #1, Gotcha #6, System Boundaries rows `vst-ws ↔ vst-proc (PTY streams)` and `vst-agents ↔ external agent CLIs` (the `AgentRegistry::resolve` restricted-call-site rule), `AGENTS.md` §§ Terminal and WebSocket **in full** — this part is where the double-echo/ghost-stream bugs those sections document actually happened, and where their regression fixes must be carried forward as explicit tests, not incidental behavior.
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-ws
**Depends on (already `done`):** 00-foundation, 01-storage, 02-process-pty, 04a-agent-plugins-core

## Already ported — do not re-derive
**`daemon/src/ws/streams/jsonAgentStream.ts` is this part's file-map row, but it was already ported as `vst-agents::json_agent_stream::JsonAgentStream`** (by part `04c`, because `JsonAgentSession` needed it as a struct field). It's complete, tested, and exported from `vst-agents`. **Depend on `vst-agents` and use it directly — do not create a second implementation in `vst-ws`.** This is the same "pulled forward across a file-map boundary" pattern seen in `04a`/`04b`/`04c` — read `vst-agents/src/json_agent_stream.rs`'s doc comment to confirm before writing anything.

## Files to port
From file-map.tsv (part 06):
- daemon/src/broadcaster.ts (224 lines — **receiver side only**; the `ServerEvent`/`Broadcaster` sender-side types already live in `vst-types::events`, part 00 — this part wires the receiver that fans broadcasts out to WS connections)
- daemon/src/services/fileList.ts (249 lines)
- daemon/src/services/ignoreFilter.ts (79 lines)
- daemon/src/services/pendingFileOpens.ts (17 lines)
- daemon/src/state/attachmentRegistry.ts (50 lines — single home here, not duplicated into 01)
- daemon/src/ws/connection.ts (501 lines — **the highest-risk file in this part**, see below)
- daemon/src/ws/handlers/*.ts (chatOpen 148, debugLog 18, fileUnwatch 26, fileWatch 86, ping 8, sessionClose 43, sessionInput 103, sessionLookup 41, sessionOpen 136, sessionResize 64, subscribe 17, treeUnwatch 29, treeWatch 88)
- daemon/src/ws/server.ts (278 lines — previously unassigned/ambiguous with `daemon/server.ts`, resolved to this part)
- daemon/src/ws/streams/fileWatcher.ts (173 lines)
- daemon/src/ws/streams/sessionStream.ts (49 lines)
- daemon/src/ws/streams/tmuxOutput.ts (205 lines — the tmux `attach-session` PTY stream; uses `vst-proc::Tmux`, a different code path from `vst-proc::PtyHandle`'s direct-PTY mode)
Tests: port the corresponding `daemon/src/__tests__/` files for each of the above (check file-map.tsv for the exact list — several WS handler tests are named after their handler).

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first — committed together with impl (interdependent, disclosed)
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-ws; save log to rust/.gate/06.log; commit — commits `e719f9b`, `71c2168`
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Closed out (2026-09-15)

Gate green, independently re-verified (re-ran `rust-gate.sh vst-ws`, N6 checked against the **true full-history start** `11a4b37` — not just this part's dispatch range — per the lesson from `04c`'s closeout, confirmed empty).

**No test-first commit boundary this time** (disclosed by the implementer, accurately: the behavior-contract tests reference the crate's own public API, which had to exist to compile — a first-time whole-crate delivery, not a Gotcha #13 tests-modified-after-commit violation). Since there's no clean diff boundary to verify, the orchestrator directly read the two safety-critical regression tests (`with_session_lock_serializes_same_session_on_same_connection`, `keyed_lock_two_connections_hold_two_live_handles_concurrently`) and the `with_session_lock` implementation itself — confirmed the lock guard is held across the entire async handler body (`f().await`), the exact pattern needed to prevent Gotcha #1's real, previously-shipped race. This is the load-bearing invariant of the whole part and it's genuinely sound.

**Disclosed simplifications, accepted as reasonable scope decisions:**
- `JsonAgentStream` (already-ported by `04c`, not amendable from this part) has no `off` — listener detach uses a shared `active` flag instead of freeing the slot; bounded per-reopen growth, not unbounded.
- `broadcaster.ts`'s token-session (`remote:connected`/`disconnected`) half deferred to `vst-daemon` (needs `auth-state`, out of this part's scope).
- `fileList`'s ripgrep backend lacks the TS's SIGTERM→SIGKILL timeout escalation — base functionality (entry cap, node-fallback, gitignore respect) is ported and tested; the escalation path is a real but non-blocking gap.

**`#[ignore]`d:** `tests/tmux_output.rs`'s one live-tmux test, gated behind `--ignored` (needs a real tmux binary).

**vst-types amendments:** none.

## Part-specific notes
- **`connection.rs` (← `ws/connection.ts`, 501 lines) is the highest-risk file** — this is where `withSessionLock` lives (Gotcha #1): a **per-`(connection, sessionId)` keyed lock**, deliberately not global. A coarser lock (one mutex for all sessions, or even one per connection without the sessionId key) silently breaks multi-tab concurrency and was the actual root cause of a real, previously-shipped bug (`AGENTS.md` § WebSocket documents it in full: interleaved `session:close`→`session:open` racing past the stale-stream check, both spawning a `tmux attach-session` client, the orphaned one keeps forwarding duplicate output). Port `session:open`/`session:close` handlers wrapped in this keyed lock — **the entire handler body, including the async attach/detach park point, must be inside the lock**, not just registration before an unlocked attach (that reintroduces the exact race). Write the regression test explicitly: interleaved open/close on the same `(connection, sessionId)` must never result in >1 live stream.
- **System Boundary test to actually write** (not optional, cited explicitly in the arch doc): spawn 50 interleaved open/close tasks for one `(connection_id, session_id)` key under `tokio::test(flavor = "multi_thread")`, assert live-handle count ≤ 1 at every instant, AND that two different `connection_id`s can hold two live handles concurrently for the same `session_id` (tabs are independent, only same-connection-same-session is serialized).
- **`tmuxOutput.ts` → `tmux_output.rs`** is a *different* PTY code path from `vst-proc::PtyHandle` (which is direct-PTY, no tmux) — this is the tmux `attach-session` stream, built on `vst-proc::Tmux`'s command wrappers (part 02). Port Gotcha #6's regression scenarios here too: `node-pty` vs `portable-pty` resize/signal/attach-detach semantics differences are exactly what caused the double-echo bug class, and this file (not `vst-proc`) is where the daemon's own attach/detach bookkeeping for tmux sessions lives.
- **`chatOpen.ts` calls `vst_agents::json_agent_chat::resolve_json_agent`** (already built, part `04c`) — it does **not** call `resolve_plugin`/`AgentRegistry::resolve` directly. This matches the System Boundary's restricted-call-site rule (`AgentRegistry::resolve` only from `vst-routes` and `vst-agents::json_agent_chat`) — `vst-ws` reaches plugin resolution *through* `vst-agents::json_agent_chat`, never around it. Don't have `chatOpen.rs` import `vst-agents::registry` directly.
- **`broadcaster.ts` here is receiver-side only** — the `ServerEvent` enum and the sender-side `Broadcaster` handle (a `tokio::sync::broadcast::Sender<ServerEvent>` newtype) already exist in `vst-types::events` (part 00). This part's job is the fan-out: subscribe to the broadcast receiver, route each `ServerEvent` to the WS connections that care about it.
- **`attachmentRegistry.ts`** — this file's single home is `vst-ws` per the arch's explicit fix note ("not duplicated into 01"). If you find a similar-sounding registry already in `vst-store`, that's a different thing — don't conflate them.
- **Gotcha #13 reminder (this part is unlikely to be the exception — assume you'll need at least one harness-only fix and disclose it cleanly):** step 4 may NOT modify anything under `tests/` or a `#[cfg(test)]` module for behavioral reasons. A step-3 test that turns out wrong gets flagged and left failing/`#[ignore]`d with a stated reason — never silently edited. A genuine harness-only fix (compile error after a rename, `cargo fmt` reflow, a real test-setup race) may be made, but disclose it explicitly and in detail under its own report heading, and cross-check any assertion *removal* against the actual TS test source before doing it (cite exactly what the TS test does/doesn't assert, the way `04b`'s report did).

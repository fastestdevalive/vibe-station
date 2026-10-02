<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Reset-with-handoff for Rich Chat (json) agents

> "Reset with handoff" silently resets a Rich Chat agent with no summary; make the old agent write the summary doc and the new one read it.

**Status:** WIP
**Branch:** `rich-chat-write-agy-medium`

**Reference files:**
- Reset + handoff routes: `rust/vst-routes/src/sessions.rs` (`reset_session` ~2970-2985, `handoff_session` 3196-3238, helpers 4803-4820)
- Tmux-only turn runner: `rust/vst-lifecycle/src/handoff.rs:29-34` (returns `Ok(false)` for `Channel::Json`)
- Chat enqueue + persist: `rust/vst-routes/src/sessions.rs:3246-3290` (`send_session` json branch)
- UI trigger: `web-ui/src/components/layout/WorkspaceCanvas.tsx:1594-1632`

---

## Problem & Concept

- Root cause: `run_handoff_turn` returns `Ok(false)` for `Channel::Json`, so `reset_session` gets `handoff_text = None`.
- Result: old row archived, new agent spawned with NO summary and no initial prompt — looks like "nothing happened".
- Fix: for json sessions, deliver the handoff instruction as a chat turn, wait for the file, feed it to the new session (existing code path).

## Out of Scope

- Tmux/pty handoff behaviour (unchanged).
- Surfacing handoff errors in the UI (UI still swallows errors in `.catch`).
- Changing the CLI `--handoff` self-session guard (`rust/vst-cli/src/commands/agent/reset.rs:72`).

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `POST /sessions/:id/reset {handoff:true}` on a json session sends the handoff instruction as a chat turn |
| 2 | Poll every 250ms for handoff file within timeout (max 120s), await agent.settled() bounded by remaining time, then read file |
| 3 | File content becomes `handoff_summary` on the archived row and `initial_prompt` of the new session |
| 4 | Timeout / enqueue error → `eprintln!` log and proceed with `None` (parity with tmux path; reset still happens) |
| 5 | `POST /sessions/:id/handoff` on json returns the summary the same way |

---

## Change Map

```
rust/vst-routes/
  src/sessions.rs          ~ json handoff helper + 2 call sites
  tests/sessions_group_b2.rs ~ json handoff tests
```

| File | Today | After |
|------|-------|-------|
| `sessions.rs` | json handoff → `None` | json handoff → chat turn + file poll |
| `sessions_group_b2.rs` | asserts json no-op | asserts enqueue-failure → `None`; asserts file read when pre-seeded |

## Key Decisions

| # | Decision | Where |
|---|----------|-------|
| 1 | Add `async fn run_handoff(&self, session: &SessionRecord, path: &Path, instruction: &str) -> Option<String>` on `SessionRoutes`; branch on `session_channel(session.channel, Some(session.use_tmux))`: `Channel::Json` → `run_json_handoff_turn`, else existing `run_handoff_turn` | `sessions.rs` near `handoff_session` |
| 2 | `run_json_handoff_turn`: delete stale file, then `enqueue_chat_turn(EnqueueChatTurnOpts { session_id, message: instruction, attachments: vec![], daemon_port: self.daemon_port, steer: Some(false), store: self.store.clone(), broadcaster: self.broadcaster.clone() }, &self.json_registry)`; do NOT call `persist_working` or `subagent_notify.note_human_turn` (not a human turn; `persist_working` races the queue's final `WaitingForHuman` write, drain.rs:139) | `sessions.rs:3265-3295` as the model |
| 3 | Completion signal: within `handoff_timeout` deadline, (a) poll every 250ms until handoff file exists, (b) await `agent.settled()` bounded by remaining time (avoids reading half-written file), (c) `read_handoff_file_or_null` | `sessions.rs` |
| 4 | New field `handoff_timeout: Duration` on `SessionRoutes`, default 120s, overridable in tests via a `with_handoff_timeout(d)` builder (test seam) | `sessions.rs` (struct ~283) |
| 5 | Enqueue error / timeout → `eprintln!("handoff: {session_id}: {e:?}")` (no `tracing` dep in `vst-routes`; `ResolveJsonAgentError` is `Debug` only) and return `None`; reset still proceeds (parity with tmux path) | `sessions.rs` |
| 6 | Timeout leaves a FIFO turn possibly still queued: in `reset_session` it dies with `release_session_runtime`; in `handoff_session` it may run later and write an unread temp file — accepted, documented in a code comment | `sessions.rs` |
| 7 | `handoff.rs` stays tmux/pty-only; update stale "paste-then-poll" comment at `sessions.rs:2967` | `handoff.rs`, `sessions.rs` |

## Boundary contract

- No REST shape change: `ResetBody{handoff,handoffText,prompt,modeId}` and `HandoffResult{ok,handoffSummary: Option<String>}` unchanged.
- Failure at boundary: enqueue error (`ResolveJsonAgentError`) or timeout → `None`, `tracing::warn!`.

---

## Implementation Phase 1 — daemon

- [x] 1.1 Add `run_json_handoff_turn` + `run_handoff` dispatcher in `rust/vst-routes/src/sessions.rs` per Key Decisions 1-3, 5-7
- [x] 1.2 Replace the `run_handoff_turn(...)` match in `reset_session` (~2975) with `self.run_handoff(...)`
- [x] 1.3 Replace the same match in `handoff_session` (~3220) with `self.run_handoff(...)`
- [x] 1.4 Add `handoff_timeout` field + `with_handoff_timeout` builder (Key Decision 4)
- [x] 1.5 Tests in `rust/vst-routes/tests/sessions_group_b2.rs`: `handoff_json_channel_returns_ok_with_no_summary` (line 638) gets a json session with `mode_id = None` (real `ModeError` → `None`); add a reset test using `with_handoff_timeout(100ms)` on a json session asserting reset still archives + spawns with `handoff_summary == None` (Req 4). No "pre-seeded file" test (path has a nanosecond suffix and is deleted pre-turn).

**Verify phase 1:**
- [x] 1.T1 `cd rust && cargo test -p vst-routes --test sessions_group_b2`
- [x] 1.T2 `cd rust && cargo clippy -p vst-routes --all-targets -- -D warnings`

## Implementation Phase 2 — sandbox verification (sonnet subagent, not the implementer)

- [ ] 2.1 `scripts/dev-sandbox.sh up` with an explicit free port; open a Rich Chat agent, exchange one message
- [ ] 2.2 Canvas tile menu → "Reset with handoff" → confirm
- [ ] 2.3 Expect: old session archived with `handoffSummary` set (`vst agent info <old> --json | jq .handoffSummary`), new session's first user message contains the summary

## Files & Phase Impact

| File | Phase |
|------|-------|
| `rust/vst-routes/src/sessions.rs` | 1 |
| `rust/vst-routes/tests/sessions_group_b2.rs` | 1 |

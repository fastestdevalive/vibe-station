<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Review round 2 — `plan-queued-msg-ordering.md`

- **Reviewed:** `.vibekit/feature-plans/wip/queued-msg-ordering/plan-queued-msg-ordering.md` (750 lines, revised after round 1)
- **Against:** `planning` skill (`SKILL.md`, `FORMAT.md`, `SECTIONS.md`) + round-1 findings (`review-round-1.md`)
- **Source verified at:** branch `fix/queued-msg-ordering` @ `d535f2c1`
- **Verdict:** **NEEDS CHANGES** — B1/B2/B5 fixed; B3 and B4 only partially fixed; 3 new BLOCKING (N1–N3), 4 new SUGGESTION

---

## Round-1 blockers — status

| # | Round-1 issue | Status | Evidence |
|---|---|---|---|
| B1 | `SessionMeta` literals missing from the plan | ✅ **FIXED** | Re-grepped `SessionMeta {` across `rust/`. Beyond `meta.rs:75` and `mod.rs:433` there are exactly 7 hits. **6** are full literals: `sessions.rs:3928`, `:3958`, `json_agent_stream.rs:60`, `:100`, `json_agent_meta.rs:173`, `:202`. The 7th, `json_agent_meta.rs:223`, uses `..meta` update syntax and needs no change. Nothing deserializes `SessionMeta` from JSON, so a non-`serde(default)` `Vec` is safe. Decision 8 and items 2.5–2.7 match this list exactly |
| B2 | Mixed `{message}`/`{text}` shapes in the lookup | ✅ **FIXED** | Decision 4 normalizes `message → text` when it builds the map. Checked against `ChatPane.tsx:210-220` (`userEvents` has shape `{text, attachments?}`) and the consumers at `:236-253` (`info?.text`, `info?.attachments`). `Attachment` is already imported (`ChatPane.tsx:4`), and `meta` is in scope (`:121`) |
| B3 | 1.T3 passes before the fix | ⚠️ **PARTIALLY FIXED** | Rewritten on `HangingTurnPlugin`, and it would now fail before the fix. As specified, though, it **hangs forever** — see N2 |
| B4 | `release()` drops turns: text lost + stale `pending` rows | ⚠️ **PARTIALLY FIXED** | Decision 5 targets the right function but persists **nothing** in production, because `release()` sets the `released` latch before it calls `abort_and_drain` — see N1. The frontend half works: `noteUserTurn` fires off the WS emit, which is not latched |
| B5 | Verification steps not runnable | ✅ **FIXED** | Every command resolves: `rust/Cargo.toml` is the workspace, the packages are `vst-agents` / `vst-routes`, and the test targets `json_agent_session_queue` / `json_agent_meta` / `json_agent_stream` exist. `web-ui/src/components/layout/ChatPane.test.tsx` exists, and `tsconfig.json` has no project references, so `npx tsc --noEmit` is valid. `#[tokio::test]` (current-thread) is stated for 1.T1 |

---

## New BLOCKING

### N1 — Decision 5's `cancelled` events are never persisted: `release()` sets the latch before `abort_and_drain` runs

- **Plan:** Decision 5 (plan lines 425–475), 1.4, CUJ 3 and the state diagram ("Dropped: PERSISTS cancelled:true") all assume that `emit_user_event` inside `abort_and_drain` writes a transcript row.
- **Source:**
  - `mod.rs:633-638`: `release()` sets `self.0.released = true` (holding the store lock) **before** anything else.
  - `mod.rs:646`: only after that does it call `self.abort_and_drain()`.
  - `mod.rs:885-889`: `persist_event` does `if self.0.released.load(..) { return; }`. So every new emit is a silent no-op for the store, and `log_seq` is never assigned.
  - `events.rs:151-152`: `stream.emit_message` still fires, so connected tabs get a `user{cancelled}` event with `logSeq: None`. That clears `pending` live, but a reload loses the text entirely. **The text loss half of B4 is still open.**
- **This is not a rare path either.** The plan's Research (lines 124–126) says `abort_and_drain` is "reachable only via session teardown (archive/dispose)". `release()` is also called from:
  - `sessions.rs:3751`: the ordinary **Rich Chat → terminal channel toggle** (json→tty).
  - `session_runtime.rs:128` (`release_session_runtime_with_warn`).
- **Why the plan's test misses it:** 1.T9 (lines 626–630) calls `abort_and_drain()` directly on an **un-released** session, so the latch is never set and the test passes while production is broken.
- **Fix:**
  - Persist the dropped turns **before** the latch. For example, add `fn cancel_all_pending_turns(&self)`, which takes `s.queue` and `s.holds` under the state lock, releases it, then emits `cancelled: true` for each dropped turn. Call it as the first statement of `release()`, ahead of the latch block.
  - Keep `abort_and_drain` as it is today, clearing only. It then covers anything enqueued in the tiny gap before the latch is set.
  - Correct the Research caller list (add `sessions.rs:3751` and `session_runtime.rs:128`) and the CUJ 3 diagram.
  - Rewrite 1.T9 to go through `session.release().await`, then read `read_transcript_from_data_dir(&data_dir, id)` (`mod.rs:948`). The store is closed after release, so the read has to go to disk. Copy the pattern in `tests/json_agent_transcript_locks.rs:180-215`.
  - Assert on a `cancelled == Some(true)` row with the original text **and** a `log_seq.is_some()` for both the queued turn and the held turn.

### N2 — 1.T3 as specified never terminates

- **Plan:** 1.T3 (lines 598–605) says to enqueue A (hanging), then enqueue B, then `stop_active_turn(None)`, then `session.settled().await`. It never says what B's message is, and puts no timeout around `settled()`.
- **Source:** `HangingTurnPlugin::run_turn` (`tests/json_agent_session_queue.rs:~268-285`) only finishes a turn whose message `starts_with("complete")`. Any other turn waits on `cancel.cancelled()` forever.
  - So once A is stopped, B runs and hangs, and `settled()` never resolves.
  - The existing `test_promote_…` (`:462-507`) avoids this by naming its turn `"complete X"` and wrapping the wait in `tokio::time::timeout`.
- **Fix:**
  - Specify B's message as `"complete B"` and wrap the wait in `tokio::time::timeout(Duration::from_secs(3), …)`, as `:484-496` does.
  - Recommended: also add the **plain drain-on-idle** variant, which is the exact user-reported path and involves no stop.
    - Steps: A = `"complete A"` (a 30ms turn); wait until `active_turn_id == A`; enqueue `"complete B"`; wait for settle.
    - Assert B's `user.log_seq` is greater than A's `Result` row. `drain.rs:289` stamps A's `turn_id` onto that row.

### N3 — 2.T4 has nothing to assert on: the channel-switch route throws its `SessionMeta` away

- **Plan:** 2.T4 (lines 683–686) says to assert that the `SessionMeta` "returned by the channel-switch route's error/no-live-agent branches" has empty `queued_turns`. It is also listed in Files & Phase Impact.
- **Source:**
  - `sessions.rs:3901`: the value is bound to `_meta` and never used.
  - `sessions.rs:4011-4015`: the route returns `PatchChannelResult { ok, channel, history_imported }`, which has no meta.
  - `sessions.rs:4002`: the code comments that no `SessionMeta` broadcast exists.
  - So no test can observe these two literals without changing production code.
- **Fix:** delete 2.T4 and its Files & Phase Impact row. `cargo build --workspace` (already the first step of Phase 2's Run line) is the whole verification for 2.5; `vec![]` there is purely a compile fix. Optionally add a note in Research that `_meta` is dead, so nobody goes looking for a consumer.

---

## New SUGGESTION

### N-S1 — 1.T8 and 1.T10 are placed in `mod.rs` tests but rely on fixtures that don't exist there

- 1.T8 (lines 622–625) says to use `MockTurnPlugin`, but that type lives in `tests/json_agent_session_queue.rs:62` and can't be reached from `src/…/mod.rs`'s `mod tests`. That module only has `NoopPlugin` (`mod.rs:~1048`).
- 1.T10 (lines 631–635) needs a "completed" turn, and it reads state white-box through `s.0.state`, which only works inside the crate.
- Pick one of these:
  - (a) Keep both in `mod.rs` and state explicitly that a `NoopPlugin` turn ends via the error branch (`drain.rs:151-167`). It still gets its pop-time `user` row, so `fork_turn`'s `first_seq_of_turn` resolves.
  - (b) Move both to the integration file and swap the white-box read for `get_meta().editing_turn_ids`. This is preferred, since the integration fixtures keep the `TempDir` alive (round-1 S7).

### N-S2 — Review IDs leak into the plan, and into source code

- **The code-comment leak:** 3.1's TypeScript doc comment (lines 696–699) contains `(Decision 4 / S9)`. That text would be committed into `types.ts`, where "S9" means nothing.
- Other occurrences:
  - "see review round 1" (1.T3, line 605)
  - "B2" (3.T6, line 726)
  - "S9" (API Contracts line 325, Risk 5 line 523)
- These are the same self-containment problem as round-1 S5. Strip the review IDs and keep the plan's own Decision numbers.

### N-S3 — Say that 1.T9 and 1.T10 depend on "no `.await` before the action"

- `enqueue()` calls `kick_drain()`, which does a `tokio::spawn`. A queued turn only stays in `s.queue` until the test's first `.await`.
- 1.T9 ("enqueue A and B with nothing running, so both sit in `s.queue`") and 1.T10 (enqueue, then immediately `begin_edit_queued_turn`) depend on this, exactly like 1.T1.
- Either state the current-thread / no-await requirement for both, or make them deterministic: start a hanging A, poll until it is active, then enqueue the turns that should stay queued.

### N-S4 — `release()`-time cancelled bubbles on the channel toggle deserve a CUJ-3 note

- With N1 fixed, toggling Rich Chat → terminal while messages are queued will leave `cancelled` bubbles in the transcript. The user sees them when they toggle back.
- That is correct: it's better than today, where the turns silently never run. But it's user-visible, so add one line to CUJ 3 and to Risks.

---

## Round-1 suggestions — spot check

| # | Suggestion | Status |
|---|---|---|
| S1 | fork while a turn is held | ✅ Decision 6 + 1.T10 (see N-S1 for test placement) |
| S2 | cancelled bubble moves position | ✅ Decision 7, Change Map row, Risk 4, 1.T7 asserts `count == 1` |
| S3 | `edited` flag is now dead | ✅ Decision 2's note, knowingly kept |
| S4 | stale doc comments | ✅ 1.1 (`queue.rs:42-43`), 1.3 (`:311`), 1.5 (`:221-222`, `MessageList.tsx:123`) |
| S5 | self-containment leaks, duplicate tree entry | ⚠️ tree entry merged and "original task notes" removed, but new review-ID leaks appeared (N-S2) |
| S6 | `sequenceDiagram` + `stateDiagram-v2` | ✅ CUJ 1–3 are sequence diagrams, and the turn-lifecycle state diagram was added. Its "Dropped PERSISTS" edge is only true once N1 is fixed |
| S7 | Files & Phase Impact omissions, fixture choice | ✅ integration file listed, fixtures documented with line refs |
| S8 | 2.T3 covers both builders; route literals asserted | ✅ 2.T3 covers `build_meta_from_store_meta` + `build_meta_from_transcript`. ❌ The route assertion (2.T4) is impossible (N3) |
| S9 | TS optionality note | ✅ 3.1 comment + Risk 5 (strip the "S9" label, N-S2) |

---

## Fresh-pass checks (no issue found)

| Check | Source | Result |
|---|---|---|
| Decision 5's `abort_and_drain` rewrite compiles | `s.queue.drain(..)` then `s.holds.drain()` are sequential borrows on one guard. `holds: HashMap<String, HeldTurn>` (`mod.rs:167`), `QueuedTurn` is already imported in `queue.rs:11`, and the emits happen after the guard is dropped (same lock order as `cancel_queued_turn`, `queue.rs:224-256`) | ✅ compiles, but it's a no-op for the store (N1) |
| Decision 1's pop-site emit is visible from `drain.rs` | `emit_user_event` is `pub(super)` (`events.rs:127`); `EmitUserEventOpts` is imported the same way by `queue.rs:11` | ✅ |
| Decision 3's snippet type-checks | `s.queue.iter()` and `s.holds.values().map(\|h\| &h.turn)` both yield `&QueuedTurn`; `vst_types::QueuedTurnMeta` resolves via `pub use domain::*` (`vst-types/src/lib.rs:21`) | ✅ |
| The existing queue tests still pass after the fix | `test_stop_active_turn_then_enqueue_…` (`:123`) reads `log_seq` from the emitted stream, and the pop-time emit still persists before emitting | ✅ |
| ChatPane test fixtures can drive 3.T3/3.T4 | `api.__test.emit({type:"session:meta", meta: meta(id, {...})})` pattern at `ChatPane.test.tsx:100-103, 395-398` | ✅ |
| Pop → meta ordering avoids a blank tray gap | `drain.rs` pop → emit_user_event (message) → `run_one_turn` → `emit_meta`, so B's message arrives before the meta that drops it from `queuedTurnIds` | ✅ |

---

## VERDICT: **NEEDS CHANGES**

- **N1 is the one that matters.** As written, Decision 5 still loses queued text on every `release()`, including the ordinary json→tty toggle, and its only test would hide that. Move the persist ahead of the latch and test through `release()`.
- N2 and N3 are one-line fixes to the test spec: name B `"complete B"` with a timeout, and delete 2.T4.
- Everything else (B1, B2, B5, Decisions 1–4, 6–8) checks out against source. No redesign needed; one more small revision should reach CLEAN.

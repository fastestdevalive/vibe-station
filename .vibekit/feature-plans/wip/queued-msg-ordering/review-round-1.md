<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Review round 1 — `plan-queued-msg-ordering.md`

- **Reviewed:** `.vibekit/feature-plans/wip/queued-msg-ordering/plan-queued-msg-ordering.md` (475 lines)
- **Against:** `planning` skill — `SKILL.md`, `FORMAT.md`, `SECTIONS.md`
- **Source verified at:** branch `fix/queued-msg-ordering` @ `d59e19d9`
- **Verdict:** **NEEDS CHANGES** — 5 BLOCKING, 9 SUGGESTION

---

## Summary

- The core diagnosis is right, and so is Decision 1 (where to emit).
  - `enqueue()` persists the `user` event at `queue.rs:66-72`.
  - `drain.rs:68` is the only `pop_front` in the crate (grep-verified). Every human turn — normal, promoted, resubmitted, forked — goes through it.
  - `run_notice_slot_turn` already pre-emits (`drain.rs:386-394`), so emitting inside `run_one_turn` would double-emit. The plan is right to avoid that.
- Blockers:
  - The plan misses one production compile break and four test compile breaks.
  - Decision 4's lookup snippet mixes two value shapes (`message` vs `text`), so it won't type-check.
  - 1.T3, the only ordering test, passes before the fix, so it proves nothing.
  - One observable regression is not addressed: queued turns dropped by `release()` lose their text, and the sender's tab keeps stale rows in the tray.
  - The verification steps are not runnable as written.

---

## Scenario trace (verified against source)

| Scenario | Backend (plan's Decisions 1–3) | Frontend tray (Decisions 3–4, Phase 3) | Result |
|---|---|---|---|
| Drain-on-idle | `drain.rs:66-71` pop → new emit → `run_one_turn`. `logSeq` comes after all of A's rows, including A's trailing `emit_stopped` at `drain.rs:311` | B leaves `queuedTurnIds` at the `emit_meta` in `run_one_turn` (`drain.rs:180`). B's `session:message` arrives one message earlier, while B is still hidden (`MessageList.tsx:530`), so there's no visible glitch | ✅ correct |
| Promote / force-send | `promote_queued_turn` (`queue.rs:372-391`) only reorders the queue and calls `stop_active_turn`. The cancelled A breaks out of its loop, `emit_stopped` runs (`drain.rs:310-312`), and only then does the pop + emit for X happen. So X's `logSeq` comes after A's "Turn stopped" | Same as drain-on-idle | ✅ correct |
| Resubmit, `edited: true` | Mutation at `queue.rs:308-310` is kept. Removing `319-329` means nothing is persisted until the turn runs. The pop-time emit reads the updated `turn.raw_message` | This tab: `queuedTurnsMeta` (edited text) wins over the stale `pending.message`. Other tabs: the same, via `session:meta` from `resubmit_queued_turn` | ✅ correct, but see B2 (type bug) |
| Resubmit, `edited: false` | `queue.rs:308` gate is unchanged, so the text is not mutated and nothing is emitted | Row shows the unchanged text from `queuedTurnsMeta` | ✅ correct |
| `fork_turn` | `first_seq_of_turn(from)` (`transcript.rs:407-416`) returns the MIN of the live rows, i.e. the original turn's pop-time `user` row. The new turn goes through `enqueue()`, so it's deferred and then emitted at pop, after `mark_superseded_from` | Sender tab: `pending{queued:false}` shows inline until the `user` event arrives | ✅ correct |
| Fork-of-fork | The forked turn F's first row is its pop-time `user` event, so `first_seq_of_turn(F)` resolves once F has started. `canFork = !turnActive` (`MessageList.tsx:512`), and F is in `hiddenTurnIds` while queued, so F can't be forked before it has a row | — | ✅ correct |
| Fork while a turn is held for editing | **Changes, not covered in the plan** — see S1 | — | ⚠️ |
| Cross-tab, queued | — | Other tab: `meta.queuedTurns`. Reload: the `chat_open.rs:73` → `read_session_meta` → `live.get_meta()` snapshot includes `queuedTurns` | ✅ correct |
| Cross-tab, held (editing) | Decision 3 covers `s.holds` | The other tab's editing row shows the text from `queuedTurnsMeta` | ✅ correct, but see B2 |
| Cross-tab, cancelled | `cancelled: true` event is now the only row, at the cancel-time `logSeq` | The cancelled bubble moves from its enqueue position to its cancel position | ⚠️ see S2 |
| Session `release()` with queued/held turns | `abort_and_drain` (`queue.rs:162-182`) clears the queue and holds and emits nothing | Sender tab: `pending{queued:true}` rows are never cleared | ❌ see B4 |

---

## BLOCKING

### B1 — Adding a field to `SessionMeta` breaks compilation in six places the plan doesn't list

- **Plan:** 2.2 (line 395–396) adds the non-`Option` field `queued_turns: Vec<QueuedTurnMeta>`. Files & Phase Impact (lines 465–475) lists only `meta.rs` and `mod.rs` as constructors.
- **Source:** `SessionMeta` (`rust/vst-types/src/domain.rs:438-462`) has no `Default` derive. Every struct literal must name every field, so these fail to compile:

| File:line | Kind |
|---|---|
| `rust/vst-routes/src/sessions.rs:3930-3953` | **production** (channel-switch meta, first branch) |
| `rust/vst-routes/src/sessions.rs:3958-3983` | **production** (second branch) |
| `rust/vst-agents/tests/json_agent_stream.rs:60` | test |
| `rust/vst-agents/tests/json_agent_stream.rs:100` | test |
| `rust/vst-agents/tests/json_agent_meta.rs:173` | test |
| `rust/vst-agents/tests/json_agent_meta.rs:~202` (2nd literal, `editing_turn_ids` at :212) | test |

- **Fix:** add a Phase 2 item that sets `queued_turns: vec![]` in each literal, and add all six rows to Files & Phase Impact.
- An alternative is `#[serde(default)]` plus a `Default` impl, but explicit literals match the existing style.

### B2 — Decision 4 / 3.3's lookup mixes two value shapes, so it won't type-check

- **Plan:** Decision 4 (lines 299–301) and 3.3 (lines 438–443) resolve `info` as `queuedTurnsMeta.get(turnId) ?? userEvents.map.get(turnId)`, while "keeping every existing `fallback`/`draft` handling exactly as-is".
- **Source:**
  - The 3.2 map holds `{ message, attachments? }`.
  - `userEvents.map` holds `{ text, attachments? }` (`ChatPane.tsx:211`).
  - The existing consumers read `info?.text` (`ChatPane.tsx:240`, `:252`).
- **Failure:** under `strict`, `text` doesn't exist on the union, so it's a TS error. If someone casts around that, rows sourced from `meta.queuedTurns` render `""`, which is exactly the blank-row bug Decision 3 is meant to fix.
- **Fix:** have 3.2 normalize to `{ text: qt.message, attachments: qt.attachments }` so both maps share one shape. Update the 3.2 snippet so the cold implementer can't miss it.

### B3 — 1.T3 passes before the fix; no test reproduces the actual bug

- **Plan:** 1.T3 (lines 357–361) enqueues A, then `settled()`, then enqueues B, then `settled()`, and asserts `B.logSeq > A.logSeq`.
- **Why it's vacuous:**
  - B is enqueued after A has fully finished, so even today B's enqueue-time `logSeq` is greater than A's.
  - `NoopPlugin` (`mod.rs:1085-1094`) never emits.
  - `NoopPlugin` also doesn't override `supports_acp()`, which defaults to `false` (`plugin.rs:292-294`). So `run_one_turn` takes the error branch (`drain.rs:151-167`): it persists an `Error` event and sets `TurnState::Error`. The plan claims "A never emits extra events", which is wrong.
- **Fix:** replace 1.T3 with a test that fails before the fix:
  - Use a plugin that has `supports_acp() == true` and emits events after a gate or delay.
  - The existing harness in `rust/vst-agents/tests/json_agent_session_queue.rs` already fits: `MockTurnPlugin` at `:98-119` emits `Result` after 50ms, and `HangingTurnPlugin` / `make_hanging_session` are at `:231-296`.
  - Steps: enqueue A, wait until `active_turn_id == A`, enqueue B, then `settled()`.
  - Assert B's `user.log_seq` is greater than **every** row whose `turn_id == A` (including A's `Result`).
  - Add a promote variant: B's `user.log_seq` must be greater than A's "Turn stopped" row.
  - Put these in the integration test file, not in `mod.rs` tests. Its fixtures keep the `TempDir`/`HomeGuard` alive, whereas `mod.rs::session()` drops both at return (`mod.rs:1098-1099`).

### B4 — Unaddressed regression: turns dropped by `release()` lose their text, and the sender's tab keeps stale "pending" tray rows

- **Plan:** Requirement 4 (line 59) and Risk 1 (line 315) assume the only thing that reads queued-turn text is the tray. `abort_and_drain` is never mentioned.
- **Source:**
  - `release()` (`mod.rs:627-663`) calls `abort_and_drain()`.
  - `abort_and_drain()` (`queue.rs:162-182`) clears `s.queue` and `s.holds` and emits nothing.
- **Today:** each dropped turn's text survives as its enqueue-time `user` row. The sender's `pending` entry was cleared the moment that row arrived (`useChat.ts:223-228`).
- **After the fix:**
  - **Text loss:** a message queued before an archive, daemon shutdown or restart disappears entirely. It is in neither the transcript nor the tray.
  - **Stale rows:** in the sender's tab, `pending{queued:true}` is never cleared, because no `user` event ever arrives. The `trayRows` pending loop (`ChatPane.tsx:259-268`) renders it as a `status:"pending"` row indefinitely.
    - The same happens whenever a queued turn leaves `s.queue` without a `user` event.
    - Before the fix, `pending` lived for about one round-trip. After it, `pending` lives as long as the turn stays queued.
- **Fix:** add a Key Decision covering both:
  - **Daemon:** have `abort_and_drain` emit `cancelled: true` for each dropped queued/held turn, mirroring `cancel_queued_turn`, or explicitly accept the loss in the plan.
  - **Frontend:** prune `pending{queued:true}` entries whose `turnId` is absent from `queuedTurnIds ∪ editingTurnIds` once a `session:meta` has confirmed it was queued. Or render tray rows only from `meta`, and use `pending` only before the first meta that lists the turn.
- Add a CUJ error path and a test for each.

### B5 — Verification steps aren't runnable as written (fails the Self-containment bar)

- **FORMAT.md § Self-containment bar:** "Verification steps runnable verbatim — exact commands, not 'run the tests'".
- **Plan:**
  - 3.T5 (line 458) says "`npm test` / project's configured runner".
  - Phases 1 and 2 give no command at all.
  - 1.T1 relies on "single-threaded-until-await" but never says the test must be `#[tokio::test]`. A plain `#[test]` panics in `tokio::spawn` via `kick_drain` (`queue.rs:427`).
- **Fix:** add exact commands, e.g.:
  - `cd rust && cargo build --workspace`, which catches B1
  - `cd rust && cargo test -p vst-agents`
  - `cd rust && cargo test -p vst-routes`
  - `cd web-ui && npx vitest run src/components/layout/ChatPane.test.tsx`
  - `cd web-ui && npm test` (runs `vitest run`)
  - `cd web-ui && npx tsc --noEmit`
- Also state `#[tokio::test]` (current-thread flavour) for 1.T1, 1.T4, 1.T5, 1.T6 and 1.T7. Those tests depend on the drain task not running until the first `.await`.

---

## SUGGESTION

### S1 — A fork while a turn is held for editing now behaves differently

- `canFork = !turnActive` (`MessageList.tsx:512`), so a fork is allowed while `s.holds` is non-empty.
- **Today:** the held turn's enqueue-time row has a `logSeq` greater than the fork point, so it lands in `superseded_turn_ids`, and `useChat.ts:333-344` drops its `editingDraft`.
- **After the fix:**
  - The held turn has no row, so it's never superseded. It survives the fork and runs after the forked turn.
  - This is arguably more correct, but it's a behaviour change. Requirement 4 claims `fork_turn` behaviour is unchanged.
- Add one line to Risks and a regression test.

### S2 — The cancelled bubble moves, and Risk 3 doesn't say so

- Risk 3 (line 317) only covers whether the bubble still reads as cancelled.
- **Today:** `MessageList.tsx:173-182` keeps the superseding event at the ORIGINAL enqueue position.
- **After the fix:** the cancelled bubble renders at the cancel-time `logSeq`.
- Add a row to Change Map's Today/After table and to Risk 3.

### S3 — Pop-site emit: reflect `edited` or drop it knowingly

- After the fix, `EmitUserEventOpts.edited` is never `true`. `NormalizedEvent.edited` still exists (`web-ui/src/api/types.ts:342`), but no UI reads it (grep-verified).
- Either note that it's dead now, or carry an `edited: bool` on `QueuedTurn` so the run-time event keeps the flag.

### S4 — Stale doc comments the plan should update

- `queue.rs:42-43`: `enqueue` says it "Synthesizes the daemon-owned user event immediately (Decision 12)".
- `queue.rs:222-223`: `cancel_queued_turn` says it "Emits a superseding user event".
- `queue.rs:311`: "Emit the superseding user event outside the lock (below)".
- `MessageList.tsx:123`: comment about a superseding (edited) event.
- Add these to 1.1 and 1.3.

### S5 — Self-containment and "post-hoc narrative" leaks

- Decision 3 (line 283): "as the original task notes suggested" refers to context the implementer doesn't have. Delete it; FORMAT.md bans post-hoc narrative in Decision blocks.
- Decision 3 (line 282) cites "Research's `ChatPane.tsx:246-258` finding", but Research actually cites `ChatPane.tsx:230-270` / `:252`. Make them match.
- Change Map tree (lines 67–74) lists `rust/vst-agents/src/json_agent_session/` twice. Merge the two entries.

### S6 — The diagram triggers in SECTIONS.md aren't met

- CUJ 1 and CUJ 2 cross three layers (daemon, then the WS event, then React). SECTIONS says to use a `sequenceDiagram`, not ASCII.
- The turn's lifecycle (queued, held, running, done/cancelled/dropped) has more than two states. SECTIONS says to use `stateDiagram-v2`.
  - The state diagram is also the clearest place to show which transitions persist a row, which is the crux of B4 and S2.

### S7 — Files & Phase Impact omissions (besides B1)

- `rust/vst-agents/tests/json_agent_session_queue.rs`: existing regression suite, and the home for the new B3 test.
  - `test_stop_active_turn_then_enqueue_runs_turn_and_sets_log_seq` (`:122-192`) and `test_promote_stops_active_and_runs_promoted_to_completion` (`:461-507`) should still pass. List them as regression items.
- The "tests mod" row for `mod.rs`: `mod.rs::session()` drops its `TempDir` and `HomeGuard` at return (`mod.rs:1098-1099`). Transcript reads then go through a SQLite file that has been unlinked. That works on Linux, but it's fragile. Prefer the integration-test fixtures.

### S8 — 2.T3 targets the wrong function

- 2.T3 says "`build_meta_from_store_meta` (or `assemble_meta` directly)". Also cover `build_meta_from_transcript` (`meta.rs:35`), since all three are `pub`.
- The route literals in B1 need their own assertion too, e.g. a `vst-routes` channel-switch test checks `queued_turns.is_empty()`.

### S9 — Wire optionality mismatch (minor)

- Rust `queued_turns: Vec<_>` is always serialized; only `Option` fields are skipped.
- The TS type is `queuedTurns?:`. That's fine for mock fixtures, but add a one-line note that it's optional only for `mock.ts` / older daemons, so nobody "fixes" it into a required field and breaks the mocks.

---

## Claims checked against source

| Plan claim (line) | Source | Status |
|---|---|---|
| `enqueue` emits at `queue.rs:66-72` (91) | `queue.rs:66-72` | ✅ |
| `drain.rs:66-71` is the single entry for human turns (93–97) | the only `pop_front` in `vst-agents/src` is `drain.rs:68` | ✅ |
| Notice path pre-emits at `drain.rs:385-394` (101) | `drain.rs:386-394` | ✅ |
| `resubmit` mutation `309-310`, emit `319-329` (108–111) | matches | ✅ |
| `cancel_queued_turn` emits at cancel time (112) | `queue.rs:238-247` | ✅ (see S2 for the position change) |
| `fork_turn` goes through `enqueue` (115) | `queue.rs:363` | ✅ |
| `get_meta` builds ids only (119) | `mod.rs:442-443` | ✅ |
| Held turns have no `pending` fallback (124) | `ChatPane.tsx:246-257` | ✅ |
| `logSeq` assigned under the store mutex in call order (Risk 2) | `transcript.rs:337-343`, `persist_event` at `mod.rs:885-893` | ✅ |
| `NoopPlugin` "never emits"; A "never emits extra events" (358) | `supports_acp` defaults to `false` (`plugin.rs:292`), so `run_one_turn` persists an `Error` event (`drain.rs:151-167`) | ❌ (B3) |
| Only `meta.rs` + `mod.rs` build `SessionMeta` (implied by 465–475) | also `vst-routes/src/sessions.rs` ×2 and 4 test literals | ❌ (B1) |
| "Only consumers" of queued-turn text are the tray and editingDrafts (Risk 1) | release/abort path + `pending` lifetime not considered | ❌ (B4) |

---

## Format compliance (planning skill)

| Check | Status |
|---|---|
| Header block right after the frontmatter | ✅ |
| Change Map above Research; tree ⊆ table | ⚠️ tree ⊆ table holds, but the table is incomplete (B1, S7) and one directory is listed twice |
| Research ≤15% of the doc and every finding cited | ✅ (~10%) |
| CUJs: happy path + an error path | ⚠️ present, but the release/abort path is missing (B4) and the multi-layer CUJs have no sequence diagram (S6) |
| Data Model table + migration note | ✅ |
| System Boundaries typed | ✅ |
| Every Key Decision has a **Where** | ✅ |
| Every phase has a `Verify phase N` block with specific tests | ⚠️ present, but 1.T3 is vacuous (B3) and no commands are given (B5) |
| Self-containment bar | ❌ B2 (the snippet won't compile), B5 (no commands), S5 (reference to chat history) |

---

## VERDICT: **NEEDS CHANGES**

- Fix B1–B5 before implementation. B1 and B2 would fail the build; B3 leaves the fix unproven; B4 is a user-visible regression; B5 fails the self-containment bar.
- The core approach (Decisions 1–3) is sound and the backend scenario traces all check out, so no redesign is needed.

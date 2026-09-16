# Phase brief: 07a — rest-routes-core

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `07a`, Entities & Modules row(s)
for `vst-routes`, Gotchas #1 (withSessionLock), #4 (draft-promotion HTTP-response
self-sufficiency), #5 (sessionStates live-state resolution — read-side only, N/A to routes
but relevant if any handler serializes status), Gotcha table row on the two-axis
lifecycle/PR model, System Boundaries rows for REST + `vst-types::rest`.
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-routes
**Depends on (already `done`):** 00, 01, 03, 04c, 05, 06

## ⚠️ Confirmed oversized — split before dispatch (measured LOC, not the arch doc's stale estimate)

Arch doc's Part Breakdown table lists `07a` at ~3.5k LOC. Actual measured LOC (2026-09-15):

```
3009 daemon/src/routes/sessions.ts
1574 daemon/src/routes/worktrees.ts
1008 daemon/src/routes/projects.ts
 314 daemon/src/routes/modes.ts
 140 daemon/src/routes/open.ts
6045 total
```

`sessions.ts` alone (3009 LOC) exceeds `04c`'s entire `jsonAgent.ts` (2057 LOC, which took
4 dispatch continuations across 2 models). Per arch doc's own rule ("if a future part's own
plan phase finds its file-map row still too large once drafted, split it there, before
dispatch") — this part is pre-split below, mirroring `04c`'s file-split-not-struct-split
approach. Do not dispatch `sessions.ts` as one continuation.

## Files to port — dispatch order

| # | Scope | Source LOC | Risk | Notes |
|---|---|---|---|---|
| 1 | `sessions.ts` **Group A** — lookup/list/create: `findSessionContext`, `findWorktreeContext`, `serializeSession`/`serializeGlobalDraft`, `runAgentSpawnJob`/`runDirectAgentSpawnJob`/`spawnNewSessionForChannel`, `GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/output`, `POST /sessions` | ~1070 (lines 1–1069) | Medium | `POST /sessions` alone is 471 lines (largest handler in the file) — draft/global/direct/worktree branches inline. Treat as its own sub-effort within this continuation. |
| 2 | `sessions.ts` **Group B1** — delete/draft-lifecycle/pin: `DELETE /sessions/:id`, `PATCH .../draft`, `POST .../start`, `PATCH .../pin\|rename\|reorder\|delink` | ~700 (lines 1072–~1770) | **Highest** | See "Highest-risk group" below. |
| 3 | `sessions.ts` **Group B2** — done/resume/reset/handoff: `POST .../done`, `POST .../resume`, `POST .../reset`, `POST .../handoff` | ~450 (lines ~1770–2224) | High | `resume`/`reset` duplicate channel-aware guarded-spawn logic + `agentChatId` self-healing — high branch count. |
| 4 | `sessions.ts` **Group C** — send/chat/queue: `sendHandler` (`POST .../send`), `POST .../chat`, `.../chat/dismiss-notice`, `.../promote-notice`, `.../stop`, `DELETE .../chat/queue/:turnId`, `.../edit`, `.../resubmit`, `.../promote`, `.../fork`, `PATCH .../chat/model` | ~380 (lines 2226–2606) | Medium | Mostly thin dispatch into already-ported `04c` `vst-agents::JsonAgentSession`/`jsonAgentRegistry` — should be the easiest continuation. |
| 5 | `sessions.ts` **Group D** — channel toggle + transcript/meta: `spawnTtyForAgent` helper, `PATCH .../channel`, `GET .../transcript`, `GET .../meta` | ~400 (lines 2608–3009) | High | `PATCH .../channel` (~226 lines) deliberately resets `lifecycle` to `working` (mirrors `/resume`) — second independent place the two-axis lifecycle field must be touched correctly. |
| 6 | `worktrees.ts` — full file, single-shot | 1574 | Medium | Largest handler `POST /worktrees` ~239 lines; nothing else near the 400-line threshold. If it stalls mid-dispatch, split by CRUD (create/pin/hide/rename/reorder/done/delete) vs. read-only git surfaces (tree/file-list/files/diff/changed-paths/diffstat/commits/submodules/pr/pending-file-opens) — do not pre-split unless it actually stalls. |
| 7 | `projects.ts` — full file, single-shot | 1008 | Medium | `POST /projects/create` is ~443 lines (comparable complexity to `sessions.ts`'s biggest handler) — flag explicitly in this continuation's dispatch prompt, same treatment `04c` gave `JsonAgentSession`. |
| 8 | `modes.ts` + `open.ts` — single-shot, one continuation | 454 | Low | Trivial. |

8 continuations total (5 for `sessions.ts`, 1 each for the other three groupings), each ≤ ~1100
LOC of source TS — under the ~800–1000/continuation target except #1 and #6, both flagged with
an explicit largest-handler callout rather than a further pre-split (their size is one big
function, not many small ones, so splitting the file wouldn't reduce the hard part).

## Highest-risk group — Group B1 (dispatch #2)

- `DELETE /sessions/:id`'s main-session promotion logic re-derives "is main / has eligible
  sibling" **inside** the `mutateProject` locked callback, not off pre-lock state — this
  closes a promotion race. A naive port that checks-then-acts outside the lock reintroduces
  it. This is exactly Gotcha #1 (`withSessionLock`)'s failure mode, applied to `mutateProject`
  rather than the WS lock — same principle: never let the read that decides the action happen
  outside the lock that performs it.
- `POST /sessions/:id/start` (draft promotion) is Gotcha #4: the HTTP response must already
  carry final persisted state (worktree id + full serialized worktree record) *before* the
  async `spawnNewSessionForChannel` fire-and-forget is even started. Do not make the Rust
  handler's response depend on anything the spawn does.

## vst-types check before any amendment

Per arch doc's `vst-types` ownership rule: `07a` is forbidden from defining any
`#[derive(Serialize, Deserialize)]` type. Check `rust::vst-types::rest::sessions` /
`::worktrees` / `::projects` / `::modes` (ported by part `00`) for the shape first; if a
response shape is genuinely missing, follow the amendment rule in the arch doc's System
Boundaries row — do not define a local type in `vst-routes`.

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [ ] 0. Load rust-coding skill
- [ ] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [ ] 2. Write the behavior contract (bullets) — per continuation (dispatch #1–8 above)
- [ ] 3. Write Rust tests first; `git commit -m "test(07a-N): <group> behavior contract"`
        where N is the dispatch # from the table
- [ ] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [ ] 5. Run rust/scripts/rust-gate.sh vst-routes; save log to rust/.gate/07a-N.log; commit
- [ ] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP
- [ ] Repeat 0-6 for each of the 8 dispatch rows above, in order, before closing out `07a`

## Closed out — dispatch #1 (Group A) complete (2026-09-15)

- Commit `844dedc` (`feat(07a-1)`) — combined test+impl commit (06-ws-realtime precedent;
  no test-first boundary since the tests need the full API to compile).
- Gate re-verified independently (not just the implementer's saved log): `rust-gate.sh
  vst-routes` and `rust-gate.sh vst-store` both green. N6 checked against `57afc5d~1`
  (07a's true start commit) — `rust/Cargo.toml`/`rust-ci.yml` diff empty.
- Tests read directly: 18 tests / 68 assertions in `vst-routes/tests/sessions_group_a.rs`,
  real 404/400 + wire-roundtrip coverage.
- One steering nudge (JSON-channel turn boundary mid-clippy-fix — not a stuck loop).
- Cross-part gaps surfaced, not blockers: `spawnSession`/`spawnDirectSession` orchestration
  (never ported by 04a/04b/04c as expected) landed here in `vst-routes`; direct-pty output
  read uses a local `HashMap` pending the real `DirectPtyRegistry::get_recent_output`
  (part-03 gap); live tmux/pty spawn paths unit- but not integration-tested.
- Full detail in `.sdlc-state.yaml`'s `07a-rest-routes-core` `process_note`.

## Closed out — dispatch #2 (Group B1, highest-risk) complete (2026-09-15)

- Commit `acb0eb4` (`feat(07a-2)`) — combined test+impl commit again (same precedent).
- Both risky invariants directly read and confirmed correct: (1) authoritative
  main-session-promotion decision lives inside the locked `mutate_project` callback
  (`sessions.rs:1310-1344`), with only a non-authoritative fast-path pre-check outside
  it; (2) draft-promotion's response is built from the just-persisted state and the
  async spawn (`tokio::spawn`) fires strictly after — no dependency either way.
- Gate re-verified independently for `vst-routes` and `vst-store`. N6 clean.
- Also fixed a real cross-part bug: `vst-store::update_global_draft` was emitting
  invalid SQL and NULLing every untouched column instead of a true partial update.
- 30/30 tests pass (1 `#[ignore]`d — needs a real git worktree). Spot-read the
  drafting-sibling-excluded test directly — genuinely exercises in-lock filtering.
- Full detail in `.sdlc-state.yaml`'s `process_note`.

## Closed out — dispatch #3 (Group B2) complete (2026-09-15)

- Commit `0c0db4c` (`feat(07a-3)`) — combined test+impl commit again.
- Both invariants directly read and confirmed: resume sets lifecycle to `Working`
  (`sessions.rs:2342-2346`); both `run_handoff_turn` call sites pass through to the
  existing bounded `vst-lifecycle` API, no new raw loop.
- Gate re-verified independently for `vst-routes`. N6 clean.
- Implementer disclosed 3 real cross-part gaps in already-"done" parts 05/06 instead
  of silently working around them: `run_handoff_turn`'s 30s-vs-60s timeout + polling
  interval divergence from TS (part 05); missing `ServerEvent::SessionResumed`/
  `SessionCreated` fields the wire type supports but the internal event enum doesn't
  (part 06); `forceCloseSessionStreams` unreachable from `vst-routes` (part 08 wiring).
  None block this gate — flagged for a later reviewer pass.
- Full detail in `.sdlc-state.yaml`'s `process_note`.

## Closed out — dispatch #4 (Group C) complete (2026-09-15)

- Commit `1784b0a` (`feat(07a-4)`) — combined test+impl commit again.
- All thin route-layer dispatch into already-ported `vst-agents` (04c), no business
  logic reimplemented (as instructed). Gate re-verified independently; N6 clean.
- Cross-part gap: no `ServerEvent::SessionFork` variant, same class as dispatch #3's
  finding — fork's broadcast mirror isn't emitted, only the lifecycle flip is.
- **⚠️ Real cross-session conflict surfaced, RESOLVED (2026-09-15, user-directed):**
  the sibling orchestrator session (`port-rust-master`) had an uncommitted arch-doc
  edit proposing to drop the edit-a-sent-message/fork path entirely (retroactive to
  already-`done` `04b`). This dispatch had faithfully ported `.../chat/fork` per its
  brief before that edit was known. User confirmed the drop — route removed in
  commit `d151c71` (fork_session handler, `ChatRouteError::UnsupportedFork`, the
  `fork_missing_session_404` test). Gate re-verified green, N6 clean.
  `vst-types::rest::sessions::ForkBody`, the WS `SessionFork` wire variant, and
  `vst-agents`' underlying `fork_turn`/`get_fork_command` machinery (parts 04a-04c)
  were deliberately left untouched — those are separate, bigger scope than this
  route removal, belonging to whichever part follows through on the full descoping.
- Full detail in `.sdlc-state.yaml`'s `process_note`.

## Closed out — dispatch #5 (Group D, first agy-medium dispatch) complete (2026-09-15)

- Commit `ca79f20` (`feat(07a-5)`) — first dispatch on `agy-medium`, ran clean end to
  end after the initial startup "y", no steering needed.
- Lifecycle-to-`Working` invariant directly read and confirmed: correctly gated on
  `from_json` (json→tty only), matching TS scope rather than copying resume's
  unconditional reset verbatim.
- Gate re-verified independently (111 tests across groups A-D). N6 clean.
- Cross-part gap: no `ServerEvent::SessionMeta` variant (same class as #3/#4's finding).
- Full detail in `.sdlc-state.yaml`'s `process_note`.

## Closed out — dispatch #6 (worktrees.ts, full file) complete (2026-09-15)

- Commits `7e0a4a4` (`feat(07a-6)`) + `f72f55f` (`test(07a-6)`, follow-up).
- **First real gate failure of `07a`**, first-failure corrective feedback resolved it,
  no escalation needed: initial delivery had zero test coverage for `POST /worktrees`
  (the flagged highest-complexity handler) and the 6 read-only git-surface routes.
  Follow-up added real coverage against an actual git repo (branch derivation, DB
  persistence, event broadcasts, 5 error paths, all 6 git-surface routes exercised).
- Clean `vst-types` amendment (`FileListResult`) — correctly placed, not local.
- Gate re-verified independently both times. N6 clean.
- Full detail in `.sdlc-state.yaml`'s `process_note`.

## Closed out — dispatch #7 (projects.ts, full file) complete (2026-09-15)

- Commits `7bd561d` (`feat(07a-7)`) + `0d97313` (`test(07a-7)`, follow-up).
- **Second real gate failure of `07a`, different failure mode than #6:** initial
  delivery had genuinely real tests present (heeded #6's lesson) but 17 bare
  `matches!(err, Variant)` calls with no `assert!()` wrapper — the boolean result was
  silently discarded, so every error-path test was a no-op that clippy couldn't catch.
  Follow-up wrapped all 17 in `assert!()`; gate still green with the real assertions
  enforced, confirming the underlying logic was correct all along.
- Gate re-verified independently both rounds. N6 clean.
- Operational note: a `vst session send --wait` had a delivery hiccup for this
  session; `--no-wait` + a follow-up output check worked. Also tightening agy poll
  cadence going forward — these tmux sessions can finish real work within a single
  short poll window.
- Full detail in `.sdlc-state.yaml`'s `process_note`.

## Closed out — dispatch #8 (modes.ts CRUD + open.ts, FINAL) complete (2026-09-15)

- Commit `306b6a0` (`feat(07a-8)`) — clean first try, no gate failure.
- Explicitly briefed on both prior failure modes (#6 zero-coverage, #7 unwrapped
  `matches!()`) and told to self-check; it did, and its self-check was correct
  (independently re-verified: all 13 `matches!()` in the new test file are within
  3 lines of an `assert!()`).
- Gate re-verified independently. N6 clean. No `vst-types` amendments.

# ============================================================
# 07A-REST-ROUTES-CORE — PART COMPLETE
# ============================================================

All 8 dispatches done and independently gated (full detail + commit hashes in
`.sdlc-state.yaml`'s `07a-rest-routes-core` `process_note`):

| # | Scope | Result |
|---|---|---|
| 1 | Group A (lookup/list/create) | clean first try |
| 2 | Group B1 (delete/draft/pin — highest risk) | clean first try |
| 3 | Group B2 (done/resume/reset/handoff) | clean first try |
| 4 | Group C (send/chat/queue) | clean first try |
| 5 | Group D (channel/transcript/meta) | clean first try — first agy-medium dispatch |
| 6 | `worktrees.ts` (21 routes) | **gate failure** (zero coverage), fixed 1st round |
| 7 | `projects.ts` (8 routes) | **gate failure** (unwrapped `matches!()`), fixed 1st round |
| 8 | `modes.ts` CRUD + `open.ts` | clean first try |

**6/8 clean, 2/8 needed one corrective round each, 0 escalations.** Both real
failures were caught only by directly reading test code after "gate green" —
neither clippy nor rustfmt nor test-count would have caught either one.

**Resolved (2026-09-15, user-directed):** the sibling orchestrator session had an
uncommitted arch-doc edit proposing to drop the edit-a-sent-message/fork path
entirely (retroactive to already-`done` `04b`). Dispatch #4 had already faithfully
ported `POST /sessions/:id/chat/fork` before that edit was known. User confirmed
the drop — route removed post-hoc in commit `d151c71`, gate re-verified green.

**Cross-part gaps surfaced for later parts to reconcile** (not blockers): part 05's
`run_handoff_turn` timeout/interval divergence from TS; part 06's missing
`ServerEvent` variants for `SessionResumed`/`SessionCreated`-snapshot/`SessionFork`/
`SessionMeta`; part 08's `forceCloseSessionStreams` wiring; spawn orchestration
(`spawnSession`/`spawnDirectSession`/`spawnSessionFromArgv`) landing in `vst-routes`
instead of `vst-agents` as originally scoped to 04a/b/c; part 03's `DirectPtyRegistry`
still missing `get_recent_output`.

**Next:** `07b-rest-routes-misc`, continuing on `agy-medium` per model-swap
exception #2 — needs its own phase brief written first.

## Part-specific notes

- No unbounded retry/poll loop lives directly in `sessions.ts`. The one touchpoint is
  `runHandoffTurn(session, { timeoutMs: 60_000, handoffPath })`, called from
  `POST /sessions/:id/reset` (Group B2) and `POST /sessions/:id/handoff` (Group B2) — the
  actual poll loop is in `services/handoff.ts`, owned by already-`done` `05-lifecycle-status`.
  **Action:** confirm whatever bounded API `vst-lifecycle::handoff` exposes still takes/enforces
  a timeout before wiring these two call sites through — don't let the route handler
  re-introduce an unbounded wait if `05`'s ported signature silently dropped the parameter.
- `PATCH .../channel` (Group D) and `POST .../resume` (Group B2) are two independent call
  sites that both reset the lifecycle axis to `working` — a Rust port missing either one
  reintroduces the exact bug class documented in AGENTS.md's "Session status in a pane" section
  (stale status shown after a state-changing action), just server-side instead of client-side.

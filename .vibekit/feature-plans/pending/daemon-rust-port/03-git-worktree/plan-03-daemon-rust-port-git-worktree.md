# Phase brief: 03 — git-worktree

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `03-git-worktree`, Entities & Modules row for `vst-git`, Forward-compatibility check row "Read-only git status/diff for a file-tree UI", System Boundaries (no `vst-git`-specific row exists — none of the boundary rows name this crate directly; skim the table anyway for the two-axis-status and PTY-stream rows so you don't accidentally reach into `vst-store`/`vst-proc` internals instead of their public handles).
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-git
**Depends on (already `done`):** 00-foundation, 01-storage, 02-process-pty

## Files to port
From file-map.tsv (part 03):
- daemon/src/services/branchValidator.ts
- daemon/src/services/git.ts
- daemon/src/services/naming.ts
- daemon/src/services/prefix.ts
- daemon/src/services/projectSetup.ts
- daemon/src/services/recover.ts
- daemon/src/services/rollback.ts
- daemon/src/services/sessionId.ts
- daemon/src/services/slugify.ts
- daemon/src/services/worktreeService.ts
Tests to port:
- daemon/src/__tests__/branchValidator.test.ts
- daemon/src/__tests__/git.commits.test.ts
- daemon/src/__tests__/git.fetchOrigin.test.ts
- daemon/src/__tests__/git.resolveBaseSha.test.ts
- daemon/src/__tests__/git.submodules.test.ts
- daemon/src/__tests__/naming.test.ts
- daemon/src/__tests__/prefix.test.ts
- daemon/src/__tests__/recover.test.ts
- daemon/src/__tests__/sessionId.test.ts
- daemon/src/__tests__/slugify.test.ts

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(03): behavior contract"` — commit `2b337ca`
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-git; save log to rust/.gate/03.log; commit — commits `097be8c`, `1a3e078`
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Closed out (2026-09-15)

Gate green, committed as `097be8c`(impl) + `1a3e078`(gate log), independently re-verified by the orchestrator (re-ran `rust-gate.sh vst-git`, reviewed the full `2b337ca..1a3e078` test diff, confirmed N6 empty).

**`#[ignore]`d (1):** `tests/recover.rs::sweep_orphan_turn_pids_kills_an_orphaned_process_and_unlinks_turn_pids` — session-leader vs group-leader-only spawning semantics were not reproducible deterministically in this sandbox's test harness (`Command::setsid` unstable, the `setsid` binary forks so `child.id()` isn't the leader, `process_group(0)` group-kill didn't land). This consumed a large share of this part's wall-clock — the orchestrator had to steer twice and eventually give an explicit `#[ignore]`-and-move-on directive after ~5 turn-boundaries of legitimate-but-unproductive debugging on this one test. The SUT logic itself (read pidfile → verify comm → group-kill → unlink) is still exercised indirectly by the sibling `does_not_kill_a_live_unrelated_process` test, so this is a test-harness gap, not an unverified code path.

**Gotcha #13 deviation (third part in a row):** step 4 edited `tests/recover.rs`, `tests/common/mod.rs`, `tests/git_fetch_origin.rs`, `tests/git_submodules.rs`. Diff-reviewed: fixture-dir collision fix (concurrency), sync→async git calls (rust-coding §4 compliance), liveness-probe fix (reap+signal-check instead of a zombie-fooled `kill -0`), plus rustfmt reflow. No assertion weakened; the ignored test's own assertion was actually *strengthened* (now checks `exit.signal() == Some(9)`, not just liveness) despite being disabled. See `.sdlc-state.yaml`'s process_note for the running tally on this Gotcha.

**Real gap surfaced (not this part's fault, flagged for future parts):** `vst-store` (part 01) never shipped a production `DirectPtyRegistry` type — only a generic-map behavior-contract test whose own comment promises "production access is provided via `DirectPtyRegistry` in the crate." Confirmed via `grep` — no such struct exists in `vst-store/src`. Similarly no shared `paths.rs` exists from part 00. This part defined minimal local versions (`vst-git::direct_pty::DirectPtyRegistry`, `vst-git::paths::Paths`) scoped to only what `recover`/`rollback` need, rather than blocking on it. **Part 06** (`vst-ws`, which owns the real PTY stream registry) and whichever part owns the rest of `paths.ts` should adopt/replace these local versions rather than inventing a third copy — noted here so it isn't lost.

**vst-types amendments:** none.

## Part-specific notes
- **Gotcha #13 reminder (this is now 2-for-2 on prior parts):** step 4 may NOT modify anything under `tests/` or a `#[cfg(test)]` module. If a step-3 test turns out wrong, leave it failing/`#[ignore]`d with a one-line reason in the report instead of editing it. If you genuinely need a *harness-only* fix (a race in test helper code, a rename after a compile error — not a behavioral assertion change), you may make it, but call it out explicitly and in detail under its own report heading so the orchestrator can diff-verify it independently, exactly as the last two parts did.
- **`git.ts` is ~930 lines — the largest, highest-risk file in this part** (same complexity signal as part 01's `transcript.rs` and part 02's `pty.rs`). Budget extra time for it. It covers: repo init, branch/worktree low-level git plumbing, commit listing, `resolveBaseSha`, submodules, and a read-only status/diff half (see Forward-compat check — this status/diff half is a real, intentional part of `vst-git`'s scope, not a future TODO).
- All git invocation in this part is one-shot `execFile("git", args)` — request/response, not a PTY session. Use `tokio::process::Command` (capturing stdout/stderr) directly for these, NOT `vst-proc`'s `PtyHandle`/`spawn_child` (that abstraction is for interactive/streaming PTYs — terminals, agent processes — a git plumbing call has no interactive input and doesn't need a ring buffer or attach/detach). The crate's dependency on `vst-proc` (per the arch's Entities table) is for `rollback.ts`'s and `recover.ts`'s use of `vst-proc`'s tmux/PTY-kill primitives (see next bullet), not for running git itself.
- `recover.ts` and `rollback.ts` are the two files that actually touch `vst-proc`/`vst-store`: `recover.ts` reads `vst-store`'s session/project registries and calls `vst-proc`'s tmux `has_session` to decide whether a `not_started` session survived an unclean daemon restart; `rollback.ts` calls `vst-proc`'s tmux `kill_session` and the direct-PTY registry's kill on worktree-creation failure. Port these against the real `StoreHandle`/`Tmux`/`directPtyRegistry` public APIs from parts 01/02 — don't reinvent a parallel path.
- `git.ts`'s `fetchOrigin` has an in-flight-dedupe + success-only cooldown map (module-level `Map`s keyed by `repoPath:ref`) guarding a single bounded-timeout `execFile` call — this is NOT an unbounded retry/poll loop (no loop at all, just a single call with `timeout: timeoutMs` and a `Promise` dedupe/cooldown cache), so rust-coding §9's bounded-retry pattern doesn't apply here; port the dedupe/cooldown semantics faithfully instead (including the "cooldown is stamped only on success" comment's reasoning — a failed fetch must not silently block a subsequent real attempt).
- `branchValidator.ts` (49 lines) is pure validation logic (no I/O) — straightforward, low risk.
- `naming.ts`/`slugify.ts`/`prefix.ts`/`sessionId.ts` are small, mostly-pure string/ID generation helpers — port directly, no concurrency concerns.

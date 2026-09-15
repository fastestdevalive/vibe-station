# Phase brief: 01 — storage

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `01-storage`, Entities & Modules row(s) for `vst-store`, Gotchas #3, #4, #14, System Boundaries row(s) `vst-lifecycle ↔ vst-store (session status)`.
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-store
**Depends on (already `done`):** 00-foundation

## Files to port
From file-map.tsv (part 01):
- daemon/src/services/dbMigration.ts
- daemon/src/services/dbSchema.ts
- daemon/src/services/sqliteTranscriptStore.ts
- daemon/src/services/transcriptMigration.ts
- daemon/src/services/transcriptStore.ts
- daemon/src/state/db.ts
- daemon/src/state/directPtyRegistry.ts
- daemon/src/state/orderedListsStore.ts
- daemon/src/state/project-store.ts
- daemon/src/state/sqliteRowMappers.ts
- daemon/src/state/tunnel-store.ts
Tests to port:
- daemon/src/__tests__/dbMigration.test.ts
- daemon/src/__tests__/dbSchema.test.ts
- daemon/src/__tests__/directPtyRegistry.test.ts
- daemon/src/__tests__/orderedListsStore.test.ts
- daemon/src/__tests__/project-store.test.ts
- daemon/src/__tests__/sqliteRowMappers.test.ts
- daemon/src/__tests__/transcriptStore.test.ts
- daemon/src/__tests__/tunnel-store.test.ts

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(01): behavior contract"` — done, commit `bdc7438`
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-store; save log to rust/.gate/01.log; commit
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Part-specific notes
- Gotcha #4: rusqlite is synchronous — do NOT call it directly on tokio worker threads. Wrap synchronous operations using a dedicated worker thread or spawn_blocking, presenting a clean async handle `StoreHandle(Arc<Inner>)` per `docs/DAEMON-RUST-APPSTATE-HANDLES.md`.
- Node-DB compat fixture (F4 requirement): create `rust/vst-store/tests/fixtures/db/node-v<head>.sqlite` and `schema-dump.sql`, verifying that the Rust migration runner opens it as a no-op and produces identical schema.
- Two-axis status model (Gotcha #3): maintain separate setters for lifecycle status and PR status, enforcing single-writer discipline.
- `transcript.rs` merges three TS source files (`transcriptStore.ts` + `sqliteTranscriptStore.ts` + `transcriptMigration.ts`) into ~740 lines — the largest, highest-risk file in this part. Budget extra time for it specifically.

## Resumption — CLOSED OUT (2026-09-15)

Part complete. Gate green, committed as `f354fa3`, re-verified independently by the orchestrator (not just trusting the implementer's own log).

**What the 3 flagged tests turned out to be (correcting the earlier hypothesis below):**
- `manifest_with_null_worktrees_migrates` — fixed: explicit `"worktrees": null` now deserializes as empty (was a strict `Vec` deserialize rejecting `null`, not `#[serde(default)]`'s job).
- `failed_project_retried_once_fixed` / `succeeded_project_not_reprocessed_live_rename_survives` hangs — **not** an unbounded retry loop as suspected below. Root cause: the tests held the `raw_conn()` `MutexGuard<Connection>` across a second `migrate_manifests` call, deadlocking the single `std::sync::Mutex<Connection>` inside `spawn_blocking`. Fixed by scoping the guard. No §9 timeout pattern was needed here — leaving that note below for the historical record, but it did not apply to this bug.

**Additional pre-existing bugs found and fixed while closing this out (not flagged by the original diagnosis):**
- `row_mappers.rs`: `row_to_worktree` collapsed `branch_is_placeholder = false` into `None`; the column is `INTEGER NOT NULL DEFAULT 0` (can't store "absent"), so reads now always yield `Some(bool)`.
- `schema.rs` tests: asserted snake_case column names (`branch_is_placeholder`, `hidden_at`); actual schema uses camelCase per `dbSchema.ts` (`branchIsPlaceholder`, `hiddenAt`) — test names were wrong, fixed.
- `transcript.rs`: JSONL seed's usage event was missing the required `model` field; and `import_transaction` called `Result::and_then` on the rusqlite `Transaction` instead of `.commit()`, so imports silently rolled back and the native watermark never persisted — fixed with an explicit commit.

**Original stuck-session note (superseded, kept for history):** the earlier session spent most of its time hitting the identical `` `stmt` does not live long enough `` rusqlite lifetime error across 8+ methods in `transcript.rs`, fixing each individually. Now documented in `rust-coding` skill §8 — checked in this pass, no remaining occurrences in the crate.

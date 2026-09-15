# Phase brief: 02 — process-pty

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `02-process-pty`, Entities & Modules row for `vst-proc`, Gotchas #1, #6, System Boundaries row `vst-ws ↔ vst-proc (PTY streams)`.
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-proc
**Depends on (already `done`):** 00-foundation

## Files to port
From file-map.tsv (part 02):
- daemon/src/services/childStreams.ts
- daemon/src/services/directPty.ts
- daemon/src/services/resolveUseTmux.ts
- daemon/src/services/shell.ts
- daemon/src/services/tmux.ts
Tests to port:
- daemon/src/__tests__/childStreams.test.ts
- daemon/src/__tests__/directPty.test.ts
- daemon/src/__tests__/resolveUseTmux.test.ts
- daemon/src/__tests__/tmux.listSessionNames.test.ts

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(02): behavior contract"` — commit `5578084`
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-proc; save log to rust/.gate/02.log; commit — commit `a52bcc9`
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Closed out (2026-09-15)

Gate green, committed as `a52bcc9`, independently re-verified by the orchestrator (re-ran `rust-gate.sh vst-proc`, reviewed the full `5578084..a52bcc9` test diff, confirmed N6 empty).

**Gotcha #13 deviation (again — see 01-storage's note too):** step 4 edited `tests/direct_pty.rs` and `tests/tmux.rs`. Diff-reviewed line-by-line: every change is a compile fix (`TmuxSpawnOptions`→`NewSessionOptions` rename) or a test-harness race fix (broadcast-channel "missed close because subscribed late" / "chunk racing the close branch of a `select!`") in helper functions — every `assert!` is byte-identical to the behavior-contract commit. Accepted, not reverted. Two parts in a row have now hit this — the phase-brief warning alone isn't preventing it; a future orchestrator pass may want to consider whether the rule itself needs softening (e.g. explicitly allow test *harness/compile* fixes, forbid only assertion changes) rather than relying on each implementer restating why its violation was fine.

**#[ignore]d:** none. The real-tmux integration test runs directly (tmux present in sandbox), with a `tmux_on_path()` runtime skip for portability.

**vst-types amendments:** none. Crate-local deps added to `vst-proc/Cargo.toml` only: `portable-pty`, `anyhow`, `tracing`.

## Part-specific notes
- **Gotcha #13 — read this before step 4, it was violated (and accepted after review) on part 01:** step 4 may NOT modify anything under `tests/` or a `#[cfg(test)]` module. If a test written in step 3 turns out to encode wrong behavior, do not edit it — leave it failing (or `#[ignore]` it with a one-line reason) and say so explicitly under the report's `#[ignore]`d section. The orchestrator will review and fix the test itself if warranted, not the implementer.
- Public interface target (Entities & Modules row for `vst-proc`): `PtyHandle`, `spawn_tmux`, `spawn_child`, `trait PtyBackend` — design so `vst-agents`' (part 04b) ACP child processes and tmux PTYs share this one abstraction; don't hardcode tmux-only assumptions into the trait.
- System boundary `vst-ws ↔ vst-proc`: the eventual contract is `(connection_id, session_id) -> PtyHandle`, at most one live handle per key. `vst-proc` itself does NOT own that liveness bookkeeping (that's `vst-ws`, part 06) — but `PtyHandle`'s attach/detach API must be shaped so a caller CAN enforce "at most one live handle per key" on top of it (e.g. attach/detach are idempotent and cheap to call defensively, not just "spawn once and hope").
- Gotcha #6: `node-pty` vs `portable-pty` differ in resize/signal/attach-detach semantics — this exact mismatch caused real double-echo/ghost-stream bugs (see `AGENTS.md` § Terminal, § WebSocket — read both). Port the bug *scenarios* described there as explicit Rust tests in this part (e.g. detach-then-reattach not leaving a lingering PTY writer, resize after detach not panicking), not just a happy-path spawn/read/write test.
- Source `directPty.ts` already documents itself as event-driven (`pty.onExit`, not polling) — preserve that; do not introduce a poll loop where the TS original has none.
- No unusually large files in this part (largest is `directPty.ts` at ~300 lines) — no special file-merge risk flagged.

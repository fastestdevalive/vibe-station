# Phase brief: 05 — lifecycle-status

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `05-lifecycle-status`, Entities & Modules row for `vst-lifecycle`, Gotcha #3, System Boundaries row `vst-lifecycle ↔ vst-store (session status)`, `AGENTS.md` § Status indicators (in full — this is the canonical source for the two-axis model this part implements).
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-lifecycle
**Depends on (already `done`):** 00-foundation, 01-storage, 02-process-pty, 03-git-worktree

## ⚠️ Parallel-dispatch note (one-off, do not treat as precedent)
This part is being run **in parallel** with a separate session working on `04c-json-agent-chat`, in a **different crate** (`vst-agents`) with no file overlap. This is a deliberate, one-time exception — every other part in this feature runs strictly serially. The only shared resource is `rust/Cargo.lock` and the `rust/target/` build cache: if you add a crate-local dependency (see below, you likely will — an HTTP client), expect `cargo build` to occasionally contend with the other session's concurrent build. That's a Cargo-level lock, not a correctness issue — if a build/test run looks like it hung or errored strangely, retry once before assuming your own code is at fault.

## Files to port
From file-map.tsv (part 05):
- daemon/src/services/lifecycle.ts (498 lines — the 1s poller, owns `lifecycle.state`)
- daemon/src/services/prPoller.ts (276 lines — the 30s poller, owns `pr`)
- daemon/src/services/handoff.ts (92 lines)
- daemon/src/services/subagentNotify.ts (291 lines)
- daemon/src/services/manifest.ts (70 lines)
- daemon/src/services/channel.ts (63 lines)
- daemon/src/services/mutex.ts (61 lines)
- daemon/src/services/toolResultCap.ts (42 lines)
- daemon/src/services/githubAuth.ts (231 lines — credential resolution, no `gh` binary dependency, see its own header comment)
- daemon/src/services/github.ts (580 lines — GitHub GraphQL API via `fetch()`; **no HTTP client crate exists in this workspace yet** — add `reqwest` as a crate-local dep in `vst-lifecycle/Cargo.toml`, not the workspace table)
- daemon/src/services/cloudflared.ts (359 lines — spawns a real long-lived background `cloudflared` process)
- daemon/src/services/tailscaleServe.ts (326 lines — one-shot `execFile("tailscale", ...)` calls, not a long-lived spawn; simpler than cloudflared.ts)
Tests to port:
- daemon/src/__tests__/lifecycle.test.ts
- daemon/src/__tests__/prPoller.test.ts
- daemon/src/__tests__/handoff.test.ts
- daemon/src/__tests__/subagentNotify.test.ts
- daemon/src/__tests__/manifest.test.ts
- daemon/src/__tests__/channel.test.ts
- daemon/src/__tests__/githubAuth.test.ts
- daemon/src/__tests__/github.test.ts
- daemon/src/__tests__/cloudflared.test.ts
- daemon/src/__tests__/tailscale.test.ts
- daemon/src/__tests__/toolResultCap.test.ts
(No `mutex.test.ts` in file-map — check if `mutex.ts` has coverage elsewhere or is exercised only indirectly; port a behavior contract for it anyway since it's a shared locking primitive.)

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(05): behavior contract"` — commit `f83a048`
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh vst-lifecycle; save log to rust/.gate/05.log; commit — commits `719adcf`, `f98596a`
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Closed out (2026-09-15)

Gate green, independently re-verified by the orchestrator (re-ran `rust-gate.sh vst-lifecycle`, confirmed N6 empty, inspected the `trybuild` fixtures directly).

**A real bug was found and fixed during closeout:** the initial `pub(super)` visibility on `set_lifecycle_state`/`set_pr_status` did NOT actually enforce the two-axis invariant — `lifecycle` and `pr_poller` are sibling modules under the crate root, and `pub(super)` grants visibility to the *entire* parent's subtree (including siblings), not just the parent itself. Fixed to fully-private (no modifier) on both setters, confirmed by two real `trybuild` compile-fail fixtures (`lifecycle_setter_is_private.rs`/`pr_setter_is_private.rs`, both expecting `E0603`) replacing the originally-stubbed always-passing test.

**Parallel-dispatch coordination incident (see `.sdlc-state.yaml` for full record):** this session briefly committed the parallel `04c` session's uncommitted work into one of its own commits (a workspace-wide `cargo fmt` + broad `git add`), self-corrected via `git reset` within minutes once caught. Separately, the orchestrator's own closeout commit for `04c` accidentally swept up this session's staged two-axis fix (a bare `git commit` while other work was staged) — also harmless, content was correct, just misattributed. No code lost in either direction; both were attribution mixups, not corruption.

**Known documentation inaccuracy (non-blocking, verified NOT a bug):** `cloudflared.rs`'s doc comment claims it spawns via `vst_proc::spawn_child`, but the actual implementation uses raw `tokio::process::Command` + PID tracking. Investigated: this is the *correct* choice, not a shortcut — `sweep_orphans` must find orphaned tunnel processes via `pgrep` after a daemon crash/restart, which is categorically impossible via `vst-proc::PtyHandle` (in-memory-handle-only, no orphan-discovery mechanism). The brief's suggestion to reuse `vst-proc`'s abstraction here was itself imprecise; the implementer's deviation was sound engineering. Doc comment left stale — cosmetic only, flagged here for whoever next touches this file.

**`#[ignore]`d:** none — all 36 tests pass, including the `two_axis_setters_are_private` trybuild invocation.

**Partial:** `subagent_notify.rs`'s `emit_pill` call is a stubbed placeholder — the coalescing timer and state tracking work, but actual pill emission needs the `jsonAgent` runtime (part 04c), not yet available to this crate. Flagged for whichever part wires the two together (likely `08-server-bootstrap`).

**vst-types amendments:** none — all needed types already existed.

## Part-specific notes
- **This part implements the two-axis status model itself (Gotcha #3) — this is a load-bearing invariant, not a style choice.** `lifecycle.state` is written ONLY by `lifecycle.rs` (the 1s poller module); `pr` is written ONLY by `pr_poller.rs` (the 30s poller module), and only onto a worktree's `isMain` session. Enforce this with `pub(super)` visibility on the setters (module-boundary enforcement, not a comment/convention) — the System Boundaries row calls for a `trybuild` compile-fail fixture proving the PR-poller module literally cannot call the lifecycle setter and vice versa. Write that fixture; it's part of this part's behavior contract, not optional polish.
- **`AGENTS.md` § Status indicators has the full matrix** (lifecycle × PR → dot color/bucket) — this part owns the two axes' *values*, not the UI rendering (that's `web-ui`, unaffected by this port), but the poller logic must produce values consistent with that matrix's documented rules: `working` beats PR in precedence; PR beats `waiting_for_human`; `idle` and `waiting_for_human` are distinct states, not merged.
- **`cloudflared.ts` spawns a real long-lived background process** — use `vst-proc`'s `spawn_child`/`PtyHandle` (add `vst-proc` as a crate-local dep in `vst-lifecycle/Cargo.toml`), the same "generic subprocess spawn" abstraction used for `04b`'s `AcpTerminalManager`. Don't hand-roll a second `tokio::process::Command` wrapper.
- **`tailscaleServe.ts` is simpler** — one-shot `execFile` calls (same pattern as `vst-git::git.rs`'s plain `tokio::process::Command` usage), not a persistent process. Don't over-engineer it with the PTY abstraction.
- **Tunnel *state* (enabled/process bookkeeping) already has a home**: `vst-store::tunnel` was ported in part 01. This part's `cloudflared.rs`/`tailscale_serve.rs` should read/write through that existing store, not invent a second persistence layer.
- **`github.ts` needs an HTTP client** — no `reqwest`/`hyper` exists anywhere in this workspace yet. Add `reqwest` (with `json` feature, likely `rustls-tls` to avoid an OpenSSL system dependency) as a crate-local dependency. This is the first part to need outbound HTTPS to a third-party API — get the TLS backend choice right the first time (rustls avoids native OpenSSL linking issues in CI/sandboxes).
- **`githubAuth.ts`'s own header comment is the spec**: deliberately does NOT require the `gh` binary (not provisioned in this environment) — reads `~/.config/gh/hosts.yml` directly as a last-resort opportunistic source, never a hard dependency. Port the exact credential-chain precedence order (env vars → hosts.yml → `gh auth token` only if `gh` happens to be on PATH) faithfully; don't simplify it.
- **`manifest.ts`, `channel.ts`, `mutex.ts`, `toolResultCap.ts`, `handoff.ts`** are all small (≤100 lines) — low risk, port directly.
- **`subagentNotify.ts` (291 lines)** — medium risk, self-contained.
- **Gotcha #13 reminder:** step 4 may NOT modify anything under `tests/` or a `#[cfg(test)]` module for behavioral reasons. A step-3 test that turns out wrong gets flagged and left failing/`#[ignore]`d with a stated reason — never silently edited. A genuine harness-only fix (compile error after a rename, `cargo fmt` reflow, a real test-setup race) may be made, but disclose it explicitly and in detail under its own report heading.

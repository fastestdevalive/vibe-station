# Plan: stop tests leaking tmux sessions / shells on the dev machine

Source: `.vibekit/reports/2026-11-06-zsh-tmux-leak.md` (read it first for evidence and file:line refs).

## Problem
`cargo test -p vst-routes` spawns real tmux sessions on the user's DEFAULT tmux server (`Tmux::new()`), e.g.
`create_terminal_defaults_to_tmux` (`rust/vst-routes/tests/sessions_group_b2.rs`, project `p1`), and never kills them
(128 `vst-p1-t-*` sessions + shells leaked). `sessions_group_d.rs` starts a private tmux server with a login shell that
is only killed on a passing test. `vst doctor`'s orphan check only knows the old `vr-*` prefix (`vst-daemon/src/doctor.rs`).

## Changes (one commit; tests + a tiny test-support helper; NO doctor/production behaviour change)
Revised after Opus review (details in that review: 37 test files use `Tmux::new()` - 14 in vst-routes, 23 in vst-daemon).
1. **Shared guard helper** (small `TmuxGuard(String)` with `Drop` -> `Tmux::with_socket(&sock).kill_server()` on THAT
   socket only; socket name prefix `vst-rtest-<pid>-<n>`, distinct from existing `vst-test-*`). Pattern: `review_terminal.rs:166-215`.
   Put it where both vst-routes and vst-daemon tests can use it without new dependency edges (e.g. a `test_support`
   module in `vst-proc`, `#[doc(hidden)]`) - check AGENTS.md's one-way crate graph.
2. **Convert ALL `Tmux::new()` in `rust/*/tests/**` to a private guarded socket.** Do `vst-daemon/tests/doctor_routes_http.rs`
   first. `routes()` helpers return the guard alongside `SessionRoutes` (call sites use struct-update syntax
   `..routes(store)` - keep them compiling; a dropped-immediately guard there is harmless).
3. **`sessions_group_d.rs`**: guard BOTH success-path-only kills (~:767-792 and the `SWITCH_SOCK` site ~:1091/:1160).
4. **terminal_reaper tests**: explicit teardown of `direct_ptys` handles at the end (no `$SHELL` override, no production seam).
5. **Behavioural regression test**: create a terminal on a guarded socket, drop the guard, assert `has-session` fails on that socket.
6. **Guard test**: fails if any file under `rust/*/tests/` calls `Tmux::new()` (after step 2 there should be no allowlist
   beyond the guard test itself).
DROPPED: widening `vst doctor` orphan detection to `vst-*` (it would expose the existing kill route to every live agent
session of a different $HOME; needs ownership tagging - file as a follow-up). `/bin/sh` swap dropped (needs a prod seam).

## Known out of scope (record in the commit message)
Production code that always uses the DEFAULT tmux server regardless of injected `Tmux`: `vst-lifecycle/src/lifecycle.rs:211`,
`handoff.rs:66`, `vst-ws/src/handlers/session_input.rs:77`, `vst-proc/src/pty.rs:591`. A test reaching those still touches the
default server; the grep guard cannot see it.

## Constraints
Never `pkill`/kill by name; tests may only kill their OWN socket's server. Do not touch the user's default tmux
server, the running dev daemon, or existing `vst-*` sessions. Throttle cargo (`nice`, `-j2`; build only the crates touched,
e.g. `cargo test -p vst-routes --test sessions_group_b2` / `-p vst-daemon doctor`). Verify by diffing the SET of default-server session names before/after (the live dev daemon also creates/kills sessions), e.g. that `grep -c '^vst-p1-'` is unchanged.

## Verify
`tmux ls | wc -l` before and after running the touched test files: unchanged. `cargo test` for touched files green.

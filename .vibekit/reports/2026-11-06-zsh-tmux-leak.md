# Report: Why did zsh shells and tmux sessions leak on the dev Mac?

**Date:** 2026-11-06 · **Commit:** HEAD `afe46cb6c` (on disk) · running dev daemon pid 13362 built from `48ce861e3` (last commit before its 2026-11-01 12:13 start) · **Scope:** `rust/vst-proc`, `rust/vst-routes` (src + tests), `rust/vst-daemon/src/doctor.rs`, portable-pty 0.9.0 / filedescriptor 0.8.3 sources, live tmux server, `/tmp/tmux-501`, `~/.vibe-station/vibe-station.db` · **Method:** code reading at both revisions, read-only `tmux ls`/`ps`/`lsof`/`sqlite3 -readonly`. Nothing was killed or edited.

## Answer
- **Confirmed (tmux, 128 sessions, still alive):** a single route test, `create_terminal_defaults_to_tmux` (`rust/vst-routes/tests/sessions_group_b2.rs:1539`), creates a **real** tmux terminal for project `p1` on the developer's **default** tmux server (`Tmux::new()` in the test's `routes()`, `sessions_group_b2.rs:151`) and never kills it. Each `cargo test -p vst-routes` run leaks one `vst-p1-t-<8hex>` session plus one `-zsh` login shell. The same bug is in both the running build and HEAD, and no commit fixes it.
- **Why nothing cleaned them up:** the daemon never sees `p1` (it is not in its store), and `vst doctor`'s orphan check only looks at the legacy `vr-*` prefix (`rust/vst-daemon/src/doctor.rs:292-296`). It reports "No orphan tmux sessions" with 128 orphans present. Same in both builds.
- **426 orphaned interactive zsh (ppid 1): root cause not proven.** The shells are gone, so this rests on correlation. Their ages line up with the same `cargo test` runs. The top suspects are test-spawned shells: direct-pty `$SHELL` terminals (`useTmux:false`) and private-socket tmux servers started with `command: None`. The exact way they survived losing their pty is unconfirmed. Commands to capture it next time are below.

## Evidence
| Claim | Source |
|-------|--------|
| tmux name = `vst-` + session id; id = `<scope>-t-<8hex>`, so `vst-p1-t-*` means a direct terminal in project `p1` | `rust/vst-git/src/session_id.rs:56-70` |
| The test creates a direct terminal in `p1` with the default `useTmux` (true) | `rust/vst-routes/tests/sessions_group_b2.rs:1529-1548` (identical at `48ce861e3`) |
| The test routes use the user's default tmux server | `sessions_group_b2.rs:151` `tmux: vst_proc::tmux::Tmux::new()` |
| `spawn_terminal` runs `tmux new-session` with cwd = `project.absolute_path` (`/repos/p1`, which doesn't exist, so tmux falls back to the server's HOME) | `rust/vst-routes/src/sessions.rs:1480-1499`, `sessions_group_b2.rs:128` |
| It is the only route test that creates a tmux-backed terminal on the default server (the others pass `useTmux:false` or use private sockets) | `$ grep -rn '"terminal"' rust/vst-routes/tests …` → only `sessions_group_b2.rs:1544` without `useTmux` |
| 128 live `vst-p1-t-*` sessions, all `zsh`, cwd `/Users/gb`, on the default socket | `$ tmux ls -F …` → `128 vst-p1`; pane cmd `128 zsh`; cwd `/Users/gb` |
| Server = default socket, started 2026-10-26 20:36 by the real daemon (`new-session -d -s vst-unlauncher-t-886e65b0`) | `$ tmux display -p '#{pid} #{socket_path} #{t:start_time}'` → `96487 /private/tmp/tmux-501/default Mon Oct 26 20:36:24 2026` |
| One leak per `vst-routes` test run: leaked `p1` sessions per day match the `sessions_group_d` private sockets (`vst-test-<pid>`, created once per run) per day | p1/day: `20 39 17 11 3 13 23 2` vs `vst-test-<pid>`/day: `18 36 17 14 3 13 23 2` (Oct 26 to Nov 4) |
| The real daemon itself does not leak tmux: every non-`p1` session maps to a stored record | `$ for n in $(tmux ls …); do sqlite3 … where tmuxName='$n'` → every `vst-*` name resolves (`working`/`waiting_for_human`); `0` rows for `p1` |
| `p1` is not a registered project | `$ sqlite3 … "select id from projects"` (no `p1`) |
| The doctor orphan check is blind to current names | `rust/vst-daemon/src/doctor.rs:292-296` `.filter(\|s\| s.starts_with("vr-"))`; same at `48ce861e3` |
| The daemon never runs `kill-server`; only unit tests on their own sockets do | `$ grep -rn kill-server rust/*/src scripts` → only `vst-proc/src/tmux.rs:300` + `vst-routes/src/sessions.rs` `#[cfg(test)]` (7862+) |
| The tmux server holds no leaked pty masters (139 `ptmx` fds = 139 panes) | `$ lsof -p 96487 \| grep -c ptmx` → `139`; `tmux list-panes -a \| wc -l` → `139` |
| The current pane shells (137 `-zsh`, ppid 96487) were not among the 426 orphans, since those tmux sessions are still alive | `$ ps … awk '$2==96487'` → `137 -zsh`; `ppid==1` zsh now: `0` |
| 566 ≈ 426 orphans + 6 Claude loops + ~134 tmux pane shells | arithmetic against the live `137 -zsh` under 96487 |

## Detail

### H1: test leaks `vst-p1-t-*` onto the real tmux server (CONFIRMED)
- Mechanism: `routes()` → `Tmux::new()` (no `-L`), so `tmux new-session -d -s vst-p1-t-xxxx -c /repos/p1` runs against `/tmp/tmux-501/default`, the same server the dev daemon uses.
- Test teardown drops `SessionRoutes` but nothing calls `kill_session`. tmux sessions outlive the test process by design.
- The leak window starts at 2026-10-26 because that is when the current server started. Earlier leaks (the test dates from `9591503e5`, 2026-09-27) died with earlier servers.
- Cost per leak: one `-zsh` login shell with p10k (plus `gitstatusd` when started), niced 5 because it inherits the tmux server's nice value.
- Running build vs HEAD: **both**. `git show 48ce861e3:…sessions_group_b2.rs` is the same. Later commits `70b29bf0d`, `cc02e4d21` and `88542adc8` don't touch it.
- AGENTS.md's `terminal_reaper.rs` is unrelated. It only reaps `Terminal` rows in the daemon's own store, and these sessions are never in it.

### H2: doctor/boot safety net misses `vst-*` orphans (CONFIRMED, contributing)
- `list_orphan_session_names` only considers `vr-*`, the pre-rename prefix (`doctor.rs:292-296`), while new sessions use `vst-` (`session_id.rs:70`).
- No boot sweep kills unknown `vst-*` sessions. The only listing in `vst-lifecycle/src/lifecycle.rs:215` is for state polling.
- Result: 128 orphans show up as "No orphan tmux sessions". Both builds.

### H3: the 426 orphaned interactive zsh (ppid 1). UNPROVEN, ranked
- Facts from the observation: ppid 1, tty attached, `SN` (niced), interactive with `gitstatusd`, aged 4-5 and 7-10 days. Niced points to the vst/cargo lineage: the daemon and its tmux server run at nice 5 (`ps` NI column), and test runs are niced per the user's own workflow. Terminal.app/iTerm shells are not niced.
- Timing: the age clusters (Oct 27-30, Nov 1-2) match the days with many test runs (Oct 26-28, Oct 31-Nov 1), not daemon restarts. The dev daemon was up continuously since Nov 1 12:13.
- **H3a (most likely): test-spawned interactive shells that never got a hangup.**
  - Direct-pty terminals: `terminal_reaper.rs` creates several `useTmux:false` terminals per run (`terminal_body`, `:330-344`). `spawn_child` runs `$SHELL` (zsh, interactive, so p10k and gitstatusd) in a pty (`sessions.rs:1500-1509`).
  - Private tmux servers with a login shell: `sessions_group_d.rs:767-793` (`command: None`) only calls `kill_server()` on the success path. A failing assertion leaks the server and its `-zsh`. There is no Drop guard, unlike `review_terminal.rs`/`review_http.rs`.
  - Scale: about 3.4 shells per `vst-routes` run × ~126 runs ≈ 426. This is plausible but not counted.
  - Weak point: a dropped `PtyHandle` sends SIGHUP (`vst-proc/src/pty.rs:160-167`; portable-pty sends `SIGHUP`, `lib.rs:327`), and process exit closes the master, which should hang up the shell. Something must have kept the master open or the shell immune. One candidate: portable-pty's `openpty()` → `cloexec()` is non-atomic (`portable-pty-0.9.0/src/unix.rs:40-66`), so a concurrent fork+exec (tmux server start, git) in a parallel test thread can inherit the master. That window is tiny, so it is unlikely to explain hundreds.
- **H3b: real-daemon direct ptys orphaned by `tauri dev`/`concurrently` restarts.** Unlikely. The store has only one non-tmux terminal (`terminal|0|idle|1`), and restarts don't match the age clusters.
- **H3c: tmux server SIGKILL or `kill-server` from scripts.** Not supported. No script or daemon path runs `kill-server` on the default socket, the default server has been up since Oct 26, and private test servers only run commands (`sleep`, `sh -c`), except `sessions_group_d:773`.
- Running build vs HEAD: the test code involved (`terminal_reaper.rs` tests, `sessions_group_d.rs`) is in both. `4659e31ac` (WS socket leak) is in the running build and doesn't touch ptys or shells.

### Unrelated, noted only
- 6 leaked Claude Code `until grep … sleep 5` loops: not vst code.
- Running daemon 13362 has about 300-360 `<defunct>` children at any moment (`ps -axo ppid,stat \| awk '$1==13362 && $2~/Z/'` → 302, 334, 362, 341 across samples). That is a reaping problem, separate from this leak and not investigated.
- `/tmp/tmux-501` has 578 stale socket files from test servers (`vst-test-*` 435, `vst-review-test-*` 36, `vst-rh-test-*`, `b2rev*`). Only one tmux server process is alive, so these are just files, not live servers.

### Proposed minimal fix
1. **Isolate the test** (fixes H1). In `sessions_group_b2.rs`, give `routes()` a per-test tmux socket with a Drop guard. Copy `review_terminal.rs`'s `Env` (`Tmux::with_socket(unique)` + `kill_server()` in `Drop`), or reuse `sessions.rs`'s `#[cfg(test)]` one-socket-per-test pattern (`:7862`). Apply the same fix to the other `routes()` helpers that pass `Tmux::new()` (`sessions_group_{a,c,d}.rs`, `terminal_reaper.rs`, `review_chat.rs`, `projects.rs`, `delete_terminal_delivery.rs`), even where they don't spawn today.
2. **Guard the private-server tests** (H3a). In `sessions_group_d.rs:767`, wrap the socket in a Drop guard so a panic still runs `kill_server`.
3. **Cheaper shells in tests** (H3a). Direct-pty test terminals could set `SHELL=/bin/sh` (or a `command` override) so a leaked shell costs a few KB instead of zsh+p10k+gitstatusd.
4. **Make leaks visible** (H2). `list_orphan_session_names` should also match `vst-` names that aren't in the store. It would then list the 128 `vst-p1-*` sessions with a one-click kill (exact `=name`, per AGENTS.md "Exact targets").

### Regression test ideas
- Process-level guard test: grep `rust/*/tests/**/*.rs` and fail on `Tmux::new()` inside test helpers, in the style of the `comment_holds.rs` guard.
- Behavioural test: run `create_session(type: terminal)` against a guard socket, drop the guard, and assert `tmux -L <sock> has-session` fails. Also assert the default server gained no `vst-p1-*` (before/after `list_session_names()` diff on `Tmux::new()`, read-only).
- Doctor test: seed a store without session `X` and a private tmux server with `vst-X`, then assert `list_orphan_session_names` returns it.

### Confirm H3 next time (before cleanup)
| Command | What it tells you |
|---------|-------------------|
| `ps -axo pid,ppid,pgid,sess,tt,stat,nice,lstart,comm \| awk '$NF ~ /zsh/ && $2==1'` | `-zsh` = tmux login shell (H3a tmux / H3c); `zsh` = direct pty `$SHELL` (H3a direct / H3b) |
| `lsof -p <zsh-pid> \| grep -E 'cwd\|ttys'` | cwd in `/var/folders/…/T/.tmp*` = test tempdir; `/repos/…`→`$HOME` fallback = fake test project |
| `lsof /dev/ttysNNN` (that shell's tty) | Who still holds the pty (master holder = why no SIGHUP) |
| `ps -E -o command= -p <zsh-pid> \| tr ' ' '\n' \| grep -E '^(TMUX\|VST_\|HOME\|CARGO)'` | `TMUX=/private/tmp/tmux-501/vst-test-<pid>` names the exact test server; `CARGO_*` means a test binary ancestor |
| `ls -lT /tmp/tmux-501 \| awk '{print $6,$7}' \| sort \| uniq -c` vs the shells' `lstart` | Per-day correlation with test runs |
| `tmux ls -F '#{session_name} #{t:session_created}' \| grep vst-p1-` | H1 recurrence count (should stay 0 after fix 1) |

## Not checked
- The 426 shells themselves (already killed): no env, cwd or tty-holder data, so H3 is correlation only.
- Did not run any test to count shells spawned per `vst-routes` run, since that would spawn processes. The ~3.4/run figure is inferred, not measured.
- `web-ui` e2e and `vst-cli` e2e suites: grepped only for `"type": "terminal"`; CLI contract tests use a mock server.
- Whether macOS pty hangup is delivered when `CLOCAL` is set, or when the master is inherited by another process (kernel behaviour, not verified).
- The source of the daemon's 300+ zombie children.

## Follow-ups
| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | On the next leak, run the "Confirm H3" commands before killing anything | Turns H3 from correlation into a root cause |
| 2 | Count interactive shells spawned per `cargo test -p vst-routes` (isolated `HOME`, `ps` before/after) | Checks the ~3.4/run × 126 runs ≈ 426 estimate |
| 3 | Clean up the 128 `vst-p1-*` sessions by exact `=name` (user action) | They still hold 128 live `-zsh` + memory now |
| 4 | Investigate the daemon's `<defunct>` children | Separate process-table leak in the running daemon |

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan 03: CLI/Tauri self-healing launch (CUJs 1/2b)

> Replace `preflight()`'s hard-exit-on-daemon-absent with self-healing: launch Tauri if there's a display (reusing `vst open`'s existing launch/poll code, generalized), spawn a headless daemon otherwise (or if Tauri isn't launchable) — no prompt, no lock probe, no version-offer, no install-CLI-in-PATH action. **Scope cut on 2026-09-27** (revision 3) after an Opus scope review found CUJ2a's prompt, CUJ3's version-offer, and CUJ5/6's install-in-PATH action were disproportionate mechanism for the actual requirement — see Superseded.

**Issue:** cli-daemon-unification/03
**Branch:** `release-ci-version` (worktree `vs-194`, no sub-branch)
**Status:** Implementation complete — **revision 3** (scope-cut, see Superseded). All Phase 1-3 checklist items done, full `cargo test -p vst-cli -p vst-daemon -p vst-proc` green.
**PRD:** `../prd-cli-daemon-unification.md` (R10, R11, R13, R31, R44, R46 — R12/R15/R16/R17-R19/R33/R45 cut, see Superseded)
**Arch:** `../arch-cli-daemon-unification.md`
**Depends on:** Part 00 (binary merge, done), Part 01 (headless auth flag, `daemon stop`, done), Part 02 (continue flow, done — **used**: the rev-4 login-URL fix below wires it into the headless self-heal path after all, via `mint_continue_code`/`present_login_url` in `launch.rs`).

---

## Superseded

| Prior approach | Why it failed | Superseded on |
|-----------------|----------------|-----------------|
| Rev 1: "zero references to Tauri-launch detection exist" | False. `rust/vst-cli/src/commands/open.rs::launch_app`/`poll_for_daemon_at`/`poll_for_daemon` already implement CUJ1's exact launch-then-poll-then-retry pattern for `vst open` specifically (10s timeout, best-effort macOS `open -a`/Linux path list) | This revision — **reuse and generalize** this existing code into a shared `launch.rs`, rather than reinventing detection-then-launch from scratch |
| Rev 1: R44's fix scoped to `preflight()`'s own local retry | `preflight()` refreshing its own URL doesn't help — every actual daemon request goes through `client.rs::daemon_request`/`send_message.rs`, both of which independently call `get_daemon_url()` (which re-checks `VST_DAEMON_URL` first) on every single call, not just once at startup | This revision — a process-global override in `daemon_url.rs` that `get_daemon_url()` itself checks first, set once after a successful self-heal, so every subsequent call (not just the retried one) benefits |
| Rev 1: self-heal triggers on any `preflight_with_url` failure | Would spawn a competing daemon for a merely-busy/slow daemon (non-2xx, or a live daemon on a different port than a stale env URL), and `preflight_with_url` has no request timeout, so a hung daemon hangs the CLI forever before self-heal even gets a chance | This revision — self-heal only on connection-refused/no-config (mirrors `open.rs::OpenFailure`'s existing classification), a bounded health-check timeout, and a **non-blocking flock probe** on the daemon lock file to distinguish "truly gone" from "another process is racing to start one right now" |
| Rev 1: `libc::setsid()` alone, called from `vst-cli` | `vst-cli` is `#![forbid(unsafe_code)]` — can't call an `unsafe` FFI function directly; also under-specified stdin handling (inherited stdin would hang a piped caller) | This revision — a `spawn_detached` helper added to `vst-proc` (`#![deny(unsafe_code)]`, the established unsafe-FFI-boundary crate — same precedent as `flock.rs`/`raw_fd_write.rs`), redirecting stdin too, not just stdout/stderr |
| Rev 1: reuse `vst_daemon::env_setup::patch_shell_configs` as-is for CUJ5's PATH wiring | That function only ever adds `$HOME/.vibe-station/bin` (never `~/.local/bin`, which is where "Install CLI in PATH" actually copies the binary), and is gated behind a `.shell-path-installed` sentinel file that every daemon boot already writes — calling it from a fresh CLI-in-PATH action would silently no-op forever on any machine that has ever booted the daemon once | This revision — a new, ungated helper in `env_setup.rs` specifically for the `~/.local/bin` line, reusing the same per-shell `shell_configs()`-style list and exact-line dedup, but with its own marker, not gated behind the daemon-boot sentinel |
| Rev 1: Tauri's version-offer compares `env!("CARGO_PKG_VERSION")` (the `vibe-station-desktop` crate's own `0.0.0`) against the running daemon's `/health` version | Wrong version entirely — the desktop crate's version has nothing to do with the bundled `vst` sidecar's version (the workspace's `0.1.0`, stamped by Part 00/04's version pipeline) | This revision — spawn the bundled `vst --version` and compare that output instead |
| Rev 1: show the version-offer dialog synchronously inside Tauri's `setup()` closure | A blocking dialog before the window exists can deadlock the app on some platforms; `setup()` runs before the window is built | This revision — defer the check+dialog to run via `tauri::async_runtime::spawn` after the window is created |
| Rev 3: `is_interactive()` removed entirely (Decision 4, 1.T3) as unused once the CUJ2a prompt was cut | False in practice — a real gap surfaced immediately after the rev-3 cut shipped: a headless self-heal spawn left a genuine human at a headless terminal with zero way to ever discover the freshly-spawned daemon's web UI (Part 02's continue flow existed but nothing called it). `is_interactive()` was reinstated, but for a **different** purpose than the cut prompt — not "should I ask", but "should I print a URL for a human to read" | Rev 4 — `ensure_daemon_reachable_with_exe` now branches three ways on `has_display()`/`is_interactive()`: display-present-but-Tauri-unlaunchable auto-opens a local browser; no-display-but-a-real-TTY prints the URL; neither, prints nothing (agent/CI). This does **not** reinstate R45 (still cut — no prompt, no "Desktop app" choice) or R16 (Tauri version-offer, still cut) — only the URL-presentation half of the old CUJ2a "Web UI" outcome came back, minus the choice itself. See `rust/vst-cli/src/launch.rs`'s module doc comment for the full reasoning. |
| Rev 3/4: R42 (suppress `daemonToken` print for a headless/self-heal-spawned daemon) silently fell through the gap between Part 01 (which reallocated it here) and this part (which never picked it up) | Found in a final pre-PR review — neither implemented nor documented as cut, just missing. On inspection, cutting it is correct, not an oversight to fix: `~/.vibe-station/logs/daemon.log` is already `0600` (R43, satisfied — same protection `config.json`'s own `cliToken` has, which is equally powerful), and the printed password is currently the **only** fallback once a self-heal-minted continue-flow login link expires (30s) with nobody around to read it in time — suppressing it would remove that fallback with nothing replacing it | Rev 4 — R42 explicitly marked CUT here (not implemented), reasoning captured in `run.rs`'s comment at the print site; the printed login-URL message (found via a human-at-headless-terminal self-heal) now points at this same log file's password as the expired-link fallback |
| Rev 3: `vst open` was left calling its own old bespoke `launch_app()`+`poll_for_daemon()` retry, never migrated onto the shared `ensure_daemon_reachable()` orchestrator this whole part built | Found in a final pre-PR review — `commands/open.rs` discarded `launch_app()`'s return value entirely (no fallback to headless if Tauri wasn't launchable) and `poll_for_daemon()` still trusts a stale `VST_DAEMON_URL` (R44's whole point was to stop exactly this). `vst open` is very likely the single most common self-heal trigger in practice and had none of this part's actual behavior | Rev 4 — `run_open` now calls `crate::launch::ensure_daemon_reachable()` directly, identically to every other command via `preflight` |
| Rev 3: R44's fix only covered *after* a self-heal (the `OnceLock` override); a stale env `VST_DAEMON_URL` failing was unconditionally treated as "self-heal from scratch" | Found in a final pre-PR review — if a daemon is alive on a *different* port than a long-lived agent's stale `VST_DAEMON_URL` (e.g. after a restart), every single command from that agent would re-launch Tauri or open a new browser tab, forever, since the override only lasts one process and the failing env URL always looks identical to "no daemon at all" | Rev 4 — `preflight_scoped` now checks `config.json` directly (bypassing the stale env value) *before* calling `ensure_daemon_reachable()`; if a daemon is already alive there, it just points at it via the same `OnceLock` override, no launch/spawn attempted |
| Rev 4 (release CI, Part 04's territory but caught in the same review pass): the Alpine boot-verification step (`file "$BIN" \| grep -i "statically linked"`) fails on every real run | `rustc`'s `x86_64-unknown-linux-musl` target produces static-**pie** binaries by default; `file`(1) reports those as `static-pie linked`, not `statically linked` — the grep never matches, so `build-cli` fails and `publish-release` never runs at all | Fixed in the same pass — the check now actually boots the daemon inside Alpine and hits `/health`, which is both a real fix for this bug and a more faithful test of what R30 actually asks for ("verifies it boots", not "verifies a `file(1)` string") |

---

## Problem & Concept

- `rust/vst-cli/src/preflight.rs:37-45` (`preflight()`) dies unconditionally with "Daemon is not running. Open the vibe-station app to start it." whenever the daemon is unreachable, for every command except `vst open` (which has its own bespoke launch-and-retry, per Research).
- `rust/vst-cli/src/daemon_url.rs`'s `get_daemon_url()` always re-checks `VST_DAEMON_URL` first (an agent's environment permanently pins this, per `rust/vst-agents/src/context.rs::build_vst_env`) — any self-heal fix that doesn't override this at the `get_daemon_url()` level itself is invisible to every subsequent request.
- No non-blocking way exists today to tell "the daemon is truly gone" apart from "another process just crashed/is racing to start one right now" — Part 01's `flock`-based lock (`rust/vst-daemon/src/lock.rs`) makes a losing racer fail loudly (`acquire_lock` bails), which is correct for the daemon itself, but a self-heal *caller* spawning that racer must not treat its own child's exit as the caller's own failure.
- `desktop/src-tauri/src/daemon.rs::detect_running_daemon` already correctly attaches instead of duplicating (CUJ3's base case, confirmed unchanged) — only the version-compare-and-offer-restart branch is missing.
- No "Install CLI in PATH" action exists anywhere (CUJ5).

---

## Requirements

| ID | Requirement |
|----|-------------|
| R10 | If no daemon is reachable and Tauri is launchable (display present, R11), the CLI launches it and waits for readiness before retrying. |
| R11 | Launchability is platform-specific: Linux uses `$DISPLAY`/`$WAYLAND_DISPLAY`; macOS is presumed to have a GUI session unless `$SSH_CONNECTION`/`$SSH_TTY` is set. |
| R13 | If no display, spawn a headless daemon with no prompt. **(Simplified scope, rev 3: this is now also the outcome when a display IS present but Tauri isn't launchable — see Superseded. There is no longer a prompt at all, so R13's "or not a TTY" clause and R12 in full are moot.)** |
| R31 | Self-healing is skipped for `vst daemon status`, `vst daemon stop`, `vst status`, `vst agent stop`/`terminate` (corrected list — `vst doctor` never calls `preflight()` at all, needs no change). |
| R44 | Self-heal never trusts a stale `VST_DAEMON_URL`; every subsequent request (not just the immediate retry) uses the freshly-written daemon, via a process-global override at the `get_daemon_url()` level. |
| R15 | Tauri launching while a daemon is already running attaches instead of duplicating (already correct — verify, don't re-implement). |
| R32 | Headless is the default for any `vst daemon run` except Tauri-spawned (already implemented — this part's headless spawn (CUJ1-fallback/CUJ2b) relies on that default). |
| R46 | AppImage install failure/unlaunchable falls through to headless like "Tauri not installed" — detected by the launched process exiting within ~2s rather than becoming ready. |

**Cut from this part's scope (rev 3 — see Superseded):** R12 (TTY-gated prompt), R16 (Tauri version-offer), R17-R19 (Install CLI in PATH), R33 (its no-op verification), R45 (macOS "Desktop app" browser-open choice). None of these are being built now; R16/R17-19/R33 have no plan-file home currently (flag for a future part if revived — Part 05's parking note covers R16's natural pairing with an eventual update flow).

---

## Change Map

```
rust/vst-cli/src/
  launch.rs        + self-heal orchestrator: ensure_daemon_reachable(), generalized from open.rs
  platform.rs       + display detection (injectable for tests)
  daemon_url.rs     ~ process-global self-heal override (OnceLock), checked first in get_daemon_url()
  preflight.rs      ~ preflight_scoped(); preflight() calls ensure_daemon_reachable() on connect-refused only
  commands/open.rs  ~ launch_app/poll_for_daemon_at moved to launch.rs (re-exported for compat), timeout 10s -> 30s
  commands/
    daemon/status.rs, daemon/stop.rs, status.rs, agent/stop.rs, agent/terminate.rs  ~ preflight_scoped(Exempt)
  Cargo.toml        ~ + vst-proc dependency (for spawn_detached)
rust/vst-proc/src/
  daemonize.rs      + spawn_detached() -- setsid + fd redirection, #[allow(unsafe_code)]
```

**Cut from the Change Map (rev 3):** `program.rs`'s `InstallCliInPath` command, `commands/install_cli_in_path.rs`, `vst-daemon/src/lock.rs`'s `is_lock_held`, `vst-daemon/src/env_setup.rs`'s `patch_local_bin_path`, and both `desktop/src-tauri/src/{daemon,main}.rs` changes (version-compare + install-in-path command) — none of these are being built in this part anymore.

| Today | After this plan |
|-------|-------------------|
| `preflight()` always dies if no daemon (except `vst open`, which has its own launch-and-retry) | Every command self-heals per CUJ1/CUJ2b via the same shared path `vst open` already pioneered |
| `get_daemon_url()` always trusts `VST_DAEMON_URL` first | A self-heal override wins first, when set |

---

## Research

- `rust/vst-cli/src/commands/open.rs:159-224` — `launch_app()` (macOS: `open -a vibe-station` by registered app name; Linux: tries `/usr/lib/vibe-station/vibe-station`, `/opt/vibe-station/vibe-station`, then `$APPIMAGE` env var), `poll_for_daemon_at()` (500ms poll interval, 1s per-request timeout, configurable total timeout), `poll_for_daemon()` (wraps the above using `get_daemon_url()`). **This is the actual CUJ1 seed — generalize, don't reinvent.** Linux's candidate list needs one more entry: `~/.local/bin/vibe-station` (the launcher symlink `scripts/install.sh:246-286`'s `install_gui_linux` creates for a curl install — not covered by the existing `/usr/lib`/`/opt`/`$APPIMAGE` candidates, which are `.deb`/manually-run-AppImage cases).
- `rust/vst-cli/src/commands/open.rs:99-108` (`OpenFailure` enum) — the exact classification this plan's self-heal trigger reuses: `NoDaemon`/`Connect` → self-heal; `Http {status, message}` → hard error, never self-heal (a non-2xx daemon response means a daemon IS there and answering, just rejecting the request for its own reasons).
- `rust/vst-cli/src/daemon_url.rs:23-42` — `VST_DAEMON_URL` env override wins unconditionally today; a self-heal fix must intercept at `get_daemon_url()` itself (a process-global, e.g. `std::sync::OnceLock<String>`, checked before the env var), since `client.rs::daemon_request` (`:143-152`) and `send_message.rs` both call `get_daemon_url()` independently on every request, not once at CLI startup.
- `rust/vst-agents/src/context.rs:151-183` (`build_vst_env`, post-Part-01) — confirms every agent-spawned child process gets `VST_DAEMON_URL` baked into its env permanently for that process's lifetime; also confirms `VST_TAURI_SUPERVISED` is explicitly stripped (Part 01) — this plan's headless spawn must independently ensure it does NOT set that var (it doesn't, by construction, since `spawn_detached` only sets `["daemon", "run"]` args with no supervised flag).
- `rust/vst-daemon/src/lock.rs` (post-Part-01) — `acquire_lock` now returns `Result<File>`, bails "already running" on `Ok(false)` from `try_lock_exclusive`. A losing self-heal racer's spawned child process exits with this error — the **caller** (the CLI doing the self-healing) must not treat its own child's exit code as its own failure signal; it must keep polling `config.json`/`​/health` until a deadline, since a *different* process may be the one that wins the race and the caller only cares that *some* daemon becomes reachable.
- `rust/vst-proc/src/raw_fd_write.rs`, `rust/vst-proc/src/flock.rs` (Part 01) — the established pattern for adding a new documented `unsafe` FFI helper to this specific crate (`#![deny(unsafe_code)]`, not `forbid`). `spawn_detached` follows the identical shape.
- `rust/vst-cli/Cargo.toml` does not currently depend on `vst-proc` — needs adding for `spawn_detached`.

---

## Architecture Diagram

```mermaid
flowchart TD
    Cmd["vst &lt;cmd&gt;"] --> Scoped{"command is\nself-heal-exempt?\n(R31)"}
    Scoped -->|yes| DieOnAbsent["preflight_scoped(Exempt):\ndie on absent, as today"]
    Scoped -->|no| Check["preflight_with_url\n(bounded timeout)"]
    Check -->|2xx| Proceed["run the command"]
    Check -->|non-2xx| HardErr["hard error -- NOT self-heal\n(a daemon IS answering)"]
    Check -->|connect refused / no config| TauriDetect{"has_display() (R11)?"}
    TauriDetect -->|yes| LaunchTauri["launch_app() + poll\n(CUJ1, 30s)"]
    TauriDetect -->|no| Headless["spawn_detached daemon\n(CUJ2b)"]
    LaunchTauri -->|exits fast\n(&lt;2s, R46)| Headless
    LaunchTauri -->|ready| SetOverride["set daemon_url override\n(R44) -- process-global"]
    Headless --> SetOverride
    SetOverride --> Proceed
```

**Cut (rev 3):** the lock-probe branch and the CUJ2a interactive prompt — see Superseded. A Tauri-launch failure (fast exit) now falls straight through to the headless spawn, no branch on TTY/interactivity at all.

---

## Design Details

### Critical User Journeys (CUJs)

**CUJ1 — daemon absent, Tauri installed, launchable:**
```
vst agent ls (no daemon, has display)
  → launch_app() (generalized from open.rs, +~/.local/bin candidate)
  → poll /health for up to 30s
  → if the launched process itself exits within ~2s (R46): treat as "not
    actually launchable", fall through to the headless spawn (CUJ2b)
  → on ready: set the process-global daemon_url override (R44), retry
```

**CUJ2b — daemon absent, no display, OR Tauri not launchable (agents, CI, no-GUI machines, or a display present but Tauri missing/broken):**
```
→ no prompt -- spawn_detached() a headless daemon directly, retry
```

**Error path — self-heal itself fails (Tauri launch times out with no exit, headless spawn fails to bind):**
```
→ falls through to the existing preflight() die() message -- self-heal
  degrades to today's behavior, never a worse/different error
```

**Error path — self-heal races another self-healing process:**
```
Two agents' `vst agent ls` calls both find the daemon absent at the same
instant
  → both attempt spawn_detached() (no lock probe -- cut in rev 3, see
    Superseded)
  → one wins the flock (Part 01), the other's spawned child exits
    immediately with "already running" -- the LOSING CLI caller does not
    treat this as ITS OWN failure; it polls config.json/​/health regardless
    of whether ITS OWN spawn attempt's child is still alive, until the
    winner's daemon becomes reachable or the deadline elapses
```

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|------------------|--------|-------------------|
| CLI ↔ Tauri process | `launch_app()` (best-effort spawn, ignores errors), poll `/health` | Launched process exits within ~2s (R46) → not launchable, fall through; 30s poll timeout with no exit → `die()` (Tauri IS running but never became ready — a different, real problem, not "not installed") | CLI |
| CLI ↔ headless daemon (spawn) | `vst_proc::spawn_detached(exe, ["daemon", "run"], cwd=$HOME, env=stripped)`, log at `~/.vibe-station/daemon.log` (0600) | Bind failure inside the daemon → same boot error as today, surfaced via the log file, not the spawning CLI's stdout | CLI |
| CLI ↔ `daemon_url` override | Process-global `OnceLock<String>`, set once per process after a successful self-heal | n/a (infallible set) | `daemon_url.rs` |

### Key Decisions

#### Decision 1: Generalize `open.rs`'s existing launch/poll code, don't duplicate it
- **Decision:** Move `launch_app`, `poll_for_daemon_at`, `poll_for_daemon` from `commands/open.rs` into a new `launch.rs` module; `open.rs` re-imports them (no behavior change for `vst open` itself, except its own timeout constant moves from a local `10_000` to the shared 30s ceiling for consistency). Extend `launch_app`'s Linux candidate list with `~/.local/bin/vibe-station`.
- **Rationale:** Found in review — this code already exists and already works for `vst open`; Rev 1's "detect a Tauri install path, then launch" design would have been a parallel, divergent implementation of the same job.
- **Where:** `rust/vst-cli/src/launch.rs` (new), `rust/vst-cli/src/commands/open.rs` (functions moved out, call sites updated).

#### Decision 2: Self-heal trigger — connection-refused only, with a bounded timeout
- **Decision:** `preflight_scoped(Normal)` classifies its own health-check failure the same way `open.rs::post_open_at` already classifies `/open` failures (`OpenFailure`-style: connect-refused/no-config → self-heal; non-2xx → hard error, no self-heal). `preflight_with_url`'s underlying `reqwest` call gains an explicit `.timeout(Duration::from_secs(3))` (currently unbounded — a hung-but-listening daemon would otherwise block forever before self-heal gets a chance).
- **Rationale:** Found in review — self-healing on a non-2xx response would spawn a competing daemon next to one that's alive and simply rejecting a request for its own reasons; an unbounded health check would hang the CLI before self-heal is even attempted.
- **Cut in rev 3 (scope review):** a non-blocking `flock` probe (`is_lock_held`) to distinguish "daemon truly gone" from "another process is racing to start one." **Why it's unnecessary:** the losing racer's spawned child exits immediately with "already running" regardless of whether a probe warned about it in advance — the caller's own polling loop (which must exist either way, to wait for whichever process wins) behaves identically whether or not it checked first. The probe added a whole new kernel-level primitive (`vst_daemon::lock::is_lock_held`) to save nothing: both branches converge on the same "poll until ready or deadline" code.
- **Where:** `rust/vst-cli/src/preflight.rs`.

#### Decision 3: R44's fix is a process-global override at `get_daemon_url()`, not a per-call retry — and polling must bypass the stale env var too
- **Decision:** `daemon_url.rs` gains `static SELF_HEAL_OVERRIDE: OnceLock<String> = OnceLock::new();` and `pub fn set_self_heal_override(url: String)`. The override check is added to `get_daemon_url_from_home` (**not** `get_daemon_url_from_home_and_env`, which stays pure/unaffected by process-global state — found in review: polluting the pure function makes its own unit tests order-dependent within the same test binary) — `get_daemon_url_from_home` checks `SELF_HEAL_OVERRIDE.get()` first, before calling `get_daemon_url_from_home_and_env` with the real `VST_DAEMON_URL` env value. **Critically**, the self-heal polling loop itself (`launch.rs`'s reuse of `poll_for_daemon`, Decision 1) must poll using `get_daemon_url_from_home_and_env(home, None)` — explicitly passing `None` for the env override, i.e. config.json only — never the ordinary `get_daemon_url()`/`poll_for_daemon()` which would keep re-checking the same stale `VST_DAEMON_URL` on every poll iteration and could poll a dead port forever. Once that config-only poll succeeds, call `set_self_heal_override` with the URL it found — only then do ordinary `get_daemon_url()` calls (used by every actual request from here on) see the fresh value.
- **Rationale:** Found in review (two passes) — every daemon request (`client.rs::daemon_request`, `send_message.rs`) independently calls `get_daemon_url()`, so fixing only `preflight()`'s own local variable does nothing for them; separately, if the *polling loop itself* still consults `VST_DAEMON_URL`, an agent with a stale env value never sees the self-heal succeed at all, since it keeps polling the wrong port.
- **Where:** `rust/vst-cli/src/daemon_url.rs` (override lives in `get_daemon_url_from_home`), `rust/vst-cli/src/launch.rs` (polling calls the env-bypassing variant explicitly).

#### Decision 4: Platform detection is `has_display()` only — no `is_interactive()`
- **Decision:** `platform::has_display() -> bool` per R11's split — Linux checks `$DISPLAY`/`$WAYLAND_DISPLAY`; macOS presumes a GUI session unless `$SSH_CONNECTION`/`$SSH_TTY` is set. **Testability fix (found in review):** expose a `has_display_for(is_macos: bool, env: &dyn EnvLookup)` core function taking the OS-check result and an injectable env-var reader, with `has_display()` a thin `cfg!(target_os)`-based wrapper — makes the logic unit-testable without needing to fake `cfg!` itself.
- **Cut in rev 3 (scope review):** `is_interactive()` (an `IsTerminal`-based TTY check) — it existed solely to gate the now-cut CUJ2a prompt (R12). With no prompt, there's nothing left for it to gate; removed rather than kept as unused/speculative API.
- **Rationale:** Same as rev 1/2 for `has_display()` — R11's split remains correct; only the testability shape changes. `is_interactive()` fails this plan's own "don't add speculative code" standard once its one caller is gone.
- **Where:** `rust/vst-cli/src/platform.rs`.

#### Decision 5: `spawn_detached` lives in `vst-proc`, redirects all three std fds, no double-fork needed
- **Decision:** `vst_proc::daemonize::spawn_detached(exe: &Path, args: &[&str], cwd: &Path, env: &HashMap<String, String>, log_path: &Path) -> io::Result<()>` — opens `log_path` with `create + append + mode 0600` (set explicitly via `OpenOptionsExt::mode`, which only takes effect on creation — if the file already exists from a prior run, `chmod` it explicitly too, don't assume the mode persists correctly across runs), redirects **stdin to `/dev/null`, stdout AND stderr** to that file, sets `.current_dir(cwd)`, `.envs(env)` (a caller-supplied, already-stripped map — see Decision 6), and `unsafe { .pre_exec(|| { libc::setsid(); Ok(()) }) }` before `.spawn()`. No double-fork: the CLI never `wait()`s on the child, so when the CLI process exits the daemon is reparented to init/launchd — `setsid()` alone is sufficient because the daemon (via `portable-pty`'s `openpty`, opened with `O_NOCTTY`) never acquires a controlling terminal on its own.
- **Rationale:** Found in review — inherited stdin would hang a piped caller (`vst agent ls | ...`) forever; `unsafe` FFI can't live in `vst-cli` (`forbid`); a double-fork is unnecessary complexity for this specific case (no controlling-tty risk, no zombie-reaping need since the parent never waits).
- **Where:** `rust/vst-proc/src/daemonize.rs` (new), `rust/vst-cli/Cargo.toml` (add `vst-proc` dependency).

#### Decision 6: Headless spawn strips agent-specific env vars
- **Decision:** Before calling `spawn_detached`, the caller builds its `env` map by cloning `std::env::vars()` and explicitly removing `VST_SESSION`, `VST_SPAWN_TOKEN`, `VST_PROJECT`, `VST_WORKTREE`, `VST_DATA_DIR`, and `VST_DAEMON_URL` (in addition to `VST_TAURI_SUPERVISED` already never being set here by construction).
- **Rationale:** Found in review — a self-heal triggered from inside an agent process would otherwise leak that agent's own session-scoped identity into the freshly-spawned daemon's environment, and its own stale `VST_DAEMON_URL` would be nonsensical for a process that's about to bind a fresh port.
- **Where:** `rust/vst-cli/src/launch.rs`.

#### Decision 7: R46's "launch failed" detection is platform-specific — `open`'s own exit code on macOS, the child process's early exit on Linux
- **Decision:** `launch_app()` is changed to return a `LaunchOutcome { Failed, Launched }` (found in review: the original design's "watch the launched process's own PID for ~2s" doesn't work on macOS at all — `open -a vibe-station` is a short-lived launcher-services shim that hands off and exits almost immediately *even on success*, so a 2s-exit check would misclassify every successful macOS launch as "failed"). Platform split:
  - **macOS:** `open -a vibe-station`'s own exit **status** is the signal — `open` returns non-zero when the named app can't be found/launched at all (e.g. not installed), and `0` when it successfully handed off to Launch Services (regardless of how long the app itself then takes to become ready). `LaunchOutcome::Failed` iff `open`'s exit code is non-zero.
  - **Linux:** the actual app binary/AppImage/launcher-symlink is spawned directly (not through an intermediary like `open`) — keep the child `Child` handle (previously discarded) and check whether *it* has exited within ~2s of spawning. `LaunchOutcome::Failed` iff the child exits in that window.
  - Either way, `LaunchOutcome::Failed` → treat identically to "Tauri not installed," fall through to the interactive/headless branch. `LaunchOutcome::Launched` but `/health` never becomes ready within the full 30s → a **different** failure (Tauri is running but broken) → `die()` with a distinct message, never silently fall through to spawning a second, competing daemon underneath a Tauri that might still be mid-boot.
- **Rationale:** Found in review, twice — the original single exit-check heuristic would have broken every macOS CUJ1 launch (misclassifying success as failure) while separately still risking a race against a slow-but-legitimately-booting Tauri if timeouts were treated the same as fast-exits.
- **Where:** `rust/vst-cli/src/launch.rs` (`launch_app` return type change, platform-specific check).

**Decisions 8-10 (Install-CLI-in-PATH helper, Tauri version-offer, CUJ2a prompt OS-scoping) are cut entirely as of rev 3** — see Superseded and the trimmed Requirements/Change Map above. Their design reasoning is preserved in this plan's git history (rev 2 commit) if the underlying features are ever revived, but none of it applies to this part's current scope.

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | macOS Tauri-detection/launch path is unverified | No macOS hardware available — `launch_app()`'s existing `open -a vibe-station` (by registered app name, not a hardcoded path) is the established mechanism; this plan does not change it, only extends the Linux candidate list. Real macOS testing still needed before shipping, called out explicitly, not silently assumed correct. |
| 2 | Musl (Alpine/CI) builds never reach the Tauri-launch branch at all | Correct, by construction — `has_display()` is false in essentially every musl/CI context, so CUJ2b's headless path is what actually runs there; no musl-specific code needed. |

**Cut in rev 3:** Risk #2 above ("`.deb` postinst PATH registration") — it only mattered for the now-cut R18 no-op check.

---

## Implementation Phases

### Phase 1: Platform detection — **[x] DONE**

- [x] **1.1** Create `rust/vst-cli/src/platform.rs`: `has_display() -> bool`, plus testable core (`has_display_for(...)`) per Key Decision 4. (`is_interactive()` cut in rev 3 — not implemented.)
- [x] **1.2** Add `pub mod platform;` to `rust/vst-cli/src/lib.rs`.

**Verify phase 1:**
- [x] **1.T1** Unit — `has_display_for` (Linux mode): `DISPLAY` set → `true`; both unset → `false`.
- [x] **1.T2** Unit — `has_display_for` (macOS mode): neither `SSH_CONNECTION` nor `SSH_TTY` set → `true`; either set → `false`.
- [x] **1.T3** (cut, no longer applicable — `is_interactive()` removed.)

### Phase 2: Generalize launch/poll + R44 override — **mostly done, needs rev-3 cleanup**

- [x] **2.1** Move `launch_app`, `poll_for_daemon_at`, `poll_for_daemon` from `commands/open.rs` to new `rust/vst-cli/src/launch.rs`; `open.rs` re-exports them; extended `launch_app`'s Linux candidates with `~/.local/bin/vibe-station`; extended the shared timeout constant to 30s. `launch_app`'s return type is `LaunchOutcome { Failed, Launched }` per Decision 7 (macOS: `open`'s own exit status; Linux: the spawned `Child`'s early-exit check).
- [x] **2.2** ~~Add `is_lock_held` to `lock.rs`~~ — **CUT (rev 3), reverted.** `is_lock_held` and its tests removed from `rust/vst-daemon/src/lock.rs` (commit e9268079).
- [x] **2.3** Add `SELF_HEAL_OVERRIDE: OnceLock<String>` + `set_self_heal_override`, checked first in `get_daemon_url_from_home` (not the pure `_and_env` variant) — done, per Key Decision 3.
- [x] **2.4** Add `.timeout(Duration::from_secs(3))` to `preflight_with_url_classified`'s `reqwest` call.
- [x] **2.5** Add `vst-proc = { workspace = true }` to `rust/vst-cli/Cargo.toml`.
- [x] **2.6** Create `rust/vst-proc/src/daemonize.rs` (`spawn_detached`) per Key Decision 5; `pub mod daemonize;` + re-export in `rust/vst-proc/src/lib.rs`.
- [x] **2.7 (new, rev 3 cleanup)** Removed `patch_local_bin_path` + `local_bin_shell_configs` + `LOCAL_BIN_PATH_MARKER` from `rust/vst-daemon/src/env_setup.rs` (commit e9268079).

**Verify phase 2:**
- [x] **2.T1** ~~`is_lock_held` unit tests~~ — **CUT**, removed along with the fn (commit e9268079).
- [x] **2.T2** Unit — `get_daemon_url_from_home` with `SELF_HEAL_OVERRIDE` set: returns the override even when `VST_DAEMON_URL` env is also set to a different value (implemented as `test_daemon_url_self_heal_override_wins_over_stale_env_var`).
- [x] **2.T3** Integration — `spawn_detached`: spawns a process confirmed still alive after the calling test function's own scope ends (proves detachment). Implemented as `spawned_process_survives_after_the_spawning_scope_ends` in `rust/vst-proc/tests/daemonize.rs`.
- [x] **2.T4** Integration — `spawn_detached` with an explicit `env` map: the spawned process's environment contains ONLY what's passed (`env_clear()` verified — no leakage of the test process's own env, including cargo's build-time vars). Implemented as `spawned_process_environment_excludes_stripped_vars` in `rust/vst-proc/tests/daemonize.rs`.

### Phase 3: Self-heal orchestrator (CUJ1, CUJ2b, R31) — **written, needs rev-3 simplification + tests**

- [x] **3.1 (revise)** `ensure_daemon_reachable()` simplified to the no-prompt, no-lock-probe design (done in commit e9268079). Testability: `ensure_daemon_reachable_with_exe`/`spawn_headless_daemon_with_exe` added as exe-injectable cores, with the zero-arg public fns as thin `current_exe()`-resolving wrappers (commit 2c86ed55).
- [x] **3.2** `rust/vst-cli/src/preflight.rs`: `preflight_scoped(PreflightScope)`, `preflight()` stays the zero-arg `Normal` default; on connect-refused/no-config, calls `ensure_daemon_reachable()`; on success, retries once; on any other failure path, unchanged `die()`. Done.
- [x] **3.3** All 5 exempt call sites updated to call `preflight_scoped(PreflightScope::Exempt)` (commit 2c86ed55).

**Verify phase 3:**
- [x] **3.T1** Integration — `ensure_daemon_reachable_with_exe(CARGO_BIN_EXE_vst)`, no display, no Tauri: spawns a headless daemon in a temp `HOME`, `/health` becomes reachable. Implemented as `ensure_daemon_reachable_spawns_a_headless_daemon_when_none_exists` in `rust/vst-cli/tests/self_heal.rs`.
- [x] **3.T2** Integration — `preflight_scoped(Exempt)` dies within <5s on an absent daemon (never the ~30s self-heal ceiling) and never creates `daemon.log` (proving no spawn attempt). Implemented as `preflight_exempt_dies_fast_without_attempting_self_heal` in `rust/vst-cli/tests/self_heal.rs` (subprocess test — `die()` is a hard `process::exit`, can't be tested in-process).
- [x] **3.T3** Two concurrent `ensure_daemon_reachable_with_exe` calls both succeed and converge on exactly one daemon (single `pid` in `config.json`), regardless of which one's own spawn attempt won Part 01's flock race. Implemented as `two_concurrent_self_heals_converge_on_one_daemon` in `rust/vst-cli/tests/self_heal.rs`.

**Phases 4 (CUJ2a prompt), 5 (Tauri version-offer), 6 (Install CLI in PATH) are CUT entirely — see Superseded and the trimmed Requirements above. Not implemented, not planned for this part.**

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `rust/vst-cli/src/platform.rs` | New — done | 1.1 | Contract: `has_display() -> bool` (+ testable core). No `is_interactive()`. |
| `rust/vst-cli/src/lib.rs` | Modified — done | 1.2 | `+ pub mod platform;`, `+ pub mod launch;` |
| `rust/vst-cli/src/launch.rs` | New — needs rev-3 trim | 2.1, 3.1 | Contract: `ensure_daemon_reachable()`, `PreflightScope`, `launch_app`/`poll_for_daemon_at` (moved from `open.rs`) — remove the prompt/lock-probe branches |
| `rust/vst-cli/src/commands/open.rs` | Modified — done | 2.1 | Launch/poll fns moved out, re-exported |
| `rust/vst-daemon/src/lock.rs` | Modified — **needs revert** | 2.2 | Remove `is_lock_held` (cut) |
| `rust/vst-daemon/src/env_setup.rs` | Modified — **needs revert** | 2.7 | Remove `patch_local_bin_path` (cut) |
| `rust/vst-cli/src/daemon_url.rs` | Modified — done | 2.3 | `+ SELF_HEAL_OVERRIDE`, `set_self_heal_override` |
| `rust/vst-cli/src/preflight.rs` | Modified — done | 2.4, 3.2 | Bounded timeout; `preflight_scoped()` |
| `rust/vst-cli/Cargo.toml` | Modified — done | 2.5 | `+ vst-proc` dependency |
| `rust/vst-proc/src/daemonize.rs` | New — done | 2.6 | Contract: `spawn_detached(...) -> io::Result<()>` |
| `rust/vst-proc/src/lib.rs` | Modified — done | 2.6 | `+ pub mod daemonize;` |
| `rust/vst-cli/src/commands/daemon/status.rs` | Modified — **pending** | 3.3 | `preflight_scoped(Exempt)` |
| `rust/vst-cli/src/commands/daemon/stop.rs` | Modified — **pending** | 3.3 | `preflight_scoped(Exempt)` |
| `rust/vst-cli/src/commands/status.rs` | Modified — **pending** | 3.3 | `preflight_scoped(Exempt)` |
| `rust/vst-cli/src/commands/agent/stop.rs` | Modified — **pending** | 3.3 | `preflight_scoped(Exempt)` |
| `rust/vst-cli/src/commands/agent/terminate.rs` | Modified — **pending** | 3.3 | `preflight_scoped(Exempt)` |

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Arch: CLI/Daemon Unification, Install, and Update

> Merge `vst`+`vst-daemon` into one self-sufficient binary, then build every install/launch/auth/update behavior that depends on that merge existing.

**Issue:** cli-daemon-unification
**Branch:** `release-ci-version` (working directly, no sub-branch — worktree `vs-194`)
**Status:** WIP — revision 3, post Opus review + verification pass
**PRD:** `.vibekit/feature-plans/pending/cli-daemon-unification/prd-cli-daemon-unification.md`

**Parts spawned from this arch:**
- [x] `00-binary-merge/plan-00-cli-daemon-unification-binary-merge.md` — merge `vst`/`vst-daemon` into one binary, embed web UI, stamp version
- [x] `01-daemon-lifecycle/plan-01-cli-daemon-unification-daemon-lifecycle.md` — flock-based lock fix, `daemon stop`, headless auth
- [x] `02-continue-flow/plan-02-cli-daemon-unification-continue-flow.md` — browser "continue" flow (CUJ4)
- [x] `03-cuj-detection-launch/plan-03-cli-daemon-unification-cuj-detection-launch.md` — CLI self-healing (CUJ1/CUJ2b only, rev-3 scope-cut — see that plan's Superseded table)
- [x] `04-curl-installer/plan-04-cli-daemon-unification-curl-installer.md` — curl installer overhaul + release CI
- [ ] `05-vst-update/plan-05-cli-daemon-unification-vst-update.md` — **PARKED (2026-09-27)**, see `.sdlc-state.yaml`'s `parked_reason` — out of active scope, not being built now

---

## Superseded

| Prior approach | Why it failed | Superseded on |
|-----------------|----------------|-----------------|
| Rev 1: headless-auth flag/gate designed as a `vst_routes` module reading `&AppState` | `AppState` and `auth_middleware` both live in `rust/vst-daemon/src/server.rs`; `vst-daemon` depends on `vst-routes`, so a `vst-routes` fn taking `&AppState` (a `vst-daemon` type) is a dependency cycle | This revision — moved into `vst-daemon/src/server.rs` alongside the existing `no_auth` flag it mirrors |
| Rev 1: per-daemon-instance agent shim (a new "instance dir" concept) | Once R20 (flock-based lock) guarantees only one daemon can ever hold the lock, "whichever daemon booted last wins" is moot — there's only ever one. A per-instance dir would instead *break* tmux agents that outlive a daemon restart, since their `PATH` (`rust/vst-agents/src/context.rs`) would point at a dead directory | This revision — R5 now just requires the existing stable shim path to be correctly rewritten on every boot, which R20 already guarantees is meaningful |
| Rev 1: PID-liveness fix via `kill(pid, 0)` alone, for the **daemon's own startup lock** (`rust/vst-daemon/src/lock.rs`) | Same TOCTOU as the original `/proc` check, just less platform-specific: two concurrent starters can both pass the liveness check and both take over the lock; also doesn't solve PID reuse (a dead daemon's PID reassigned to an unrelated live process reads as "still running" forever) | This revision — `flock(2)` advisory lock, held for the life of the process, released by the kernel on any exit including a crash. **Scope note:** this fix applies only to `lock.rs`'s own startup lock (used when a second `vst-daemon`/`vst daemon run` process tries to start directly) — Tauri's separate `detect_running_daemon()` check (`desktop/src-tauri/src/daemon.rs:48-51`, `kill(pid, 0)`) is a different mechanism solving a different problem (attach-vs-spawn from a GUI process, not mutual exclusion between two daemon processes) and is left unchanged. Both share the same theoretical PID-reuse weakness, but only the daemon's own lock is a *correctness* bug (it decides whether `config.json` gets clobbered); Tauri's check merely decides attach-vs-spawn, and a wrong answer there just means an extra sidecar gets spawned, not data corruption — out of scope for this fix. |
| Rev 1: client-side (webview) GitHub releases fetch for the UI banner | Tauri's CSP `connect-src` only allows `127.0.0.1`; a direct `fetch("api.github.com/...")` from the webview is blocked outright | This revision — daemon-side cached `update_status` endpoint is the only GitHub caller whenever a daemon exists; the UI always polls the daemon, never GitHub directly. The CLI also prefers asking the daemon over calling GitHub itself, falling back to its own direct (separately cached) GitHub call only when no daemon is reachable at all — see System Boundaries table |
| Rev 2: CUJ2a-spawned daemon modeled as "attended, keeps loopback trust" | Contradicted `docs/CLI-DAEMON-TAURI-CUJS.md`'s own CUJ2a sequence diagram, which explicitly spawns `vst daemon run (headless)` and mints a browser code for this exact branch — a misreading introduced while fixing rev 1's other headless-detection issue (B1) | Rev 3 — CUJ2a is headless like CUJ2b; only a Tauri-sidecar-spawned daemon is non-headless (PRD R32) |
| Rev 1: "Install CLI in PATH" symlinks the bundled binary | An AppImage's sidecar lives inside an ephemeral squashfs mount that only exists while the app runs; a macOS `.app` may be App-Translocated to a random read-only path. Both make a symlink dangle | This revision — copies the binary into `~/.local/bin` instead |
| Rev 1: `vst update`'s "update the Tauri copy" patches the sidecar binary inside the existing signed `.app` | Breaks the bundle's code-signature seal (macOS reports the app "damaged"); leaves a stale SPA/`web-ui/dist` resource paired with a newer daemon | This revision — downloads the new `.dmg`/`.AppImage` and replaces the whole app bundle, after confirming the app is quit |

---

## Problem

- `vst` (CLI) and `vst-daemon` are two separate binaries/sidecars with no shared identity; Tauri bundles both plus `cloudflared` and `agy-acp` (4 sidecars total, `desktop/src-tauri/tauri.conf.json:42`).
- `scripts/install.sh` refuses macOS outright (comment block, `scripts/install.sh:19-23`) and nothing publishes the `vst-<triple>.tar.gz` asset it already expects to consume (`scripts/install.sh:222`) — confirmed zero release-publishing workflow exists (`.github/workflows/` has only `desktop-build.yml` and `rust-ci.yml`, neither uploads to a GitHub Release; `desktop-build.yml` has no tag trigger).
- `rust/vst-cli/src/preflight.rs:43` dies with "Open the vibe-station app to start it" on any daemon-absent CLI invocation — no self-healing for any of the documented CUJs.
- `rust/vst-daemon/src/lock.rs:12-17`'s `pid_is_alive` checks `/proc/<pid>` existence — always `false` on macOS, so a live macOS daemon looks dead to its own lock and a second one can start and clobber `config.json`. Even the more portable `kill(pid,0)` fix considered in rev 1 is a TOCTOU race under concurrent starts and is fooled by PID reuse — needs `flock(2)`, not a liveness probe.
- `rust/vst-daemon/src/server.rs`'s loopback-trust bypass has no headless/unattended-mode gate on **either** copy of the check — the HTTP path (`:905-909`) or its independent WS-upgrade duplicate (`:1059-1064`) — any local process on a shared/CI box is trusted with zero token check.
- No `vst update` command exists; no version-check code exists anywhere in `rust/vst-cli`; there is no version pipeline at all — the workspace `Cargo.toml` reports `0.1.0`, Tauri reports `0.0.0`, and only `-beta` git tags exist, so `/health`'s `version` field and any comparison against it are currently meaningless.
- A curl-only daemon cannot serve the web UI: `web-ui/dist` is shipped only as a Tauri `bundle.resources` entry, never embedded in or alongside the daemon binary; `handle_fallback`'s SPA-serving path 404s with nothing to serve. This silently breaks CUJ2a/2b's entire "Web UI" branch unless fixed as part of the merge.

## Out of Scope

- Windows (install matrix and CUJ docs are macOS/Linux only).
- systemd/launchd supervised-service story beyond today's spawn-once daemon lifecycle.
- Per-agent scoped tokens (`docs/CLI-DAEMON-TAURI-CUJS.md`'s token table marks this `deferred`).
- Update channels/cadence, rollback story (`docs/UPGRADE-IDEAS.md` "Explicitly not decided here").
- Auto-update without an explicit `vst update` invocation.
- Feature parity for curl-only daemons on cloudflared/agy-acp/Claude-ACP (sidecar/vendored-asset gaps) — `vst doctor` reports the gap; closing it is future work.
- Real macOS Gatekeeper/quarantine/notarization verification — no macOS hardware available for this session's Docker-based verification pass; every macOS-only CUJ is called out explicitly as unverified here, not silently skipped.

---

## Requirements

See `prd-cli-daemon-unification.md` §§1-7 (R1-R40) — this arch does not restate them.

### Non-functional

| # | Requirement | Target |
|---|-------------|--------|
| N1 | Merged binary size, post-embed | Document the actual delta once `web-ui/dist` (R28) is embedded — the naive "≤ sum of today's two binaries" target from rev 1 does not account for embedding the SPA and is dropped; report the real number in Part 00's plan instead of pre-committing to one |
| N2 | Daemon-absent CLI self-heal latency | Matches existing 30s sidecar-ready timeout (`desktop/src-tauri/src/daemon.rs:180`) as the ceiling for CUJ1/2b spawns |
| N3 | Headless-mode auth | Zero unauthenticated loopback requests (HTTP or WS) once headless mode is on |
| N4 | Version-check overhead | Non-blocking; never adds observable latency to a `vst <cmd>` invocation (R25); notice surfaces on a *later* invocation, never the one that triggered the check |
| N5 | Install idempotency | Re-running `install.sh`, "Install CLI in PATH", or a second GUI/CLI install never duplicates PATH entries or daemons |
| N6 | Lock race-freedom | The lock fix (R20) is exercised identically on Linux and macOS (no OS-specific branch) so a Linux Docker test proves the same code path macOS runs — no "fixed on the platform someone happened to test" gap |

---

## Architecture Diagram

```mermaid
flowchart TB
    subgraph bin["vst (merged binary)"]
        direction TB
        Dispatch{"argv0 == vst-daemon,\nor argv[1..2] == \"daemon run\"?"}
        CLI["CLI commands\n(rust/vst-cli/src/commands/*)"]
        Daemon["Daemon server\n(vst_daemon::run_daemon(DaemonOptions))"]
        SPA["Embedded web-ui/dist\n(rust-embed or include_dir)"]
        Dispatch -->|yes| Daemon
        Dispatch -->|no| CLI
        Daemon --> SPA
    end

    CLI -->|"self-heal: launch/prompt/spawn\n(scoped, TTY-aware)"| Launcher["Launch strategy"]
    Launcher --> Daemon
    CLI -->|"HTTP + Bearer cliToken"| Daemon
    Daemon -->|"/mobile-auth + /continue\ncode exchange"| Browser["Browser tab"]
    Tauri["Tauri desktop app"] -->|"kill(pid,0) liveness (unchanged)\n+ /health version compare (new)"| Daemon
    Daemon -->|"rewrite shim on boot\n(guaranteed single-daemon by flock)"| AgentShim["~/.vibe-station/bin/vst"]
    GH["GitHub Releases API"] -->|"daemon-side cached poll"| Daemon
    Daemon -->|"update-available event"| UI["Web/Tauri UI banner"]
```

- **vst (merged binary)** — one executable; `Dispatch` is the only new control-flow node (Part 00). `SPA` is new (Part 00, R28) — without it, `Daemon`'s web-UI branch has nothing to serve.
- **Launcher** — the self-healing strategy selection in the CLI (Part 03); platform-aware display check, TTY-gated prompt, command-scoped (R31).
- **Browser** — the "continue" flow's target (Part 02), reusing the mobile/QR redemption endpoint (`rust/vst-routes/src/mobile_auth.rs:412-501`) under a new `origin`.
- **Tauri** — attach-or-spawn logic (`desktop/src-tauri/src/daemon.rs:55-72`) is **unchanged** (its `kill(pid,0)` check is a separate, already-adequate-for-its-purpose mechanism — see Superseded table) plus a new version-compare-and-offer-restart branch (Part 03).
- **AgentShim** — the existing `~/.vibe-station/bin/vst` wrapper script (`rust/vst-daemon/src/env_setup.rs:93-134`), now provably always-correct once the daemon lock (Part 01) guarantees single-daemon.
- **GH / update-available event** — new (Part 05); the UI never talks to GitHub directly.

---

## Target Structure

```
rust/vst-daemon/        ~ main() logic extracted to lib fn run_daemon(DaemonOptions); lock.rs uses flock; env_setup.rs shim logic unchanged (now provably correct); server.rs gains headless flag on AppState + daemon stop route + continue-flow route + update-status route; web-ui/dist embedded
rust/vst-proc/           + new unsafe flock helper (this crate already hosts unsafe helpers for forbid(unsafe_code) crates, e.g. raw_fd_write.rs, and already depends on libc)
rust/vst-cli/            ~ gains daemon dispatch entry point (argv0/subcommand), launch-strategy module, update command, throttled version-check cache
desktop/src-tauri/       ~ externalBin drops the separate vst-daemon entry; version-check-and-restart branch; vst_bin resolution simplified to current_exe() fallback
scripts/                 ~ install.sh gains macOS support; prep-sidecar.sh / dev-start.sh / docker-compose.dev.yml updated for the merged binary (argv0 == vst-daemon still works, but references are updated for clarity)
.github/workflows/       + new release workflow: stamps version from git tag, publishes vst-<triple>.tar.gz (incl. musl boot-test), builds Linux GUI, uploads to GitHub Release
web-ui/src/               ~ update-available banner (Part 05), sourced from the daemon's own endpoint
```

---

## Entities & Modules

| Entity / Module | Layer | Responsibility | Public interface | Key Dependencies |
|-----------------|-------|-----------------|-------------------|-------------------|
| `vst_daemon::run_daemon` | Daemon | Everything `main()` does today, as a callable lib fn, parameterized by mode | `async fn run_daemon(opts: DaemonOptions) -> anyhow::Result<()>` where `DaemonOptions { headless: bool }` | `vst_routes`, `vst_store`, `vst_lifecycle`, `vst_git`, `vst_proc` |
| `vst_daemon::lock` (flock-based) | Daemon | Race-free single-daemon guarantee | `async fn acquire_lock(path) -> Result<LockGuard>` — `LockGuard`'s `Drop` releases via `flock` | `vst_proc`'s unsafe flock helper |
| `vst_proc::flock` | Proc (unsafe helper host) | OS-level advisory file lock, held for process lifetime | `fn try_lock_exclusive(fd: RawFd) -> io::Result<bool>` | `libc` |
| `vst_cli::dispatch` | CLI entry | Decide daemon-mode vs CLI-mode from argv0/argv[1..2] | `fn resolve_entry_mode(argv0: &str, args: &[String]) -> EntryMode` | `std::env` only |
| `vst_cli::launch` | CLI | Self-healing daemon-absent strategy, command-scoped, TTY-aware | `async fn ensure_daemon_reachable(cmd: &Command) -> Result<DaemonHandle, LaunchError>` | `vst_cli::preflight`, platform display detection, Tauri detection |
| `vst_daemon::server::headless` (AppState field) | Daemon | Gate the loopback-trust bypass on headless mode, alongside existing `no_auth` | `AppState.headless: bool`, checked at both `server.rs:905-909`-equivalent and `:1064`-equivalent sites | none new — mirrors existing `no_auth` field shape |
| `vst_routes::continue_flow` | Daemon | Mint+redeem the browser "continue" code, new `origin` value | reuses `mobile_auth::OneTimeCodeStore` | `rust/vst-routes/src/mobile_auth.rs` |
| `vst_cli::update` | CLI | `vst update`, install-shape classification (curl-only vs. curl+Tauri-app-present), throttled version check | `async fn run_update() -> Result<(), UpdateError>`, `async fn maybe_check_version()` | `reqwest`, `scripts/install.sh`'s atomic-swap convention |
| `vst_daemon::server::update_status` (route) | Daemon | Cached GitHub-releases poll, served to CLI + UI | `GET /api/update/status → {latest: String, current: String, updateAvailable: bool}` | GitHub Releases API, in-memory TTL cache |

---

## Alternatives Considered

See PRD §"Options considered" — not re-derived here.

---

## Design Details

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|-----------------|--------|-------------------|
| CLI ↔ Daemon (self-heal + version) | `GET /health` → `{ok: bool, version: String, port: i64, uptime: i64}` (`vst_types::rest::health::Health`, `rust/vst-routes/src/health.rs:31-38`) — unchanged wire contract; now meaningful once R29's version pipeline lands | Connection refused → trigger launch strategy (command-scoped, R31); non-2xx → existing preflight error | Daemon |
| CLI ↔ Tauri (CUJ1) | Process launch via resolved `.app`/binary path; readiness via polling `/health` | Launch fails → fall through to headless spawn (Part 03 Key Decision); single-instance guard needed on the Tauri side (Risk 5) | CLI |
| Browser ↔ Daemon (continue flow) | `POST /api/auth/continue/mint` → `{code, expiresInMs}`; `GET /continue?code=` → `302` redirect to `/` + `Set-Cookie` (not the static `SUCCESS_HTML` page `mobile_auth.rs` uses today — R38 requires a real URL-scrubbing redirect) | Expired/consumed code → same `410` + `EXPIRED_HTML`-equivalent pattern as `mobile_auth.rs:453-458` | Daemon (`OneTimeCodeStore`, new `origin: "local-cli"`) |
| Daemon ↔ Daemon (singleton lock) | `~/.vibe-station/.daemon.lock` — held via `flock(2)`, kernel-released on any process exit | Lock held by a live process → bail with the (now-real) `vst daemon stop` hint; process gone → kernel already released the lock, no manual "stale PID" branch needed at all | Filesystem + kernel |
| CLI ↔ GitHub Releases (update) | `GET https://api.github.com/repos/fastestdevalive/vibe-station/releases/latest` (already used by `install.sh:95-118`'s `resolve_version`) → tag name, asset URLs — called by the **daemon** (`update_status` route) whenever one is reachable, so the CLI's stderr notice and the UI banner share one cached result; the CLI calls GitHub **directly** only in the no-daemon-reachable case (pure curl-only, nothing to ask), under its own separate on-disk cache file (R25) | Network/rate-limit failure → cache holds last-known value; never blocks (R25/N4) | GitHub, cached in daemon memory (or the CLI's own cache file in the no-daemon fallback) |
| Daemon ↔ Embedded SPA | `web-ui/dist` compiled into the binary via `rust-embed` (or equivalent); `handle_fallback` serves from the embedded asset table when no `VST_DIST_PATH` override is set | Missing asset → same 404 behavior as today, now only reachable if the embed step itself is misconfigured | Compiled-in at build time |

### Critical User Journeys (CUJs)

See `docs/CLI-DAEMON-TAURI-CUJS.md` for the full sequence diagrams (CUJ1, CUJ2a, CUJ2b, CUJ3, CUJ4, CUJ5, CUJ6) — not redrawn here; each owning part's plan links back to its specific CUJ(s) and calls out where this arch's revisions diverge from the doc's original diagram (the CUJ4 redirect-not-HTML change, the CUJ2a/2b headless-flag split).

### Data Model

No new persisted tables. `~/.vibe-station/config.json` gains **no** new field for headless mode (rev 1's plan to persist `headless: bool` there was rejected — R34 keeps it in-memory only, set fresh at every boot, to avoid a stale on-disk value leaking into a differently-launched daemon). `~/.vibe-station/.daemon.lock` changes from a bare PID-string file (read by a liveness probe) to an `flock`-held file whose *content* no longer matters for correctness (kept as a PID string for human debugging only).

### API Contracts

New/changed routes, full contracts owned by their part's plan:

| Method | Path | Owning part |
|--------|------|-------------|
| `POST` | `/api/daemon/stop` (or equivalent authenticated shutdown route) | 01-daemon-lifecycle |
| `POST` | `/api/auth/continue/mint` | 02-continue-flow |
| `GET` | `/continue` | 02-continue-flow |
| `GET` | `/api/update/status` | 05-vst-update |
| `GET` | `/health` | unchanged wire shape — reused, now backed by a real version (R29) |

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does `.deb`'s postinst already register `vst` on PATH? | Unverified against a real built `.deb` (Tauri's default `.deb` bundling has no custom postinst script configured in this repo — `tauri.conf.json`'s `bundle.linux.deb.depends: []` is the only `.deb`-specific config found) — Part 03 verifies against an actual built `.deb` before assuming either answer; R33 covers both outcomes |
| 2 | GitHub API rate limits on the background version check | Mitigated by the daemon-side cache (`update_status` route) serving both the CLI's once-a-day-per-machine check and the UI's polling from one shared, longer-TTL cache — not one GitHub call per `vst` invocation |
| 3 | macOS `/Applications/vibe-station.app` write permissions + code-signing seal for `vst update` | Resolved: whole-bundle replace (download new `.dmg`/`.AppImage`, swap the app), never patch inside the existing signed bundle (Option C rejected, see Superseded); app must be fully quit first, checked and refused-with-message otherwise |
| 4 | Merged binary's daemon-dependency weight in every CLI invocation | Accepted per PRD Option A; N1 no longer pre-commits to a size target given the SPA-embed addition — Part 00's plan reports the real before/after size and flags if it's egregious, rather than gating on an arbitrary number |
| 5 | Tauri has no single-instance plugin; a hidden-in-tray Tauri instance with a dead daemon won't re-spawn on a second CUJ1 trigger | Flagged for Part 03: either add `tauri-plugin-single-instance` plus a "re-detect daemon" path, or document this as a known gap (user must manually quit-and-relaunch Tauri if its daemon dies while the tray icon is still up) |
| 6 | aarch64 Linux GUI asset gap | `desktop-build.yml`'s matrix has no aarch64 Linux job — Part 04 either adds one or makes `install.sh`'s AppImage step degrade gracefully (warn + skip) on an arch with nothing published, same pattern as its existing musl skip |
| 7 | Musl feasibility of the merged (heavier) daemon | The Linux CLI tarball is already a static-musl build (`install.sh:137-140`); Part 00/04 must confirm the daemon's dependencies (bundled sqlite via `rusqlite`, `portable-pty`, `ring`) actually cross-compile and boot under musl/Alpine — R30 requires CI to verify boot, not just compile, before publishing |

---

## Part Breakdown

| Part | Scope | Dependencies |
|------|-------|---------------|
| [`00-binary-merge`](./00-binary-merge/plan-00-cli-daemon-unification-binary-merge.md) | Single `vst` binary (argv0/subcommand dispatch), `DaemonOptions{headless}`, embedded `web-ui/dist` (R28), **version-read mechanism** (`VST_VERSION` build-time override else `CARGO_PKG_VERSION`, R29 half 1), Tauri externalBin update, SKILL.md `include_str!`, dev-script/Docker-sandbox updates for the merged binary | none |
| [`01-daemon-lifecycle`](./01-daemon-lifecycle/plan-01-cli-daemon-unification-daemon-lifecycle.md) | `flock`-based lock fix (in `vst-proc`), `vst daemon stop` (a real stop-request signal reusing SIGTERM's cleanup path, not a bare `notify_one()`), headless-mode auth gate on both HTTP and WS paths | 00 |
| [`02-continue-flow`](./02-continue-flow/plan-02-cli-daemon-unification-continue-flow.md) | Browser "continue" mint/redeem routes reusing the mobile/QR mechanism under a new origin, redirect-based URL scrub | 00 |
| [`03-cuj-detection-launch`](./03-cuj-detection-launch/plan-03-cli-daemon-unification-cuj-detection-launch.md) | CLI self-healing (CUJ1/CUJ2b only — the CUJ2a prompt, Tauri version-offer, and "Install CLI in PATH" were cut on scope review, see that plan's Superseded/rev-3 notes), platform-aware display check, command scoping per R31, `VST_DAEMON_URL` refresh per R44, detached headless-spawn via `vst-proc::spawn_detached` | 00, 01, 02 |
| [`04-curl-installer`](./04-curl-installer/plan-04-cli-daemon-unification-curl-installer.md) | `install.sh` macOS support, release CI: stamps `VST_VERSION` from the git tag at build time (**version pipeline, R29 half 2** — the CI-side counterpart to Part 00's read mechanism), publishes `vst-<triple>.tar.gz` + musl boot verification | 00 |
| [`05-vst-update`](./05-vst-update/plan-05-cli-daemon-unification-vst-update.md) | `vst update` (install-shape classification, curl swap, macOS whole-bundle swap, restart-with-consequences), `update_status` route (daemon-side GitHub cache), throttled CLI notice (daemon-first, GitHub-direct fallback) + UI banner | 00, 01, 03, 04 |

> Each part uses the **plan template** and carries its own phased checklist + test verification.
> This arch doc is not re-opened once parts are drafted — it is the stable reference.

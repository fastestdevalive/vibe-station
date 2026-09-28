<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: CLI/Daemon Unification, Install, and Update

> Merge the `vst` CLI and `vst-daemon` into one binary, ship both platforms via `curl`, make every daemon-absent/Tauri-present/headless combination behave correctly, close a macOS daemon-lock bug, tighten headless auth, and give `vst` a real update story.

**Status:** Draft — revision 3, post Opus review + verification pass (see `## Review disposition` at the end)
**Technical plan:** `.vibekit/feature-plans/pending/cli-daemon-unification/arch-cli-daemon-unification.md`
**Source docs:** `docs/CURL-INSTALL.md`, `docs/CLI-DAEMON-TAURI-CUJS.md`, `docs/UPGRADE-IDEAS.md`, `docs/AUTH.md` (agreed future direction, not yet built)

---

## Problem

- `vst` CLI and `vst-daemon` ship as two separate sidecar binaries in Tauri and have no story at all for a standalone curl install on macOS — today's `scripts/install.sh` refuses macOS outright.
- Every "daemon not running" CLI invocation just tells the user to open the desktop app — there is no headless fallback, no macOS "which UI do you want" prompt, and no handling for CI/no-display boxes.
- `vst-daemon`'s own startup singleton lock checks PID liveness via `/proc/<pid>`, which doesn't exist on macOS — a live daemon looks dead there, so a second daemon can start and clobber `config.json`.
- Loopback requests are always trusted, with no way to turn that off for a daemon started unattended on a shared/CI box.
- There is no `vst update` command and no update-availability signal anywhere in the CLI or UI.
- **Compounding gap found in review:** none of the above can work today because there is no single source of truth for "what version is this" (workspace `Cargo.toml` says `0.1.0`, Tauri says `0.0.0`, only `-beta` git tags exist) and the curl-installed binary cannot serve the web UI at all (`web-ui/dist` is a Tauri-only resource, never embedded in `vst-daemon`).

## Goals

- One binary (`vst`) is both the CLI and the daemon; Tauri bundles one fewer sidecar.
- `curl | sh` installs CLI + daemon on macOS and Linux; Linux also gets the GUI unconditionally.
- A curl-only daemon can actually serve the web UI end to end (not just bind a port) — this is a prerequisite for CUJ2b/CUJ2a's "Web UI" branch to mean anything.
- Every `vst <cmd>` self-heals when no daemon is reachable, using the right strategy for the platform/environment/interactivity it's running in (Tauri launch, prompt, or headless spawn) — and never hangs a non-interactive caller.
- A daemon started unattended (headless) requires a bearer token/session cookie even from loopback.
- The macOS PID-liveness bug in the daemon's own singleton lock is fixed, race-free (not just "less wrong").
- A single version travels from git tag → CI build → workspace `Cargo.toml` → Tauri config → `/health` response, so version comparisons are meaningful.
- `vst update` swaps the CLI+daemon binary (and, on macOS, the whole GUI app bundle — not just the sidecar inside it) in place; a background check tells the user/UI a new version exists, sourced from the daemon (never a direct webview→GitHub call, which the CSP blocks).

## Non-goals

- Auto-update (silently replacing the binary without an explicit `vst update` invocation).
- A real systemd/launchd supervised-service story for the headless daemon (crash recovery beyond today's spawn-once behavior).
- Per-agent scoped tokens (deferred in `docs/CLI-DAEMON-TAURI-CUJS.md`'s token table).
- Update channels/cadence (beta track vs. stable) — out of scope per `docs/UPGRADE-IDEAS.md`.
- Windows support for any of the above (install matrix and CUJ docs only cover macOS/Linux).
- Feature parity for a curl-only daemon vs. a Tauri-bundled one on cloudflared tunneling, agy Rich Chat, and Claude Rich Chat — these depend on sidecars/vendored assets a bare tarball doesn't ship; `vst doctor` must say so, closing the gap is future work.
- Verifying real macOS Gatekeeper/quarantine/code-signing behavior end to end — no macOS hardware in this session's Docker-based verification; called out explicitly, not silently skipped (see arch Risks).

---

## Requirements

### 1. Binary merge

| ID | Requirement |
|----|-------------|
| R1 | A single `vst` executable serves as the daemon when invoked as `vst daemon run`, and as the CLI for every other invocation. |
| R2 | Invoking the same executable via a symlink/copy named `vst-daemon` (argv0) also serves — kept for the dev sandbox (`docker-compose.dev.yml`) and `scripts/prep-sidecar.sh`/`package.json` scripts that reference `vst-daemon` by name today, not for any external consumer. |
| R3 | The Tauri desktop app bundles one `vst` sidecar instead of separate `vst` and `vst-daemon` sidecars. |
| R4 | `skill/SKILL.md` ships embedded inside the compiled binary, not as a separate bundled resource file. |
| R5 | The `~/.vibe-station/bin/vst` shim always resolves to the one currently-running daemon's own binary — guaranteed by R19 (single-daemon lock fix) plus rewriting the shim on every boot; no separate per-instance mechanism is needed once only one daemon can ever hold the lock. |
| R28 | The compiled `vst` binary embeds `web-ui/dist` so a curl-only, sidecar-free daemon can serve the web UI (not just bind a port and 404 on every asset request). |
| R29 | A single version string is stamped from the release git tag into the workspace build (`CARGO_PKG_VERSION` or an override), the Tauri bundle version, and returned by `/health` — `vst --version`, `/health`'s `version` field, and the Tauri app's reported version always agree for one release. |

### 2. Curl installer

| ID | Requirement |
|----|-------------|
| R6 | Running the published `install.sh` on macOS installs the merged `vst` binary to `~/.local/bin`, on PATH, idempotently. |
| R7 | Running it on Linux (glibc or musl) installs the merged `vst` binary the same way, unchanged from today's CLI behavior. |
| R8 | Linux additionally gets the `.AppImage` GUI installed unconditionally, with a launcher and `.desktop` entry. |
| R9 | macOS does not download or install any GUI asset via curl; the `.dmg` remains a separate manual download, fetched by opening the Releases page in a browser (never curl-downloaded by `vst` itself) so the file keeps its quarantine flag and Gatekeeper still runs. |
| R30 | The published `vst-<triple>.tar.gz` for Linux is a genuine static-musl build of the now-heavier merged binary (daemon dependencies: sqlite, portable-pty, tokio) — CI verifies it actually boots under Alpine before publishing, not just that it compiles. |

### 3. Daemon-absent self-healing (CUJs 1/2a/2b/3)

| ID | Requirement |
|----|-------------|
| R10 | If no daemon is reachable, Tauri is installed, **and** Tauri is launchable (see R11's display check) on this OS, the CLI launches it and waits for readiness before retrying the original command. |
| R11 | Launchability is a platform-specific check, not a bare env-var read: Linux uses `$DISPLAY`/`$WAYLAND_DISPLAY` presence; macOS is presumed to have a GUI session unless `$SSH_CONNECTION`/`$SSH_TTY` is set (a bare macOS Terminal has neither `$DISPLAY` nor `$WAYLAND_DISPLAY` set, so the Linux check would wrongly classify every local Mac session as headless). |
| R12 | The CUJ2a prompt additionally requires stdin to be a TTY — a non-interactive caller (pipe, CI with a display, an agent in tmux) never blocks on a prompt; it falls straight through to R13's headless spawn instead. |
| R13 | If no daemon is reachable and (no display, or not a TTY), the CLI spawns a headless daemon with no prompt. |
| R31 | Self-healing (R10-R13) is skipped entirely for daemon-status-shaped or target-may-already-be-gone commands (`vst daemon status`, `vst doctor`, `vst status`, `vst agent stop`/`terminate`) — these report "not running"/"not found" as today, since spawning a fresh daemon just to immediately report on it (or to look for a session on a daemon that never had it) is meaningless. |
| R14 | Choosing "Web UI" opens a browser tab that ends up authenticated without a durable token ever appearing in the URL, via the mechanism in §"Browser continue flow" below. |
| R15 | When Tauri launches while a daemon is already running (headless or otherwise), it attaches to the existing daemon instead of spawning a duplicate, using a liveness check that works identically on macOS and Linux. |
| R16 | When Tauri detects (via `/health`'s now-meaningful `version`, R29) that it bundles a newer daemon than the one currently running, it offers to restart into the bundled version, after confirming with the user that this will invalidate existing browser/phone sessions (a restart always mints a fresh `daemonToken`). |
| R32 | A daemon is headless (loopback trust off) by default whenever it's started via `vst daemon run` directly — both CUJ2a's "Web UI" branch and CUJ2b, matching `docs/CLI-DAEMON-TAURI-CUJS.md`'s own CUJ2a diagram, which explicitly spawns `vst daemon run (headless)` and mints a browser code even for the attended case. Only a daemon spawned by **Tauri's own sidecar mechanism** (`desktop/src-tauri/src/daemon.rs::spawn_daemon`) is non-headless — Tauri sets an internal flag/env var when launching its bundled sidecar specifically to keep the existing attended-desktop loopback-trust model; a `vst daemon run` invoked any other way (self-heal, or an operator running it manually) defaults headless. This makes R14's continue-flow genuinely load-bearing for CUJ2a, not merely for CUJ2b. |

### 4. GUI/CLI install-order parity (CUJs 5/6)

| ID | Requirement |
|----|-------------|
| R17 | A GUI installed via `.dmg`/`.AppImage` (bypassing curl) offers an explicit "Install CLI in PATH" action that **copies** its bundled binary into `~/.local/bin` (copy, not symlink — an AppImage's sidecar only exists inside its ephemeral squashfs mount while running, and a macOS `.app`'s Mach-O may be App-Translocated to a random read-only path, so a symlink into either can dangle; a copy has no such lifetime dependency on the app bundle). |
| R18 | Running that action when `vst` is already on PATH (and `--version` runs successfully — not a broken/stale copy) is a no-op, not a clobber. |
| R19 | Installing the GUI after the CLI was already on PATH (or vice versa) never spawns a duplicate daemon or corrupts `config.json`. |
| R33 | If a `.deb` install already places `vst` on `/usr/bin` PATH via its own package mechanism (verified true/false during the plan phase — see Open Questions), the "Install CLI in PATH" action detects that case too and no-ops rather than trying to write root-owned paths. |

### 5. Daemon lock / headless auth

| ID | Requirement |
|----|-------------|
| R20 | The daemon's own startup singleton lock correctly and race-free-ly detects a live daemon process on macOS as well as Linux — using an OS-level advisory file lock (`flock`), not a PID-liveness probe, so the same code path is exercised (and Docker-testable) on every platform instead of only being "fixed" on the platform someone remembered to check. |
| R21 | A daemon started in headless mode requires a valid bearer token or session cookie on every request, including from loopback, on both the HTTP and the WebSocket-upgrade path (both currently have their own independent loopback-trust check). |
| R22 | A daemon started by Tauri's own sidecar mechanism (`spawn_daemon`) keeps today's loopback-trust bypass — this is the only non-headless spawn path (R32). |
| R34 | `headless` is an in-memory `AppState` flag set once at boot from a CLI flag/env var, never persisted to or re-read from `config.json` — so a stale on-disk value can never leak into a later, differently-launched daemon. |
| R35 | `vst daemon stop` (or an equivalent authenticated `POST` route) exists — needed by both an operator wanting to cleanly stop a headless daemon (today's lock-bail message already references this nonexistent command) and by `vst update`'s restart-after-swap (R27). |
| R41 | "Install CLI in PATH" and any Rust-side PATH-rc writing reuses the same shell-rc-patching logic the daemon's own `patch_shell_configs` already implements (`rust/vst-daemon/src/env_setup.rs:138-160`) — `install.sh`'s separate shell-only PATH mechanism (`~/.config/vibe-station/env`, sourced from `.profile`/`.zshenv`/etc.) is left as-is for the curl path, but no *third*, divergent PATH-rc mechanism is introduced; `~/.local/bin` (curl) and `~/.vibe-station/bin` (daemon shim) are both added to PATH, in that order, so a curl-installed binary is never shadowed by the daemon's own shim. |
| R42 | **(Owned by Part 03, not Part 01 — see that part's plan.)** A headless daemon boot that Part 03 has actually detached/redirected to a log file never prints `daemonToken` into that file. Rescoped after Part 01's implementation review found that suppressing the print at every headless boot (including an operator's own interactive `vst daemon run`, and `Dockerfile.screenshots`'s documented "read the token from container logs" flow) breaks currently-working logins with no replacement yet — the fix belongs at the point that actually controls where stdio goes (Part 03's real detached-spawn implementation), not unconditionally on the `headless` flag alone. |
| R43 | **(Owned by Part 03.)** A headless daemon's log file (wherever Part 03's detached-spawn path redirects its stdio) is created with `0600` permissions, matching `config.json`'s existing mode. |
| R44 | The CLI's self-heal never trusts a stale `VST_DAEMON_URL`/`VST_DAEMON_TOKEN` env override (set once into an agent's environment at spawn time, per `rust/vst-agents/src/context.rs`) when deciding whether to self-heal or where to retry — it re-resolves the daemon's actual current port/token from `config.json` after a self-heal action, rather than looping forever against a port a dead daemon used to own. |
| R45 | On macOS, choosing "Desktop app" in the CUJ2a prompt opens the GitHub Releases page in the user's default browser (same as a manual `.dmg` download) rather than having `vst` download the `.dmg` itself — consistent with R9's rationale (a curl/programmatic download never gets the quarantine flag Gatekeeper needs). |
| R46 | If the Linux `.AppImage` GUI failed to install (missing `libfuse2`, or any other `install_gui_linux` failure) or is present but not launchable, CUJ1/CUJ2a's self-heal treats this identically to "Tauri not installed" and falls through to the headless/prompt path rather than hanging or erroring. |

### 6. Browser continue flow (CUJ4)

| ID | Requirement |
|----|-------------|
| R36 | The "continue" flow mints a short-lived, single-use code and redeems it for a session cookie using the same in-memory `OneTimeCodeStore` mechanism the mobile/QR flow already uses (`rust/vst-routes/src/mobile_auth.rs`) — not a new mint/redeem implementation. |
| R37 | A continue code is bound to a new `origin: "local-cli"` (or equivalent) distinct from the existing `"local"`/`"tunnel"` origins, since it's redeemed from a CLI-opened loopback browser tab, not a scanned QR — redemption still enforces single-use + 30s TTL like the existing origins. |
| R38 | On successful redemption, the code is scrubbed from the visible URL via a redirect (not just a static HTML page), matching the "URL is scrubbed" requirement in `docs/CLI-DAEMON-TAURI-CUJS.md`. |

### 7. `vst update`

| ID | Requirement |
|----|-------------|
| R23 | `vst update` classifies the current install by content-comparing the resolved `vst` binary against both a plain `~/.local/bin` curl install and a known Tauri-app-bundle copy (R17 made "Install CLI in PATH" a copy, not a symlink, so there is no path to canonicalize through — classification instead checks whether a Tauri app bundle is *also* present on disk, independent of which copy happens to be on PATH). |
| R24 | `vst update` on a curl-only install downloads, verifies, and atomically renames the CLI+daemon binary into place (never overwrites a running binary's inode in place — macOS SIGKILLs a process whose backing file is overwritten, not renamed), without requiring the daemon to be stopped first. |
| R39 | `vst update` on a machine with both a curl-installed binary and a Tauri app updates both: the curl binary via R24's swap, and the Tauri app by downloading the new `.dmg`/`.AppImage` and replacing the **entire app bundle** (not patching the Mach-O/ELF sidecar inside a signed bundle in place, which breaks the code-signature seal) — this requires the app to be fully quit first; `vst update` checks for and refuses to proceed past a running app, printing how to quit it. Unlike R9/R45 (a first-time GUI install, where the quarantine flag matters because the user has never run this app before), replacing an app the user is already running is not a fresh-trust decision — `vst update` is allowed to download the `.dmg` itself here, quarantine flag or not. |
| R27 | `vst update` restarts a running daemon after swapping its binary (via R35's stop + a fresh `vst daemon run` in the same mode it was already running in — headless stays headless), so the new version actually takes effect; the user is shown the session-invalidation consequence (R16) before confirming. |
| R25 | Every `vst <cmd>` invocation triggers a non-blocking, throttled (at most once per day, via a cached last-check timestamp) background check for a newer version — **if a daemon is reachable, the CLI asks the daemon's own `/api/update/status` (R26) instead of calling GitHub itself**, so one machine makes one class of GitHub call no matter how many CLI invocations happen; only when no daemon is reachable at all (pure curl-only, no daemon ever spawned yet) does the CLI fall back to calling GitHub directly, under its own separate once-per-day cache file. The notice prints to **stderr** on the *next* invocation after the check completes (a short-lived CLI process can't block waiting on its own background check) and is suppressed entirely when not a TTY, when `VST_SESSION` is set (agent context), or under CI. |
| R26 | The web/Tauri UI surfaces the same update-available signal as a dismissible banner, sourced from the **daemon-side** `GET /api/update/status` endpoint, which itself talks to GitHub's releases API on a longer-TTL cache (hours) shared across every CLI/UI caller on that machine — never a direct webview→GitHub fetch (blocked by the Tauri CSP's `connect-src`, which only allows `127.0.0.1`). |
| R40 | No update ever happens without an explicit `vst update` invocation — the background check (R25/R26) only notifies. |

---

## Options considered

### Binary merge mechanism

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — single binary, dispatch on argv0/subcommand | One artifact to build/sign/notarize; matches `k3s` precedent; smaller total size | Daemon's heavier dependency tree (axum, tokio full, etc.) now links into every CLI invocation | ✅ chosen |
| B — keep two binaries, share a common lib crate | No dependency-tree merge | Doesn't solve the actual problem (two sidecars, two things to keep in version-lockstep) | ❌ deferred |

**Decision:** Option A — per `docs/CURL-INSTALL.md`'s design decision 3, already agreed, not reopened here. Confirmed feasible: no workspace dependency cycle (nothing currently depends on `vst-cli`), the CLI's `tokio = { workspace = true }` already pulls in the `full` feature so `run_daemon().await` composes under the CLI's own `#[tokio::main]`, and the release profile (`lto`/`strip`/`panic = "abort"`) is workspace-wide already.

### `vst update` scope when both curl and Tauri copies exist

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — update both copies (curl binary swap + full Tauri app-bundle replace) | User never has to know two copies exist; matches doc's own leaning | Needs the app fully quit first; more moving parts than a binary swap | ✅ chosen |
| B — update only the copy on `PATH`/currently running | Simpler | Leaves a stale Tauri-bundled binary that resurfaces (with a stale, possibly incompatible SPA + daemon pair) on next Tauri restart, silently undoing the update | ❌ rejected |
| C — patch just the sidecar binary inside the existing signed `.app`, skip re-downloading the whole bundle | Smaller download | Breaks the bundle's code-signature seal (macOS reports the app as "damaged"); leaves a stale SPA/`web-ui/dist` resource paired with a newer daemon | ❌ rejected (found during review) |

**Decision:** Option A, with the mechanics corrected to a full-bundle replace (not Option C's in-place sidecar patch) after the Opus review identified C as the naive-but-broken version of "update the Tauri copy."

### Headless-mode detection

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — headless is the **default** for any `vst daemon run`; only Tauri's own `spawn_daemon` sets an explicit opt-out flag/env var when launching its bundled sidecar | Unambiguous; matches `docs/CLI-DAEMON-TAURI-CUJS.md`'s CUJ2a diagram (its Web-UI branch is headless too); exactly one call site (Tauri) needs to remember to opt out, instead of every self-heal call site needing to remember to opt in | Any future direct `vst daemon run` invocation (a human running it manually at a terminal, or a dev script) is headless-by-default unless it also knows to pass the opt-out — dev tooling (`scripts/dev-start.sh`) must be updated to set it, or rely on `VST_NO_AUTH` as it already does in the Docker sandbox | ✅ chosen |
| B — infer from absence of `$DISPLAY`/`$WAYLAND_DISPLAY` at daemon-boot time | No call-site changes needed | Conflates "no display" with "should disable loopback trust" — CUJ2a's daemon is headless even though a human is at the keyboard; inference can't produce that outcome | ❌ deferred |

**Decision:** Option A, default-on. CUJ1 and CUJ3 (Tauri-managed daemons) are the only non-headless path, via Tauri's own opt-out flag; CUJ2a and CUJ2b (any daemon the CLI spawns directly) are headless by default, matching R32. `scripts/dev-start.sh` (runs `cargo run -p vst-daemon` directly, outside Tauri) must set the opt-out flag or rely on `VST_NO_AUTH` — flagged for Part 01's plan so local dev doesn't suddenly require a bearer token.

---

## Resolved design questions

1. **Does merging the CLI+daemon binary remove the need for a bearer token?** — **No.** `vst <cmd>` and `vst daemon run` are still separate OS processes even sharing one executable; per `docs/CLI-DAEMON-TAURI-CUJS.md`, binary identity isn't process authorization.
2. **Does the browser "continue" flow mint a new kind of token?** — **No.** It reuses the existing mobile/QR short-lived-code → cookie-exchange mechanism (`docs/AUTH.md`'s one-time-code path, `rust/vst-routes/src/mobile_auth.rs`), under a new `origin` value (R37), not a new mechanism.
3. **What does "both copies" mean precisely for `vst update` on macOS?** — The curl-installed binary at `~/.local/bin/vst`, and the entire installed `.app` bundle (not just a binary inside it — see Option C rejection above). The app must be fully quit before its bundle is replaced.
4. **Does replacing the daemon's own binary while it's running need more than the atomic rename trick?** — **Yes, twice over.** (a) Atomic rename swaps the file safely (the already-running process keeps its old inode open and keeps serving; overwriting-in-place would SIGKILL it on macOS) — but the new binary only takes effect after the process restarts, so R27 explicitly restarts. (b) The restart mints a fresh `daemonToken`, invalidating every existing browser/phone session — R27 surfaces this before confirming, it is not silent.
5. **Is the version check ever blocking?** — **No.** It's a background/throttled check; a slow or failed check never delays the invoked command, and its result surfaces on a *later* invocation, not synchronously (R25).
6. **Is a curl-only daemon actually usable as a Web UI, or does it just bind a port?** — **It must actually work.** R28 requires the SPA to be embedded in the binary; without it, CUJ2a/2b's "Web UI" branch is a dead end (a `404` from `handle_fallback`), which the initial draft of this PRD missed entirely.
7. **Do R10-R13's checks correctly separate "is Tauri launchable" from "should we prompt"?** — **Yes, by construction now.** R10/R11 gate launchability (platform-specific display check); R12 additionally gates the prompt on TTY-ness; R13 is the fallthrough when either check fails. The original draft conflated "no display" with "headless," which would have sent every macOS Terminal session down the no-prompt path (macOS has neither `$DISPLAY` nor `$WAYLAND_DISPLAY` set even in a normal GUI session).
8. **Is the CUJ2a "Web UI" branch's daemon actually headless, or does it keep loopback trust like a Tauri-spawned one?** — **Headless**, per `docs/CLI-DAEMON-TAURI-CUJS.md`'s own CUJ2a diagram (it explicitly spawns `vst daemon run (headless)` and mints a browser code). Rev 2 of this PRD briefly drafted an "attended spawns stay loopback-trusted" model that contradicted the source doc; rev 3 (R32) corrects this — the only non-headless spawn path is Tauri's own sidecar mechanism.
9. **Who calls GitHub's releases API — the CLI or the daemon?** — **The daemon, whenever one is reachable** (R25/R26) — one cached call per machine serves every CLI invocation and the UI banner alike. The CLI only calls GitHub directly in the one case where no daemon exists to ask (pure curl-only, daemon never spawned).
10. **Does `vst update` downloading a `.dmg` itself contradict R9's "never curl-download the GUI" rule?** — **No, they cover different moments.** R9/R45 is about a *first install* on a machine that has never run this app before, where the quarantine flag is the thing that lets Gatekeeper do its job. R39 is about *replacing* an app the user is already running — there is no fresh-trust decision being made, so `vst update` is allowed to fetch the new `.dmg` itself.

---

## Priority & sequencing

| Order | Sub-feature | Depends on | Can ship independently? |
|-------|-------------|------------|--------------------------|
| 1 | Binary merge (incl. embedded web UI + version-read mechanism: `VST_VERSION` build-time override, else `CARGO_PKG_VERSION`) | — | No — everything else assumes one self-sufficient `vst` binary with a meaningful version exists |
| 2 | Daemon lifecycle safety + headless auth | Binary merge | Yes, once merge lands |
| 3 | Browser "continue" flow (CUJ4) | Binary merge | Yes, once merge lands |
| 4 | CLI/Tauri detection & launch (CUJs 1/2a/2b/3/5/6) | Binary merge, lifecycle safety, continue flow | No — CUJ2a's Web UI branch needs the continue flow; CUJ2b needs the headless flag; CUJ3's version-offer needs the version pipeline |
| 5 | Curl installer overhaul (incl. CI stamping `VST_VERSION` from the git tag at release-build time — the other half of Part 00's version mechanism) | Binary merge (embedded UI + musl-buildable heavier daemon) | Yes, once merge + CI publish land |
| 6 | `vst update` + version-check nudge | Binary merge, lifecycle safety (stop command), CLI/Tauri detection (spawn/restart plumbing), curl installer (atomic-swap convention, release asset shape) | Yes, once all four land |

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|--------------------------|
| 1 | Does a Tauri-built `.deb` already place `vst`/`cloudflared`/`agy-acp` on `/usr/bin` via its own packaging, or does it need the same "Install CLI in PATH" treatment as `.dmg`/`.AppImage`? | Verify against a real built `.deb` in the CUJ-detection-launch part; R33 covers either outcome |
| 2 | GitHub releases API rate limits for the background version check | Daemon-side cache (R26) with a generous TTL (hours, not the R25 CLI throttle's "once/day" — the daemon serves many CLI/UI callers, so it should check less often than each of them would individually) |
| 3 | Exact aarch64 Linux GUI gap | `desktop-build.yml`'s matrix has no aarch64 Linux job; `install.sh` would try to download an AppImage that was never published for that arch — flagged for the curl-installer part to either add the CI job or make the AppImage step degrade gracefully (warn + skip) on an arch with no published asset, mirroring the existing musl skip |

---

## Review disposition

An Opus-model adversarial review of PRD revision 1 + the arch doc found 6 blocking and ~16 significant issues (factual errors in code citations, a headless-auth design that put the flag in the wrong crate given a dependency-cycle constraint, an unservable curl-only Web UI, no real version pipeline, broken AppImage/dmg symlink assumptions, unsound macOS update mechanics, and several missing edge cases: TTY-vs-display, `VST_DAEMON_URL` staleness after self-heal, PID-reuse/TOCTOU in the lock fix, restart-invalidates-sessions consequences going unstated). Rev 2 incorporated every blocking fix and most significant ones (R28-R40 were new). A follow-up verification pass on rev 2 found 2 findings still unresolved (S9 PATH-rc unification, S16 headless-secret hygiene), several partial (B3/B5's prerelease-only-tags and update-vs-quarantine tension, S2's CUJ2a-headless modeling error, S6's `VST_DAEMON_URL` staleness and scoping, S4's Desktop-app-branch gap), and 6 new internal inconsistencies introduced by rev 2's own fixes (R17-vs-R23 leftover symlink wording, R9-vs-R39 contradiction, split ownership of the version pipeline across two parts, a Tauri-liveness mechanism contradiction, inconsistent GitHub-caller ownership, swapped line-number citations). **Rev 3** (this revision) adds R41-R46, corrects R32/R22 to match the source doc's actual CUJ2a behavior (headless, not attended-trusted — the earlier model was a genuine misreading), resolves the R9/R39 tension via Resolved Design Question 10, and fixes the GitHub-caller and version-pipeline ownership splits (ownership notes cross-referenced in the arch doc). The corresponding arch-doc fixes (line-number corrections, Tauri-liveness wording, GitHub-boundary table update) are in that file's own revision.

---
Feature: dev-build-docker-setup
Branch: main
Status: awaiting-review
PRD: N/A
---

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

## Problem & Concept

- `pnpm dev` at repo root only starts web-ui Vite — no Tauri window, no daemon
- No sidecar binary exists in `desktop/src-tauri/binaries/` → spawn_daemon() silently falls back to empty token in dev
- `pnpm build` doesn't wire the daemon binary build before `tauri build`
- `pnpm docker` doesn't exist — Docker sandbox has no root-level entry point
- Access-token login form is accessible from LAN (port 7421); should be QR/Tauri-only

**Success state:**
- `pnpm dev` → Tauri window opens, daemon running (tsx watch), Vite HMR — one command from root
- `pnpm build` → platform installers with bundled daemon binary — one command from root
- `pnpm docker` → headless daemon container for agent testing — one command from root
- Login form removed; only Tauri injection (`__VST_TOKEN__`) and QR codes authenticate

## Requirements

| # | Requirement |
|---|-------------|
| R1 | `pnpm dev` from repo root opens the Tauri window with daemon and Vite running |
| R2 | All three layers hot-reload independently (Rust via Tauri, daemon via tsx watch, UI via Vite HMR) |
| R3 | Dev daemon started directly via tsx — no sidecar binary required in dev mode |
| R4 | `pnpm build` produces platform installers with bundled vst-daemon sidecar |
| R5 | `beforeBuildCommand` builds the daemon binary and places it in `binaries/` before `tauri build` |
| R6 | `pnpm docker` wraps `scripts/dev-sandbox.sh up` with agent-testing defaults |
| R7 | Docker container runs no Rust, no Tauri — headless daemon + web-ui only |
| R8 | `POST /auth/login` removed from daemon; login form removed from web-ui |
| R9 | Non-Tauri browsers (LAN and tunnel) see a unified QR-scan notice, no token form |
| R10 | Tauri auto-login via `window.__VST_TOKEN__` injection preserved |
| R11 | `desktop/src-tauri/binaries/` gitignored; never committed |
| R12 | Failed daemon spawn in debug builds produces a visible error (not silent fallback) |

## Change Map

```
desktop/src-tauri/
  tauri.conf.json          ~ beforeDevCommand, beforeBuildCommand
  src/main.rs              ~ loud failure in debug builds
  .gitignore               + ignore binaries/
package.json               ~ dev/build scripts → desktop; add docker script
scripts/
  prep-sidecar.sh          + detect triple, build daemon binary, copy to binaries/
daemon/src/routes/
  auth.ts                  ~ remove POST /auth/login route
web-ui/src/
  components/auth/
    LoginScreen.tsx        ~ replace PasswordLoginScreen with unified QRNotice
  hooks/useAuth.ts         ~ remove api.login() fallback
  api/client.ts            ~ remove login() method
```

| Today | After this plan |
|-------|-----------------|
| `pnpm dev` starts only web-ui Vite | `pnpm dev` opens full Tauri window with daemon + Vite |
| Daemon sidecar binary required in dev (missing → silent fail) | Dev uses tsx watch directly; no sidecar needed |
| `pnpm build` does recursive Node builds only | `pnpm build` → daemon binary → tauri build → installers |
| No `pnpm docker` command | `pnpm docker` wraps dev-sandbox.sh for agent testing |
| LAN browsers see token input form | LAN and tunnel browsers see unified QR-scan notice |
| `api.login()` called as Tauri fallback | Tauri path only calls `api.checkAuth()`; no token POST |

## Research

- `desktop/src-tauri/tauri.conf.json:7` — `beforeDevCommand` currently only starts Vite; `beforeBuildCommand` only builds web-ui
- `desktop/src-tauri/src/main.rs:39-54` — spawn_daemon failure swallowed with `eprintln!`; falls back to `DaemonInfo { port: 7422, pid: 0, token: "" }`
- `desktop/src-tauri/src/daemon.rs:54-69` — `detect_running_daemon()` reads `~/.vibe-station/config.json` and checks pid alive; if daemon is pre-running, Tauri reuses it without spawning sidecar
- `daemon/src/main.ts:250` — daemon listens on `127.0.0.1` by default; fine for Docker since Vite proxy handles external traffic
- `daemon/src/main.ts:82-91` — `writeConfig()` writes `port`, `pid`, `cliToken`, `tauriToken` to `~/.vibe-station/config.json`; Tauri reads this via detect_running_daemon
- `daemon/src/routes/auth.ts:20-56` — `POST /auth/login` checks `cf-connecting-ip` to block tunnel, but LAN traffic passes through
- `web-ui/src/hooks/useAuth.ts:30-47` — Tauri path: checks `__VST_TOKEN__`, calls `api.checkAuth()`, falls back to `api.login(token)` if check fails
- `web-ui/src/components/auth/LoginScreen.tsx:5-7` — `isTunnelBrowser()` only checks `.trycloudflare.com` hostname; LAN browsers still get the password form
- `scripts/build-daemon-binary.sh` — entry: `cli/dist/daemon/main.js`; requires `pnpm --filter cli build` first
- `dev.Dockerfile` + `docker-compose.dev.yml` — full agent sandbox already exists; `pnpm docker` becomes a thin root-level wrapper
- `cli/package.json` — daemon compiles into `cli/dist/daemon/main.js` via `tsc -b`; tsx can run `daemon/src/main.ts` directly in dev without compiling

## Architecture Diagram

```
pnpm dev                         pnpm build                   pnpm docker
     │                                │                             │
     ▼                                ▼                             ▼
tauri dev                       scripts/prep-sidecar.sh      scripts/dev-sandbox.sh up
  ├── beforeDevCommand           (build daemon binary +        (docker compose -f
  │     ├── tsx watch            copy to binaries/)            docker-compose.dev.yml)
  │     │   daemon/src/main.ts        │
  │     └── vite dev --port 5180 tauri build
  └── cargo build (Rust shell)   └── platform installers
         │
         ▼
  detect_running_daemon()
  (reads config.json — daemon
   already up, no sidecar spawn)
         │
         ▼
  WebviewWindow (port 5180, __VST_TOKEN__)
```

## Design Details

### Critical User Journeys

**Happy path — pnpm dev:**
```
Developer runs: pnpm dev (from repo root)
  → delegates to: pnpm --filter @vibe-station/desktop dev
  → tauri dev starts
  → beforeDevCommand fires concurrently:
      tsx watch daemon/src/main.ts  (daemon up, writes config.json)
      vite dev --port 5180          (Vite HMR server)
  → cargo build (Rust shell, debug)
  → Tauri setup() calls detect_running_daemon() → finds daemon in config.json
  → WebviewWindow opens at http://localhost:5180 with __VST_TOKEN__ injected
  → Developer sees app, fully authenticated
  → Edit web-ui/src/*.tsx → Vite HMR, instant
  → Edit daemon/src/*.ts → tsx restarts daemon, Tauri reconnects
  → Edit desktop/src-tauri/src/*.rs → Tauri recompiles, window restarts
```

**Happy path — pnpm build:**
```
Developer runs: pnpm build
  → beforeBuildCommand: scripts/prep-sidecar.sh
      detects host target triple (rustc -vV)
      runs: pnpm --filter @vibestation/cli build
      runs: scripts/build-daemon-binary.sh --target <triple>
      copies dist/vst-daemon-<triple> → desktop/src-tauri/binaries/vst-daemon-<triple>
      downloads cloudflared → desktop/src-tauri/binaries/cloudflared-<triple>
  → beforeBuildCommand: pnpm --filter web-ui build
  → tauri build (release mode Rust + pkg bundle)
  → installers written to desktop/src-tauri/target/release/bundle/
```

**Happy path — pnpm docker:**
```
Developer runs: pnpm docker
  → scripts/dev-sandbox.sh up (default port auto-detected)
  → docker compose -f docker-compose.dev.yml up --build
  → container: daemon + Vite, VST_NO_AUTH=1
  → open http://localhost:<port>
  → agent reads cliToken from ~/.vibe-station/config.json inside container
```

**Non-Tauri browser (post-auth-removal):**
```
Browser opens http://localhost:7421
  → LoginScreen renders
  → NOT a Tauri shell (__VST_TOKEN__ absent) and NOT tunnel hostname
  → Shows unified QRNotice: "Open the desktop app → Remote Access → Show QR"
  → No token form rendered
```

### Key Decisions

#### Decision 1: Dev daemon via tsx watch, not sidecar
- **Decision:** Start `tsx watch daemon/src/main.ts` in `beforeDevCommand`; Tauri's `detect_running_daemon()` picks it up; no sidecar binary needed in dev
- **Rationale:** Avoids `pkg` bundling step in dev, enables hot reload; `detect_running_daemon()` already handles pre-running daemons gracefully
- **Where:** `desktop/src-tauri/tauri.conf.json` (beforeDevCommand), `desktop/src-tauri/src/main.rs` (no change needed — logic already there)

#### Decision 2: concurrently for beforeDevCommand
- **Decision:** Use `concurrently` to run tsx watch + Vite in parallel inside `beforeDevCommand`
- **Rationale:** `beforeDevCommand` is a single shell string; both processes must run simultaneously; `concurrently` is the standard tool for this in the Node ecosystem
- **Where:** `desktop/src-tauri/tauri.conf.json:7` — add `concurrently` to root devDependencies

#### Decision 3: prep-sidecar.sh for prod build
- **Decision:** New `scripts/prep-sidecar.sh` detects host triple, builds daemon binary, copies to `binaries/`; called from `beforeBuildCommand`
- **Rationale:** `beforeBuildCommand` must complete before Tauri reads `externalBin`; script encapsulates triple detection + binary placement in one place
- **Where:** `desktop/src-tauri/tauri.conf.json` (beforeBuildCommand), `scripts/prep-sidecar.sh` (new)

#### Decision 4: Loud debug failure in main.rs
- **Decision:** In `#[cfg(debug_assertions)]` builds, panic with a clear message when `spawn_daemon()` fails instead of silently using empty DaemonInfo
- **Rationale:** Silent fallback hides dev misconfiguration; in dev the daemon should always be running (started by beforeDevCommand)
- **Where:** `desktop/src-tauri/src/main.rs:44-50`

#### Decision 5: Unified QRNotice replaces PasswordLoginScreen
- **Decision:** Remove `PasswordLoginScreen`; `LoginScreen` always renders `<QRNotice>` for non-Tauri browsers (both LAN and tunnel)
- **Rationale:** Token form is the attack surface; LAN access should use QR, same as tunnel; `isTunnelBrowser()` check removed (no longer needed)
- **Where:** `web-ui/src/components/auth/LoginScreen.tsx` — replace entire non-Tauri branch

#### Decision 6: Remove api.login() Tauri fallback
- **Decision:** Remove `api.login(injectedToken)` call from `useAuth.ts`; Tauri path only calls `api.checkAuth()`
- **Rationale:** If checkAuth() fails, the token is stale; user should relaunch the app rather than retry a token POST against a now-removed endpoint
- **Where:** `web-ui/src/hooks/useAuth.ts:38-46`

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does tsx handle daemon's native modules (node-pty, better-sqlite3) in dev? | Both are prebuilt binaries; tsx passes them through; should work but verify |
| 2 | `beforeDevCommand` CWD is `desktop/src-tauri/` — paths use `../../daemon/...` | Verified and corrected in 1.3 |
| 3 | cloudflared sidecar for prod — needs triple-suffixed binary in `binaries/` | Handled in `prep-sidecar.sh` step 2.2 |
| 4 | `concurrently` children (tsx watch) must die when `tauri dev` exits | Add `--kill-others-on-fail` flag to concurrently; prevents orphaned daemon on dev exit |
| 5 | `docker-compose.dev.yml` has `VST_NO_AUTH: "0"` (line 67) — must be `"1"` for agent sandbox | Fix in 3.3 |

## Implementation Phases

### Phase 1 — Root scripts + pnpm dev wiring

- [x] **1.1** `package.json` (root): change `dev` → `pnpm --filter @vibe-station/desktop dev`; change `build` → `pnpm --filter @vibe-station/desktop build`; add `"docker": "bash scripts/dev-sandbox.sh up"` — note: root `build` no longer calls cli/daemon transitively; prod build picks that up via prep-sidecar.sh
- [x] **1.2** Add `concurrently` and `tsx` to root `devDependencies`; run `pnpm install` — tsx is not currently a dependency anywhere in the workspace
- [x] **1.3** `desktop/src-tauri/tauri.conf.json`: update `beforeDevCommand` → `"concurrently \"pnpm --filter @vibestation/web dev -- --port 5180\" \"tsx --tsconfig ../../daemon/tsconfig.json ../../daemon/src/main.ts\""` — paths are relative to `desktop/src-tauri/` (tauri's cwd); package name is `@vibestation/web` not `web-ui`
- [x] **1.4** `desktop/src-tauri/src/main.rs`: wrap spawn_daemon failure in `#[cfg(debug_assertions)]` to panic with "daemon not found — is beforeDevCommand running?"; release builds keep the fallback
- [x] **1.5** Create `desktop/src-tauri/.gitignore` with `binaries/` entry (or add to root `.gitignore`)

- [ ] **1.T1** Manual — run `pnpm dev` from repo root; verify Tauri window opens and app loads without login screen
- [ ] **1.T2** Manual — edit a `web-ui/src` file; verify Vite HMR reloads without window restart
- [ ] **1.T3** Manual — edit `daemon/src/routes/health.ts`; verify daemon restarts and app reconnects

### Phase 2 — pnpm build (prod installer)

- [x] **2.1** Create `scripts/prep-sidecar.sh`: (a) detect host triple via `rustc -vV | grep host | awk '{print $2}'`; (b) run `pnpm --filter @vibestation/cli build` (required — `build-daemon-binary.sh` needs `cli/dist/daemon/main.js`); (c) run `scripts/build-daemon-binary.sh --target <triple>`; (d) `mkdir -p desktop/src-tauri/binaries`; (e) copy `dist/vst-daemon-<triple>` → `desktop/src-tauri/binaries/vst-daemon-<triple>` — triple suffix MUST be preserved exactly; Tauri resolves `externalBin: ["binaries/vst-daemon"]` → `vst-daemon-<triple>`
- [x] **2.2** `scripts/prep-sidecar.sh`: also download/copy cloudflared for the host triple to `desktop/src-tauri/binaries/cloudflared-<triple>` — check if `scripts/download-cloudflared.sh` exists and reuse its logic
- [x] **2.3** `desktop/src-tauri/tauri.conf.json`: update `beforeBuildCommand` → `"bash ../../scripts/prep-sidecar.sh && pnpm --filter @vibestation/web build"` — package name is `@vibestation/web`
- [x] **2.4** Make `prep-sidecar.sh` executable (`chmod +x`)

- [ ] **2.T1** Manual — run `pnpm build` from repo root; verify no errors and installer produced in `desktop/src-tauri/target/release/bundle/`
- [ ] **2.T2** Manual — check `desktop/src-tauri/binaries/` contains `vst-daemon-<triple>` and `cloudflared-<triple>`

### Phase 3 — pnpm docker

- [x] **3.1** Verify `scripts/dev-sandbox.sh up` works standalone (no changes needed if it does)
- [x] **3.2** `package.json` (root): confirm `"docker"` script added in 1.1; test invocation
- [x] **3.3** Confirm `docker-compose.dev.yml` has `VST_NO_AUTH: "1"` for agent testing (currently `"0"` — fix if needed)

- [ ] **3.T1** Manual — run `pnpm docker` from repo root; verify container starts, `http://localhost:<port>` loads with no login screen
- [ ] **3.T2** Manual — confirm `cliToken` is readable inside container at `~/.vibe-station/config.json`

### Phase 4 — Auth cleanup

- [x] **4.1** `daemon/src/routes/auth.ts`: remove the entire `POST /auth/login` route handler (lines 20–56); keep logout, check, revoke-browser; also remove `checkLoginRateLimit`/`resetLoginRateLimit` imports (they're exported from `daemon/src/auth.ts` and used only by this route)
- [x] **4.2** `daemon/src/server.ts`: remove `"POST /auth/login"` from the `AUTH_EXEMPT` list (line 35); remove the no-op stub `app.post("/auth/login", ...)` (line 193) used in no-auth mode
- [x] **4.3** `daemon/src/auth.ts`: remove `checkLoginRateLimit` and `resetLoginRateLimit` exports and their in-memory rate-limiter map if no other callers remain (grep first: `grep -r "checkLoginRateLimit\|resetLoginRateLimit" daemon/src`)
- [x] **4.4** `web-ui/src/components/auth/LoginScreen.tsx`: remove `PasswordLoginScreen` function and `isTunnelBrowser()` check; replace with single `QRNotice` component shown to all non-Tauri browsers; message: "Open the desktop app → Settings → Remote Access → Show QR"
- [x] **4.5** `web-ui/src/hooks/useAuth.ts`: remove `api.login(injectedToken)` call (lines 38–46); Tauri path only does `api.checkAuth()` → if false, set `authed: false`; assumption: `/auth/check` (line 74 of auth.ts) auto-passes loopback callers, so Tauri loopback always passes
- [x] **4.6** `web-ui/src/api/client.ts`: remove `login()` method (lines 1131–1138)
- [x] **4.7** Delete `web-ui/src/components/auth/LoginScreen.css` if it becomes empty/unused after removing the form styles (check first)

- [ ] **4.T1** Manual — open `http://localhost:7421` in a browser (non-Tauri); verify QRNotice shown, no form
- [ ] **4.T2** Manual — open Tauri app; verify it loads authenticated without hitting login screen
- [ ] **4.T3** Regression — tunnel URL (`.trycloudflare.com`); verify QRNotice still shown
- [ ] **4.T4** Unit — `LoginScreen.tsx`: verify component renders QRNotice for all non-Tauri cases

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `package.json` | Modified | 1.1 | `dev` → desktop filter, `build` → desktop filter, add `docker` script |
| `desktop/src-tauri/tauri.conf.json` | Modified | 1.3, 2.3 | `beforeDevCommand` (concurrently + tsx), `beforeBuildCommand` (prep-sidecar + vite build) |
| `desktop/src-tauri/src/main.rs` | Modified | 1.4 | Debug-mode panic on spawn_daemon failure |
| `desktop/src-tauri/.gitignore` | New | 1.5 | Ignore `binaries/` |
| `scripts/prep-sidecar.sh` | New | 2.1–2.2 | Detect triple, build + copy daemon binary + cloudflared to `binaries/` |
| `daemon/src/routes/auth.ts` | Modified | 4.1 | Remove `POST /auth/login` route + checkLoginRateLimit/resetLoginRateLimit imports |
| `daemon/src/server.ts` | Modified | 4.2 | Remove AUTH_EXEMPT entry + no-op stub for POST /auth/login |
| `daemon/src/auth.ts` | Modified | 4.3 | Remove checkLoginRateLimit/resetLoginRateLimit exports + rate-limiter map if no other callers |
| `web-ui/src/components/auth/LoginScreen.tsx` | Modified | 4.4 | Remove PasswordLoginScreen; unified QRNotice for all non-Tauri browsers |
| `web-ui/src/hooks/useAuth.ts` | Modified | 4.5 | Remove api.login() fallback; Tauri path: checkAuth() only |
| `web-ui/src/api/client.ts` | Modified | 4.6 | Remove login() method |
| `web-ui/src/components/auth/LoginScreen.css` | Modified/Deleted | 4.7 | Remove form-specific styles or delete if unused |

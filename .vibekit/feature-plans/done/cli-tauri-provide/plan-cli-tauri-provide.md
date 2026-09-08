---
Issue: N/A
Branch: cli-tauri-provide
Status: implementing
PRD: skipped
---

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: cli-tauri-provide

## Problem & Concept

- Agents have no guaranteed `vst` binary on PATH — the system prompt references `vst` ~20 times but no binary is bundled or injected
- `skill/SKILL.md` (full REST/WS reference) is never surfaced to agents or harness skill dirs
- `vst daemon start/stop/restart` are misleading and harmful when Tauri manages the daemon lifecycle
- `vst open` is a vestigial browser-launcher — needs to be a proper `code .` analog

---

## Requirements

| # | Requirement |
|---|-------------|
| R1 | `vst` binary available inside every agent terminal without extra install |
| R2 | `skill/SKILL.md` auto-registered into ACP catalog and harness skill dirs at daemon boot |
| R3 | `vst daemon start/stop/restart` removed; error messages direct users to the app |
| R4 | `~/.vibe-station/bin` prepended to PATH for all agent processes |
| R5 | `VST_SKILL_PATH` injected into every agent env |
| R6 | Shell configs patched on first daemon boot so `vst` works in any user terminal |
| R7 | `vst open <path>` upserts project + navigates Tauri window (or launches app if not running) |

---

## Change Map

```
scripts/
  prep-sidecar.sh               ~ add vst sidecar build step
desktop/src-tauri/
  tauri.conf.json               ~ add vst to externalBin + SKILL.md to resources
  capabilities/default.json     ~ add vst to shell:allow-execute allowlist
  src/daemon.rs                 ~ pass VST_CLI_BIN + VST_SKILL_PATH env vars
daemon/src/
  lib/
    resolveVstPaths.ts          + resolve binary + skill source paths
    harnessSkillDirs.ts         + config resolvers for ~/.claude/skills, ~/.gemini/skills
  services/
    context.ts                  ~ prepend ~/.vibe-station/bin to PATH + inject VST_SKILL_PATH
    config.ts                   ~ replace hardcoded defaultSkillPaths() with harnessSkillDirs
    userSkillCatalog.ts         ~ auto-register vst skill in catalog at boot
  assets/
    agent-system-prompt.md      ~ add $VST_SKILL_PATH pointer line
  routes/
    open.ts                     + POST /open with navigate replay buffer
cli/src/
  commands/
    open.ts                     ~ rewrite: path → POST /open + launch-if-not-running
    daemon/start.ts             - delete
    daemon/stop.ts              - delete
    daemon/restart.ts           - delete
  program.ts                    ~ remove start/stop/restart registrations
  lib/preflight.ts              ~ update daemon-not-running error messages
  commands/doctor.ts            ~ update daemon check message
```

| Today | After this plan |
|-------|-----------------|
| No `vst` binary in agent terminals | `vst` available via `~/.vibe-station/bin` shim, PATH-injected by daemon |
| `skill/SKILL.md` never surfaced to agents | Installed to `~/.vibe-station/skill/vst/SKILL.md`; `VST_SKILL_PATH` in every agent env |
| `skill/SKILL.md` not in harness skill dirs | Copied to `~/.claude/skills/vst/` and `~/.gemini/skills/vst/` on daemon boot |
| `vst daemon start/stop/restart` exist | Deleted; error messages direct to app |
| `vst open` opens a browser tab | `vst open <path>` upserts project + navigates Tauri window or launches app |
| `~/.vibe-station/bin` not on any PATH | Shell configs patched on first boot; agent PATH always includes it |

---

## Research

- `scripts/prep-sidecar.sh:47-62` — daemon built via `build-daemon-binary.sh`, then `cp` to `binaries/`; same pipeline for `vst` sidecar
- `desktop/src-tauri/tauri.conf.json:45` — `externalBin: ["binaries/vst-daemon", "binaries/cloudflared"]`; no `bundle.resources` exists yet
- `desktop/src-tauri/capabilities/default.json:14-19` — `shell:allow-execute` allow-list has `vst-daemon` + `cloudflared` sidecars
- `desktop/src-tauri/src/daemon.rs:101` — `.env("VST_CLOUDFLARED_BIN", cloudflared_str)` is the pattern for passing sidecar paths
- `daemon/src/services/context.ts:126-142` — `buildVstEnv()` builds VST-namespaced vars only; no PATH manipulation today
- `daemon/src/services/config.ts:59-64` — `defaultSkillPaths()` hardcodes `~/.claude/skills` + `~/.gemini/skills`; line 77 applies default
- `daemon/src/services/userSkillCatalog.ts:45-49` — `AcpCommandLike` shape; `getMergedSkillCatalog()` at lines 299-301 is what callers use
- `cli/src/program.ts:5-8,64-70` — imports + registers `registerDaemonStart/Stop/Restart/Status`; daemon group at line 64
- `cli/src/lib/preflight.ts:7,13,18` — three `die(...)` calls referencing `vst daemon start`/`restart`
- `cli/src/commands/doctor.ts:82-89` — daemon check prints `"Daemon is running"` label; no custom not-running string
- `cli/src/commands/open.ts:10,14-23` — reads `VST_UI_URL`, dispatches `open`/`xdg-open`/`start` on 29-line file
- `cli/src/commands/daemon/` — contains `start.ts`, `stop.ts`, `restart.ts`, `status.ts` (keep `status.ts`)

---

## Architecture Diagram

```mermaid
flowchart LR
  subgraph Tauri["Tauri app"]
    TR[tauri.conf.json\ncapabilities/default.json]
    DR[daemon.rs\nspawn_daemon()]
  end
  subgraph Daemon["daemon process"]
    RVP[resolveVstPaths.ts]
    HSD[harnessSkillDirs.ts]
    CTX[context.ts\nbuildVstEnv]
    CFG[config.ts\ndefaultSkillPaths]
    CAT[userSkillCatalog.ts]
    OPR[routes/open.ts]
  end
  subgraph FS["~/.vibe-station/"]
    BIN["bin/vst (shim)"]
    SKL["skill/vst/SKILL.md"]
  end
  subgraph Harness["~/.claude/skills/\n~/.gemini/skills/"]
    HSK["vst/SKILL.md"]
  end
  subgraph CLI["vst CLI"]
    OPN[commands/open.ts]
    PRE[lib/preflight.ts]
  end

  DR -->|VST_CLI_BIN\nVST_SKILL_PATH| Daemon
  RVP --> BIN
  RVP --> SKL
  HSD --> CFG
  HSD --> HSK
  CTX -->|PATH prepend\nVST_SKILL_PATH| AgentProcess[agent process]
  CAT -->|available_commands_update| AgentProcess
  OPR -->|WS navigate| TauriWindow[Tauri window\nReact hook]
  OPN -->|POST /open| OPR
```

---

## Design Details

### Critical User Journeys

**CUJ 1 — Agent uses `vst` inside terminal**
```
Agent terminal spawned by daemon
  → context.ts prepends ~/.vibe-station/bin to PATH
  → daemon boot already wrote ~/.vibe-station/bin/vst shim
  → agent runs `vst session ls` → shim proxies to native binary or node
  → command succeeds
```
- Edge: `VST_CLI_BIN` absent (dev) → shim uses `node cli/dist/main.js` fallback
- Edge: `~/.vibe-station/bin` not writable → daemon logs warning, agents fall back to no `vst`

**CUJ 2 — Agent reads full vst skill reference**
```
Agent spawned in Rich Chat
  → session/new ack includes ACP catalog entry { name: "vst", path: "~/.vibe-station/skill/vst/SKILL.md" }
  → agent invokes /vst or runs `cat $VST_SKILL_PATH`
  → reads REST API / WS protocol details
```
- Edge: skill file absent → catalog entry omitted; VST_SKILL_PATH still set but `cat` fails gracefully

**CUJ 3 — `vst open <path>` from terminal**
```
User runs `vst open /projects/myapp`
  → CLI resolves to absolute path
  → preflight checks daemon running → POST /open { path: "/projects/myapp" }
  → daemon upserts project → emits WS navigate event + stores 3s replay buffer
  → Tauri window receives navigate event → React hook calls router.push(/projects/<id>)
```
- Edge: daemon not running → CLI launches app (macOS: `open -a vibe-station`; Linux deb: `/usr/lib/vibe-station/vibe-station`) → polls `~/.vibe-station/config.json` up to 10s → retries POST /open
- Edge: window not yet connected → replay buffer delivers navigate on WS connect within 3s

**CUJ 4 — Shell PATH available after fresh app install**
```
User installs vibe-station .dmg / .deb
  → launches app → daemon boots for first time
  → daemon writes PATH shim lines to ~/.zshrc, ~/.bashrc, ~/.config/fish/config.fish
  → user opens new terminal → vst available
```
- Edge: fish shell — must use `fish_add_path` not `export PATH=...` (fish expands `$PATH` as space-list)
- Edge: file not writable → daemon logs warning, skips that shell config

### System Boundaries

**Tauri → Daemon: sidecar env vars**
```
main.rs: resolves vst_bin and skill_path via app_handle.path().resource_dir() (same pattern as cloudflared_bin)
daemon.rs: spawn_daemon(app, cloudflared_bin, vst_bin, skill_path) passes:
  VST_CLI_BIN    = vst_bin.to_str()        // absolute path inside .app bundle
  VST_SKILL_PATH = skill_path.to_str()     // bundled SKILL.md resource path
  (existing) VST_CLOUDFLARED_BIN = cloudflared_bin.to_str()
```

**Daemon → Agent process: env injection (context.ts)**
```
PATH = ~/.vibe-station/bin + ":" + process.env.PATH
VST_SKILL_PATH = ~/.vibe-station/skill/vst/SKILL.md
(all existing VST_* vars unchanged)
```

**CLI → Daemon: POST /open**
```
POST /open
  Body: { path: string }   // absolute filesystem path
  200: { projectId: string }
  400: { error: "path_not_found" | "path_not_directory" }
  401: UNAUTHORIZED (auth token required)
```

**Daemon → Tauri window: WS navigate event**
```
WS event: { type: "navigate", projectId: string }
Replay: stored for 3s after POST /open; replayed once to next connecting client
```

### Key Decisions

#### Decision 1: Shell shim writes to `~/.vibe-station/bin/vst`, not a symlink to the sidecar
- **Decision:** Write a `/bin/sh` script that execs the sidecar or `node main.js` rather than a direct symlink
- **Rationale:** Sidecar path is different per platform (`.app/Contents/MacOS/vst-aarch64-apple-darwin` on macOS, `/usr/lib/vibe-station/...` on Linux); shim is platform-agnostic and survives app updates without re-symlinking
- **Where:** `daemon/src/lib/resolveVstPaths.ts` (new file)

#### Decision 2: PATH injection in `context.ts`, not in individual plugin `getEnvironment()`
- **Decision:** Prepend `~/.vibe-station/bin` once in `buildVstEnv()` at `daemon/src/services/context.ts:132`
- **Rationale:** All plugins merge the result of `buildVstEnv()`; a single injection point is authoritative and avoids per-plugin drift — see AGENTS.md § Agent plugin invariant
- **Where:** `daemon/src/services/context.ts:132`

#### Decision 3: Harness skill dir resolvers replace hardcoded `defaultSkillPaths()`
- **Decision:** Extract `harnessSkillDirs.ts` with resolver array; `config.ts` imports it
- **Rationale:** Avoids hardcoding env-var names (`CLAUDE_CONFIG_DIR`, `GEMINI_CONFIG_DIR`) in two places; new harnesses (Aider, Cursor) add one resolver, not a config.ts edit
- **Where:** `daemon/src/lib/harnessSkillDirs.ts` (new) + `daemon/src/services/config.ts:59-64`

#### Decision 4: Navigate replay buffer is 3s, held in-memory on the daemon
- **Decision:** Store `lastNavigate = { projectId, expiresAt: Date.now() + 3000 }` in module-level variable; replay once per new WS connection if not expired
- **Rationale:** Avoids a race where POST /open fires before the Tauri window's WS connection is established; 3s covers normal window boot time without accumulating stale navigations
- **Where:** `daemon/src/routes/open.ts` (new)

#### Decision 5: `vst open` launch-if-not-running polls config.json, not a lock file
- **Decision:** Poll `~/.vibe-station/config.json` for `port` field up to 10s after launching the app
- **Rationale:** `config.json` is the existing daemon-ready signal (written after port bind); no new IPC needed
- **Where:** `cli/src/commands/open.ts`

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does `cli/`'s esbuild output use `"format": "cjs"`? | `@yao-pkg/pkg` requires CJS; confirm before Phase 1 |
| 2 | AppImage sidecar path at runtime | AppImage mounts squashfs; `resolveResource()` may not work — may need `process.env.APPIMAGE` + path walk |
| 3 | Fish shell PATH corruption | `fish_add_path` is the correct idiom; avoid `export PATH=...:$PATH` in fish configs |
| 4 | Version marker for idempotent harness skill install | Use a `# vst-skill-version: <semver>` comment at top of installed SKILL.md; overwrite only when version bumps |
| 5 | `vst open` on Linux AppImage — no `/usr/lib/vibe-station/` | Need `readlink /proc/self/exe` walk or `APPIMAGE` env var to find launcher |

---

## Implementation Phases

### Phase 1 — vst sidecar build + Tauri wiring

- [x] **1.1** `scripts/prep-sidecar.sh` — add `vst` pkg build after line 47 (parallel to daemon build):
  ```bash
  node_modules/.bin/pkg cli/dist/main.js \
    --target node18-linux-x64 \
    --output dist/vst-${TRIPLE}
  cp dist/vst-${TRIPLE} desktop/src-tauri/binaries/vst-${TRIPLE}
  chmod +x desktop/src-tauri/binaries/vst-${TRIPLE}
  ```
- [x] **1.2** Confirm `cli/` esbuild config has `"format": "cjs"` — check `cli/package.json` or `cli/esbuild.config.*`
  > CLI uses ESM ("type":"module") but build-daemon-binary.sh's esbuild step converts to CJS for pkg. Same pattern used here.
- [x] **1.3** `desktop/src-tauri/tauri.conf.json:45` — add `"binaries/vst"` to `externalBin` array
- [x] **1.4** `desktop/src-tauri/tauri.conf.json` — add `bundle.resources` key: `["../../skill/SKILL.md"]`
- [x] **1.5** `desktop/src-tauri/capabilities/default.json:16-19` — add `{ "name": "vst", "sidecar": true }` to allow list
- [x] **1.6** `desktop/src-tauri/src/main.rs:17-30` — resolve `vst_bin` and `skill_path` using the same `resource_dir()` pattern as `cloudflared_bin`:
  ```rust
  let vst_bin: PathBuf = app_handle.path().resource_dir().ok()
      .map(|dir| dir.join(if cfg!(target_os="windows") {"vst.exe"} else {"vst"}))
      .unwrap_or_else(|| PathBuf::from("vst"));
  let skill_path: PathBuf = app_handle.path().resource_dir().ok()
      .map(|dir| dir.join("SKILL.md"))
      .unwrap_or_else(|| PathBuf::from("SKILL.md"));
  ```
  Then at `main.rs:39` pass both to `spawn_daemon`:
  ```rust
  match daemon::spawn_daemon(&app_handle, &cloudflared_bin, &vst_bin, &skill_path) {
  ```
- [x] **1.6b** `desktop/src-tauri/src/daemon.rs:78-80` — extend `spawn_daemon()` signature and `.env()` chain:
  ```rust
  pub fn spawn_daemon(
      app: &AppHandle,
      cloudflared_bin: &Path,
      vst_bin: &Path,
      skill_path: &Path,
  ) -> Result<DaemonInfo, String> {
  ```
  After line 101 (`.env("VST_CLOUDFLARED_BIN", cloudflared_str)`), add:
  ```rust
  .env("VST_CLI_BIN", vst_bin.to_str().ok_or("vst_bin path not UTF-8")?)
  .env("VST_SKILL_PATH", skill_path.to_str().ok_or("skill_path not UTF-8")?)
  ```

**Verify phase 1:**
- [ ] **1.T1** Manual — `scripts/prep-sidecar.sh` completes without error; `desktop/src-tauri/binaries/vst-*` exists
- [ ] **1.T2** Manual — `cargo tauri build --debug` succeeds; no missing sidecar error
- [ ] **1.T3** Manual — running daemon from Tauri dev has `VST_CLI_BIN` + `VST_SKILL_PATH` in its env (`echo $VST_CLI_BIN` from daemon log)

---

### Phase 2 — Skill + PATH infrastructure

- [x] **2.1** Create `daemon/src/lib/resolveVstPaths.ts`:
- [x] **2.2** `daemon/src/main.ts:153` — after `acquireLock()`, call a new `setupVstEnvironment()` function (create in `daemon/src/lib/resolveVstPaths.ts`) that writes `~/.vibe-station/bin/vst` shim
- [x] **2.3** `daemon/src/main.ts:153` — in the same `setupVstEnvironment()` call, copy skill source to `~/.vibe-station/skill/vst/SKILL.md` (atomic: `fs.writeFile` to `.tmp`, `fs.rename`)
- [x] **2.4** `daemon/src/services/context.ts:132` — in `buildVstEnv()`, add PATH prepend + VST_SKILL_PATH
- [x] **2.5** `daemon/src/assets/agent-system-prompt.md:166` — append line:
  ```
  The full `vst` CLI reference (REST API, WS protocol, advanced patterns) is at $VST_SKILL_PATH — read it when you need detail beyond what's listed above.
  ```

**Verify phase 2:**
- [ ] **2.T1** Manual — after daemon boot, `~/.vibe-station/bin/vst` exists and is executable
- [ ] **2.T2** Manual — `~/.vibe-station/skill/vst/SKILL.md` exists after daemon boot
- [ ] **2.T3** Integration — spawn an agent session; confirm `VST_SKILL_PATH` and modified `PATH` are present in the spawned process env
- [ ] **2.T4** Integration — inside agent terminal, run `vst --version` → succeeds

---

### Phase 3 — Harness skill dirs + ACP catalog

- [ ] **3.1** Create `daemon/src/lib/harnessSkillDirs.ts`:
  ```ts
  import os from "os";
  import path from "path";

  export const HARNESS_SKILL_RESOLVERS: Array<() => string> = [
    () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "skills"),
    () => path.join(process.env.GEMINI_CONFIG_DIR ?? path.join(os.homedir(), ".gemini"), "skills"),
  ];

  export function resolveHarnessSkillDirs(): string[] {
    return HARNESS_SKILL_RESOLVERS.map((r) => r());
  }
  ```
- [x] **3.2** `daemon/src/services/config.ts:59-64` — replace `defaultSkillPaths()` body with `return resolveHarnessSkillDirs()` (import from `../lib/harnessSkillDirs`)
- [x] **3.3** At daemon boot (after step 2.3), install `~/.vibe-station/skill/vst/SKILL.md` to each harness skill dir as `<dir>/vst/SKILL.md`:
  - Read first line of existing file; skip overwrite if `# vst-skill-version: <x>` matches current version
  - Write with version marker on first line
- [x] **3.4** `daemon/src/main.ts` — include `~/.vibe-station/skill` in `setSkillPaths()` call so scanner picks up `~/.vibe-station/skill/vst/SKILL.md` as skill `vst`

**Verify phase 3:**
- [ ] **3.T1** Manual — after daemon boot, `~/.claude/skills/vst/SKILL.md` exists
- [ ] **3.T2** Manual — after daemon boot, `~/.gemini/skills/vst/SKILL.md` exists (create `~/.gemini/skills/` if needed)
- [ ] **3.T3** Integration — start a Rich Chat session; ACP `available_commands_update` catalog includes `{ name: "vst" }` entry (check daemon debug logs)
- [ ] **3.T4** Regression — existing user skill dirs (`~/.claude/skills/`) still scanned; other skills still appear in autocomplete

---

### Phase 4 — Remove daemon start/stop/restart

- [x] **4.1** Delete `cli/src/commands/daemon/start.ts`
- [x] **4.2** Delete `cli/src/commands/daemon/stop.ts`
- [x] **4.3** Delete `cli/src/commands/daemon/restart.ts`
- [x] **4.4** `cli/src/program.ts:5-8` — remove imports of `registerDaemonStart`, `registerDaemonStop`, `registerDaemonRestart`
- [x] **4.5** `cli/src/program.ts:67-70` — remove calls to `registerDaemonStart(daemon)`, `registerDaemonStop(daemon)`, `registerDaemonRestart(daemon)`
- [x] **4.6** `cli/src/lib/preflight.ts:7,13,18` — replace all three `die()` messages:
  - `"Daemon is not running. Run \`vst daemon start\`."` → `"Daemon is not running. Open the vibe-station app to start it."`
  - `"Daemon is not responding. Run \`vst daemon restart\`."` → `"Daemon is not responding. Restart the vibe-station app."`
- [x] **4.7** Verified — `cli/src/commands/doctor.ts:82-89` does not reference `vst daemon start` (no change needed)

**Verify phase 4:**
- [ ] **4.T1** Unit — `vst daemon --help` no longer lists `start`, `stop`, or `restart` subcommands
- [ ] **4.T2** Manual — `vst daemon start` → `error: unknown command 'start'`
- [ ] **4.T3** Manual — with daemon not running, any `vst session ls` shows updated "Open the vibe-station app" message
- [ ] **4.T4** Regression — `vst daemon status` still works

---

### Phase 5 — PATH install for end users

- [x] **5.1** At daemon first boot (gate: `~/.vibe-station/.shell-path-installed` absent), append to shell configs (implemented in `patchShellConfigs()` in `resolveVstPaths.ts`)
- [ ] **5.2** (Option B) `desktop/src-tauri/tauri.conf.json` — add `postInstallScript` for `.deb`/`.rpm`:
  > **DEFERRED** — requires Tauri packaging research (postInstallScript support varies by target).
  ```bash
  #!/bin/sh
  ln -sf /usr/lib/vibe-station/vst-x86_64-unknown-linux-gnu /usr/local/bin/vst
  ```

**Verify phase 5:**
- [ ] **5.T1** Manual — fresh daemon boot creates `~/.vibe-station/.shell-path-installed`
- [ ] **5.T2** Manual — `~/.zshrc` contains `~/.vibe-station/bin` PATH line; second boot does NOT append again
- [ ] **5.T3** Manual — open a new terminal shell after boot; `which vst` resolves to shim
- [ ] **5.T4** Manual — fish config gets `fish_add_path` (not `export PATH=...`) line

---

### Phase 6 — `vst open <path>`

- [x] **6.1** Create `daemon/src/routes/open.ts` — POST /open, project upsert, navigate broadcast, 3s replay buffer
- [x] **6.2** Register `POST /open` route in `server.ts`
- [x] **6.3** `web-ui/src/api/types.ts` — add `navigate` to WSEvent union. `ws/protocol.ts` — add NavigateEvent to ServerMessage. `App.tsx` — subscribe to `navigate` WS event via `api.on("navigate", ...)` using `useNavigate()` hook.
  > Note: navigate goes to `/` (dashboard) instead of `/projects/:id` since no project-specific route exists
- [x] **6.4** Rewrite `cli/src/commands/open.ts`:
  ```ts
  // resolve target to absolute path
  // call preflight() — checks daemon running
  // POST /open { path: absolutePath }
  // if daemon not running:
  //   macOS: execSync('open -a "vibe-station"')
  //   Linux deb/rpm: execFileSync('/usr/lib/vibe-station/vibe-station')
  //   poll ~/.vibe-station/config.json for port up to 10s
  //   retry POST /open
  ```

**Verify phase 6:**
- [ ] **6.T1** Integration — `vst open .` from a project dir → Tauri window navigates to that project
- [ ] **6.T2** Integration — `vst open <path>` with daemon not running → app launches, window opens, navigates to project
- [ ] **6.T3** Integration — `vst open <path>` with app running but window just opened → replay buffer delivers navigate within 3s
- [ ] **6.T4** Manual — `vst open /nonexistent` → clear error, no crash
- [ ] **6.T5** Regression — `vst open` with no args → usage error (no browser tab opened)

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `scripts/prep-sidecar.sh` | Modified | 1.1 | Add `vst` pkg build + cp step after daemon build |
| `desktop/src-tauri/tauri.conf.json` | Modified | 1.3, 1.4 | Add `"binaries/vst"` to `externalBin`; add `bundle.resources` for SKILL.md |
| `desktop/src-tauri/capabilities/default.json` | Modified | 1.5 | Add `{ "name": "vst", "sidecar": true }` to `shell:allow-execute` allow-list |
| `desktop/src-tauri/src/daemon.rs` | Modified | 1.6 | Pass `VST_CLI_BIN` + `VST_SKILL_PATH` env vars in `spawn_daemon()` |
| `daemon/src/lib/resolveVstPaths.ts` | New | 2.1 | Contract: `resolveVstCliBinSource(): string \| undefined`, `resolveVstSkillSource(): string \| undefined` |
| `daemon/src/lib/harnessSkillDirs.ts` | New | 3.1 | Contract: `resolveHarnessSkillDirs(): string[]`; `HARNESS_SKILL_RESOLVERS` array |
| `daemon/src/services/context.ts` | Modified | 2.4 | Add PATH prepend + `VST_SKILL_PATH` to `buildVstEnv()` return at line 132 |
| `daemon/src/services/config.ts` | Modified | 3.2 | Replace `defaultSkillPaths()` body (lines 59-64) with `resolveHarnessSkillDirs()` import |
| `daemon/src/services/userSkillCatalog.ts` | Modified | 3.4 | Add `vst` skill entry before ACP `available_commands_update` is sent |
| `daemon/src/assets/agent-system-prompt.md` | Modified | 2.5 | Append `$VST_SKILL_PATH` pointer line at line 167 |
| `daemon/src/routes/open.ts` | New | 6.1, 6.2 | Contract: `POST /open { path: string } → 200 { projectId } \| 400 \| 401`; owns `lastNavigate` replay buffer |
| `cli/src/commands/open.ts` | Modified | 6.4 | Rewrite: resolve path → `POST /open` + launch-if-not-running; old `xdg-open` logic deleted |
| `cli/src/commands/daemon/start.ts` | Deleted | 4.1 | — |
| `cli/src/commands/daemon/stop.ts` | Deleted | 4.2 | — |
| `cli/src/commands/daemon/restart.ts` | Deleted | 4.3 | — |
| `cli/src/program.ts` | Modified | 4.4, 4.5 | Remove `registerDaemonStart/Stop/Restart` imports (lines 5-8) + calls (lines 67-70) |
| `cli/src/lib/preflight.ts` | Modified | 4.6 | Replace 3 `die()` messages at lines 7, 13, 18 with app-directed wording |
| `web-ui/src/api/client.ts` | Modified | 6.3 | Handle `navigate` WS event at line 173; call `router.push(/projects/${projectId})` |
| `cli/src/commands/doctor.ts` | Modified | 4.7 | Update daemon check message at lines 82-89 |

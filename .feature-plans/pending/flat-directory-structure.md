# Feature Plan: Flat Directory Structure Restructure

> Move from `apps/cli` + `apps/web` to flat siblings `cli/`, `daemon/`, `web-ui/` at the repo root, with `daemon/` as a TypeScript-only project (no `package.json`) compiled into `cli/dist/` via TS project references.

**Issue:** —
**Branch:** `directory-structure`
**Status:** Pending
**PRD:** —

**Reference files:**
- CLI entry: `apps/cli/src/main.ts`
- Daemon entry: `apps/cli/src/daemon/main.ts`
- Daemon spawn: `apps/cli/src/commands/daemon/start.ts`
- Daemon paths lib: `apps/cli/src/daemon/services/paths.ts`
- CLI tsconfig: `apps/cli/tsconfig.json`
- Root tsconfig: `tsconfig.base.json`
- Workspace config: `pnpm-workspace.yaml`
- Docker: `dev.Dockerfile`, `docker-compose.dev.yml`

---

## Problem

- `apps/cli/` conflates two distinct concerns: CLI commands and the daemon HTTP server
- No visual separation between the CLI binary layer and the background daemon
- `apps/` and `packages/` workspace directories are framework boilerplate, not meaningful to this project

## Concept

- Three sibling directories at the repo root: `cli/`, `daemon/`, `web-ui/`
- `daemon/` is NOT a pnpm workspace package — it has only a `tsconfig.json`; its output goes directly into `cli/dist/daemon/` via TypeScript project references
- `cli/` remains the sole Node package for the CLI side; it references `daemon/` as a TS project reference, so `tsc -b` in `cli/` builds daemon first then CLI in one step
- The daemon binary path resolution in `commands/daemon/start.ts` is **unchanged** — it computes `join(here, "..", "..", "daemon", "main.js")` from `cli/dist/commands/daemon/start.js` → `cli/dist/daemon/main.js` ✅
- Zero cross-boundary source imports: the one CLI→daemon import (`daemonLogPath`) is moved to `cli/src/lib/paths.ts`

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `cli/`, `daemon/`, `web-ui/` exist as siblings at repo root |
| 2 | `daemon/` has no `package.json`; all daemon tests run via CLI's vitest |
| 3 | `tsc -b` (or `pnpm --filter @vibestation/cli build`) compiles both daemon and CLI in one invocation |
| 4 | `daemon/dist/` does NOT exist — daemon output lands in `cli/dist/daemon/` |
| 5 | All existing tests pass with no logic changes |
| 6 | Docker dev sandbox works with updated paths |

---

## Research

### Cross-boundary imports (CLI → Daemon)

- **Only one confirmed:** `apps/cli/src/commands/daemon/start.ts:8` imports `daemonLogPath` from `../../daemon/services/paths.js`
- `daemonLogPath()` = `join(homedir(), ".vibe-station", "logs", "daemon.log")` — trivially moveable
- All other `commands/` files import from `lib/` (daemon-client, daemon-url) or use HTTP — no daemon source coupling
- `daemon-url.ts` already hardcodes the config path inline — no import from daemon/services/paths.ts
- **Fix:** add `daemonLogPath()` to new `cli/src/lib/paths.ts`; daemon's `paths.ts` keeps its own copy (acceptable 3-line duplication)

### Daemon spawn path

- `apps/cli/src/commands/daemon/start.ts:11–12`:
  ```ts
  const here = dirname(fileURLToPath(import.meta.url));
  const DAEMON_MAIN = join(here, "..", "..", "daemon", "main.js");
  ```
- Resolves at runtime to `cli/dist/daemon/main.js` — **unchanged** after restructure because daemon output still lands in `cli/dist/daemon/`

### Asset path inside daemon

- `apps/cli/src/daemon/services/promptBuilder.ts` computes: `join(here, "..", "assets", "agent-system-prompt.md")`
- At runtime from `cli/dist/daemon/services/promptBuilder.js` → `cli/dist/daemon/assets/agent-system-prompt.md`
- **Unchanged** — daemon relative asset path works as long as the cpSync destination remains `dist/daemon/assets` (only the source path in the build script changes)

### TypeScript project references mechanism

- `daemon/tsconfig.json`: `composite: true`, `declaration: true`, `outDir: "../cli/dist/daemon"`, `tsBuildInfoFile: "./.tsbuildinfo"` — keeps build info out of dist
- `cli/tsconfig.json`: adds `"references": [{ "path": "../daemon" }]`; `rootDir` stays `"src"`, `outDir` stays `"dist"`
- `tsc -b cli/` builds daemon first → `cli/dist/daemon/`, then CLI → `cli/dist/`
- `declaration: true` in daemon produces `.d.ts` files in `cli/dist/daemon/` — harmless, CLI has no consumers of these types at source level

### Daemon tests type-checking

- Daemon `__tests__` are excluded from `daemon/tsconfig.json` (avoids test deps polluting composite build)
- After move they land in `daemon/src/__tests__/` — outside `cli/src/`, so `cli/tsconfig.json` (rootDir: src) cannot include them
- **Fix:** add `daemon/tsconfig.test.json` (non-composite, noEmit, includes tests) for type-checking only; vitest resolves TS via its own transform so tests still run from CLI's vitest config

### Daemon tests vitest

- Currently covered by CLI's vitest via `src/**/__tests__/**`
- After move: live in `daemon/src/__tests__/` — outside `cli/src/`
- **Fix:** CLI's `vitest.config.ts` widens include to `"../daemon/src/**/__tests__/**/*.{test,spec}.ts"`

### Relative config paths that change

- All `tsconfig.json` files currently `extends: "../../tsconfig.base.json"` → becomes `"../tsconfig.base.json"` (moving from `apps/*/` depth to root-level siblings)
- `apps/web/package.json` lint script: `eslint --config ../../eslint.config.mjs` → `../eslint.config.mjs`
- `apps/cli/package.json` lint script: same fix
- `apps/web/tsconfig.json` and `tsconfig.node.json`: same `extends` fix

### Docker

- `dev.Dockerfile` CMD: `node apps/cli/dist/daemon/main.js` → `node cli/dist/daemon/main.js`
- `docker-compose.dev.yml` volume mounts (both lines, both host AND container sides):
  - `./apps/web/src:/app/apps/web/src:ro` → `./web-ui/src:/app/web-ui/src:ro`
  - `./apps/web/public:/app/apps/web/public:ro` → `./web-ui/public:/app/web-ui/public:ro`

### ESLint + root scripts

- `eslint.config.mjs:12`: `apps/web/**/*.{ts,tsx}` → `web-ui/**/*.{ts,tsx}`
- `package.json` lint script: `apps/web/src apps/web/e2e` → `web-ui/src web-ui/e2e`
- `pnpm-workspace.yaml`: `["apps/*", "packages/*"]` → `["cli", "web-ui"]`

### Sequencing constraint (critical)

- `pnpm --filter @vibestation/cli build` requires pnpm to know about `cli/` — only works after `pnpm-workspace.yaml` is updated AND `apps/` is removed AND `pnpm install` is re-run
- Correct order: scaffold → move sources → update all configs → rm apps/ → pnpm install → build verify → test

---

## Approach

### Architecture

```
repo root
├── cli/            @vibestation/cli (package.json + tsconfig.json)
│   ├── src/        commands/, lib/, main.ts, program.ts
│   └── dist/
│       ├── commands/
│       ├── lib/
│       ├── main.js
│       └── daemon/  ← daemon source compiles HERE (outDir in daemon/tsconfig.json)
├── daemon/         no package.json — tsconfig.json + tsconfig.test.json only
│   └── src/        main.ts, server.ts, routes/, services/, ws/, types.ts, assets/, __tests__/
├── web-ui/         @vibestation/web (package.json + tsconfig.json)
│   └── src/
└── pnpm-workspace.yaml  ["cli", "web-ui"]
```

### daemon/tsconfig.json

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "tsBuildInfoFile": "./.tsbuildinfo",
    "rootDir": "src",
    "outDir": "../cli/dist/daemon",
    "noEmit": false,
    "types": ["node", "vitest/globals"],
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
}
```

### daemon/tsconfig.test.json

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true
  },
  "include": ["src"]
}
```

### cli/tsconfig.json

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "noEmit": false,
    "types": ["node", "vitest/globals"],
    "resolveJsonModule": true
  },
  "references": [{ "path": "../daemon" }],
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
}
```

### cli/src/lib/paths.ts (new)

```ts
import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.vibe-station/logs/daemon.log */
export function daemonLogPath(): string {
  return join(homedir(), ".vibe-station", "logs", "daemon.log");
}
```

---

## Files to Modify / Create / Delete

| File | Change |
|------|--------|
| `daemon/tsconfig.json` | **Create** — composite TS project, `outDir: "../cli/dist/daemon"`, `tsBuildInfoFile` |
| `daemon/tsconfig.test.json` | **Create** — non-composite, includes tests, noEmit |
| `daemon/src/**` | **Move** from `apps/cli/src/daemon/` |
| `cli/package.json` | **Create** from `apps/cli/package.json`; fix asset cpSync source + lint `--config` path |
| `cli/tsconfig.json` | **Create** from `apps/cli/tsconfig.json`; fix `extends` + add `references` |
| `cli/vitest.config.ts` | **Create** from `apps/cli/vitest.config.ts`; widen `include` glob |
| `cli/src/**` | **Move** from `apps/cli/src/{commands,lib,main.ts,program.ts,__tests__}` |
| `cli/src/lib/paths.ts` | **Create** — `daemonLogPath()` helper |
| `cli/src/commands/daemon/start.ts` | Fix one import: `../../daemon/services/paths.js` → `../../lib/paths.js` |
| `web-ui/` | **Move** from `apps/web/`; fix `extends` in tsconfigs + lint `--config` in package.json |
| `pnpm-workspace.yaml` | `["apps/*","packages/*"]` → `["cli","web-ui"]` |
| `package.json` (root) | Fix lint script: `apps/web/src apps/web/e2e` → `web-ui/src web-ui/e2e` |
| `eslint.config.mjs` | Fix file glob: `apps/web/**` → `web-ui/**` |
| `dev.Dockerfile` | Fix CMD: `apps/cli/dist/daemon/main.js` → `cli/dist/daemon/main.js` |
| `docker-compose.dev.yml` | Fix both volume mounts (host + container sides) |
| `apps/` | **Delete** entirely — after all moves and config updates |

## Risks / Open Questions

| # | Risk | Resolution |
|---|------|------------|
| 1 | **pnpm-lock.yaml churn** | Regenerated by `pnpm install` after `rm -rf apps/` |
| 2 | **stale `.tsbuildinfo` files** | Cleared in Phase 5.1 before build |
| 3 | **`.d.ts` files in `cli/dist/daemon/`** | Harmless; no consumers at source level |
| 4 | **`moduleResolution: "bundler"` in base tsconfig** | Pre-existing, works today, unchanged |
| 5 | **Cross-boundary imports** | Confirmed by grep: only one (`daemonLogPath`) — resolved by Phase 2.6–2.7 |
| 6 | **Daemon test type-checking orphaned** | Resolved by `daemon/tsconfig.test.json` |
| 7 | **`pnpm install` ordering** | Always `rm -rf apps/` first, then `pnpm install` — avoids dual install |

---

## Implementation Phases

---

### Phase 1 — Scaffold new directories + configs (no source moves yet)

- [ ] **1.1** `mkdir -p cli/src daemon/src`
- [ ] **1.2** Copy `apps/cli/package.json` → `cli/package.json`; apply two edits:
  - Build script: `cpSync('src/daemon/assets'` → `cpSync('../daemon/src/assets'` (source only; dest `dist/daemon/assets` unchanged)
  - Lint script: `../../eslint.config.mjs` → `../eslint.config.mjs`
- [ ] **1.3** Copy `apps/cli/vitest.config.ts` → `cli/vitest.config.ts`; add to `include`:
  - `"../daemon/src/**/__tests__/**/*.{test,spec}.ts"`
- [ ] **1.4** Create `cli/tsconfig.json` (extends `"../tsconfig.base.json"`, adds `references`, see template above)
- [ ] **1.5** Create `daemon/tsconfig.json` (composite, `tsBuildInfoFile`, see template above)
- [ ] **1.6** Create `daemon/tsconfig.test.json` (non-composite, noEmit, see template above)
- [ ] **1.7** Copy `apps/web/` → `web-ui/` (full directory copy, excluding `node_modules` and `dist`); then fix in `web-ui/`:
  - `package.json` lint script: `../../eslint.config.mjs` → `../eslint.config.mjs`
  - `tsconfig.json`: `"../../tsconfig.base.json"` → `"../tsconfig.base.json"`
  - `tsconfig.node.json`: same `extends` fix

**Verify phase 1:**
- [ ] **1.T1** `ls cli/ daemon/ web-ui/` — all three exist with expected sub-dirs
- [ ] **1.T2** `grep "cpSync" cli/package.json` — shows `../daemon/src/assets` as source, `dist/daemon/assets` as dest
- [ ] **1.T3** `grep "tsBuildInfoFile" daemon/tsconfig.json` — present
- [ ] **1.T4** `grep "extends" web-ui/tsconfig.json` — shows `../tsconfig.base.json`

---

### Phase 2 — Move all source files

- [ ] **2.1** Move `apps/cli/src/daemon/` → `daemon/src/` (all subdirs and files)
- [ ] **2.2** Move `apps/cli/src/commands/` → `cli/src/commands/`
- [ ] **2.3** Move `apps/cli/src/lib/` → `cli/src/lib/`
- [ ] **2.4** Move `apps/cli/src/main.ts`, `apps/cli/src/program.ts` → `cli/src/`
- [ ] **2.5** Move `apps/cli/src/__tests__/` → `cli/src/__tests__/`
- [ ] **2.6** Create `cli/src/lib/paths.ts` with `daemonLogPath()` (see template above)
- [ ] **2.7** In `cli/src/commands/daemon/start.ts`: change import `../../daemon/services/paths.js` → `../../lib/paths.js`

**Verify phase 2:**
- [ ] **2.T1** `grep -r "from.*daemon/services/paths" cli/src/` — zero matches
- [ ] **2.T2** `grep -r "from.*\.\./\.\./daemon" cli/src/commands/` — zero matches
- [ ] **2.T3** `ls daemon/src/` — contains `main.ts`, `server.ts`, `routes/`, `services/`, `ws/`, `types.ts`, `__tests__/`, `assets/`

---

### Phase 3 — Update workspace, root configs, and Docker

- [ ] **3.1** Update `pnpm-workspace.yaml`: replace contents with `packages: ["cli", "web-ui"]`
- [ ] **3.2** Update root `package.json` lint script: `apps/web/src apps/web/e2e` → `web-ui/src web-ui/e2e`
- [ ] **3.3** Update `eslint.config.mjs:12`: `apps/web/**/*.{ts,tsx}` → `web-ui/**/*.{ts,tsx}`
- [ ] **3.4** Update `dev.Dockerfile` CMD: `apps/cli/dist/daemon/main.js` → `cli/dist/daemon/main.js`
- [ ] **3.5** Update `docker-compose.dev.yml` — both volume mount lines (host path AND container path):
  - `./apps/web/src:/app/apps/web/src:ro` → `./web-ui/src:/app/web-ui/src:ro`
  - `./apps/web/public:/app/apps/web/public:ro` → `./web-ui/public:/app/web-ui/public:ro`

**Verify phase 3:**
- [ ] **3.T1** `cat pnpm-workspace.yaml` — shows only `cli` and `web-ui`
- [ ] **3.T2** `grep "apps/" docker-compose.dev.yml` — zero matches

---

### Phase 4 — Delete old directories and reinstall

- [ ] **4.1** `rm -rf apps/` — sources already moved in Phase 2; configs updated in Phase 3
- [ ] **4.2** `pnpm install` from repo root — regenerates `pnpm-lock.yaml` with new workspace paths

**Verify phase 4:**
- [ ] **4.T1** `ls apps/ 2>&1` — "No such file or directory"
- [ ] **4.T2** `pnpm ls -r --depth 0` — lists `@vibestation/cli` (at `cli/`) and `@vibestation/web` (at `web-ui/`)

---

### Phase 5 — Build and full test verification

- [ ] **5.1** `rm -f cli/tsconfig.tsbuildinfo daemon/.tsbuildinfo` — clear any stale build info
- [ ] **5.2** `pnpm --filter @vibestation/cli build` — builds daemon first (project ref), then CLI
- [ ] **5.3** Verify `cli/dist/daemon/main.js` exists
- [ ] **5.4** Verify `cli/dist/commands/daemon/start.js` exists
- [ ] **5.5** Verify `cli/dist/daemon/assets/agent-system-prompt.md` exists

**Verify phase 5:**
- [ ] **5.T1** `node cli/dist/main.js --help` — CLI responds correctly
- [ ] **5.T2** `pnpm --filter @vibestation/cli test` — all daemon + CLI unit tests pass
- [ ] **5.T3** `pnpm --filter @vibestation/web build` — web build passes
- [ ] **5.T4** `pnpm typecheck` — passes for both packages
- [ ] **5.T5** `pnpm lint` — clean

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/tsconfig.json` | 1.5 | Create — composite TS project |
| `daemon/tsconfig.test.json` | 1.6 | Create — non-composite for test type-checking |
| `cli/package.json` | 1.2 | Create from `apps/cli/package.json`; fix two paths |
| `cli/tsconfig.json` | 1.4 | Create; fix `extends` + add `references` |
| `cli/vitest.config.ts` | 1.3 | Create; widen `include` |
| `web-ui/` | 1.7 | Copy of `apps/web/`; fix `extends` + lint path |
| `daemon/src/**` | 2.1 | Moved from `apps/cli/src/daemon/` |
| `cli/src/commands/**` | 2.2 | Moved from `apps/cli/src/commands/` |
| `cli/src/lib/**` | 2.3 | Moved from `apps/cli/src/lib/` |
| `cli/src/main.ts` + `program.ts` | 2.4 | Moved — no content change |
| `cli/src/__tests__/**` | 2.5 | Moved from `apps/cli/src/__tests__/` |
| `cli/src/lib/paths.ts` | 2.6 | Create — `daemonLogPath()` helper |
| `cli/src/commands/daemon/start.ts` | 2.7 | Fix one import |
| `pnpm-workspace.yaml` | 3.1 | `["cli","web-ui"]` |
| `package.json` (root) | 3.2 | Fix lint script |
| `eslint.config.mjs` | 3.3 | Fix file glob |
| `dev.Dockerfile` | 3.4 | Fix daemon binary path |
| `docker-compose.dev.yml` | 3.5 | Fix both volume mounts |
| `apps/` | 4.1 | Delete entirely |

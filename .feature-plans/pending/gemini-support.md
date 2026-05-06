# Feature Plan: Gemini CLI Support ✦

> Add Google Gemini CLI as a supported agent **and** refactor CLI registration so that adding any future CLI (ampcode, etc.) requires only: (1) a new plugin file and (2) one line in `PLUGIN_MAP` — nothing else.

**Issue:** gemini-support-may06
**Branch:** `gemini-support-may06`
**Status:** WIP
**PRD:** n/a

**Reference files:**
- Plugin registry (becomes single source of truth): `daemon/src/agent-plugins/registry.ts`
- Plugin interface: `daemon/src/services/spawn.ts:29–71`
- `CliId` type (daemon): `daemon/src/types.ts:6`
- `CliId` type (web-ui): `web-ui/src/api/types.ts:47`
- Hardcoded Zod enums: `daemon/src/routes/modes.ts:59,68,128`
- OpenCode plugin (closest analogue): `daemon/src/agent-plugins/opencode.ts`
- Claude plugin: `daemon/src/agent-plugins/claude.ts`
- NewModeDialog CLI radios: `web-ui/src/components/dialogs/NewModeDialog.tsx:9–152`
- EditModeDialog CLI radios: `web-ui/src/components/dialogs/EditModeDialog.tsx:5–110`
- Web API client: `web-ui/src/api/client.ts`
- Mock API: `web-ui/src/api/mock.ts:455–471`
- Plugin tests: `daemon/src/__tests__/plugins.test.ts`

---

## Problem

- `gemini` CLI not supported at all
- Every supported CLI is hardcoded in **four separate places**: `types.ts`, `registry.ts` (array + switch), three Zod enums in `modes.ts`, web-UI type + two dialog components — adding ampcode means touching 7–8 files
- `defaultModelForCli()` hardcoded switch in both dialogs must be kept in sync manually

## Concept

**`PLUGIN_MAP` in `registry.ts` is the one and only registration point.**

```ts
// registry.ts — target state
const PLUGIN_MAP = {
  claude:   createClaudePlugin,
  cursor:   createCursorPlugin,
  opencode: createOpencodePlugin,
  gemini:   createGeminiPlugin,
} as const satisfies Record<string, () => AgentPlugin>;

export type CliId          = keyof typeof PLUGIN_MAP;
export const SUPPORTED_CLIS = Object.keys(PLUGIN_MAP) as CliId[];
export function resolvePlugin(cli: CliId): AgentPlugin { return PLUGIN_MAP[cli](); }
```

- `CliId`, `SUPPORTED_CLIS`, and `resolvePlugin` all derive from the map — no separate array, no switch
- `AgentPlugin` gains `defaultModel: string` — each plugin owns its default
- New `GET /supported-clis` route exposes `{ id, defaultModel }[]` derived from `PLUGIN_MAP`
- Zod enums in `modes.ts` derived from `SUPPORTED_CLIS` — no literal strings
- Web-UI `CliId` becomes `string`; dialogs fetch `/supported-clis` and render dynamically

**Adding ampcode in the future:**
1. Create `daemon/src/agent-plugins/ampcode.ts` (implement `AgentPlugin` incl. `defaultModel`)
2. Add `ampcode: createAmpcodePlugin` to `PLUGIN_MAP`
→ Types, Zod, API, UI — all update automatically.

## Requirements

| # | Requirement |
|---|-------------|
| R1 | `PLUGIN_MAP` in `registry.ts` is the sole source of truth; `CliId` and `SUPPORTED_CLIS` derived from it |
| R2 | `resolvePlugin` is a map lookup — no switch statement |
| R3 | `daemon/src/types.ts` re-exports `CliId` from registry (no breaking change for existing imports) |
| R4 | Zod enums in `modes.ts` derived from `SUPPORTED_CLIS` — no hardcoded CLI string literals |
| R5 | `AgentPlugin` interface gains `readonly defaultModel: string`; all plugins implement it |
| R6 | New `GET /supported-clis` route returns `{ id: string; defaultModel: string }[]` |
| R7 | Web-UI `CliId` is `string`; `SupportedCli` type added |
| R8 | `getSupportedClis()` added to API client + mock |
| R9 | `NewModeDialog` + `EditModeDialog` fetch `/supported-clis`; render CLI options dynamically; `defaultModelForCli` switch removed |
| R10 | `createGeminiPlugin()` implemented and registered; gemini mode can be created and spawns the binary |
| R11 | All existing tests pass; new tests cover gemini plugin and `/supported-clis` route |

---

## Research

### PLUGIN_MAP — type safety

```ts
// `satisfies` ensures every value returns AgentPlugin at compile time
// Adding a plugin that doesn't implement the full interface → compile error
const PLUGIN_MAP = {
  claude: createClaudePlugin,
  ...
} as const satisfies Record<string, () => AgentPlugin>;

// CliId is inferred as "claude" | "cursor" | "opencode" | "gemini"
export type CliId = keyof typeof PLUGIN_MAP;

// Zod can accept the keys array directly
export const SUPPORTED_CLIS = Object.keys(PLUGIN_MAP) as CliId[];
// z.enum(SUPPORTED_CLIS as [CliId, ...CliId[]]) works fine in Zod 3.x
```

### Circular dependency — `registry.ts` ↔ `types.ts`

- Current: `registry.ts` imports `CliId` from `types.ts`
- After: `CliId` is defined in `registry.ts`; `types.ts` re-exports it
- No cycle — `types.ts` only re-exports, doesn't import anything from registry that imports from types

### `AgentPlugin.defaultModel` — propagation

- `GET /supported-clis`: `Object.entries(PLUGIN_MAP).map(([id, factory]) => ({ id, defaultModel: factory().defaultModel }))`
- Web-UI dialog: on CLI radio change → `clis.find(c => c.id === selected)?.defaultModel` → pre-fill model field
- Replaces `defaultModelForCli()` in both dialogs entirely

### Gemini CLI invocation

- **Binary:** `gemini` (`npm i -g @google/gemini-cli`)
- **Model flag:** `-m <model-id>`
- **System prompt:** `GEMINI_SYSTEM_MD` env var → path to a markdown file
- **Task prompt:** post-launch paste (no inline flag) — same pattern as opencode
- **Ready sentinel:** `╭` (box-drawing char from ink TUI); `fallbackMs: 10_000`
- **Session resume:** not supported in v1 — `getRestoreCommand` returns `null`
- **Auth:** `GEMINI_API_KEY` env var; unauthenticated → session exits cleanly

### Fake gemini for smoke-testing

- A shell script at a path on `$PATH` named `gemini` can stub the binary:
  ```sh
  #!/usr/bin/env bash
  echo "╭─ Fake Gemini CLI ─╮"
  echo "Ready."
  cat  # block stdin so the session stays alive and accepts post-launch input
  ```
- Mount it into the Docker container alongside the daemon to verify spawn + prompt delivery without a real API key

---

## Approach

### Before vs. after

```
BEFORE — hardcoded in 7-8 places:
  types.ts         → CliId = "claude" | "cursor" | "opencode"
  registry.ts      → SUPPORTED_CLIS array  +  resolvePlugin switch
  modes.ts         → z.enum([...]) × 3
  web-ui/types.ts  → CliId = "claude" | "cursor" | "opencode"
  NewModeDialog    → defaultModelForCli() switch + hardcoded radios
  EditModeDialog   → same

AFTER — one registration point:
  registry.ts      → PLUGIN_MAP  ← add one line to register any CLI
                     CliId, SUPPORTED_CLIS, resolvePlugin all derived
  types.ts         → re-exports CliId (no breakage)
  modes.ts         → z.enum(SUPPORTED_CLIS) × 3  +  GET /supported-clis
  web-ui/types.ts  → CliId = string
  NewModeDialog    → fetches /supported-clis, renders dynamically
  EditModeDialog   → same
```

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/agent-plugins/registry.ts` | Replace array+switch with `PLUGIN_MAP`; derive `CliId`, `SUPPORTED_CLIS`, `resolvePlugin` |
| `daemon/src/types.ts` | Remove `CliId` definition; re-export from registry |
| `daemon/src/services/spawn.ts` | Add `readonly defaultModel: string` to `AgentPlugin` interface |
| `daemon/src/agent-plugins/claude.ts` | Add `defaultModel: "sonnet"` |
| `daemon/src/agent-plugins/cursor.ts` | Add `defaultModel: "auto"` |
| `daemon/src/agent-plugins/opencode.ts` | Add `defaultModel: "opencode/big-pickle"` |
| `daemon/src/agent-plugins/gemini.ts` | **New file** — full plugin with `defaultModel: "gemini-2.5-pro"` |
| `daemon/src/routes/modes.ts` | `z.enum(SUPPORTED_CLIS)` × 3; add `GET /supported-clis` |
| `web-ui/src/api/types.ts` | `CliId = string`; add `SupportedCli` interface |
| `web-ui/src/api/client.ts` | Add `getSupportedClis(): Promise<SupportedCli[]>` |
| `web-ui/src/api/mock.ts` | Add `getSupportedClis()` returning static list incl. gemini |
| `web-ui/src/components/dialogs/NewModeDialog.tsx` | Fetch `/supported-clis`; dynamic radios; remove `defaultModelForCli` |
| `web-ui/src/components/dialogs/EditModeDialog.tsx` | Same |
| `daemon/src/__tests__/plugins.test.ts` | Gemini plugin tests + `/supported-clis` route test |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **`z.enum(SUPPORTED_CLIS)` TypeScript tuple constraint** | Cast as `[CliId, ...CliId[]]` if needed; Zod 3.x handles readonly arrays |
| 2 | **`as const satisfies` requires TS 4.9+** | Daemon already uses TS 5.x — confirmed safe |
| 3 | **`GEMINI_SYSTEM_MD` honoured by CLI?** | Confirmed in Gemini CLI source; fallback: system prompt silently skipped, agent still functional |
| 4 | **Ready sentinel `╭` stripped by terminal?** | `fallbackMs: 10_000` covers this |
| 5 | **Dialog fetch flicker** | `/supported-clis` is in-process O(1) — <5ms; loading state is a precaution |

---

## Implementation Checklist

### Phase 1 — Registry refactor + `AgentPlugin.defaultModel`

- [x] **1.1** `registry.ts` — replace `SUPPORTED_CLIS` array + `resolvePlugin` switch with `PLUGIN_MAP as const satisfies Record<string, () => AgentPlugin>`; derive `CliId = keyof typeof PLUGIN_MAP`; `SUPPORTED_CLIS = Object.keys(PLUGIN_MAP) as CliId[]`; `resolvePlugin` becomes a map lookup
- [x] **1.2** `types.ts:6` — remove `CliId` definition; add `export type { CliId } from "../agent-plugins/registry.js"`
- [x] **1.3** `spawn.ts` — add `readonly defaultModel: string` to `AgentPlugin` interface
- [x] **1.4** `claude.ts` — add `defaultModel: "sonnet"`
- [x] **1.5** `cursor.ts` — add `defaultModel: "auto"`
- [x] **1.6** `opencode.ts` — add `defaultModel: "opencode/big-pickle"`

**Verify phase 1:**
- [x] **1.T1** `tsc --noEmit` in `daemon/` exits 0
- [x] **1.T2** `npm test` in `daemon/` — all existing tests pass
- [x] **1.T3** `resolvePlugin("claude").defaultModel === "sonnet"` (and cursor, opencode)

---

### Phase 2 — Gemini plugin + dynamic Zod + `/supported-clis` route

- [ ] **2.1** Create `daemon/src/agent-plugins/gemini.ts`:
  - `name: "gemini"`, `defaultModel: "gemini-2.5-pro"`, `promptDelivery: "post-launch"`, `postSentinelDelayMs: 500`
  - `listModels()` → `{ models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] }`
  - `getLaunchCommand(cfg)` → `["gemini", ...(cfg.model ? ["-m", cfg.model] : [])]`
  - `getEnvironment(cfg)` → `{ GEMINI_SYSTEM_MD: systemPromptPath(cfg.project.id, cfg.worktree.id, cfg.session.id) }`
  - `getReadySignal()` → `{ sentinel: "╭", fallbackMs: 10_000 }`
  - `composeLaunchPrompt(prompt)` → `postLaunchInput` = taskPrompt + `<!-- VSTPRMT:sessionId -->`; `postLaunchSubmit: true`
  - `getRestoreCommand` → returns `null`
- [ ] **2.2** `registry.ts` — add `gemini: createGeminiPlugin` to `PLUGIN_MAP`; add import
- [ ] **2.3** `modes.ts:59,68,128` — replace three `z.enum(["claude","cursor","opencode"])` with `z.enum(SUPPORTED_CLIS as [CliId, ...CliId[]])`; import `SUPPORTED_CLIS`, `CliId` from registry
- [ ] **2.4** `modes.ts` — add `GET /supported-clis` route: `Object.entries(PLUGIN_MAP).map(([id, f]) => ({ id, defaultModel: f().defaultModel }))` — import `PLUGIN_MAP` from registry

**Verify phase 2:**
- [ ] **2.T1** `resolvePlugin("gemini").name === "gemini"` and `.defaultModel === "gemini-2.5-pro"`
- [ ] **2.T2** `getLaunchCommand` with model → `["gemini", "-m", "gemini-2.5-pro"]`; without → `["gemini"]`
- [ ] **2.T3** `getEnvironment` → object contains `GEMINI_SYSTEM_MD` with correct path
- [ ] **2.T4** `composeLaunchPrompt` → `postLaunchSubmit: true`; input contains task + `VSTPRMT:` needle
- [ ] **2.T5** `listModels()` → three gemini model ids
- [ ] **2.T6** `GET /supported-clis` → array includes `{ id: "gemini", defaultModel: "gemini-2.5-pro" }`
- [ ] **2.T7** `POST /modes` with `cli: "gemini"` → 201; with `cli: "bogus"` → 400
- [ ] **2.T8** `tsc --noEmit` in `daemon/` exits 0

---

### Phase 3 — Web-UI dynamic dialogs

- [ ] **3.1** `web-ui/src/api/types.ts` — `CliId = string`; add `export interface SupportedCli { id: string; defaultModel: string }`
- [ ] **3.2** `web-ui/src/api/client.ts` — add `getSupportedClis(): Promise<SupportedCli[]>` → `GET /supported-clis`
- [ ] **3.3** `web-ui/src/api/mock.ts` — add `getSupportedClis()` returning `[{id:"claude",defaultModel:"sonnet"},{id:"cursor",defaultModel:"auto"},{id:"opencode",defaultModel:"opencode/big-pickle"},{id:"gemini",defaultModel:"gemini-2.5-pro"}]`
- [ ] **3.4** `NewModeDialog.tsx`:
  - Add `useEffect` fetching `api.getSupportedClis()` on mount → state `{ clis: SupportedCli[], loading: boolean }`
  - Replace `defaultModelForCli` switch + hardcoded radio group with `.map()` over `clis`
  - On CLI change → `setModel(clis.find(c => c.id === newCli)?.defaultModel ?? "")`
  - While loading → disable submit; show subtle spinner in radio area
- [ ] **3.5** `EditModeDialog.tsx` — same changes as 3.4

**Verify phase 3:**
- [ ] **3.T1** `tsc --noEmit` in `web-ui/` exits 0
- [ ] **3.T2** `npm test` in `web-ui/` — all existing tests pass
- [ ] **3.T3** Manual — New Mode dialog: fetches and renders claude/cursor/opencode/gemini; selecting gemini pre-fills `gemini-2.5-pro`
- [ ] **3.T4** Manual — Edit Mode dialog: switching CLI updates model default from API

---

### Phase 4 — Smoke test with fake gemini binary in Docker

- [ ] **4.1** Write `scripts/fake-gemini.sh` stub:
  ```sh
  #!/usr/bin/env bash
  echo "╭─ Fake Gemini CLI ─╮"
  echo "Ready."
  cat
  ```
- [ ] **4.2** Build daemon Docker image and run container with `fake-gemini.sh` on `$PATH` as `gemini`
- [ ] **4.3** POST `/modes` to create a gemini mode
- [ ] **4.4** POST `/worktrees` (or `/sessions`) to spawn an agent session using the gemini mode
- [ ] **4.5** Verify session reaches `working` state (not `exited`)
- [ ] **4.6** Verify `GET /supported-clis` returns all four CLIs including gemini

**Verify phase 4:**
- [ ] **4.T1** Session spawned with gemini mode reaches `working` state
- [ ] **4.T2** Regression — claude mode still spawns correctly
- [ ] **4.T3** Regression — `resolvePlugin` with unknown string throws

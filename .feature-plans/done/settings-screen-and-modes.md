# Feature Plan: Settings Screen, Mode Edit/Delete, and Model Selection

> Replace the modes popup with a dedicated settings screen (like dashboard); add full mode editing including CLI and model, deletion, and per-mode model selection with live CLI model enumeration.

**Issue:** (settings-screen-and-modes)
**Branch:** `feat/settings-screen-and-modes`
**Status:** Implemented — code on branch `feat/settings-screen-and-modes`. **Requirements** (R1–R19) and **Phase 1–3 implementation** checklists below are complete `[x]`. **Verify phase** rows (`1.T*`, `2.T*`, `3.T*`) remain `[ ]` until manual QA against a live daemon + browser.
**PRD:** n/a

**Reference files:**
- Mode type (web): `apps/web/src/api/types.ts:49-55`
- Mode type (daemon): `apps/cli/src/daemon/routes/modes.ts:17-23`
- Mode CRUD routes: `apps/cli/src/daemon/routes/modes.ts`
- Web API client: `apps/web/src/api/client.ts:293-325`
- Sidebar settings button: `apps/web/src/components/layout/LeftSidebar.tsx:397-400`
- ~~Current modes menu~~ (removed): dedicated `/settings` screen replaces `ModesMenuDialog`
- New mode form: `apps/web/src/components/dialogs/NewModeDialog.tsx`
- Claude plugin: `apps/cli/src/daemon/plugins/claude.ts`
- OpenCode plugin: `apps/cli/src/daemon/plugins/opencode.ts`
- Cursor plugin: `apps/cli/src/daemon/plugins/cursor.ts`
- Agent plugin interface + LaunchConfig: `apps/cli/src/daemon/services/spawn.ts:29-70`
- Session spawn job: `apps/cli/src/daemon/routes/sessions.ts:53-108`
- Route definitions: `apps/web/src/App.tsx`
- Workspace route (how dashboard is rendered): `apps/web/src/routes/Workspace.tsx`
- Design system: `~/code/fastestdevalive/100gb-minimalist-design-system/src/`
- Design system settings sample: `~/code/fastestdevalive/100gb-minimalist-design-system/src/components/Showcase.tsx:888-950` (`web-settings` pattern)

---

## Problem

- Settings icon in sidebar opens a small popup (`ModesMenuDialog`) — no room to grow as settings expand
- No way to edit or delete an existing mode (PUT/DELETE daemon routes exist but have no UI)
- Mode has no `model` field; every session inherits the CLI's default model with no override
- CLI field on a mode is unnecessarily locked to its creation value (daemon enforces this but there is no technical reason — mode is consumed once at spawn time and sessions run independently after)

## Concept

- Settings icon navigates to `/settings` route — a **dedicated screen** like the dashboard (same sidebar + content area layout pattern, uses `dashboardPane` slot in `Layout`)
- Settings screen has a left nav of sections; first section is **Modes** (more sections can be added later)
- Modes section provides full CRUD: create, edit (name, cli, context, model), delete with guard
- Mode data model gains an optional `model` field; new/edit mode dialog fetches available models from the selected CLI; model is passed into spawn as a CLI flag
- Default model per CLI remembered in `localStorage` so user's last choice is pre-selected on next open

## Requirements

<!-- Acceptance criteria — mirrored against merged branch -->

- [x] **R1** Sidebar settings icon navigates to `/settings` route; active state shown on icon
- [x] **R2** Settings screen renders in the main content area (right of sidebar), identical structural pattern to dashboard
- [x] **R3** Settings left nav lists sections; clicking a section anchor-scrolls the content panel
- [x] **R4** Modes section: lists all modes, each as a row with name, CLI badge, model badge (if set), Edit and Delete buttons
- [x] **R5** Edit mode dialog: all fields editable — name, CLI (radio), context, model; pre-populated with current values
- [x] **R6** Delete mode: inline confirmation; on 409 (in-use by active session) surfaces readable error message
- [x] **R7** New `GET /cli-models?cli=<cliId>` daemon endpoint returns list of model strings for a given CLI
- [x] **R8** Mode data model gains optional `model?: string`; stored in `modes.json`, exposed in all CRUD responses
- [x] **R9** PUT /modes/:id extended to also accept `cli` and `model` updates (CLI was previously immutable — remove that restriction)
- [x] **R10** New/edit mode: model dropdown disabled until CLI is selected; populates via `listCliModels` when CLI changes
- [x] **R11** Default model per CLI persisted in `localStorage` (`vst-last-model-<cli>`); pre-selected on dialog open when no saved mode model exists
- [x] **R12** Default selections: Claude → `sonnet`, Cursor → `auto`, OpenCode → `opencode/big-pickle` (used as fallback when no localStorage value exists)
- [x] **R13** Model dropdown always includes `(default)` as the first option (value = empty/undefined = no flag passed to CLI)
- [x] **R14** On model dropdown error from CLI: show inline warning + allow free-text input fallback
- [x] **R15** Each agent plugin applies the model flag to its launch command when `LaunchConfig.model` is set
- [x] **R16** Existing sessions are unaffected by mode edits; UI shows info callout aligned with plan wording (sessions continue with original settings)
- [x] **R17** WS events `mode:created / mode:updated / mode:deleted` drive live updates in the settings screen
- [x] **R18** `ModesMenuDialog` is removed entirely (replaced by the dedicated settings screen)
- [x] **R19** Design uses inline JSX + CSS custom properties (`var(--space-*)`, `var(--fg-*)`, `var(--border-default)`, etc.) — same pattern as `DashboardPanel.tsx` and `NewModeDialog.tsx`; the design system is a visual reference only, **not** an npm dependency

---

## Research

### Mode identifier and mutability

- **Identifier:** `mode.id` — machine-generated string (`mode-{timestamp}-{random}`)
- Sessions store `modeId` (the `id`) in the session record (`types.ts:28`)
- At spawn time, mode is resolved **once**: `modes.find((m) => m.id === modeId)` → CLI selected → prompt built → session launched (`sessions.ts:66-84`)
- After spawn, the session never re-reads the mode — it runs with its own plugin instance
- **Conclusion:** all mode fields (name, cli, context, model) are safe to mutate; existing sessions are unaffected

### CLI model flags (verified from `--help` / `--list-models`)

- **Claude** (`claude` CLI):
  - Flag: `--model <model>` — accepts aliases (`sonnet`, `opus`, `haiku`) or full names (`claude-sonnet-4-6`)
  - No built-in `list-models` CLI command
  - **Strategy:** hardcode curated list: `["sonnet", "opus", "haiku", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]`
  - Default selection: `sonnet`
  - Applied in: `claude.ts` `composeLaunchPrompt` — append `--model ${model}` to `shellLine`

- **OpenCode** (`opencode` CLI):
  - Flag: `-m, --model <model>` — format `provider/model` (e.g. `opencode/big-pickle`)
  - List command: `opencode models` — one `provider/model` per stdout line
  - List is large (many providers); show all in searchable dropdown
  - Default selection: `opencode/big-pickle`
  - Applied in: `opencode.ts` `getLaunchCommand` — insert `"-m", model` after `"opencode"`

- **Cursor** (`cursor-agent` CLI):
  - Flag: `--model <model>` — e.g. `auto`, `composer-2-fast`, `gpt-5.3-codex`, `claude-opus-4-7-thinking-high`
  - List command: `cursor-agent --list-models` — one `modelId   Display Name` per line; parsing: take first token
  - Default selection: `auto`
  - Applied in: `cursor.ts` `getLaunchCommand` — insert `"--model", model` before `"--workspace"`
  - On subprocess failure: show inline warning "Could not fetch models — check cursor-agent is installed"; allow free-text entry

### Settings routing — how dashboard works (reference pattern)

- `App.tsx:6-12`: `<Route path="/" element={<Workspace />} />` — dashboard is at `/`
- `Workspace.tsx:22`: `const isDashboard = location.pathname === "/";`
- `Workspace.tsx:117`: `dashboardPane={isDashboard ? <DashboardPanel api={api} /> : undefined}` passed to `<Layout>`
- `Layout.tsx:10-11`: when `dashboardPane` is set, it replaces IDE panels
- **Settings pattern:** add `/settings` route → `const isSettings = location.pathname === "/settings"` → pass `<SettingsPanel api={api} />` as `dashboardPane`

### UI component inventory (what actually exists in the project)

The design system at `~/code/fastestdevalive/100gb-minimalist-design-system` is a **visual reference only** — it is not imported as a package. The project has its own components:

- **Existing shared UI** (`apps/web/src/components/ui/`): `Button.tsx`, `Input.tsx`, `Select.tsx`, `Radio.tsx`
  - `Button` only has `variant="ghost" | "solid"` (default solid) — no `destructive`, `secondary`, or `accent` variants
  - `Select` is a thin wrapper around native `<select>` with CSS-variable styling
  - `Input` is a styled `<input>`
  - `Radio` is a styled `<input type="radio">`
- **Existing dialogs** (`apps/web/src/components/dialogs/`): `Dialog.tsx`, `ConfirmDialog.tsx`, `NewModeDialog.tsx`, `NewSessionDialog.tsx`
  - All new dialogs must use `<Dialog>` from `Dialog.tsx` as the wrapper
- **No `ListItem`, `Card`, `Badge`, or `Separator`** — these do not exist; write inline JSX with CSS variables instead
- **Styling pattern:** inline styles using `var(--space-*)`, `var(--fg-primary)`, `var(--fg-muted)`, `var(--border-default)`, `var(--bg-input)`, `var(--radius-sm)`, `var(--border-width)` — see `NewModeDialog.tsx:114-121` and `DashboardPanel.tsx:143-186` for the exact pattern
- **Icons:** Lucide React (`import { Pencil, Trash2, Info, Plus } from "lucide-react"`)
- **Design system layout reference** (`Showcase.tsx:888-950`): use the two-column `web-settings-nav` + `web-settings-content` structure as the CSS layout model for `SettingsPanel` — but implement it with inline styles / project CSS variables, not design system imports

### Daemon `PUT /modes/:id` current state

- `modes.ts:117-143`: accepts only `{ name?, context? }` via `UpdateModeBody` schema
- `cli` is simply omitted from the Zod schema — no explicit rejection, just silently ignored
- Need to: add `cli?: CliId` and `model?: string` to `UpdateModeBody`; apply them in the merge

### In-process model cache (daemon)

- `GET /cli-models` shells out to CLI process — expensive if called on every dialog open
- Cache: `Map<CliId, { models: string[]; fetchedAt: number }>` in module scope; TTL = 10 minutes
- On cache miss: spawn subprocess, parse stdout, store in cache
- On subprocess failure: return `{ models: [], error: "<message>" }`; don't cache errors

---

## Approach

### Architecture

- New `/settings` route mirrors `/` (dashboard) — uses the same `<Workspace>` component with a path check
- `<SettingsPanel>` passed as `dashboardPane` — no new layout code needed
- `SettingsPanel` = left nav (`<nav>`) + right content (`<div>`) following `web-settings` pattern from design system
- `ModesSetting` section inside `SettingsPanel` owns mode CRUD state; listens to WS events for live updates
- `ModelPicker` = shared combobox for new and edit dialogs; fetches via `api.listCliModels(cli)` when CLI changes; stores last selection in `localStorage`

### Data model changes

- `Mode` interface (both web + daemon): add `model?: string`
- `LaunchConfig`: add `model?: string`
- `modes.json` format: backwards-compatible (new field optional; old files load fine)

### Per-CLI model flag wiring

| CLI | Flag | Where inserted |
|-----|------|----------------|
| `claude` | `--model <model>` | `claude.ts` → append to `shellLine` in `composeLaunchPrompt` |
| `opencode` | `-m <model>` | `opencode.ts` → insert after `"opencode"` in `getLaunchCommand` |
| `cursor` | `--model <model>` | `cursor.ts` → insert before `"--workspace"` in `getLaunchCommand` |

---

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/App.tsx` | Add `/settings` route → `<Workspace />` |
| `apps/web/src/routes/Workspace.tsx` | Add `isSettings` check; pass `<SettingsPanel>` as `dashboardPane`; navigate to `/settings` from sidebar settings button |
| `apps/web/src/api/types.ts` | Add `model?: string` to `Mode` interface |
| `apps/web/src/api/client.ts` | Add `listCliModels(cli)` → `GET /cli-models?cli=` |
| `apps/web/src/components/layout/LeftSidebar.tsx` | Settings button: `navigate("/settings")` instead of opening popup; show active state when on `/settings`; remove `modesOpen` state |
| `apps/web/src/components/settings/SettingsPanel.tsx` | **New** — top-level settings screen (nav + content); section: Modes |
| `apps/web/src/components/settings/ModesSetting.tsx` | **New** — modes list with edit/delete; info callout; "+ New mode" trigger |
| `apps/web/src/components/shared/ModelPicker.tsx` | **New** — model combobox; fetches via `listCliModels`; localStorage default |
| `apps/web/src/components/dialogs/NewModeDialog.tsx` | Add `ModelPicker`; include `model` in `createMode` call |
| `apps/web/src/components/dialogs/EditModeDialog.tsx` | **New** — pre-populated edit form; all fields editable including CLI; calls `updateMode` |
| `apps/web/src/components/dialogs/ModesMenuDialog.tsx` | **Delete** |
| `apps/cli/src/daemon/routes/modes.ts` | Add `model?` to Mode type + POST handler; add `cli?` + `model?` to PUT handler; new `GET /cli-models` route |
| `apps/cli/src/daemon/services/spawn.ts` | Add `model?: string` to `LaunchConfig` |
| `apps/cli/src/daemon/routes/sessions.ts` | Pass `model: mode.model` into `LaunchConfig` in spawn job |
| `apps/cli/src/daemon/plugins/claude.ts` | Append `--model <model>` to `shellLine` when `cfg.model` is set |
| `apps/cli/src/daemon/plugins/opencode.ts` | Prepend `-m <model>` in `getLaunchCommand` when `cfg.model` is set |
| `apps/cli/src/daemon/plugins/cursor.ts` | Append `--model <model>` in `getLaunchCommand` when `cfg.model` is set |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Claude has no `list-models` CLI command** | Hardcode 6 models: `sonnet`, `opus`, `haiku`, `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`. Update list manually when models are released. |
| 2 | **OpenCode model list can be very long** | Show all in a native `<select>` (browser handles scroll). If UX feels heavy, add a search input above the select. |
| 3 | **`cursor-agent --list-models` may fail if cursor not installed/authed** | Return `{ models: [], error: "..." }` from daemon; surface inline warning in `ModelPicker` with free-text fallback. |
| 4 | **CLI mutability confirmed safe** | Mode is resolved by `id` at spawn time only; sessions run independently after. All fields (including `cli`) can be edited without affecting existing sessions. |
| 5 | **z-index: settings screen vs terminal fullscreen** | N/A — settings is a route, not an overlay. Navigating to `/settings` replaces the workspace content just like dashboard. |
| 6 | **Model caching in daemon** | In-process `Map<CliId, {models, fetchedAt}>` with 10-min TTL. Subprocess cost only paid once per CLI per 10 minutes. |
| 7 | **`isModeInUse` check on delete** | Daemon already implements this (409 on DELETE if active sessions use the mode). UI surfaces the error message from the response body. |
| 8 | **Navigating away from `/settings`** | Sidebar worktree click navigates to `/worktree` (existing behaviour). Dashboard click → `/`. Settings → `/settings`. Back button works via browser history. |

---

## Implementation Phases

### Phase 1 — Data model + daemon endpoints

- [x] **1.1** Add `model?: string` to `Mode` interface in `apps/cli/src/daemon/routes/modes.ts:17-23`
- [x] **1.2** Thread `model?` through `POST /modes` body validation (Zod schema) + storage; any non-empty string ≤100 chars
- [x] **1.3** Extend `UpdateModeBody` Zod schema in `PUT /modes/:id` to also accept `cli?: CliId` and `model?: string`; apply in the merge object
- [x] **1.4** Add `GET /cli-models?cli=<cliId>` route:
  - Validate `cli` query param against `["claude", "cursor", "opencode"]`
  - **claude:** return hardcoded `{ models: ["sonnet", "opus", "haiku", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"] }`
  - **opencode:** spawn `opencode models`, split stdout by newline, filter empty lines; return `{ models: string[] }`
  - **cursor:** spawn `cursor-agent --list-models`, parse first whitespace-delimited token per line (the model id); return `{ models: string[] }`
  - In-process cache: `Map<CliId, { models: string[]; fetchedAt: number }>` with 10-min TTL
  - On failure: return `{ models: [], error: "<message>" }`; do not cache
- [x] **1.5** Add `model?: string` to `Mode` interface in `apps/web/src/api/types.ts:49-55`
- [x] **1.6** Add `listCliModels(cli: CliId): Promise<{ models: string[]; error?: string }>` to `apps/web/src/api/client.ts` → `GET /cli-models?cli=<cli>`
- [x] **1.7** In `apps/cli/src/daemon/services/spawn.ts`: add `model?: string` to both `SpawnOptions` (the public interface, ~line 65) AND `LaunchConfig` (the internal config, ~line 50); in the body of `spawnSession`, pass `model: opts.model` when assembling `launchCfg`
- [x] **1.8** In `sessions.ts` spawn job (~line 76): add `model: mode.model` to the `spawnSession(...)` call options
- [x] **1.9** `claude.ts` `composeLaunchPrompt`: if `prompt.launchCfg.model`, append ` --model ${sq(model)}` to `shellLine`
- [x] **1.10** `opencode.ts` `getLaunchCommand`: if `cfg.model`, return `["opencode", "-m", cfg.model]` instead of `["opencode"]`
- [x] **1.11** `cursor.ts` `getLaunchCommand`: if `cfg.model`, insert `"--model", cfg.model` into argv before `"--workspace"`

**Verify phase 1** *(manual — curl against running daemon or integration test)*

- [ ] **1.T1** `POST /modes` with `model: "sonnet"` → 201; response body includes `model: "sonnet"`
- [ ] **1.T2** `PUT /modes/:id` with `{ cli: "opencode" }` → 200; mode's CLI updated in response + `modes.json`
- [ ] **1.T3** `PUT /modes/:id` with `{ model: "auto" }` → 200; model updated
- [ ] **1.T4** `GET /cli-models?cli=claude` → 200; `models` is the 6-item hardcoded array
- [ ] **1.T5** `GET /cli-models?cli=opencode` → 200; `models` array non-empty, items match `provider/model` format
- [ ] **1.T6** `GET /cli-models?cli=cursor` → 200; `models` includes `auto`, `composer-2-fast`
- [ ] **1.T7** Create a claude mode with `model: "sonnet"`; spawn a session → inspect tmux pane: `--model sonnet` present in launch command
- [ ] **1.T8** Create an opencode mode with `model: "opencode/big-pickle"`; spawn → pane shows `opencode -m opencode/big-pickle`

---

### Phase 2 — Settings route + screen shell

- [x] **2.1** Add `<Route path="/settings" element={<Workspace />} />` to `apps/web/src/App.tsx`
- [x] **2.2** In `Workspace.tsx`: add `const isSettings = location.pathname === "/settings";`; pass `<SettingsPanel api={api} />` as `dashboardPane` when `isSettings`
- [x] **2.3** Create `apps/web/src/components/settings/SettingsPanel.tsx`:
  - Two-column layout matching `web-settings` pattern from design system Showcase
  - Left `<nav className="settings-nav">`: section buttons (`Modes` first); clicking a section scrolls to its anchor
  - Right `<div className="settings-content">`: scrollable; renders `<ModesSetting>` and future sections
  - Use CSS from design system tokens (`--space-*`, `--fg-*`, `--border-default`, etc.)
- [x] **2.4** Update `apps/web/src/components/layout/LeftSidebar.tsx:397-400`:
  - Add `useNavigate` and `useLocation` from `react-router-dom` to the existing import at the top of the file (LeftSidebar has no router hooks today — add them directly, the same way it already calls `useTheme`, `useWorkspaceStore`, etc.)
  - Settings button `onClick`: call `navigate("/settings")`
  - Show active/highlighted state when `useLocation().pathname === "/settings"` — e.g. add `className={location.pathname === "/settings" ? "icon-btn icon-btn--active" : "icon-btn"}` (match whatever active-state CSS class the project already uses for other sidebar buttons)
  - Remove `modesOpen` state, `ModesMenuDialog` import and render
- [x] **2.5** Delete `apps/web/src/components/dialogs/ModesMenuDialog.tsx`

**Verify phase 2** *(manual — browser)*

- [ ] **2.T1** Click settings icon in sidebar → URL changes to `/settings`; main content area shows the settings screen (left nav + content)
- [ ] **2.T2** Clicking sidebar worktree navigates away from `/settings` to `/worktree`
- [ ] **2.T3** Settings nav "Modes" button scrolls to modes section
- [ ] **2.T4** Settings icon shows active/highlighted state when on `/settings`; no active state on other routes
- [ ] **2.T5** No regressions: dashboard at `/` still works; workspace at `/worktree` still works

---

### Phase 3 — Modes section + ModelPicker + Edit/New dialogs

- [x] **3.1** Create `apps/web/src/components/settings/ModesSetting.tsx`:
  - Fetches `api.listModes()` on mount; stores in local `useState<Mode[]>`
  - **WS live updates:** use `api.on(...)` inside a `useEffect` — the correct pattern (same as `DashboardPanel.tsx:75-103`) is:
    ```ts
    useEffect(() => {
      const off1 = api.on("mode:created", (ev) => setModes(ms => [...ms, ev.mode]));
      const off2 = api.on("mode:updated", (ev) => setModes(ms => ms.map(m => m.id === ev.mode.id ? ev.mode : m)));
      const off3 = api.on("mode:deleted", (ev) => setModes(ms => ms.filter(m => m.id !== ev.modeId)));
      return () => { off1(); off2(); off3(); };
    }, [api]);
    ```
    Do NOT use `useSubscription` — that hook is only for session-ID subscriptions
  - Renders modes as plain `<div>` rows with inline styles (no `ListItem` component — it doesn't exist); each row shows name, a `<span>` CLI badge, optional model `<span>` badge, and two `<Button variant="ghost">` buttons (Pencil icon for edit, Trash2 icon for delete)
  - Delete: show a confirmation `<span>` inline on first click; on confirm call `api.deleteMode(id)`; on 409 show: "This mode is being used by an active session. Stop the session first."
  - `<Button variant="solid">+ New mode</Button>` at bottom → opens `NewModeDialog`
  - Info callout: a styled `<div>` with an `<Info size={14} />` icon and text "Editing a mode only affects new sessions — running sessions continue with their original settings."
- [x] **3.2** Create `apps/web/src/components/shared/ModelPicker.tsx`:
  - Props: `api: ApiInstance`, `cli: CliId | null`, `value: string | undefined`, `onChange: (model: string | undefined) => void`
  - On `cli` change: call `api.listCliModels(cli)` → set loading state → populate options
  - Options rendered as `<option>` elements inside the project's existing `<Select>` component (`ui/Select.tsx`): first option `value=""` label `(default)`, then one per model string; `value === ""` maps to `undefined` on submit
  - Default pre-selection logic (in order): 1) `value` prop if set (editing existing mode), 2) `localStorage.getItem("vst-last-model-" + cli)`, 3) hardcoded fallback: `claude → "sonnet"`, `cursor → "auto"`, `opencode → "opencode/big-pickle"`
  - On `onChange`: call `localStorage.setItem("vst-last-model-" + cli, selectedValue)` then call `onChange`
  - On `listCliModels` error: hide the `<Select>` and show `<span>Could not fetch models. Type a model name below.</span>` + `<Input>` free-text fallback
  - Render `<Select disabled>` when `cli` is null or models are loading
- [x] **3.3** Update `apps/web/src/components/dialogs/NewModeDialog.tsx`:
  - Add `<ModelPicker cli={selectedCli} value={model} onChange={setModel} />` below context fields
  - Include `model: model || undefined` in `api.createMode(...)` call
- [x] **3.4** Create `apps/web/src/components/dialogs/EditModeDialog.tsx`:
  - Props: `mode: Mode`, `open: boolean`, `onClose: () => void`, `api: ApiInstance`
  - Wrap in `<Dialog>` from `dialogs/Dialog.tsx` — same as `NewModeDialog`
  - Editable fields: name (`<Input>`), CLI (`<Radio>` buttons — copy the pattern from `NewModeDialog.tsx:97-114`), context (`<textarea>` with inline styles — copy from `NewModeDialog.tsx:114-121`), model (`<ModelPicker>`)
  - Initialise state from `mode` prop on open (`useEffect` on `[mode]` or initialise in `useState(() => ...)`)
  - On CLI radio change: clear `model` state (so `ModelPicker` resets to default for new CLI)
  - Save: calls `api.updateMode(mode.id, { name: name.trim(), cli, context, model: model || undefined })`
  - On success: call `onClose()` — WS `mode:updated` event will update the list in `ModesSetting`
  - Footer buttons: `<button onClick={onClose}>Cancel</button>` and `<button onClick={submit}>Save</button>` — match `NewModeDialog` footer pattern exactly

**Verify phase 3** *(manual — browser + daemon)*

- [ ] **3.T1** Modes section lists all existing modes with name, CLI badge, edit + delete buttons
- [ ] **3.T2** WS event `mode:created` → new mode appears in list without reload
- [ ] **3.T3** WS event `mode:deleted` → mode disappears from list
- [ ] **3.T4** Edit dialog opens pre-populated; change CLI → model dropdown refreshes; save → row updates
- [ ] **3.T5** New mode dialog: select `claude` → model dropdown shows 6 options, `sonnet` pre-selected; select `cursor` → shows cursor models, `auto` pre-selected
- [ ] **3.T6** Model selection persists to `localStorage`; reopen dialog for same CLI → last selected model is pre-selected
- [ ] **3.T7** Delete mode in use by active session → 409 error shows human-readable message; mode remains in list
- [ ] **3.T8** Spawn a session with a mode that has `model: "opus"` → `--model opus` in tmux pane command; existing session with same mode remains unaffected

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `apps/cli/src/daemon/routes/modes.ts` | 1.1–1.4 | Add `model?`; extend PUT to accept `cli?`+`model?`; add `GET /cli-models` |
| `apps/web/src/api/types.ts` | 1.5 | Add `model?: string` to Mode |
| `apps/web/src/api/client.ts` | 1.6 | Add `listCliModels` method |
| `apps/cli/src/daemon/services/spawn.ts` | 1.7 | Add `model?` to both `SpawnOptions` AND `LaunchConfig`; wire through |
| `apps/cli/src/daemon/routes/sessions.ts` | 1.8 | Add `model: mode.model` to `spawnSession(...)` call |
| `apps/cli/src/daemon/plugins/claude.ts` | 1.9 | Append `--model` to shellLine |
| `apps/cli/src/daemon/plugins/opencode.ts` | 1.10 | Prepend `-m` to getLaunchCommand |
| `apps/cli/src/daemon/plugins/cursor.ts` | 1.11 | Append `--model` to getLaunchCommand |
| `apps/web/src/App.tsx` | 2.1 | Add `/settings` route |
| `apps/web/src/routes/Workspace.tsx` | 2.2 | `isSettings` check + SettingsPanel as dashboardPane |
| `apps/web/src/components/settings/SettingsPanel.tsx` | 2.3 | **New** — settings screen shell (nav + content) |
| `apps/web/src/components/layout/LeftSidebar.tsx` | 2.4 | Settings icon → `navigate("/settings")`; remove ModesMenuDialog |
| `apps/web/src/components/dialogs/ModesMenuDialog.tsx` | 2.5 | **Delete** |
| `apps/web/src/components/settings/ModesSetting.tsx` | 3.1 | **New** — modes list + edit/delete + info callout |
| `apps/web/src/components/shared/ModelPicker.tsx` | 3.2 | **New** — model combobox with localStorage default |
| `apps/web/src/components/dialogs/NewModeDialog.tsx` | 3.3 | Add ModelPicker |
| `apps/web/src/components/dialogs/EditModeDialog.tsx` | 3.4 | **New** — edit mode form (all fields) |

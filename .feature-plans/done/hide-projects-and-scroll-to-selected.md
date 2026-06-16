# Mini-Design: Hide projects + scroll-to-selected worktree

> Project-level hide (server-side flag, Settings unhide) + sidebar reopen snaps to the selected worktree.

**Issue:** hide-projects-and-scroll-to-selected
**Branch:** `scrollfix-n-hiding`
**Status:** Done
**PRD:** `.feature-plans/pending/prd-hide-projects-and-scroll-to-selected.md`

**Reference files:**
- Data / schema: `daemon/src/types.ts:51` (`ProjectRecord`)
- Project store: `daemon/src/state/project-store.ts:67` (`mutateProject`)
- Project routes: `daemon/src/routes/projects.ts:41` (`registerProjectRoutes`)
- WS protocol (zod): `daemon/src/ws/protocol.ts:239` (`ServerMessage` discriminatedUnion; `project:created` at `:191`)
- Pin precedent: `daemon/src/routes/worktrees.ts:382` (PATCH `/worktrees/:id/pin`)
- Client API: `web-ui/src/api/client.ts:192-204` (project methods)
- Mock API: `web-ui/src/api/mock.ts:29` (`createMockApi`; `ApiInstance` is a `client | mock` union — both must implement new methods)
- URL sync: `web-ui/src/hooks/useWorkspaceUrlSync.ts:41-66` (deep-link applies wtId with no hidden check)
- Client types: `web-ui/src/api/types.ts:9` (`Project`), `:140` (WS events)
- Server store: `web-ui/src/hooks/useServerStore.ts:32` (project reducers)
- WS sync: `web-ui/src/hooks/useServerSync.ts:85` (project event wiring)
- Sidebar: `web-ui/src/components/layout/LeftSidebar.tsx:400-431` (project row), `:281` (scroll container)
- Dashboard: `web-ui/src/components/layout/DashboardPanel.tsx:45,93` (worktree lists)
- Settings: `web-ui/src/components/settings/SettingsPanel.tsx:26` (sections)
- Route shell: `web-ui/src/routes/Workspace.tsx:74-90` (stale-selection cleanup)

---

## Problem

- Sidebar + dashboard list every project/worktree with no way to declutter.
- No project-row kebab exists today (only chevron + "New session" `+` button at `LeftSidebar.tsx:422-430`).
- Reopening the left sidebar resets scroll to top; selected worktree (`data-active="true"` at `LeftSidebar.tsx:443`) is lost if offscreen.

## Out of Scope

- Per-worktree hide (pin/dismiss already exist).
- Project delete/archive (CLI-only).
- Bulk hide/unhide, search, undo toast.
- Smooth-animated sidebar scroll (instant snap only).

## Concept

- Add `hidden` flag to a project (server-side, persisted in manifest, broadcast via WS).
- Project-row kebab menu (new) with **New worktree** + **Hide project**.
- Hidden projects filtered out of sidebar + dashboard everywhere.
- Settings gets a **Hidden projects** section to unhide.
- On sidebar open transition, snap the active worktree row into view.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Project kebab menu with "New worktree" (reuse `NewSessionDialog`) + "Hide project" (no confirm) |
| 2 | Hiding removes project + its worktrees from sidebar (expanded + collapsed) and dashboard, live across tabs |
| 3 | Hidden state server-side on manifest; survives daemon restart; identical across clients |
| 4 | Settings "Hidden projects" section lists hidden projects + per-row Unhide + empty state |
| 5 | Hiding never touches sessions/worktrees/files |
| 6 | Hiding the active project redirects to dashboard and clears active selection |
| 7 | Sidebar open snaps selected worktree into view only if offscreen; no-op if visible or none selected |

---

## Research

### Project data model — no visibility flag

- **File:** `daemon/src/types.ts:51-58` — `ProjectRecord` has no `hidden`.
- **File:** `daemon/src/routes/projects.ts:19-28` — `serializeProject` drops `worktrees`; must add `hidden`.
- **Risk:** LOW — additive optional field.

### No project PATCH endpoint

- **File:** `daemon/src/routes/projects.ts:41-193` — only GET/POST/DELETE.
- **Precedent:** `daemon/src/routes/worktrees.ts:382-469` (PATCH pin) — idempotent `mutateProject` + `broadcastAll`.
- **Risk:** LOW — mirror the pin pattern.

### WS `project:updated` event missing on BOTH sides (compile blocker)

- **File:** `daemon/src/ws/protocol.ts:191-197,239` — `ServerMessage` is a zod `discriminatedUnion`; has `project:created`/`project:deleted`, **no** `project:updated`. `broadcastAll` (`broadcaster.ts:32`) is strictly typed to it → `broadcastAll({type:"project:updated"})` is a **TS error**.
- **File:** `web-ui/src/api/types.ts:140-147` — client WS union also lacks `project:updated`.
- **File:** `web-ui/src/hooks/useServerStore.ts:32-62` — has `applyProjectCreated`/`applyProjectDeleted`, **no** `applyProjectUpdated`.
- **File:** `web-ui/src/hooks/useServerSync.ts:85-90,127-138` — wires `project:created`/`project:deleted` only.
- **Risk:** MEDIUM — must add the event in 4 places (daemon zod + client union + reducer + sync); mirror `project:created`/`worktree:updated`.

### Mock API must implement new methods (compile blocker)

- **File:** `web-ui/src/api/mock.ts:29,257` — `createMockApi` has `deleteProject` (emits `project:deleted`) but no hide/unhide. `ApiInstance = client | mock` union (`api/index.ts:8`) → a method exists only if **both** declare it; all call sites take `api: ApiInstance`.
- **Risk:** MEDIUM — without mock impl, every `api.hideProject` call + every vitest using the mock fails to compile. Mock impl must mutate in-memory project + `emit({type:"project:updated",project})` so reducer/integration tests exercise real flow.

### Deep-link to hidden project's worktree (leak + effect fight)

- **File:** `web-ui/src/hooks/useWorkspaceUrlSync.ts:41-66` — read effect resolves `params.wtId` from the **unfiltered** `worktrees` and sets it active with **no hidden check**; write effect (`:71-93`) mirrors it back to the path.
- **File:** `web-ui/src/routes/Workspace.tsx:74-90` — stale-selection effect clears selection when worktree missing but does **not** `navigate()`; deps `[bundleLoaded, worktrees, sessions]` (no `projects`).
- **Risk:** MEDIUM — hidden project's worktree stays openable by URL; redirect must cover the URL-sync path, add `projects` to deps, and be a **separate branch** from `!wtStillExists`.

### Dashboard projects section + counts also list projects

- **File:** `web-ui/src/components/layout/DashboardPanel.tsx:243-248` — a `projects.map` "projects" section (cards) below the worktree buckets; must also be filtered (R7), not just buckets at `:89-103`.
- **Risk:** LOW.

### Sidebar render sites

- **File:** `LeftSidebar.tsx:72` — `projects` from `useServerStore`; mapped at `:400`.
- **File:** `LeftSidebar.tsx:121` — `wtMenu` state + portal menu at `:585-680` is the kebab pattern to copy.
- **File:** `LeftSidebar.tsx:281-283` — `.left-sidebar__scroll` is the scroll container (no ref today).
- **File:** `LeftSidebar.tsx:222-230` — effect already auto-expands `activeProjectId` into `openProj` (so active row will exist in DOM).
- **Risk:** MEDIUM — sidebar is dense; must filter in both expanded + collapsed paths and not break pinned section (pinned worktrees at `:97-104,285-359` must also drop hidden-project worktrees).

### Dashboard render sites

- **File:** `DashboardPanel.tsx:45-47` — `projects`/`worktrees`/`sessions` from store.
- **File:** `DashboardPanel.tsx:89-103` — buckets iterate `worktrees`; filter by hidden-project here.
- **File:** `DashboardPanel.tsx:82` — `projectById` available for lookup.
- **Risk:** LOW.

### Sidebar open transition

- **File:** `Workspace.tsx:40-43,98` — `leftSidebarCollapsed` (desktop) / `mobileSidebarOpen` (mobile) control visibility; LeftSidebar gets `collapsed` + `isMobile` props (`:137-138`).
- **File:** `useStore.ts:42-45,207-209` — both flags live in `useWorkspaceStore`.
- **Risk:** MEDIUM — must detect false→true transition and scroll after layout settles (expand may add the row same frame).

## Root Cause

- **Hide:** feature never existed — no flag, no endpoint, no filter.
- **Scroll:** sidebar has no scroll-restoration / scroll-to-active logic; native scroll resets when width/visibility changes.

---

## Architecture

```
[Project kebab "Hide"] → api.hideProject(id) → PATCH /projects/:id {hidden:true}
                                                      ↓
                                          mutateProject() → manifest.json
                                                      ↓
                                          broadcastAll(project:updated)
                                                      ↓
        useServerSync(project:updated) → useServerStore.applyProjectUpdated
                                                      ↓
              ┌──────────────────────────────────────┴───────────────────────┐
        LeftSidebar (filter hidden)                              DashboardPanel (filter hidden)
              │                                                                │
        Workspace (active project hidden → clear + nav "/")        SettingsPanel → HiddenProjectsSetting → Unhide

[Sidebar open transition] → useEffect(visible false→true) → scrollEl.querySelector('[data-active]').scrollIntoView({block:"nearest"})
```

---

## Design Details

### Critical User Journeys (CUJs)

#### CUJ 1 — Hide a project

```
User opens project kebab (⋮) in sidebar
  → Clicks "Hide project"
  → api.hideProject(id) PATCH → manifest hidden:true → broadcast
  → applyProjectUpdated sets project.hidden
  → Sidebar + dashboard drop the project and its worktrees (all tabs)
```

- **Edge — active project hidden:** Workspace effect detects `activeProjectId` now hidden → clears selection + `navigate("/")`.
- **Edge — concurrent delete:** `project:deleted` still cascades; `applyProjectUpdated` drops unknown ids (mirror `:80`).
- **Error:** PATCH fails → swallow like sibling handlers (`LeftSidebar.tsx:197`); no state change, project stays visible.

#### CUJ 2 — Unhide from Settings

```
User opens Settings → "Hidden projects"
  → Sees hidden projects (or empty state)
  → Clicks "Unhide"
  → api.unhideProject(id) PATCH hidden:false → broadcast
  → Project reappears in sidebar + dashboard; row leaves hidden list
```

- **Edge — none hidden:** empty state copy.

#### CUJ 3 — Reopen sidebar with offscreen selection

```
User scrolled, selected worktree far down → collapses sidebar (or closes drawer)
  → Reopens sidebar
  → visible transitions false→true
  → active project auto-expanded (existing effect :222)
  → rAF: active row scrollIntoView({block:"nearest"})
```

- **Edge — already visible:** `block:"nearest"` no-ops.
- **Edge — no selection / on dashboard:** no `[data-active="true"]` → no scroll.
- **Edge — user scrolls during open:** one-shot per transition; not re-fired.

### Data Model

| Entity | Field | Type | Constraints | Notes |
|--------|-------|------|-------------|-------|
| `ProjectRecord` | `hidden` | `boolean?` | optional | Absent/undefined ≡ visible; drop field when false (clean manifest, mirror `pinnedAt` drop at `worktrees.ts:436`) |
| `Project` (client) | `hidden` | `boolean` | always emit | Serialize `hidden: !!p.hidden` so client never special-cases |

- **Migration:** N — additive optional field; existing manifests load as visible.

### API Contracts

```
PATCH /projects/:id
  Request:  { hidden: boolean }
  Response: { ok: true, project: Project }
  Errors:   400 VALIDATION_ERROR, 404 NOT_FOUND
  Behavior: idempotent (no-op + no broadcast when already in requested state);
            broadcasts project:updated only on actual change
```

```
WS event (new): project:updated
  Payload:  { type: "project:updated", project: Project }
  Producer: PATCH /projects/:id  → Consumer: useServerSync → applyProjectUpdated
```

- Unchanged: GET/POST/DELETE `/projects` (only `serializeProject` gains `hidden`).

### Key Decisions

#### Decision 1: Server-side flag, not localStorage

- **Decision:** store `hidden` on the project manifest; sync via WS.
- **Rationale:** durable, cross-client, consistent with `pinnedAt`.
- **Where:** `daemon/src/types.ts:51`, `daemon/src/routes/projects.ts` (new PATCH + serialize).

#### Decision 2: Idempotent PATCH mirroring pin

- **Decision:** reuse the pin handler's outcome-closure pattern (no-op vs updated; 404 on race).
- **Rationale:** proven; avoids manifest churn + cross-tab bounce.
- **Where:** `daemon/src/routes/projects.ts` (new handler modeled on `worktrees.ts:385-469`).

#### Decision 3: Filter in render, single source of truth

- **Decision:** keep full `projects`/`worktrees` in store; filter `hidden` at each render site (sidebar, dashboard) + derive `hiddenProjects` in Settings.
- **Rationale:** store stays server-truth; Settings still needs the hidden ones.
- **Where:** `LeftSidebar.tsx:400` (project map), `:97-104` (pinned), `DashboardPanel.tsx:89-103`, `SettingsPanel.tsx`.

#### Decision 4: Hidden-aware projectId set helper

- **Decision:** compute `hiddenProjectIds = new Set(projects.filter(p=>p.hidden).map(p=>p.id))` and exclude worktrees whose `projectId` is in it (pinned section + dashboard).
- **Rationale:** worktrees carry only `projectId`; one set covers all worktree filters.
- **Where:** `LeftSidebar.tsx` (memo near `:75`), `DashboardPanel.tsx` (memo near `:82`).

#### Decision 5: Scroll trigger via visibility transition + double-rAF with null-retry

- **Decision:** in LeftSidebar, `visible = isMobile ? mobileSidebarOpen : !collapsed`; `useEffect` on `visible` rising edge → **double `requestAnimationFrame`** → query `[data-active="true"]` inside scroll-container ref → `scrollIntoView({block:"nearest"})`. If `querySelector` returns null (active row not yet inserted by the auto-expand effect), retry once on the next frame.
- **Rationale:** desktop expand changes width 52→220px + swaps abbrev→full labels + auto-expand inserts rows in the same commit; a single rAF runs before layout settles. Double-rAF runs after layout. `block:"nearest"` self-no-ops when already visible (R15).
- **Caveat:** unit tests can only spy that `scrollIntoView` is *called* — jsdom has no layout/`scrollIntoView` geometry. Real correctness verified manually in Docker (5.T3).
- **Where:** `LeftSidebar.tsx` (ref on `.left-sidebar__scroll` at `:282`, new effect + `prevVisible` ref near `:120`).

#### Decision 6: Active-project-hidden redirect (covers store AND URL-sync deep-link paths)

- **Decision:** in the `Workspace.tsx:74-90` effect, add a **separate branch**: if the active worktree exists but its project is `hidden`, clear selection AND `navigate("/")`. Add `projects` to the effect deps.
- **Rationale:** url-sync (`useWorkspaceUrlSync.ts:41-66`) has no hidden check and would keep a hidden project's worktree open + mirror it to the URL; centralizing the gate in Workspace (same `bundleLoaded` timing) overrides it without touching url-sync's one-shot logic.
- **Where:** `Workspace.tsx:74-90` (new branch separate from `!wtStillExists`; `projects` dep; `navigate("/")`).

#### Decision 7: Add `project:updated` to daemon zod union + client union

- **Decision:** add a `project:updated` schema to `daemon/src/ws/protocol.ts` `ServerMessage` (mirror `project:created` at `:191`, `project: z.record(z.string(), z.unknown())`) and to client `WSEvent` (`api/types.ts:159`). Cast payload `as unknown as Record<string,unknown>` like `projects.ts:148`.
- **Rationale:** `broadcastAll` is strictly typed to the zod union — without the daemon schema the broadcast won't compile.
- **Where:** `daemon/src/ws/protocol.ts:191,239`, `web-ui/src/api/types.ts:159`.

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/types.ts` | Add `hidden?: boolean` to `ProjectRecord` |
| `daemon/src/ws/protocol.ts` | Add `project:updated` schema to `ServerMessage` zod union (**compile blocker**) |
| `daemon/src/routes/projects.ts` | Add `hidden` to `serializeProject`; add PATCH `/projects/:id` (idempotent, broadcast `project:updated`) |
| `web-ui/src/api/types.ts` | Add `hidden: boolean` to `Project`; add `project:updated` to WS union |
| `web-ui/src/api/client.ts` | Add `hideProject(id)`/`unhideProject(id)` (PATCH) |
| `web-ui/src/api/mock.ts` | Implement `hideProject`/`unhideProject` (mutate + emit `project:updated`) (**compile blocker**) |
| `web-ui/src/hooks/useServerStore.ts` | Add `applyProjectUpdated` reducer (replace by id; drop unknown) |
| `web-ui/src/hooks/useServerSync.ts` | Wire `project:updated` → `applyProjectUpdated` |
| `web-ui/src/components/layout/LeftSidebar.tsx` | Project kebab (New worktree + Hide); filter hidden in project map (`:400`) + pinned memo (`:97`); scroll-container ref + open-snap effect |
| `web-ui/src/components/layout/DashboardPanel.tsx` | Exclude hidden-project worktrees from buckets (`:89`) AND projects section (`:243`) |
| `web-ui/src/components/settings/SettingsPanel.tsx` | Register "Hidden projects" section |
| `web-ui/src/components/settings/HiddenProjectsSetting.tsx` | **New** — list hidden projects + Unhide + empty state |
| `web-ui/src/routes/Workspace.tsx` | Redirect/clear when active project hidden (covers deep-link) |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Daemon broadcaster typed? | **YES** — `broadcastAll` is strictly typed to the zod `ServerMessage` union (`protocol.ts:239`); `project:updated` MUST be added there or it won't compile (Decision 7) |
| 2 | Scroll timing on desktop expand | Same-component (no remount on collapse↔expand), but a single rAF runs before the width/label layout settles → use double-rAF + null-retry (Decision 5) |
| 3 | Cross-branch remount resets `prevVisible` | LeftSidebar is rendered from 3 mutually-exclusive `Layout` branches (`Layout.tsx:133,317,341`); dashboard↔worktree nav or terminal-position toggle remounts it. A remount with an already-expanded sidebar fires one extra snap, which `block:"nearest"` no-ops if visible — acceptable; document that R18 "one-shot" holds within a mount, not across remounts |
| 4 | Mobile drawer mount | LeftSidebar stays mounted when drawer closed (`Layout.tsx:102-119`), so effect fires on `mobileSidebarOpen` flip |
| 5 | Collapsed rail kebab | Single `projects.map` at `:400` serves collapsed + expanded, so one `hiddenProjectIds` filter covers both; "Hide"/"New worktree" kebab shown expanded-only (no room on rail) — acceptable per PRD R5 |
| 6 | Deep-link to hidden worktree | url-sync has no hidden check (`useWorkspaceUrlSync.ts:41`); gate centralized in Workspace effect (Decision 6) |

---

## Implementation Phases

### Phase 1 — Backend: hidden flag + PATCH + broadcast

- [ ] **1.1** `daemon/src/types.ts:51` — add `hidden?: boolean` to `ProjectRecord`
- [ ] **1.2** `daemon/src/ws/protocol.ts:191,239` — add `project:updated` schema (`{type:literal, project:z.record}`) to `ServerMessage` union
- [ ] **1.3** `daemon/src/routes/projects.ts:19` — add `hidden: !!p.hidden` to `serializeProject`
- [ ] **1.4** `daemon/src/routes/projects.ts` — add `app.patch("/projects/:id")`: zod `{hidden:boolean}`, `mutateProject` set/drop field, idempotent no-op (broadcast only on change), `broadcastAll({type:"project:updated",project: ... as unknown as Record<string,unknown>})`, 404 via caught `mutateProject` throw (simpler than pin's nested re-lookup — see Decision/N2)

**Verify phase 1:**
- [ ] **1.T1** Unit — projects route: PATCH `{hidden:true}` returns `{ok,project.hidden:true}`; PATCH unknown id → 404; invalid body → 400
- [ ] **1.T2** Integration — manifest: PATCH persists `hidden` then reload (`readManifest`) returns it; PATCH `{hidden:false}` drops field
- [ ] **1.T3** Regression — GET `/projects` still returns existing projects with `hidden:false`

### Phase 2 — Client data layer

- [ ] **2.1** `web-ui/src/api/types.ts:9` — `hidden: boolean` on `Project`; `:159` add `project:updated` event
- [ ] **2.2** `web-ui/src/api/client.ts` — `hideProject(id)` / `unhideProject(id)` PATCH `/projects/:id`
- [ ] **2.3** `web-ui/src/api/mock.ts:29` — implement `hideProject`/`unhideProject` (mutate in-memory project + `emit({type:"project:updated",project})`)
- [ ] **2.4** `web-ui/src/hooks/useServerStore.ts` — `applyProjectUpdated` (replace by id, drop unknown — mirror `:75-84`)
- [ ] **2.5** `web-ui/src/hooks/useServerSync.ts` — subscribe `project:updated` → `applyProjectUpdated` (+ cleanup)

**Verify phase 2:**
- [ ] **2.T1** Unit — `useServerStore`: `applyProjectUpdated` replaces matching project, ignores unknown id
- [ ] **2.T2** Unit — mock api: `hideProject` issues PATCH with `{hidden:true}` to correct URL
- [ ] **2.T3** Integration — sync: dispatched `project:updated` event updates store project's `hidden`

### Phase 3 — UI: hide entry + filtering

- [ ] **3.1** `LeftSidebar.tsx:75` — memo `hiddenProjectIds`; filter `projects.map` (`:400`) and `pinnedWorktrees` (`:97`) by hidden
- [ ] **3.2** `LeftSidebar.tsx:120,422` — add `projMenu` state + project kebab button (expanded only) + portal menu (copy `:585-680`) with "New worktree" (`setNewSessProject(p)`) and "Hide project" (`api.hideProject(p.id)`)
- [ ] **3.3** `DashboardPanel.tsx:82` — memo `hiddenProjectIds`; exclude worktrees whose `projectId` ∈ set in buckets (`:89-103`), `renderWorktreeCard`, AND the projects section `projects.map` (`:243-248`)
- [ ] **3.4** `Workspace.tsx:74-90` — add branch: active worktree's project hidden → clear selection + `navigate("/")`; add `projects` to deps (covers url-sync deep-link)

**Verify phase 3:**
- [ ] **3.T1** Unit — `LeftSidebar`: hidden project not rendered; its worktrees absent from pinned section
- [ ] **3.T2** Unit — `DashboardPanel`: hidden-project worktree cards AND its project card (`:243`) not rendered
- [ ] **3.T3** Integration — hide active project → redirected to dashboard, selection cleared, TopBar crumb reads "Dashboard"
- [ ] **3.T4** Integration — deep-link `/worktree/:id` of a hidden project → lands on dashboard (not the worktree)
- [ ] **3.T5** Regression — non-hidden projects + "New session"/kebab worktree actions still work

### Phase 4 — Settings unhide

- [ ] **4.1** `web-ui/src/components/settings/HiddenProjectsSetting.tsx` — new component: `SectionHeader` + list of `projects.filter(hidden)` with Unhide button + empty state
- [ ] **4.2** `SettingsPanel.tsx:21-39` — add ref + section entry "Hidden projects"

**Verify phase 4:**
- [ ] **4.T1** Unit — `HiddenProjectsSetting`: renders hidden projects; empty state when none; Unhide calls `api.unhideProject`
- [ ] **4.T2** Integration — unhide → project reappears in sidebar list

### Phase 5 — Scroll-to-selected on sidebar open

- [ ] **5.1** `LeftSidebar.tsx:282` — `scrollRef` on `.left-sidebar__scroll`
- [ ] **5.2** `LeftSidebar.tsx` — `visible = isMobile ? mobileSidebarOpen : !collapsed`; `prevVisible` ref; effect on rising edge → **double rAF** → `scrollRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:"nearest"})`; if querySelector null, retry once next frame

**Verify phase 5:**
- [ ] **5.T1** Unit — `LeftSidebar`: on visible false→true with an active row offscreen, `scrollIntoView` called once (spy)
- [ ] **5.T2** Unit — no active row → `scrollIntoView` not called
- [ ] **5.T3** Integration — collapse→expand keeps selected worktree visible (manual/Docker)

### Phase 6 — Verification (Docker)

- [ ] **6.1** Build daemon + web-ui; run app in Docker (`docker-compose.dev.yml`)
- [ ] **6.2** Manual: hide project from kebab → gone from sidebar + dashboard; unhide in Settings → returns
- [ ] **6.3** Manual: scroll list, collapse + reopen → snaps to selected worktree; mobile drawer same

**Verify phase 6:**
- [ ] **6.T1** Integration — full lint + typecheck + `vitest` suite green
- [ ] **6.T2** Integration — two browser tabs: hide in one reflects in the other (WS broadcast)

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/types.ts` | 1.1 | `hidden?` on `ProjectRecord` |
| `daemon/src/ws/protocol.ts` | 1.2 | `project:updated` zod schema in `ServerMessage` |
| `daemon/src/routes/projects.ts` | 1.3,1.4 | serialize `hidden`; PATCH handler |
| `web-ui/src/api/types.ts` | 2.1 | `Project.hidden`; `project:updated` event |
| `web-ui/src/api/client.ts` | 2.2 | `hideProject`/`unhideProject` |
| `web-ui/src/api/mock.ts` | 2.3 | mock `hideProject`/`unhideProject` + emit |
| `web-ui/src/hooks/useServerStore.ts` | 2.4 | `applyProjectUpdated` |
| `web-ui/src/hooks/useServerSync.ts` | 2.5 | wire `project:updated` |
| `web-ui/src/components/layout/LeftSidebar.tsx` | 3.1,3.2,5.1,5.2 | filter + project kebab + scroll snap |
| `web-ui/src/components/layout/DashboardPanel.tsx` | 3.3 | filter hidden worktrees |
| `web-ui/src/routes/Workspace.tsx` | 3.4 | hidden active-project redirect |
| `web-ui/src/components/settings/SettingsPanel.tsx` | 4.2 | register section |
| `web-ui/src/components/settings/HiddenProjectsSetting.tsx` | 4.1 | new section component |
| `daemon/src/routes/projects.test.ts` | 1.T1,1.T2 | PATCH unit/integration |
| `web-ui/src/hooks/useServerStore.test.ts` | 2.T1 | reducer unit |
| `web-ui/src/components/layout/LeftSidebar.test.tsx` | 3.T1,5.T1,5.T2 | filter + scroll unit |
| `web-ui/src/components/layout/DashboardPanel.test.tsx` | 3.T2 | filter unit |
| `web-ui/src/components/settings/HiddenProjectsSetting.test.tsx` | 4.T1 | settings unit |

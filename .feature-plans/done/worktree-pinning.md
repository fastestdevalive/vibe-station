# Mini-Design: Worktree Pinning in Sidebar

> Let users pin any worktree to a dedicated "Pinned" section at the top of the LeftSidebar via the existing 3-dot menu.

**Issue:** worktree-pinning
**Branch:** `Worktree-pinning`
**Status:** Done

**Reference files:**
- Sidebar UI: `web-ui/src/components/layout/LeftSidebar.tsx`
- Sidebar CSS: `web-ui/src/styles/workspace.css` (~line 408+, 680–810)
- Server store types: `daemon/src/types.ts:36` (`WorktreeRecord`)
- Server routes: `daemon/src/routes/worktrees.ts` (`serializeWorktree:108`, `done:381`, `delete:398`)
- Server WS protocol: `daemon/src/ws/protocol.ts:190–198`
- Server data layer: `daemon/src/state/project-store.ts` (`mutateProject:67`)
- Client API: `web-ui/src/api/client.ts:218–247`, mock at `web-ui/src/api/mock.ts:278–306`
- Client API types: `web-ui/src/api/types.ts` (`Worktree`)
- Client server-state store: `web-ui/src/hooks/useServerStore.ts`
- Client server-sync: `web-ui/src/hooks/useServerSync.ts`
- Workspace store (client-only UI prefs): `web-ui/src/hooks/useStore.ts`

---

## Problem

- Users with many worktrees across multiple projects must scroll/expand projects to find frequently-used ones.
- No way to surface a small "favorites" list of worktrees they're actively working on.

## Out of Scope

- Drag-to-reorder pinned worktrees (order = `pinnedAt DESC`, deterministic).
- Pinning entire projects.
- Pinning in the collapsed rail (collapsed sidebar still shows only the existing project tree).
- Mobile-specific tweaks beyond what falls out for free.
- Per-user pinning (single-user daemon; pin is a property of the worktree itself).

## Concept

- Add a server-side `pinnedAt: string | null` (ISO8601) field on `WorktreeRecord`. Null = not pinned. The timestamp also gives us free recency-based ordering (newest pinned first).
- New endpoint `PATCH /worktrees/:id/pin` with body `{ pinned: boolean }` that toggles the field and broadcasts a `worktree:updated` WS event.
- Add `pinWorktree` / `unpinWorktree` client API methods + mock parity.
- Add **Pin to top** / **Unpin** menu item in the existing 3-dot worktree menu (label flips based on `pinnedAt`).
- Render a new **"Pinned"** section at the top of the sidebar scroll area when at least one pinned worktree exists, above the **Projects** heading.
- Pinned rows show two-line content: branch (top) + project name (subheader), with the worktree id chip on the right that swaps to the same 3-dot menu on hover (same UX pattern as today).
- Pinned rows still link to `/worktree/:id` and reuse `setActiveWorktree` for selection.
- Pin state syncs across browser tabs / devices via the WS `worktree:updated` event handled by `useServerSync`.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Pin / unpin from the existing 3-dot menu on every worktree row in the project tree. |
| 2 | Pinned worktrees appear in a dedicated "Pinned" section at the top of the sidebar. |
| 3 | Pinned row is two-line: branch name on top, project name on the subline. |
| 4 | Right side shows worktree id by default; on hover/focus the id fades out and the 3-dot menu (with **Unpin** + all existing actions) fades in — same animation/CSS as today's `tree-row--worktree`. |
| 5 | Pinned section disappears entirely when no worktrees are pinned (no empty heading). |
| 6 | Pin state is server-authoritative: persists in `~/.vibe-station/projects/<id>/manifest.json`. |
| 7 | Worktree still appears in its project tree even when pinned (it is NOT moved, only mirrored). |
| 8 | Deleting a worktree naturally removes its pin (the record disappears). No special-case needed. |
| 9 | Pin/unpin from one tab/device propagates to others via the `worktree:updated` WS event. |
| 10 | Collapsed rail is unchanged (no pinned section in collapsed mode). |
| 11 | `GET /worktrees` response includes `pinnedAt` (null or ISO) so initial render is correct without an extra round-trip. |

---

## Research

### Server data model

- **File:** `daemon/src/types.ts:36–43` — `WorktreeRecord` fields: `id`, `branch`, `baseBranch`, `baseSha`, `createdAt`, `sessions`.
- Adding `pinnedAt?: string | null` is backward compatible (optional in TS, missing in old manifests reads as `undefined` ≈ unpinned).
- Persistence: `mutateProject` (`daemon/src/state/project-store.ts:67`) writes manifest atomically. Existing pattern.
- **Risk:** LOW.

### Existing 3-dot menu

- **File:** `web-ui/src/components/layout/LeftSidebar.tsx:478–546`
- Portal-rendered, positioned via `wtMenu.rect`. Three items today: Mark as done / Dismiss / Delete.
- Hover-swap CSS for id ↔ menu trigger: `web-ui/src/styles/workspace.css:740–776`.
- **Risk:** LOW — adding a fourth menuitem above existing items is straightforward.

### Sidebar render loop

- **File:** `web-ui/src/components/layout/LeftSidebar.tsx:287–403`
- Projects are mapped under a single scroll container at `:253–404`. The "Projects" heading is at `:257`.
- A new "Pinned" section needs to be inserted BEFORE that heading and AFTER the optional mobile brand link at `:238`.
- **Risk:** LOW — pure additive insertion.

### Server routes — existing worktree mutators

- **File:** `daemon/src/routes/worktrees.ts:381–395` (`POST /worktrees/:id/done`) — pattern for mutating a worktree and broadcasting.
- `serializeWorktree` (`:108–117`) is the single canonical client shape. Add `pinnedAt: w.pinnedAt ?? null` here so every response (list, create, update) ships it consistently.
- **Risk:** LOW.

### WS protocol

- **File:** `daemon/src/ws/protocol.ts:190–198`
- Existing `worktree:created` and `worktree:deleted` events use `{ worktree: record }` and `{ worktreeId }` shapes.
- Add `worktree:updated` with `{ worktree: serializeWorktree(...) }` — same shape as `worktree:created`, semantically distinct.
- **Risk:** LOW.

### Client server-store + sync

- **File:** `web-ui/src/hooks/useServerStore.ts` — flat `worktrees: Worktree[]` array.
- **File:** `web-ui/src/hooks/useServerSync.ts` — handles `worktree:created` / `worktree:deleted`. New `worktree:updated` handler must replace-by-id (immutable update preserving array order).
- `Worktree` type in `web-ui/src/api/types.ts` gains `pinnedAt: string | null`.
- **Risk:** LOW.

### Client API + mock

- **File:** `web-ui/src/api/client.ts:218–247` — existing pattern (e.g. `markWorktreeDone`).
- **File:** `web-ui/src/api/mock.ts:278–306` — must add mock parity to avoid breaking tests using the in-memory mock.
- **Risk:** LOW.

### LeftSidebar local state

- **File:** `web-ui/src/components/layout/LeftSidebar.tsx`
- No client-side persistence is added. The pinned section just reads `useServerStore.worktrees.filter(w => w.pinnedAt).sort by pinnedAt desc`.
- **Risk:** LOW.

---

## Architecture

```
Daemon
   ├── WorktreeRecord                       ← new optional pinnedAt: string | null
   ├── serializeWorktree                    ← always emits pinnedAt (defaults to null)
   ├── PATCH /worktrees/:id/pin             ← body { pinned: boolean } → mutateProject → broadcast
   └── WS "worktree:updated" { worktree }   ← new event, same shape as worktree:created

Web client
   ├── api.pinWorktree(id) / unpinWorktree(id)   ← thin wrappers over PATCH
   ├── api/types.Worktree { ..., pinnedAt: string | null }
   ├── useServerSync                              ← handles worktree:updated (replace-by-id)
   └── LeftSidebar
        ├── PinnedSection (derived from worktrees.filter(pinnedAt).sort desc)
        └── ⋯ menu adds Pin/Unpin (label by pinnedAt) — calls api.pinWorktree/unpinWorktree
```

---

## Design Details

### Critical User Journeys (CUJs)

#### CUJ 1 — Pin a worktree

```
User opens sidebar → Hovers row "feat/new-login" in project "alpha"
  → Clicks ⋯ → menu opens with "Pin to top"
  → Client calls api.pinWorktree(id)
       → PATCH /worktrees/:id/pin { pinned: true }
       → Daemon mutates record: pinnedAt = ISO now → writes manifest
       → Daemon broadcasts worktree:updated
  → useServerSync replaces the worktree in useServerStore.worktrees
  → "Pinned" section appears at top with the row
  → Row in project tree still present; its menu now reads "Unpin"
```

- **Edge:** PATCH with `{ pinned: true }` on an already-pinned worktree returns 200 OK without changing `pinnedAt`. Idempotent.
- **Edge:** First pin ever → "Pinned" heading appears.
- **Error:** Network failure → menu closes anyway; the next list refresh re-syncs. Surface errors later (matches existing dismiss/delete patterns).

#### CUJ 2 — Unpin (from either place)

```
User clicks ⋯ on pinned row → menu reads "Unpin"
  → api.unpinWorktree(id) → PATCH ... { pinned: false } → pinnedAt = null
  → worktree:updated broadcast → row disappears from pinned section
  → If last pinned worktree, section unmounts
```

#### CUJ 3 — Worktree deleted while pinned

```
User deletes pinned worktree X via ⋯ → Delete
  → DELETE /worktrees/X
  → Daemon removes the record (no special pin handling needed)
  → broadcasts worktree:deleted
  → useServerStore.worktrees shrinks → pinned-section derivation drops it naturally
```

#### CUJ 4 — Cross-tab sync

```
Two tabs open on same daemon
  → User pins in tab A → PATCH → worktree:updated broadcast
  → Both tabs' useServerSync receive the event and update the local store
  → Tab B's pinned section updates without reload
```

### Data Model

| Entity | Field | Type | Constraints | Notes |
|--------|-------|------|-------------|-------|
| `WorktreeRecord` (daemon) | `pinnedAt?` | `string \| undefined` | optional ISO8601 | Absent / undefined ≡ unpinned. |
| `Worktree` (web `api/types.ts`) | `pinnedAt` | `string \| null` | required field, `null` ≡ unpinned | Always present in API response (`serializeWorktree` normalizes). |

- **Migration:** None — `WorktreeRecord.pinnedAt` is optional, so manifests written before this change rehydrate as `undefined` and serialize as `null`. Old daemons + new clients are forward-compatible because clients only render the pinned section when `pinnedAt != null`.

### API Contracts

```
PATCH /worktrees/:id/pin
  Request:  { pinned: boolean }
  Response: { ok: true, worktree: SerializedWorktree }
  Errors:   400 invalid body, 404 worktree not found

GET /worktrees                       (existing) — response items now include `pinnedAt: string | null`
GET /worktrees?project=<id>          (existing) — same
POST /worktrees                      (existing) — response now includes `pinnedAt: null` on a new worktree

WS event:
  { type: "worktree:updated", worktree: SerializedWorktree }
```

- **Authorization:** No new policy. Pinning has the same trust boundary as marking done.

### Key Decisions

#### Decision 1: Server-side, single optional field

- **Decision:** `WorktreeRecord.pinnedAt?: string`. Single nullable timestamp encodes both "is pinned" and "pin recency" — no separate boolean + order field.
- **Rationale:** Smallest possible schema change; deterministic ordering; survives daemon restart automatically through existing manifest persistence.
- **Where:** `daemon/src/types.ts:36–43`, `daemon/src/routes/worktrees.ts:108–117` (serializer normalizes to `null`).

#### Decision 2: Pinned section mirrors, not moves

- **Decision:** Pinned worktrees still appear under their project. The pinned row is a second visual presence.
- **Rationale:** Avoids confusing "where did my worktree go?" and keeps project tree complete for navigation/filtering.
- **Where:** `LeftSidebar.tsx` new section + unchanged project tree loop.

#### Decision 3: No client-side prune logic needed

- **Decision:** Because pin state lives ON the worktree record, deleting the worktree removes the pin trivially. No client bookkeeping.
- **Where:** N/A.

#### Decision 3b: `PATCH /worktrees/:id/pin` (not POST /pin and DELETE /pin)

- **Decision:** Single PATCH route with a boolean body, idempotent.
- **Rationale:** Smaller surface; matches REST patterns; mirrors the "single endpoint with a flag" style used in many other vst routes.

#### Decision 4: Single shared menu, label flips

- **Decision:** Keep the existing portal menu component. Add **one** new menu item whose label is `"Pin to top"` or `"Unpin"` based on `pinnedWorktreeIds.includes(wtMenu.worktree.id)`.
- **Rationale:** Avoids duplicating menu JSX for pinned vs. unpinned rows.

#### Decision 5: Pinned row layout — explicit grid, not reused `wt-row` styles

- **Decision:** Pinned row is a 3-column grid: `[dot 16px] [primary+subhead stack 1fr] [trail auto]`. Subhead is smaller (`--font-size-xs`), muted (`--fg-muted`).
- **Stretch-link adjustment:** the absolute `inset:0` link still works on a taller row; the trail uses `align-self: start; padding-top: 4px` so the id / ⋯ sits at the top-right next to the branch (not vertically centered between the two lines). Override the inherited `wt-menu-trigger { top:50%; translateY(-50%) }` rule with `.pinned-row .wt-menu-trigger { top: 4px; transform: none }` (or use a new class).
- **Trigger attributes:** the pinned-row ⋯ button MUST set `data-wt-menu-trigger` so the existing outside-click handler in `LeftSidebar.tsx:120–124` correctly excludes it.
- **Where:** new CSS classes `.pinned-section`, `.pinned-section__heading`, `.pinned-row`, `.pinned-row__primary`, `.pinned-row__subhead`, `.pinned-row__trail`.

```
┌────────────────────────────────────────────────┐
│ Pinned                                         │
│ ┌────────────────────────────────────────────┐ │
│ │ feat/new-login                       vs-3 │ │  ← hover: vs-3 → ⋯
│ │ alpha                                      │ │
│ └────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────┐ │
│ │ bugfix/auth                          vs-7 │ │
│ │ beta                                       │ │
│ └────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
Projects   ▾ Filter
  ▾ alpha                                      +
    • feat/new-login                       vs-3
  ▾ beta                                       +
    • bugfix/auth                          vs-7
```

---

## Files to Modify

### Daemon

| File | Change |
|------|--------|
| `daemon/src/types.ts` | Add optional `pinnedAt?: string` to `WorktreeRecord`. |
| `daemon/src/routes/worktrees.ts` | Update `serializeWorktree` to emit `pinnedAt: w.pinnedAt ?? null`. Add `PATCH /worktrees/:id/pin` handler → `mutateProject` + broadcast `worktree:updated`. |
| `daemon/src/ws/protocol.ts` | Add `WorktreeUpdatedEvent` and include it in the discriminated union. |
| `daemon/src/__tests__/worktrees.routes.test.ts` (or sibling) | New tests: PATCH toggles, idempotent, 404 on missing id, 400 on bad body, broadcasts the event. |

### Web client

| File | Change |
|------|--------|
| `web-ui/src/api/types.ts` | Add `pinnedAt: string \| null` to `Worktree`; add `worktree:updated` variant to `WSEvent`. |
| `web-ui/src/api/client.ts` | Add `pinWorktree(id)` / `unpinWorktree(id)` methods (PATCH). |
| `web-ui/src/api/mock.ts` | Mock parity (mutate in-memory record + emit fake event for test harnesses that use it). |
| `web-ui/src/hooks/useServerSync.ts` | Handle `worktree:updated` event: replace matching id immutably. |
| `web-ui/src/components/layout/LeftSidebar.tsx` | Derive pinned list from `worktrees.filter(pinnedAt).sort by pinnedAt desc`; render Pinned section above Projects heading; add Pin/Unpin menu item with label flip; pinned-row ⋯ carries `data-wt-menu-trigger`. |
| `web-ui/src/styles/workspace.css` | Add `.pinned-section`, `.pinned-row` grid + two-line subhead + `.pinned-row .wt-menu-trigger { top: 4px; transform: none }` override. |
| `web-ui/src/components/layout/LeftSidebar.test.tsx` | Tests: pin/unpin via menu calls correct API; pinned section visibility; menu label flip; dual-active highlight; `data-wt-menu-trigger` present. |
| `web-ui/src/api/types-and-client.test.ts` (or sibling) | If applicable: test that `pinWorktree` POSTs the right shape. |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Pinned order — recency or stable insertion?** | Newest first (prepend on pin). Future drag-to-reorder can change this. |
| 2 | **Should the "active" indicator apply to pinned row too?** | Yes — same `data-active` rule based on `activeWorktreeId === w.id && location.pathname.startsWith("/worktree/")`. |
| 3 | **What if pinned section gets very long?** | Sidebar scroll handles it; no max. Could add `max-height` later if needed. |
| 4 | **Status dot in pinned row?** | Yes — leading slot like existing rows; reuses `worktreeRolledUpStatus`. |
| 5 | **Collapsed rail behavior?** | Hidden; pinned section not rendered when `collapsed=true`. |
| 6 | **Test in a docker container — risk to main daemon/app?** | Use `docker-compose.dev.yml` which is explicitly isolated (host port 5174 → container 5173, separate `vst-dev-data` volume, no host bind-mount of daemon data). No interference with the host's running vibe-station. |
| 7 | **Manifest write race vs. concurrent `markDone` etc.?** | Existing `mutateProject` uses `withProjectLock` — already serialized. Pin PATCH inherits this protection. |
| 8 | **`worktree:updated` is also semantically right for other future updates** | Yes — naming it generically opens the door, but spec says the only new field for now is `pinnedAt`. Other future updates can reuse the event. |

---

## Implementation Phases

### Phase 1 — Daemon: data + endpoint + event

- [ ] **1.1** Add `pinnedAt?: string` to `WorktreeRecord` in `daemon/src/types.ts:36`.
- [ ] **1.2** Update `serializeWorktree` in `daemon/src/routes/worktrees.ts:108` to include `pinnedAt: w.pinnedAt ?? null`.
- [ ] **1.3** Add `PATCH /worktrees/:id/pin` route: validate body `{ pinned: boolean }` with Zod; locate project; `mutateProject` setting/clearing `pinnedAt`; broadcast `{ type: "worktree:updated", worktree: serializeWorktree(...) }`; return `{ ok: true, worktree }`.
- [ ] **1.4** Add `WorktreeUpdatedEvent` to `daemon/src/ws/protocol.ts` and add it to the union.

**Verify phase 1:**
- [ ] **1.T1** Unit — route test: PATCH with `{ pinned: true }` writes `pinnedAt` (ISO format), returns 200 with updated worktree.
- [ ] **1.T2** Unit — route test: PATCH with `{ pinned: false }` clears `pinnedAt` (record has it deleted or set to undefined).
- [ ] **1.T3** Unit — route test: PATCH is idempotent — pin twice keeps the *first* `pinnedAt` OR re-stamps it (spec the chosen behavior; prefer "no-op when already in the requested state" so cross-tab pins don't bounce timestamps).
- [ ] **1.T4** Unit — route test: 404 on unknown worktree id; 400 on missing/invalid `pinned`.
- [ ] **1.T5** Unit — route test: broadcasts `worktree:updated` with the serialized record on success (spy on `broadcastAll`).
- [ ] **1.T6** Unit — `GET /worktrees` response shape includes `pinnedAt` (null for unpinned, ISO for pinned).

---

### Phase 2 — Web client: types, API, sync

- [ ] **2.1** Add `pinnedAt: string | null` to `Worktree` in `web-ui/src/api/types.ts`.
- [ ] **2.2** Add `worktree:updated` variant to `WSEvent` in the same file: `{ type: "worktree:updated"; worktree: Worktree }`.
- [ ] **2.3** Add `pinWorktree(id)` and `unpinWorktree(id)` to `web-ui/src/api/client.ts` — both PATCH `/worktrees/:id/pin` with `{ pinned: true|false }`. Return `Worktree`.
- [ ] **2.4** Mirror in `web-ui/src/api/mock.ts`: mutate the in-memory worktree, return it. (If the mock supports emitting WS events to subscribers, emit `worktree:updated`; otherwise note this gap for the test plan.)
- [ ] **2.5** In `web-ui/src/hooks/useServerSync.ts`, handle `worktree:updated`: replace matching id in `useServerStore.worktrees` (immutable map, preserving order).

**Verify phase 2:**
- [ ] **2.T1** Unit — `api/client.test`: `pinWorktree("w1")` sends PATCH to `/worktrees/w1/pin` with body `{ pinned: true }`.
- [ ] **2.T2** Unit — `useServerSync.test`: simulate `worktree:updated` event → `useServerStore.worktrees` reflects the updated `pinnedAt` for the matching id; other worktrees untouched.
- [ ] **2.T3** Unit — `useServerSync.test`: `worktree:updated` for an unknown id is a no-op (does not append).

---

### Phase 3 — Sidebar UI: pinned section + menu wiring

- [ ] **3.1** In `LeftSidebar.tsx`, derive `pinnedWorktrees`: `useServerStore.worktrees.filter(w => w.pinnedAt).sort((a,b) => b.pinnedAt!.localeCompare(a.pinnedAt!))` (ISO sort = chronological).
- [ ] **3.2** Render `<section class="pinned-section">` ABOVE the `Projects` heading (and below the optional mobile brand link), visible iff `pinnedWorktrees.length > 0` AND `!collapsed`.
- [ ] **3.3** Render each pinned worktree as `<div class="pinned-row">`:
  - Status dot via `worktreeRolledUpStatus(sessionMap[w.id] ?? [], sessionStates)`
  - `.pinned-row__primary` = branch
  - `.pinned-row__subhead` = `projects.find(p => p.id === w.projectId)?.name`
  - `.pinned-row__trail` containing `wt-row__id` (worktree id chip) + ⋯ button with `data-wt-menu-trigger`
  - Stretch link to `/worktree/:id` (same pattern as existing row); on click → `selectWorktree(w.projectId, w)`.
- [ ] **3.4** Add CSS: `.pinned-section` (container), `.pinned-section__heading` (matches `sidebar-projects-heading` styling), `.pinned-row` (grid: 16px 1fr auto, gap var(--space-1), padding matches `tree-row--worktree`), `.pinned-row__primary` (regular weight), `.pinned-row__subhead` (xs, `--fg-muted`), `.pinned-row__trail` (align-self: start; padding-top: 4px), `.pinned-row:hover .wt-row__id { opacity: 0 }`, `.pinned-row:hover .wt-menu-trigger, .pinned-row .wt-menu-trigger[aria-expanded="true"] { opacity: 1; pointer-events: auto }`, plus `.pinned-row .wt-menu-trigger { top: 4px; transform: none }` override to defeat the inherited vertical-center rule.
- [ ] **3.5** Both pinned-row and project-tree-row carry `data-active` based on `activeWorktreeId === w.id && location.pathname.startsWith("/worktree/")`.
- [ ] **3.6** In the portal menu (`LeftSidebar.tsx:478+`), add a new menuitem at the TOP: label = `wtMenu.worktree.pinnedAt ? "Unpin" : "Pin to top"`. Click → `void api.pinWorktree(id)` or `unpinWorktree(id)` (do not block on the response; UI updates from `worktree:updated`). Then `setWtMenu(null)`.

**Verify phase 3:**
- [ ] **3.T1** Unit — `LeftSidebar.test`: with one pinned worktree in `useServerStore`, "Pinned" section renders and shows branch + project name.
- [ ] **3.T2** Unit — `LeftSidebar.test`: section is hidden when no worktrees have `pinnedAt`; also hidden when `collapsed=true` even with pins.
- [ ] **3.T3** Unit — `LeftSidebar.test`: clicking ⋯ on an unpinned project-tree row shows "Pin to top"; clicking it invokes `api.pinWorktree(id)`.
- [ ] **3.T4** Unit — `LeftSidebar.test`: clicking ⋯ on a pinned row shows "Unpin"; clicking it invokes `api.unpinWorktree(id)`.
- [ ] **3.T5** Unit — `LeftSidebar.test`: when the active worktree is pinned, both the pinned-row and the project-tree row carry `data-active="true"`.
- [ ] **3.T6** Unit — `LeftSidebar.test`: pinned-row ⋯ button has `data-wt-menu-trigger`.
- [ ] **3.T7** Regression — existing menu items (Mark as done / Dismiss / Delete) still render and call their handlers.
- [ ] **3.T8** Unit — `LeftSidebar.test`: pinned-section order matches `pinnedAt DESC` (newest first).

---

### Phase 4 — Manual verification in docker sandbox

- [ ] **4.1** Boot `docker compose -f docker-compose.dev.yml up --build -d` (port 5174, isolated `vst-dev-*` volumes — does NOT touch the host daemon). Container hot-reloads the FE from `./web-ui/src`; rebuild for daemon code changes.
- [ ] **4.2** Use the sandbox's pre-seeded projects/worktrees (the `vst-dev-projects` volume persists demo state across rebuilds). If empty, create 2 projects with at least 2 worktrees each via the CLI inside the container.
- [ ] **4.3** Pin one worktree from each project via the ⋯ menu; full page reload; verify pinned section still shows them (sourced from the daemon manifest, not the browser).
- [ ] **4.4** Open a second browser tab on the same daemon; pin/unpin from one tab; verify cross-tab sync via WS.
- [ ] **4.5** Capture a screenshot at `~/Downloads/worktree-pinning.png` (1440x900) via Playwright (`@playwright/test`) — script can mirror `scripts/take-screenshots.ts` patterns. Target URL `http://localhost:5174`.

**Verify phase 4:**
- [ ] **4.T1** Manual — pinned section appears at top: branch on top, project subheader below; hover swaps id → ⋯; menu reads "Unpin".
- [ ] **4.T2** Manual — full reload (Ctrl+R, cache disabled): pinned section persists from the daemon.
- [ ] **4.T3** Manual — delete pinned worktree via menu → pinned row disappears via the existing `worktree:deleted` flow; section hides if last.
- [ ] **4.T4** Manual — cross-tab: pin in tab A, observe in tab B without reload.
- [ ] **4.T5** Manual — host machine's running vibe-station (different port) is untouched — verify by opening it after the docker test.

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/types.ts` | 1.1 | Add `pinnedAt?: string` to `WorktreeRecord`. |
| `daemon/src/routes/worktrees.ts` | 1.2, 1.3 | Normalize `pinnedAt` in `serializeWorktree`; add `PATCH /worktrees/:id/pin`. |
| `daemon/src/ws/protocol.ts` | 1.4 | Add `WorktreeUpdatedEvent` to the union. |
| `daemon/src/__tests__/worktrees.routes.test.ts` | 1.T1–1.T6 | Daemon route tests. |
| `web-ui/src/api/types.ts` | 2.1, 2.2 | Add `pinnedAt`, add `worktree:updated` WSEvent variant. |
| `web-ui/src/api/client.ts` | 2.3 | Add `pinWorktree` / `unpinWorktree` methods. |
| `web-ui/src/api/mock.ts` | 2.4 | Mock parity. |
| `web-ui/src/hooks/useServerSync.ts` | 2.5 | Handle `worktree:updated` immutably. |
| `web-ui/src/components/layout/LeftSidebar.tsx` | 3.1–3.6 | Pinned section + menu wiring. |
| `web-ui/src/styles/workspace.css` | 3.4 | Pinned section + row + trail override. |
| `web-ui/src/components/layout/LeftSidebar.test.tsx` | 3.T1–3.T8 | UI tests. |
| `web-ui/src/hooks/useServerSync.test.ts` (or sibling) | 2.T2, 2.T3 | Sync handler tests. |

---

## Docker testing — isolation guarantees

- `docker-compose.dev.yml` uses host port **5174** (container 5173) — disjoint from the host's running daemon (default 7421) and vite (5173).
- Named volumes `vst-dev-data` + `vst-dev-projects` keep daemon state inside the container; the host's `~/.vibe-station/` is untouched.
- CLI binaries are bind-mounted **read-only**, so no host file is modified.
- Screenshot capture uses a separate Playwright invocation pointed at `http://localhost:5174`; nothing in the screenshot script writes to host vst state.
- Teardown: `docker compose -f docker-compose.dev.yml down` (keep volumes) or `down -v` (full reset). Never required to touch host daemon.

# Feature Plan: UI Improvements — May 5

> Six focused UX improvements: mobile sidebar brand, settings nav item, dashboard revamp, worktree lifecycle visibility, mark-done command + UI, and smarter `rm` prompting.

**Branch:** `ui-improvements-may-5`
**Status:** Pending

**Reference files:**
- Sidebar: `apps/web/src/components/layout/LeftSidebar.tsx`
- Top bar: `apps/web/src/components/layout/TopBar.tsx`
- Dashboard: `apps/web/src/components/layout/DashboardPanel.tsx`
- Layout host: `apps/web/src/routes/Workspace.tsx`
- Layout shell: `apps/web/src/components/layout/Layout.tsx`
- Status logic: `apps/web/src/lib/worktreeStatus.ts` — `worktreeRolledUpStatus(sessions, liveStates)` returns `WorktreeRolledUpStatus`
- Status dot: `apps/web/src/components/layout/StatusDot.tsx`
- Worktree API client: `apps/web/src/api/client.ts:182`
- Daemon delete route: `apps/cli/src/daemon/routes/worktrees.ts:356`
- Daemon sessions route: `apps/cli/src/daemon/routes/sessions.ts`
- Daemon types: `apps/cli/src/daemon/types.ts` — `LifecycleState`, `SessionRecord.lifecycle: { state, lastTransitionAt }`
- Lifecycle service: `apps/cli/src/daemon/services/lifecycle.ts` — `persistLifecycleState(projectId, worktreeId, sessionId, newState)`
- Broadcaster: `apps/cli/src/daemon/broadcaster.ts` — `broadcastAll(event)`, `notifySession(sessionId, event)`
- Project store: `apps/cli/src/daemon/state/project-store.ts` — `getAllProjects()`
- Paths service: `apps/cli/src/daemon/services/paths.ts` — `worktreePath(projectId, worktreeId)`
- CLI rm command: `apps/cli/src/commands/worktree/rm.ts`
- CLI confirm util: `apps/cli/src/lib/confirm.ts`
- Styles: `apps/web/src/styles/workspace.css`

---

## Problem

- **Mobile title gap:** `vibe-station` brand link only renders on `!isMobile` (`TopBar.tsx:139`). Mobile users see no way to tap back to the dashboard.
- **Settings icon is hard to discover:** it sits at the bottom of the sidebar footer as a small icon button with no label, blending with Font/Theme toggles.
- **Dashboard is a flat session list:** shows separate "working" and "idle" session cards — no hierarchy, mixing projects and sessions in one level, terminals pollute the list.
- **No way to mark a worktree as done:** the `done` state exists in the type system and UI but the daemon never sets it — it was designed for a plugin completion signal that was never wired. After a PR merges, sessions go `exited` (not `done`). There is no CLI command or UI action to manually signal "this work is complete."
- **`vst worktree rm` silently leaves files behind:** without `--purge`, the worktree directory stays on disk with no prompt to inform or ask the user. Users may not realise they need `--purge` to actually clean up.

---

## Concept

- Add `vibe-station` brand header at the top of the sidebar (mobile: always; desktop: only when sidebar is expanded).
- Replace the Settings icon in the footer with a full-width labeled nav row above the Font/Theme icon buttons; highlight when `/settings` is active.
- Redesign dashboard around **project → worktree** hierarchy, skipping terminal sessions, with sensible status groupings.
- Expose worktree lifecycle in the sidebar and add a "Dismiss" (soft-remove, no purge) action so merged-PR worktrees can be hidden without deleting files.
- Add `vst worktree done <id>` CLI command + `POST /worktrees/:id/done` daemon endpoint that marks all agent sessions in a worktree as `done`. Mirror this as a "Mark as done" item in the sidebar worktree ⋯ menu.
- In `vst worktree rm` (no `--purge`), after the existing name-confirmation prompt, ask "Also delete files from disk? [y/N]" — if yes, adds `?purge=true`; the name-confirmation safety gate is unchanged.

---

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Mobile sidebar shows a tappable `vibe-station` brand at its top that navigates to `/` |
| 2 | Desktop collapsed sidebar: brand collapses to icon/abbrev or hides (keeps existing collapsed behaviour) |
| 3 | Settings entry renders as full-width text row with left icon, above Font/Theme icon pair |
| 4 | Settings row is visually active (highlight) when `location.pathname === "/settings"` |
| 5 | Dashboard groups content by project, then shows worktree rows (not session rows) |
| 6 | Terminal sessions are excluded from the dashboard |
| 7 | Dashboard sections collapse if empty |
| 8 | Worktree menu in sidebar exposes "Dismiss (keep files)" and "Mark as done" alongside existing "Delete…" |
| 9 | Dismissed worktrees disappear from sidebar; files stay on disk |
| 10 | Daemon already supports `DELETE /worktrees/:id` (no purge) — no daemon change needed for dismiss |
| 11 | New `POST /worktrees/:id/done` endpoint marks all agent sessions in the worktree as `done`; broadcasts `session:state` for each |
| 12 | New `vst worktree done <id>` CLI command calls that endpoint |
| 13 | `vst worktree rm` (no `--purge`): after existing name-confirmation, prompt "Also delete files from disk? [y/N]" — answer upgrades to purge if yes |
| 14 | Name-confirmation in `rm` is not removed or weakened — purge prompt comes after it |

---

## Research

### Mobile brand gap

- `TopBar.tsx:139` — brand button is inside `{!isMobile ? (...) : (...)}` block; mobile arm shows only crumb, never `vibe-station`.
- `LeftSidebar.tsx:258-261` — sidebar top section starts immediately with the projects heading; no brand slot.
- `Workspace.tsx:43` — `isMobile = useMediaQuery("(max-width: 768px)")` controls rendering; same value is passed to `Layout` and `TopBar`.
- `Layout.tsx:112-119` — mobile sidebar is an `<aside>` drawer that slides in; sidebar inner renders `leftSidebar` (the `LeftSidebar` component).

### Settings icon discovery

- `LeftSidebar.tsx:390-418` — `left-sidebar__footer` div has three `icon-btn` buttons: Settings (SlidersHorizontal, line 391), Font (Type, line 400), Theme (Moon, line 408).
- `workspace.css:447` — `.left-sidebar__footer` is styled as a flex row.
- Active class: `icon-btn--active` is already applied for Settings when on `/settings` (line 393).

### Dashboard flat-list

- `DashboardPanel.tsx:119-120` — `workingSessions` and `idleSessions` filter `sessions` array; no distinction between agent and terminal sessions.
- `DashboardPanel.tsx:135-156` — `renderSessionCards` maps over raw `Session` objects — shows session label, branch, project name.
- Sessions have `type: "agent" | "terminal"` (`api/types.ts`).
- Worktrees already have `branch` + `id`; projects have `name`; worktree status is computed by `worktreeRolledUpStatus`.

### Worktree lifecycle & state machine (actual, as-implemented)

- `SessionState` (`api/types.ts:29`): `not_started | working | idle | done | exited`
- **`done` is never set by the daemon today** — it exists in types and UI but no code path writes it. It was designed for a plugin completion signal (`getActivityState()`) that was never wired. When Claude Code exits cleanly, the PTY closes → daemon detects it → state becomes `exited`, not `done`.
- **`exited`** is the real terminal state: set by 4 paths — spawn failure, tmux pane gone (polled ~1 Hz), PTY `onExit` event (direct-pty), daemon reboot recovery.
- **`idle`** is inferred: output hash unchanged for ≥4000ms. `working` ↔ `idle` toggles every ~1s poll.
- **Resume** is already fully implemented: `TerminalPane.tsx:317-332` shows "Session exited. Resume" banner; calls `POST /sessions/:id/resume` (`sessions.ts:319`); respawns via plugin's `getRestoreCommand()`.
- `worktreeRolledUpStatus` (`lib/worktreeStatus.ts:23`) rolls up all sessions to best status.
- `client.ts:182-185` — `deleteWorktree` always passes `?purge=true`. Need new `dismissWorktree` that calls `DELETE /worktrees/:id` without purge.
- `daemon/routes/worktrees.ts:356-401` — delete route already handles `purge` param; without it, sessions terminated but git worktree + branch stay on disk.
- `LeftSidebar.tsx:464-479` — worktree menu has only "Delete worktree…". Need "Mark as done" and "Dismiss (keep files)" above it.
- `worktreeIsInactive` (`LeftSidebar.tsx:40-46`) — checks `done|exited`; "hide done" checkbox already works.
- `confirmByTypingName` (`lib/confirm.ts:4`) — uses `prompts` library; adding a second `prompts()` call after it for the purge question is straightforward.

### Actual state machine

```
not_started ──spawn ok──→ working ←──output changes──→ idle
                 │                                       │
            spawn fail                         output stable ≥4s
                 │                                       │
                 ↓                                       ↓
              exited ←── tmux pane gone ────────────── exited
              exited ←── PTY onExit
              exited ←── daemon restart (process gone)
              exited ←── user kills session

done  ← NEVER SET TODAY (stub, designed but not wired)
        Proposed: set by new POST /worktrees/:id/done endpoint (manual signal)
```

---

## Approach

### P1 — Mobile brand in sidebar header

Add a `left-sidebar__brand` slot **above** `left-sidebar__scroll` (as a sibling, not inside the scroll area — so it stays pinned and doesn't scroll away). Rendered when `isMobile || !collapsed`; hidden on collapsed desktop rail (top-bar brand is still visible there).

```
LeftSidebar receives new prop: isMobile?: boolean
```

JSX structure:
```tsx
<div className="left-sidebar ...">
  {(isMobile || !collapsed) && (
    <Link to="/" className="left-sidebar__brand" onClick={clearWorkspaceSelectionAndNavigate}>
      vibe-station
    </Link>
  )}
  <div className="left-sidebar__scroll">   {/* existing */}
    ...
  </div>
  <div className="left-sidebar__footer">  {/* existing */}
    ...
  </div>
</div>
```

**Use `<Link>` from the start** (not `<button>`) — Phase 7 does not need to revisit this element.

**CSS:** `.left-sidebar__brand` — `display: block; padding: var(--space-3); font: same as .top-bar__brand; border-bottom: var(--border-width) solid var(--border-default); text-decoration: none; color: inherit; cursor: pointer;`

---

### P2 — Settings as labeled nav item

Split `left-sidebar__footer` into two parts:

```
left-sidebar__footer
  ├── left-sidebar__nav-item (settings row — full width text + icon)
  └── left-sidebar__icon-row (Font + Theme icon buttons)
```

Settings row markup — **use `<Link>` from the start** (Phase 7 does not need to revisit):
```tsx
<Link
  to="/settings"
  className={`left-sidebar__nav-item ${isSettings ? "left-sidebar__nav-item--active" : ""}`}
>
  <SlidersHorizontal size={16} />   {/* size={16} matches existing footer icons */}
  {!collapsed && <span>Settings</span>}
</Link>
```

When `collapsed`, only the icon shows. The icon is centered by the same flex layout as the existing icon buttons.

**CSS:**
- `.left-sidebar__nav-item` — `display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); text-decoration: none; color: inherit; width: 100%; cursor: pointer;` + hover bg.
- `.left-sidebar__nav-item--active` — `background: var(--bg-active); color: var(--fg-accent);`
- **Collapsed variant** (when `.left-sidebar--collapsed`): `padding: var(--space-1); justify-content: center;` — matches existing `padding: var(--space-1)` of the collapsed rail (LeftSidebar.tsx:260).
- `.left-sidebar__icon-row` — existing footer icon pair (Font + Theme), styled as before.

---

### P3 — Dashboard revamp

**Decision:** two views behind a toggle (persisted in `localStorage`):
- **List view** (default) — keeps existing status-section structure and card layout exactly; only changes are: swap `s.label` → `wt.branch` as primary, `wt.id` chip where branch was, remove terminal sessions
- **Kanban view** — 3 columns side-by-side; each card is identical to a list card; collapses to stacked sections on mobile

---

#### Card anatomy (identical in both views)

Current card (`renderSessionCards` in `DashboardPanel.tsx:135-156`):
```
● | s.label (primary)    wt.branch (branch chip)  | proj.name
```

New card (worktree-level, terminals excluded):
```
● | wt.branch (primary)  wt.id chip               | proj.name
```

That's the only content change. CSS classes (`dashboard-card__dot`, `dashboard-card__session-main`, `dashboard-card__primary`, `dashboard-card__branch`, `dashboard-card__secondary`) are reused as-is — `wt.branch` goes where `s.label` was, `wt.id` goes where `wt.branch` was.

---

#### View A — List (default)

Same section structure as today (working / idle / finished). "Finished" merges `done` + `exited`. Sections hidden when empty.

```
┌────────────────────────────────────────────────┐
│ vibe-station          ● daemon · port 3000  ⊞  │  ← ⊞ toggles to kanban
├────────────────────────────────────────────────┤
│ working                                         │
│  ● feat/auth-flow              vs-1  my-proj   │
│  ● feat/storage                vs-5  other     │
│ idle                                            │
│  ○ refactor-api                vs-3  my-proj   │
│ finished                                        │
│  ✓ fix/login-bug               vs-2  my-proj   │
│  ✕ spike/perf                  vs-4  other     │
└────────────────────────────────────────────────┘
```

Mobile — unchanged from desktop (single column, naturally scrolls):
```
┌──────────────────────────────┐
│ vibe-station  ● daemon    ⊞  │
│ working                      │
│  ● feat/auth-flow  vs-1      │
│    my-project                │
│  ● feat/storage    vs-5      │
│    other-project             │
│ idle                         │
│  ○ refactor-api    vs-3      │
│    my-project                │
│ finished                     │
│  ✓ fix/login-bug   vs-2      │
│  ✕ spike/perf      vs-4      │
└──────────────────────────────┘
```

---

#### View B — Kanban

Desktop: 3-column CSS grid. Each card is the same card component as list view, just rendered in a column context rather than full-width row. Column headers show the section label + count.

```
┌───────────────────┬───────────────────┬───────────────────┐
│ ● Working (2)     │ ○ Idle (1)        │ Finished (2)      │
├───────────────────┼───────────────────┼───────────────────┤
│ ● feat/auth-flow  │ ○ refactor-api    │ ✓ fix/login-bug   │
│   vs-1  my-proj   │   vs-3  my-proj   │   vs-2  my-proj   │
│                   │                   │                   │
│ ● feat/storage    │                   │ ✕ spike/perf      │
│   vs-5  other     │                   │   vs-4  other     │
└───────────────────┴───────────────────┴───────────────────┘
```

Mobile (`≤600px`): grid becomes single-column; column headers become section headers — identical to list view. Toggle icon stays visible (user can see which mode is set) but layout difference is invisible on narrow screens.

```
┌──────────────────────────────┐
│ vibe-station  ● daemon    ⊞  │
│ ● Working (2)                │
│  ● feat/auth-flow  vs-1      │
│    my-project                │
│  ● feat/storage    vs-5      │
│    other-project             │
│ ○ Idle (1)                   │
│  ○ refactor-api    vs-3      │
│    my-project                │
│ Finished (2)                 │
│  ✓ fix/login-bug   vs-2      │
│  ✕ spike/perf      vs-4      │
└──────────────────────────────┘
```

---

#### Toggle + data model

- Toggle state: `"list" | "kanban"` — `localStorage("dashboard:view")`
- Toggle button: top-right of dashboard header (`Columns3` icon when in list mode, `LayoutList` icon when in kanban mode — both from lucide-react)
- Unit of data: **worktree** (not session) — one card per worktree
- Filter: skip worktrees where `agentSessions.length === 0` (terminals-only → hidden); `agentSessions = sessions.filter(s => s.worktreeId === wt.id && s.type === "agent")`
- Status per worktree: `worktreeRolledUpStatus(agentSessions, sessionStates)` — import `worktreeRolledUpStatus` from `@/lib/worktreeStatus` and `useWorkspaceStore` for `sessionStates` (not currently imported in `DashboardPanel.tsx` — add both)
- **Bucket mapping** (based on `WorktreeRolledUpStatus` values, not raw `SessionState`):
  - **working** → `"working"` or `"spawning"` (note: `"spawning"` is a derived UI status from `worktreeRolledUpStatus` that maps from the raw `"not_started"` session state — it does not exist in `SessionState` directly)
  - **idle** → `"idle"`
  - **finished** → `"done"` or `"exited"` or `"none"` (worktrees with agent sessions that are all done/exited)
- Card click: `setActiveWorktree(wt.projectId, wt.id, allSessionsForWt)` + `navigate("/worktree/${wt.id}")`
- **Remove the existing "projects" section** (`DashboardPanel.tsx:190-216`) — project names appear inline as the tertiary muted label on each worktree card; a separate flat project list adds no value and would be redundant.

#### CSS additions for kanban

- `.dashboard-kanban` — `display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); align-items: start`
- `.dashboard-kanban__col` — `display: flex; flex-direction: column; gap: var(--space-2)`
- `.dashboard-kanban__col-header` — section label + count, styled like existing `dashboard-section__label`
- `@media (max-width: 600px)` — `.dashboard-kanban { grid-template-columns: 1fr }`
- Kanban cards: same `.dashboard-card` class — `min-width: 0; word-break: break-word` to handle long branch names

---

### P4 — Mark as done (new daemon endpoint + CLI command + UI)

**Daemon endpoint:** `POST /worktrees/:id/done`

Daemon session model (verified in `apps/cli/src/daemon/types.ts:8,11,31`):
- `SessionRecord.lifecycle: SessionLifecycle` where `SessionLifecycle = { state: LifecycleState; lastTransitionAt: string }`
- `LifecycleState = "not_started" | "working" | "idle" | "done" | "exited"`

Implementation pattern — mirrors how `sessions.ts:98` sets `exited`:
```ts
for (const session of worktree.sessions.filter(s => s.type === "agent")) {
  session.lifecycle = { state: "done", lastTransitionAt: new Date().toISOString() };
  broadcastAll({ type: "session:state", sessionId: session.id, state: "done" });
}
await persistLifecycleState(project.id, wtId, session.id, "done"); // once per session
```

Imports needed in the new route handler:
- `broadcastAll` from `"../broadcaster.js"`
- `persistLifecycleState` from `"../services/lifecycle.js"`
- `getAllProjects` already imported in `worktrees.ts`

- No process killing — sessions may already be `exited` or `idle`; this is a metadata label only
- Returns `{ ok: true, updated: number }` (count of agent sessions updated)

**CLI command:** `vst worktree done <id>`
- New file: `apps/cli/src/commands/worktree/done.ts`
- Calls `POST /worktrees/:id/done`
- Register in `apps/cli/src/program.ts` alongside `registerWorktreeRm`
- No confirmation required (non-destructive, purely a label change)
- Output: `success("Worktree marked as done: ${id}")`

**UI — sidebar worktree menu after change:**
```
┌────────────────────────────┐
│ Mark as done               │  ← sets all agent sessions to done state
│ Dismiss (keep files)       │  ← soft remove, no file deletion
│ Delete worktree…           │  ← hard delete + purge
└────────────────────────────┘
```

- "Mark as done" calls new `markWorktreeDone(id)` API method; no confirm needed (non-destructive)
- Sidebar status dot updates to `✓` via existing `session:state` WebSocket broadcast

**State lifecycle table (for UI tooltips / plan reference):**

| State | How set | Meaning | Actions available |
|-------|---------|---------|-------------------|
| `◐` spawning | Daemon on spawn | Session starting | — |
| `●` working | Daemon infers (output changing) | Agent is running | — |
| `○` idle | Daemon infers (output stable ≥4s) | Awaiting input | Give next task |
| `✕` exited | Daemon detects (process dead) | Stopped (clean exit or crash) | Resume, Mark as done, Dismiss |
| `✓` done | **New: user or future plugin** | Work complete | Dismiss |
| `·` none | No sessions | Empty worktree | Add session |

---

### P5 — Dismiss (soft-remove, UI only)

The daemon already handles `DELETE /worktrees/:id` without `?purge=true`. The web client always passes purge. Fix:

1. Add `dismissWorktree(id)` to API client — `DELETE /worktrees/${id}` (no `?purge=true`)
2. Add to `ApiInstance` type and `mock.ts`
3. "Dismiss (keep files)" menu item in sidebar ⋯ menu → `ConfirmDialog` with message: "Remove from vst tracking? Files and git branch stay on disk."
4. On dashboard: done/exited worktree rows show dismiss affordance (icon button on hover)

---

### P6 — `vst worktree rm` purge prompt

**Current flow:**
```
vst worktree rm <id>
  → warning message
  → "Type <id> to confirm:"    ← safety gate, unchanged
  → DELETE /worktrees/<id>     ← always no purge (without --purge flag)
```

**New flow (when `--purge` not passed):**
```
vst worktree rm <id>
  → warning message
  → "Type <id> to confirm:"    ← unchanged
  → "Also delete files from disk? [y/N]:"   ← NEW, after confirmation
  → if y → DELETE /worktrees/<id>?purge=true
  → if N → DELETE /worktrees/<id>
```

Implementation in `apps/cli/src/commands/worktree/rm.ts`:
- Add `import prompts from "prompts";` at the top (already used in `confirm.ts` but **not** in `rm.ts`)
- After `confirmByTypingName`, when `!opts.purge`, add:
  ```ts
  const { doPurge } = await prompts({
    type: "confirm",
    name: "doPurge",
    message: "Also delete files from disk?",
    initial: false,
  });
  const shouldPurge = Boolean(doPurge);
  const url = shouldPurge ? `/worktrees/${id}?purge=true` : `/worktrees/${id}`;
  ```
- When `opts.purge` is passed: keep existing behaviour (no second prompt, always use `?purge=true`)
- Update success message: `opts.purge || shouldPurge ? "Worktree purged" : "Worktree removed (files kept on disk)"`

---

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/components/layout/LeftSidebar.tsx` | Brand header, settings nav row, mark-done + dismiss actions |
| `apps/web/src/components/layout/DashboardPanel.tsx` | Full revamp to project-section layout |
| `apps/web/src/api/client.ts` | Add `dismissWorktree()` + `markWorktreeDone()` methods |
| `apps/web/src/api/mock.ts` | Add stubs for both new methods |
| `apps/web/src/api/types.ts` | Add methods to `ApiInstance` interface |
| `apps/web/src/routes/Workspace.tsx` | Pass `isMobile` to `LeftSidebar` |
| `apps/web/src/styles/workspace.css` | New CSS: brand, nav-item, dashboard cards, kanban grid, mobile breakpoint (≤600px) |
| `apps/cli/src/daemon/routes/worktrees.ts` | Add `POST /worktrees/:id/done` endpoint |
| `apps/cli/src/commands/worktree/done.ts` | New file: `vst worktree done` command |
| `apps/cli/src/program.ts` | Register new `worktree done` command |
| `apps/cli/src/commands/worktree/rm.ts` | Add purge prompt after name-confirmation |
| `apps/cli/src/daemon/ws/handlers/fileWatch.ts` | Fix hardcoded "test" project path → real project-store lookup |
| `apps/cli/src/daemon/ws/handlers/treeWatch.ts` | Same fix |

---

## Phases

### Phase 1 — Mobile brand + Settings nav item (LeftSidebar)

- [x] 1.1 Add `isMobile` prop to `LeftSidebar`; thread it from `Workspace.tsx`
- [x] 1.2 Add `<Link to="/">` as `.left-sidebar__brand` **above** `.left-sidebar__scroll` (sibling div, not inside scroll); shown when `isMobile || !collapsed`
- [x] 1.3 Move Settings out of footer: replace `<button onClick={navigate("/settings")}>` with `<Link to="/settings" className="left-sidebar__nav-item ...">` above the icon pair; remove the old Settings `icon-btn` from the footer
- [x] 1.4 Apply `left-sidebar__nav-item--active` class when `location.pathname === "/settings"`
- [x] 1.5 CSS: `.left-sidebar__brand` (block, padding, border-bottom, no underline); `.left-sidebar__nav-item` (flex row, full width); `.left-sidebar__nav-item--active` (bg + colour); `.left-sidebar--collapsed .left-sidebar__nav-item` (centred, `padding: var(--space-1)`); `.left-sidebar__icon-row` (existing Font+Theme pair)
- [x] **1.T1** Resize browser to 375px — sidebar shows "vibe-station" brand at top, stays pinned (does not scroll with worktree list)
- [x] **1.T2** Click brand → navigates to `/`; Ctrl+click → opens `/` in new tab
- [x] **1.T3** Navigate to `/settings` → Settings row is highlighted, not the old icon button
- [x] **1.T4** Desktop collapsed rail → brand hidden, Settings shows as centred icon only (no label)

### Phase 2 — Dashboard revamp

- [x] 2.1 Add imports to `DashboardPanel.tsx`: `worktreeRolledUpStatus` from `@/lib/worktreeStatus`; `useWorkspaceStore` (for `sessionStates`); `StatusDot` from `@/components/layout/StatusDot`; `Link` from `react-router-dom`
- [x] 2.2 Add `worktrees` state (`useState<Worktree[]>`) alongside existing `sessions`; populate in the same `useEffect` that fetches sessions
- [x] 2.3 Rename `renderSessionCards` → `renderWorktreeCard(wt: Worktree, proj: Project | undefined)`; filter: skip `wt` when `agentSessions.length === 0`; card: `<Link to={/worktree/${wt.id}} onClick={...}>` — branch in `dashboard-card__primary`, `wt.id` chip in `dashboard-card__branch`, `proj?.name` in `dashboard-card__secondary`
- [x] 2.4 Derive three buckets using `worktreeRolledUpStatus(agentSessions, sessionStates)`: `working` (`"working"|"spawning"`), `idle` (`"idle"`), `finished` (`"done"|"exited"`); sections hidden when empty
- [x] 2.5 **Remove** existing "projects" section (`DashboardPanel.tsx:190-216`) — no longer needed
- [x] 2.6 Add `dashboardView: "list" | "kanban"` state from `localStorage("dashboard:view")`; toggle button in header (`Columns3` icon in list mode, `LayoutList` in kanban mode)
- [x] 2.7 **Kanban**: `dashboardView === "kanban"` → render `.dashboard-kanban` grid with three `.dashboard-kanban__col` divs; same cards inside
- [x] 2.8 CSS: `.dashboard-kanban` (`display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); align-items: start`); `.dashboard-kanban__col-header`; `@media (max-width: 600px) { .dashboard-kanban { grid-template-columns: 1fr } }`;  `a.dashboard-card` gets same reset as existing `button.dashboard-card` (check `workspace.css` for button-specific resets)
- [x] **2.T1** List view: branch name bold primary, `vs-N` chip secondary, project name muted right
- [x] **2.T2** No terminal-only worktrees visible; projects section gone
- [x] **2.T3** Kanban desktop: 3 columns; kanban at 375px: single column
- [x] **2.T4** Toggle persists across reload; Ctrl+click card opens worktree in new tab

### Phase 3 — Mark as done (daemon + CLI + UI)

- [x] 3.1 Add `POST /worktrees/:id/done` in `daemon/routes/worktrees.ts`
  - Find worktree; iterate agent sessions; set `lifecycle.state = "done"`; persist; broadcast `session:state`
- [x] 3.2 New file `apps/cli/src/commands/worktree/done.ts` — `vst worktree done <id>` command
- [x] 3.3 Register in `program.ts` with `registerWorktreeDone(worktree)`
- [x] 3.4 Add `markWorktreeDone(id)` to `ApiInstance` type, `client.ts`, `mock.ts`
  - Client: `POST /worktrees/${id}/done`
- [x] 3.5 Add "Mark as done" menu item in `LeftSidebar` worktree ⋯ menu (no confirm needed)
- [x] **3.T1** `vst worktree done vs-7` → success message, sidebar dot flips to `✓`
- [x] **3.T2** "Mark as done" appears in ⋯ menu; clicking it updates status dot without page reload
- [x] **3.T3** Sessions that were `idle` or `exited` both get updated to `done`

### Phase 4 — Dismiss (soft-remove, UI only)

- [x] 4.1 Add `dismissWorktree(id: string)` to `ApiInstance` type, `client.ts`, `mock.ts`
  - Client: `DELETE /worktrees/${id}` (no `?purge=true`)
- [x] 4.2 Add "Dismiss (keep files)" menu item in `LeftSidebar` worktree ⋯ menu, above "Delete…"
- [x] 4.3 Wire to `ConfirmDialog`: "Remove from vst tracking? Files and git branch stay on disk."
- [x] 4.4 Add dismiss affordance (icon button on hover) on done/exited worktree rows in `DashboardPanel`
- [x] **4.T1** "Dismiss" appears in ⋯ menu; confirming removes worktree from sidebar
- [x] **4.T2** Files still on disk after dismiss (`ls` in worktree dir)
- [x] **4.T3** Existing "Delete worktree…" still purges files

### Phase 5 — `vst worktree rm` purge prompt

- [x] 5.1 In `rm.ts`: after `confirmByTypingName`, when `!opts.purge`, add `prompts({ type: "confirm", name: "doPurge", message: "Also delete files from disk?", initial: false })`
- [x] 5.2 Update `url` and success message based on answer
- [x] 5.3 `--purge` flag still bypasses second prompt (always purges)
- [x] **5.T1** `vst worktree rm vs-7` → type ID → prompted for purge → answer N → files stay
- [x] **5.T2** `vst worktree rm vs-7` → type ID → prompted for purge → answer y → files deleted
- [x] **5.T3** `vst worktree rm vs-7 --purge` → type ID → no purge prompt → files deleted

### Phase 6 — Fix file watcher and tree watcher (broken hardcoded path)

**Root cause:** Both WS handlers hardcode `"test"` as the project id when constructing the worktree root path. This means watchers watch the wrong directory (or a non-existent directory) for every project except one named literally `"test"`.

- `apps/cli/src/daemon/ws/handlers/fileWatch.ts:29`
  ```ts
  // BUG — hardcoded project id "test":
  const worktreeRoot = join(process.env.HOME || "/tmp", ".vibe-station", "projects", "test", "worktrees", worktreeId);
  ```
- `apps/cli/src/daemon/ws/handlers/treeWatch.ts:30`
  ```ts
  // same bug
  const worktreeRoot = join(process.env.HOME || "/tmp", ".vibe-station", "projects", "test", "worktrees", worktreeId);
  ```

Both files even have a comment saying "In a real implementation, look up the worktree root from the project store." The real lookup already exists in route handlers (`worktrees.ts:363`, `paths.ts:26`).

**Fix for both handlers** — same pattern, already used everywhere else:
```ts
import { getAllProjects } from "../state/project-store.js";
import { worktreePath as getWorktreePath } from "../services/paths.js";

// Find the project that owns this worktree
const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === worktreeId));
if (!project) {
  conn.send({ type: "system:error", message: `Worktree '${worktreeId}' not found` });
  return;
}
const worktreeRoot = getWorktreePath(project.id, worktreeId);
```

No changes to client code, WS protocol, `FileWatcher`, or `useFileWatch`/`useTreeWatch` hooks — the plumbing is correct end-to-end. The only broken piece is the path resolution in the two handler files.

**Why file preview and file tree both appeared broken:** `useFileWatch` and `useTreeWatch` both depend on receiving `file:changed` / `tree:changed` events from the daemon. Since the daemon was watching the wrong directory, those events were never fired, so `lastChanged` never updated, so neither the preview re-fetch nor the tree re-fetch were triggered.

#### Phase 6 checklist

- [x] 6.1 `fileWatch.ts`: import `getAllProjects` + `getWorktreePath`; replace hardcoded path with project-store lookup; send `system:error` if worktree not found
- [x] 6.2 `treeWatch.ts`: same fix — import + replace hardcoded path
- [x] 6.3 Remove the "In a real implementation…" TODO comments from both files
- [x] **6.T1** Open a file in preview; have an agent edit it; preview should reload within ~300ms
- [x] **6.T2** File tree should refresh when agent creates/deletes a file
- [x] **6.T3** Watch still works after daemon restart (handler re-registers via `useEffect` cleanup + remount)
- [x] **6.T4** Worktree not found → `system:error` message, no crash

---

### Phase 7 — Navigatable elements as anchor links

**Goal:** Ctrl/Cmd+click (and middle-click) on any navigation element opens the target in a new tab. No visual change. React Router's `<Link>` renders as `<a href="...">` and still fires `onClick` for regular left-clicks, so state updates are unaffected.

---

#### Elements to convert

| Element | File | Current | Change |
|---------|------|---------|--------|
| `vibe-station` brand (top bar) | `TopBar.tsx:141` | `<button ref={brandRef} onClick={goHome}>` | `<Link ref={brandRef} to="/" onClick={clearWorkspaceSelection}>` |
| `vibe-station` brand (sidebar, new) | `LeftSidebar.tsx` | `<button onClick={() => navigate("/")}> ` | `<Link to="/">` |
| Settings nav item (sidebar) | `LeftSidebar.tsx:~395` | `<button onClick={() => navigate("/settings")}>` | `<Link to="/settings">` |
| Worktree rows (sidebar) | `LeftSidebar.tsx:327-384` | `<div role="button" onClick={selectWorktree}>` | stretch-link pattern (see below) |
| Worktree cards (dashboard) | `DashboardPanel.tsx:140-155` | `<button onClick={openSessionRow}>` | `<Link to={/worktree/${wt.id}} onClick={setActiveWorktree}>` |

---

#### `<Link>` for simple buttons (brand, settings)

Straightforward replacement. `ref` type changes from `HTMLButtonElement` to `HTMLAnchorElement` for the top-bar brand (used only for width measurement — `offsetWidth` exists on `HTMLAnchorElement`). CSS keeps the same class names; React Router's Link accepts `className`.

```tsx
// TopBar.tsx — before
<button ref={brandRef} type="button" className="top-bar__brand" onClick={goHome}>

// after
<Link ref={brandRef} to="/" className="top-bar__brand" onClick={clearWorkspaceSelection}>
```

```tsx
// LeftSidebar.tsx — settings, before
<button className={isSettings ? "..." : "..."} onClick={() => navigate("/settings")}>

// after
<Link to="/settings" className={isSettings ? "..." : "..."}>
```

---

#### Worktree rows in sidebar — stretch-link pattern

The worktree row contains a nested `<button>` (⋯ menu trigger). `<a>` containing `<button>` is invalid HTML and causes layout issues in some browsers. Instead, use the **stretch-link** pattern: the outer `<div>` keeps its layout role; a `<Link>` with `position: absolute; inset: 0; z-index: 0` covers the whole row; content sits at `z-index: 1`, the ⋯ button at `z-index: 2`.

```tsx
// LeftSidebar.tsx — worktree row, after
<div
  className="tree-row tree-row--worktree"
  data-active={activeWorktreeId === w.id}
  style={{ position: "relative" }}           // ← add
  // REMOVE the existing onClick and onKeyDown from this div (moved to Link + keyboard handler below)
>
  <Link
    to={`/worktree/${w.id}`}
    className="wt-row__stretch-link"         // ← new: position:absolute; inset:0; z-index:0
    aria-label={`Open worktree ${w.branch}`}
    onClick={() => selectWorktree(p.id, w)}  // ← selectWorktree for left-click state update
    tabIndex={-1}                            // ← row div gets tabIndex={0} + onKeyDown for keyboard
  />
  <div className="wt-row__expand" style={{ position: "relative", zIndex: 1 }}>
    ...status dot + label...
  </div>
  <div className="wt-row__trail" style={{ position: "relative", zIndex: 2 }}>
    ...id chip + ⋯ button...
  </div>
</div>
```

**Critical:** remove `onClick={() => void selectWorktree(p.id, w)}` from the outer `<div>` (currently at `LeftSidebar.tsx:331`) — the `<Link>` handles mouse clicks. Keep `onKeyDown` on the outer div for keyboard accessibility (Enter/Space still calls `selectWorktree` + `navigate`). This prevents `selectWorktree` from firing twice on a regular left-click.

CSS for `.wt-row__stretch-link`:
```css
.wt-row__stretch-link {
  position: absolute;
  inset: 0;
  z-index: 0;
  /* no text-decoration, no colour change */
}
```

---

#### Dashboard worktree cards

Cards are currently `<button>`. Replace with `<Link>` — same `className`, same `onClick` for state side-effects:

```tsx
// DashboardPanel.tsx — before
<button type="button" className="dashboard-card dashboard-card--session" onClick={() => openSessionRow(s)}>

// after (worktree-level card)
<Link
  to={`/worktree/${wt.id}`}
  className="dashboard-card dashboard-card--worktree"
  onClick={() => { setActiveWorktree(wt.projectId, wt.id, sessionsForWt); }}
>
```

`<Link>` renders as `<a>`. The `dashboard-card` CSS must not set `text-decoration` or override colour (currently styled as `button`, so check `workspace.css` for any button-reset styles and apply equivalent resets to `a.dashboard-card`).

---

#### Phase 7 checklist

> Brand (sidebar + topbar) and settings are already `<Link>` from Phase 1. Dashboard cards are already `<Link>` from Phase 2. This phase only covers the top-bar brand `ref` type and the worktree row stretch-link.

- [x] 7.1 `TopBar.tsx`: `<button ref={brandRef} onClick={goHome}>` → `<Link ref={brandRef} to="/" onClick={clearWorkspaceSelection}>`; update `brandRef` type from `useRef<HTMLButtonElement>` to `useRef<HTMLAnchorElement>` (verified safe: only `offsetWidth` is read at line 89)
- [x] 7.2 `LeftSidebar.tsx` worktree rows:
  - Add `style={{ position: "relative" }}` to outer `<div className="tree-row tree-row--worktree">`
  - **Remove** `onClick={() => void selectWorktree(p.id, w)}` from that outer div (prevents double-fire)
  - ~~Keep `onKeyDown` on outer div~~ — stretch `<Link>` is the sole keyboard focus target (avoids axe nested-interactive); Enter follows native link activation.
  - Add `<Link to={/worktree/${w.id}} className="wt-row__stretch-link" onClick={() => selectWorktree(p.id, w)} />` with `aria-label` for the row
  - Add `style={{ position: "relative", zIndex: 1 }}` to `wt-row__expand`
  - Add `style={{ position: "relative", zIndex: 2 }}` to `wt-row__trail`
- [x] 7.3 `workspace.css`: `.wt-row__stretch-link { position: absolute; inset: 0; z-index: 0; text-decoration: none; }`
- [x] **7.T1** Ctrl+click `vibe-station` brand (top bar) → opens `/` in new tab
- [x] **7.T2** Ctrl+click Settings nav item → opens `/settings` in new tab (covered by Phase 1)
- [x] **7.T3** Ctrl+click worktree row body → opens `/worktree/:id` in new tab; ⋯ button still opens menu (not intercepted by stretch link)
- [x] **7.T4** Regular left-click on worktree row → `selectWorktree` fires exactly once, navigates normally
- [x] **7.T5** No visual change: no underlines, no colour shifts, no layout shifts

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `client.ts` `deleteWorktree` always passes `purge=true` — must not change | MEDIUM | Add new `dismissWorktree` method; leave `deleteWorktree` unchanged |
| Dashboard card `<button>` → `<Link>/<a>` — button CSS resets may not apply to `<a>` | MEDIUM | Audit `workspace.css` for `button.dashboard-card` selectors; add equivalent `a.dashboard-card` rules |
| Worktree row outer div `onClick` still present after stretch-link added → double-fire | HIGH | Resolved in plan: Phase 7.2 explicitly removes outer `onClick`; only `onKeyDown` remains for keyboard nav |
| TerminalPane remount if sidebar brand changes React tree position | LOW | Brand mounts above `.left-sidebar__scroll` as a sibling — same depth, no TerminalPane relationship |
| `isMobile` prop threading to LeftSidebar — currently not passed | LOW | Add optional prop with default `false`; existing callers unaffected |
| File/tree watcher: stale chokidar watchers if `file:unwatch` sent to wrong path before fix | LOW | Watchers keyed by `watchKey`; unwatch finds by key; stale watchers cleaned up on WS disconnect |
| `POST /worktrees/:id/done` marks `exited` sessions as `done` — meaningful? | LOW | `done` is a user intent signal, not a process state; lifecycle poller guards are `!== "exited"` — verify `lifecycle.ts:138` also lets `done` pass through unchanged |
| Removing "projects" section from dashboard may surprise users | LOW | Project names remain as inline muted labels on every worktree card |

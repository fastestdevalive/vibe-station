# Mini-Design: Terminal dock auto-create + panel close

> Auto-create first terminal when the dock opens empty; add an in-panel close button (TopBar toggle unchanged).

**Issue:** terminal-panel-close
**Branch:** `terminal-panel-close`
**Status:** Pending
**PRD:** _(none — small UI fix)_
**Parent design:** _(none)_

**Reference files:**
- Tab strip / empty state: `web-ui/src/components/layout/TabsStrip.tsx`
- Create terminal API: `web-ui/src/components/dialogs/NewTerminalDialog.tsx`
- Dock visibility: `web-ui/src/hooks/useStore.ts` (`toggleTerminalDock`)
- Close-button precedent: `web-ui/src/components/layout/ToolPanel.tsx`
- Dock mount gate: `web-ui/src/components/layout/Layout.tsx`
- Wiring: `web-ui/src/routes/Workspace.tsx`

---

## Problem

- Opening the terminal dock with zero terminals shows empty hint ("No terminals — open one with +") instead of a ready shell
- Dock can only be closed via TopBar toggle — no close control on the panel itself

## Out of Scope

- Changing TopBar terminal toggle UI, shortcut, or behavior
- Keeping `TerminalPane` mounted while dock is hidden (existing hide/unmount stays)
- Auto-creating when the last terminal tab is closed while the dock stays open
- Renaming / dialog UX for the auto-created terminal
- Agent-tab strip changes

## Concept

- First open of terminal dock for a worktree or direct-session project with **no** terminal sessions → create one immediately (defaults, no dialog)
- X button on the right of the terminal tab strip closes the dock (same action as TopBar toggle)
- TopBar toggle left as-is

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Worktree + direct (project-scope) docks both auto-create when opened with zero terminals |
| 2 | Auto-create uses existing create APIs + default name / `useTmux: true` — no dialog |
| 3 | Guard against double-create (StrictMode remount / concurrent effect) |
| 4 | Close button on right of terminal `TabsStrip` tools calls `toggleTerminalDock` |
| 5 | TopBar toggle unchanged |
| 6 | Do not remount `TerminalPane` for reasons other than existing dock show/hide |

---

## Research

### Dock mounts `TabsStrip` only when visible

- **File:** `web-ui/src/components/layout/Layout.tsx:188-204`
- **Trigger:** `showTerminalDock` false → dock branch not rendered → `TabsStrip` unmounts
- **Risk:** LOW — remount on open is a natural place for “opened empty → create”

### Empty terminal state today

- **File:** `web-ui/src/components/layout/TabsStrip.tsx:169-171`
- **Trigger:** `kind === "terminal"` and `sessions.length === 0`
- **Risk:** LOW — replace with auto-create; keep empty hint as fallback while create in flight / on error

### Create paths

- **File:** `web-ui/src/components/dialogs/NewTerminalDialog.tsx:63-79`
- **Trigger:** worktree → `api.createSession({ type: "terminal", … })`; project → `api.createDirectSession({ type: "terminal", … })`
- **Risk:** LOW — reuse same calls without dialog

### Active tab selection after create

- **File:** `web-ui/src/components/layout/TabsStrip.tsx:110-122` (`session:created` → `setActiveSession`)
- **Trigger:** create emits `session:created`
- **Risk:** LOW — existing handler selects new tab

### Tool panel close precedent

- **File:** `web-ui/src/components/layout/ToolPanel.tsx:54-64`
- **Trigger:** X in `__tabs-actions` → `toggleToolPanel()`
- **Risk:** LOW — mirror in `tabs-strip__tools` for terminal kind only

### AGENTS.md terminal remount

- **File:** `AGENTS.md` (TerminalPane invariant)
- **Trigger:** React tree-position change remounts PTY stream
- **Risk:** MEDIUM — do not move close/create UI in a way that relocates `TerminalPane`; dock hide already unmounts (accepted, unchanged)

## Root Cause

- Empty dock is passive (hint only) — no first-open create
- Terminal strip has zoom/fullscreen tools but no panel close control

---

## Architecture

```
[TopBar toggle] ──→ [useStore.toggleTerminalDock] ──→ [Layout showTerminalDock]
                                                              ↓
                         [Workspace terminalDock] → [TabsStrip kind=terminal]
                                                              ↓
                         empty + mounted → [api.createSession / createDirectSession]
                                                              ↓
                         [session:created] → setActiveTerminalSession → [TerminalPane]

[TabsStrip close X] ──→ [toggleTerminalDock] ──→ (same hide path as TopBar)
```

---

## Design Details

### Critical User Journeys (CUJs)

#### CUJ 1 — First open, no terminals

```
User opens worktree / direct session
  → Clicks TopBar terminal toggle (dock was hidden, 0 terminals)
  → Layout mounts TabsStrip (terminal)
  → TabsStrip sees sessions.length === 0
  → Calls createSession / createDirectSession (defaults)
  → session:created → new tab active → TerminalPane attached
```

- **Error path:** create fails → show empty hint + keep + control; no retry loop
- **Edge case:** user already has terminals → no auto-create

#### CUJ 2 — Close dock from panel

```
User has terminal dock open
  → Clicks X on right of tabs-strip tools
  → toggleTerminalDock() (same as TopBar)
  → Dock unmounts; fullscreen terminal cleared if needed (existing store logic)
```

- **Error path:** n/a (local UI state)
- **Edge case:** TopBar toggle still works identically

#### CUJ 3 — Reopen after deleting all terminals

```
User deletes last terminal tab while dock open → empty hint, no auto-create
  → User closes dock, opens again with still 0 terminals
  → Auto-create runs again (condition is “opened + empty”, not a one-shot flag)
```

### Data Model

| Entity | Field | Type | Constraints | Notes |
|--------|-------|------|-------------|-------|
| _(none)_ | — | — | — | No store/schema fields added |
| Session | `type` | `"terminal"` | existing | Created via existing APIs |

- **Relationships:** unchanged
- **Indexes:** n/a
- **Migration:** N

### API Contracts

```
# Unchanged — reuse existing:

POST createSession
  Request:  { worktreeId, modeId: null, type: "terminal", name?: string, useTmux: true }
  Response: Session
  Errors:   existing daemon errors (surface via empty hint / no toast required)

POST createDirectSession
  Request:  { target: "direct", projectId, type: "terminal", name?: string, useTmux: true }
  Response: Session
  Errors:   existing
```

### Key Decisions

#### Decision 1: Auto-create lives in `TabsStrip` (terminal only)

- **Decision:** Effect after load when `kind === "terminal"` && `sessions.length === 0` && context id present
- **Rationale:** Strip only mounts when dock visible — natural “opened” signal for worktree + project scope
- **Where:** `web-ui/src/components/layout/TabsStrip.tsx` (~after session load effects ~L72–152)

#### Decision 2: No dialog; defaults match NewTerminalDialog happy path

- **Decision:** `useTmux: true`; name via `nextTerminalName` when worktree, omit/undefined for project
- **Rationale:** Zero friction on first open; + button still opens dialog for named shells
- **Where:** `TabsStrip.tsx` (new helper / inline); mirror `NewTerminalDialog.tsx:63-79`

#### Decision 3: In-flight / StrictMode guard

- **Decision:** Module-or-ref key (`scope:contextId`) so one create attempt per mount cycle; reset when sessions appear or context changes
- **Rationale:** Avoid duplicate terminals from double effect fire
- **Where:** `TabsStrip.tsx`

#### Decision 4: Close button = `toggleTerminalDock`, terminal kind only

- **Decision:** X after fullscreen in `tabs-strip__tools`; agent strip unchanged
- **Rationale:** Match `ToolPanel` close; leave TopBar alone
- **Where:** `TabsStrip.tsx:227-252`; style via existing `tab tab--icon` (+ minor CSS if needed)

#### Decision 5: Do not fix dock hide remount in this change

- **Decision:** Accept existing Layout unmount of dock when hidden
- **Rationale:** Out of scope; AGENTS.md fullscreen rule still respected (no secondary render site)
- **Where:** `Layout.tsx:188-204` — no change

---

## Files to Modify

| File | Change |
|------|--------|
| `web-ui/src/components/layout/TabsStrip.tsx` | Auto-create effect; close button on terminal tools |
| `web-ui/src/components/layout/TabsStrip.test.tsx` | Tests for auto-create + close |
| `web-ui/src/styles/workspace.css` | Optional spacing for close control in `__tools` |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Re-auto-create every empty open?** | Yes — “opened + empty”, not a persisted once flag (CUJ 3) |
| 2 | **Create while listing still empty race?** | Guard + rely on `session:created` / list refresh |
| 3 | **Should open-failure toast?** | Prefer silent empty hint; toast optional if project already toasts API errors |

---

## Implementation Phases

### Phase 1 — Panel close button

- [ ] **1.1** Add X button to terminal `tabs-strip__tools` calling `toggleTerminalDock` from `useLayout` / store
- [ ] **1.2** Only render for `kind === "terminal"`; leave agent strip alone
- [ ] **1.3** Aria: `Close terminal dock`; mirror ToolPanel sizing (`X` size 13)

**Verify phase 1:**
- [ ] **1.T1** Unit — `TabsStrip.test`: terminal strip exposes “Close terminal dock”; click calls toggle (dock visible → false)
- [ ] **1.T2** Regression — `TabsStrip.test`: agent strip still has no dock-close control; TopBar tests untouched

---

### Phase 2 — Auto-create on empty open

- [ ] **2.1** After sessions resolved empty for terminal strip + `worktreeId`, call create API (worktree vs project scope)
- [ ] **2.2** In-flight / once-per-mount-cycle guard
- [ ] **2.3** On failure, leave empty hint; do not spin forever
- [ ] **2.4** Rely on existing `session:created` to activate tab

**Verify phase 2:**
- [ ] **2.T1** Unit — `TabsStrip.test`: mounting terminal strip with 0 sessions invokes `createSession` / `createDirectSession` once
- [ ] **2.T2** Unit — `TabsStrip.test`: mounting with existing terminals does not create
- [ ] **2.T3** Regression — manual / existing: TopBar toggle still shows/hides dock; + still opens `NewTerminalDialog`

---

## Files Summary

| File | Phase | Change |
|------|--------|--------|
| `web-ui/src/components/layout/TabsStrip.tsx` | 1.1–1.3, 2.1–2.4 | Close X + auto-create |
| `web-ui/src/components/layout/TabsStrip.test.tsx` | 1.T1–1.T2, 2.T1–2.T2 | Coverage |
| `web-ui/src/styles/workspace.css` | 1.1 | Optional tools spacing |

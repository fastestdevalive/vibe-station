# PRD: Hide projects + scroll-to-selected worktree

> Let users hide whole projects (and all their worktrees) from the sidebar and dashboard with a Settings-based unhide flow, and fix the sidebar so reopening it snaps to the selected worktree instead of resetting to the top.

**Status:** Approved (reviewed by Opus subagent)
**Technical plan:** `.feature-plans/pending/hide-projects-and-scroll-to-selected.md`

---

## Problem

- The left sidebar and the dashboard "Overview" list **every** registered project and all its worktrees, with no way to declutter. Users who have many projects (or finished/parked ones) are forced to scroll past noise to reach what they're working on.
- There is no project-level row menu in the sidebar today — projects only have a chevron and a "New session" button — so there's no natural home for project-scoped actions.
- When the left sidebar is reopened (expanded on desktop, or the drawer opened on mobile), the worktree list is **scrolled back to the top**. If the currently-selected worktree is far down the list, the user loses their place and has to hunt for it every time, even though the app already knows which worktree is active.

Who is affected: any user with more than a handful of projects/worktrees — i.e. the power users the product is built for.

Why now: both are low-risk quality-of-life fixes that directly address day-to-day friction, and the hiding feature has a clean precedent in the existing worktree-pinning implementation.

## Goals

- A user can hide a project from a menu on its sidebar row; the project and all its worktrees immediately disappear from the sidebar and the dashboard everywhere they normally appear.
- Hidden projects remain fully intact (sessions keep running, files untouched) — hiding is purely a visibility filter, not a delete or archive.
- A user can see all hidden projects in Settings and unhide any of them, restoring them to the sidebar and dashboard.
- The hidden state is durable and consistent across browser tabs and reloads.
- Reopening the left sidebar keeps the selected worktree visible: if it was scrolled out of view, the list snaps so the selected worktree row is on screen.

## Non-goals

- **Hiding individual worktrees.** This PRD hides at the *project* level only. (Per-worktree dismiss/pin already exists and is unchanged.)
- **Bulk hide/unhide**, search, or sorting of the hidden-projects list in Settings. A simple list with per-row unhide is enough for v1.
- **Deleting or archiving** projects. Delete remains a CLI-only destructive op.
- **Animated/smooth scrolling** for the sidebar snap — an instant jump is acceptable and matches "quickly snapping to it."
- **Persisting scroll position** of the sidebar between opens beyond what's needed to keep the selected worktree visible.
- **Hiding the active project.** Allowed, but see R10 for what happens to the current view.

---

## Requirements

### 1. Hiding a project from the sidebar

Covers the entry point and immediate effect of hiding.

| ID | Requirement |
|----|-------------|
| R1 | Each project row in the left sidebar has a "3 dots" (kebab) overflow menu, consistent in look and interaction with the existing worktree-row kebab menu (click to open, click-outside / Escape to close). |
| R2 | The project kebab menu contains at least two actions: **"New worktree"** (opens the existing new-worktree/session dialog for that project, the same action the current "New session" button performs) and **"Hide project"**. |
| R3 | Choosing "Hide project" immediately removes that project and all of its worktrees from the sidebar, with no confirmation dialog (the action is fully reversible from Settings). |
| R4 | Hiding takes effect across all open browser tabs/clients without a manual refresh. |
| R5 | The collapsed (icon-rail) sidebar must also respect the hidden filter — hidden projects do not appear in either the expanded or collapsed sidebar. |

### 2. Hiding effect on the dashboard

Covers the dashboard "Overview" surface.

| ID | Requirement |
|----|-------------|
| R6 | The dashboard Overview must not show any worktree card belonging to a hidden project, in any of its groupings/views (e.g. working / idle / finished, list and kanban). |
| R7 | Any other place that lists projects or worktrees for browsing (counts, overview headers) must exclude hidden projects, so a hidden project leaves no visible trace outside Settings. |

### 3. Unhiding from Settings

Covers discovery and restoration of hidden projects.

| ID | Requirement |
|----|-------------|
| R8 | Settings has a section (e.g. "Hidden projects") that lists every currently-hidden project by name, with an "Unhide" control per row. |
| R9 | Choosing "Unhide" immediately restores the project (and its worktrees) to the sidebar and dashboard across all clients, and removes it from the hidden list. |
| R10 | When there are no hidden projects, the section shows a clear empty state rather than appearing broken or blank. |

### 4. Edge cases & state

| ID | Requirement |
|----|-------------|
| R11 | If the user hides the project whose worktree is currently open/active, the app must not break: it returns to a safe view (the dashboard Overview) and clears the now-hidden active selection. |
| R12 | Hidden state is server-side and persisted, so it survives daemon restarts and is identical for every client. It is **not** stored only in one browser's local storage. |
| R13 | Hiding/unhiding never alters worktrees, sessions, branches, or files — running agents continue running while a project is hidden. |

### 5. Scroll-to-selected worktree on sidebar open

Covers the sidebar reopen behavior.

| ID | Requirement |
|----|-------------|
| R14 | When the left sidebar transitions from hidden to visible (desktop: collapsed → expanded; mobile: drawer closed → open), if a worktree is selected and its row is outside the visible scroll area, the list scrolls so that the selected worktree row is brought into view. |
| R15 | If the selected worktree row is already visible when the sidebar opens, no scrolling occurs (no jarring jump). |
| R16 | If no worktree is selected (e.g. user is on the dashboard), opening the sidebar does not force any scroll. |
| R17 | The selected worktree's project must be expanded if needed so the row actually exists in the DOM to scroll to; a selected worktree inside a collapsed project group should be revealed. |
| R18 | The snap is effectively instant ("quickly snapping"), and must not fight the user — once they start scrolling manually, the auto-snap does not re-trigger until the next open. |

---

## Options considered

### Where to store the "hidden" state

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — Server-side flag on the project manifest (`hidden`), exposed via a new `PATCH /projects/:id` + `project:updated` WS broadcast | Durable across restarts; consistent across all clients/tabs; mirrors the existing worktree-pinning pattern exactly | Requires a small backend addition (new endpoint + WS event + store reducer) | ✅ chosen |
| B — Client-only localStorage list of hidden project ids | No backend change | Per-browser only (hidden on laptop ≠ hidden on phone); easy to desync; inconsistent with how pinning works | ❌ rejected |

**Decision:** Option A. The product already models per-worktree visibility (`pinnedAt`) server-side; project hiding should follow the same durable, broadcast-synced pattern so the experience is consistent across devices.

### Hide entry point

**Option A — Kebab menu on the project row (chosen)**
Add a project-row kebab (which doesn't exist yet) and put "Hide project" + "New worktree" in it. Matches the worktree-row interaction users already know; gives project actions a permanent home.

**Option B — A dedicated hide (eye) icon-button on hover**
Faster to reach, but clutters the row, has no room on the collapsed rail, and doesn't scale as more project actions are added.

**Decision:** Option A — the request explicitly asks for the 3-dots menu, and it's the extensible choice.

### Scroll mechanism

**Option A — `scrollIntoView({ block: "nearest" })` on the active row, triggered on the open transition (chosen)**
Browser handles the math; only scrolls when needed; respects "nearest" so an already-visible row doesn't move.

**Option B — Manually compute and set `scrollTop` on the scroll container**
More code, more edge cases (row heights, padding), no benefit over the native API.

**Decision:** Option A.

---

## Resolved design questions

1. **Hide at project or worktree granularity?** — **Project.** The request says "hiding the projects … all the worktrees for that project should not be visible," so one flag per project hides the whole group.
2. **Confirmation before hiding?** — **No.** Hiding is non-destructive and reversible from Settings; a confirmation would add friction for no safety benefit. (A toast/undo is a nice-to-have, see open questions.)
3. **Where does unhide live?** — **Settings**, in a dedicated "Hidden projects" section, per the request.
4. **Server-side vs client-side state?** — **Server-side** (`hidden` on the manifest), broadcast over WS, mirroring worktree pinning.
5. **What happens to a running agent in a hidden project?** — **Nothing.** Hiding is visibility only; sessions keep running.
6. **What if the active worktree's project is hidden?** — **Redirect to dashboard** and clear the active selection (R11).
7. **Smooth vs instant scroll snap?** — **Instant** (`block: "nearest"`), matching "quickly snapping."
8. **Does the new-worktree dialog change?** — **No.** "New worktree" in the kebab reuses the existing dialog the "New session" button already opens.
9. **What if a user deep-links / reloads a URL pointing at a hidden project's worktree?** — **Redirect to the dashboard.** Hiding should leave no browseable trace; an explicit unhide in Settings is required to reach it again. (Found in review: the URL-sync path has no hidden check, so the gate is centralized in the workspace route.)

---

## Screen layouts

### Project row kebab (left sidebar, expanded)

```
┌─────────────────────────────────────────────┐
│  LEFT SIDEBAR                               │
│                                             │
│  ▸ vibe-station                  [ + ] [⋮]  │ ← project row: chevron, New, kebab(⋮)
│      ● fix-auth-bug                          │
│      ● scrollfix-n-hiding   (selected)       │
│                                             │
│            ┌──────────────────────────┐     │
│            │  + New worktree          │     │ ← kebab menu (on ⋮ click)
│            │  ⊘ Hide project          │     │
│            └──────────────────────────┘     │
│                                             │
│  ▸ agent-orchestrator            [ + ] [⋮]  │
│                                             │
└─────────────────────────────────────────────┘
```

Notes:
- "New worktree" → opens the existing new-worktree/session dialog scoped to that project.
- "Hide project" → project and its worktrees vanish immediately from this list and the dashboard; menu closes.
- The kebab visually matches the worktree-row kebab already in the sidebar.

### Settings → Hidden projects section

```
┌──────────────────────────────────────────────────┐
│  Settings                                         │
│  ┌────────────┐  ┌──────────────────────────────┐ │
│  │ Modes      │  │  Hidden projects             │ │ ← section header + description
│  │ Appearance │  │  Projects you've hidden from │ │
│  │ Hidden     │  │  the sidebar and dashboard.  │ │
│  │  projects  │  │                              │ │
│  └────────────┘  │  agent-orchestrator  [Unhide]│ │
│                  │  old-prototype       [Unhide]│ │
│                  │                              │ │
│                  │  (empty state when none:     │ │
│                  │   "No hidden projects.")     │ │
│                  └──────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

Notes:
- "Unhide" restores the project across all clients and removes the row.
- Empty state replaces the list when nothing is hidden (R10).

---

## Priority & sequencing

| Order | Sub-feature | Depends on | Can ship independently? |
|-------|-------------|------------|------------------------|
| 1 | Backend: `hidden` flag + `PATCH /projects/:id` + `project:updated` broadcast + client store reducer | — | Yes (no visible change until UI uses it) |
| 2 | Sidebar project kebab (New worktree + Hide) + hidden filtering in sidebar & dashboard | Sub-feature 1 | No |
| 3 | Settings "Hidden projects" section (unhide) | Sub-feature 1 | No |
| 4 | Scroll-to-selected-worktree on sidebar open | — | Yes (fully independent of the hide feature) |

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|------------------------|
| 1 | Should hiding show a toast with an "Undo" affordance? | Nice-to-have; defer. Settings unhide covers recovery for v1. |
| 2 | Should the sidebar footer show a count/badge of hidden projects as a discovery hint for the Settings section? | Defer; not required for the core flow. |
| 3 | On mobile, the sidebar is a 280px drawer — confirm scroll-to-selected works identically there (it should, same scroll container). | Verify during implementation/Docker test. |

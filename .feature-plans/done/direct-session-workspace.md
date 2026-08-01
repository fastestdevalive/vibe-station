# Mini-Design: Direct Session Workspace View

> Enable clicking direct sessions in sidebar to open a workspace-like view with terminal and proper URL routing.

**Issue:** non-git-projects (continued)
**Branch:** `revisit-projects`
**Status:** Pending
**Parent design:** `.feature-plans/done/project-dialog/non-git-projects.md`

**Reference files:**
- Routing: `web-ui/src/App.tsx:49-57`
- Workspace: `web-ui/src/routes/Workspace.tsx`
- Store: `web-ui/src/hooks/useStore.ts:106-128`
- URL sync: `web-ui/src/hooks/useWorkspaceUrlSync.ts`
- Layout: `web-ui/src/components/layout/Layout.tsx`
- Sidebar: `web-ui/src/components/layout/LeftSidebar.tsx`

---

## Problem

- Direct sessions appear in sidebar but clicking them does nothing
- No URL route exists for direct sessions
- Workspace component is worktree-centric — assumes `activeWorktreeId` is always set
- File tree API is worktree-keyed (`/worktrees/:id/tree`) — no project-scoped equivalent

## Out of Scope (v1)

- **File tree for direct sessions** — requires new backend routes; deferred to follow-up
- Multiple direct sessions in one view (each direct session = one workspace)
- Agent tabs for direct sessions (single-agent by design)
- Terminal dock (agent IS the terminal)
- QuickOpen (depends on worktree file-list API)

## Concept

- Direct session workspace v1: **terminal-only view** (no file tree)
- URL pattern: `/session/:sessionId`
- Derive context from URL params (no new store field needed)
- Clear worktree context when entering direct session mode and vice versa

---

## Architecture

```
URL: /session/:sessionId
         ↓
    App.tsx (new route)
         ↓
    Workspace.tsx
         ↓ (detect isDirectSession from URL)
    Layout.tsx (directSession mode)
         ↓
    ┌────────────┬──────────────────┐
    │ LeftSidebar│   TerminalPane   │ (single agent, full width)
    │            │                  │
    └────────────┴──────────────────┘
```

---

## Design Details

### Critical User Journeys (CUJs)

#### CUJ 1 — Click direct session in sidebar

```
User clicks direct session row in sidebar
  → URL navigates to /session/:sessionId
  → Workspace detects direct session from useParams()
  → Clears activeWorktreeId (mutual exclusion)
  → Layout renders terminal-only view
  → Terminal attaches to session's tmux pane
```

- **Error path:** session not found → redirect to dashboard
- **Edge case:** session deleted while viewing → redirect to dashboard

#### CUJ 2 — Navigate from direct session to worktree

```
User clicks worktree in sidebar while viewing direct session
  → URL navigates to /worktree/:wtId
  → activeWorktreeId set, direct context cleared
  → Normal worktree workspace renders
```

### Key Decisions

#### Decision 1: URL pattern `/session/:sessionId`

- **Decision:** Use `/session/:sessionId` not `/project/:pid/session/:sid`
- **Rationale:** Simpler URL; sessionId is unique; projectId derivable from session
- **Where:** `App.tsx:49-57` — add new route

#### Decision 2: Derive context from URL, not new store field

- **Decision:** Use `useParams().sessionId` to detect direct session mode
- **Rationale:** URL is source of truth; avoids store complexity and mutual-exclusion bugs
- **Where:** `Workspace.tsx` — add `sessionId` from params, derive `isDirectSession`

#### Decision 3: Mutual exclusion via existing store fields

- **Decision:** Clear `activeWorktreeId`/`activeSessionId` when entering direct session mode
- **Rationale:** Prevents dual-highlight in sidebar, stale context issues
- **Where:** `Workspace.tsx` effect — clear worktree context when on `/session/:id` route

#### Decision 4: Terminal-only layout for v1

- **Decision:** Skip file tree / tool panel in direct session mode
- **Rationale:** File tree API is worktree-keyed; requires backend changes for project-scoped
- **Where:** `Layout.tsx` — render simplified layout when `isDirectSession`

---

## Files to Modify

| File | Change |
|------|--------|
| `App.tsx` | Add `/session/:sessionId` route |
| `Workspace.tsx` | Detect direct session, clear worktree context, pass to Layout |
| `Layout.tsx` | Add `isDirectSession` prop, render terminal-only view |
| `LeftSidebar.tsx` | Link direct sessions to `/session/:id` |
| `useWorkspaceUrlSync.ts` | Skip sync for `/session/` paths (read-only) |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **File tree for direct sessions?** | Deferred — needs `/projects/:id/tree` backend route |
| 2 | **QuickOpen in direct mode?** | Disabled — depends on worktree file-list |
| 3 | **Keyboard shortcuts?** | Some disabled (Cmd+P, Cmd+Shift+Z); others work |
| 4 | **Document title?** | Show session label or project name |

---

## Implementation Phases

### Phase 1 — Routing + Workspace Detection

- [ ] **1.1** Add `/session/:sessionId` route in `App.tsx`
- [ ] **1.2** `Workspace.tsx`: get `sessionId` from `useParams()`
- [ ] **1.3** `Workspace.tsx`: derive `isDirectSession` and lookup session/project
- [ ] **1.4** `Workspace.tsx`: clear worktree context when on direct session route
- [ ] **1.5** `Workspace.tsx`: set document title for direct session

**Verify phase 1:**
- [ ] **1.T1** Manual — `/session/:id` renders Workspace (not 404)
- [ ] **1.T2** Manual — worktree context cleared when navigating to direct session

---

### Phase 2 — Layout + Terminal

- [ ] **2.1** `Layout.tsx`: add `isDirectSession` prop
- [ ] **2.2** `Layout.tsx`: render terminal-only view (no TabsStrip, no ToolPanel)
- [ ] **2.3** `Workspace.tsx`: pass `isDirectSession` and session to Layout
- [ ] **2.4** Ensure TerminalPane receives correct session for attachment

**Verify phase 2:**
- [ ] **2.T1** Manual — direct session shows terminal full-width (no panels)
- [ ] **2.T2** Manual — terminal attaches and shows agent output
- [ ] **2.T3** Manual — can type in terminal, agent responds

---

### Phase 3 — Sidebar + Navigation

- [ ] **3.1** `LeftSidebar.tsx`: wrap direct session row in `<Link to="/session/:id">`
- [ ] **3.2** `LeftSidebar.tsx`: highlight active direct session (use URL match)
- [ ] **3.3** `useWorkspaceUrlSync.ts`: guard write effect to skip `/session/` paths
- [ ] **3.4** `Workspace.tsx`: redirect to dashboard if session not found/deleted

**Verify phase 3:**
- [ ] **3.T1** Manual — click direct session → navigates to `/session/:id`
- [ ] **3.T2** Manual — sidebar shows direct session as active (highlighted)
- [ ] **3.T3** Manual — browser back/forward works correctly
- [ ] **3.T4** Manual — deleted session redirects to dashboard

---

## Follow-up (v2)

- [ ] Backend: Add `/projects/:id/tree`, `/projects/:id/files/*` routes
- [ ] Backend: Add project-scoped tree watch
- [ ] Frontend: Enable file tree in direct session mode
- [ ] Frontend: Enable QuickOpen for direct sessions

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `App.tsx` | 1.1 | Add /session/:sessionId route |
| `Workspace.tsx` | 1.2-1.5, 2.3-2.4, 3.4 | Direct session detection, context, title |
| `Layout.tsx` | 2.1-2.2 | isDirectSession prop, terminal-only view |
| `LeftSidebar.tsx` | 3.1-3.2 | Link + active highlight |
| `useWorkspaceUrlSync.ts` | 3.3 | Skip /session/ paths |

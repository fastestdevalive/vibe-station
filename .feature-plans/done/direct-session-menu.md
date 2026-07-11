# Mini-Design: Direct-Session 3-dots Menu (pin / mark-done / dismiss)

> Add a per-direct-session actions menu mirroring the worktree menu, with a hard daemon-side guard that project files are never deleted.

**Branch:** `revisit-projects` (amend the single squashed commit)
**Status:** Pending

**Reference files:**
- Sidebar menu (worktree): `web-ui/src/components/layout/LeftSidebar.tsx:865-945` (wtMenu portal), `:616-642` (direct sessions render)
- Session delete: `daemon/src/routes/sessions.ts:527-577`
- Worktree pin/done: `daemon/src/routes/worktrees.ts:411` (pin), `:499-509` (done)
- Session model: `daemon/src/types.ts:24-54` (SessionRecord has `pinnedAt`)
- Cleanup helpers: `daemon/src/services/paths.ts:84-91` (cleanupDirectSessionDataDir)

---

## Problem

- Direct sessions have no actions menu — can't pin, mark done, or dismiss from the sidebar.
- Worktrees have this via `wtMenu`. Need the equivalent for direct sessions.
- **Critical safety:** dismissing a direct session must NEVER delete the project's own files (it runs *in* the project dir, not an isolated worktree).

## Out of Scope

- Global "Pinned" section for direct sessions (they reorder within their project group only).
- Resume/restart from the menu.

## Concept

- 3-dots trigger on each direct-session row → portal menu with:
  1. **Pin to top / Unpin** — toggles `session.pinnedAt`; pinned direct sessions sort first within the project group.
  2. **Mark as done** — sets session lifecycle state to `"done"` (metadata only, no process kill).
  3. **Dismiss** — confirm dialog → `DELETE /sessions/:id` (removes record + kills process + removes data dir; **never** touches `project.absolutePath`).
- Daemon: add `PATCH /sessions/:id/pin` and `POST /sessions/:id/done`; harden delete/cleanup with a path-safety guard.

---

## Design Details

### Backend

**New endpoints (`daemon/src/routes/sessions.ts`):**
```
PATCH /sessions/:id/pin   { pinned: boolean }   → toggle session.pinnedAt (idempotent)
POST  /sessions/:id/done                        → set lifecycle state "done", broadcast session:state
```
- Both work for direct AND worktree sessions (findSessionContext).
- Persist via `mutateProject` (direct → `directSessions[]`, worktree → `worktrees[].sessions[]`).

**File-deletion guard (`daemon/src/services/paths.ts`):**
- Add `assertSafeToDelete(target, projectAbsolutePath)` — throws if `target` equals, contains, or is contained by `projectAbsolutePath`, or is outside `vstHome()`.
- Call it inside `cleanupDirectSessionDataDir` / `cleanupSessionDataDir` before `rmSync`.
- Guarantees cleanup only ever removes paths under `~/.vibe-station/`, never the project checkout.

### Frontend

**API client (`web-ui/src/api/client.ts`):**
```
pinSession(id):    PATCH /sessions/:id/pin { pinned: true }
unpinSession(id):  PATCH /sessions/:id/pin { pinned: false }
markSessionDone(id): POST /sessions/:id/done
// deleteSession(id) already exists → used for Dismiss
```
- Mirror in `web-ui/src/api/mock.ts`.

**Session type (`web-ui/src/api/types.ts`):** add `pinnedAt?: string | null` (daemon already serializes it for worktree sessions; ensure direct sessions serialize it too).

**Sidebar (`web-ui/src/components/layout/LeftSidebar.tsx`):**
- Add `sessMenu` state (mirror `wtMenu`): `{ projectId, session, rect }`.
- Add a 3-dots trigger button to each direct-session row (currently a plain `<Link>` — wrap so the trigger sits in a trailing slot, like `wt-row__trail`).
- Render a portal menu (reuse `menu-pop` classes) with Pin / Mark as done / Dismiss.
- Sort `directSessionMap[p.id]`: pinned (by `pinnedAt` desc) first, then rest.
- Dismiss reuses a confirm dialog (`pendingDismissSession` state) → `api.deleteSession`.
- Close-on-outside-click effect mirroring the wtMenu one (`data-sess-menu-panel` / `data-sess-menu-trigger`).

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/routes/sessions.ts` | Add PATCH /pin, POST /done; guard delete |
| `daemon/src/services/paths.ts` | Add `assertSafeToDelete`; call in cleanup fns |
| `daemon/src/routes/sessions.ts` (serialize) | Ensure `pinnedAt` in serializeSession |
| `web-ui/src/api/client.ts` | pinSession/unpinSession/markSessionDone |
| `web-ui/src/api/mock.ts` | Mock the 3 methods |
| `web-ui/src/api/types.ts` | Session.pinnedAt |
| `web-ui/src/components/layout/LeftSidebar.tsx` | Menu trigger, portal, sort, confirm |

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Deleting project files** | `assertSafeToDelete` guard; cleanup only targets `~/.vibe-station/` data dirs |
| 2 | Menu remounts terminal | Sidebar is separate tree from TerminalPane — no remount risk |
| 3 | Pin sort instability | Sort by `pinnedAt` ISO desc, tie-break on id |

---

## Implementation Phases

### Phase 1 — Daemon: endpoints + guard
- [ ] **1.1** `assertSafeToDelete(target, projectPath)` in paths.ts; call in both cleanup fns
- [ ] **1.2** `PATCH /sessions/:id/pin { pinned }` — toggle pinnedAt (idempotent)
- [ ] **1.3** `POST /sessions/:id/done` — set lifecycle "done", broadcast
- [ ] **1.4** Ensure `serializeSession` emits `pinnedAt`

**Verify:** `cd daemon && npm run build`; manual curl pin/done; confirm dismiss leaves project dir intact.

### Phase 2 — Frontend: client + menu
- [ ] **2.1** client + mock methods; Session.pinnedAt type
- [ ] **2.2** Sidebar: 3-dots trigger + portal menu (Pin/Done/Dismiss)
- [ ] **2.3** Sort pinned direct sessions first; confirm dialog for dismiss

**Verify:** `cd web-ui && npx tsc --noEmit && npx vitest run`; menu works, dismiss keeps files.

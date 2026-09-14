# Plan — Draft Agent Sidebar Drag & Reorder

**Branch:** `create-ui-db`  
**Worktree:** `/home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131`  
**Target:** Enable drag-and-drop reordering for Global drafts and New Worktree drafts on the left sidebar without creating new commits (amend to existing daemon and UI commits).

---

## Architecture & Root Cause

1. **Global Drafts (`/draft/:id`):**
   - The daemon's `PATCH /sessions/:id/reorder` endpoint previously returned 404 for global drafts.
   - The `global_drafts` table lacked a `sortOrder` column.
   - `LeftSidebar.tsx` rendered global drafts as static elements without `DndContext` / `SortableContext`.
   - `mock.ts` coerced `projectId: null` to `"proj-a"`, corrupting global drafts in test environments.

2. **New Worktree Drafts (`draftsByProject[p.id]`):**
   - In `LeftSidebar.tsx`, the parent Project row attached `{...listeners}` to `div.wt-row-wrap` enclosing all children. Pointer down on any child draft triggered the Project's drag sensor.
   - Project drafts' `SortableRow` wrapper div lacked `className="wt-row-wrap"`, preventing drag affordance styling (`cursor: grab`, full width).
   - Project drafts need proper `DndContext` and `SortableContext` wrapping with `handleServerReorder(orderedDrafts, "session", e)`.

---

## Phases

### Phase 1: Daemon & Mock API Layer for Draft Reordering
**Files:**
- `daemon/src/services/dbSchema.ts` — add `sortOrder REAL` column to `global_drafts`
- `daemon/src/state/project-store.ts` — add `sortOrder` to `GlobalDraftRow`, `addGlobalDraft`, and `updateGlobalDraft`
- `daemon/src/routes/sessions.ts`:
  - `serializeGlobalDraft`: map `sortOrder: row.sortOrder ?? new Date(row.createdAt).getTime()`
  - `createDraftSession`: initialize `sortOrder: Date.now()` for global drafts
  - `PATCH /sessions/:id/reorder`: handle `ctx.kind === "global"`: update DB, broadcast `session:updated` with `sortOrder`, return `{ ok: true, sortOrder }`
- `daemon/src/__tests__/sessions.reorder.test.ts` — add test verifying `PATCH /sessions/:id/reorder` succeeds for global drafts
- `web-ui/src/api/mock.ts`:
  - `createDraftSession`: preserve `projectId: null` for global drafts (remove fallback to `"proj-a"`)
  - `reorderSession`: handle both project and global drafts

**Verification:**
- `pnpm --filter @vibestation/daemon test` passes

---

### Phase 2: Web UI Layer for LeftSidebar Draft Reordering
**Files:**
- `web-ui/src/components/layout/LeftSidebar.tsx`:
  - Move Project `{...listeners}` from `div.wt-row-wrap` to `<div className="tree-row tree-row--project" {...listeners}>` so parent projects do not intercept child drags.
  - Global drafts: wrap in `DndContext` + `SortableContext` + `SortableRow` (`className="wt-row-wrap"`), calling `handleServerReorder(globalDrafts, "session", e)`.
  - Project drafts (`draftsByProject`): sort by `sortOrder`, wrap in `DndContext` + `SortableContext` + `SortableRow` (`className="wt-row-wrap"`), calling `handleServerReorder(orderedDrafts, "session", e)`.
  - Add `onPointerDown={(e) => e.stopPropagation()}` to discard buttons.
- `web-ui/src/components/layout/LeftSidebar.test.tsx`:
  - Add unit tests for dragging global drafts and project drafts to verify `api.reorderSession` is called with computed sort order.

**Verification:**
- `pnpm --filter @vibestation/web typecheck` passes
- `pnpm --filter @vibestation/web test src/components/layout/LeftSidebar.test.tsx` passes

---

### Phase 3: Verification & Commit Amend
- Run full tests across daemon and web.
- Amend changes into existing commits (`5b3a0c63` and `0aac0044`) as requested by the user, leaving working tree clean and with no new commits added.

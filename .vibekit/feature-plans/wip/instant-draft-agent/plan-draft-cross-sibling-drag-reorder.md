# Plan — Draft Agent Cross-Sibling Drag & Reorder

**Branch:** `create-ui-db`  
**Worktree:** `/home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131`  
**Target:** Enable drag-and-drop reordering for drafts across non-draft siblings in the left sidebar:
1. Worktree drafts (`entryPoint === "worktree"` under a project) draggable across non-draft worktrees within that project (and direct drafts draggable across direct sessions).
2. Global drafts (`projectId === null, state === "drafting"`) draggable across projects at the root level.
All changes must be amended into existing commits (`971da2c` daemon, `71eaf4e` UI). No new commits.

---

## Architecture & Design

### 1. Worktrees + Worktree Drafts Unification (Project Level)
- **Current problem:** `draftsByProject[p.id]` is rendered in its own `DndContext` isolated from `orderedWtList`'s `DndContext`. Drafts cannot be dragged into or between worktrees.
- **Solution:**
  - Partition project draft sessions (`s.projectId === p.id && s.state === "drafting"`) into:
    - Direct drafts (`s.draftConfig?.entryPoint === "direct"`)
    - Worktree drafts (`s.draftConfig?.entryPoint !== "direct"`)
  - Direct drafts merge with `directList` (both are `Session` objects with `sortOrder`), sharing the direct-sessions `DndContext`.
  - Worktree drafts merge with `wtList` into a unified list:
    ```ts
    type ProjectWorktreeItem =
      | { kind: "worktree"; data: Worktree; id: string; sortOrder?: number }
      | { kind: "draft"; data: Session; id: string; sortOrder?: number };
    ```
  - Sort together by `sortOrder` (with `id` tie-breaker).
  - Single `DndContext` and `SortableContext` wrapping both worktrees and worktree drafts under the project.
  - `onDragEnd` uses fractional ordering (`computeNewSortOrder(prevNeighbor, nextNeighbor)`) and dispatches:
    - If moved item is a worktree: `useServerStore.applyWorktreeUpdated` + `api.reorderWorktree`
    - If moved item is a draft: `useServerStore.applySessionUpdated` + `api.reorderSession`

### 2. Global Drafts + Projects Unification (Root Level)
- **Current problem:** `globalDrafts` is rendered in its own `DndContext` above the projects heading / projects `DndContext`. They cannot be dragged into or between projects.
- **Solution:**
  - Top level projects and global drafts merge into a unified sortable item list:
    ```ts
    type TopLevelSidebarItem =
      | { kind: "project"; data: Project; id: string }
      | { kind: "global_draft"; data: Session; id: string };
    ```
  - The project scope (`sortOrders["projects"]`) manages the relative order of both projects and global drafts.
  - Live IDs include all visible project IDs and global draft IDs.
  - Un-ordered global drafts (newly created) default to the top of the list so they remain visible; once dragged, their position is saved in `sortOrders["projects"]`.
  - Single `DndContext` and `SortableContext` wrapping projects and global drafts at the top level.
  - On drag end: `handleReorder("projects", currentIds, e)` persists the order via `setSortOrder("projects", next)`. If a global draft was moved, also update its server `sortOrder` via `api.reorderSession`.

---

## Phases

### Phase 1: Worktree & Draft Unification under Project
**Files:**
- `web-ui/src/components/layout/LeftSidebar.tsx`:
  - Split project drafts into direct drafts and worktree drafts.
  - Combine direct drafts with `directList`.
  - Combine worktree drafts with `wtList` into unified sortable collection.
  - Single `DndContext` & `SortableContext` for worktrees + drafts.
  - Update reorder handler to call `api.reorderWorktree` or `api.reorderSession` based on item kind.
  - Remove redundant isolated draft `DndContext`.

### Phase 2: Global Draft & Project Unification at Top Level
**Files:**
- `web-ui/src/components/layout/LeftSidebar.tsx`:
  - Combine visible projects and global drafts into unified top-level sortable collection.
  - Single `DndContext` & `SortableContext` for top-level items.
  - Update `handleReorder` for `"projects"` scope to update `sortOrders["projects"]` and sync `api.reorderSession` for moved global drafts.
  - Remove redundant isolated global draft `DndContext`.

### Phase 3: Unit Tests & Verification
**Files:**
- `web-ui/src/components/layout/LeftSidebar.test.tsx`:
  - Test dragging a worktree draft between two worktrees verifies `api.reorderSession` with interpolated sortOrder.
  - Test dragging a worktree between two drafts (or draft and worktree) verifies `api.reorderWorktree`.
  - Test dragging a global draft between two projects verifies `sortOrders["projects"]` ordering.
- Verification:
  - `pnpm --filter @vibestation/web typecheck`
  - `pnpm --filter @vibestation/web test src/components/layout/LeftSidebar.test.tsx`

### Phase 4: Verification & Commit Amend
- Ensure docker dev container (`http://localhost:7131`) runs and hot-reloads cleanly.
- Amend UI changes to `71eaf4e`.
- Ensure git working tree is completely clean.

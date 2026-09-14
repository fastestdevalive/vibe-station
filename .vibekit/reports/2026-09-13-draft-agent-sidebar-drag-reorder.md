# SDLC Report: Drag and Reorder Issues for Global and New Worktree Draft Agents

**Date:** 2026-09-13  
**Branch:** `create-ui-db`  
**Target Worktree:** `vs-131`  

---

## 1. Problem Statement

Drag-and-drop reordering works seamlessly on the left sidebar for already-created **projects** and **worktrees**, but fails for draft agents:
1. **Global Draft Agents** (top-level drafts before projects)
2. **New Worktree Draft Agents** (project-level drafts created via Project `+` → "Agent in worktree")

*(Tab drafts inside worktrees are managed in `TabsStrip` and correctly excluded from the sidebar).*

---

## 2. Root Cause Analysis

### Issue 1: Global Draft Agents

There are two sub-issues preventing global draft reordering:

#### A. In `HEAD` (`0aac0044`), Global Drafts Had No DnD Setup
In `HEAD`, server-persisted global drafts (`projectId === null && state === "drafting"`) were rendered at `LeftSidebar.tsx:1508-1548` using a plain `.map()` over `<div>`s. There was **no** `<DndContext>`, no `<SortableContext>`, and no `<SortableRow>`. The rows were completely inert to drag gestures.

#### B. The Daemon Route Rejected Global Reorders with 404
In `daemon/src/routes/sessions.ts:1618`, `PATCH /sessions/:id/reorder` explicitly rejected global drafts:
```ts
const ctx = findSessionContext(id);
if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
if (ctx.kind === "global") return reply.status(404).send({ error: `Session '${id}' not found` });
```
Additionally, the SQLite `global_drafts` table lacked a `sortOrder` column.

#### C. Staged Fix vs. Docker Dev Sandbox Drift
While the working tree currently has staged changes adding `sortOrder` to `global_drafts` and wrapping global drafts in a `DndContext`:
* In `docker-compose.dev.yml`, only `web-ui/src` is bind-mounted (hot-reloaded). `daemon/src` is **baked into the container image at build time**.
* In the active running sandbox (`vs-131-vst-dev-1`), the daemon has **not been rebuilt**.
* When the UI attempts `api.reorderSession(globalDraftId, newSortOrder)`, the running container daemon returns `404 Session '...' not found`.
* `LeftSidebar.tsx:554` catches the 404 and **immediately rolls back the optimistic sort order**:
  ```ts
  void call.catch(() => {
    patch(prevSortOrder);
  });
  ```
  The row snaps back to its original position upon release.

---

### Issue 2: New Worktree Draft Agents (`draftsByProject`)

When an agent is created via Project `+` → "Agent in worktree", it is stored with `draftConfig: { entryPoint: "worktree", worktreeChoice: "new" }` and rendered in `draftsByProject[p.id]`. Reordering fails due to two major obstacles:

#### A. Scope Isolation: Drafts Cannot Be Reordered Among Worktrees
This is the core UX mismatch. When a user creates a "New worktree draft", they intuitively consider it a worktree (a worktree in draft state) and expect to drag it into position relative to existing worktrees (`wt-1`, `wt-2`, etc.).

However, inside each project `p.id` in `LeftSidebar.tsx`:
* **Direct sessions** are in `<DndContext onDragEnd={... directSession ...}>`
* **Drafts** are in `<DndContext onDragEnd={... orderedDrafts ...}>`
* **Worktrees** are in `<DndContext onDragEnd={... orderedWtList ...}>`

They are **three isolated `DndContext` components**:
* An item in `draftsByProject` cannot detect or drop onto items in `orderedWtList`. Dragging a draft over a worktree yields `over = null`.
* Draft rows can **only** be reordered amongst other draft rows of that exact same project.
* Because a user typically only has **1** draft in a project at a time, dragging the draft produces no valid drop target anywhere in the sidebar.

#### B. Parent Project Drag Listener Hijacking (`LeftSidebar.tsx:1629-1634`)
In `HEAD`, the parent project row was wrapped like this:
```tsx
{orderedVisibleProjects.map((p) => (
  <SortableRow key={p.id} id={p.id}>
    {({ setNodeRef, style, attributes, listeners }) => (
      <div ref={setNodeRef} style={style} className="wt-row-wrap" {...attributes} {...listeners}>
        <div className="tree-row tree-row--project">
          ...
        </div>
        {/* Children: direct sessions, drafts, worktrees */}
```
Because `{...listeners}` was attached to the outer `wt-row-wrap` container enclosing the entire project subtree:
* A `pointerdown` on any draft row bubbled up to the project's pointer sensor.
* Moving the pointer 4px triggered a drag of the entire **Project** (`p.id`) rather than the draft row.
*(The unstaged diff in the workspace moves `{...listeners}` to `div.tree-row--project`, which resolves this hijacking).*

---

## 3. The Two UX Models for New Worktree Drafts

Before implementing, a product decision is needed on how "New Worktree" drafts should behave:

### Model A: Drafts Reorder Among Worktrees (Unified Worktree List)
* **Behavior:** A "New worktree draft" is rendered in the worktree list alongside existing worktrees. Dragging it allows the user to position the new worktree before starting it.
* **Implementation:** Merge `draftsByProject[p.id].filter(isWorktreeDraft)` and `worktreeMap[p.id]` into a unified sortable list within a single `<DndContext>`. `sortOrder` is shared across both.

### Model B: Drafts Section Reorders Only Peer Drafts (Dedicated Draft Section)
* **Behavior:** Drafts remain in their own "Drafts" section above worktrees. Dragging only allows reordering draft 1 vs. draft 2.
* **Implementation:** Keep the separate `DndContext` for `draftsByProject`, fix the parent listener leak, and ensure users understand drafts cannot be interleaved with existing worktrees.

---

## 4. Remediation Plan

1. **Fix Parent Event Leak (Immediate):**
   * Apply the unstaged fix in `LeftSidebar.tsx`: move `{...listeners}` from `div.wt-row-wrap` to `div.tree-row--project` so parent projects do not hijack child drag gestures.
2. **Rebuild Sandbox Daemon for Global Drafts:**
   * Rebuild the dev sandbox container (`docker compose -f docker-compose.dev.yml build vst-dev && scripts/dev-sandbox.sh up vs-131`) so the daemon incorporates the `sortOrder` column and `PATCH /sessions/:id/reorder` global handler.
3. **Align "New Worktree" DnD Context (Model A vs Model B):**
   * If Model A is desired: combine new worktree drafts and worktrees under the worktree `<SortableContext>`.
   * If Model B is desired: ensure draft rows have proper drop feedback when ≥2 drafts exist.

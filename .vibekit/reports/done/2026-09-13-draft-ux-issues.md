# Draft UX Issues: Worktree ✕ Behavior and Reordering

**Commit:** `a95160a986cf88ae4cc2c182b50a2b09070098fc`  
**Date:** 2026-09-13  
**Branch:** `create-ui-db`

---

## Answer

Two distinct issues:

1. **Worktree ✕ creates intermediate broken state** → second ✕ discards the entire draft
2. **Draft rows are not reorderable** → `draftsByProject` rendering is explicitly excluded from DnD

Both are fixable; neither requires data model changes.

---

## Issue 1: Worktree ✕ Intermediate State

### Root cause

`DraftComposer.tsx:583-594` — the ✕ handler for a worktree-level draft:

```tsx
onClick={() => {
  if (entryPoint === "worktree" && draftSessionId) {
    prefilledRef.current = false;
    setUseWorktree(false);           // ← LOCAL state only
    void api.updateDraft(draftSessionId, {
      draftConfig: { ...currentConfig, entryPoint: "direct", useWorktree: false },
    }).catch(() => {});
  } else {
    committedRef.current = true;
    onDiscard();
  }
}}
```

### Step-by-step failure sequence

| Step | What happens | UI state |
|------|-------------|----------|
| 1. User clicks ✕ | `setUseWorktree(false)` fires | `entryPoint` still `"worktree"` (from server store — WS hasn't arrived); `useWorktree` = false |
| 2. Re-render | Project chip still shows (entryPoint=worktree); "Use worktree" checkbox appears **unchecked** | Confusing intermediate state |
| 3. API call sends PATCH | Server sets `entryPoint: "direct"` | — |
| 4. WS `session:updated` arrives | `entryPoint` flips to `"direct"` | Another re-render |
| 5. Project chip still shows | ✕ handler: `entryPoint === "worktree"` is **false** | Hits `else { onDiscard() }` branch |
| 6. User sees project chip with ✕ | **Second ✕ click discards the entire draft** | Full discard |

### Why the second click discards

After step 4, `entryPoint === "direct"`. The ✕ handler condition `entryPoint === "worktree"` is false. The `else` branch calls `onDiscard()`. That's a complete draft deletion.

### The missing link: `setUseWorktree` vs. `applySessionUpdated`

- `setUseWorktree(false)` only updates local React state — **does not** change `entryPoint`
- `entryPoint` is derived from `session.draftConfig.entryPoint` via the server store (`DraftComposer.tsx:54-64`)
- The server store only updates when the WS event arrives
- Between click and WS arrival: `entryPoint = "worktree"`, `useWorktree = false` → incoherent pair

### Fix

Replace `setUseWorktree(false)` with an **optimistic store update** that changes `entryPoint` immediately:

```tsx
onClick={() => {
  if (entryPoint === "worktree" && draftSessionId) {
    const newConfig = { ...currentConfig, entryPoint: "direct" as const, useWorktree: false };
    // Optimistic update: entryPoint flips to "direct" immediately, no intermediate state
    useServerStore.getState().applySessionUpdated(draftSessionId, { draftConfig: newConfig });
    void api.updateDraft(draftSessionId, {
      draftPrompt: prompt,
      draftConfig: newConfig,
    }).catch(() => {
      // Rollback on API error
      if (currentConfig) {
        useServerStore.getState().applySessionUpdated(draftSessionId, { draftConfig: currentConfig });
      }
    });
  } else {
    committedRef.current = true;
    onDiscard();
  }
}}
```

- No `prefilledRef.current = false` needed — the WS event will still arrive and re-prefill correctly
- `useServerStore` is already imported in `DraftComposer.tsx:14`
- `applySessionUpdated` signature: `(sessionId: string, patch: Partial<Session>)` — `DraftComposer.tsx:39`

---

## Issue 2: Draft Rows Not Reorderable

### Root cause

`LeftSidebar.tsx:1765-1807` — draft rows are rendered **outside** any DnD context:

```tsx
{/* Tier 1 draft rows (state === "drafting") — rendered AFTER the
    sorted direct-session list, outside the sortOrder sort, so a
    draft never participates in reorder ordering. */}
{!collapsed && openProj.has(p.id) && (draftsByProject[p.id] ?? []).length > 0
  ? (draftsByProject[p.id] ?? []).map((s) => (
      <div key={s.id} className="tree-row tree-row--worktree draft-row" ...>
```

The comment is self-documenting: intentionally excluded. No `SortableRow`, no `SortableContext`, no sort by `sortOrder`.

### What IS already in place

| Component | Status |
|-----------|--------|
| `@dnd-kit/core`, `@dnd-kit/sortable` | ✅ Imported at top of file |
| `SortableRow` component | ✅ Defined at `LeftSidebar.tsx:70` |
| `handleServerReorder` | ✅ Defined at `LeftSidebar.tsx:517` — works for `"session"` kind via `api.reorderSession` |
| `dndSensors`, `markDrag` | ✅ Available |
| `Session.sortOrder` | ✅ Field exists (used by direct sessions at line 1638) |
| `computeNewSortOrder` | ✅ Used by `handleServerReorder` |

### Fix

1. Sort `draftsByProject[p.id]` by `sortOrder` before rendering (same pattern as `orderedDirect` for sessions)
2. Wrap the draft row list in `DndContext` + `SortableContext`
3. Use `SortableRow` for each row (same pattern as worktree rows)
4. `onDragEnd`: `handleServerReorder(orderedDrafts, "session", e)`

No API changes needed — `api.reorderSession` already handles session reordering.

---

## Not checked

- Whether worktree-level drafts (`entryPoint === "worktree"`) should be displayed nested under their target worktree row (currently they appear flat under the project, same as direct-session drafts). This is a separate UX decision not addressed here.
- Whether the `draftsByProject` memo should also be sorted (currently unsorted — sort order would be insertion order).
- Drag handle styling for draft rows (currently draft rows have a ×discard button on the right; a drag cursor would need CSS attention).

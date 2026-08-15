<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Sidebar section header consistency + project reordering

> Make the Pinned / Workspaces / Projects sidebar section headers visually consistent (aligned text, leading icons, dividers) and let Projects be drag-reordered like every other sidebar list.

**Issue:** sidebar-header-consistency
**Branch:** `wip/vs-45` (current worktree branch)
**Status:** Implementation complete — typecheck + full vitest suite (402 tests) pass; lint could not be run (root `node_modules` not installed in this worktree, pre-existing environment gap unrelated to this change)
**PRD:** none — small, single-component visual + interaction change, skipped per user request
**Parent:** none

**Reference files:**
- `web-ui/src/components/layout/LeftSidebar.tsx` — all three section headers + project list render
- `web-ui/src/styles/workspace.css:313-373` — `.sidebar-projects-heading*` rules
- `web-ui/src/styles/workspace.css:505-518` — `.tree-row__chevron` (12px reference box)
- `web-ui/src/hooks/useStore.ts` — `sortOrders`/`setSortOrder` (local-only reorder store, already used by pinned lists)

---

## Problem

- Three sidebar section headers (Pinned, Workspaces, Projects) don't left-align their titles: Workspaces has a 12px chevron + gap before its text, Pinned/Projects have none — titles visually jog left/right against each other
- No visual separation between the three sections — they run together
- Projects can't be reordered; every other sidebar list (pinned worktrees, pinned direct sessions, workspaces, direct sessions, worktrees) already supports drag-reorder

## Out of Scope

- Server-side persistence of project order (no `Project.sortOrder` field/route exists) — use the same local-only `sortOrders` mechanism already used for pinned lists (Decision 1 precedent in the file's own comments)
- Reordering worktrees/sessions *across* projects — unchanged
- Collapsed-rail (`collapsed` prop) header layout — already icon-only, not addressed here

## Concept

- Give Pinned's and Projects' headers a leading icon in a 12px box (same box `.tree-row__chevron` uses), with the same gap before the title that Workspaces' chevron+title already has — all three titles land at the same x-offset
- Add a top border divider between adjacent rendered sections
- Wrap `visibleProjects.map(...)` in the same `DndContext`/`SortableContext`/`SortableRow` pattern used for pinned worktrees, keyed by project id, writing to `sortOrders["projects"]` via `setSortOrder`

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Pinned header shows a leading `Pin` icon (12px box), Projects header shows a leading folder icon (12px box) — both use the same gap as Workspaces' chevron→title spacing |
| 2 | All three section header titles left-align at the same x position (verified visually / via matching CSS box widths) |
| 3 | A 1px top border divider appears between any two adjacent *rendered* sections (Pinned/Workspaces/Projects — sections that don't render, e.g. no pinned items, don't leave a stray double border) |
| 4 | Projects are draggable and reorderable among themselves; order persists across reload (localStorage-backed, same mechanism as pinned lists) via `sortOrders["projects"]` |
| 5 | Dragging a project doesn't trigger its expand/collapse toggle or navigate — mirrors existing `markDrag`/`useDragClickGuard` handling for worktree rows |
| 6 | Collapsed-rail mode (`collapsed` prop) gets no new icons/dividers (icon-only header mark unchanged) — **deviation during implementation:** the drag-reorder wrapper is applied to the single project-list render path in both modes rather than duplicating ~350 lines of JSX per the guardrail against parallel render sites for the same element; collapsed rail is draggable too as a result, which is harmless (same underlying rows, just centered/abbreviated styling) |

---

## Design Details

### Header icon alignment

- New shared class `.sidebar-projects-heading__icon`: `width/height: 12px`, `display: inline-flex; align-items: center; justify-content: center` (mirrors `.tree-row__chevron`), placed before `.sidebar-projects-heading__title` with `gap: var(--space-2)` on the heading container (matches `.tree-row__project-expand`'s existing `gap: var(--space-2)`)
- Pinned heading: add `<Pin size={12} />` inside the icon slot
- Projects heading (expanded, non-collapsed branch only): add `<FolderTree size={12} />` inside the icon slot — reuses the icon already used for the collapsed-rail mark, so Projects' glyph is recognizable in both states
- Workspaces heading already has its chevron in the equivalent slot position — no change needed there, just used as the alignment reference

### Divider

- New class `.sidebar-section-divider`: `border-top: var(--border-width) solid var(--border-default); margin: var(--space-2) 0`
- Rendered once between Pinned section and Workspaces section (only when Pinned rendered), and once between Workspaces section and the Projects heading (Workspaces' header always renders when `!collapsed`, so this one is unconditional in non-collapsed mode)
- Collapsed mode: no dividers (matches existing collapsed header suppression)

### Projects drag-reorder

- New `orderedVisibleProjects` memo: `applyLocalSortOrder(sortOrders["projects"], visibleProjects.map(p => p.id))` mapped back through a `byId` lookup — same shape as `orderedPinnedWorktrees`
- Wrap the `visibleProjects.map(...)` block in `DndContext` (`dndSensors`, `closestCenter`, `onDragStart={markDrag}`, `onDragCancel={markDrag}`, `onDragEnd` → `handleReorder("projects", orderedVisibleProjects.map(p => p.id), e)`) + `SortableContext` (`items`, `verticalListSortingStrategy`)
- Each project's outer `<div key={p.id}>` becomes a `SortableRow` (same wrapper pattern as pinned rows: `setNodeRef`/`style`/`attributes`/`listeners` spread onto a `.wt-row-wrap`-equivalent wrapper div around the existing project block) — existing `tree-row--project` click/expand handlers untouched
- Reuses existing `handleReorder` (already generic over `scopeKey`) — no new reorder function needed
- Only rendered when `!collapsed` — collapsed rail keeps its current static list (Requirement 6)

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does making the whole project row a drag surface break the existing "…" project menu / "+" new-session button? | No — same `onPointerDown` stop-propagation pattern already used on those buttons in worktree rows; verify by clicking both after adding drag wrapper |
| 2 | Project order is local-only (per-browser) | Documented precedent (pinned lists) — acceptable per Out of Scope |

---

## Implementation Phases

### Phase 1 — Header alignment + divider

- [x] **1.1** Add `.sidebar-projects-heading__icon` CSS rule (12px box) in `workspace.css` near `.sidebar-projects-heading__gutter`
- [x] **1.2** Add `.sidebar-section-divider` CSS rule in `workspace.css`
- [x] **1.3** Pinned heading (`LeftSidebar.tsx` ~line 868): add icon slot with `<Pin size={12} />` before the title span
- [x] **1.4** Projects heading (`LeftSidebar.tsx` ~line 1264, non-collapsed branch): add icon slot with `<FolderTree size={12} />` before the title span
- [x] **1.5** Insert `.sidebar-section-divider` between Pinned and Workspaces sections (conditional on Pinned rendering) and between Workspaces and the Projects heading (unconditional when `!collapsed`)

**Verify phase 1:**
- [x] **1.T1** `npm run typecheck` + full `vitest run` (402 tests) pass; visual check deferred to user — no browser available in this session (see plan header note)

### Phase 2 — Projects drag-reorder

- [x] **2.1** Add `orderedVisibleProjects` memo using `applyLocalSortOrder(sortOrders["projects"], ...)`
- [x] **2.2** Wrap the projects list render in `DndContext` + `SortableContext`, replace `visibleProjects.map` with `orderedVisibleProjects.map`, wrap each project block in `SortableRow`; applied to the single existing render path (used in both collapsed/expanded) rather than duplicating JSX — see Requirement 6 deviation note
- [x] **2.3** Confirm `handleReorder("projects", ...)` writes via existing `setSortOrder` — no new handler
- [x] **2.4** Added `onPointerDown` stop-propagation to the project row's "+" and "…" buttons (matches the established convention for interactive controls inside a drag surface — see `SortableRow` docstring)

**Verify phase 2:**
- [x] **2.T1** Code review — `handleReorder`/`setSortOrder`/`applyLocalSortOrder` are the exact same functions already exercised by pinned-worktree drag tests; visual/interactive confirmation deferred to user (no browser in this session)
- [x] **2.T2** Full LeftSidebar test suite (42 tests, incl. project expand-toggle and menu-trigger tests) still passes after the drag-wrapper change

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/styles/workspace.css` | Modified | 1 | New `.sidebar-projects-heading__icon`, `.sidebar-section-divider` rules |
| `web-ui/src/components/layout/LeftSidebar.tsx` | Modified | 1, 2 | Header icons, dividers, projects drag-reorder |

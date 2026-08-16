# Plan: add-tile-picker-filters

Very small, single-commit fix to the saved-workspace "Add tile" picker's cross-project
section. No PRD (self-contained, low-ambiguity, one file's worth of changes). No sub-plan
decomposition — one plan, one implementation pass, one commit/PR.

## Scope

In `WorkspaceCanvas.tsx`'s "Add tile" dropdown (`workspace-canvas__picker`), the
cross-project `otherContextGroups` section (only shown for a *saved* workspace,
`isSaved`):

1. Currently lists every worktree in every other project, including fully "done" ones.
   Only show non-done worktrees — reuse the same status rollup the dashboard uses to
   decide its "Finished" bucket (`worktreeRolledUpStatus` + `bucketForRollup`-equivalent:
   done/exited ⇒ hidden; a worktree with no agent sessions at all is NOT treated as done,
   since it may still have terminal sessions worth adding as a tile — the dashboard skips
   those rows entirely rather than bucketing them "finished", so filtering must mirror
   that skip, not the fallback branch).
2. Add a search/filter input at the top of the picker that filters the visible items
   (own-worktree agents/terminals + cross-project sessions/worktree names) by substring,
   case-insensitive.
3. Make each project's cross-context section collapsible/expandable, chevron/folder-icon
   toggle matching the left sidebar's per-project disclosure pattern
   (`LeftSidebar.tsx`'s `openProj` Set + `Folder`/`FolderOpen` icon swap).

## Root causes / reference points (found during exploration)

- `WorkspaceCanvas.tsx` lines 353-372: `otherContextGroups` builds the cross-project
  worktree list with no status filter at all.
- `web-ui/src/lib/worktreeStatus.ts`: `worktreeRolledUpStatus(sessions, live)` — same
  function `DashboardPanel.tsx` uses (lines 130-141) to bucket "Working / Waiting / PR /
  Finished". `DashboardPanel.tsx` line 133 skips worktrees with zero agent sessions
  entirely (`if (agentSessions.length === 0) continue`) rather than bucketing them
  "finished" — the picker filter must replicate that skip-vs-hide distinction, not treat
  agentless worktrees as done.
- `sessionStates` (`useWorkspaceStore((s) => s.sessionStates)`) is the live-state map
  `worktreeRolledUpStatus` needs as its second arg; `WorkspaceCanvas.tsx` doesn't
  currently read this selector — needs to be added.
- `LeftSidebar.tsx` lines 1344-1363: the project-row disclosure pattern to mirror
  (`aria-expanded`, `Folder`/`FolderOpen` icon swap, click toggles a `Set<string>` of
  expanded ids). The picker doesn't need `localStorage` persistence — it's a transient
  popup, reset on every open is fine and keeps this small.
- `QuickOpen.tsx` lines 135-147: existing search-input markup pattern (icon + `<input
  type="search">`) to follow visually, adapted into the picker's own CSS classes in
  `workspace-canvas.css` rather than reusing `quick-open-*` classes (different container).

## Checklist

- [x] 1. `WorkspaceCanvas.tsx`: import `worktreeRolledUpStatus` from `@/lib/worktreeStatus`
      and read `sessionStates` via `useWorkspaceStore((s) => s.sessionStates)`.
- [x] 2. `WorkspaceCanvas.tsx`: add a `worktreeIsDone(w)` helper — agent sessions for `w`
      from `allSessions`; if none, return `false`; else `worktreeRolledUpStatus(...)` is
      `"done"` or `"exited"` ⇒ `true`. Apply it in the `otherContextGroups` worktree
      `.filter(...)` (line ~359) alongside the existing `projectId`/`id` filters.
- [x] 3. `WorkspaceCanvas.tsx`: add `pickerSearch` state (`useState("")`), reset to `""`
      whenever `pickerOpen` flips to `true` (existing outside-click effect's dependency
      block, or a small dedicated effect). Apply a case-insensitive substring filter to:
      own-worktree `availableAgents`/`availableTerminals` (by `sessionLabel`), and, inside
      `otherContextGroups`, each worktree's `sessions` plus the worktree's own
      name/branch (a worktree survives the filter if its name matches OR it has at least
      one matching session) and drop now-empty worktree entries / empty project groups.
- [x] 4. `WorkspaceCanvas.tsx`: render a search `<input>` as the first child of the
      `workspace-canvas__picker` panel (only when the panel isn't `pickerEmpty` and there's
      something to search — always safe to render, harmless if list is short), wired to
      `pickerSearch`/`setPickerSearch`, autofocused on open.
- [x] 5. `WorkspaceCanvas.tsx`: add `expandedPickerProjects` state (`Set<string>`,
      default: all project ids expanded on open, same reset-on-open effect as the search).
      Wrap each `otherContextGroups` group's heading in a toggle button (chevron via
      `Folder`/`FolderOpen` icon swap, `aria-expanded`), and only render that group's
      worktree list when expanded.
- [x] 6. `workspace-canvas.css`: add `.workspace-canvas__picker-search` (input + icon row,
      sticky to the top of the scrollable panel) and
      `.workspace-canvas__picker-heading--toggle` (cursor pointer, hover state) styles.
- [x] 7. Update this plan's checklist as items complete; write a short `report.md` with a
      before/after screenshot pair of the Add Tile picker (dev sandbox), per the "add
      screenshots" ask.

## Verification

- `npx tsc --noEmit` in `web-ui/` (or existing typecheck script).
- `npm run build` in `web-ui/` (or equivalent) to catch JSX/type errors.
- Manual/browser verification via the dev sandbox (`scripts/dev-sandbox.sh up`) — open a
  saved workspace's Add Tile picker, confirm: done worktrees are hidden, search filters
  the list, project sections collapse/expand. Screenshot both states for `report.md`.

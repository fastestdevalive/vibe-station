# SDLC report: dashboard-kanban-chips-search

**Date:** 2026-09-26 · **Commit:** `1fc99fc2dd4ff0137c98043a7786dafd723a9075` (branch `design-dashboard-ptal`, just rebased onto `origin/main`) · **Sub-feature(s) covered:** none yet — pre-plan scope alignment

## Bugs

| # | Symptom | Where found | Severity |
|---|---------|-------------|----------|
| 1 | Kanban's 4th column ("PR Created") wraps onto its own row instead of sitting beside the other 3 | `web-ui/src/styles/workspace.css:5258-5270` (`.dashboard-kanban` track is `repeat(3, 1fr)`) vs `web-ui/src/components/layout/DashboardPanel.tsx:450-483` (always renders 4 `.dashboard-kanban__col` divs, 5 with Finished shown) | Medium — visual only, no data loss |
| 2 | "PR Created" bucket shows one row per **session**, not per **worktree** — a worktree with 2 sessions both landing in the `pr` bucket produces 2 redundant rows for one PR | `DashboardPanel.tsx:95-172` (`useSessionBuckets` buckets `Session[]`, no worktree de-dup) and reused verbatim by `ProjectHomeTab.tsx:64-68,289-296` | Medium — misleading, not broken |
| 3 | Open a file in a worktree, navigate Home, navigate back to the same worktree: the file's tab is still in the tab strip, but the preview pane shows "Select a file from the tree" instead of the file — clicking the tab re-shows it immediately | `web-ui/src/hooks/useStore.ts:1641-1660` (`clearWorkspaceSelection`, called by the "Home" link at `LeftSidebar.tsx:1240`) sets `activeFileTabIdxByWorktree[key] = -1` intending to only deactivate the *current* view; `setActiveWorktree` (`useStore.ts:987`) restores `activeFilePath` on re-entry by reading that same shared index (`useStore.ts:1024-1027`) and finds `-1`, so it restores `null` even though `openFileTabsByWorktree` (the tab list itself) was never touched | Medium — data isn't lost, but every worktree revisit after a Home trip silently blanks the preview |

## Root cause

- **Kanban column bug** → CSS track (`repeat(3,1fr)`) was never updated when a 4th ("PR Created") and conditional 5th ("Finished") column were added to the JSX; the two were never reconciled.
- **PR-bucket redundancy** → `bucketForRollup` (`DashboardPanel.tsx:52-58`) is intentionally per-session (matches every other bucket, which IS agent-activity-driven), but the `pr` bucket is the one case where the underlying signal (`worktreePrStatus`, `web-ui/src/lib/statusColor.ts`) is actually per-**worktree** — no de-dup step exists between "resolve PR per worktree" and "render one row per session".
- **No sidebar search** → `LeftSidebar.tsx` sections (`Pinned` @1259, `Workspaces` @1514, `Projects` @1646, per-project `openProj` Set @688, `workspacesOpen` bool @707) are driven only by manual collapse/expand state persisted to `localStorage`; no query/filter layer exists to override it.
- **Chip layout not adapted for kanban** → `dashboard-card__primary` (session name) + `dashboard-card__branch` (`"{branch} · {id}"`) in `renderDashboardItem` (`DashboardPanel.tsx:302-358`) was laid out for the wider list-view row; kanban reuses the identical markup in a narrower column with no line-break adjustment.
- **Preview blanks after Home → worktree** → `activeFileTabIdxByWorktree` is a single shared map used for two different jobs: (1) "which tab is visually active in this worktree" and (2) the restore key `setActiveWorktree` trusts on re-entry. `clearWorkspaceSelection` mutates it for job (1) (blank the pane while on Home) but that write is indistinguishable from "the user closed the tab" for job (2), so the next `setActiveWorktree` restores nothing.

## Action items

| # | Action | Owner sub-feature | Status |
|---|--------|--------------------|--------|
| 1 | Two-line chip: project/worktree name on its own line above session name (fixes narrow-column wrap contributing to bug #1); fix kanban grid track to match actual rendered column count (3/4/5) so all boards sit on one row | `01-kanban-chip-and-grid-fix` | open |
| 2 | Cap each kanban column at 10 chips + a "More" affordance that reveals the rest | `01-kanban-chip-and-grid-fix` | open — **decision needed:** expand-in-place vs. modal/drawer |
| 3 | Reuse the exact same (new) chip visual treatment in list view — no second chip style | `02-list-view-chip-parity` | open |
| 4 | `pr` bucket renders one row per **worktree**, not per session, on both `ProjectHomeTab.tsx` (`renderSessionRow` @146-181, `pr.map` @289-296) and `DashboardPanel.tsx` (`renderDashboardItem` @302-358, kanban `pr.map` @473, list `pr` section) | `03-pr-bucket-worktree-rollup` | open — **decision needed:** does `useSessionBuckets`'s `pr: Session[]` shape change to `pr: Worktree[]` (breaking both call sites' types), or does rendering de-dup client-side and leave the hook untouched? |
| 5 | Sidebar search input directly below "Create new agent" (`LeftSidebar.tsx:1250-1258`); fuzzy-matches across Pinned/Workspaces/Projects+their sessions; force-expands all groups while a query is active; restores prior `openProj`/`workspacesOpen` state (not a hard reset) on clear | `04-sidebar-search` | open — **decision needed:** match scope is session name + branch name + project name + mode name all together, or per-field with per-field weighting? |
| 6 | Sidebar search: confirm client-only feasibility | `04-sidebar-search` | open — **author's take:** client-only is sufficient — sidebar data is already fully loaded in-memory (REST fetch + live WS patches per `useServerSync.ts`, per `AGENTS.md`'s session-status invariant), so no new endpoint is needed; a small fuzzy-match utility (e.g. hand-rolled subsequence scorer, no new dependency required) run against the existing `projects`/`worktrees`/`sessions` store slices is enough. Flagging for confirmation before planning locks this in. |
| 7 | Fix bug #3: `setActiveWorktree`/`setActiveDirectContext` must not treat `clearWorkspaceSelection`'s `-1` write as "tab was closed" — either give the pane-blank and the tab-restore-index separate state, or have `clearWorkspaceSelection` remember what it blanked so re-entry can tell "explicitly deactivated" apart from "no tab was ever open" | `05-preview-restore-after-home-nav` | open |

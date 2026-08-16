# Plan: direct-agents-dashboard-tile

Small feature bundle, no PRD — both parts confirmed architecturally additive by investigation.

## Scope

1. Direct agent sessions (no worktree, project-scoped) don't appear on the dashboard home page —
   only worktrees are bucketed. Add them into the same Working/Waiting for User/PR created/Finished
   buckets, alongside worktrees.
2. The canvas "Add tile" picker's cross-context section (saved workspaces only) offers other
   worktrees' sessions but never direct sessions. Add them per project, same section.

## Findings (investigation)

- Direct sessions live in the same flat `sessions` array (`useServerStore`), identified by
  `worktreeId == null && projectId` set. No store changes needed.
- `sessionStatus(state)` (`lib/worktreeStatus.ts:34`) is purely state-driven, no worktree
  dependency — reusable as-is for a single direct session's bucket status.
- `/session/:directSessionId` route already exists (`App.tsx`), and `Workspace.tsx` already derives
  active direct-session context from the URL alone — a dashboard card needs only a plain `<Link>`,
  no store action on click (confirmed by mirroring `LeftSidebar.tsx`'s existing direct-session row,
  which does the same).
- `TileSpec.worktreeId` staying `undefined` for a direct-session tile is safe: `paneKeyForTile`
  never reads worktreeId for agent/terminal tiles (pure `${kind}:${sessionId}`), and
  `renderTileChrome`'s label logic already branches on `session.worktreeId` (not `tile.worktreeId`)
  for the worktree-segment of the label — a direct session's tile already renders correctly as
  `"Project > SessionLabel"` with zero changes, per a comment already in the code anticipating
  exactly this case.
- The cross-context picker is saved-workspace-only by explicit design (`!isSaved` guard,
  `WorkspaceCanvas.tsx:353`) — direct sessions are added to that same scope, not the transient
  per-worktree scratch canvas (architectural limit, not a new one introduced here).

## Explicit scope decisions

- No "dismiss" affordance on a direct-session dashboard card (worktree cards get one for
  done/exited, backed by `api.dismissWorktree` — deleting a direct session outright is a more
  destructive, different action not needed for a visibility-only fix).
- No PR-poller changes — `prPoller.ts` only ever polls worktrees; a direct session's `needs_review`
  bucket is dead code today (never actually set) but harmless to leave wired for forward-compat.
- Direct-session card secondary line shows `"direct"` (mirrors the sidebar's own "direct" badge)
  in place of a worktree's short id, since there's no id-chip equivalent.

## Checklist

- [x] 1. `DashboardPanel.tsx`: introduce a `DashboardItem` union (`{kind:"worktree", worktree}` |
      `{kind:"direct", session}`), change the 4 bucket arrays to hold `DashboardItem[]`.
- [x] 2. Extend the bucketing loop to also scan `sessions` for `type === "agent" && worktreeId == null
      && archivedAt == null && projectId not hidden`, bucket via `sessionStatus`.
- [x] 3. Generalize `renderWorktreeCard` → `renderDashboardItem`, switching on `item.kind`; direct
      case renders a `Link to="/session/:id"` card (dot, `sessionLabel`, "direct", project name),
      no dismiss button.
- [x] 4. Update the list/kanban render call sites (`.map((wt) => renderWorktreeCard(wt))` →
      `.map((item) => renderDashboardItem(item))`).
- [x] 5. `WorkspaceCanvas.tsx`: add a `directSessions` array to each `otherContextGroups` project
      entry (same project, `worktreeId == null`, not already placed), include in the group's
      non-empty filter.
- [x] 6. Render the group's `directSessions` in the picker JSX, sibling to the worktree subheadings
      (own "Direct" subheading, same item-button styling, `addTile(s.type, s.id)` — no
      `tileWorktreeId`, matching the own-worktree call pattern).
- [x] 7. `DashboardPanel.test.tsx` / `WorkspaceCanvas.test.tsx`: added a direct-session dashboard
      bucketing test and a picker cross-context test (asserts the tile lands with the right
      sessionId and no worktreeId).

## Verification

- `npx tsc -b --noEmit`, `npm run build`, `npx vitest run` (web-ui) — all clean, 406/406 tests
  (404 baseline + 2 new).
- Live: dev sandbox (vs-48) — created a real direct session via `POST /sessions`, confirmed it
  shows on the dashboard under "Working" linking to `/session/:id`, confirmed the session page
  itself renders correctly, then saved a worktree's canvas as a workspace and confirmed "Doc audit
  agent" appears under a "Direct" subheading in the Add-tile picker and tiles in correctly labeled
  "northstar-api > Doc audit agent".

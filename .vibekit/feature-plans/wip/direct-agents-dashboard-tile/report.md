# /sdlc report — direct-agents-dashboard-tile

**Scope:** small feature bundle, no PRD — investigation confirmed both parts are purely additive,
no architecture changes needed.

## What was implemented

1. **Dashboard visibility** (`DashboardPanel.tsx`) — direct (worktree-less) agent sessions now
   bucket into the same Working/Waiting for User/PR created/Finished sections as worktrees. Added
   a `DashboardItem` union (`{kind:"worktree"}` | `{kind:"direct"}`) so the existing bucket arrays
   and render function could hold both kinds without duplicating the list/kanban layout code. A
   direct session's card links to `/session/:id` (the route and its URL-driven context derivation
   already existed — no routing change), shows `sessionLabel(s)`, a `"direct"` secondary tag
   (mirrors the sidebar's own badge), and the owning project's name. No dismiss button (that's a
   worktree-only, less-destructive "untrack but keep files" action; deleting a direct session
   outright is a different, more destructive operation, out of scope for a visibility fix).
2. **Add-tile picker** (`WorkspaceCanvas.tsx`) — the cross-context picker (saved workspaces only,
   by existing design) now lists each project's direct sessions under their own "Direct"
   subheading, alongside the existing per-worktree session groups. Confirmed via investigation
   that `TileSpec.worktreeId` staying `undefined` for a direct-session tile is already handled
   correctly by existing code — `paneKeyForTile` never reads it for agent/terminal tiles, and the
   tile label logic already branches on `session.worktreeId` (not `tile.worktreeId`), so a direct
   session's tile renders as `"Project > SessionLabel"` with zero other changes required.

## Explicit scope decisions

- No PR-poller changes — `prPoller.ts` only polls worktrees, so a direct session's `needs_review`
  bucket is unreachable in practice today; left wired for forward-compatibility, not worth
  expanding poller scope for this fix.
- Cross-context tile addition stays saved-workspace-only, matching the picker's existing
  architecture (the transient per-worktree scratch canvas's `PaneHostLayer` scope is deliberately
  limited to that one worktree — not touched).

## Verification

- `npx tsc -b --noEmit`, `npm run build`, `npx vitest run` — all clean. **406/406 tests** (404
  baseline + 2 new: a dashboard-bucketing test for a direct session, and a picker test asserting
  the tile lands with the correct `sessionId` and no `worktreeId`).
- `npm run lint` — 0 errors (2 pre-existing unrelated warnings on `main`, one of which — an unused
  `tileMenuLabel` in `WorkspaceCanvas.tsx` — is already fixed on the still-open PR #58).
- **Live-verified end to end** against the running `vs-48` dev sandbox: created a real direct
  session via `POST /sessions`, confirmed it appears on the dashboard under "Working" and links to
  a working `/session/:id` page; saved a worktree's canvas as a workspace and confirmed the direct
  session appears under a "Direct" subheading in the Add-tile picker, and that clicking it adds a
  correctly-labeled tile ("northstar-api > Doc audit agent") to the canvas.

## Diff / PR

Branched fresh off `main` (not off the two other still-open PRs, to keep this independent).
4 files changed (2 source, 2 test) + plan/report. Not yet committed — awaiting confirmation.

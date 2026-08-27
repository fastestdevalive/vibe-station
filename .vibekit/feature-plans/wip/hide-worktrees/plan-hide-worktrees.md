# Plan: hide-worktrees

## Requirements
- Quickly hide a worktree from the left side panel (per-worktree action, e.g. context menu item).
- Hidden state is DB-driven on the daemon — syncs across all UI instances (browser tabs, devices), not localStorage.
- Hiding a pinned worktree also removes it from the pinned list.
- A per-project UI surface lists all hidden worktrees, with an "unhide" action.
- Scope: worktrees only. Direct agent sessions are untouched.

## Approach
Mirror the existing `pinnedAt` pattern (`daemon/src/types.ts` `WorktreeRecord.pinnedAt`,
`routes/worktrees.ts` `PATCH /worktrees/:id/pin`) with a new `hiddenAt?: string` field on
`WorktreeRecord`. Same shape: absent ≡ visible, ISO timestamp ≡ hidden (also usable as
"hidden since" sort key in the hidden-list UI). This keeps the change additive and
consistent with how pin already works end-to-end (schema → migration → row mapper →
route → WS broadcast → client → store → UI).

## Checklist

### Daemon
- [x] 1.1 Add `hiddenAt?: string` to `WorktreeRecord` in `daemon/src/types.ts` (doc comment mirroring `pinnedAt`)
- [x] 1.2 Add `hiddenAt TEXT` column to the worktrees table in `daemon/src/services/dbSchema.ts` + `addColumnIfMissing` backfill for existing DBs (no separate `dbMigration.ts` needed — that file only handles the legacy-manifest→sqlite import, not column migrations)
- [x] 1.3 Wire `hiddenAt` through `daemon/src/state/sqliteRowMappers.ts` (row ↔ record) and the `INSERT INTO worktrees` column list in `project-store.ts`
- [x] 1.4 Add `PATCH /worktrees/:id/hide` route in `daemon/src/routes/worktrees.ts`, body `{ hidden: boolean }` — idempotent, clears `pinnedAt` when hiding, leaves it cleared on unhide, broadcasts `worktree:updated`
- [x] 1.5 `daemon/src/ws/protocol.ts`'s `worktree:updated` payload is `z.record(z.string(), z.unknown())` (untyped passthrough) — no schema change needed; `serializeWorktree` already emits `hiddenAt`

### Web UI — data layer
- [x] 2.1 Add `hiddenAt: string | null` to `Worktree` type in `web-ui/src/api/types.ts`
- [x] 2.2 Add `hideWorktree(id)` / `unhideWorktree(id)` to `web-ui/src/api/client.ts` (mirror `pinWorktree`/`unpinWorktree`)
- [x] 2.3 `useServerSync.ts`'s `applyWorktreeUpdated` does a full-object replace already — no per-field wiring needed, `hiddenAt` flows through automatically
- [x] 2.4 Updated `web-ui/src/api/mock.ts` fixtures (5 literals) + added `hideWorktree`/`unhideWorktree` mock handlers; also patched `hiddenAt` into 4 test-file `Worktree` literals that the type change made non-optional

### Web UI — sidebar filtering + hide action
- [x] 3.1 `worktreeMap` (feeds the normal per-project list) now excludes `hiddenAt != null`; `pinnedWorktrees` filter got `w.hiddenAt == null` added too (defense-in-depth, hide already clears pin server-side)
- [x] 3.2 Added a "Hide" item to the existing per-worktree overflow menu (`wtMenu`), right after Pin/Unpin
- [x] 3.3 No optimistic update — matches the existing Pin/Hide-project pattern in this codebase (`// Store stays current via the worktree:updated WS event`), not a gap specific to this feature

### Web UI — hidden worktrees surface (per project)
- [x] 4.1 Added a "Hidden worktrees (N)" item to the existing per-project overflow menu (`projMenu`), shown only when that project has ≥1 hidden worktree
- [x] 4.2 New `HiddenWorktreesDialog.tsx` (mirrors `ConfirmDialog`/`Dialog` usage) lists the project's hidden worktrees with an "Unhide" button per row
- [x] 4.3 Unhide calls `unhideWorktree`; store update (WS `worktree:updated`) removes it from the hidden list and restores it to the normal sidebar list

### Bug fix — worktree overflow menu needs two clicks
Reported: the `⋯` trigger on a worktree row (`wt-menu-trigger`) doesn't open `wtMenu` on the
first click right after hovering onto the row; only the second click works. This is the same
trigger the new "Hide" item (3.2) is being added to, so fix it in this pass rather than
shipping a new menu item onto a known-flaky trigger.

Likely cause: `.tree-row--worktree .wt-menu-trigger` (`web-ui/src/styles/workspace.css:722-730`)
sits at `opacity: 0; pointer-events: none` at rest and only flips to
`opacity: 1; pointer-events: auto` via `.tree-row--worktree:hover .wt-menu-trigger`
(`workspace.css:748-752`). If the row's hover state and the pointer-events flip aren't both
settled by the time the click's hit-test runs (e.g. opacity is animated on the compositor
while pointer-events hit-testing lags a frame behind on the main thread), the first click's
mousedown can still hit-test as "not interactive" and fall through to whatever is beneath
(the row's stretch link / drag surface), and only the *second* click — now fully in the
settled hover state — lands on the button.

- [x] 0.1 Not reproduced live in a browser (no interactive browser session in this pass) — but the codebase already documents the identical symptom for touch: the `@media (hover: none)` block's comment says verbatim "the first tap only landed on the row underneath ... only the SECOND tap actually hit the button", which is this same bug for the case where there's no `:hover` at all. That block only patched touch; mouse users doing a fluid hover-then-click gesture hit the same pointer-events/hover race.
- [x] 0.2 Root cause confirmed: `pointer-events: none → auto` was gated on the same `:hover`/`:focus-within` match the click needs to land inside, so a click that arrives as part of the same continuous gesture that triggers the hover isn't guaranteed to see the "auto" state in time
- [x] 0.3 Fix applied: `pointer-events` is now unconditionally `auto` on `.wt-menu-trigger` at rest; only `opacity` (a purely visual property, no hit-testing implication) is still gated on hover/focus. This is the same trade-off the codebase already made for touch, just applied universally instead of behind `@media (hover: none)`.
- [x] 0.4 Checked all `.wt-menu-trigger` rule sites: plain worktree rows (`workspace.css:722-762`) and pinned rows, both worktree and direct-session (`workspace.css:1063-1072`) — both fixed the same way. The plain (non-pinned) direct-session row's trigger was never gated by a hover-reveal rule in the first place (no matching CSS selector targets it), so it was never affected.
- [ ] 0.5 Manual re-test not performed live — needs a quick check in the running dev server (hover onto a worktree row and click the ⋯ trigger as one fluid motion) before merging

### Tests
- [x] 5.1 Daemon: `PATCH /worktrees/:id/hide` route tests — set/clear/idempotent/404/400/TOCTOU/list-shape, plus hide-clears-pin and unhide-does-not-restore-pin (mirrors the existing pin coverage 1:1, `worktrees.test.ts`)
- [x] 5.2 Daemon: `sqliteRowMappers.test.ts` round-trip + omit-when-null tests for `hiddenAt`; also extended `dbSchema.test.ts` with fresh-DB and legacy-DB-backfill coverage for the new column (mirroring the existing `branchIsPlaceholder` column tests)
- [x] 5.3 Web UI: sidebar tests — Hide action removes the row from the normal list, hiding a pinned worktree also removes it from the pinned section
- [x] 5.4 Web UI: hidden-list UI test — project menu shows "Hidden worktrees (N)" only once a worktree is hidden, dialog lists it, Unhide empties the dialog and restores the worktree to the sidebar

All added/touched tests pass: 77 daemon tests (worktrees/sqliteRowMappers/dbSchema), 568/568
web-ui tests, 804/804 cli/daemon tests overall. `pnpm typecheck` clean on both packages.

## Review (Opus)
Reviewed the full diff independently. No must-fix issues — hide-implies-unpin logic, client-side
filtering (including the racy "hidden AND pinned" state, which is benign), the CSS fix, type
fallout across all `Worktree` literals, and the dialog's a11y basics all checked out. The CSS fix
was independently re-derived and confirmed, plus the reviewer found a second mechanism it also
fixes: the trigger's `onPointerDown` stopPropagation (which keeps dnd-kit's drag listeners on the
row from claiming the gesture) never ran while `pointer-events: none`, so the first pointerdown
fell through to the drag surface — unconditional `pointer-events: auto` closes both paths.

Nice-to-haves applied:
- `HiddenWorktreesDialog`'s Unhide button now wraps the API call in try/catch (matches the Hide
  action's error-handling pattern instead of a bare `void`).
- Hidden-worktree list now sorts newest-hidden-first (by `hiddenAt` desc) instead of store order.
- Each Unhide button gets a disambiguating `aria-label`.
- Hoisted the duplicated `hiddenWorktreeMap[...]?.length` lookup in the project menu to one `const`.

Flagged but explicitly left out of scope: hidden worktrees still appear on the Dashboard (which
has no `hiddenAt` filter, unlike hidden *projects*, which are filtered from both the sidebar and
the dashboard). Noted as a deliberate scope call for this pass, not fixed here — worth a follow-up
if it reads as inconsistent in practice.

Still open: 0.5 (manual browser re-test of the CSS fix) was not performed live in this pass.

## Out of scope
- Hiding/filtering direct agent sessions.
- Bulk hide/unhide actions.
- Auto-expiring or auto-unhiding worktrees.
- Filtering hidden worktrees from the Dashboard (flagged above, not implemented this pass).

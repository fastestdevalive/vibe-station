# /sdlc report — sidebar-canvas-shortcuts

**Scope:** small bug-bundle + small-feature. Plan → implement, no PRD (low ambiguity). Grew across
three rounds: initial implementation, an Opus subagent review pass with fixes, then two rounds of
direct user feedback (shortcut rework + a canvas-tile actions menu) — all folded into one commit.
**Plan:** `plan-sidebar-canvas-shortcuts.md` (checklist fully `[x]`, including the follow-up round).

## What was implemented

1. **Pinned-item ⋯ menu, vertical alignment** (`workspace.css`) — the hardcoded `top: 4px` override
   read as visibly off-center against the two-line pinned row (confirmed with Playwright
   screenshots against a live dev sandbox). Removed the override entirely — it now inherits the
   same `top:50%; translateY(-50%)` centering every other `.wt-menu-trigger` uses.
2. **Pinned-item ⋯ menu, two taps to open** (`workspace.css`) — root cause: `.wt-menu-trigger` is
   `opacity:0; pointer-events:none` until `:hover`/`:focus-within`, and touch has no hover — the
   first tap only synthesized the row's hover state, the second tap actually hit the button. Added
   `@media (hover: none)` forcing it always visible/interactive; also hides the id chip the same
   way `:hover` already does, so the two don't render on top of each other on touch.
3. **Canvas "Add tile" picker not closing on outside tap** (`WorkspaceCanvas.tsx`) — added the same
   deferred `document`-click + Escape effect the sidebar's kebab menus already use.
4. **"New agent" entry in the canvas picker** (`WorkspaceCanvas.tsx`, `NewTabDialog.tsx`) — opens
   the exact same `NewTabDialog` the tab bar's "+" uses (own-worktree canvases only) and
   auto-places the created session as a tile; closes the picker when opened.
5. **Keyboard shortcuts, reworked twice**: `Alt+N` → new agent in current worktree (no-op in canvas
   mode, where the picker's own "New agent" already covers it — avoids creating an orphaned,
   unplaced session); `Alt+Shift+N` → new worktree in current project. Bare Alt combos per user
   preference, not `Ctrl+N`/`Ctrl+Shift+N` (OS/browser-chrome-reserved, can't be
   `preventDefault()`-ed) — matched on `e.code` so Option+N's Mac dead-key behavior doesn't break it.
6. **Agent tile "⋯" menu in canvas/workspace mode** (`WorkspaceCanvas.tsx`,
   `workspace-canvas.css`) — a kebab button left of each agent tile's close button, opening the
   same actions as the agent tab bar's right-click menu (Reset, Reset with handoff), plus a
   Terminate action equivalent to the tab bar's "×" close (`ConfirmDialog` → `deleteSession`, and
   also removes the tile from canvas). Agent tiles only — terminal/tools tiles unaffected.

## Review + fixes (Opus subagent pass on the first round)

7 findings, all fixed: Alt+N wouldn't fire on Mac (dead key) → matched on `e.code`; forcing the
trigger visible on touch would overlap the id chip → hid the chip too; the new-agent shortcut
could create an invisible session in canvas mode → suppressed there; shortcut-dialog open state
could survive a worktree switch → reset on `activeWorktreeId` change; the keydown listener churned
every render → stabilized callbacks with `useCallback`; the picker stayed open behind the new
"New agent" dialog → now closes it; a CSS comment's stated rationale was wrong → caught while
fixing it, which led to re-deriving the alignment fix from a live screenshot instead (see #1 above).

## Verification

- `npx tsc -b --noEmit` — clean, twice (post-review and post-follow-up).
- `npm run build` (vite) — clean, twice.
- `npx vitest run` — **404/404 tests pass** (60 files), unchanged across all rounds.
- `npm run lint` — could not run; root `eslint.config.mjs` needs root-level deps (`@eslint/js`) not
  installed in this environment. Pre-existing environment gap, unrelated to this diff.
- **Visually verified against a live dev sandbox** (`scripts/dev-sandbox.sh up vs-48`, hot-reloading
  this worktree) with Playwright screenshots: pinned-row kebab centering (before/after), the canvas
  tile "⋯" menu opening with the three expected items, the Terminate confirm dialog matching the
  tab bar's copy, `Alt+Shift+N` opening the New Session dialog, and `Alt+N` correctly no-op'ing in
  canvas mode.
- Not verified: real touch-device tap behavior (no touch hardware in this environment) — the fix is
  code-reasoned from the CSS cascade, not physically tapped.

## Diff / PR

Single commit, amended across all rounds per request. Pushed to `dialog-canvas-shortcut`, PR
[#56](https://github.com/fastestdevalive/vibe-station/pull/56) (opened under the `fastestdevalive`
account, per this repo's collaborator requirement).

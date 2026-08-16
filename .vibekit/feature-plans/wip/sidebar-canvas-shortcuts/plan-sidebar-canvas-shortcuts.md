# Plan: sidebar-canvas-shortcuts

Small bug-fix + small-feature bundle. No PRD (four self-contained, low-ambiguity changes).

## Scope

1. Pinned-item kebab (⋯) menu: vertical alignment + two-tap-to-open on touch.
2. Canvas "Add tile" picker doesn't close on outside click.
3. Canvas "Add tile" picker (own-worktree canvas only) gains a "New agent" entry that opens the same dialog as the tab bar's "+".
4. Two new global shortcuts: new worktree in current project, new agent in current worktree.

## Root causes (found during exploration)

1. `web-ui/src/styles/workspace.css`:
   - `.tree-row--worktree .wt-menu-trigger` (and the pinned/direct-session variants) are `opacity:0; pointer-events:none` until `:hover`/`:focus-within`. Touch devices have no hover — the first tap only synthesizes the row's hover state (making the button hit-testable); the second tap actually clicks it. Fix: `@media (hover: none)` override forcing the trigger always visible/interactive.
   - `.pinned-row .wt-menu-trigger { top: 4px }` is an arbitrary offset that doesn't match `.pinned-row__leading`'s `padding-top: 5px` (the value chosen to align with the first text line). Fix: match it, `top: 5px`.
2. `web-ui/src/components/layout/WorkspaceCanvas.tsx`: `pickerOpen` has no outside-click/Escape handler at all (unlike the sidebar's kebab menus, which use a deferred-`useEffect` + `document` click pattern). Fix: add the same pattern, scoped via `data-workspace-canvas-picker-trigger` / `data-workspace-canvas-picker-panel`.
3. Same file: the picker only lists *existing* agent/terminal sessions (`addTile`), there's no "create a new agent" entry. `NewTabDialog` (`web-ui/src/components/dialogs/NewTabDialog.tsx`) is the dialog the tab bar's "+" already uses for this, for the same worktree. Fix: render it from `WorkspaceCanvas` too, gated to the non-detached (own-worktree) canvas, and auto-add the created session as a tile — this needs `NewTabDialog`'s `onCreated` to hand back the new session id (currently `() => void`), a small optional-arg widen.
4. `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts` is the one global `keydown` hook; `web-ui/src/routes/Workspace.tsx` is where "current project"/"current worktree" are already resolved and where `NewSessionDialog`/`NewTabDialog` can be rendered directly (both are plain controlled dialogs, no ambient state needed). `Ctrl/Cmd+N` and `Ctrl/Cmd+Shift+N` are OS/browser-reserved (new window / new incognito window) and cannot be `preventDefault()`-ed from a web page — using them would silently fail. Use `Ctrl/Cmd+Alt+N` (new worktree) and `Ctrl/Cmd+Shift+A` (new agent) instead, mnemonic and unreserved.

## Checklist

- [x] 1a. `workspace.css`: add `@media (hover: none)` override making `.tree-row--worktree .wt-menu-trigger` / `.tree-row--direct-session.pinned-row .wt-menu-trigger` always `opacity:1; pointer-events:auto`.
- [x] 1b. `workspace.css`: `.pinned-row .wt-menu-trigger { top: 4px }` → `top: 5px` (match `.pinned-row__leading`).
- [x] 2. `WorkspaceCanvas.tsx`: add deferred outside-click + Escape close effect for `pickerOpen`, mirroring `LeftSidebar.tsx`'s pattern; add matching `data-workspace-canvas-picker-trigger` / `data-workspace-canvas-picker-panel` attributes.
- [x] 3a. `NewTabDialog.tsx`: widen `onCreated?: () => void` → `onCreated?: (sessionId: string) => void`, pass `sess.id` at both call sites inside `submit()`.
- [x] 3b. `WorkspaceCanvas.tsx`: import `NewTabDialog`, add `newAgentOpen` state, render a "New agent" picker entry (own-worktree canvas only, i.e. `!isDetachedView`) above the existing agent list, and render `<NewTabDialog>` with `onCreated={(id) => { addTile("agent", id); setNewAgentOpen(false); }}`. Adjust `pickerEmpty` so the "everything's on the canvas" message doesn't show when New Agent is available.
- [x] 4a. `NewTabDialog.tsx` call site check / `TabsStrip.tsx`: no change needed (extra callback arg is backward compatible).
- [x] 4b. `Workspace.tsx`: resolve current project + worktree (reuse the existing `worktrees.find`/`projects.find` pattern at lines ~74-77), add local state for a worktree-scoped `NewSessionDialog` and worktree-scoped `NewTabDialog`, pass two new callbacks into `useWorkspaceKeyboardShortcuts`.
- [x] 4c. `useWorkspaceKeyboardShortcuts.ts`: accept the two new callbacks, add `Ctrl/Cmd+Alt+N` → new worktree, `Ctrl/Cmd+Shift+A` → new agent, guarded by the existing `inEditable` check and only when a project/worktree is actually active.

## Verification

- `npx tsc --noEmit` (or the project's existing typecheck script) in `web-ui/`.
- `npm run build` in `web-ui/` (or equivalent) to catch JSX/type errors the above doesn't.
- Manual code-reading pass over the diff for the two CSS fixes (no live device available in this environment) — call this out explicitly as unverified-in-browser in the report.

## Follow-up round (post-review, post-PR)

Opus subagent review of the above surfaced 7 real issues (Alt+N dead-key on Mac, id-chip/trigger
overlap on touch, invisible-session edge case for the agent shortcut in canvas mode, stale dialog
state across worktree switches, keydown-listener churn, picker not closing under the new "New
agent" item, and an inaccurate code comment) — all fixed, then verified against the live dev
sandbox with Playwright screenshots (the pinned-row centering fix in particular needed a second
pass: the first attempt was still visibly off-center).

Then two more rounds of user feedback, folded into the same commit (single-commit PR):

- [x] 5. Shortcut rework: `Alt+N` (bare, no ⌘/Ctrl) → new agent in current worktree; `Alt+Shift+N`
      → new worktree in current project. Replaces the earlier `Ctrl/Cmd+Alt+N` / `Ctrl/Cmd+Shift+A`
      pair per user preference. `useWorkspaceKeyboardShortcuts.ts`: moved the Alt+N handling above
      the `mod` (⌘/Ctrl) gate so it fires independent of it; kept `e.code === "KeyN"` for the
      Mac-dead-key fix.
- [x] 6. Agent tile "⋯" popup menu in canvas/workspace mode (`WorkspaceCanvas.tsx`,
      `workspace-canvas.css`): a kebab button left of each agent tile's existing close ("remove
      from canvas") button, opening a `menu-pop` (same component class TabsStrip's right-click
      menu uses) with Reset / Reset with handoff / Terminate. Terminate mirrors the tab bar's "×"
      close (`ConfirmDialog` → `api.deleteSession`) and additionally removes the tile from this
      canvas (the tab bar has no canvas to reconcile against). Gated to `tile.kind === "agent"`
      tiles only — terminal/tools tiles unaffected.

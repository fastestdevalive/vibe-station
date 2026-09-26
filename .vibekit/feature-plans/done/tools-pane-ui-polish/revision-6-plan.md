# Revision 6 plan — fix collapse/resize animation firing on worktree switch (properly, this time)

Two prior attempts at this (in this same session, both reverted — see the "Known open issue" paragraph at the bottom of the current UI commit's message for the exact revert) got the architecture wrong in the same way. Read that commit message's last paragraph before starting. This plan exists so a fresh pass doesn't repeat the mistake.

## The bug

Three CSS transitions animate a layout change that should only animate when the user *explicitly* toggles something, but currently also animate on a plain worktree switch:

1. `web-ui/src/components/layout/Layout.tsx` — the tools-pane `PanelGroup` (`data-animate-collapse`, ~line 287) and the terminal-dock `PanelGroup` (~line 347) both have a static `data-animate-collapse` attribute, which the CSS (`workspace.css` `[data-panel-group][data-animate-collapse] [data-panel] { transition: flex-grow ... }`) uses to animate `flex-grow` changes.
2. `web-ui/src/components/tools/FilesPanel.tsx` — `.files-panel__content`'s `paddingLeft`/`paddingTop` (~line 422) has an unconditional `transition: ... 0.15s ease` (only turned off during live drag via `isDragging`).

Reported symptom (confirmed by the user, twice, across two different fix attempts): switching from a worktree with horizontal split to one with vertical split animates the transition; switching from a worktree with the tools pane hidden to one with it shown animates too. Both should snap instantly — a worktree switch is not a toggle.

## Why the two prior attempts failed

Both attempts tried to infer "was this a real toggle" from a `useEffect` watching the *derived* values that change on toggle (`toolsInSplit`/`effectiveOrientation` in Layout.tsx; `isPanelOpen`/`masterDetailVertical` in FilesPanel.tsx), setting a transient "just toggled, animate" flag whenever those values changed, then clearing it after ~200ms. The flaw: **a worktree switch can also change those exact same derived values** — `toolSplitOrientation`/tool-panel-visibility and `masterDetailVertical`/`fileTreeVisible`-equivalent state are per-worktree (or otherwise vary across worktrees), so switching to a worktree with a different persisted orientation or visibility flips the same booleans the effect was watching, and the effect can't tell that apart from a real click. (The first attempt added a `wt`-changed guard in `FilesPanel.tsx` only, which happened to mask the symptom for the *specific* repro tested at the time — dragging one worktree's panel width and switching to another with the *same* width/orientation but observing no animation — but did not actually fix the general case, and the `Layout.tsx` half of the fix never got the same guard at all.)

**Watching "which values changed" is the wrong signal in general, because a worktree switch and a real toggle can produce the exact same value transitions.** The correct signal is "did a real toggle action just execute" — i.e. drive the animate-flag from the *cause* (the toggle action itself firing), not the *effect* (a derived value changing), so that a worktree switch — which never calls the toggle actions — can never set it, regardless of what values happen to change as a side effect of switching.

## Recommended approach (not mandatory — use your judgment, but this is the shape that avoids the above trap)

Set the "animate this transition" flag **inside the actual toggle action**, not in a `useEffect` reacting to its downstream state. Concretely:

- The relevant toggle actions all live in the zustand store (`web-ui/src/hooks/useStore.ts`): `toggleToolPanel`, `toggleTerminalDock`, `toggleFileTree`, `setFilesLeftPaneMode` (rail mode clicks), `setMasterDetailVertical` (orientation toggle). Every call site that should animate — the top-bar pane-visibility button, `Ctrl+\`/`Ctrl+Shift+Z` keyboard shortcuts, the rail's mode icons, the relocated orientation toggle button — already goes through one of these actions. None of them fire on a worktree switch (switching worktree only changes `activeWorktreeId`/context, never calls these actions).
- Add a short-lived signal to the store (e.g. a `uiTransitionHint: string | null` field, or a monotonically-incrementing `toggleNonce` + `lastToggledKind`) that these specific actions set when they run, and have it auto-clear after the transition's duration (~200ms) — either via a `setTimeout` inside the action itself, or by having the *consuming* component clear it after it observes and applies it once.
- `Layout.tsx` and `FilesPanel.tsx` read that signal (not the derived boolean) to decide whether to apply the transition/attribute for the *current* render, then let it lapse. A worktree switch never sets the signal, so it can never animate, no matter what else changes as a result.
- This does mean editing `useStore.ts`, not just the two consuming components — that's expected; the previous two attempts tried to solve this purely at the consumer level and that's exactly the part that doesn't work.

If you find a cleaner mechanism that satisfies the same constraint (transition only fires when a real toggle action executed, never as a side effect of a worktree switch touching the same derived values) — use it. The constraint is the point, not the specific implementation above.

## Verification (must actually reproduce the originally-reported scenarios, not just the narrower case the last attempt tested)

In the sandbox (`http://localhost:7182`):
1. Set up two worktrees with *different* persisted `toolSplitOrientation` (one horizontal, one vertical). Switch between them — confirm NO animation (instant snap) on the tools/agent split.
2. Set up two worktrees with different persisted tool-panel visibility (one hidden, one shown). Switch between them — confirm NO animation.
3. Set up two worktrees with different persisted Files side-panel width/height/orientation (`masterDetailVertical`). Switch between them — confirm NO animation on `.files-panel__content`'s padding.
4. On a SINGLE worktree, explicitly click the top-bar pane-visibility toggle, the terminal-dock keyboard shortcut, a rail mode icon (open/close), and the relocated split-orientation button — confirm EACH of these still animates (0.15s), since those are real explicit toggles and must keep working.
5. Add test coverage for at least one of the four toggle actions asserting the transition/attribute is present immediately after the action and absent after a worktree-id-only change with no toggle action involved — the previous two attempts shipped with zero test coverage for this exact regression, twice.

Fold this into the same PR — squash into the existing UI commit (see `git log --oneline` on `ui-polish-tools-pane` for the current 2-commit shape: one `docs:` commit, one `feat(web-ui):` commit) rather than adding a third commit; the docs commit should get this plan moved into `.vibekit/feature-plans/done/tools-pane-ui-polish/` alongside the others once this is fixed and verified.

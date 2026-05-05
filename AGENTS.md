# Agent / Coding Guidelines

Accumulated lessons from bugs that were painful to diagnose. Read before touching the listed areas.

---

## Terminal — never unmount TerminalPane during UI transitions

**File:** `apps/web/src/components/layout/Layout.tsx`

### The invariant

`TerminalPane` must stay at the **same React tree position** for the entire lifetime of a worktree session. Any React tree-position change (different parent path, different branch of a conditional) causes an unmount + remount, which:

1. Sends `session:close` to the daemon → kills the current PTY stream.
2. Mounts fresh → sends `session:open` → daemon creates a **new** stream.
3. The old stream is not always cleaned up synchronously; it can linger and keep emitting output.
4. Result: one extra ghost stream per remount. Input echoes N+1 times after N remounts.

This was the root cause of the "double input after fullscreen toggle" bug.

### How fullscreen is implemented (correct approach)

The terminal is **always rendered in its panel slot**. Fullscreen is achieved by swapping the wrapper div's CSS class — `position: fixed; inset: 0; z-index: 200` (`.pane-viewport-fullscreen`) escapes the Panel's `overflow: hidden` and covers the viewport without moving the terminal in the React tree.

```tsx
// terminalWrapper() — stable tree position, only CSS changes
<div className={terminalFullscreen ? "pane-viewport-fullscreen" : undefined}
     style={terminalFullscreen ? undefined : { flex: 1, height: "100%", ... }}>
  {wrapTerminal(ideTerminalPane, terminalFullscreen ? "viewport" : "panel")}
</div>
```

The terminal is **never** rendered in `fullscreenOverlay`. Only the preview pane uses the overlay pattern (preview has no daemon-side streaming so remounting it is safe).

### What to watch for

- **Conditional tree branches:** if terminal appears in two different `if/else` arms at different depths, React will remount it on the branch switch. Use a single render site with prop/style changes instead.
- **Portal traps:** `createPortal` changes the DOM location but NOT the React tree position — this is safe. But rendering the same `ideTerminalPane` element from two different call sites is not.
- **`terminalInSplit` flag:** this is `vTerm` (terminal pane visible), not `vTerm && paneFullscreen !== "terminal"`. The fullscreen state must never suppress the terminal from rendering in its panel slot.
- **`key` prop changes:** changing the `key` on a container that wraps `TerminalPane` forces an unmount. Never derive `key` from `paneFullscreen`.

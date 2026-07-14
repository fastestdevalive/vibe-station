# Agent / Coding Guidelines

Accumulated lessons from bugs that were painful to diagnose. Read before touching the listed areas.

---

## Terminal — never unmount TerminalPane during UI transitions

**File:** `web-ui/src/components/layout/Layout.tsx`

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

---

## Agent plugin — all CLI-specific logic lives in the plugin, nowhere else

**Files:** `daemon/src/agent-plugins/` · Interface: `daemon/src/services/spawn.ts`

### The invariant

Every behaviour that differs between `claude`, `cursor`, and `opencode` **must be implemented as a method on `AgentPlugin`**, not as an `if/else` or `switch` on `CliId` anywhere in calling code. The plugin is the single extension point for CLI-specific logic.

Calling code resolves the plugin once via `resolvePlugin(cli)` and then calls interface methods. It must never inspect the CLI name again after that point.

```ts
// ✅ correct — resolves once, calls interface
const plugin = resolvePlugin(mode.cli);
const { models } = await plugin.listModels();
const argv = await plugin.getRestoreCommand({ session, project, worktree, model });

// ❌ wrong — CLI-specific knowledge leaking into calling code
if (mode.cli === "claude") { ... }
else if (mode.cli === "opencode") { ... }
```

### Adding new CLI-specific behaviour

1. Add the method to `AgentPlugin` in `spawn.ts` with a JSDoc that explains the contract.
2. Implement it in all three plugins: `claude.ts`, `cursor.ts`, `opencode.ts`.
3. Call `resolvePlugin(cli).yourNewMethod()` from wherever the feature is needed.
4. Never add a new `if (cli === ...)` branch outside of the plugin files.

### Current plugin methods

| Method | Required | Purpose |
|--------|----------|---------|
| `listModels()` | yes | Return available models for this CLI |
| `getLaunchCommand(cfg)` | yes | Build spawn argv |
| `getEnvironment(cfg)` | yes | Extra env vars for the process |
| `getReadySignal()` | yes | Sentinel string or fallback timeout |
| `composeLaunchPrompt(...)` | yes | Build the shell line / post-launch input |
| `setupWorkspaceHooks?(path)` | optional | Write hook scripts into the worktree |
| `provideChatId?(args)` | optional | Pre-spawn: mint a chat ID (cursor) |
| `captureChatId?(args)` | optional | Post-ready: read chat ID from token file |
| `getRestoreCommand?(args)` | optional | Return resume argv, or null for fresh spawn |

### What to watch for

- **New CLI support:** if a fourth CLI is ever added, implement *all* required methods and the optional ones that make sense. The TypeScript interface will enforce required methods at compile time.
- **`resolvePlugin` in routes vs. services:** `resolvePlugin` is in `daemon/src/agent-plugins/registry.ts`. Routes are allowed to import it. Services (`daemon/src/services/spawn.ts`) receive the already-resolved plugin as an argument — they never import `resolvePlugin` themselves.
- **`CliId` type:** defined in `daemon/src/types.ts`. Adding a new CLI means adding it to `CliId`, adding a plugin file, registering it in `registry.ts`, and updating Zod schemas in `modes.ts`.

---

## WebSocket — serialize session:open / session:close per (connection, sessionId)

**Files:** `daemon/src/ws/connection.ts` · `daemon/src/ws/handlers/sessionOpen.ts` · `daemon/src/ws/handlers/sessionClose.ts`

### The invariant

`session:open` and `session:close` for the **same `(connection, sessionId)` pair** MUST be serialized. The `socket.on("message", async …)` dispatcher does NOT serialize concurrent handlers — it awaits each handler independently, so a close immediately followed by an open run interleaved.

A terminal remount fires `session:close` then `session:open` back-to-back. Without serialization both handlers park at their respective `await stream.detach` / `await stream.attach` calls concurrently. Both `open` calls can get past the stale-stream check before either registers its new stream, so both spawn a `tmux attach-session` client. Only the last is registered in `openStreams`; the orphaned client keeps forwarding tmux pane output to `conn.send` → browser receives duplicate ("double") echo.

### The mechanism: `WSConnection.withSessionLock`

`connection.ts` holds a per-session promise-chain lock (`sessionLocks: Map<string, Promise<void>>`). Wrap every `session:open` and `session:close` handler body with it:

```ts
export function handleSessionOpen(conn, msg): Promise<void> {
  return conn.withSessionLock(msg.sessionId, () => openSessionLocked(conn, msg));
}
// same shape for handleSessionClose
```

Keep the **entire** handler body — including the `await stream.attach` park point — inside the `fn` passed to `withSessionLock`. Moving the attach outside defeats the purpose.

The lock is scoped to one `WSConnection`. Two browser tabs legitimately hold two tmux clients (one per connection), so never serialize across connections.

### What to watch for

- **New open/close-like handlers:** any handler that calls `stream.attach()` or `stream.detach()` must be wrapped with `conn.withSessionLock`.
- **Don't move attach outside the lock:** the race occurs precisely because `attach` is an async park point. Splitting into "register then attach" outside the lock recreates the bug.
- **Symptom if violated:** `tmux list-clients -t <session>` shows >1 client for a single browser → duplicated ("double") echo that a page refresh temporarily clears.
- **Invariant:** for any `(conn, sessionId)`, at most one `TmuxOutputStream` should be live (i.e., have a non-killed PTY) at any moment. The stale-stream teardown in `sessionOpen.ts` reinforces this but only works reliably once the lock prevents interleaving across the attach await.

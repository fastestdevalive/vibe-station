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

---

## UI terminology — "Rich Chat" in the UI, `"json"` in the code

**The split is deliberate, not inconsistent.** The structured, per-turn chat channel (as opposed to a raw terminal) is:

- **In the UI:** always labeled **"Rich Chat"** (button labels, dialog titles/copy, tooltips, hint text). Where a qualifier is useful for a technical reader, add `(json based)` — e.g. `"Switch to Rich Chat"` / `"Rich Chat (json based)"` — see `web-ui/src/components/chat/ChannelToggleButton.tsx`'s `COPY` table and `web-ui/src/components/layout/TabsStrip.tsx`'s tab tooltip for the established pattern.
- **In the code:** always `"json"` — the `Channel` enum value (`daemon/src/types.ts`, `daemon/src/ws/protocol.ts`, `web-ui/src/api/types.ts`), file/identifier names (`jsonAgent.ts`, `JsonAgentSession`, `jsonAgentChat.ts`, `jsonAgentRegistry.ts`, `jsonAgentStream.ts`, `resolveJsonAgent`, etc.), route paths, WS event names, and every comment/doc describing the mechanism. `"json"` is the more literal, technically accurate name (the channel's defining trait is that the CLI is driven via structured JSON output) and renaming the code layer to chase the UI label would touch persisted session records (`channel: "json"` already exists in on-disk manifests) for no real benefit.

### What to watch for

- **Do not rename the code to `"rich-chat"` / `RichChat*`** to "match" the UI — this was considered and explicitly rejected. The UI label and the code identifier are allowed to diverge; keep them that way.
- **Do not change UI copy back to "JSON chat" / "JSON mode"** to "match" the code — same reasoning in reverse. If you're editing a component and see `"json"` in a prop/variable name right next to `"Rich Chat"` in the JSX it renders, that's correct, not a bug — leave both as they are.
- **New UI copy for this channel:** use "Rich Chat"; add `(json based)` only where the technical detail is genuinely useful to the reader (a tooltip, an advanced-settings hint), not in every occurrence.
- **New code identifiers for this channel:** use `json`/`Json`-prefixed names, consistent with the existing files above.

---

## Docker dev sandboxes — two different tools, don't conflate them

**Files:** `docker-compose.dev.yml` · `scripts/dev-sandbox.sh` · `scripts/dev-entrypoint.sh` · `docker-compose.screenshots.yml` · `Dockerfile.screenshots` · `scripts/demo-seed.sh` · `scripts/seed-file-search-demo.sh`

There are two separate docker setups in this repo. They look similar (both boot a daemon + Vite dev server) but exist for different jobs — picking the wrong one silently gives you the wrong environment instead of erroring.

| | `docker-compose.dev.yml` (via `scripts/dev-sandbox.sh`) | `docker-compose.screenshots.yml` |
|---|---|---|
| Purpose | Interactive dev/testing sandbox | Frozen, realistic dataset for README screenshots |
| Source | Bind-mounted (`web-ui/src`) — hot reload on edit | Baked into the image (`COPY . .`) — rebuild to see changes |
| Seed data | `VST_SEED_MODE=file-search` (default, one lightweight project) or `VST_SEED_MODE=demo` (3 projects / 9 worktrees / 14 sessions, via `scripts/demo-seed.sh`) | Always the same 3-project/9-worktree/14-session dataset |
| Auth | `VST_NO_AUTH=1` — no login screen | Real token login (printed to container logs) |
| Instances | Per-worktree (`scripts/dev-sandbox.sh` picks a free port + isolated volumes per worktree checkout) | Single, fixed name/port (`vst-screenshots`, `5174`) — not meant to run more than one at a time |

**Rule of thumb:** if you're testing a UI change and just need *some* worktrees/agent sessions to click into, use `scripts/dev-sandbox.sh up --seed=demo` — you get hot reload, no login, and the realistic dataset in one sandbox. Reach for `docker-compose.screenshots.yml` directly only when you're actually regenerating README screenshots (`scripts/take-screenshots.ts` targets its fixed port/dataset).

### What to watch for

- **Don't assume `scripts/dev-sandbox.sh up` alone gives you worktrees/agents** — its default seed (`file-search`) is intentionally minimal. Pass `--seed=demo` if you need the realistic dataset.
- **Switching `--seed` mode on an already-seeded volume does NOT cleanly swap datasets — it merges/corrupts them.** The two seed scripts guard themselves independently and asymmetrically, not via a shared "already seeded in mode X" marker: `demo-seed.sh` checks its own `$VST/.seeded` file; `seed-file-search-demo.sh` checks whether `file-search-demo`'s repo dir exists and whether that project is already registered with the daemon. Neither guard knows about the other, so going `file-search` → `demo` on the same worktree-name runs `demo-seed.sh` in full on a volume the daemon already has state for (it `rm -rf`s its own project dirs and overwrites `modes.json`, but doesn't touch the pre-existing `file-search-demo` data or the daemon's already-booted SQLite state — the result is an inconsistent mix, not a clean demo dataset), and going `demo` → `file-search` just registers a 4th project alongside the demo data rather than being a no-op. Use a fresh worktree-name (or `docker volume rm vst-dev-data-<worktree> vst-dev-projects-<worktree>`) whenever you want to actually change an existing sandbox's seed mode.
- **Don't add demo-dataset seeding to `docker-compose.screenshots.yml`'s job description** or vice versa — `screenshots` intentionally has no hot reload and real auth so it matches what `take-screenshots.ts` expects; don't "fix" that to make it more dev-friendly.

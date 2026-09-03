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
| `supportsAcp?()` | optional | ACP migration: true once `runTurn` drives a persistent ACP connection (`ctx.getAcpConnection`) instead of a per-turn one-shot spawn |
| `captureNativeChatId?(args)` | optional | Two-identity model: read the CLI's NATIVE resume id out-of-band, for a plugin whose ACP `session/new` id was empirically proven to diverge from it (`bridged` = agy, `unavailable` = cursor). Deliberately NOT implemented by an `identical`-strategy plugin (claude, opencode) |
| `supportsChannelResume?()` | optional | Two-identity model: `false` (cursor only) declares that no bridge exists from this CLI's ACP session to its own resume flag, so a json→tty toggle starting a fresh conversation is expected, not a bug. Unimplemented ≡ `true` |

### The two session identities (ACP)

A session that has run a Rich Chat turn carries **two** ids — the ACP
`session/new` id (`SessionRecord.acpSessionId`, protocol-level) and the
**native** chat id (`SessionRecord.agentChatId`, what the CLI's own
`--resume`/`--session`/`--conversation` flag understands). `agentChatId` is
always the native one; never store an ACP id in it.

Whether the two coincide is a per-CLI fact, not a choice, and each plugin
declares its answer only by which of the two methods above it implements:
`identical` (claude, opencode — implement neither), `bridged` (agy —
`captureNativeChatId`), `unavailable` (cursor — plus `supportsChannelResume:
false`). Per-CLI resolution code lives in
`daemon/src/agent-plugins/native-chat-id/` (one file per CLI that needs one —
opencode's absence is meaningful). The model is stated once in the
"two session identities" block above `captureNativeChatId` in `spawn.ts`, and
in full in [`docs/AGENT-CHAT-ID-CAPTURE.md`](docs/AGENT-CHAT-ID-CAPTURE.md).

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

## Status indicators — `docs/STATUS-INDICATORS.md` is the source of truth, keep it in sync

**Canonical matrix:** [`docs/STATUS-INDICATORS.md`](docs/STATUS-INDICATORS.md) — every
lifecycle × PR combination, its dot colour, its glyph, and its dashboard bucket.

### The invariant

Session status is **two orthogonal axes**, never one enum:

| Axis | Field | Written by, exclusively |
|------|-------|------------------------|
| Lifecycle (is the agent busy?) | `session.lifecycle.state` | `daemon/src/services/lifecycle.ts`, 1s poll |
| PR (what happened to the branch?) | `session.pr` | `daemon/src/services/prPoller.ts`, 30s poll |

Each poller writes **only** its own field. They previously shared one `LifecycleState` slot
(`needs_review`) with three uncoordinated writers, which raced and silently destroyed the
"PR created" signal — that is why the axes are split. Do not add a cross-write, and do not
collapse them back into one enum.

### Rule: a status change is a two-file change

Touching **any** of these means updating `docs/STATUS-INDICATORS.md`'s matrix **in the same commit**:

- `web-ui/src/lib/statusColor.ts` — `resolveStatusClass` / `worktreePrStatus`
- `web-ui/src/components/layout/DashboardPanel.tsx` — `bucketForRollup`
- `web-ui/src/components/layout/StatusDot.tsx` — glyphs
- `web-ui/src/styles/tokens.css` — `--status-*` / `--pr-*` tokens
- `LifecycleState` (`daemon/src/types.ts`) or `PrStatus` — adding/removing a value
- `daemon/src/services/prPoller.ts` — which PR states map to which `pr.state`

A PR that changes behaviour without changing the matrix should be sent back.

### What to watch for

- **Colour and bucket deliberately disagree for `done`/`exited`** — the dot keeps the PR colour
  (blue/green) so you can see the branch landed, but the card stays in **Finished**, because
  `done` is an explicit manual user action. This is intentional; don't "fix" it into agreement.
- **`idle` buckets to its own Idle column, not Finished** — an idle session is open work, not done.
  Idle and `waiting_for_human` are separate dashboard columns (**Idle** vs **Needs you**), not one
  mixed "Waiting" column — mixing them read as a bug (idle sat under "Waiting" with a neutral dot
  and no red `!`). Both are shown by default; only Finished hides behind the toggle.
- **The dashboard is per-session for LIFECYCLE, per-worktree for PR** (Phase 6, PR resolution
  corrected by BLOCKING-2) — every non-archived agent session gets its own card, bucketed by its
  own lifecycle status. The daemon (`prPoller.ts`) writes `session.pr` **only** to a worktree's
  `isMain` session — nothing else ever writes it — so PR colour/bucket is resolved once per
  worktree (`worktreePrStatus()`, off the `isMain` session, branch-guarded) and the UI fans that
  single value out to every non-archived agent session card of that worktree; the daemon never
  writes `pr` to more than one session (that would reintroduce write amplification — one write, N
  reads is the shape). The sidebar's worktree rows roll up per worktree via
  `worktreeRolledUpStatus()`/`worktreePrStatus()` (unchanged). The canvas tile border and agent
  pane border are per-session for lifecycle (each reads its own `session.state`) but per-worktree
  for PR, same as the dashboard (via `worktreePrStatus()`, branch-guarded against the tile's/pane's
  own worktree) — none of these surfaces ever read a sibling session's own `session.pr` directly.
  See `docs/STATUS-INDICATORS.md` § Per-session vs per-worktree.
- **`working` beats PR; PR beats `waiting_for_human`.** The second one is easy to get backwards:
  an agent idles at its prompt right after opening a PR, so if red won you would almost never
  see blue — which was the original bug's symptom all over again.
- **Never render a PR colour without checking `pr.prBranch === worktree.branch`.** The PR is a
  property of the branch, not the worktree; after a branch switch a stale PR must colour nothing.
- **`draft` and `closed` are informational only** — they never drive colour or bucket.
- **No bare hexes.** Status colours are per-theme tokens in `tokens.css`; a single hex fails
  light-mode contrast. Non-colour cues (`spawning` dashed, `exited` dimmed) must survive recolours.
- **Testing:** Ctrl+Shift+D opens the dev state simulator, which drives both axes with no daemon.
  Prefer it over injecting SQLite rows — a container restart kills tmux, the lifecycle poller
  then marks every session `exited`, and `exited` is terminal, so injected states never recover.

---

## Docker dev sandboxes — two different tools, don't conflate them

**Files:** `docker-compose.dev.yml` · `scripts/dev-sandbox.sh` · `scripts/dev-entrypoint.sh` · `docker-compose.screenshots.yml` · `Dockerfile.screenshots` · `scripts/demo-seed.sh` · `scripts/seed-file-search-demo.sh`

There are two separate docker setups in this repo. They look similar (both boot a daemon + Vite dev server) but exist for different jobs — picking the wrong one silently gives you the wrong environment instead of erroring.

| | `docker-compose.dev.yml` (via `scripts/dev-sandbox.sh`) | `docker-compose.screenshots.yml` |
|---|---|---|
| Purpose | Interactive dev/testing sandbox | Frozen, realistic dataset for README screenshots |
| Source | Bind-mounted (`web-ui/src`) — hot reload on edit | Baked into the image (`COPY . .`) — rebuild to see changes |
| Seed data | `VST_SEED_MODE=demo` (default, 3 projects / 9 worktrees / 14 sessions, via `scripts/demo-seed.sh`) or `VST_SEED_MODE=file-search` (one lightweight project) | Always the same 3-project/9-worktree/14-session dataset |
| Auth | `VST_NO_AUTH=1` — no login screen | Real token login (printed to container logs) |
| Instances | Per-worktree (`scripts/dev-sandbox.sh` picks a free port + isolated volumes per worktree checkout) | Single, fixed name/port (`vst-screenshots`, `5174`) — not meant to run more than one at a time |

**Rule of thumb:** a bare `scripts/dev-sandbox.sh up` already gives you *some* worktrees/agent sessions to click into — hot reload, no login, and the realistic dataset, in one sandbox, no flags needed. Pass `--seed=file-search` only when you specifically want a fast, empty single-project tree instead. Reach for `docker-compose.screenshots.yml` directly only when you're actually regenerating README screenshots (`scripts/take-screenshots.ts` targets its fixed port/dataset).

### What to watch for

- **`scripts/dev-sandbox.sh up` with no flags seeds the full demo dataset by default** — worktrees/agents are there out of the box. Pass `--seed=file-search` if you specifically want a fast, empty single-project tree instead.
- **Switching `--seed` mode on an already-seeded volume does NOT cleanly swap datasets — it merges/corrupts them.** The two seed scripts guard themselves independently and asymmetrically, not via a shared "already seeded in mode X" marker: `demo-seed.sh` checks its own `$VST/.seeded` file; `seed-file-search-demo.sh` checks whether `file-search-demo`'s repo dir exists and whether that project is already registered with the daemon. Neither guard knows about the other, so going `file-search` → `demo` on the same worktree-name runs `demo-seed.sh` in full on a volume the daemon already has state for (it `rm -rf`s its own project dirs and overwrites `modes.json`, but doesn't touch the pre-existing `file-search-demo` data or the daemon's already-booted SQLite state — the result is an inconsistent mix, not a clean demo dataset), and going `demo` → `file-search` just registers a 4th project alongside the demo data rather than being a no-op. Use a fresh worktree-name (or `docker volume rm vst-dev-data-<worktree> vst-dev-projects-<worktree>`) whenever you want to actually change an existing sandbox's seed mode.
- **Don't add demo-dataset seeding to `docker-compose.screenshots.yml`'s job description** or vice versa — `screenshots` intentionally has no hot reload and real auth so it matches what `take-screenshots.ts` expects; don't "fix" that to make it more dev-friendly.

---

## Three unrelated things named "skill" — don't conflate them

**Files:** `skill/SKILL.md` · `daemon/src/assets/agent-system-prompt.md` · `daemon/src/services/promptBuilder.ts:22-23,35-46` · `daemon/src/services/userSkillCatalog.ts` · `daemon/src/services/config.ts` (`UserSettings.skillPaths`)

There are three different "skill" concepts in this repo, two of which share a file name pattern (`SKILL.md`):

1. **`skill/SKILL.md` at the repo root** is the **`vst` agent skill this repo publishes** — a Claude-Code-style skill (frontmatter `name: vst`) documenting how an *external* agent drives the vst daemon. It is not loaded by the daemon at all; it is shipped for other agents to install.
2. **`daemon/src/assets/agent-system-prompt.md`** is vibe-station's **own L1 system prompt asset** — loaded once at daemon boot by `promptBuilder.ts` (`loadSkillMd()`, whose stale `skill/skill.md` header comment is what invites confusion #1) and sent to every spawned agent as the base of its system prompt. Not user-configurable, nothing to do with per-user "skills".
3. **User skill directories** (`UserSettings.skillPaths`, default `~/.claude/skills`) are scanned by `userSkillCatalog.ts` for `<dir>/<name>/SKILL.md` files — these are the skills a user can invoke with `/name` in Rich Chat (skill-invocation-in-chat).

### What to watch for

- **Scan hazard:** if a user ever adds the vibe-station repo root to `skillPaths` in the Skills settings panel, `userSkillCatalog`'s `<dir>/*/SKILL.md` scan would ingest `skill/SKILL.md` as a user skill named `vst` (it has valid frontmatter, so it parses cleanly — the ingestion is silent, not an error). The default (`~/.claude/skills`) avoids this in practice, but the settings UI does not block the repo root — don't "fix" this by special-casing the repo root path; the fix (if ever needed) belongs in the scanner's directory validation, not as a silent path skip.
- Do not rename `userSkillCatalog` to `skillCatalog` or similar — the deliberately distinct name is what keeps this file from being confused with `promptBuilder.ts`'s L1 asset in searches/greps.
- **`skill/SKILL.md` is not the L1 prompt.** Editing it changes what *external* agents are told about the vst CLI; editing `daemon/src/assets/agent-system-prompt.md` changes what *our own* spawned agents are told. They are cross-referenced from each other but are never the same file.

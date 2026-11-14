# Agent / Coding Guidelines

Accumulated lessons from bugs that were painful to diagnose. Read before touching the listed areas.

**Note on the sections below referencing `daemon/src/...` (Node/TypeScript):** this branch's daemon has been
rewritten in Rust (`rust/vst-daemon`, `rust/vst-routes`, `rust/vst-store`, `rust/vst-types`,
`rust/vst-lifecycle`, `rust/vst-cli`) — there is no `daemon/` or `cli/` directory here anymore. The
architectural *invariants* documented below (plugin boundaries, status axes, WS locking, etc.) still hold
conceptually; only the file paths are stale. Don't assume a `daemon/src/foo.ts` path you can't find means the
invariant no longer applies — find its Rust equivalent instead of skipping the rule.

---

## Architecture — modular, contained, boring (read before adding any feature)

**Files:** `rust/*/Cargo.toml` (crate graph) · `rust/vst-daemon/src/run.rs` (wiring) · `rust/vst-agents/src/plugin.rs` · `web-ui/src/components/<area>/` · `web-ui/src/api/types.ts`

### The invariant

A feature should be removable or replaceable by touching one owner plus one line of wiring. These are
defaults, not dogma: deviate for a concrete reason and record it in the PRD/plan. Bullets marked
**(target)** describe new code; older code that predates them is not a licence to copy it, nor a mandate
to refactor it in an unrelated PR.

### Backend (Rust)

- **Dependencies are one-way.** Today: `vst-types` (no I/O; serde types, `Broadcaster`, `Coalescer`, the
  `ReviewPort`/`TurnObserver` traits) ← `vst-proc`/`vst-store`/`vst-rpc`/`vst-tasks`/`vst-fswatch` ←
  `vst-git`/`vst-activity`/`vst-artifacts` ← `vst-review` ← `vst-agents` ← `vst-lifecycle`/`vst-ws` ←
  `vst-lsp`/`vst-routes` ← `vst-daemon` ← `vst-cli`; `vst-ws` re-exports `vst-fswatch`; `vst-review`
  depends only on `vst-types`, `vst-store`, `vst-proc`, `vst-git`, `vst-fswatch`, `vst-artifacts` (the
  `vst-review -> vst-artifacts` edge is one-way); `vst-routes` and `vst-daemon` also depend on
  `vst-review`; `vst-diffstat` (deps: `vst-git`, `vst-store`, `vst-types` only) sits beside
  `vst-lifecycle`/`vst-ws` and is depended on only by `vst-daemon`;
  `vst-agy-stream-acp` is a leaf crate with no `vst-*` deps, depended on only by
  `vst-daemon` (hidden `agy-stream-acp` subcommand); no library crate depends on `vst-routes`/`vst-daemon`.
- **One feature, one owner.** A new service/domain gets its own module or crate owning its state,
  scheduling and cache. Don't grow `vst-lifecycle` (already a grab-bag), `vst-agents` or `vst-routes`.
- **New feature crates stay CLI-agnostic (target):** take per-CLI behaviour by injection (closure/trait
  object built in `run.rs`) rather than adding another `vst-agents` dep edge.
- **CLI-specific behaviour** follows "Agent plugin" above. A new per-harness query is one `AgentPlugin`
  method with a safe default, shaped like `list_models()` → `{ models, error: Option<String> }`.
- **Routes are thin (target):** parse, call the owner, serialise. `projects.rs`/`worktrees.rs`/
  `tailscale.rs` still spawn processes directly — don't add more.
- **Single writer per field** — the general form of the lifecycle/PR split in "Status indicators".

### Data flow & contracts

- **Push, don't poll (target):** fetch on connect/reconnect, then follow `ServerEvent`s sent only on real
  change (cf. `pr_status_equivalent`). Existing client `setInterval` polls (`useLspStatus`,
  `useDoctorStatus`, `DashboardPanel`) predate this. The requester still uses its HTTP response ("Draft promotion").
- **Pollers copy `PrPollerHandle`** (`vst-lifecycle/src/pr_poller.rs`): `new(store, broadcaster)`,
  `start(self: Arc<Self>)` from `run.rs`, in-flight guard, `MissedTickBehavior::Skip`, broadcast on change
  only, last-known value kept on transient error.
- **External probes are bounded** (timeout, kill-on-drop, backoff). "Unknown / unsupported / signed out"
  are distinct visible states, never a fake `0` or blank.
- **Wire types are hand-mirrored:** `vst-types` is the source of truth, no codegen — a REST/WS type change
  updates `web-ui/src/api/types.ts` in the same commit.
- **Persisted data stays readable:** new stored fields are `Option`/`#[serde(default)]`; never rename or
  repurpose a persisted value (cf. `channel: "json"`).
- **Vendors:** use their own binary/documented API; never read credential files/keychains, reuse tokens, or
  edit users' CLI config. Unstable surfaces live behind one file each, parse tolerantly, have a fixture test.

### Web UI

- **One folder per feature area** (`components/<area>/` + tests, hook beside it or in `hooks/`). Shared
  shells (`Layout`, `GlobalStatusBar`, `TabsStrip`) get a mount, not feature logic.
- **One source per piece of server state.** Read sessions/worktrees from `useServerStore` (what the
  sidebar uses); don't keep a private fetched copy. `TabsStrip` did (`localSessions`) and tabs drifted from
  the sidebar — it now derives its list from the store and keeps only focus side-effects. Project (direct-agent) tabs are
  likewise derived (`projectTabIds` in `lib/sessionVisibility.ts`); there is no persisted open-tab set.

### What to watch for

- **"Just add it to the nearest big file"** — check the owner and dependency direction first.
- **A second writer or second poll loop for the same data** — fold it into the existing owner.
- **A `vst-types` change without `api/types.ts`**, or a persisted field without a serde default.
- **Tests:** a new owner is tested at its public handle; a new route's tests mount it under `/api` ("CLI").
  Large features go PRD → plan (`.vibekit/feature-plans/`) first.

---

## CLI — every REST route lives under `/api`; the CLI must prefix every path with it

**Files:** `rust/vst-daemon/src/server.rs` (`.nest("/api", api)`) · `rust/vst-cli/src/client.rs` (`api_path`)

### The invariant

The daemon's `Router` in `server.rs` puts every REST route (`/sessions`, `/worktrees`, `/projects`, `/modes`,
`/open`, etc.) under `.nest("/api", api)`. Only four routes are intentionally at root: `/health`,
`/mobile-auth`, `/ws`, `/continue` (the last added by `cli-daemon-unification` Part 02 — a browser-opened
redemption endpoint that, like `/mobile-auth`, can't require the auth it's establishing). Anything else hit
at root falls through to `.fallback(handle_fallback)`, which serves the SPA's `index.html` with a `200`
status — **not** a `404`.

This bit us for real: every `vst-cli` call site built its request path root-relative (`"/sessions"`,
`"/worktrees"`, …) with no `/api` prefix anywhere, so every CLI command — including `vst session create` and
`vst worktree create`, which is literally how an agent following `skill/SKILL.md` spawns a subagent — silently
200'd against the SPA HTML instead of hitting its route. Worse, `client.rs`'s old response parsing swallowed
the real "this isn't JSON" error and replaced it with `serde_json::from_value(Value::Null)`, which then failed
with the misleading `invalid type: null, expected a sequence` — nothing in that message points at routing, so
an agent hitting it reasonably (but wrongly) suspects DB/daemon corruption instead. `vst doctor`/`vst status`
still reported "Daemon is running" throughout, because `/health` is one of the root routes that *does*
work, masking the outage from the one diagnostic an agent would naturally reach for.

The fix: `client.rs` has a single `api_path()` helper that every `daemon_request*` call routes through, which
prefixes `/api` onto anything except `ROOT_PATHS` (`/health`, `/mobile-auth`, `/ws` — three, not the daemon's
four root routes above, since the CLI itself never requests `/continue`; it's browser-opened only).
**Do not add `/api` at individual call sites** —
if a new CLI command needs a new route, add the route under `.nest("/api", ...)` in `server.rs` as usual and
call it root-relative from the CLI; `api_path()` handles the prefix.

### What to watch for

- **A non-2xx-looking response that still parses as valid JSON `null` is not proof of success.** If you ever
  need to loosen `client.rs`'s JSON-parse error again (e.g. to special-case another status code), keep it
  narrow — the whole point of surfacing the real parse error (status + content-type + body snippet) is so a
  routing/prefix mismatch like this one fails loudly instead of masquerading as a deserialization bug three
  layers away from the actual cause.
- **Mock servers in `vst-cli/tests/*.rs` must mount their routes under `/api/...`** to match what
  `daemon_request_with_base` actually requests (except `/health`, which stays at root) — a contract test with
  an unprefixed mock route will pass while encoding the wrong convention, which is exactly how this shipped
  undetected.
- **`vst doctor`/`preflight()` only prove `/health` works**, not that the rest of the API is reachable. Don't
  treat "daemon is running" as evidence that `vst session create`/`vst worktree create`/etc. will work.

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

## Tools rail — a stable sibling of the main column, never a wrapper

**Files:** `web-ui/src/components/layout/Layout.tsx` · `ToolsRailColumn.tsx`

`ToolsRailColumn` is a trailing child of `#workspace-layout` (phones: each `ToolPanel` carries its own
vertical rail instead). It must stay a *sibling* of the main column: wrapping or reparenting
`topRow`/the agent `PanelGroup` changes its tree path and remounts `TerminalPane` (see "Terminal" above).
It renders only while the tools pane is shown (`showRail`), and Layout marks that with `data-rail` on
`#workspace-layout`. Its head cell is an empty 35px spacer under the actions chip's toggle (below).
`Layout.test.tsx` asserts `agentChildMounts === 1` across hide/show, orientation and fullscreen; keep it
green. Both `Layout` returns sit under the same `TopActionsProvider` with `#workspace-layout` at child index 1
**and `paneHostLayer` at index 3** (the dashboard return holds a `{null}` in the regions return's
`fullscreenOverlay` slot) so `div.app-shell`/the sidebar and every live agent/terminal pane do not remount on
dashboard <-> worktree navigation; keep a test (`Layout.test.tsx`) if you add a child before `paneHostLayer`.

## Search / "..." / toggle chip — one stable box, hosts only reserve its width

**Files:** `web-ui/src/context/TopActionsContext.tsx` · `components/layout/TopActionsSlot.tsx` · `Layout.tsx` · `styles/workspace.css` (`.top-actions-anchor`, `.top-bar-floating-actions`, `.actions-host__reserve`)

The chip renders exactly once: `Layout` renders `<TopActionsOwner zones>` as the LAST child of
`#workspace-layout`, an absolute top-right box (`main`'s chrome: `--bg-elevated`, 1px left border, 6px
bottom-left radius, soft shadow) that is never re-parented, so it never remounts, moves or hides during
tools / rail / list transitions (hidden only by `#workspace-layout[data-pane-fullscreen]`). Do not portal
it into rows, do not add transition holds (visibility/opacity timers, `data-*-transition` attributes) and
do not measure it: portaling it into rows remounted it on every host change, and the transition hold that hid that was the flicker.

Panes mount `ActionsHost`/`ToolActionsHost`/`ModeHeaderActionsHost` in their top row. The registry picks
the ONE row under the chip (`reserveHost()`), whose empty `.actions-host__reserve` span takes the chip's
width from tokens (`--top-actions-w` = 105px, minus the rail's 36px under `[data-rail]`, plus the offline
pill). Pane controls (layout toggle, Fullscreen) portal into the host's pane span by scope; on phones an
open side-by-side list's header carries them (`listHostsPane`). A new tool tab must mount a
`ToolActionsHost` in its header bar; a new top-row item must stay left of the reserve. The "..." menu is
portaled to `usePortalRoot()` (`position: fixed`) because host rows clip overflow.

The chip is an overlay: anything that ends up at the top-right of `#workspace-layout` is under it unless its row reserves. **New header row** that can be the window's top-right row: put the `actions-row` class on it and mount `ToolActionsHost`/`ActionsHost` as its LAST item, in a zone listed in Layout's `zones` (a new pane kind = a new `GroupZone` + `HOST_PRIORITY` entry). Without a host its right end silently slides under the chip. **New button in the chip:** add it in `WorkspaceActions` AND bump the button count in `--top-actions-w` (`workspace.css`) and `CHIP_W` (`anchorCss.test.ts`), and re-check `FILES_LEFT_PANE_MIN_WIDTH_DESKTOP` (`lib/layoutSizes.ts`; `anchorCss.test.ts` fails if the open list's header no longer fits beside the chip's reserve); the count test in `WorkspaceActions.test.tsx` fails until you do. **New tool tab:** mount a `ToolActionsHost` in its header bar (or rely on `ToolPanel`'s host bar). **Docked lists:** the Files list AND the VCS commit view's changed-file list use the one `DockedListLayout` (`components/layout/`: right dock, left-edge handle, shared persisted size, phone clamps); a new docked list reuses it (never a second resize/clamp copy) and its header mounts `ModeHeaderActionsHost` (`ListHeaderMode`; `ToolPanel` derives `isPanelOpen`/`filesMode` for it). Shared sizes: `--pane-row-h`/`--tools-toggle-size`/`--tools-rail-col-w` on `.app-shell`, mirrored in `lib/layoutSizes.ts` (`DockedListLayout` is the one owner of the list size var `--list-pane-w/h`); phone breakpoint `MOBILE_QUERY`. Never render a second toggle; `HOST_PRIORITY` ranks competing hosts.

---

## Session status in a pane — always `sessionStates[id] ?? session.state`, never `session.lifecycleState`

**Files:** `web-ui/src/components/layout/TerminalPane.tsx` · `ChatPane.tsx` · `LeftSidebar.tsx` · `DashboardPanel.tsx` · `SubagentRow.tsx` · `TabsStrip.tsx` · `useServerSync.ts`

### The invariant

A session's lifecycle status is readable from **two** places on the client, and they are not interchangeable:

- `useWorkspaceStore`'s `sessionStates` map — the LIVE value, patched by `useServerSync.ts`'s `session:state`/`session:exited`/`session:resumed` WS handlers, and re-seeded wholesale on every reconnect (`syncSessionsFromApi`). This is the only place a page-session-old client ever finds out a status changed.
- The `Session` record's own two fields: `.state` (patched by the SAME three WS handlers, via `useServerStore`'s `applySessionUpdated`) and `.lifecycleState` (written **only** by the initial REST fetch — no live handler ever touches it, so for any session created or promoted during the current page load it is permanently frozen at whatever value it had the moment its record first arrived, typically `"drafting"` or `undefined`).

Any pane/row that shows a status-dependent placeholder ("Starting…", a draft badge, a colored dot) must resolve state as **`sessionStates[id] ?? session.state`** — the live map first, the session record's `.state` as fallback for a session the map has no entry for yet (a session this client only just learned about). Never read `.lifecycleState` for anything live-updating; it is a one-shot initial value, not a status field.

This was violated three separate times in the same feature (the instant-draft-agent flow), each with a different symptom, before all three were normalized to the rule above:

1. `TerminalPane.tsx` read `sessionStates[id]` with **no fallback at all**. A freshly-promoted draft has no entry in that map yet, so `lifecycleState` was `undefined`, which made BOTH `mountTerminal` and `showSpawningOverlay` false — no xterm mounted, no "Starting…" either, just a silent empty box until a reload repopulated the map from REST.
2. `ChatPane.tsx`'s spawning guard read `session.lifecycleState` — frozen forever at `"drafting"`/`undefined` for any session created this page-session, so the guard could never fire; a Rich Chat agent showed its empty "Start chatting" view for the entire spawn window.
3. (Historical — fixed by deriving tabs from `useServerStore`.) `TabsStrip.tsx` kept its own REST-fetched `localSessions` copy (worktree-scoped tabs are NOT rendered off the global store) and its WS `session:updated` handler patched `name`/`channel`/`isMain`/etc but never `.state` — and there were no handlers at all for `session:state`/`session:exited`/`session:resumed`. A tab's "Draft" badge (`s.state === "drafting"`) stuck forever after Start, even though the session was long since running, until a hard refresh forced a fresh `listSessions()` fetch.

In all three cases the left sidebar (`LeftSidebar.tsx`, `DashboardPanel.tsx`, `SubagentRow.tsx`) showed the correct status the whole time — it has always used the `sessionStates[id] ?? s.state` resolution — which is the fastest way to tell "is this a live-state-resolution bug" apart from "is the session actually stuck": if the sidebar shows it correctly and a specific pane/row doesn't, suspect this pattern first.

### What to watch for

- **New status-driven UI:** resolve state via `sessionStates[id] ?? session.state`, matching the sidebar. Do not introduce a fourth divergent resolution.
- **A component with its OWN fetched copy of sessions** (avoid this; `TabsStrip.tsx` no longer has one) needs its OWN WS reconciliation for `.state`/`session:exited`/`session:resumed` — subscribing only to `session:updated` is not enough, since that event never carries `.state` at all (state changes go out as their own three distinct event types).
- **`.lifecycleState` is not a live field.** Grep for `.lifecycleState` before adding a new read of it — every existing one is either the same intentional one-shot idempotency use `AgentPaneSlot.tsx` documents at its `session.state` comment, or a bug waiting to be found.

---

## Draft promotion (`POST /sessions/:id/start`) — the HTTP response must be self-sufficient, not just the WS broadcast

**Files:** `daemon/src/routes/sessions.ts` (the `/sessions/:id/start` handler) · `web-ui/src/components/draft/DraftComposer.tsx`

### The invariant

When a draft is promoted to a live session, the web-ui navigates off the **HTTP response** of `startDraft` synchronously — it does not, and must not have to, wait for the corresponding `worktree:created`/`session:updated` WS broadcasts to be processed first. Those broadcasts exist for OTHER connected clients (other tabs, other devices); the client that made the request already has a perfectly good response to use immediately.

Two bugs shipped from forgetting this:

- The brand-new-worktree branch's response only ever included `worktreeId`, not the worktree record itself. The caller had no way to register the worktree in its own store without waiting on the `worktree:created` broadcast — which could lose the race against the client's own navigation (reconnect, event ordering), leaving the pane blank until a manual refresh re-fetched everything over REST.
- The already-existing-worktree branch (entryPoint `"tab"`, or `"worktree"` + `worktreeChoice: "existing"`) didn't return `worktreeId` in its response AT ALL. The caller saw `worktreeId: undefined` and fell through to the direct-session `/session/:id` route instead of `/worktree/:id`, even though the session was now living inside a worktree.

The fix in both cases was the same shape: make the response carry everything the client needs to update its own store *before* navigating (`{ ok: true, worktreeId, worktree: serializedWorktree }`), and have `DraftComposer.tsx` call `applyWorktreeCreated`/`applySessionUpdated` on it immediately, the same way `startTier2NewProject`'s direct `api.createWorktree()` call already did (that path never had this bug, because its response was always the full record).

### What to watch for

- **A new `/start`-like promotion path:** if the client needs to know about a worktree/session/anything-else right after the call succeeds, put it in the response body — don't make the client wait on a WS broadcast for data the server already has in hand while building the reply.
- **`serializeWorktree(projectId, worktree)` needs the worktree's REAL `sessions` array to compute `mainSessionId` correctly.** The brand-new-worktree branch builds its `WorktreeRecord` with `sessions: []` (via `buildSessions: () => []`) and only attaches the real session afterward via `mutateProject` — serializing the original (still-empty) object gives `mainSessionId: null` in both the HTTP response and the `worktree:created` broadcast. Serialize `{ ...worktree, sessions: [theRealSession] }`, not the pre-mutation object.

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
| `default_channel()` | yes | Default execution channel for this CLI (`json` for claude/cursor/opencode/codex/omp, `tmux` for agy/pi); used when no explicit/inherited channel and no user override resolve otherwise |
| `supports_json()` | optional (default `false`) | Whether this CLI can run the JSON (Rich Chat) channel. `true` for agy (Rich Chat spoken via the hidden `vst agy-stream-acp` subcommand, crate `vst-agy-stream-acp`) and for omp (speaks ACP natively via `omp acp`). When false, the daemon rejects `--channel=json` on session/worktree create and the tty→json toggle with a 4xx, and the web UI hides/disables the Rich Chat affordances |
| `setupWorkspaceHooks?(path)` | optional | Write hook scripts into the worktree |
| `provideChatId?(args)` | optional | Pre-spawn: mint a chat ID (cursor) |
| `captureChatId?(args)` | optional | Post-ready: read chat ID from token file |
| `getRestoreCommand?(args)` | optional | Return resume argv, or null for fresh spawn |
| `supportsAcp?()` | optional | ACP migration: true once `runTurn` drives a persistent ACP connection (`ctx.getAcpConnection`) instead of a per-turn one-shot spawn |
| `captureNativeChatId?(args)` | optional | Two-identity model: read the CLI's NATIVE resume id out-of-band, for a plugin whose ACP `session/new` id was empirically proven to diverge from it (`unavailable` = cursor). Deliberately NOT implemented by an `identical`-strategy plugin (claude, opencode, omp, agy) |
| `supportsChannelResume?()` | optional | Two-identity model: `false` (cursor only) declares that no bridge exists from this CLI's ACP session to its own resume flag, so a json→tty toggle starting a fresh conversation is expected, not a bug. Unimplemented ≡ `true` |
| `acpSessionIdIsNative?()` | optional (default `false`) | Two-identity model: `true` (omp, agy) declares the ACP `session/new` id IS the CLI's own resume id (`identical` strategy), so after a tty→json toggle refreshes `agent_chat_id` the daemon may drop a stale stored `acp_session_id` (which would otherwise win on reconnect). See `rust/vst-agents/src/omp.rs` |
| `native_history_importer?()` | optional (default `None`) | At-rest history importer for this harness's native store (`None` ⇒ toggle reports `historyImported:false` and the UI warns). Implement once the store is readable — importing terminal history into Rich Chat is preferred for every harness, so a plugin that omits it carries a comment saying why not |
| `acp_ext_notification_event(method, params)` | optional (default `None`) | Turns an ACP ext notification for the current session into a persisted, never-rendered `task_signal` row (claude: raw SDK `task_*` messages, opted into via `acp_meta` `emitRawSDKMessages`); vendor parsing in the harness's one task file. **Never declare `_meta.jetbrains.air` in `initialize`**: it flips the claude adapter into AIR-client mode, which rewrites every tool-call shape we normalize |
| `task_observations(ev)` | optional (default empty) | Background-task tray (`vst-tasks`): pure, tolerant `Vec<TaskObservation>` from ONE persisted `NormalizedEvent`'s stored fields only (so a transcript rebuild equals live observation). Unstable vendor parsing lives in one file per harness (claude: `claude_tasks.rs`); default empty hides the tray. Claude also supplies an enrich hook copying `_meta.claudeCode.parentToolUseId` onto `parent_tool_use_id`, returns `TurnSettled` from a `Result` row (its adapter holds a turn open until background subagents settle), and maps `task_signal` rows (see `acp_ext_notification_event`) to `Confirmed`/`Ended` — structured state that beats the OS liveness probe |
| `terminal_delivery()` | optional (default `None`) | `Some(TerminalDeliveryCaps)` once this CLI's terminal readiness probe is proven: enables Terminal scheduling / sends to a tmux agent (`settle_ms`, `multiline_ok`, `raw_lf`). `None` ⇒ "Scheduling isn't supported for this agent yet" (`rust/vst-agents/src/plugin.rs`) |
| `terminal_readiness(pane)` | optional (default `Unknown`) | Classify a captured `PaneSnapshot` as `Ready` / `AwaitingApproval` / `Unknown`; the delivery job pastes only after two consecutive `Ready` reads and never answers an approval dialog |
| `extract_file_effects(call)` | optional (default `default_acp_effects`) | Path-bearing file effects (`Write`/`Delete`/`Move`) of a finished tool call, for artifact capture; pure, no I/O, `[]` for anything else; the default also parses a finished (completed or failed) shell (`execute`) call's `command` via `vst-agents/src/shell_effects.rs` (redirects, `tee`, `cp`/`mv`/`install`, `touch`, `dd of=`, `curl -o`, `wget -O`, literal-variable paths only, never guessed; bounded: values >4096 B unresolved; stderr/`.log` ignored; `mv` -> `Move`); override only where a fixture proves the ACP-generic default wrong, and fall back to the default for non-edit calls |

### The two session identities (ACP)

A session that has run a Rich Chat turn carries **two** ids — the ACP
`session/new` id (`SessionRecord.acpSessionId`, protocol-level) and the
**native** chat id (`SessionRecord.agentChatId`, what the CLI's own
`--resume`/`--session`/`--conversation` flag understands). `agentChatId` is
always the native one; never store an ACP id in it.

Whether the two coincide is a per-CLI fact, not a choice, and each plugin
declares its answer only by which of the two methods above it implements:
`identical` (claude, opencode — implement neither; omp and agy — only `acpSessionIdIsNative`, because their ACP id *is* the native id; agy's ACP agent uses the conversation id from `agy --output-format stream-json` as the ACP `sessionId`), `unavailable` (cursor — plus `supportsChannelResume:
false`). Per-CLI resolution code lives in
`daemon/src/agent-plugins/native-chat-id/` (one file per CLI that needs one —
opencode's absence is meaningful). The model is stated once in the
"two session identities" block above `captureNativeChatId` in `spawn.ts`, and
in full in [`docs/RICH-CHAT-ACP.md`](docs/RICH-CHAT-ACP.md) (§ Two session identities).

### What to watch for

- **New CLI support:** if a fourth CLI is ever added, implement *all* required methods and the optional ones that make sense. The TypeScript interface will enforce required methods at compile time.
- **`resolvePlugin` in routes vs. services:** `resolvePlugin` is in `daemon/src/agent-plugins/registry.ts`. Routes are allowed to import it. Services (`daemon/src/services/spawn.ts`) receive the already-resolved plugin as an argument — they never import `resolvePlugin` themselves.
- **`CliId` type:** defined in `daemon/src/types.ts`. Adding a new CLI means adding it to `CliId`, adding a plugin file, registering it in `registry.ts`, and updating Zod schemas in `modes.ts`.
- **Importing history is preferred for every harness:** a new plugin either implements `native_history_importer?()` once its store is readable or adds a comment on the plugin explaining why not; defaulting to `None` silently keeps terminal turns invisible after a toggle.

---

## Terminal delivery safety — scheduled pastes into a tmux agent

**Files:** `rust/vst-review/src/{delivery,probe,sanitize}.rs` · `rust/vst-proc/src/tmux.rs` · `rust/vst-agents/src/plugin.rs` (`terminal_delivery`, `terminal_readiness`)

- **Stdin buffer only.** Text reaches tmux through a named buffer fed on stdin (`paste_buffer`/`paste_buffer_with`); never write a `/tmp` buffer file.
- **Exact targets.** Address tmux as `=name:`; a bare `-t name` prefix-matches another session.
- **Never answer approvals.** `AwaitingApproval`/`Unknown` keep waiting (then fail `timed_out`); the job never sends keys to dismiss a dialog.
- **The probe lives in the plugin.** `terminal_readiness(pane)` and `terminal_delivery()` are `AgentPlugin` methods (default `Unknown`/`None`); `vst-review` is CLI-agnostic and gets them by injected closure.
- **Sanitize every body.** `sanitize_paste_text` strips C0/C1/bidi/zero-width, normalises CR, caps 32 KB; multi-line only if `caps.multiline_ok`.
- **One in flight per session.** Per-session FIFO; the 10-minute timeout starts when a job heads its queue.
- **`deliveryPhase` is set only by `vst-review`** (`waiting`/`pasting`); store transitions clear it.
- **Every terminal transition of a `channel='tmux'` row goes through `TerminalDeliveryHandle`** (sent, failed, cancelled, re-armed, gone: job, poller, cancel route, session delete, boot recovery) so the outcome observer fires exactly once. A direct store write skips it.
- **Not serialized with jobs:** the immediate `/input` paste and the handoff paste. They share the pane but not the FIFO.

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
- **Multiple devices are legitimate:** `tmux attach-session` deliberately has no `-d`, so >1 client on a session is normal when several connections (devices/tabs) are open; `-d` force-detached the other device ("[detached]"). The "one stream" rule below is per connection only.
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

- **JSON (Rich Chat) lifecycle is derived** by `reconcile_lifecycle_locked` (`json_agent_session/lifecycle.rs`)
  from drain · OOB window · `TaskRegistry::hold()`; the only writer is `write_lifecycle_locked`. Never add a
  second prompt-less writer; feed a new input into reconcile instead.
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
- **Exited plain terminals are deleted, agents are not.** `rust/vst-routes/src/terminal_reaper.rs` (started from
  `run.rs`) deletes a `type == Terminal` session once it is `exited` (boot sweep + `SessionState` events) via the
  normal `delete_session` path; exited *agents* stay resumable. The poller / `worktree_done` / `recover.rs` remain
  the only writers of the state. An open terminal dock always has ≥1 terminal: `TabsStrip` (keyed off
  `terminalDockVisible` — the dock's content stays mounted while hidden) creates one (`onlyIfNone`) when the dock is
  open and empty, and CLOSES the dock when it empties while open — never re-create in place, or an
  instantly-dying shell loops create → exit → reap → create. A hidden dock creates nothing.

---

## Killing processes you started — by PID only, never by name

**Applies to:** any agent/script that launches a throwaway `vst-daemon`, `vite`, `cargo run`, etc. to test something.

The developer usually has a **real** dev daemon running on the same machine (e.g. the Tauri dev app's
`target/debug/vst-daemon` sidecar). `pkill -f "target/debug/vst-daemon"` matches *every* process whose command
line contains that string, so it kills theirs too. This has happened twice.

### Rules

- **Never** use `pkill`, `killall`, `pkill -f`, or `kill $(pgrep …)` / `kill $(ps … | grep …)` for processes by
  binary name or pattern. Never `lsof -ti :PORT | xargs kill` on a port you didn't verify is yours.
- **Prefer the Docker dev sandbox** (`scripts/dev-sandbox.sh up|down`) for anything that needs a running daemon;
  `down` only touches that sandbox's own containers. If Docker is down, start it or ask — don't silently fall
  back to a native daemon.
- If you must run a daemon natively, capture the PID at launch and kill exactly that PID:

```bash
T=$(mktemp -d)
# Isolated HOME (the data dir is $HOME/.vibe-station) and a port you checked is free:
lsof -i :7198 >/dev/null 2>&1 && { echo "port busy"; exit 1; }
HOME=$T VST_NO_AUTH=1 VST_PORT=7198 ./target/debug/vst-daemon >"$T/daemon.log" 2>&1 &
DAEMON_PID=$!
trap 'kill "$DAEMON_PID" 2>/dev/null; rm -rf "$T"' EXIT   # exactly this PID, nothing else
# ... curl localhost:7198 ...
```

- Before killing, confirm the PID is yours: `ps -p "$DAEMON_PID" -o pid,command` should show your temp `HOME`
  port/binary, not the developer's. After cleanup, check that only *your* port is gone.

### Tests that start a real binary — Docker/CI only, always behind the guard

**Files:** `rust/vst-testkit/src/proc_guard.rs` · `rust/vst-daemon/tests/{async_startup,agy_stream_acp_cmd}.rs` ·
`rust/vst-cli/tests/self_heal.rs` · `scripts/ci-steps.sh` · `scripts/check-native-daemon-tests.sh`

A test that spawned the daemon as a plain `std::process::Child` orphaned it whenever an assert failed first.
Three such debug daemons ran for hours on a dev Mac (2026-11-12), each exec'ing children while Gatekeeper
re-scanned the 147 MB binary: ~1300% CPU.

- **Gate it.** A test that starts `vst-daemon` / `vst daemon run` begins with
  `if !native_daemon_tests_enabled("<name>") { return; }`. `VST_NATIVE_DAEMON_TESTS=1` is set only by
  `scripts/ci-steps.sh` inside the CI container and by `rust-ci.yml`, so `cargo test` and
  `scripts/ci-local.sh --native` on a dev host start no daemon. Don't export it on a dev host; run
  `scripts/ci-local.sh --only rust`.
- **Guard it.** Spawn through `vst_testkit::ChildGuard::spawn` (own process group; `Drop`, also on panic, sends
  the group `SIGTERM` then `SIGKILL` and reaps), never a bare `Command::spawn`. For a daemon the test starts
  indirectly and detached (CLI self-heal), create a `vst_testkit::DaemonHomeGuard` for its temp `HOME` **before**
  anything can spawn, declared after the tempdir. Cleanup at the end of the test body is not cleanup: a failed
  assert skips it.
- **Add it to `scripts/check-native-daemon-tests.sh`** (with its test count) so CI fails if the test silently
  skips instead of running.
- The guards signal the PID/PGID they captured, never a name or port. A process that leaves the group
  (`setsid`, e.g. a tmux server) is out of reach: don't start one from such a test.
- The guards run on unwind only. Killing the test binary itself (Ctrl-C, `timeout`) drops nothing, and a guarded
  child is in its own group so it does not receive that Ctrl-C: the container being thrown away is the backstop.

---

## Docker dev sandboxes — two different tools, don't conflate them

**Files:** `docker-compose.dev.yml` · `scripts/dev-sandbox.sh` · `scripts/dev-entrypoint.sh` · `docker-compose.screenshots.yml` · `Dockerfile.screenshots` · `scripts/demo-seed.sh` · `scripts/seed-file-search-demo.sh`

There are two separate docker setups in this repo. They look similar (both boot a daemon + Vite dev server) but exist for different jobs — picking the wrong one silently gives you the wrong environment instead of erroring.

| | `docker-compose.dev.yml` (via `scripts/dev-sandbox.sh`) | `docker-compose.screenshots.yml` |
|---|---|---|
| Purpose | Interactive dev/testing sandbox | Frozen, realistic dataset for README screenshots |
| Source | Bind-mounted (`web-ui/src`) — hot reload on edit | Baked into the image (`COPY . .`) — rebuild to see changes |
| Seed data | `VST_SEED_MODE=demo` (default, 3 projects / 9 worktrees / 14 sessions, via `scripts/demo-seed.sh`) or `VST_SEED_MODE=file-search` (one lightweight project) | Always the same 3-project/9-worktree/14-session dataset |
| Auth | `VST_NO_AUTH=1` (requires `insecure-no-auth` feature) — no login screen | Real token login (printed to container logs) |
| Instances | Per-worktree (`scripts/dev-sandbox.sh` picks a free port + isolated volumes per worktree checkout) | Single, fixed name/port (`vst-screenshots`, `5174`) — not meant to run more than one at a time |

**Network exposure (deliberate):** the dev sandbox publishes its port on all host interfaces so it can be used from other devices, and its daemon runs with `VST_NO_AUTH=1` — anyone who can reach the host on that port gets an unauthenticated UI/API, including terminals and agent sessions (command execution as the container user). Only run it on a trusted network; never on a shared or public one. Origin checks still apply: reach it by IP, `localhost`, or a `*.ts.net` name, or list the exact origin in `VST_ALLOWED_ORIGINS` (a plain hostname like `mybox.local` gets 403 on writes). If you need to lock one down, edit the `ports:` line in `docker-compose.dev.yml` to `127.0.0.1:${VST_SANDBOX_PORT:-5174}:5173` locally.

**Rule of thumb:** a bare `scripts/dev-sandbox.sh up` already gives you *some* worktrees/agent sessions to click into — hot reload, no login, and the realistic dataset, in one sandbox, no flags needed. Pass `--seed=file-search` only when you specifically want a fast, empty single-project tree instead. Reach for `docker-compose.screenshots.yml` directly only when you're actually regenerating README screenshots (`scripts/take-screenshots.ts` targets its fixed port/dataset).

### What to watch for

- **`scripts/dev-sandbox.sh up` with no flags seeds the full demo dataset by default** — worktrees/agents are there out of the box. Pass `--seed=file-search` if you specifically want a fast, empty single-project tree instead.
- **Switching `--seed` mode on an already-seeded volume does NOT cleanly swap datasets — it merges/corrupts them.** The two seed scripts guard themselves independently and asymmetrically, not via a shared "already seeded in mode X" marker: `demo-seed.sh` checks its own `$VST/.seeded` file; `seed-file-search-demo.sh` checks whether `file-search-demo`'s repo dir exists and whether that project is already registered with the daemon. Neither guard knows about the other, so going `file-search` → `demo` on the same worktree-name runs `demo-seed.sh` in full on a volume the daemon already has state for (it `rm -rf`s its own project dirs and overwrites `modes.json`, but doesn't touch the pre-existing `file-search-demo` data or the daemon's already-booted SQLite state — the result is an inconsistent mix, not a clean demo dataset), and going `demo` → `file-search` just registers a 4th project alongside the demo data rather than being a no-op. Use a fresh worktree-name (or `docker volume rm vst-dev-data-<worktree> vst-dev-projects-<worktree>`) whenever you want to actually change an existing sandbox's seed mode.
- **One `dev.Dockerfile` for every host; host binaries only on Linux, only if present.** Every harness (`claude`, `codex`, `opencode`, `cursor-agent`, `agy`, `omp`, `pi`) is installed in `dev.Dockerfile` as a pinned, `TARGETARCH`-aware Linux build (a Mac's binaries are Mach-O → `ENOEXEC ... posix_spawn`, so macOS mounts none). On a Linux host `dev-sandbox.sh` (OS from `uname -s`, `VST_SANDBOX_OS` overrides) generates a compose overlay mounting the host's own `opencode`/`agy`/`codex`/`cursor-agent` under `/opt/host-bins` — only paths that exist, since a missing bind source becomes an empty dir that would shadow the image copy — and `dev-entrypoint.sh` links each into `/usr/local/bin` only if the expected file is there, else the image copy stays. Don't put host-binary mounts in `docker-compose.dev.yml` itself. `claude-acp` / `codex-acp` are the pinned Rust ports (`vendor/rust-acp/pins.toml`, `scripts/build-rust-acp.sh`): `dev-sandbox.sh` fetches the Linux binaries with `--docker` and bind-mounts those that built at `/opt/rust-acp/*` through a generated overlay (a port that cannot be built is skipped with the reason, never mounted as an empty dir). Bump versions/checksums deliberately. Only credentials come from the host (read-only `/seed/*` → `dev-entrypoint.sh`); the sandbox never reads the macOS Keychain. Keychain-held logins therefore need a vendor mechanism instead: **claude** — the long-lived `claude setup-token` token (`~/.config/vibe-station/claude-oauth-token`) is REQUIRED on macOS (`dev-sandbox.sh up` offers, on a TTY, to run `claude setup-token` in the sandbox image and save the pasted token 0600; otherwise it warns and still starts signed out); **cursor-agent** — `CURSOR_API_KEY` (passed through) or a one-time `cursor-agent login` inside; **agy** — a one-time in-sandbox sign-in (it prints a URL, you paste the code back; also needed on Linux, whose login is in Secret Service); **codex** with a keyring store — `codex login --device-auth` inside. codex `auth.json`, opencode `auth.json`, omp and pi are plain files on macOS too and are seeded. In-sandbox logins for codex/opencode/cursor-agent/agy persist in the data volume (`seed_persistent_home` → `~/.vibe-station/cli-home/`), so they survive `up`'s `--force-recreate`; a host credential file, when present, is re-copied on top at each start.
- **Don't add demo-dataset seeding to `docker-compose.screenshots.yml`'s job description** or vice versa — `screenshots` intentionally has no hot reload and real auth so it matches what `take-screenshots.ts` expects; don't "fix" that to make it more dev-friendly.

---

## Three unrelated things named "skill" — don't conflate them

**Files:** `skill/SKILL.md` · `daemon/src/assets/agent-system-prompt.md` · `daemon/src/services/promptBuilder.ts:22-23,35-46` · `daemon/src/services/userSkillCatalog.ts` · `daemon/src/services/config.ts` (`UserSettings.skillPaths`)

There are three different "skill" concepts in this repo, two of which share a file name pattern (`SKILL.md`):

1. **`skill/SKILL.md` at the repo root** is the **`vst` agent skill this repo publishes** — a Claude-Code-style skill (frontmatter `name: vst`) documenting how an *external* agent drives the vst daemon. It is compiled into the daemon binary (`include_str!` in `rust/vst-daemon/src/env_setup.rs`) and written to `~/.vibe-station/skill/vst/SKILL.md` on every boot, which the `~/.claude`/`~/.gemini` skill dirs symlink to.
2. **`daemon/src/assets/agent-system-prompt.md`** is vibe-station's **own L1 system prompt asset** — loaded once at daemon boot by `promptBuilder.ts` (`loadSkillMd()`, whose stale `skill/skill.md` header comment is what invites confusion #1) and sent to every spawned agent as the base of its system prompt. Not user-configurable, nothing to do with per-user "skills".
3. **User skill directories** (`UserSettings.skillPaths`, default `~/.claude/skills`) are scanned by `userSkillCatalog.ts` for `<dir>/<name>/SKILL.md` files — these are the skills a user can invoke with `/name` in Rich Chat (skill-invocation-in-chat).

### What to watch for

- **Scan hazard:** if a user ever adds the vibe-station repo root to `skillPaths` in the Skills settings panel, `userSkillCatalog`'s `<dir>/*/SKILL.md` scan would ingest `skill/SKILL.md` as a user skill named `vst` (it has valid frontmatter, so it parses cleanly — the ingestion is silent, not an error). The default (`~/.claude/skills`) avoids this in practice, but the settings UI does not block the repo root — don't "fix" this by special-casing the repo root path; the fix (if ever needed) belongs in the scanner's directory validation, not as a silent path skip.
- Do not rename `userSkillCatalog` to `skillCatalog` or similar — the deliberately distinct name is what keeps this file from being confused with `promptBuilder.ts`'s L1 asset in searches/greps.
- **`skill/SKILL.md` is not the L1 prompt.** Editing it changes what *external* agents are told about the vst CLI; editing `daemon/src/assets/agent-system-prompt.md` changes what *our own* spawned agents are told. They are cross-referenced from each other but are never the same file.

---

## HTML rendering — untrusted HTML only enters an iframe via `htmlDocument.buildHtmlSrcdoc`

**Files:** `web-ui/src/components/preview/htmlDocument.ts` · `web-ui/src/components/preview/HtmlView.tsx` · `rust/vst-agents/assets/agent-subagent-richchat.md`

`.html`/`.htm` file previews and Rich Chat ```` ```html ```` fences are rendered as sandboxed iframes. The sandbox is a layered boundary (iframe `sandbox` flags + a CSP meta + DOMPurify), and **`buildHtmlSrcdoc` is the single audited path from untrusted HTML to an iframe** — no component builds an iframe from raw HTML any other way.

### The invariant

- **The sandbox never gains `allow-scripts` or `allow-same-origin`** (nor `allow-forms`/`allow-top-navigation*`/`allow-modals`). `HTML_IFRAME_SANDBOX` is exactly `"allow-popups allow-popups-to-escape-sandbox"`; `HtmlView.tsx` renders `<iframe sandbox={HTML_IFRAME_SANDBOX}>` with no `allow` and no `src`. Adding any of these flags is the one edit that turns a harmless preview into full script execution — treat it as a security review blocker.
- **The CSP meta is always first** in the `srcdoc`, before user content, so a sanitized user `<style>` can never precede or override it. `HTML_CSP` (`default-src 'none'`; `style-src 'unsafe-inline'`; `img`/`font`/`media-src data:`) blocks all network/exfil even if a sanitizer bypass slips through.
- **The DOMPurify instance in `htmlDocument.ts` is private** (`const purify = DOMPurify(window)`) with its own hook — never swap it for the default instance used by `MermaidView`, or the link-rewriting hook leaks into SVG sanitization (and vice-versa).
- **`renderHtml` is only passed by the assistant `TextMessage`** (`StreamingMarkdown.tsx`'s `renderHtml?: boolean`, default `false`). User messages and `ThinkingBlock` never pass it, so an html fence there stays a plain code block.
- **The prompt section's rules stay in sync with the UI's caps and sanitizer:** `rust/vst-agents/assets/agent-subagent-richchat.md` (appended to the Rich-Chat-only `SUBAGENT_MD`, gated by `rich_chat` in `prompt_builder.rs`) tells agents "inline `<style>` only, images only as `data:` URIs, no JS/external assets/forms, keep each block under 256 KiB, http(s)/mailto links only". If `HTML_CHAT_MAX_BYTES` (256 KiB), the sanitizer + `HTML_CSP` allowed set (inline CSS; the CSP limits images to `data:`), or the link rules ever change, that prose must change in the same commit.

### What to watch for

- **A second path from HTML text to a rendered view.** Every new render site for untrusted HTML must go through `buildHtmlSrcdoc` — never `dangerouslySetInnerHTML`, never injecting into app DOM (a sanitizer bypass then becomes app XSS), never adding `allow-same-origin` to measure iframe height (it would give the frame the app's origin).
- **Editing the prompt section without the sanitizer/caps, or vice versa.** The UI lets an agent render exactly what the prompt promises (inline CSS, `data:` images, ≤256 KiB, http(s)/mailto links); they must not drift apart.
- **Size caps have one owner:** `HtmlView.isOverHtmlCap` — callers (`FilePreviewPane`, `HtmlBlock`) only call it to pick Source vs Rendered, never re-implement thresholds.

---

## Artifacts — outside-the-root reads go through the artifact allowlist

**Files:** `rust/vst-artifacts/src/paths.rs` (`is_denied`, `is_denied_prefix`) · `rust/vst-artifacts/src/service.rs` (`read_content`, `authorize_read`) · `rust/vst-routes/src/artifact_gate.rs` (`gate_read`, `confine_only`, `artifact_open_path`) · `rust/vst-routes/src/worktrees.rs` / `projects.rs` (`get_file`) · `rust/vst-lsp/src/manager.rs` (`is_sensitive_path`)

### The invariant

Content outside a worktree root is readable through **exactly two gates**: (1) an artifact row, authorized by
`is_denied` (name patterns plus prefix denylist) when the row is read via `read_content`; (2) an expiring LSP
external-peek token, authorized by `is_denied_prefix`. Nothing else may read a path outside the root.

### What to watch for

- **Never add a third outside-root read path.** A new route/WS handler that serves absolute paths must go through
  `ArtifactsHandle::read_content`/`authorize_read`.
- **`resolve_inside_*` alone is not a content gate** for artifact paths; gutter, tree and watchers stay confined to
  the root and reject absolute / `..` paths.
- **In-root routes confine via `artifact_gate::confine_only` / `gate_read`;** never call `read_file_response` on an un-gated path.
- **The denylist is canonical and case-folded:** compare canonicalized paths (symlinks resolved) with folding, never the
  user-typed spelling.

---

## Review comments — rows leave on send, snapshots restore

**Files:** `rust/vst-review/src/{service,holds,terminal,schedule,boot}.rs` · `rust/vst-store/src/{comments,comment_consumers}.rs` · `rust/vst-types/src/{review,review_format}.rs` · `rust/vst-daemon/src/review_routes.rs`

- **A Rich Chat send marks the rows, a schedule/Terminal send moves them, in one transaction:** a Rich Chat turn's rows get `heldBy/heldSession/heldTurn/heldAt` on `comments` (deleted `WHERE heldBy=?` by `turn_persisted`, marker cleared by `turn_cancelled`; there is no hold table); a scheduled row keeps its `commentsSnapshot` (`ScheduledReviewPayload`, state `held`/`adopted`/`restored`; adopting inserts it as held rows), as does a Terminal send's `origin='immediate'` row. **A held row is "absent" for every reader** (`LIVE` = `heldBy IS NULL`; the guard test in `vst-store/tests/comment_holds.rs` fails on an unfiltered `comments` statement); only the purges, `list_comment_scopes` and the hold selects see it. The pin index is partial (`WHERE heldBy IS NULL`), so a restore renumbers a taken pin to max+1. Never a second copy: a failure path restores from the same marker/snapshot, once (the payload flip or the marker decides who wins).
- **Single writer.** `vst-review` writes comments; `vst-agents`/`vst-routes` reach it only through `ReviewPort`/`TurnObserver` (`JsonAgentRegistry::set_review_hooks`). Every terminal transition of a `channel='tmux'` row, Terminal comment sends included, goes through `TerminalDeliveryHandle`; `vst-review` reads the outcome from its `OutcomeObserver` (`Failed`/`Cancelled`/`Gone` restore, `Sent`/`Rearmed` keep the hold) and never writes a tmux row's state itself. `RowCapture` copies a row's snapshot just before a cancel / session removal deletes it.
- **Immediate rows** are inserted claimed + `waiting` (the 1 s poller never sees them), one pending per session (409 `delivery_in_flight`), never re-armed (reset or channel flip fail them), and the paste body is the Appendix A block built at fire time (`review_paste_body`, then `sanitize_paste_text` and the 32 KB cap).
- **Bodies are never logged** (ids and counts only), control/bidi characters are stripped or shown as `<U+202E>`, and a quote can never forge a `2) File:` line (body lines are indented).
- **Boot:** `reconcile_boot()` runs before `recover_orphans` (holds with a persisted user row are deleted, others restored; claimed json schedule rows and rows of vanished sessions restored; claimed immediate rows noted so their `error` reads `restart`).
- **Rich Chat never steers a review turn**, and the hold id travels in `EnqueueSpec`; a reset carry rehomes the hold to the carried turn's NEW id.

## @-mentions — draft-form vs wire-form

**Files:** `web-ui/src/lib/mentions.ts` · `web-ui/src/components/mentions/` · `web-ui/src/lexical/`

### The invariant

Mentions inside the editor, drafts, and all UI components below `useChat` use **draft-form** strings containing `{@kind [id, label]}` tokens. Conversion to wire (plain text + `mentions[]` sidecar) happens strictly at send/promotion seams (`useChat.send`/`saveEdit`, `firstTurn.ts`, `ChatPane` schedule, and `DraftComposer` start calls via `toWire` or `toPlainText`).

- **Hydrate with `fromWire` only at the 6 ingress points** (`MessageList.tsx` user items, `useChat` begin-edit, `QueuedTurnEditor`, `ChatPane` initial session load, history, retry).
- **Convert with `toWire` (with sidecar) or `toPlainText` (sidecar-less)** only at the designated send/start sites (`ReviewPicker` is one). Never drop IDs where sidecars cannot travel; `toPlainText` appends `(id=...)` for non-file mentions.
- **Plain text consumers use `renderDraftText`** (`lib/mentions.ts`, unescaped, files stay `@path`): stored comment text, the Terminal message, Copy message and a Terminal schedule's `text`. `toPlainText` is still `escapeSkillText`-escaped and would corrupt code in comments.
- **Never resolve a mention by name.** Mention identity is `{kind, id}`; labels are untrusted hints.
- **Key handlers register once and read refs.** `mentionStateRef` (`{ open, hasSelectable }`) is the single source of popover-open truth passed between plugins and handlers.
- **Adding a new mention kind touches exactly these places (and no hard-coded kind lists elsewhere):**
  1. `MentionKind` in `vst-types` (Rust) and `web-ui/src/api/types.ts`, same commit.
  2. One entry in `MENTION_KINDS` (`components/mentions/kinds.ts`): `kind`, `section`, `singular`, `title`, `Icon`, `caption`, `plainPrefix`, `plainValue`. This single entry already drives the `@section:` scope regex/lookup (`mentionQuery.ts`), the draft-token `isKnownMentionKind` check and `mentionPlainText` (`lib/mentions.ts`), the popover groups and `mentionRows.ts`. Do not add hard-coded copies of the kind list.
  3. One source hook in `useMentionSources.ts` (take `open`, return a stable empty result while closed) and its entry in the returned `Record<MentionKind, SourceResult>`.
  4. `mentionRows.ts` ranks non-file kinds client-side; `file` keeps server order (never re-filter/re-sort server-ranked kinds).
  5. Daemon: id-resolution/validation for the new kind. Tests for the kind def, the source hook and rows.
  Unknown kinds (stale clients) must keep rendering a generic chip: `mentionKindDef` never throws.

---

## Transcript search — one insert path, one index owner

**Files:** `rust/vst-store/src/transcript_search.rs` · `rust/vst-store/src/transcript.rs` · `rust/vst-agents/src/json_agent_session/transcript_search.rs` · `rust/vst-store/src/transcript_outline.rs`

- **The index unit is the contiguous text run**, not single delta rows, so words split across streaming chunks match.
- **Single writer path:** all message rows insert via `insert_message` (sole exception: `migrate_jsonl_into_db`), which also indexes in the same txn; a new `INSERT INTO message` fails `guard_single_insert_site`.
- **Lock discipline:** the store mutex is released between backfill chunks; `BACKFILL_CHUNK_ROWS` must not grow (keeps chunks well under rusqlite's 5s timeout). The whole-chat outline is a persisted `turn_outline` table (`turn_outline.rs`, single writer `OutlineWriter`: applied in `insert_message`'s txn only while `caught_up`, else by the read-driven chunked `catch_up_step` under `backfill_within`; fork deletes rows and bumps `revision`; nested `parentToolUseId` calls are never counted) read by `transcript_outline.rs` (`outline_summary` bucketed O(turns), `outline_window` O(limit)); labels are never logged.
- **Stale rebuilds:** `stale = 1` resets `message_fts` and `backfill_next_seq = 0`, then lazily backfills.
- **Privacy:** message/tool bodies are never logged (IDs and counts only).
- **Measured baseline (62 MB session):** 59 → 127 MB, append 0.03 → 0.21 ms, backfill ≈2 s.

---

## File scroll map — one owner, line-index mapping

**Files:** `web-ui/src/components/preview/scrollmap/` · `web-ui/src/hooks/useFileScrollMap.ts`

- **Line-index mapping, not `scrollTop / scrollHeight`:** line positions scale from line numbers, never raw scroll ratio.
- **Never DOM-per-line:** minimap uses chunked summary + canvas; files over `MINIMAP_MAX_LINES` (1,000,000) or `MINIMAP_MAX_BYTES` (25 MB) cap to marks.
- **Single writer & single toggle surface:** `useFileScrollMap` is the only writer of the setting; the preview-strip `ScrollMapToggle` (+ Settings) is the single toggle surface (there is no overflow menu item in `WorkspaceActions`); status feeds consumers via the single `onDisplayChange` path.
- **Default is the minimap (desktop default); `effectiveScrollMapMode` is the one resolver:** nothing is shown for files that fit; marks are shown for phones (`MOBILE_QUERY`), diffs, files over the cap, panes under `MINIMAP_MIN_PANE_WIDTH` (480px, border-box width) and when the worker is unavailable. Never add a second fallback condition in a component.
- **Scroll map jump contract:** `onJump(line)` puts that line at the top of the view (code line or diff row). Centring is the caller's job (`centeredTopLine`).
- **DOM boundary:** the scroll map reads another component's DOM in exactly two places — `scrollmap/codeLines.ts` (`CodeView` / `CodeLine` rows for the range, plus the diff rows for the thumb range) and `FilePreviewPane.handleDiffJump`. Both diff-side reads use `.diff-line[data-diff-row]` only, never `data-line`: the diff scale is the 1-based flattened hunk-row index (`DiffView`'s `lineRowIndex`, mirrored by `buildDiffMarks`), while `data-line` is the new-file line number — a hunk at line 800 in a 40-row diff would put the thumb off the track. Collapsed hunks render no rows but their indices still count, so never derive a diff row index from the DOM list position. `scrollmap/codeLines.contract.test.tsx` pins both DOMs (incl. a real `DiffView` starting past line 1) and must stay green when those selectors change. The scroll map re-measures on `scroll`, on resize and when the scroller's rows change (a `MutationObserver` in `ScrollMap`), because the code virtualiser mounts rows after the scroll event.

---

## Find in chat + turn chain — overlays in the chat viewport

**Files:** `web-ui/src/components/chat/find/` · `web-ui/src/components/chat/outline/`

- **Single nav channel:** `MessageNav` (`messageNav.ts`) is the only API find and outline use to move the list; `useChat` is the only owner of the event window. An outline jump to an unloaded turn goes through `useChat.viewAround` (a detached window: `useLoadLater` pages newer rows in near its bottom via `useChat.loadLater`, which rejoins the live tail once reached), never a fetch of its own. `hooks/useTranscriptOutline.ts` is the single owner of the whole-chat summary (`GET /sessions/:id/transcript/outline`: fixed-size bucketed counts, cached per session, refetched on `ws:open` / `session:fork` / a revision mismatch / a live user turn (debounced); bounded retry only while the index builds) and `hooks/useOutlineWindows.ts` of per-turn rows by index (`.../outline/window`); `mergeTurnOutline` overlays the loaded nodes on them (wire types: the outline types in `rust/vst-types` mirrored in `web-ui/src/api/types.ts`; rows are addressed by turn index and a stale `revision` refetches the summary), and without the endpoint (404, 503 or a non-JSON reply) the rail keeps the loaded window, its cap and the top-of-rail auto-load.
- **Hover never scrolls or fetches:** resting on find results only adds dashed rings or opens the preview; hovering the turn chain only brightens it. The chain's list opens only on press (one pointer-events path with pointer capture: drag scrubs the list, release jumps, a tap leaves a sticky list), a rail wheel, or Enter/Space. A wheel scrub moves the ring and auto-jumps the chat and closes the list once the wheel rests `WHEEL_JUMP_IDLE_MS` (never a rebuilt list); leaving rail + list commits a pending jump only if the session is `WHEEL_ARM_MS` old, a press/arrow/blur/Esc cancels it, and Enter/a click jumps at once. A wheel or drag scrub resting `SCRUB_TOP_LOAD_DWELL_MS` on the top row (or the cap) auto-loads earlier turns through `MessageList.startLoadEarlier` (one in flight and at most `SCRUB_TOP_LOADS_PER_REST` per rest, the auto-jump held until it settles, live trimming held while the list is open). A marked row resting on an unloaded turn fetches its outline window, then its around-window for steps only (`outline/useBeatWindows.ts`, LRU `BEAT_WINDOW_LRU`, stale requests aborted) and shows "Loading steps…" on that row; the scrub never waits for it.
- **Pure marks:** marks are a pure function of `(source, terms)` via `findTerms.ts`; parity is pinned by `rust/vst-store/tests/fixtures/transcript_search_cases.json`. One deliberate exception: the results-list hover ring sets `data-find-peek` on the matching marks imperatively and clears it on leave/unmount.
- **Focusable message viewport:** `.chat-pane__body` carries `tabIndex={-1}`, so a click into the transcript focuses it; the pane-scoped keys (Ctrl/Cmd+F seed-from-selection, F3/Shift+F3, Alt+↑/↓ turn jump, Alt+Enter, the Esc ladder) only arrive while focus is inside the pane; Ctrl/Cmd+F and F3 also fire from the footer/composer, which stays exempt from Alt+↑/↓, Alt+Enter and Esc.
- **Overlay hierarchy:** find bar/results and turn chain mount inside `.chat-pane__viewport`; the find trigger button lives in `.chat-font-overlay`, never in the workspace actions chip.
- **Beats / chain:** beats are a pure client-only second level (`outline/buildTurnBeats.ts`, cap 12 via `mergeBeats`); the chain is one SVG exactly as tall as the viewport, each turn and step at its flat-list position (`chainGeometry.ts`: y↔row, density rule), never one DOM node per turn; every turn's steps are always listed (nothing folds: no chevrons, ←→ or Collapse all) and every row shows its time at the right edge; the open list sits right of the chain, which stays on top, visible and pressable; jumps go through `MessageNav.scrollToAnchor` with `align: "center"` (`jumpAlign.ts`: row mid-viewport, top-aligned if too tall, clamped; find and Alt+↑/↓ keep the top) + `flashAnchor` (`jumpFlash.ts`, the one flash owner); no server or wire change.



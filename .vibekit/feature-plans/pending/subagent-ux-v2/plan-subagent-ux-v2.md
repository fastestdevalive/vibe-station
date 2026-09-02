<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Subagent UX v2

> Let an agent spawn a real, watchable VST session as a subagent — and show it to the user.

**Issue:** subagent-ux-v2
**Branch:** `subagent-ux-v2`
**Status:** Pending

**Reference files:**
- Env assembly: `daemon/src/services/spawn.ts:510-519`, `:708-716`; ACP child spawn `daemon/src/services/acp/acpTransport.ts:155`
- Agent guidance: shared L1 `daemon/src/assets/agent-system-prompt.md:76-104` (unchanged); Rich-Chat split at `daemon/src/services/jsonAgentChat.ts:173`
- Session routes: `daemon/src/routes/sessions.ts` — create `:475-495`, delete `:799`, reset `:1351`
- Parent→child field: `daemon/src/types.ts:368` — `spawnedFrom` today, `parentSessionId` after Phase 0
- Chat footer: `web-ui/src/components/layout/ChatPane.tsx:271-314`
- Kill UI: `web-ui/src/components/layout/TabsStrip.tsx:137`, `:752-786`

---

## Commit policy

- **Exactly two commits.** Phase 0 is one commit containing nothing but the rename; Phases 1-6 are one commit.
- Phase 0's diff must be reviewable by inspection — no behavior change, no new tests beyond the rename's own, no drive-by fixes.
- If a genuine bug surfaces during Phase 0, leave it and fix it in the second commit.

## Scope guard — do NOT do these

- Do not rename the SQLite column, and do not write a migration (Decision 15).
- Do not touch `docs/STATUS-INDICATORS.md` — the row adds no status bucket (Decision 9).
- Do not re-introduce anything from `c905422`: no `childByParent`, no `TaskToolEntry`, no `SubagentBanner`, no FIFO correlation.
- Do not add a server-side delete cascade (Decision 5), and do not change `DELETE /sessions/:id` at all.
- Do not add subagent guidance to the shared `agent-system-prompt.md` — Rich Chat only, via the new fragment (Decision 10).
- Do not add an index on the parent column, and do not add FK enforcement.
- Do not change `composeLaunchPrompt` in any plugin — it is not the prompt injection point.
- Do not add a `VST_PARENT_SESSION` env var — deferred, see Risk 4.

## What the user sees

| # | Change | Where | Phase |
|---|--------|-------|-------|
| 1 | Ask a Rich Chat agent to "delegate this to a subagent" and it actually spawns one — same worktree, same mode, and also a Rich Chat session rather than a terminal one | any Rich Chat session | 1-2 |
| 2 | A row appears above the composer, one line per live subagent: status dot, name, elapsed time | parent's chat, above the composer | 3 |
| 3 | Tapping a row opens that subagent — tiled beside the parent in workspace mode, as a tab in classic mode | parent's chat | 3 |
| 4 | The dot tracks the subagent's state (working → idle/done); the row goes away only when that session is terminated — exactly when its tab does | parent's chat | 3 |
| 4b | **The child shows its parent** — one row reading "↑ Parent · <name>"; tapping it navigates back to the parent | subagent's chat, above the composer | 3 |
| 5 | Killing a parent that has subagents says so, and the confirm button reads "Detach subagents & terminate" — they keep running | terminate dialog | 4 |
| 6 | A tool run's header stays one short line — "Ran 12 shell commands, read 4 files" — instead of growing a full clause per command until it fills the screen | any Rich Chat transcript | 5 |
| 7 | A `Task` tool call collapses into one row showing what the in-harness subagent did, instead of its tool calls spilling into the transcript | any Rich Chat transcript | 6 |

- **Nothing changes for terminal (tmux) sessions** — same prompt, same behavior, same spawning as today (Decision 10).
- **Phase 5 depends on nothing** and can ship before Phases 1-4.
- **"Parent"** is the only word for the spawning session — the code says `parentSessionId`, the DB column stays `spawnedFrom`, and `--source-agent` is the legacy flag; all three mean the same thing (Decision 15).
- **"Channel"** is the code's word for how a session runs: Rich Chat (`json`) or a terminal (`tmux`/`pty`) — `daemon/src/types.ts:64`.
  - It matters here only because a Rich Chat parent must not spawn a terminal child; nothing in the UI shows the word.

## Problem

- Spawning a subagent is broken end-to-end today: `$VST_SESSION` is empty in Rich Chat so the link is silently lost, mode and channel are not inherited so the child comes up as a terminal, and no UI ever shows the result.
- An agent asked to "spawn a subagent" therefore produces an orphaned session the user cannot find.

## Concept

- An agent runs one command, gets a real sibling session, and the user sees it as a row in the parent's chat.
- Subagents are real sessions — watchable, openable, and outliving the parent — not an in-harness abstraction.

## Out of Scope

- Auto-converting native `Task` calls into VST sessions.
- Cascade-terminating subagents when a parent dies — the spawning agent owns its subagents' lifecycle (Decision 5).
- Changes to the ACP protocol or the CLI binaries.
- Subagent trees deeper than one level in the UI — the row shows one level and links onward.
- Agent-beside-agent tiling in classic layout mode — see Decision 6.
- Cursor and agy native-`Task` rendering — neither emits task events.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `$VST_SESSION` is present in an agent's environment in every channel (tmux, direct-PTY, ACP) and for every CLI |
| 2 | A subagent inherits its parent's mode and channel (Rich Chat vs terminal) unless the spawning agent passes an explicit value |
| 3 | A session spawned by an agent is linked to it automatically, and the link survives a reset of either parent or child |
| 4 | Rich Chat agents are told their spawned sessions appear as subagents; terminal agents' prompt is byte-identical to today's |
| 5 | `--parent` is the documented flag; `--source-agent` still works, and either warns when passed explicitly but blank |
| 6 | The parent's chat lists its subagents above the composer for as long as those sessions exist, and a subagent's chat links back to its parent |
| 7 | Tapping a subagent row never unmounts a live pane, and never switches worktree in classic mode |
| 8 | Killing a parent detaches its subagents and says so explicitly; neither kill nor reset ever terminates a subagent |
| 9 | A CLI that emits no task events renders nothing — never an error |

---

## Research

### Env injection — the blocker

- **File:** `daemon/src/services/spawn.ts:510-519` (worktree), `:708-716` (direct) — `baseEnv` carries `VST_SESSION`, `VST_SPAWN_TOKEN`, `VST_WORKTREE`, `VST_PROJECT`, `VST_DATA_DIR`, `VST_DAEMON_URL`.
- **File:** `daemon/src/services/acp/acpTransport.ts:155` — ACP child spawns with `{...process.env, ...this.spec.env}` only.
- **Trigger:** any Rich Chat session, because `spec.env` is per-plugin and carries no VST vars.
  - `claude.ts:390-397` → `CLAUDE_CODE_EXECUTABLE`; `opencode.ts:64-71` → `OPENCODE_CONFIG`, `VST_SPAWN_TOKEN`; `cursor.ts:238-244` → none; `agy.ts:409-417` → `AGY_BIN`.
- **Risk:** HIGH — `agent-system-prompt.md:14` tells every agent it has `$VST_SESSION`, which is false in Rich Chat.
- Both spawn-site literals end with `...plugin.getEnvironment(launchCfg)` (`spawn.ts:517`, `:714`), which must stay put — opencode's has a side effect (writes the config file, `opencode.ts:307-320`).

### Mode and channel are not inherited

- **File:** `daemon/src/routes/sessions.ts:486-488` — `modeId` is **required** for agent sessions; 400 otherwise.
- **File:** `daemon/src/routes/sessions.ts:481-483` — channel defaults via `resolveUseTmux`; the CLI sends `channel: "json"` only with `--json` (`cli/src/commands/session/create.ts:66`).
- **Consequence:** a Rich Chat parent following the documented command gets a **tmux child**, so tapping its row opens a terminal, not a chat.
- There is no `VST_MODE` env var, so an agent cannot echo its own mode without an extra `vst session info` round-trip.

### Parent→child link — already built, do not rebuild

- **File:** `daemon/src/types.ts:368` — `spawnedFrom?: string | null`, write-once, no FK by design (doc comment `:357-367`).
- **File:** `daemon/src/services/dbSchema.ts:131` — column exists via `addColumnIfMissing`; no migration needed.
- **File:** `daemon/src/routes/sessions.ts:66,82` (zod `sourceAgentId`), `:580`, `:720` (persisted).
- **File:** `cli/src/commands/session/create.ts:24-27` (flag), `:58` (`$VST_SESSION` default), `:67` (conditional send).
- **Risk:** LOW — commit `1288bea` reverted only the UI correlation layer, not this.

### Guidance — one missing flag, and it must be Rich-Chat-only

- **File:** `daemon/src/assets/agent-system-prompt.md:76-104` — already documents Case A (`vst worktree create`) and Case B (`vst session create $VST_WORKTREE --type=agent --mode=<modeId> --prompt=…`).
- **Gap:** neither case says the spawned session becomes a visible subagent, and in Rich Chat the automatic link silently fails (empty `$VST_SESSION`).
- **File:** `daemon/src/services/promptBuilder.ts:26-40` — loads and caches L1 for **both** channels, so editing that file directly would change terminal agents too.
- **Split point:** `daemon/src/services/jsonAgentChat.ts:173`/`:181` is the **only** Rich Chat caller of `buildPrompt`/`buildDirectPrompt`.
  - The other nine callers (`routes/sessions.ts:215,276,1242,1260,1905,1923`, `routes/projects.ts:593,708`, `routes/worktrees.ts:500`) are all tmux `spawnSession` paths.
- `composeLaunchPrompt` is **not** the injection point — it returns `{useShell, shellLine, launchArgs, postLaunchInput}` and is not called on the ACP path.

### Reset

- **File:** `daemon/src/routes/sessions.ts:1351-1543` — archives the old row, mints a new id at `:1429`, builds a new record at `:1445-1470`.
- **Risk (child):** MEDIUM — the new record omits `spawnedFrom`, so a reset child is silently orphaned.
- **Risk (parent):** MEDIUM — a reset parent gets a new id while children still carry the old one, so the row list goes empty (see Decision 7).
- `supersededBy` is set on the archived old row pointing forward to the new id (`:1493`, broadcast `:1509`).

### Delete — detaching is already the behavior

- **File:** `daemon/src/routes/sessions.ts:799-922` — per-session delete, no cascade; children are untouched and keep running.
- **File:** `daemon/src/types.ts:357-367` — a dangling `spawnedFrom` after the parent is deleted is explicitly harmless by design.
- Session ids are slot-derived and never reused (`sessions.ts:529`), so a stale `spawnedFrom` can never match a future session.
- **Consequence:** "detach" needs no daemon work — the row vanishes with the parent and the children become ordinary sessions.
- **File:** `web-ui/src/components/layout/TabsStrip.tsx:137` (`terminateTarget`), `:752-786` (`ConfirmDialog` + `api.terminateSession`) — the dialog whose wording changes.

### UI surfaces

- **File:** `web-ui/src/components/layout/ChatPane.tsx:271-314` — footer is `QueuedTray` (`:272`) → `StatusBar` (`:286`) → `archived` ternary (`:294`) → `Composer` (`:301`).
- **File:** `web-ui/src/hooks/useStore.ts:270` (`insertTileIntoWorkspaceDoc`), `:288` (`insertTileIntoScratchCanvas`), `:734` (`setActiveSession`) — the real open APIs.
- `WorkspaceCanvas.tsx:603` `addTile` is a component-local closure and is **not callable** from `ChatPane`.
- **File:** `web-ui/src/hooks/useServerSync.ts:191-209` — already auto-tiles a `spawnedFrom` child next to its parent.
- **File:** `web-ui/src/components/chat/MessageList.tsx:13` (`RenderItem` union), `:101` (`groupEvents`), `:230-266` (tool cases) — nesting touches all three.
- **File:** `web-ui/src/components/chat/ToolRunSummary.tsx:14` (`BASH_TOOL_NAMES`), `:32` (`TOOL_ALIASES`), `:50` (`summarizeGroup`, module-private).

### The run header grows without bound

- **File:** `web-ui/src/components/chat/ToolRunSummary.tsx:50` — `summarizeGroup` buckets by `t.toolName.toLowerCase()`.
- **Trigger:** any ACP session, where `toolName` is the **full command string** (`ls -R /home/…`, `grep -n "useChat(" …`), not a tool name.
- **Effect:** every call lands in its own bucket, none match `PHRASE_FNS`, so each emits `used <entire command> 1 time` — one full-command clause per tool call.
- **Risk:** HIGH — the header always renders (`:214-228`), so a 20-tool run shows a 20-clause paragraph above the rows (reported screenshot).
- **Fix key:** `toolKind` is reliable and low-cardinality — real transcripts contain only `execute`, `read`, `edit`, `think`, `other`, `fetch` (vs-64 counts: 394/224/87/12/7/1).
- `PHRASE_ORDER` and `PHRASE_FNS` (`:39-48`) are already correct — only the bucket key is wrong.
- The `|| "Delegated to N subagents"` fallback at `:225` becomes dead once `summarizeGroup` always returns a phrase.

### Native Task events — verified against real transcripts

- Queried `~/.vibe-station/projects/vibe-station/session-data/vs-66/…/messages.db`: a subagent's own tool calls appear between the `Task` `tool_use` and its `completed` `tool_result`.
- The full `tool_use` payload key set is `id, sessionId, ts, provider, kind, role, toolId, toolName, toolInput, toolKind, toolStatus, turnId, logSeq, toolLocations, toolDiffs` — **no parent-link field**, and the same `sessionId`/`turnId` as the parent's own calls.
- Across 26 sampled Task calls (vs-62, vs-64, vs-66) no two Tasks were ever concurrently open, so positional bracketing is correct on all observed data.
- One counter-example exists: vs-64 seq 18 opens a Task and seq 23 opens a `Terminal` before it closes at seq 24 — hence the guards in Decision 4.
- Match on `toolName.toLowerCase() === "task"`; `toolKind` is `"think"`, shared with the Think tool.

---

## Design Details

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|----------------|--------|-----------------|
| Daemon → agent process (env) | `VST_SESSION`, `VST_WORKTREE`, `VST_PROJECT`, `VST_DATA_DIR`, `VST_DAEMON_URL`, `VST_SPAWN_TOKEN` — all `string` | absent var = unset, never empty string | `buildVstEnv` |
| CLI → Daemon (create) | `sourceAgentId?: string`, `modeId?: string`, `channel?: "json"` | `400 VALIDATION_ERROR`; unknown `sourceAgentId` accepted by design | daemon |
| Daemon ↔ DB | column `sessions.spawnedFrom TEXT NULL` ↔ record field `parentSessionId` | none | SQLite; translated in `sqliteRowMappers.ts` |
| Daemon → UI (WS) | `session:created \| session:updated \| session:deleted`, each carrying `parentSessionId`, `archivedAt`, `supersededBy` | none — one event per session, never batched | daemon |
| UI → UI (open a child) | `setActiveSession(id: string)` \| `insertTileIntoScratchCanvas(...)` | none | `useWorkspaceStore` |

- Unchanged contracts: `serializeSession()` output, `DELETE /sessions/:id` semantics, `POST /sessions` request shape.

### Critical User Journeys (CUJs)

#### CUJ 1 — Agent delegates, user watches

```
Agent decides a sub-task is worth watching
  → vst session create $VST_WORKTREE --type=agent --prompt "<sub-task>"
  → CLI links it automatically: sourceAgentId defaults to $VST_SESSION  (Decision 14)
  → daemon inherits mode + channel from the source session   (Decision 2)
  → persists parentSessionId = parent id, broadcasts session:created
  → parent's chat shows a row above the composer: ● <name> · 0s
  → user taps it
      workspace mode: child's tile focused beside the parent
      classic mode:   child activated as a tab in the same worktree
  → child finishes → its dot turns idle/done; the row REMAINS
  → parent agent runs `vst session terminate <id>` when the work is consumed
  → row and tab disappear together
```

- **Error path:** `$VST_SESSION` empty or blank → CLI warns naming the variable and still creates the session, unlinked.
- **Error path:** `sourceAgentId` names an unknown session → created unlinked, no 400 (existing design, `types.ts:357-367`).
- **Edge case:** parent is archived → rows still render; the composer is replaced by the archived banner (`ChatPane.tsx:294`).

#### CUJ 1b — What the transcript looks like (Phases 5 and 6)

Today — the header restates every command, and the subagent's calls are siblings of `Task`:

```
▾ Used ls -R /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-66/.vibekit/
  feature-plans/pending/chat-lru-retain/ 1 time, used find . -name useChat.ts -not
  -path '*/node_modules/*' 1 time, used wc -l .vibekit/feature-plans/pending/…
  1 time, used Read .vibekit/… 1 time, used grep -n "chatSubs\|openChat\|…
  [grows by one full-command clause per tool call, unbounded]
  ▸ 🔧 Task
  ▸ 🔧 Ran  ls -R /home/gb/…            ✓
  ▸ 🔧 Ran  find . -name useChat.ts     ✓
  ▸ 🔧 Read web-ui/src/hooks/useChat.ts ✓
  … 14 more rows, all siblings of Task
```

After Phase 5 — header is bounded, and never repeats a command:

```
▾ Ran 12 shell commands, read 4 files, delegated to 1 subagent
  ▸ 🔧 Task
  ▸ 🔧 Ran  ls -R /home/gb/…            ✓
  …
```

After Phase 6 — the subagent's calls nest under the Task that spawned them:

```
▾ Ran 3 shell commands, delegated to 1 subagent
  ▾ 🔧 Task · review the LRU retain plan · 6 tools · 41s   ✓
      ↳ Ran  find . -name useChat.ts        ✓
      ↳ Read web-ui/src/hooks/useChat.ts    ✓
      ↳ Ran  grep -n "chatSubs" …           ✓
  ▸ 🔧 Ran  wc -l .vibekit/…               ✓
```

- The Task row collapses by default, so a 40-call subagent occupies one line until opened.
- Phase 5 alone already fixes the reported screenshot; Phase 6 is the structural improvement on top.

#### CUJ 2 — User kills a parent that has subagents

```
User clicks terminate on the parent tab            (TabsStrip.tsx:137)
  → dialog names the live subagents and states they will KEEP RUNNING
  → confirm button reads "Detach subagents & terminate"
  → confirm → only the parent is deleted
  → subagents keep running, stay in the tab strip, become ordinary sessions
```

- **Edge case:** no live subagents → today's dialog and wording, unchanged.
- **Edge case:** a subagent spawned between dialog-open and confirm is unaffected — nothing is done to children either way.
- **Who cleans up:** the spawning agent, via `vst session terminate <id>` when the sub-task is done (taught in Phase 2).

### Data Model

| Entity | Field | Type | Constraints | Notes |
|--------|-------|------|-------------|-------|
| `SessionRecord` | `parentSessionId` | `string \| null` | nullable, no FK | **Exists as `spawnedFrom`** — renamed in Phase 0; DB column unchanged |
| `SessionRecord` | `supersededBy` | `string \| null` | nullable | **Exists** — set by reset on the archived row |
| `SessionRecord` | `archivedAt` | `string \| null` | ISO8601 | **Exists** — "live subagent" filter |

- **Relationships:** Session 1→N Session via `parentSessionId`; cycles impossible (write-once at creation).
- **Indexes:** none added — lookups are in-memory scans over a small array.
- **Migration:** N — no new columns; this plan only changes which values get written.

### API Contracts

```
POST /sessions                                   (request shape unchanged)
  Request:  { worktreeId, type, modeId?, channel?, prompt?, sourceAgentId? }
  Response: { session: Session }
  Errors:   400 VALIDATION_ERROR
            400 "'modeId' is required for agent sessions"  ← only when neither
                 modeId nor an inheritable sourceAgentId is given
  Change:   modeId and channel are inherited from sourceAgentId when omitted

POST /sessions/:id/reset                         (shape unchanged, behavior changed)
  Response: { ok, archivedSessionId, newSessionId }
  Change:   the new record carries parentSessionId forward

DELETE /sessions/:id                             (fully unchanged)
  Errors:   400 NO_SIBLING_ERROR
  Note:     children are untouched and keep running — see Decision 5
```

### Key Decisions

#### Decision 1: One `buildVstEnv()`, three call sites, in a leaf module

- **Decision:** extract the six VST vars into one helper and call it from both spawn sites and the ACP connection funnel.
- **Rationale:** "which vars does an agent get" must have exactly one answer, and a fifth CLI should get them for free.
- **Where:** new export in `daemon/src/services/context.ts` (leaf, already imported by both); called at `spawn.ts:511-516`, `:709-713`, and `jsonAgent.ts:1062` (`getOrCreateConnection`).
- Placing it in `context.ts` avoids giving `jsonAgent.ts` a runtime import of `spawn.ts` (today `jsonAgent.ts:19` imports it as `import type` only).

```ts
// Merged UNDER spec.env so a plugin keeps the last word on its own vars
// (CLAUDE_CODE_EXECUTABLE, OPENCODE_CONFIG must not be clobbered).
// worktree is nullable — direct sessions omit VST_WORKTREE entirely.
const env = { ...buildVstEnv({ project, worktree, session, daemonPort }), ...spec.env };
```

- `getOrCreateConnection` is the single funnel (only caller is the `:948` wiring) and is also the lazy-respawn path, so a reconnect keeps the env.
- Env staleness is a non-issue: `VST_SESSION` is the immutable session id, and a reset mints a new `JsonAgentSession` anyway.

#### Decision 2: The daemon inherits mode and channel from `sourceAgentId`

- **Decision:** when `sourceAgentId` resolves to a known session, `modeId` and `channel` default to that session's values; an explicit value always wins.
- **Rationale:** the user's rule is "explicit wins, inherit as fallback", and doing it daemon-side keeps the taught command a single line with no `vst session info` round-trip.
- **Where:** `daemon/src/routes/sessions.ts:481-488` — resolve before the `modeId` 400 check.
- Without this, a Rich Chat parent spawns a tmux child and the row opens a terminal instead of a chat.

#### Decision 3: Warn in the CLI, stay permissive in the daemon

- **Decision:** the daemon keeps accepting any `sourceAgentId`; the CLI warns when the value is empty or blank.
- **Rationale:** dangling ids are harmless by design, but a silently unlinked subagent is the bug this plan exists to remove.
- **Where:** `cli/src/commands/session/create.ts:58` — test truthiness, not nullishness, since `??` lets `VST_SESSION=""` through to the falsy spread at `:67`.

#### Decision 4: Native Task grouping is display-only

- **Decision:** positional bracketing renders a sub-thread and never decides identity, navigation, or lifecycle.
- **Rationale:** no payload carries a parent link, and real data already contains a case where a non-subagent tool opens inside a Task's window.
- **Where:** `web-ui/src/components/chat/MessageList.tsx:13`, `:101`, `:230-266`.

```ts
// Guards — a mis-bracket must never swallow the transcript:
//  1. close any open bracket at end of turnId
//  2. a second Task opening while one is open closes the first and stops nesting
//  3. match on toolName.toLowerCase() === "task" — NEVER toolKind ("think" is shared)
```

#### Decision 5: Killing a parent detaches, never cascades

- **Decision:** deleting a parent leaves its subagents running; the dialog's confirm button reads "Detach subagents & terminate".
- **Rationale:** the spawning agent knows when a sub-task is finished and the user does not — so lifecycle belongs to the agent, and a cascade would kill work the user can still see and use.
- **Where:** `web-ui/src/components/layout/TabsStrip.tsx:752-786` — wording only; no delete logic changes.
- Detach is free: nothing is written on delete, and a dangling parent id is harmless by design (`types.ts:357-367`).
- A cascade would also have to solve deepest-first ordering and `NO_SIBLING_ERROR` partial failures — cost with no demand.

#### Decision 6: Tile in workspace mode, tab otherwise, never cross-worktree

- **Decision:** tapping focuses/inserts a tile in workspace-canvas mode, else calls `setActiveSession`; a child in a different worktree is not opened, only labelled.
- **Rationale:** classic mode's second slot is a tool panel, and switching worktree tears down that worktree's panes, violating the AGENTS.md terminal invariant (`AGENTS.md:7-43`) and Requirement 7.
- **Where:** `web-ui/src/hooks/useStore.ts:270`/`:288` (tile), `:734` (tab).
- Subagents are same-worktree by default (Decision 8), so cross-worktree is the rare case.

#### Decision 7: Rows resolve the parent's ancestry, not just its current id

- **Decision:** row derivation matches children against the parent's id **and** its archived predecessors, found by walking `supersededBy` backwards.
- **Rationale:** a parent reset mints a new id while live children still carry the old one, so a naive `parentSessionId === sessionId` filter goes empty after any parent reset.
- **Where:** the row-derivation helper in `web-ui/src/components/chat/SubagentRow.tsx`.
- Child-side reset needs no UI work: once Phase 1.4 carries `parentSessionId` forward, the predecessor collapses into its successor for free.

#### Decision 8: Same worktree, inherited mode — both as fallbacks only

- **Decision:** taught guidance uses `$VST_WORKTREE` and omits `--mode`; an explicit user instruction (e.g. "review this in opus mode") overrides either.
- **Rationale:** the user's stated rule; same-worktree spawning already works correctly today and needs no code change.
- **Where:** the Rich-Chat-only fragment (Decision 10), not the shared L1 file.

#### Decision 10: Subagent guidance is Rich-Chat-only

- **Decision:** the subagent guidance ships as a separate asset appended to L1 only when the session's channel is `json`.
- **Rationale:** only Rich Chat has a subagent row to make a VST sibling worth spawning — a terminal agent asked for "a subagent" should use its own in-harness `Task` tool instead.
- **Where:** new `daemon/src/assets/agent-subagent-richchat.md`; appended by `promptBuilder.ts` behind a `richChat?: boolean` input, set true only at `jsonAgentChat.ts:173`/`:181`.

```ts
// Default false, so all nine tmux call sites keep today's prompt byte-for-byte.
// The flag is the ONLY thing that distinguishes the two channels' L1.
export interface BuildPromptInput { …; richChat?: boolean }
```

- Editing `agent-system-prompt.md:96-101` in place is the wrong fix — it is shared, and it would teach terminal agents a flag whose payoff they cannot see.
- Terminal agents keep spawning plain `vst` sessions exactly as today; those are simply not *labelled* subagents.

#### Decision 14: Agents never pass `--source-agent`; the link is automatic

- **Decision:** taught guidance omits `--source-agent` entirely and relies on the CLI's existing `$VST_SESSION` default.
- **Rationale:** the default already exists and is the documented intent — "source-agent affinity for free without passing `--source-agent` explicitly" (`cli/src/commands/worktree/create.ts:60-66`).
- **Where:** `cli/src/commands/session/create.ts:58`; nothing to build, only prompt text not to write.
- The flag stays for callers that are **not** running inside an agent's shell — OpenClaw, CI, a human script — where `$VST_SESSION` is legitimately unset.
- Consequence: `1.6`'s warning fires only when the flag was passed **explicitly** and resolved blank; an unset `$VST_SESSION` in a human terminal stays silent, as it does today.

#### Decision 15: "Source agent" and "parent" are one concept — say parent

- **Decision:** source agent ≡ parent session; the product, the prompt text, and this plan say **parent** everywhere, and `--parent` becomes the documented flag name.
- **Rationale:** there is no case where the spawning session is not the parent — the two words exist only because `spawnedFrom` was built for workspace-tile affinity (`useServerSync.ts:191-209`), not for a parent/child UX.
- **Where:** `cli/src/commands/session/create.ts:24-27` and `worktree/create.ts:32` gain `--parent` as an alias.
- `--source-agent` keeps working, undocumented, so external callers (OpenClaw, CI) do not break.
- The invariant that makes the unification concrete and testable:

```
child.parentSessionId  ===  parent.VST_SESSION
```

- **Every TypeScript surface is renamed to `parentSessionId`** — `types.ts`, `api/types.ts`, `ws/protocol.ts`, both route files, and the web-ui consumers (Phase 0).
- **The SQLite column stays `spawnedFrom`**, translated in `daemon/src/state/sqliteRowMappers.ts` — that mapping seam already exists, so no migration and no rollout skew.
- `VST_SESSION` is likewise not renamed: it means "your own session id" and is correct in every existing use (`cli/src/lib/env.ts:10`, `agent-system-prompt.md:14`).

```ts
// sqliteRowMappers.ts is the ONLY place the two names meet.
rowToSession:  parentSessionId: row.spawnedFrom ?? null,
sessionToRow:  spawnedFrom: s.parentSessionId ?? null,
```

#### Decision 13: A row lives exactly as long as its tab

- **Decision:** the row list is the tab strip filtered to this session's children — same lifetime, same archived treatment.
- **Rationale:** a session does not end when its task ends; it goes `idle`/`done` and stays openable, so removing the row would hide a session whose tab is still right there.
- **Where:** row derivation in `web-ui/src/components/chat/SubagentRow.tsx`.
- `TabsStrip` keeps archived sessions as tabs (`TabsStrip.tsx:564` styles them, it does not filter them), so the row must too.
- The **only** thing that clears a row is deleting the session — which is why Phase 2.3b tells the spawning agent to terminate a subagent once its work is consumed.
- Consequence: rows accumulate across a long parent session, which is what the 5-row cap plus `+N more` is for.
- Exception: a reset predecessor is replaced by its successor rather than shown twice (Decision 7).

#### Decision 12: One component renders both directions

- **Decision:** the same row component renders the parent's list of children **and** the child's single link back to its parent.
- **Rationale:** both are "a session related to this one, with a status dot, that opens on tap" — two components would duplicate the open logic and drift apart.
- **Where:** `web-ui/src/components/chat/SubagentRow.tsx`, rendered once in `ChatPane.tsx`.
- Child→parent resolves `session.parentSessionId`, then follows `supersededBy` **forward** when that parent has been reset (the mirror of Decision 7's backward walk).
- A parent that was deleted leaves a dangling id (Decision 5); the row is then simply not rendered.

#### Decision 11: Bucket the run header by `toolKind`, and cap it

- **Decision:** `summarizeGroup` buckets on `toolKind`, falls back to `toolName` only when `toolKind` is absent, and caps the result at four clauses.
- **Rationale:** `toolName` is the full command in ACP sessions, so keying on it guarantees one clause per call and unbounded growth.
- **Where:** `web-ui/src/components/chat/ToolRunSummary.tsx:50-76`.

```ts
// toolKind is low-cardinality and reliable; toolName is a whole shell command.
// Task is detected by NAME first — its kind is "think", shared with Think.
const KIND_BUCKET: Record<string, string> = {
  execute: "bash", read: "read", edit: "edit",
  search: "search", fetch: "fetch", think: "think",
};
const key = isTask(t) ? "task"
  : KIND_BUCKET[t.toolKind ?? ""] ?? TOOL_ALIASES[raw] ?? raw;
```

- A name-derived fallback label is truncated to 24 chars, so one stray tool can never restore the old behavior.
- Header text is bounded at four clauses plus `+N more`, independent of run length.

#### Decision 9: The subagent row shows lifecycle only, no PR axis

- **Decision:** `StatusDot` is passed `pr={null}`.
- **Rationale:** PR state is per-worktree and every subagent shares the parent's worktree, so a PR dot would repeat the parent's own status on every row.
- **Where:** `web-ui/src/components/chat/SubagentRow.tsx`; no `docs/STATUS-INDICATORS.md` change, since no matrix cell changes (`AGENTS.md:185-197`).

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does inheriting `channel` surprise anyone?** | A tmux parent spawns a tmux child; only Rich Chat parents change behavior — verify no CI/script relies on the tmux default |
| 2 | **Should terminal agents ever get the guidance?** | No for now (Decision 10); revisit if a subagent row ever appears outside Rich Chat |
| 3 | **Row cap of 5** | Placeholder; revisit once real parallel usage exists |
| 4 | **Should a subagent be able to message its parent?** | Deferred — needs a `VST_PARENT_SESSION` env var, and nothing in this plan requires it |

---

## Implementation Phases

### Phase 0 — Rename `spawnedFrom` → `parentSessionId` (mechanical; land first)

- [x] **0.1** Rename the field on `SessionRecord` (`daemon/src/types.ts:368`) and in `web-ui/src/api/types.ts`
- [x] **0.2** Rename in both route files (`daemon/src/routes/sessions.ts` ×5, `worktrees.ts` ×2) and `daemon/src/ws/protocol.ts`
- [x] **0.3** Translate at the DB seam only — `daemon/src/state/sqliteRowMappers.ts` maps `row.spawnedFrom` ↔ `parentSessionId`; leave `dbSchema.ts` untouched
- [x] **0.4** Rename in web-ui consumers: `useServerSync.ts`, `useStore.ts`, `routes/Workspace.tsx`
- [x] **0.5** Rename in `daemon/src/state/project-store.ts` and update the ~33 test references
- [x] **0.6** Update the documented session JSON shape in `skill/SKILL.md:197` — an external contract read by non-vibe-station agents
- [x] **0.7** Delete `docs/SUBAGENT-UX-PREVIEW.md` — it describes the reverted `c905422` UI in the present tense and would mislead every future reader of this feature

**Verify phase 0:**
- [x] **0.T1** Regression — full suite green with no behavior change (`cd cli && npx vitest run`, `cd web-ui && npx vitest run`)
- [x] **0.T2** Integration — `sqliteRowMappers`: a row written with `parentSessionId` reads back from the `spawnedFrom` column and round-trips
- [x] **0.T3** Regression — an existing DB created before this change still loads its parent links
- [x] **0.T4** Grep gate — `spawnedFrom` appears in exactly two files: `sqliteRowMappers.ts` and `dbSchema.ts`
- [x] **0.T5** Grep gate — no remaining source or doc file describes `spawnedFrom` as part of the session payload

---

### Phase 1 — Make the mechanism real (daemon + CLI)

**Most of this already exists.** The plumbing to record a parent→child link was built by earlier work and survived the `c905422` revert untouched. Phase 1 changes four behaviors and refactors one thing; it builds no new storage, no new field, and no new endpoint.

| Already works today | Where |
|---|---|
| `--source-agent <id>` flag, defaulting to `$VST_SESSION` | `cli/src/commands/session/create.ts:24-27`, `:58` |
| CLI sends `sourceAgentId` in the create body | `create.ts:67` |
| Route accepts it (both worktree and direct bodies) | `sessions.ts:66`, `:82` |
| Route persists it to `spawnedFrom` | `sessions.ts:580`, `:720` |
| Column exists, no migration needed | `dbSchema.ts:131` |
| Every session payload exposes `spawnedFrom` to the UI | `sessions.ts:394` |
| `VST_SESSION` + five other vars reach tmux/direct-PTY agents | `spawn.ts:510-519`, `:708-716` |

| What Phase 1 actually adds | Item | Kind |
|---|---|---|
| `VST_SESSION` reaches **Rich Chat** agents — today it does not, so the CLI's automatic link resolves to nothing and is silently dropped | 1.3 | new behavior |
| A subagent inherits its parent's **mode and channel** — today `modeId` is required and channel defaults to tmux, so a Rich Chat parent spawns a terminal child | 1.5 | new behavior |
| Reset **keeps** `spawnedFrom` — today the replacement record drops it and the child is orphaned | 1.4 | new behavior, one line |
| The CLI **warns** instead of silently creating an unlinked session | 1.6 | new behavior |
| One `buildVstEnv()` instead of two copies of the same literal | 1.1, 1.2 | refactor, no behavior change |

Net effect — the same command, before and after:

```
agent runs: vst session create $VST_WORKTREE --type=agent --prompt "..."
            (no --source-agent — the CLI defaults it from $VST_SESSION)

today (from Rich Chat):  400 — 'modeId' is required
  …and with --mode added: creates a TMUX session, spawnedFrom = null
                          ($VST_SESSION unset in Rich Chat, so the default
                           resolved to nothing and the field was omitted)

after Phase 1:           creates a RICH CHAT session in the parent's mode,
                          parentSessionId = parent id, and it survives a reset
```

- [ ] **1.1** Add `buildVstEnv({project, worktree, session, daemonPort})` to `daemon/src/services/context.ts`
- [ ] **1.2** Use it at `spawn.ts:511-516` and `:709-713`, replacing the six VST keys and **keeping** the `...plugin.getEnvironment(launchCfg)` spread
- [ ] **1.3** Merge it under `spec.env` in `daemon/src/services/jsonAgent.ts:1062` (`getOrCreateConnection`)
- [ ] **1.4** Carry the link through reset: `parentSessionId: session.parentSessionId ?? null` at `daemon/src/routes/sessions.ts:1445-1470`
- [ ] **1.5** Inherit `modeId` and `channel` from `sourceAgentId` at `daemon/src/routes/sessions.ts:481-488`, before the 400 check
- [ ] **1.6** Warn only when `--source-agent` was passed explicitly and resolved blank (`cli/src/commands/session/create.ts:58`); stay silent when it was never passed
- [ ] **1.7** Add `--parent <sessionId>` as the documented alias of `--source-agent` on `session create` and `worktree create`

**Verify phase 1:**
- [ ] **1.T1** Unit — `buildVstEnv`: returns all six vars for a worktree session; omits `VST_WORKTREE` when `worktree` is null
- [ ] **1.T2** Integration — ACP spawn: a plugin with empty `spec.env` gets `VST_SESSION` equal to the session id
- [ ] **1.T3** Regression — ACP spawn: `CLAUDE_CODE_EXECUTABLE` still wins over the VST block; opencode's `getEnvironment` side effect still runs once
- [ ] **1.T4** Integration — `sessions.reset`: resetting a session with `parentSessionId` set yields a new record with the same value
- [ ] **1.T5** Integration — `sessions.create`: `sourceAgentId` pointing at a json-channel session with no `modeId`/`channel` creates a json child with the parent's mode
- [ ] **1.T6** Regression — `sessions.create`: no `sourceAgentId` and no `modeId` still 400s with `'modeId' is required for agent sessions`
- [ ] **1.T7** Unit — `session create`: an explicit `--source-agent ""` warns and still creates the session
- [ ] **1.T8** Regression — `session create`: no flag and no `$VST_SESSION` (human terminal) creates the session with no warning and no `sourceAgentId`
- [ ] **1.T9** Integration — the invariant: a child's `parentSessionId` equals the parent's `VST_SESSION`
- [ ] **1.T10** Unit — `session create`: `--parent` and `--source-agent` produce an identical request body

---

### Phase 2 — Teach Rich Chat agents only

- [ ] **2.1** New `daemon/src/assets/agent-subagent-richchat.md` — spawning a session here creates a visible subagent, linked automatically (no `--source-agent` to pass)
- [ ] **2.2** State that mode and channel are inherited and that an explicit user instruction overrides them (Decision 8)
- [ ] **2.3** State when to delegate: a VST subagent for work worth watching, the CLI's own `Task` tool for short lookups
- [ ] **2.3b** State that the spawning agent owns its subagents' lifecycle — run `vst session terminate <id>` when a sub-task is done (Decision 5)
- [ ] **2.4** Add `richChat?: boolean` to `BuildPromptInput`/`BuildDirectPromptInput` and append the fragment when true (`promptBuilder.ts:46-57`, `:67`, `:120`)
- [ ] **2.5** Set `richChat: true` at `jsonAgentChat.ts:173` and `:181` — and nowhere else
- [ ] **2.6** Leave `agent-system-prompt.md` unchanged; leave `skill/SKILL.md` unchanged unless an external agent needs the same command

**Verify phase 2:**
- [ ] **2.T1** Unit — `promptBuilder`: `richChat: true` output contains the subagent section; default output does not
- [ ] **2.T2** Regression — `promptBuilder`: default (no flag) output is byte-identical to today's for both `buildPrompt` and `buildDirectPrompt`
- [ ] **2.T3** Unit — `jsonAgentChat`: `buildSystemPrompt` passes `richChat: true` for both the worktree and direct paths
- [ ] **2.T4** Integration — live spawn: a Rich Chat agent told "delegate X to a subagent" produces a session whose `parentSessionId` is the parent id and whose channel is `json`

---

### Phase 3 — Subagent row + opening

- [ ] **3.1** New `web-ui/src/components/chat/SubagentRow.tsx` — one row per live child, `StatusDot` with `pr={null}`, `QueuedTray` styling
- [ ] **3.2** Row derivation: every non-deleted child whose `parentSessionId` matches the parent's id or any archived predecessor (Decision 7), collapsing a reset predecessor into its successor
- [ ] **3.3** Render in `ChatPane.tsx` between `StatusBar` (`:286`) and the `archived` ternary (`:294`), so archived parents still show rows
- [ ] **3.4** Tap handler — tile via `useStore.ts:270`/`:288` in workspace mode, else `setActiveSession` (`:734`); a different-worktree child renders disabled with a tooltip
- [ ] **3.5** Cap at 5 rows with a `+N more` affordance
- [ ] **3.6** Parent link: when `session.parentSessionId` is set, render one row "↑ Parent · <name>" above any child rows
- [ ] **3.7** Resolve a reset parent by following `supersededBy` forward; render nothing when the parent was deleted

**Verify phase 3:**
- [ ] **3.T1** Unit — `SubagentRow`: renders nothing when the parent has no children; one row per child
- [ ] **3.T1b** Unit — `SubagentRow`: a child in state `done` still renders, with a done dot — the row is not removed on completion
- [ ] **3.T2** Unit — `SubagentRow`: a reset child shows once, as its successor; an archived-but-not-superseded child still shows, styled archived
- [ ] **3.T3** Unit — `SubagentRow`: after a parent reset, children carrying the predecessor id still render
- [ ] **3.T4** Integration — WS: a `session:created` carrying `parentSessionId` adds a row with no refetch
- [ ] **3.T5** Integration — open: tapping a same-worktree row in classic mode calls `setActiveSession` with the child id
- [ ] **3.T6** Unit — `SubagentRow`: a session with `parentSessionId` set renders exactly one "↑ Parent" row; a root session renders none
- [ ] **3.T7** Unit — `SubagentRow`: a parent that was reset resolves through `supersededBy` to the live successor; a deleted parent renders nothing
- [ ] **3.T8** Integration — open: tapping the parent row activates the parent session
- [ ] **3.T9** Regression — `ChatPane`: composer position, queued tray, and the archived banner are unchanged when no subagents exist

---

### Phase 4 — Detach-on-kill dialog (wording only)

- [ ] **4.1** When the terminate target has live subagents, name them in the `ConfirmDialog` body and state they will keep running (`TabsStrip.tsx:752-786`)
- [ ] **4.2** Change the confirm label to "Detach subagents & terminate" in that case only
- [ ] **4.3** Leave `api.terminateSession` and the delete path untouched (`TabsStrip.tsx:777`)

**Verify phase 4:**
- [ ] **4.T1** Unit — `TabsStrip`: a target with live subagents shows their names and the "Detach subagents & terminate" label
- [ ] **4.T2** Integration — confirm: only the parent is deleted; the subagents remain in the store and in the tab strip
- [ ] **4.T3** Regression — `TabsStrip`: a target with no subagents shows today's dialog, label, and delete behavior unchanged

---

### Phase 5 — Fix the run header (independent; ship first)

- [ ] **5.1** Bucket `summarizeGroup` by `toolKind` via `KIND_BUCKET`, falling back to `TOOL_ALIASES`/`toolName` only when `toolKind` is absent (`ToolRunSummary.tsx:50-76`)
- [ ] **5.2** Detect Task by name before kind and give it a `task` bucket — "delegated to N subagents"
- [ ] **5.3** Truncate any name-derived fallback label to 24 chars
- [ ] **5.4** Cap the header at 4 clauses, appending `+N more`
- [ ] **5.5** Add `"terminal": "bash"` to `TOOL_ALIASES` (`:32`) — one-line insurance for any session reporting no `toolKind`, which would otherwise regress to the unbounded header
- [ ] **5.6** In `ToolRunEntryRow`, fall back to `toolName` when `tool.toolKind === "execute" && !BASH_TOOL_NAMES.has(name)` — the ACP case where `toolName` IS the command
- [ ] **5.7** Drop the now-dead `|| "Delegated to N subagents"` fallback at `:225`

**Verify phase 5:**
- [ ] **5.T1** Unit — `summarizeGroup`: 12 `execute` + 4 `read` calls with distinct command-string `toolName`s produce "Ran 12 shell commands, read 4 files"
- [ ] **5.T2** Unit — `summarizeGroup`: header length is unchanged between a 20-call and a 200-call run of the same kinds
- [ ] **5.T3** Unit — `summarizeGroup`: six distinct kinds render 4 clauses plus "+2 more"
- [ ] **5.T4** Unit — `summarizeGroup`: a Task call reads "delegated to 1 subagent", not "thought 1 time"
- [ ] **5.T5** Unit — `summarizeGroup`: a tool with no `toolKind` and a 200-char `toolName` yields a clause ≤ 40 chars
- [ ] **5.T6** Regression — `ToolRunSummary`: native (non-ACP) runs with real tool names summarize exactly as before

---

### Phase 6 — Native Task sub-thread

- [ ] **6.1** Add a children field to the `RenderItem` tool variant (`MessageList.tsx:13`) and bracket Task groups in `groupEvents` (`:101`, `:230-266`)
- [ ] **6.2** Apply the three guards from Decision 4
- [ ] **6.3** Read the task description from the first result chunk; label `Task` until it arrives
- [ ] **6.4** Render nested children under their Task row in `ToolRunSummary`

**Verify phase 6:**
- [ ] **6.T1** Unit — `groupEvents`: events between a Task's start and its completed result nest under it
- [ ] **6.T2** Unit — `groupEvents`: an unterminated Task closes at the end of its `turnId` and does not swallow later turns
- [ ] **6.T3** Unit — `groupEvents`: a second Task opening while one is open closes the first and stops nesting
- [ ] **6.T4** Regression — `MessageList`: a transcript with no Task events groups exactly as before

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/types.ts` | **Modified** | 0.1 | `spawnedFrom` → `parentSessionId` on `SessionRecord` |
| `web-ui/src/api/types.ts` | **Modified** | 0.1 | Same rename on the client `Session` type |
| `daemon/src/ws/protocol.ts` | **Modified** | 0.2 | Same rename on session WS events |
| `daemon/src/state/sqliteRowMappers.ts` | **Modified** | 0.3 | Contract: translates column `spawnedFrom` ↔ field `parentSessionId` · the only place both names appear |
| `daemon/src/routes/worktrees.ts` | **Modified** | 0.2 | Same rename |
| `daemon/src/state/project-store.ts` | **Modified** | 0.5 | Same rename |
| `web-ui/src/hooks/useStore.ts` | **Modified** | 0.4, 3.4 | Rename; tile/tab open APIs used by the row |
| `web-ui/src/routes/Workspace.tsx` | **Modified** | 0.4 | Same rename |
| `daemon/src/services/dbSchema.ts` | **Unchanged** | — | Column stays `spawnedFrom` — no migration (Decision 15) |
| `skill/SKILL.md` | **Modified** | 0.6 | Documented session JSON shape — external contract |
| `docs/SUBAGENT-UX-PREVIEW.md` | **Deleted** | 0.7 | Documents the reverted `c905422` UI as if it shipped |
| `daemon/src/services/context.ts` | **Modified** | 1.1 | Contract: `buildVstEnv(opts): Record<string,string>` — single source of VST env · Owns: nothing (pure) |
| `daemon/src/services/spawn.ts` | **Modified** | 1.2 | Use `buildVstEnv`; keep the `plugin.getEnvironment` spread |
| `daemon/src/services/jsonAgent.ts` | **Modified** | 1.3 | Merge `buildVstEnv()` under `spec.env` in `getOrCreateConnection` |
| `daemon/src/routes/sessions.ts` | **Modified** | 0.2, 1.4, 1.5 | Rename to `parentSessionId`; reset carries it; create inherits `modeId`/`channel` |
| `cli/src/commands/session/create.ts` | **Modified** | 1.6, 1.8 | `--parent` alias; warn only on an explicit blank value; never fail |
| `daemon/src/assets/agent-subagent-richchat.md` | **New** | 2.1-2.3 | Rich-Chat-only L1 fragment — automatic linking, inheritance, when to delegate, lifecycle |
| `daemon/src/services/promptBuilder.ts` | **Modified** | 2.4 | Contract: `BuildPromptInput.richChat?: boolean` — appends the fragment when true |
| `daemon/src/services/jsonAgentChat.ts` | **Modified** | 2.5 | Pass `richChat: true` from `buildSystemPrompt` (both paths) |
| `daemon/src/assets/agent-system-prompt.md` | **Unchanged** | — | Shared L1 stays byte-identical so terminal agents are unaffected |
| `web-ui/src/components/chat/SubagentRow.tsx` | **New** | 3.1-3.7 | Contract: `({sessionId, onOpen}) => JSX` — parent link + live child rows · Owns: nothing |
| `web-ui/src/components/layout/ChatPane.tsx` | **Modified** | 3.3 | Render `SubagentRow` above the archived/composer branch |
| `web-ui/src/components/layout/TabsStrip.tsx` | **Modified** | 4.1-4.2 | Detach wording in the existing terminate `ConfirmDialog`; no delete-logic change |
| `web-ui/src/components/chat/MessageList.tsx` | **Modified** | 6.1-6.3 | Contract: `RenderItem` tool variant gains children; `groupEvents` nests Task groups |
| `web-ui/src/components/chat/ToolRunSummary.tsx` | **Modified** | 5.1-5.7, 6.4 | Contract: `summarizeGroup` buckets by `toolKind`, capped at 4 clauses · bash fallback · nested child rendering |
| `daemon/src/__tests__/vstEnv.test.ts` | **New** | 1.T1-1.T3 | `buildVstEnv` + ACP env merge |
| `daemon/src/__tests__/sessions.parentSession.test.ts` | **New** | 1.T4-1.T6 | Reset preserves the link; create inherits mode/channel |
| `cli/src/__tests__/session-create.test.ts` | **Modified** | 1.T7-1.T8, 1.T11 | Blank-value warning, silent human-terminal path, `--parent` alias |
| `cli/src/commands/worktree/create.ts` | **Modified** | 1.8 | `--parent` alias |
| `daemon/src/__tests__/promptBuilder.test.ts` | **Modified** | 2.T1-2.T3 | Fragment present with `richChat`, absent by default |
| `web-ui/src/components/chat/SubagentRow.test.tsx` | **New** | 3.T1-3.T8 | Child rows, parent link, ancestry/successor, tap behavior |
| `web-ui/src/components/layout/TabsStrip.test.tsx` | **Modified** | 4.T1-4.T3 | Detach wording, subagents survive, no-subagent regression |
| `web-ui/src/components/chat/MessageList.test.tsx` | **Modified** | 6.T1-6.T4 | Task bracketing and guards |
| `web-ui/src/components/chat/ToolRunSummary.test.tsx` | **Modified** | 5.T1-5.T6 | Bounded header: kind bucketing, clause cap, Task phrasing, regression |

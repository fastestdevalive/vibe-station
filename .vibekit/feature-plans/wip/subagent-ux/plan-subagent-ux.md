---
Issue: N/A
Branch: chat-encapsulated-persistent
Status: planning (revised after opus review)
PRD: N/A (small feature, no PRD needed)
---

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Subagent UX — persistent status line, dedicated Task entry, SubagentBanner

## Problem

- When Claude fires a `Task` tool (spawning an inline subagent), the parent chat shows a generic collapsed row: "used task 1 time" — no live status of what the child is doing
- The `Task` tool entry title grows bloated; there is no way to see child progress inline
- Child vibe-station sessions (created by the agent calling `vst session create`) have no contextual framing or navigation back to the parent when viewed in chat

## Concept

- **Child-session correlation**: when `session:created` fires with `spawnedFrom = parentSessionId`, the client matches it to the earliest unresolved `task` tool_use in the parent's event stream; no daemon changes needed
- **Task tool entry**: a dedicated, live-updating `TaskToolEntry` component renders `↳ {currentToolName} {title}` while the child runs, and `↳ N tools · Xms` on completion; clicking navigates to the child session
- **SubagentBanner**: a slim banner above the Composer when `session.spawnedFrom` is set — shows the parent session name and a navigate-to-parent affordance
- **Refcounted chat subscriptions**: `openChat`/`closeChat` become refcounted so multiple concurrent subscribers to the same sessionId (e.g. the child's own `ChatPane` + the parent's `TaskToolEntry`) don't clobber each other

## Requirements

| # | Requirement |
|---|-------------|
| R1 | `openChat`/`closeChat` in `client.ts` are refcounted — a `Map<sessionId, refCount>` replaces the `Set`; `chat:close` is only sent when the count drops to zero |
| R2 | When `session:created` fires with `spawnedFrom === parentSessionId`, the client records `(parentSessionId, childSessionId)` in FIFO order in a store map; the earliest entry is consumed when a `task` tool_use needs a child |
| R3 | `ToolCallEntry` gains a `childSessionId?: string` field, populated in `groupEvents` using the store map |
| R4 | `task` tool entries in `ToolRunSummary` render as `TaskToolEntry` only when `live === true` and `tool.result` is absent; completed/historical task entries fall back to `ToolRunEntryRow` showing the `tool.result` text |
| R5 | `TaskToolEntry` subscribes to the child session's events via `useChat(api, childSessionId, !!childSessionId)` and renders `↳ {currentToolName} {title}` while running |
| R6 | `TaskToolEntry` clicking navigates to the child session by calling `onNavigateToSession(childSessionId)` |
| R7 | `ChatPane` shows `SubagentBanner` between `StatusBar` and `Composer` when `session.spawnedFrom` is set |
| R8 | `SubagentBanner` shows the parent session name (resolved from `useServerStore`) and calls `onNavigateToSession(parentId)` on click |
| R9 | `onNavigateToSession` is threaded `Workspace.tsx → AgentPaneSlot → ChatPane → SubagentBanner / ToolRunSummary` |
| R10 | `summarizeGroup` in `toolFormat.ts` skips `task` entries when rendering the run summary phrase (so "Used task 1 time" no longer appears alongside the `TaskToolEntry` row) |
| R11 | Existing tests pass; new behaviour covered by new test cases per phase |

## Research

- `web-ui/src/api/client.ts:100,108` — `subRefs: Map<string, number>`, `chatSubs: Set<string>`; `openChat`/`closeChat` at lines 819–827 — no refcounting today, `Set` only
- `web-ui/src/hooks/useServerSync.ts:173–203` — `session:created` handler; stores session in `useServerStore`; does layout auto-insert for `spawnedFrom`; no `task` correlation today
- `web-ui/src/hooks/useServerStore.ts:20,43–113` — unpersisted Zustand store for `sessions: Session[]`; sessions carry `spawnedFrom`; safe to add a transient `childByParent: Map<string, string[]>` here (not in `useWorkspaceStore` which is `persist`-wrapped)
- `web-ui/src/components/chat/toolFormat.ts` — `ToolCallEntry` interface; no `childSessionId` field today
- `web-ui/src/components/chat/MessageList.tsx:101,413` — `groupEvents(events: NormalizedEvent[])` pure function, called inside `useMemo(..., [events])`; adding `childByParent` as a dep fixes the race where `session:created` arrives after the `tool_use`
- `web-ui/src/components/chat/ToolRunSummary.tsx:17` — `READ_ONLY_TOOL_NAMES` includes `"task"`; `ToolRunSummaryProps` has no `api` or `onNavigate` today; `ToolRunSummary` at line 195 is called from `MessageList.tsx:801`
- `web-ui/src/components/layout/AgentPaneSlot.tsx:46,102` — `AgentPaneSlot({ api, sessionId, session, ... })` renders `<ChatPane api={api} session={...} visible={...} />` at line 102 — this is the correct threading point
- `web-ui/src/routes/Workspace.tsx:377,519` — renders `AgentPaneSlot` twice (canvas tile at 377, direct-session slot at 519); both must receive `onNavigateToSession`
- `web-ui/src/hooks/useChat.ts:76–192` — `useChat(api, sessionId, enabled)` signature; handles `chat:open`/`chat:close` lifecycle; safe to call with child sessionId when `enabled` is gated
- `web-ui/src/components/chat/MessageList.tsx:801` — `<ToolRunSummary key={key} tools={item.tools} live={...} cwd={cwd} />` — the render site; `api` and `onNavigate` props must be added here

## Architecture Diagram

```mermaid
flowchart LR
  subgraph Daemon["Daemon (no changes)"]
    WS["WS broadcast: session:created\ncarries spawnedFrom"]
  end
  subgraph Client
    WS -->|spawnedFrom| Sync["useServerSync\nupdates childByParent map\nin useServerStore"]
    Sync --> MsgList["MessageList\ngroupEvents(events, parentId, childByParent)\npopulates ToolCallEntry.childSessionId"]
    MsgList --> TRS["ToolRunSummary\nlive task → TaskToolEntry\ncompleted task → ToolRunEntryRow (result text)"]
    TRS -->|useChat(childSessionId)| Child["child session events\n(refcounted openChat)"]
    TRS -->|click| Nav["onNavigateToSession(childId)\nWorkspace → AgentPaneSlot → ChatPane"]
    Session["session.spawnedFrom"] --> Banner["SubagentBanner\nuseServerStore: parentSession\nclick → onNavigateToSession(parentId)"]
    Banner --> Nav
  end
```

## Design Details

### CUJs

```
Parent chat, Task tool fires, child session not yet created
  → task tool_use in_progress (no result), live=true, childSessionId=undefined
  → TaskToolEntry renders "Task (description)…" with spinner
  → session:created fires → childByParent updated → groupEvents re-runs → childSessionId set
  → TaskToolEntry now shows "↳ Reading src/foo.ts" live

Parent chat, Task completes (tool_result arrives)
  → TaskToolEntry receives result → unmounts (live=false OR result present)
  → ToolRunEntryRow renders with result text: "↳ 8 tools · 4.2s"
  → click on task row → onNavigateToSession(childId) called

Parent chat, reload / reconnect
  → sessions loaded from REST (useServerStore.sessions), all carry spawnedFrom
  → childByParent rebuilt from sessions list on mount (no live events needed)
  → historical completed task rows use ToolRunEntryRow from result — no subscription needed

Viewing child (subagent) session
  → session.spawnedFrom is set → SubagentBanner renders
  → Shows "Subagent · ↑ [parent session name]"
  → Click → onNavigateToSession(session.spawnedFrom) → parent pane focused

Two simultaneous task tool calls (concurrent)
  → session:created #1 and #2 arrive → childByParent[parentId] = [childId1, childId2] (FIFO)
  → groupEvents assigns childId1 to earliest unresolved task tool_use, childId2 to next
```

### API Contracts

**`childByParent` store field (client-side, new)**
```typescript
// Added to useServerStore state (useServerStore.ts)
childByParent: Map<string, string[]>
// key: parentSessionId, value: FIFO list of childSessionIds for unmatched task tool_use entries
// Built from:
//   - sessions list on initial load (sessions with spawnedFrom, grouped by parentId)
//   - live session:created events (appended in arrival order)
// Consumed (splice from front) in groupEvents when a task tool_use needs a child
```

**`ToolCallEntry` (client, `toolFormat.ts`)**
```typescript
childSessionId?: string;
// Populated in groupEvents for task tool entries where a child session is known
```

**`groupEvents` (revised signature)**
```typescript
// MessageList.tsx — internal function
function groupEvents(
  events: NormalizedEvent[],
  parentSessionId: string | null,
  childByParent: ReadonlyMap<string, readonly string[]>
): RenderItem[]
// childByParent is from useServerStore; the function clones and consumes FIFO per parentSessionId
// useMemo deps: [events, parentSessionId, childByParent]
```

**`openChat` / `closeChat` (revised)**
```typescript
// client.ts — chatSubs becomes Map<sessionId, refCount>
async openChat(sessionId: string, sinceSeq?: number): Promise<void>
// increments refCount; sends chat:open only on 0→1 transition

async closeChat(sessionId: string): Promise<void>
// decrements refCount; sends chat:close only on 1→0 transition
```

**`ToolRunSummaryProps` (revised)**
```typescript
interface ToolRunSummaryProps {
  tools: ToolCallEntry[];
  live?: boolean;
  cwd?: string;
  api?: ApiInstance;           // new — optional, for TaskToolEntry
  onNavigate?: (sessionId: string) => void;  // new — optional
}
```

**`SubagentBanner` (new)**
```typescript
// web-ui/src/components/chat/SubagentBanner.tsx
export function SubagentBanner({
  parentSessionId: string,
  onNavigate?: (sessionId: string) => void
}): JSX.Element | null
// reads parentSession from useServerStore; returns null when not found
```

**`AgentPaneSlotProps` (revised)**
```typescript
interface AgentPaneSlotProps {
  // ... existing fields ...
  onNavigateToSession?: (sessionId: string) => void;  // new
}
```

### Key Decisions

#### Decision 1: Client-only correlation — no daemon changes
- **Decision:** match child sessions to `task` tool_use entries via FIFO order on `session:created` events; no `spawnedFromToolId` field added to the daemon
- **Rationale:** the Task tool spawns an inline subagent; vibe-station child sessions are created by the subagent calling `vst session create`, which doesn't carry the parent's `toolId`; threading the toolId would require env-var plumbing across process boundaries; FIFO matching is correct for the common sequential case
- **Where:** `web-ui/src/hooks/useServerSync.ts`, `web-ui/src/hooks/useServerStore.ts`, `web-ui/src/components/chat/MessageList.tsx`

#### Decision 2: `childByParent` in `useServerStore` (not `useWorkspaceStore`)
- **Decision:** store the `Map<parentId, childId[]>` in `useServerStore` (unpersisted), not `useWorkspaceStore` (persist-wrapped with `partialize`)
- **Rationale:** `useWorkspaceStore` writes its state to localStorage; a transient Map of session IDs would persist across reloads and become stale; `useServerStore` is rebuilt on every load from the REST session list anyway
- **Where:** `web-ui/src/hooks/useServerStore.ts`

#### Decision 3: `TaskToolEntry` only for live, result-less task entries
- **Decision:** render `TaskToolEntry` only when `live === true && !tool.result`; completed task entries use the standard `ToolRunEntryRow` with the result text (which the Claude Code agent always provides as a summary)
- **Rationale:** avoids opening `chat:open` subscriptions for every historical task entry on pane load; the completed result text already contains the summary the user needs
- **Where:** `web-ui/src/components/chat/ToolRunSummary.tsx`

#### Decision 4: Refcount `openChat`/`closeChat`
- **Decision:** change `chatSubs: Set<string>` to `chatSubs: Map<string, number>` in `client.ts`; increment on open, decrement on close, send `chat:close` only at 0
- **Rationale:** the child session's own `ChatPane` and `TaskToolEntry` may both subscribe to the same child sessionId; without refcounting, whichever unmounts first sends `chat:close` and kills the other's live feed
- **Where:** `web-ui/src/api/client.ts:100,819–827`

#### Decision 5: `summarizeGroup` skips `task` entries
- **Decision:** filter `task`-named tools out of the `summarizeGroup` phrase computation in `toolFormat.ts`
- **Rationale:** the dedicated `TaskToolEntry` already represents the task visually; "Used task 1 time" appearing in the run summary header above the row is redundant and confusing
- **Where:** `web-ui/src/components/chat/toolFormat.ts:50–76`

#### Decision 6: `onNavigateToSession` implementation in `Workspace.tsx`
- **Decision:** `Workspace.tsx` provides `onNavigateToSession` using `useWorkspaceStore`'s `setActiveWorktree` / `setFocusedPane` (or equivalent); `AgentPaneSlot` and `ChatPane` pass it through as an optional prop
- **Rationale:** `Workspace` owns the canvas layout and knows how to focus a session tile; lower-level components (ChatPane, ToolRunSummary) stay callback-driven and testable in isolation
- **Where:** `web-ui/src/routes/Workspace.tsx:377,519`

#### Decision 7: `childByParent` rebuilt from sessions list on load
- **Decision:** `useServerStore.replaceAll` rebuilds `childByParent` from the sessions array on every initial load, grouping sessions by `spawnedFrom`
- **Rationale:** eliminates the reconnect/cold-load degradation identified in the review; historical sessions with `spawnedFrom` can be matched to task entries without needing live `session:created` events
- **Where:** `web-ui/src/hooks/useServerStore.ts:49` (`replaceAll` action)

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does `onNavigateToSession` need to handle cross-worktree navigation (child session in a different worktree)? | `session.worktreeId` is available; if different, `setActiveWorktree` must be called first |
| 2 | Will adding `childByParent` to `groupEvents` deps cause any perf regression on large transcripts? | `Map` reference-equality is used by Zustand; new events add new children (rare), so most re-renders hit the memo cache |
| 3 | `READ_ONLY_TOOL_NAMES` still contains `"task"` — does the `isReadOnly` flag need to stay for the `ToolRunEntryRow` fallback path? | Yes — keep it; `ToolRunEntryRow` for a completed task is still read-only (no diffs) |
| 4 | Two task tools run concurrently; their child sessions arrive out of order | FIFO matches by arrival order, not task order; mis-match is silent (wrong child shown) — acceptable for MVP; fix needs daemon `sourceToolId` plumbing |

## Implementation Phases

### Phase 1 — Refcount `openChat`/`closeChat` in `client.ts`

- [x] **1.1** `web-ui/src/api/client.ts:100,108` — change `chatSubs: Set<string>` → `chatSubs: Map<string, number>`; update `openChat` to increment count and send `chat:open` only on `0 → 1`; update `closeChat` to decrement and send `chat:close` only on `1 → 0`; guard against negative counts (warn + clamp to 0); also fix the reconnect loop at line ~183 that iterates `chatSubs` to re-send `chat:open` after reconnect — change `for (const sid of chatSubs)` to `for (const sid of chatSubs.keys())` so it iterates keys, not `[key, count]` tuples
- [x] **1.T1** Unit — `openChat` twice for same sessionId: `chat:open` sent once, refCount is 2
- [x] **1.T2** Unit — `closeChat` once after two opens: `chat:close` not sent, refCount is 1
- [x] **1.T3** Unit — `closeChat` twice after two opens: `chat:close` sent once on second close

**Verify phase 1:** `cd web-ui && npx vitest run src/api/`

### Phase 2 — `childByParent` in store + correlation in `groupEvents`

- [x] **2.1** `web-ui/src/hooks/useServerStore.ts` — add `childByParent: Map<string, string[]>` to state (initial value: empty Map); add `addChildSession(parentId: string, childId: string): void` action that appends `childId` to `childByParent[parentId]` in FIFO order; update `replaceAll` to rebuild `childByParent` from the sessions list by grouping `session.spawnedFrom` values
- [x] **2.2** `web-ui/src/hooks/useServerSync.ts:173–203` — in the `session:created` handler, after updating `useServerStore.sessions`, call `addChildSession(ev.spawnedFrom, ev.sessionId)` when `ev.spawnedFrom` is set
- [x] **2.3** `web-ui/src/components/chat/toolFormat.ts` — add `childSessionId?: string` to `ToolCallEntry`
- [x] **2.4** `web-ui/src/components/chat/MessageList.tsx` — update `groupEvents` signature to `groupEvents(events, parentSessionId?: string | null, childByParent?: ReadonlyMap<string, readonly string[]>)` (both new params optional so existing test call-sites with 1 arg keep compiling unchanged); inside, when a `task` tool_use entry is created and both optional params are present, FIFO-consume from `childByParent.get(parentSessionId)` and set `entry.childSessionId`; update the `useMemo` call-site to pass `sessionId` and `useServerStore((s) => s.childByParent)`, and add both to the deps array; also add `onNavigateToSession?: (sessionId: string) => void` to `MessageListProps` and thread it to the `ToolRunSummary` render call at line ~806
- [x] **2.5** `web-ui/src/components/chat/toolFormat.ts:50–76` — in `summarizeGroup`, filter out entries where `toolName.toLowerCase() === "task"` before computing phrases
- [x] **2.T1** Unit — `groupEvents` with a `task` tool_use and a matching childByParent entry: `childSessionId` is set on the entry
- [x] **2.T2** Unit — `groupEvents` with a `task` tool_use and empty map: `childSessionId` is undefined, no crash
- [x] **2.T3** Unit — two task tool_use entries, two child sessions in FIFO order: each gets the correct child
- [x] **2.T4** Unit — `summarizeGroup` with mixed tools including `task`: phrase omits "task"; other phrases present
- [x] **2.T5** Unit — `useServerStore.replaceAll` with sessions carrying `spawnedFrom`: `childByParent` is populated correctly
- [x] **2.T6** Regression — `useServerSync.test.ts`: `session:created` with `spawnedFrom` calls `addChildSession`

**Verify phase 2:** `cd web-ui && npx vitest run src/components/chat/MessageList src/hooks/useServerStore src/hooks/useServerSync`

### Phase 3 — `TaskToolEntry` component

- [x] **3.1** `web-ui/src/components/chat/ToolRunSummary.tsx` — add `api?: ApiInstance` and `onNavigate?: (sessionId: string) => void` to `ToolRunSummaryProps`
- [x] **3.2** `web-ui/src/components/chat/ToolRunSummary.tsx` — add `TaskToolEntry` function component (above `ToolRunSummary`); props: `{ tool: ToolCallEntry; api: ApiInstance; onNavigate?: (sessionId: string) => void }`; calls `useChat(api, tool.childSessionId ?? null, !!tool.childSessionId)`; derives `currentTool` (last `tool_use` event without a matching `tool_result` in child events — use a local memo); derives `completionInfo` (count of `tool_use` entries + elapsed from first to last timestamp); renders an `ToolRunEntryRow`-shaped element with an additional `↳ {currentTool.toolName} {currentTool.inline}` line when running, or `↳ {count} tools · {elapsed}` when done; wraps child `useChat` in `try/catch` to handle unavailable child sessions gracefully
- [x] **3.3** `web-ui/src/components/chat/ToolRunSummary.tsx` — in `ToolRunSummary`'s JSX, when a tool entry has `toolName.toLowerCase() === "task"` AND `live === true` AND `!tool.result`: render `<TaskToolEntry tool={tool} api={api!} onNavigate={onNavigate} />`; otherwise render `<ToolRunEntryRow tool={tool} running={...} cwd={cwd} />`
- [x] **3.4** `web-ui/src/components/chat/MessageList.tsx:801` — add `api`, `onNavigate` to the `ToolRunSummary` render call; both are optional (existing tests don't provide them)
- [x] **3.T1** Unit — `TaskToolEntry` with no `childSessionId`: renders fallback (generic spinner label, no `↳` line)
- [x] **3.T2** Unit — `TaskToolEntry` with child events and running tool: shows `↳ Read src/foo.ts`
- [x] **3.T3** Unit — `TaskToolEntry` with completed child (all tool_use have tool_result): shows `↳ 3 tools · 1200ms`
- [x] **3.T4** Unit — `TaskToolEntry` click: calls `onNavigate(childSessionId)`
- [x] **3.T5** Regression — `ToolRunSummary.test.tsx`: existing non-task entries render unchanged with no `api` prop

**Verify phase 3:** `cd web-ui && npx vitest run src/components/chat/ToolRunSummary`

### Phase 4 — `SubagentBanner` + `ChatPane` + prop threading

- [x] **4.1** `web-ui/src/components/chat/SubagentBanner.tsx` — new component; props: `{ parentSessionId: string; onNavigate?: (sessionId: string) => void }`; reads `parentSession` from `useServerStore((s) => s.sessions.find(x => x.id === parentSessionId))`; returns `null` when not found; renders a slim `<div className="chat-subagent-banner">` with "↑ Subagent · {parentSession.name}" and an `onClick={() => onNavigate?.(parentSessionId)}` button
- [x] **4.2** Add `.chat-subagent-banner` CSS to `web-ui/src/styles/chat.css` (or the closest co-located CSS file used by ChatPane components): slim bar (`padding: 4px 12px`), `background: var(--chat-bg-subtle)`, `border-bottom: 1px solid var(--border-muted)`, `font-size: var(--chat-font-sm)`, `color: var(--text-muted)`; button inside gets `cursor: pointer; text-decoration: underline; background: none; border: none; color: inherit`
- [x] **4.3** `web-ui/src/components/layout/ChatPane.tsx` — add `onNavigateToSession?: (sessionId: string) => void` to `ChatPaneProps`; thread it to `ToolRunSummary` (via `MessageList`) and to `SubagentBanner`; render `{session?.spawnedFrom ? <SubagentBanner parentSessionId={session.spawnedFrom} onNavigate={onNavigateToSession} /> : null}` between `StatusBar` and the archived/`Composer` block
- [x] **4.4** `web-ui/src/components/layout/AgentPaneSlot.tsx` — add `onNavigateToSession?: (sessionId: string) => void` to `AgentPaneSlotProps`; forward it to `<ChatPane>`
- [x] **4.5** `web-ui/src/routes/Workspace.tsx:377,519` — provide `onNavigateToSession` at both `AgentPaneSlot` render sites; implementation: given a `targetSessionId`, find the target session in `useServerStore`, then if in the same project use `useWorkspaceStore` to bring its pane into focus (use `setActiveWorktree` for worktree sessions, `setDirectSessionId` or equivalent for direct sessions); log a warning and no-op for cross-project sessions
- [x] **4.T1** Unit — `SubagentBanner` with resolved parent: renders parent name and a button
- [x] **4.T2** Unit — `SubagentBanner` with unknown parentSessionId (not in store): returns null
- [x] **4.T3** Unit — `SubagentBanner` button click: calls `onNavigate(parentSessionId)`
- [x] **4.T4** Integration — `ChatPane` with `session.spawnedFrom` set: `SubagentBanner` mounts; without: absent

**Verify phase 4:** `cd web-ui && npx vitest run src/components/chat/ && npx tsc --noEmit`

### Phase 5 — `steer()` mid-turn injection

> **Freeview findings (Opus):** `acpTransport.ts` contains `AcpConnection` (not `AcpTransport`); the ACP wire method is `_session/steering` with `prompt: PromptBlock[]` (NOT `ContentBlock[]` — `PromptBlock` is the local type at `acpTransport.ts:26`). `supportsSteering` must be read from `_meta.steering.supported` inside `initialize()`'s response; it is currently discarded. The gate for steering uses `this.running` + `this.activeAbort` — NOT a `turnState` enum; `!aborted` must be written `!this.activeAbort.signal.aborted`. Attachments must block steering (they are injected by `runOneTurn` which a steered message bypasses). Only steer when queue is empty to preserve FIFO.

- [x] **5.0** Type declarations — add before any other step to keep `tsc --noEmit` passing throughout:
  - `daemon/src/types.ts:238` — add `canSteer?: boolean` to `SessionMeta` interface
  - `daemon/src/services/jsonAgentChat.ts:191` — add `delivery?: "queued" | "steered"` to `EnqueueChatResult` (or equivalent local type); also ensure the `enqueueChatTurn` call at line ~225 is `await agent.submit(...)` (submit is async, enqueue was sync)
  - `web-ui/src/api/types.ts:272` — add `delivery?: "queued" | "steered"` to `SendChatResponse`
  - `web-ui/src/api/types.ts:310` — add `canSteer?: boolean` to the web-ui mirror `SessionMeta`
  - `web-ui/src/hooks/useChat.ts:7` — add `delivery?: "queued" | "steered"` to `PendingTurn`

- [x] **5.1** `daemon/src/services/acp/acpTransport.ts` — in `initialize()` (L120), capture the top-level `_meta` from the response and store as a private field; add `get supportsSteering(): boolean` returning `this._initMeta?.steering?.supported === true`; add `async steer(blocks: PromptBlock[]): Promise<"injected" | "promptRequired" | "unsupported">` that calls `this.request("_session/steering", { sessionId: this.sessionId, prompt: blocks, _meta: { steering: { idleBehavior: "promptRequired" } } })` and returns the `outcome` field; on any rejection (method-not-found, disposed, closed stdin) catch and return `"unsupported"` so callers have exactly one fallback branch; after a successful `"injected"` outcome also call `this.resetIdleTimer()` to prevent spurious idle-timeout during the injected continuation

- [x] **5.2** `daemon/src/services/jsonAgent.ts` — factor a private `emitUserEvent(turnId: string, input: ...): void` out of `enqueue()` at L404–411 (the block that persists + broadcasts the synthesized `user` event); add `async submit(input): Promise<{ turnId: string; queuePosition: number; delivery: "queued" | "steered" }>` as a new public method; the gate — steer iff ALL are true: `this.running && this.activeAbort && !this.activeAbort.signal.aborted && this.queue.length === 0 && !attachments.length && !this.isFirstTurnPending && this.connection?.isAlive() && this.connection.supportsSteering`; convert `input.message: string` to `[{ type: "text", text: input.message }]` before calling `this.connection.steer(blocks)`; on `"injected"`: mint a fresh turnId, call `emitUserEvent(turnId, ...)`, return `{ turnId, queuePosition: 0, delivery: "steered" }` — do NOT touch `queue`, `turnState`, or `kickDrain`; on `"promptRequired"` / `"unsupported"` / any throw: `return this.enqueue(input)` unchanged; add `canSteer: this.running && !!this.connection?.isAlive() && !!this.connection?.supportsSteering` to `getMeta()` (L731)

- [x] **5.3** `daemon/src/services/jsonAgentChat.ts` — in `enqueueChatTurn`, `await agent.submit(...)` instead of `agent.enqueue(...)`; pass the returned `delivery` field through in the `202` response body alongside `turnId` and `queuePosition`; `sessions.ts` route at L1607–1652 needs no other change

- [x] **5.4** `web-ui/src/hooks/useChat.ts:194–205` — in the `send` handler, record `delivery` from the 202 response on the pending bubble alongside `turnId`; when `delivery === "steered"`, the bubble is already inline (because `queuePosition === 0`) — no additional rendering change needed; the field is ignored if absent (old daemons)

- [x] **5.5** `web-ui/src/components/layout/ChatPane.tsx` — pass `canSteer={meta?.canSteer ?? false}` to `<Composer>`; read `meta` from `useChat`'s existing `meta` field (already subscribed via the session WS stream)

- [x] **5.6** `web-ui/src/components/chat/Composer.tsx` — accept `canSteer?: boolean` in props; at L266–267, change `aria-label` and `title` for the send button when `busy && canSteer` to `"Interrupts and steers the running turn"` instead of `"Sends after the current turn finishes"`; no new button, no new keybinding

- [x] **5.T1** Unit (`daemon/src/__tests__/acpTransport.test.ts`) — add fixture mode to `fakeAcpAgent.mjs` returning `_meta: { steering: { supported: true } }` in the initialize response; test: `supportsSteering` is `true`; absent `_meta` fixture → `false`
- [x] **5.T2** Unit (`daemon/src/__tests__/acpTransport.test.ts`) — add fixture mode where `_session/steering` responds with `{code: -32601}` method-not-found; test: `steer()` returns `"unsupported"`, does not throw
- [x] **5.T3** Unit (`daemon/src/__tests__/jsonChatQueue.test.ts`) — `submit()` when NOT running: falls through to `enqueue()`, returns `delivery: "queued"`
- [x] **5.T4** Unit (`daemon/src/__tests__/jsonChatQueue.test.ts`) — `submit()` when running + attachments: falls through to `enqueue()` (attachment gate)
- [x] **5.T5** Unit (`daemon/src/__tests__/jsonChatQueue.test.ts`) — inject a fake `connection` (duck-type stub) into the private `connection` field after turn 2 starts (past `isFirstTurnPending`); fake returns `"injected"`; test: `emitUserEvent` called once, `queue` untouched, `delivery: "steered"`
- [x] **5.T6** Unit (`daemon/src/__tests__/jsonChatQueue.test.ts`) — same fixture as T5 but fake returns `"promptRequired"`; test: falls through to `enqueue()`, `emitUserEvent` not called before enqueue
- [x] **5.T7** Regression (`web-ui/src/components/chat/Composer.test.tsx`) — `busy && !canSteer` → aria-label unchanged; `busy && canSteer` → steer label

**Verify phase 5:** `cd daemon && npx vitest run src/__tests__/acpTransport.test.ts src/__tests__/jsonAgent.test.ts src/__tests__/jsonChatQueue.test.ts && npx tsc --noEmit && cd ../web-ui && npx vitest run src/hooks/useChat src/components/chat/Composer && npx tsc --noEmit`

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/api/client.ts` | **Modified** | 1.1 | `chatSubs: Set→Map<string,number>`; refcounted `openChat`/`closeChat` |
| `web-ui/src/hooks/useServerStore.ts` | **Modified** | 2.1 | Add `childByParent: Map<string,string[]>` + `addChildSession` action; rebuild in `replaceAll` |
| `web-ui/src/hooks/useServerSync.ts` | **Modified** | 2.2 | Call `addChildSession` in `session:created` handler |
| `web-ui/src/components/chat/toolFormat.ts` | **Modified** | 2.3, 2.5 | Add `childSessionId?: string` to `ToolCallEntry`; filter `task` from `summarizeGroup` |
| `web-ui/src/components/chat/MessageList.tsx` | **Modified** | 2.4, 3.4 | `groupEvents` signature + FIFO child resolution; add `api`/`onNavigate` to `ToolRunSummary` call |
| `web-ui/src/components/chat/ToolRunSummary.tsx` | **Modified** | 3.1–3.3 | Add `TaskToolEntry` component; add `api?`/`onNavigate?` to props; route live task entries to it |
| `web-ui/src/components/chat/SubagentBanner.tsx` | **New** | 4.1 | Contract: `SubagentBanner({ parentSessionId, onNavigate? }) → JSX\|null` |
| `web-ui/src/styles/chat.css` | **Modified** | 4.2 | Add `.chat-subagent-banner` styles |
| `web-ui/src/components/layout/ChatPane.tsx` | **Modified** | 4.3 | Add `onNavigateToSession?` prop; render `SubagentBanner`; thread prop to `MessageList` |
| `web-ui/src/components/layout/AgentPaneSlot.tsx` | **Modified** | 4.4 | Add `onNavigateToSession?`; forward to `ChatPane` |
| `web-ui/src/routes/Workspace.tsx` | **Modified** | 4.5 | Provide `onNavigateToSession` at both `AgentPaneSlot` sites |
| `web-ui/src/components/chat/ToolRunSummary.test.tsx` | **Modified** | 3.T1–3.T5 | `TaskToolEntry` cases + regression guard |
| `web-ui/src/hooks/useServerStore.test.ts` | **Modified** | 2.T5 | Append unit tests for `childByParent` rebuild and `addChildSession` to existing file |
| `web-ui/src/hooks/useServerSync.test.ts` | **Modified** | 2.T6 | `session:created` → `addChildSession` |
| `daemon/src/types.ts` | **Modified** | 5.0 | Add `canSteer?: boolean` to `SessionMeta` |
| `daemon/src/services/acp/acpTransport.ts` | **Modified** | 5.1 | `supportsSteering` getter from `initialize()` `_meta`; `async steer(blocks: PromptBlock[])` calling `_session/steering`; returns `"unsupported"` on any rejection |
| `daemon/src/services/jsonAgent.ts` | **Modified** | 5.2 | Private `emitUserEvent()`; `async submit()` with steer-vs-enqueue gate; `canSteer` in `getMeta()`; `string → PromptBlock[]` conversion |
| `daemon/src/services/jsonAgentChat.ts` | **Modified** | 5.0, 5.3 | Add `delivery?` to `EnqueueChatResult`; `await agent.submit()` instead of `agent.enqueue()`; pass `delivery` in 202 body |
| `web-ui/src/api/types.ts` | **Modified** | 5.0 | Add `delivery?` to `SendChatResponse`; add `canSteer?` to `SessionMeta` mirror |
| `web-ui/src/hooks/useChat.ts` | **Modified** | 5.0, 5.4 | Add `delivery?` to `PendingTurn`; record `delivery` from 202 response on pending bubble |
| `web-ui/src/components/layout/ChatPane.tsx` | **Modified** | 5.5 | Pass `canSteer={meta?.canSteer}` to `<Composer>` |
| `web-ui/src/components/chat/Composer.tsx` | **Modified** | 5.6 | `canSteer?` prop; update `aria-label`/`title` at L266–267 only |
| `daemon/src/__tests__/fixtures/fakeAcpAgent.mjs` | **Modified** | 5.T1, 5.T2 | Add fixture modes: `_meta.steering.supported` in initialize; method-not-found on `_session/steering` |

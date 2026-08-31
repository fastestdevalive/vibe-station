<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: ACP Normalize Superset

> Extend `NormalizedEvent`/`normalize.ts` additively to losslessly carry 7 ACP update kinds it currently drops, and render the richest one (file-edit diffs) as green/red in chat.

**Issue:** acp-normalize-superset
**Branch:** `background-support-stops` (current)
**Status:** Pending
**PRD:** none — small feature, root sub-feature, no PRD per task scoping
**Parent:** none

**Reference files:**
- Data / schema: `daemon/src/types.ts:74-84` (`NormalizedEventKind`), `daemon/src/types.ts:116-171` (`NormalizedEvent`), `daemon/src/ws/protocol.ts:152-185` (`NormalizedEventSchema` — a SEPARATE Zod-enforced copy of the kind/field set, must move in lockstep or `tsc` fails at the WS send site)
- Core logic: `daemon/src/services/acp/normalize.ts`
- UI / entrypoint: `web-ui/src/components/chat/MessageList.tsx`, `web-ui/src/components/chat/ToolRunSummary.tsx` (the actual live renderer — see Research)
- Wiring: `web-ui/src/api/types.ts:181-221` (client-side `NormalizedEvent` mirror), `web-ui/src/components/preview/DiffView.tsx`, `web-ui/src/preview/diffParser.ts`

---

## Problem

- `normalize.ts` was deliberately built to introduce zero new event kinds during the ACP migration (67a3736), so it silently drops 7 categories of data ACP provides — not hidden-in-UI, never even written to SQLite.
- Dropped: non-text content blocks (image/audio/resource/resource_link), diff content blocks (file-edit before/after), `tool_call.locations`, `tool_call.kind`, in-progress `tool_call_update` statuses, `current_mode_update`, `available_commands_update`.
- Diff blocks are the highest-value loss: today a file-edit tool call either shows raw JSON input or nothing — no green/red diff.

## Out of Scope

- Rewriting/redesigning the chat UI or ACP transport layer (`AcpConnection`, `AcpTerminalManager`, `JsonAgentSession`) — untouched.
- `plan` / `plan_update` / `plan_removed`, `config_option_update`, `session_info_update`, `usage_update`, `compaction_update` session-update kinds — not in the 7-item gap list, no change.
- Rendering embedded MCP resource *contents* (full text/blob payload) — only a link/metadata chip (name, mimeType, uri) per resource/resource_link block; opening the resource is future work.
- Any SQLite schema/migration — `message.payload` is a JSON blob column (`daemon/src/services/sqliteTranscriptStore.ts:76`), so new optional `NormalizedEvent` fields need zero DB migration.
- Backfilling historical transcript rows with the new fields — old rows simply lack them and render exactly as today (hard constraint).
- `ToolUseCard.tsx`/`ToolResultCard.tsx` — confirmed dead code (zero mounts outside their own tests, see Research), left untouched; `ToolRunSummary.tsx`/`ToolRunEntryRow` is the sole live renderer this plan updates.

## Concept

- `NormalizedEvent` gains a small set of **optional** fields and **two new** `NormalizedEventKind` values, populated by `normalize.ts` instead of returning `null`/dropping data.
- Web-ui chat components read the new optional fields when present; every existing code path that ignores them is untouched and renders old rows identically.
- File-edit diffs are the flagship win: `{type:"diff", path, oldText, newText}` tool-call content becomes a real green/red unified diff via the existing `DiffView` component, not raw JSON or skipped output.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Every one of the 7 gaps is captured on `NormalizedEvent`/persisted — no silent drops remain in `normalizeSessionUpdate` |
| 2 | Additive only: no existing `NormalizedEventKind` changes meaning, all new fields optional, old persisted rows render unchanged |
| 3 | File-edit diff blocks render as green (added) / red (removed) lines in chat, reusing `DiffView` |
| 4 | `tool_call.locations` / `.kind` surface as structured metadata (not just a display-name fallback) |
| 5 | In-progress `tool_call_update` (pending/in_progress) produces a live-updating event, not silence until terminal status |
| 6 | `current_mode_update` / `available_commands_update` render as status-like indicators in the feed |
| 7 | Small, sonnet-implementable in one pass — no new services, no new persistence layer, no UI redesign |

---

## Research

### `normalize.ts` drop points

- **File:** `daemon/src/services/acp/normalize.ts:30-35` — `textFromContentBlock()` only handles `{type:"text"}`; any other block type returns `undefined`.
- **File:** `daemon/src/services/acp/normalize.ts:60-65` (`agent_message_chunk`) / `:66-70` (`agent_thought_chunk`) — `if (text === undefined) return null;` drops the WHOLE event when `raw.content` (a single `ContentBlock`, see schema note below) is non-text.
- **File:** `daemon/src/services/acp/normalize.ts:78-88` (`tool_call`) — only reads `toolCallId`, `title`/`kind` (display fallback), `rawInput`/`input`. Never reads `raw.locations`, never preserves `raw.kind` structurally, never reads `raw.content` (where diff blocks/partial output land even on the FIRST `tool_call`, per ACP spec `ToolCall.content?: Array<ToolCallContent>`).
- **File:** `daemon/src/services/acp/normalize.ts:89-106` (`tool_call_update`) — line 94: `if (status !== "completed" && status !== "failed") return null;` drops pending/in_progress entirely; the `content.map(...)` (lines 96-98) only extracts `textFromContentBlock`, so a `{type:"diff",...}` entry in the array maps to `undefined` and is filtered out by `.filter((t): t is string => ...)` at line 98 — the diff is silently discarded, never persisted.
- **File:** `daemon/src/services/acp/normalize.ts:117-118` (`default: return null`, inside the outer `switch` whose last named case, `plan`, ends at line 116) — `current_mode_update` and `available_commands_update` fall through here.
- **File:** `daemon/src/ws/protocol.ts:152-185` — `NormalizedEventSchema` is a Zod schema, hand-kept in sync with `daemon/src/types.ts`'s `NormalizedEvent`, NOT derived from it. `kind: z.enum([...10 strings...])` (`:157-168`) is a hard allowlist — any event with a kind outside it fails Zod parsing wherever this schema validates outbound events (`ChatReplayEvent.events` at `:453`, `SessionMessageEvent.event` at `:463`, both feeding `ServerMessage`, exercised by `daemon/src/__tests__/jsonProtocol.test.ts`). **This file is a THIRD copy of the kind/field set (alongside `daemon/src/types.ts` and `web-ui/src/api/types.ts`) and must be updated in the same commit or the build breaks at the WS send site.**

### ACP schema shapes (from `@agentclientprotocol/sdk@1.4.0`, `dist/schema/types.gen.d.ts`)

- `ContentBlock` union: `TextContent{text}` | `ImageContent{data,mimeType}` | `AudioContent{data,mimeType}` | `ResourceLink{uri,name,mimeType?,description?}` | `EmbeddedResource{resource: TextResourceContents|BlobResourceContents}`.
- **`agent_message_chunk`/`agent_thought_chunk`'s `content` field is a SINGLE `ContentBlock`, not an array** — both are `ContentChunk = { content: ContentBlock; messageId?: ... }` (`types.gen.d.ts:3410-3452`). The current `normalize.ts:61`/`:67` already pass `raw.content` as one object, matching this — any new helper for these two cases must take one block, not an array.
- `ToolCallContent` union (a DIFFERENT, separate union from `ContentBlock` — only reached via `tool_call`/`tool_call_update.content`, which IS an array): `{type:"content", content: ContentBlock}` | `{type:"diff", path, oldText?, newText}` | `{type:"terminal", ...}` — `Diff` type at `types.gen.d.ts:522-534`: `path: string`, `oldText?: string|null` (absent ⇒ new file), `newText: string`.
- `ToolCallLocation` at `types.gen.d.ts:581-589`: `{path: string, line?: number|null}`.
- `ToolKind` at `types.gen.d.ts:209`: `"read"|"edit"|"delete"|"move"|"search"|"execute"|"think"|"fetch"|"switch_mode"|"other"`.
- `ToolCallStatus`: `"pending"|"in_progress"|"completed"|"failed"`.
- `ToolCall` (initial) carries `kind?`, `status?`, `content?`, `locations?`, `rawInput?` all together — so diff/locations/kind can arrive on the FIRST `tool_call` update, not only on a later `tool_call_update`.
- `ToolCallUpdate` mirrors the same optional fields (`kind?`, `status?`, `content?`, `locations?`). Per the SDK doc comment, "only changed fields need to be included" — every extraction below must be additive/merge-safe and never assume presence.
- `CurrentModeUpdate = { currentModeId: string }` — no mode name in the update itself.
- `AvailableCommandsUpdate = { availableCommands: Array<{name, description, input?}> }`.

### Existing UI diff-rendering pattern (reuse, don't reinvent)

- **File:** `web-ui/src/components/chat/toolFormat.ts:43-47` — `looksLikeUnifiedDiff()` heuristically detects unified-diff TEXT output (e.g. from a `git diff`-shaped Bash result). `web-ui/src/components/chat/ToolRunSummary.tsx:129-131` feeds a match to `<DiffView diffText={resultText} />`. This heuristic path is for TEXT tool output that happens to look like a diff — separate from the STRUCTURED `{oldText,newText}` ACP diff block this plan adds, which needs no heuristic (the type tag already says "diff").
- **File:** `web-ui/src/components/preview/DiffView.tsx:9-15` — `diffText: string` is REQUIRED and unconditionally dereferenced at `:52` (`diffText.trim()`); no other prop lets a caller skip it today.
- **File:** `web-ui/src/components/preview/DiffView.tsx:38-92` — parses via `parseUnifiedDiff()` (`web-ui/src/preview/diffParser.ts:16`) or, for an empty diff + `fileContentFallback`, `syntheticUntrackedHunks()` (`web-ui/src/preview/diffParser.ts:118-128`, marks every line "added" — used for brand-new untracked files).
- **File:** `web-ui/src/components/chat/ToolRunSummary.tsx:77-138` (`ToolRunEntryRow`) — the actual LIVE per-tool-call renderer used by `MessageList` (via `ToolRunSummary`, `MessageList.tsx:761-767`). `running` (`:181`) is `!!live && !t.result` and the done-checkmark (`:111-117`) is `!hasBody && result` — both inferred purely from `t.result`'s truthiness today, with no explicit status field.
- **File:** `web-ui/src/components/chat/ToolRunSummary.tsx:160` (`ToolRunSummary`) — `hasPending = live && tools.some((t) => !t.result)`, same truthiness inference, drives the group-level spinner.
- **Confirmed dead code:** `ToolUseCard.tsx`/`ToolResultCard.tsx` are a lone-call variant with their own test (`ToolResultCard.test.tsx`) but have **zero usages** outside their own files/tests anywhere in `web-ui/src` (`grep -rn "ToolUseCard\|ToolResultCard" web-ui/src` returns only their own definitions/tests) — `MessageList` renders exclusively through `ToolRunSummary`/`ToolRunEntryRow`. Per Requirement 7 ("small... no UI redesign"), this plan does NOT touch these two dead files — see Out of Scope.
- No `diff`/`jsdiff` npm package present anywhere in the repo (`grep` of all `package.json` + a source-wide import scan came up empty) — Decision 3 below adds one. `diff@9.0.0` (latest, confirmed via `npm view diff version`) ships its own `.d.ts` (`libcjs/index.d.ts`) — no `@types/diff` devDependency needed.

### Persistence — confirms zero schema/migration work, flags an unbounded-write risk

- **File:** `daemon/src/services/sqliteTranscriptStore.ts:70-78` — `message` table: `kind TEXT` (unconstrained), `payload TEXT NOT NULL` (whole event JSON-serialized, `sqliteTranscriptStore.ts:151` `JSON.stringify(ev)`). New optional fields and new `kind` string values need no `ALTER TABLE` — they're just new JSON keys / new string values in already-untyped columns.
- **File:** `daemon/src/services/jsonAgent.ts:1144` — `this.store.append(ev)` runs for EVERY event `normalizeSessionUpdate` returns (no filtering above the normalizer). Removing the `pending`/`in_progress` early-return (Gap 5) means every non-terminal status tick becomes a new persisted row for the session's lifetime — see Decision 7.
- **File:** `daemon/src/services/jsonAgent.ts:1151-1170` (`updateTurnState`) — `switch` on `kind` with a catch-all `default: break` — the 2 new kinds (`mode_update`/`commands_update`) fall through harmlessly, no turn-state regression.

## Root Cause

- The migration's Decision 2.3/Requirement 5 ("introduces NO new NormalizedEventKind") was correct for the migration's own scope (don't destabilize the UI mid-transport-swap) but was never revisited once ACP's actual update richness became visible — this plan is that follow-up, now safe to do additively since the transport itself is stable.

---

## Architecture Diagram

- Single-module change (normalize.ts + types.ts + protocol.ts + web-ui chat/preview files) — no new service boundary, no new process. One line suffices:

```
AcpConnection --session/update--> normalize.ts --NormalizedEvent--> SqliteTranscriptStore (payload JSON, unchanged schema) --WS--> web-ui chat/*
```

---

## Design Details

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|----------------|--------|-----------------|
| `AcpConnection` ↔ `normalize.ts` | Raw `session/update` payload (`AcpSessionUpdate`, unchanged shape) — see Research's ACP schema shapes | N/A (pure function, no throws — unrecognized fields already return `null`/are skipped) | ACP agent process |
| `normalize.ts` ↔ `NormalizedEvent` (daemon core / persistence / WS) | New optional fields listed in Data Model below | N/A — additive fields, absent ⇒ `undefined`, no new failure mode | `normalize.ts` (pure mapping) |
| Daemon ↔ web-ui | `NormalizedEvent` shape must stay in lockstep across THREE hand-kept copies: `daemon/src/types.ts` (canonical), `daemon/src/ws/protocol.ts`'s Zod schema (WS validation), `web-ui/src/api/types.ts:181-221` (client mirror) — **existing pattern, not a generated contract**, this plan follows the same manual-mirror convention | A field present in `types.ts` but missing from `protocol.ts` fails Zod parsing at the WS send site (Research B1); missing from `api/types.ts` silently `undefined`s in the UI — mitigated by 1.T2 and the mirror-completeness checklist items | `daemon/src/types.ts` is canonical; the other two copy it by hand (existing convention, unchanged) |

### Critical User Journeys (CUJs)

#### CUJ 1 — Agent edits a file, chat shows a real diff

```
Agent (e.g. claude) calls its file-edit tool
  → ACP emits tool_call {kind:"edit", locations:[{path}], content:[]}
  → ACP emits tool_call_update {status:"in_progress"}   (no content yet)
  → ACP emits tool_call_update {status:"completed", content:[{type:"diff", path, oldText, newText}]}
  → normalize.ts maps the diff block onto NormalizedEvent.toolDiffs
  → ToolRunEntryRow (MessageList → ToolRunSummary) renders <DiffView> with green (added) / red (removed) lines
  → User sees the exact file change, not raw JSON
```

- **Edge case:** `oldText` absent (new file) → `DiffView`'s existing `fileContentFallback`/`syntheticUntrackedHunks` path already handles "no old content" — Decision 3 wires `oldText ?? ""` through the same path, so a brand-new file renders as all-green, matching today's untracked-file behavior.
- **Edge case:** an in-progress `tool_call_update` (CUJ 2) arrives with only `status`, no `content` — spec says "only changed fields need to be included", so `toolDiffs` must never be cleared by an update that omits `content`; only a merge, never an overwrite-with-absence.

#### CUJ 2 — In-progress tool call shows live status instead of silence

```
Agent starts a long-running tool call
  → ACP emits tool_call {status:"pending"}
  → ACP emits tool_call_update {status:"in_progress"}   ← currently DROPPED (normalize.ts:94 returns null)
  → normalize.ts now emits a `tool_result`-kind event carrying toolStatus:"in_progress" (non-terminal)
  → groupEvents merges it onto the tool's item by toolId, setting item.status — item.result stays undefined (no toolResult on a non-terminal update, see Decision 4)
  → ToolRunEntryRow/ToolRunSummary read `tool.status` explicitly for the spinner/checkmark, per Decision 4b
  → ACP emits tool_call_update {status:"completed", content:[...]}
  → normalize.ts emits the existing terminal tool_result event (unchanged behavior), item.status becomes "completed"
```

- **Error path:** `status:"failed"` — unchanged, already handled (`normalize.ts:94`, `isError: status === "failed"`).

#### CUJ 3 — Mode change / dynamic slash-commands surface as status notes

```
Agent switches session mode (e.g. plan → build)
  → ACP emits current_mode_update {currentModeId}
  → normalize.ts emits a NEW `mode_update`-kind event (was: silently dropped via `default: return null`)
  → MessageList's groupEvents maps it to the EXISTING `status` RenderItem (no new UI component) — text "Mode changed to <id>"
  → Renders exactly like today's plan-update status note (chat-status-note div, MessageList.tsx:771-777)
```

- Same pattern for `available_commands_update` → `commands_update` kind → status note listing command names.

#### CUJ 4 — A non-text content block (image/audio/resource) shows a placeholder chip, never a blank bubble

```
Agent sends agent_message_chunk with an image block, no text
  → normalize.ts (Decision 1) emits kind:"text", text: undefined, blocks:[{type:"image",...}]
  → groupEvents' "text" case (MessageList.tsx:172-184) today does `text: ev.text ?? ""`
    — UNGUARDED, this would push/append an EMPTY assistant bubble (a regression: today this event never reaches here because normalize.ts drops it)
  → Phase 3 adds: when ev.text is absent AND ev.blocks is non-empty, use a one-line
    placeholder per block ("🖼 image", "🔊 audio", "📎 <name or uri>" for resource/resource_link)
    joined into the bubble's text instead of "" — same RenderItem shape, no new component
  → User sees a labeled placeholder, never a silently blank message bubble
```

### Data Model

_(Not a DB table — `NormalizedEvent` is a JSON-serialized TypeScript interface, see Persistence research above. Table format reused for field-level clarity.)_

| Entity | Field | Type | Constraints | Notes |
|--------|-------|------|-------------|-------|
| `NormalizedEvent` | `kind` | `NormalizedEventKind` | adds 2 new string values | `"mode_update"`, `"commands_update"` (Gaps 6, 7) |
| `NormalizedEvent` | `blocks` | `NormalizedContentBlock[]` \| undefined | optional | Gap 1 — set ONLY when raw content has ≥1 non-text block; pure-text content keeps using plain `text` unchanged (zero behavior change for the common case) |
| `NormalizedEvent` | `toolDiffs` | `ToolDiff[]` \| undefined | optional | Gap 2 — `{path, oldText?, newText}[]`, from `ToolCallContent` entries with `type:"diff"` |
| `NormalizedEvent` | `toolLocations` | `{path:string, line?:number}[]` \| undefined | optional | Gap 3 — from `tool_call`/`tool_call_update.locations` |
| `NormalizedEvent` | `toolKind` | `AcpToolKind` \| undefined | optional | Gap 4 — the 9-value `ToolKind` union verbatim, structural (not just a display-name fallback) |
| `NormalizedEvent` | `toolStatus` | `"pending"\|"in_progress"\|"completed"\|"failed"` \| undefined | optional | Gap 5 — mirrors ACP `ToolCallStatus` on both `tool_use`- and `tool_result`-kind events |
| `NormalizedEvent` | `modeId` | `string` \| undefined | optional | Gap 6 — on `mode_update` events, from `currentModeId` |
| `NormalizedEvent` | `commands` | `{name:string, description:string}[]` \| undefined | optional | Gap 7 — on `commands_update` events, from `availableCommands` |
| `NormalizedContentBlock` (new type) | `type` | `"text"\|"image"\|"audio"\|"resource"\|"resource_link"` | — | ALL blocks in a mixed array land here (Decision 1); `text`-type blocks in `blocks` are a redundant copy of the same content already in `NormalizedEvent.text` — kept for order/positioning, never the ONLY place text lives |
| `NormalizedContentBlock` | `text` | `string` \| undefined | — | `type:"text"` only |
| `NormalizedContentBlock` | `mimeType` | `string` \| undefined | — | `type:"image"\|"audio"\|"resource_link"` |
| `NormalizedContentBlock` | `data` | `string` \| undefined | — | base64, `type:"image"\|"audio"` only |
| `NormalizedContentBlock` | `uri` | `string` \| undefined | — | `type:"resource_link"`, or `type:"resource"`'s nested `resource.uri` |
| `NormalizedContentBlock` | `name` | `string` \| undefined | — | `type:"resource_link"` only (`ResourceLink.name`) |
| `ToolDiff` (new type) | `path` | `string` | required | absolute file path |
| `ToolDiff` | `oldText` | `string` \| undefined | — | absent ⇒ new file |
| `ToolDiff` | `newText` | `string` | required | — |

#### `toNormalizedBlock` mapping table (ACP `ContentBlock` variant → `NormalizedContentBlock`)

| ACP `type` | Normalized `type` | Populated fields |
|---|---|---|
| `text` (`TextContent{text}`) | `"text"` | `text` |
| `image` (`ImageContent{data,mimeType}`) | `"image"` | `data`, `mimeType` |
| `audio` (`AudioContent{data,mimeType}`) | `"audio"` | `data`, `mimeType` |
| `resource_link` (`ResourceLink{uri,name,mimeType?}`) | `"resource_link"` | `uri`, `name`, `mimeType` |
| `resource` (`EmbeddedResource{resource}`), `resource.text` present (`TextResourceContents`) | `"resource"` | `uri: resource.uri`, `mimeType: resource.mimeType` — NOT `resource.text` itself (Out of Scope: no embedded payload) |
| `resource` (`EmbeddedResource{resource}`), `resource.blob` present (`BlobResourceContents`) | `"resource"` | `uri: resource.uri`, `mimeType: resource.mimeType` — NOT `resource.blob` itself |
| any other/unrecognized `type` | (dropped) | `toNormalizedBlock` returns `undefined`, filtered out — same graceful-drop behavior as today, never a thrown error |

- **Relationships:** none new — all fields hang directly off `NormalizedEvent`, no new tables/FKs.
- **Migration:** N — `payload` is an untyped JSON blob (`sqliteTranscriptStore.ts:76`); old rows simply lack these keys, `JSON.parse` yields `undefined` for them, every consumer treats `undefined` as "not present" (hard constraint satisfied by construction, not by extra code).

### API Contracts

- `GET /sessions/:id/transcript`, `GET /sessions/:id/transcript?since=`, WS event broadcast — response `NormalizedEvent` shape gains the optional fields above; existing consumers reading only pre-existing fields are unaffected (TypeScript structural typing — no consumer needs to change to keep compiling or rendering).
- No other endpoint changes.

### Key Decisions

#### Decision 1: two separate helpers — `agent_message_chunk`/`agent_thought_chunk` take ONE block, `tool_call(_update).content` takes an ARRAY of a different union

- **Decision:** replace `textFromContentBlock` with `toNormalizedBlock(block: unknown): NormalizedContentBlock | undefined` (single-block mapper, per the mapping table in Data Model). Two call patterns:
  1. `agent_message_chunk`/`agent_thought_chunk` (`normalize.ts:60-70`): `raw.content` is ONE `ContentBlock` (confirmed in Research — `ContentChunk.content` is not an array). Map it once: `type:"text"` → `{ text: block.text }` (unchanged output shape); any other type → `{ blocks: [toNormalizedBlock(block)] }` with `text` left `undefined` (no text content exists to put there).
  2. `tool_call`/`tool_call_update.content` (`normalize.ts:78-88`, `:89-106`): this `content` field is `Array<ToolCallContent>` — a DIFFERENT union (`{type:"content", content: ContentBlock}` | `{type:"diff",...}` | `{type:"terminal",...}`). Keep the existing per-entry unwrap (`(c).content ?? c`, `normalize.ts:97`) before calling `toNormalizedBlock`, and separately extract `type:"diff"` entries into `toolDiffs` (Decision 2) — a `ToolCallContent` entry is never itself a bare `ContentBlock`.
- **Rationale:** matches the ACTUAL two different ACP shapes instead of assuming both are arrays of the same union; text-only content in both cases keeps identical output to today (byte-for-byte `text` string, no `blocks`).
- **Where:** `daemon/src/services/acp/normalize.ts:30-35` (replace `textFromContentBlock`), `:60-70` (chunk cases, single-block path), `:89-106` (tool_call_update array-walk, reusing the existing unwrap).

```typescript
// Gap 1 — single-block mapper for agent_message_chunk/agent_thought_chunk.
// Text-only content is UNCHANGED: `{ text }`, no `blocks` field, matching
// today's normalize.ts:61-63/67-69 exactly.
function toNormalizedBlock(block: unknown): NormalizedContentBlock | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text === "string" ? { type: "text", text: b.text } : undefined;
    case "image":
    case "audio":
      return typeof b.mimeType === "string" && typeof b.data === "string"
        ? { type: b.type, mimeType: b.mimeType, data: b.data }
        : undefined;
    case "resource_link":
      return typeof b.uri === "string"
        ? { type: "resource_link", uri: b.uri, name: typeof b.name === "string" ? b.name : undefined, mimeType: typeof b.mimeType === "string" ? b.mimeType : undefined }
        : undefined;
    case "resource": {
      const r = b.resource as Record<string, unknown> | undefined;
      return r && typeof r.uri === "string"
        ? { type: "resource", uri: r.uri, mimeType: typeof r.mimeType === "string" ? r.mimeType : undefined }
        : undefined;
    }
    default:
      return undefined;
  }
}

function contentFromChunk(block: unknown): { text?: string; blocks?: NormalizedContentBlock[] } {
  const mapped = toNormalizedBlock(block);
  if (!mapped) return {};
  if (mapped.type === "text") return { text: mapped.text };
  return { blocks: [mapped] };
}
```

#### Decision 2: Diffs, locations, kind live on the SAME `tool_use`/`tool_result` event, not a new kind

- **Decision:** `toolDiffs`/`toolLocations`/`toolKind` are added as sibling fields next to the existing `toolInput`/`toolResult` on whichever event (`tool_use` for the initial `tool_call`, `tool_result` for a terminal `tool_call_update`) already carries that toolId — no new `NormalizedEventKind` for these three gaps.
- **Rationale:** `MessageList.tsx:236-245` already merges a `tool_result` event into its matching `tool_use` item BY `toolId`; reusing that merge means zero new merge logic in `groupEvents` for diffs/locations/kind — only new fields to read once merged.
- **Where:** `daemon/src/services/acp/normalize.ts:78-88` (`tool_call` case — read `raw.locations`, `raw.kind`, `raw.content` diff blocks), `:89-106` (`tool_call_update` case — same three, merged onto the terminal `tool_result` event; a diff/location/kind present on a NON-terminal update, see Decision 4, is carried on that update's own event too).

#### Decision 3: Diff rendering reuses `DiffView` via a new `oldText`/`newText` prop path, backed by a new `diff` (jsdiff) dependency in web-ui

- **Decision:** add `"diff": "^9.0.0"` (jsdiff, MIT, ships its own types — no `@types/diff` needed, confirmed in Research) to `web-ui/package.json`. `DiffView`'s `diffText` prop becomes OPTIONAL (`diffText?: string`); it gains a new optional prop pair `oldText?: string; newText?: string`. When either is defined, compute `DiffHunk[]` via a new adapter instead of `parseUnifiedDiff`; otherwise fall back to `(diffText ?? "").trim()`, identical to today.
- **Rationale:** avoids hand-rolling an LCS/line-diff algorithm (out of scope per "small and tightly scoped"); reuses 100% of `DiffView`'s existing rendering, syntax highlighting (`shikiHighlighter`), and CSS (`preview-diff-*` classes) — the ACTUAL green/red styling the human asked for already exists and needs zero new CSS.
- **Where:** `web-ui/src/components/preview/DiffView.tsx:9-15` (prop interface — `diffText` → optional), `:38-53` (new prop branch before the existing `hunks` `useMemo`), `web-ui/package.json` (new dependency), new small adapter `web-ui/src/preview/diffFromTexts.ts` (`diffLinesToHunks(oldText, newText): DiffHunk[]`) kept separate from `diffParser.ts` since it's a different input shape (two full strings, not unified-diff text).
- Existing callers (`ToolRunSummary.tsx:131`, the standalone preview pane) keep passing only `diffText` — unaffected, since they never pass `oldText`/`newText`.

```typescript
// diffFromTexts.ts — Decision 3. Maps jsdiff's Change[] (added/removed/neither,
// each covering 1+ lines via `.value`) onto the SAME DiffHunk/DiffLine shape
// DiffView already renders, as ONE synthetic hunk (no @@ header math needed —
// jsdiff diffs the whole file, there's no "hunk" boundary concept to preserve).
import { diffLines } from "diff";
import type { DiffHunk, DiffLine } from "./diffParser";

export function diffLinesToHunks(oldText: string, newText: string): DiffHunk[] {
  const changes = diffLines(oldText, newText);
  const lines: DiffLine[] = [];
  let oldNum = 1, newNum = 1;
  for (const part of changes) {
    const type = part.added ? "added" : part.removed ? "removed" : "context";
    // jsdiff keeps trailing "\n" inside `.value`, so split() always leaves a
    // final "" entry EXCEPT for a part with no trailing newline (the file's
    // very last line) — only drop it when it's actually empty, never
    // unconditionally, or the last real line silently disappears.
    const rawLines = part.value.split("\n");
    if (rawLines[rawLines.length - 1] === "") rawLines.pop();
    for (const content of rawLines) {
      lines.push({
        type,
        content,
        oldLineNumber: type === "added" ? null : oldNum++,
        newLineNumber: type === "removed" ? null : newNum++,
      });
    }
  }
  return [{ header: `@@ -1,${oldNum - 1} +1,${newNum - 1} @@`, lines }];
}
```

- `ToolRunEntryRow` (`web-ui/src/components/chat/ToolRunSummary.tsx:77-138`) renders `<DiffView oldText={diff.oldText} newText={diff.newText} filePath={diff.path} />` per entry in `tool.diffs` — ONE `DiffView` per diff, shown ABOVE the existing text-result rendering (a tool call can carry both a diff and a text summary, e.g. "3 lines changed").
- When `tool.diffs` is non-empty, the EXISTING `looksLikeUnifiedDiff(resultText)` heuristic path is skipped for that entry (structured diff wins over heuristic text sniffing) — no behavior change for tool calls that only ever produced heuristic-detected diff TEXT (e.g. a raw `git diff` in Bash output), since those never populate `diffs`.

#### Decision 4: In-progress tool status reuses the `tool_result` kind with a non-terminal `toolStatus`; `groupEvents` merges per-field instead of overwriting

- **Decision:** `tool_call_update` no longer early-returns `null` for `pending`/`in_progress` (`normalize.ts:94`). It emits a `tool_result`-kind event with `toolStatus` set to the raw status; `toolResult` is set ONLY when the update actually carries `content` (may be entirely absent on a bare status tick) — never a `{content: undefined}` placeholder object. `toolDiffs`/`toolLocations`/`toolKind` are populated on this same event when present, per Decision 2.
- **Rationale:** the ACP spec's own doc comment ("only changed fields need to be included") means an in-progress update's ABSENT `content`/`locations`/`kind` must never be read as "clear the value already known" on the merged UI item. The actual risk is NOT the pre-existing `target.result = result` line (`MessageList.tsx:237-241` only ever held `content`/`isError`, and those two fields are never targeted by an in-progress update per this decision) — the risk is the NEW `diffs`/`locations`/`toolKind`/`status` fields this plan adds to the same merge, which must each be assigned only when the incoming event actually carries that field.
- **Where:** `daemon/src/services/acp/normalize.ts:89-106`; `web-ui/src/components/chat/MessageList.tsx:235-245` (`tool_result` case, exact change below); `web-ui/src/components/chat/toolFormat.ts:8-19` (`ToolCallEntry` gains `status?`, `diffs?`, `locations?`, `toolKind?` fields, all optional).
- **Regression guard:** a terminal update (`completed`/`failed`) ALWAYS carries the full final `content` per ACP's own contract for that transition, so `target.result = result` (guarded below) still runs unconditionally on the terminal path — identical resulting state as today.

```typescript
// MessageList.tsx groupEvents, "tool_result" case — replaces target.result = result.
// Only ever ADD fields the incoming event actually carries; never overwrite
// a known value with undefined.
case "tool_result": {
  markToolCallDuringThinking(ev.turnId);
  const idx = ev.toolId ? toolIndexById.get(ev.toolId) : undefined;
  const target = idx != null ? items[idx] : undefined;
  if (target && target.type === "tool") {
    if (ev.toolResult !== undefined) {
      target.result = { content: ev.toolResult.content, isError: ev.toolResult.isError };
    }
    if (ev.toolStatus !== undefined) target.status = ev.toolStatus;
    if (ev.toolDiffs !== undefined) target.diffs = ev.toolDiffs;
    if (ev.toolLocations !== undefined) target.locations = ev.toolLocations;
    if (ev.toolKind !== undefined) target.toolKind = ev.toolKind;
  } else {
    items.push({
      type: "tool", id: ev.id, toolName: ev.toolName ?? "tool", turnId: ev.turnId,
      result: ev.toolResult !== undefined ? { content: ev.toolResult.content, isError: ev.toolResult.isError } : undefined,
      status: ev.toolStatus, diffs: ev.toolDiffs, locations: ev.toolLocations, toolKind: ev.toolKind,
    });
  }
  break;
}
```

#### Decision 4b: `ToolRunEntryRow`/`ToolRunSummary`'s spinner and done-checkmark prefer `tool.status` over `result` truthiness when `status` is present

- **Decision:** `running` becomes `!!live && (t.status ? (t.status === "pending" || t.status === "in_progress") : !t.result)` — the `live` guard stays OUTSIDE the status check so a dead session replaying a persisted `toolStatus:"in_progress"` row (the process died mid-call) never spins forever; only a currently-live turn shows the spinner, exactly as today.
- Done-checkmark condition becomes `t.status ? t.status === "completed" : (!hasBody && !!result)`.
- `hasPending` (`ToolRunSummary.tsx:160`) keeps its existing `live && tools.some(...)` shape, with the inner predicate updated to the same status-aware check.
- Both fall back to today's exact truthiness logic when `status` is `undefined` (old rows, or a plugin/CLI that never sends structured status) — preserves old-row rendering exactly (hard constraint).
- **Why explicit, not optional:** an in-progress update can carry a diff/location with no text `content` — `result` stays falsy either way in that case (today's inference happens to still read "running" correctly), but a terminal `completed` update whose only content is a diff (no text) sets `target.result` to a defined-but-contentless object; explicit `status` removes any ambiguity for that case and every future non-text-only terminal shape.
- **Where:** `web-ui/src/components/chat/ToolRunSummary.tsx:77-138` (`ToolRunEntryRow`'s `running` prop and the done-checkmark check), `:153-186` (`ToolRunSummary` — `hasPending` at `:160`, the `running` prop passed at `:181`).

#### Decision 4c: `groupEvents`' `text`/`thinking` cases render a placeholder for a block-only event instead of a blank bubble

- **Decision:** `MessageList.tsx:172-184` (`text`) and the `thinking` case both currently do `text: ev.text ?? ""` unconditionally — with Decision 1, an image/audio/resource-only chunk now reaches this switch with `ev.text === undefined` and `ev.blocks` set, which would push an empty bubble (a REGRESSION: today this event never arrives here at all, since `normalize.ts` drops it before reaching the store). Fix: when `ev.text` is `undefined` and `ev.blocks` is non-empty, compute a one-line placeholder (`blocksToPlaceholder(ev.blocks)`: `"🖼 image"` / `"🔊 audio"` / `"📎 " + (name ?? uri)` per block, joined) and use that as the bubble text instead of `""`.
- **Rationale:** satisfies Out of Scope's own promise ("only a link/metadata chip... shown") with zero new component — same `assistant`/`thinking` `RenderItem`, just a different text string; a real empty-text event (the pre-existing edge case, e.g. a signature-only thinking chunk) is unaffected since `ev.blocks` is `undefined` there too, so the `??` fallback to `""` still applies.
- **Where:** `web-ui/src/components/chat/MessageList.tsx:172-184` (`text` case), the parallel `thinking` case (`MessageList.tsx:186-`, exact end line via Research), new helper `blocksToPlaceholder(blocks: NormalizedContentBlock[]): string` in `toolFormat.ts` or inline in `MessageList.tsx`.

#### Decision 5: `mode_update` / `commands_update` are new `NormalizedEventKind` values, rendered via the EXISTING `status` `RenderItem` — no new UI component

- **Decision:** two new kind strings are added to `NormalizedEventKind`. `normalize.ts`'s `default:` branch grows two new `case` arms mapping `current_mode_update`/`available_commands_update` to these kinds (instead of falling through to `return null`). `MessageList.groupEvents`' `switch` (`MessageList.tsx:146-273`) grows two new `case` arms that push the SAME `{ type: "status", id, text }` `RenderItem` the `status` kind already uses (`MessageList.tsx:265`) — text is `"Mode changed"` (+ modeId) / `"N command(s) available"` (+ names, capped) respectively.
- **Rationale:** satisfies the task's "mode/available-commands as status-like indicators" instruction literally, with zero new CSS/component — the `chat-status-note` div (`MessageList.tsx:771-777`) already exists and needs no change.
- **Alternative rejected:** reuse `kind:"status"` directly (like the existing `plan` case, `normalize.ts:107-116`) with `modeId`/`commands` as sibling optional fields, skipping the enum edit entirely. Rejected because it collapses "mode changed" and "commands available" into one indistinguishable kind at the storage layer, losing the ability to query/filter/replay-skip one without the other later — the 3-file enum cost (`types.ts`, `protocol.ts`, `api/types.ts`) buys that distinction now while the migration is fresh in memory.
- **Where:** `daemon/src/types.ts:74-84` (`NormalizedEventKind` — add `"mode_update" | "commands_update"`), `daemon/src/services/acp/normalize.ts:117-118` (`default:` → two new cases before it), `web-ui/src/components/chat/MessageList.tsx:146-273` (two new `case` arms before `default:`), `web-ui/src/api/types.ts:181-191` (mirror the 2 new kind strings), `daemon/src/ws/protocol.ts:157-168` (mirror the 2 new kind strings in the Zod enum — see Research B1).

#### Decision 6: `web-ui/src/api/types.ts` AND `daemon/src/ws/protocol.ts` both get every new field too — same existing hand-mirror convention, not a new pattern

- **Decision:** every field added to `daemon/src/types.ts`'s `NormalizedEvent` in this plan is copy-pasted (same names/types, structurally) into `web-ui/src/api/types.ts:194-221`'s `NormalizedEvent` interface, exactly as the pre-existing fields already are (e.g. `logSeq`, `edited`, `cancelled` all appear in both files today with no shared import). The SAME fields are also added to `daemon/src/ws/protocol.ts:152-185`'s Zod `NormalizedEventSchema` (a third, independently-maintained copy — see Research B1) with matching Zod shapes.
- **Rationale:** this is the codebase's existing (if informal) contract-sync mechanism; introducing a shared-types package here would be a scope-inflating refactor this plan explicitly avoids (Out of Scope).
- **Where:** `web-ui/src/api/types.ts:194-221`, `daemon/src/ws/protocol.ts:152-185`.

#### Decision 7: non-terminal `tool_call_update` events are persisted as-is; accept the extra SQLite rows as a known, bounded cost

- **Decision:** every `pending`/`in_progress` update that reaches `normalizeSessionUpdate` produces one persisted row (Research: `jsonAgent.ts:1144` calls `store.append` unconditionally). No de-duplication/coalescing is added in this plan.
- **Rationale:** ACP tool-call status ticks are bounded by actual tool-call count per turn (not a heartbeat/poll), so row growth is proportional to real work done, not wall-clock time — acceptable for "small and tightly scoped." Coalescing (e.g. "only persist a status change, not every identical tick") is a valid follow-up but adds stateful bookkeeping this plan's Requirement 7 explicitly avoids.
- **Where:** no code change — this is a documented trade-off, tracked in Risks below.

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does every ACP-migrated CLI (claude/cursor/opencode/agy) actually emit `locations`/`kind`/diff blocks, or is this claude-adapter-specific?** | Per-plugin `enrich()` hooks (`AcpEnrichHook`, `normalize.ts:24-28`) are untouched by this plan — if a given adapter never sends these fields, the corresponding UI simply never renders (graceful, matches "optional" design); no plugin-specific code needed to ship this plan |
| 2 | **jsdiff line-based diff vs. the agent's own diff granularity (char-level edits)** | `diffLines` is coarse (whole-line add/remove) — acceptable for "green/red diff" per the human's ask; word-level diff highlighting is a follow-up, not required here |
| 3 | **`resource`/`resource_link` content blocks carrying large embedded text** | Out of Scope explicitly excludes rendering the embedded payload — only a metadata chip (name/uri/mimeType) is shown, so no size/perf concern from this plan |
| 4 | **Persisting every non-terminal tool status tick grows the transcript row count** | Accepted per Decision 7 — bounded by tool-call count, not time; coalescing is a follow-up, not required here |

---

## Implementation Phases

### Phase 1 — `daemon/src/types.ts` + `daemon/src/ws/protocol.ts`: additive type surface

- [x] **1.1** Add `"mode_update" | "commands_update"` to `NormalizedEventKind` (`daemon/src/types.ts:74-84`)
- [x] **1.2** Add `NormalizedContentBlock` interface (per the mapping table in Data Model, including `text?`) + `ToolDiff` interface + `AcpToolKind` type alias (the 9-value `ToolKind` union) near the `UsageInfo`/`Attachment` interfaces (`daemon/src/types.ts:86-111`)
- [x] **1.3** Add optional fields to `NormalizedEvent`: `blocks?`, `toolDiffs?`, `toolLocations?`, `toolKind?`, `toolStatus?`, `modeId?`, `commands?` (`daemon/src/types.ts:116-171`)
- [x] **1.4** Mirror 1.1 + 1.3 into `daemon/src/ws/protocol.ts:152-185`'s `NormalizedEventSchema` — add the 2 kind strings to the `z.enum([...])` at `:157-168`, add 7 matching `z.optional(...)` field schemas (see Research B1 — required for `tsc`/`jsonProtocol.test.ts` to keep passing)

**Verify phase 1:**
- [x] **1.T1** Unit — `pnpm --filter @vibestation/cli build` (runs `tsc`) passes with the new optional fields; no existing call site required to change (structural typing)
- [x] **1.T2** Regression — `daemon/src/__tests__/jsonProtocol.test.ts` still passes (confirms `NormalizedEventSchema` parses events using only pre-existing fields, and now also parses the 2 new kinds)

---

### Phase 2 — `daemon/src/services/acp/normalize.ts`: populate instead of drop

- [x] **2.1** Add `toNormalizedBlock`/`contentFromChunk` helpers per Decision 1, replacing `textFromContentBlock` at the `agent_message_chunk`/`agent_thought_chunk` call sites (`normalize.ts:60-70`) — text-only content produces identical output to today
- [x] **2.2** `tool_call` case (`normalize.ts:78-88`): read `raw.locations` → `toolLocations`, `raw.kind` → `toolKind` (keep existing display-name fallback logic unchanged for `toolName`), scan `raw.content` (array of `ToolCallContent`, reusing the existing `(c).content ?? c` unwrap) for `{type:"diff"}` entries → `toolDiffs`
- [x] **2.3** `tool_call_update` case (`normalize.ts:89-106`): remove the line-94 `pending`/`in_progress` early-return; for ANY status, build the event with `toolStatus`, set `toolResult` only when `content` text is actually present, merge `toolDiffs`/`toolLocations`/`toolKind` from `raw.content`/`raw.locations`/`raw.kind` (all optional, absent when the update doesn't touch them), keep existing terminal `isError` behavior for `completed`/`failed`
- [x] **2.4** Add `case "current_mode_update":` → `stamp({ kind: "mode_update", modeId: raw.currentModeId })`, before `default:` (`normalize.ts:117`)
- [x] **2.5** Add `case "available_commands_update":` → `stamp({ kind: "commands_update", commands: (Array.isArray(raw.availableCommands) ? raw.availableCommands : []).map(c => ({name: c.name, description: c.description})) })`, before `default:` — guard with `Array.isArray` matching the file's existing style (e.g. `normalize.ts:109`'s `entries`)
- [x] **2.6** Rewrite the existing test "an in-progress tool_call_update (no terminal status) produces nothing" (`acpNormalize.test.ts:58-65`) to assert the NEW behavior: a `tool_result`-kind event with `toolStatus:"in_progress"` and `toolResult` undefined (no `content` was sent)
- [x] **2.7** Update the file-header comment (`normalize.ts:1-9`) — remove the now-false "Introduces NO new NormalizedEventKind" claim, replace with a note that `mode_update`/`commands_update` are the only 2 new kinds and everything else is additive fields on existing kinds

**Verify phase 2:**
- [x] **2.T1** Unit — `acpNormalize.test.ts`: `agent_message_chunk` with `content:{type:"image",data:"...",mimeType:"image/png"}` (a SINGLE non-text block, matching the real `ContentChunk` shape) → event has `blocks:[{type:"image",...}]` and `text` undefined
- [x] **2.T2** Unit — `acpNormalize.test.ts`: `tool_call` with `content:[{type:"diff",path,oldText,newText}]` → event's `toolDiffs` contains that diff verbatim
- [x] **2.T3** Unit — `acpNormalize.test.ts`: `tool_call_update` with `status:"in_progress"`, no `content` → returns a `tool_result`-kind event with `toolStatus:"in_progress"` and `toolResult` undefined (supersedes 2.6's old assertion)
- [x] **2.T4** Unit — `acpNormalize.test.ts`: `current_mode_update` → `kind:"mode_update"`, `modeId` set; `available_commands_update` → `kind:"commands_update"`, `commands` set
- [x] **2.T5** Regression — `acpNormalize.test.ts`: every existing test EXCEPT the one rewritten in 2.6 passes unmodified (text-only chunks, terminal tool_call_update, `user_message_chunk` drop, unknown-kind `null`, `plan` → `status`)

---

### Phase 3 — Web-ui type mirror + `MessageList` merge/render

- [x] **3.1** Mirror all Phase 1 additions into `web-ui/src/api/types.ts:181-221` per Decision 6
- [x] **3.2** `ToolCallEntry` (`web-ui/src/components/chat/toolFormat.ts:8-19`) gains `status?`, `diffs?: ToolDiff[]`, `locations?`, `toolKind?`
- [x] **3.3** `groupEvents`' `tool_use` case (`MessageList.tsx:229-234`) copies `toolDiffs`/`toolLocations`/`toolKind`/`toolStatus` onto the pushed item as `diffs`/`locations`/`toolKind`/`status`; `tool_result` case (`MessageList.tsx:235-245`) replaced per Decision 4's exact code block (per-field merge, never overwrite with `undefined`)
- [x] **3.4** Add `case "mode_update":` / `case "commands_update":` to `groupEvents`' switch (before `default:`, `MessageList.tsx:268`), pushing the existing `{type:"status", ...}` shape per Decision 5
- [x] **3.5** `ToolRunEntryRow`/`ToolRunSummary` (`ToolRunSummary.tsx:77-138`, `:153-186`) — `running`/done-checkmark/`hasPending` logic updated per Decision 4b (keep the `live` guard outside the status check)
- [x] **3.6** `groupEvents`' `text` and `thinking` cases (`MessageList.tsx:172-184` and the parallel `thinking` block) — add `blocksToPlaceholder` per Decision 4c so a block-only event renders a labeled placeholder, never an empty bubble

**Verify phase 3:**
- [x] **3.T1** Unit — `web-ui/src/components/chat/MessageList.test.tsx` (existing `groupEvents` test file): a `tool_result` event with `toolStatus:"in_progress"` and no `toolResult` does NOT erase a previously-set `diffs` on the same toolId's item (asserts Decision 4's per-field merge)
- [x] **3.T2** Unit — `MessageList.test.tsx`: a `mode_update` event with `modeId:"build"` produces a `status`-type `RenderItem`
- [x] **3.T3** Unit — new test in `ToolRunSummary.test.tsx` (create if absent) or `MessageList.test.tsx`: a tool item with `status:"in_progress"` and no `result` renders the spinner ONLY when `live`; the same non-live (replayed/dead-session) item renders no spinner (asserts Decision 4b's `live` guard); a tool item with `status:"completed"` renders the checkmark, not the spinner
- [x] **3.T4** Unit — `MessageList.test.tsx`: a `text` event with `text` undefined and `blocks:[{type:"image",...}]` renders a non-empty placeholder bubble, never an empty one (asserts Decision 4c)
- [x] **3.T5** Regression — existing `groupEvents`/`mergeToolRuns` tests (tool_use/tool_result merge-by-id, thinking-group open/close) all still pass

---

### Phase 4 — Diff rendering (`DiffView` + new `diff` dependency)

- [x] **4.1** Add `"diff": "^9.0.0"` to `web-ui/package.json` dependencies; `pnpm install` (no `@types/diff` needed — see Research)
- [x] **4.2** New `web-ui/src/preview/diffFromTexts.ts` — `diffLinesToHunks(oldText, newText): DiffHunk[]` per Decision 3's corrected snippet
- [x] **4.3** `DiffView` (`web-ui/src/components/preview/DiffView.tsx:9-15`, `:38-53`) — `diffText` becomes optional; new optional `oldText?`/`newText?` props; when either is set, use `diffLinesToHunks` instead of `parseUnifiedDiff`/`syntheticUntrackedHunks`; verify `ToolRunSummary.tsx:131`'s existing `diffText`-only call site still compiles and renders unchanged
- [x] **4.4** `ToolRunEntryRow` (`web-ui/src/components/chat/ToolRunSummary.tsx:77-138`) — when `tool.diffs` is non-empty, render one `<DiffView oldText newText filePath={diff.path} />` per entry, ABOVE the existing text-result block; skip the `looksLikeUnifiedDiff` heuristic path for that tool call

**Verify phase 4:**
- [x] **4.T1** Unit — `web-ui/src/components/preview/DiffView.test.tsx` (new, colocated with the component — NOT under `web-ui/src/preview/`): `oldText="a\nb"`, `newText="a\nc"` renders one removed line (`b`) and one added line (`c`)
- [x] **4.T2** Unit — new test in `ToolRunSummary.test.tsx` (create if absent, mirroring `ToolResultCard.test.tsx`'s diff-detection conventions): a tool entry with a `diffs` entry renders `DiffView` via the structured path, not the `looksLikeUnifiedDiff` heuristic
- [ ] **4.T3** Manual — sanity-check an actual file-edit tool call in a live claude/cursor/opencode JSON-channel session (whichever is exercisable locally — see Risk 1) shows green additions / red removals in the chat pane, not raw JSON or plain text
- [x] **4.T4** Regression — existing heuristic-diff path (`looksLikeUnifiedDiff` + `diffText` prop) still renders identically for a Bash `git diff`-shaped text result that carries no structured `diffs`

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/types.ts` | **Modified** | 1.1-1.3 | Adds `NormalizedContentBlock`, `ToolDiff`, `AcpToolKind` types; adds 2 `NormalizedEventKind` values; adds 7 optional `NormalizedEvent` fields — all additive |
| `daemon/src/ws/protocol.ts` | **Modified** | 1.4 | Mirrors the 2 kinds + 7 fields into the Zod `NormalizedEventSchema` |
| `daemon/src/services/acp/normalize.ts` | **Modified** | 2.1-2.7 | Contract: `normalizeSessionUpdate` now returns a non-null event for `current_mode_update`/`available_commands_update`/in-progress `tool_call_update`; populates diff/location/kind fields instead of dropping them |
| `daemon/src/__tests__/acpNormalize.test.ts` | **Modified** | 2.6, 2.T1-2.T5 | Rewrites 1 existing test (in-progress no longer returns null), adds new cases for each of the 7 gaps |
| `daemon/src/__tests__/jsonProtocol.test.ts` | **Unchanged (verified)** | 1.T2 | Confirms `NormalizedEventSchema` still parses correctly after 1.4 |
| `web-ui/src/api/types.ts` | **Modified** | 3.1 | Mirror new kinds/fields onto the client `NormalizedEvent` (Decision 6) |
| `web-ui/src/components/chat/toolFormat.ts` | **Modified** | 3.2 | `ToolCallEntry` gains `status?`, `diffs?`, `locations?`, `toolKind?` |
| `web-ui/src/components/chat/MessageList.tsx` | **Modified** | 3.3-3.4, 3.6 | `groupEvents`: per-field merge for `tool_result` (Decision 4), 2 new switch cases reusing the existing `status` `RenderItem`, block-only placeholder text (Decision 4c) |
| `web-ui/src/components/chat/MessageList.test.tsx` | **Modified** | 3.T1-3.T2, 3.T4-3.T5 | New cases for the merge fix, the 2 new kinds, and the block-placeholder fix; existing cases unmodified |
| `web-ui/src/components/chat/ToolRunSummary.tsx` | **Modified** | 3.5, 4.4 | Spinner/checkmark read `status` when present (Decision 4b); renders `DiffView` per structured diff |
| `web-ui/src/components/chat/ToolRunSummary.test.tsx` | **New or modified** | 3.T3, 4.T2 | Status-aware spinner/checkmark tests; structured-diff rendering test |
| `web-ui/src/components/chat/ToolUseCard.tsx` | **Unchanged** | — | Confirmed dead code (Research) — out of scope |
| `web-ui/src/components/chat/ToolResultCard.tsx` | **Unchanged** | — | Confirmed dead code (Research) — out of scope |
| `web-ui/src/components/preview/DiffView.tsx` | **Modified** | 4.3 | Contract: `diffText` becomes optional; new optional `oldText?`/`newText?` props, alternative input path |
| `web-ui/src/preview/diffFromTexts.ts` | **New** | 4.2 | Contract: `diffLinesToHunks(oldText: string, newText: string): DiffHunk[]` — pure, no I/O |
| `web-ui/src/components/preview/DiffView.test.tsx` | **New** | 4.T1 | Unit tests for the new `oldText`/`newText` prop path |
| `web-ui/package.json` | **Modified** | 4.1 | New dependency: `diff@^9.0.0` (jsdiff) |

**Test commands:**
- `pnpm --filter @vibestation/cli test` (daemon/CLI — Phase 1/2 tests)
- `pnpm --filter @vibestation/web test` (`web-ui/package.json:12` → `vitest run`; Phase 3/4 tests)

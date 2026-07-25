# Design: Queue controls — "Send now" + edit queued message

> Two small controls on top of the existing daemon-owned JSON turn queue: run a queued message ahead of schedule ("Send now" = jump-the-queue), and edit a queued message's text/attachments before it starts (Edit = withdraw-for-edit + re-enqueue). Both operate ONLY on not-yet-started queued turns; the daemon's `JsonAgentSession` queue stays the single source of truth.

**Issue:** queue-controls-send-now-edit
**Branch:** `json-mode-chat-with-file-upload`
**Status:** Pending — both product decisions RESOLVED (KD1 jump-the-queue; KD2 withdraw-for-edit)
**Parent design:** `.feature-plans/wip/json-mode/json-agent-chat.md` (Decision 8 = daemon-owned FIFO queue; Decision 12 = daemon-owned `user` event)

---

## Problem

- Queued messages can only be **cancelled** (`DELETE …/chat/queue/:turnId`) — not reordered or run early. A user who queued behind a long turn must wait or cancel + re-type.
- A queued message is frozen at enqueue: a typo can't be fixed without cancel + re-send (which loses queue position + re-uploads intent).

## Concept

- **Send now** — on a queued (not-started) turn, splice it to the **front** of the queue: it runs next, after the currently-active turn finishes. Nothing is interrupted (KD1, resolved).
- **Edit** — hitting Edit **atomically withdraws** the turn from the run queue into a daemon-held "editing" state (it can no longer start), opens an inline editor prefilled with its text + attachments; **Save** re-enqueues it at its **original index** (same `turnId` + superseding `user` event), **Discard** re-enqueues it unchanged (KD2, resolved).
- Both degrade cleanly: when nothing is running / queue is empty, they collapse into normal composer send / composer draft editing.

---

## Requirements

| # | Requirement |
|---|-------------|
| R1 | "Send now" on any **queued, not-yet-started** turn → splices it to queue index 0 (runs next after the active turn; nothing interrupted). |
| R2 | "Edit" on any **queued, not-yet-started** turn → withdraws it from the run queue into an editing state and opens an inline editor prefilled with its `message` + `attachmentIds`. |
| R3 | **Save** re-enqueues the edited turn at its **original queue index** (same `turnId`), appending a superseding `user` event with `edited:true` (Decision 12; append-only). **Discard** re-enqueues it unchanged at its original index (no superseding event). |
| R4 | Both actions address a turn by **`turnId`** (not "the last") — surfaced on every queued bubble; the tail is just the common case. |
| R5 | Daemon is the single source of truth: withdraw / re-enqueue / promote are `JsonAgentSession` methods gated on queue (or held) membership; the UI implements **no** ordering. |
| R6 | **Empty-edit rule:** a Save clearing text with **zero** attachments is rejected (reuse `ChatBody.refine` — message OR ≥1 attachment); text-empty + ≥1 attachment is allowed (files-only, reuse `injectAttachments` header-only path). |
| R7 | **Attachments:** an edit may add/remove attachment ids referencing **already-uploaded** session attachments (`getAttachment(sessionId, id)`); a removed id is dropped from the injected prompt only — the file stays on disk (cleaned with the session). Unknown id → 400 on Save. |
| **Edge cases (explicit requirements)** | |
| R8 | **No start-while-editing race:** because Edit atomically withdraws the turn from the run queue, it **cannot** dequeue/start while being edited — the race is eliminated by construction (no 409 `turn_started` path needed). |
| R9 | **Edit/Send-now after start or completion:** withdraw/promote on a turnId not in the run queue → **404 `not_queued`** (already running/done/cancelled) — no-op. UI hides both affordances the instant a bubble leaves `queued` (driven by `session:meta` queue entries). |
| R10 | **Send-now on the active or a completed turn:** not offered / no-op — the affordance only renders on `queued` bubbles (never on the running or a finished turn). |
| R11 | **Send-now when nothing is running (queue empty):** affordance not shown; composer send is already immediate — no promote call. |
| R12 | **Edit when nothing is queued:** degenerates to editing the composer draft (local textarea) — no API call. |
| R13 | **Multiple queued turns:** any may be edited/promoted by turnId. Send-now moves the target to index 0 (runs next); the relative order of the others is preserved. |
| R14 | **Middle-of-queue edit:** Save/Discard re-enqueue at the turn's **original index** (clamped to the current queue length if turns ahead have since dequeued), preserving order — only the tail case is trivial. |
| R15 | **Ghost / tombstone:** a withdrawn-and-not-yet-resaved turn must NOT read as "will run." Its bubble shows an **"editing"** state (from `session:meta` editing entries) — never a "queued" badge — in **all** tabs. It is absent from `queueDepth`/`queuedTurnIds` while held. |
| R16 | **Unsaved-edit limbo:** if the editor is closed/blurred without Save, the turn is **auto-restored** to the queue unchanged (client fires Discard on blur/close). Safety net: the daemon retains the held turn until an explicit Save/Discard, so a lost client leaves it in "editing" (recoverable by reopening), never silently dropped — until restart (R19). |
| R17 | **Edit-only-queued turn drains to idle:** while a turn is held for edit and it was the only queued item, an active turn completing leaves the session `idle` (the held turn isn't runnable); Save re-enqueues → it runs; Discard re-enqueues → it runs. |
| R18 | **Concurrency (two tabs):** both call the daemon; withdraw is atomic (a second tab's withdraw of an already-held turn → 409 `already_editing`); Save is last-write-wins on held content; promote-to-front is idempotent. Convergence via `session:meta` (queue + editing entries) + `session:message` (superseding `user`). |
| R19 | **Daemon restart:** unchanged from v1 — the in-memory queue AND any held (editing) turns are lost on restart; withdraw/save/promote on a vanished turn → 404. This feature adds **no** durability (still no `pending.jsonl`). |

---

## Research (current implementation)

- Queue + runner: `daemon/src/services/jsonAgent.ts` — `queue: QueuedTurn[]` (`:196`), `enqueue` persists the `user` event then pushes (`:249-286`), `drain` shifts + runs (`:377-397`), `runOneTurn` (`:409`), `stopActiveTurn` keeps queue (`:317`), `cancelQueuedTurn` filters by id (`:328`), `abortAndDrain` (`:300`), `emitStopped` "Turn stopped" (`:478`), `getMeta` broadcasts `turnState`+`queueDepth` (`:361-373`).
- `QueuedTurn = { turnId, input: TurnInput }`; `TurnInput = { message, attachmentPaths?, isFirstTurn }` (`:57-60`, `spawn.ts`).
- A turn LEAVES the queue at `this.queue.shift()` in `drain` (`:382`) — Edit withdraws *before* this can fire, which is why R8 has no race.
- Enqueue path + attachment injection: `daemon/src/services/jsonAgentChat.ts` — `enqueueChatTurn` (`:164`), `injectAttachments` files-only rule (`:144-151`).
- REST: `daemon/src/routes/sessions.ts` — `POST …/chat` (`:953`), `/chat/stop` (`:995`), `DELETE …/chat/queue/:turnId` (`:1006`), `ChatBody` refine (`:74-83`), `getAttachment` (`:963`).
- Web-UI: `hooks/useChat.ts` — `pending: PendingTurn[]` deduped by `turnId` (`:118-145`); `components/chat/MessageList.tsx` — queued pending bubble + cancel ✕ (`:147-166`), `groupEvents` pushes each `user` separately (`:36-37`); `components/chat/Composer.tsx`; `components/chat/StatusBar.tsx`; `api/client.ts` chat methods (`:650-719`).

---

## Architecture

```
MessageList queued bubble  (Edit ✎ · Send now ⏭ · Cancel ✕ ; "editing" state)
   → api.beginEditQueuedTurn / resubmitQueuedTurn / promoteQueuedTurn (REST)
   → routes/sessions.ts  POST …/queue/:turnId/edit · /resubmit · /promote
   → JsonAgentSession  (mutates queue[] + holds Map — SOURCE OF TRUTH)
         ├─ edit:    queue[] → holds{turn,index}         (out of run queue)
         ├─ resubmit: holds → queue[] at index; if edited → append `user`(edited:true)
         └─ promote: splice target → queue[0]  (jump; preempt = daemon-only opt-in, UI off)
   → getMeta (queue + editing entries) + session:message → all tabs via useChat
```

---

## Design Details

### CUJs

**Edit a queued message (happy path)**
```
User clicks ✎ on a queued bubble
  → POST …/queue/:turnId/edit  → daemon: queue → holds, returns {message, attachmentIds, index}
  → bubble flips to "editing" (all tabs, via session:meta) ; textarea prefilled
  → Save → POST …/queue/:turnId/resubmit {edited:true, message, attachmentIds}
  → daemon: holds → queue[index]; append superseding `user`(edited:true); drain
  → session:message(edited user) + session:meta → bubble shows new text + "queued"
```
- Discard / blur (R16): `resubmit {edited:false}` → held turn re-inserted unchanged at its index.
- Empty (R6): blank text + no attachments on Save → client-side + server 400.
- Already started (R9): `edit` on a turn no longer queued → 404 `not_queued`; editor not opened.

**Send now (jump-the-queue)**
```
Turn A running · [B, C] queued · user clicks ⏭ on C
  → POST …/queue/C/promote  → daemon: splice C to index 0 → queue = [C, B]
  → A finishes → C runs next → B after
```
- Not queued (R9/R10): C already running/done → 404 `not_queued`.

### API / Contract changes

**New REST** (all under `/sessions/:id`)

| Method · Path | Request | Response | Errors |
|---------------|---------|----------|--------|
| `POST /chat/queue/:turnId/edit` | — | `200 { turnId, message, attachmentIds, queueIndex }` | 404 (`not_queued`), 409 (`already_editing`) |
| `POST /chat/queue/:turnId/resubmit` | `{ edited: boolean, message?: string, attachmentIds?: string[] }` (`edited:true` requires `ChatBody` refine on `message`/`attachmentIds`) | `200 { ok, turnId }` | 400 (empty when `edited`), 400 (unknown attachment), 404 (`not_editing`) |
| `POST /chat/queue/:turnId/promote` | `{ preempt?: boolean }` (default false → jump-the-queue) | `200 { ok, turnId }` | 404 (`not_queued`); 409 only if `preempt` and no active turn |

- **Removed vs prior draft:** the `PATCH …/queue/:turnId` (in-place mutate-while-queued) is dropped — replaced by the atomic withdraw (`edit`) + `resubmit` pair (KD2).
- `DELETE …/chat/queue/:turnId` (cancel) unchanged.

**Changed WS/meta:** no new event **types**. Extend `SessionMeta` so tabs can render per-turn queued/editing state and converge (R15/R18); reuse `session:message` (superseding `user` carries `edited?:true`).

**New `JsonAgentSession` methods** (`jsonAgent.ts`):
- `beginEditQueuedTurn(turnId): { message, attachmentIds, index } | "not_queued" | "already_editing"` — splice from `queue[]` into `holds: Map<turnId,{turn,index}>`; `emitMeta`.
- `resubmitQueuedTurn(turnId, { edited, message?, attachments? }): "ok" | "not_editing"` — pull from `holds`; if `edited`, overwrite `input.message`/`attachmentPaths` + append superseding `user` event; insert into `queue[]` at `min(heldIndex, queue.length)`; `emitMeta`; `kickDrain`.
- `promoteQueuedTurn(turnId, { preempt }): "ok" | "not_queued" | "no_active"` — splice target to index 0; `preempt` (daemon-only opt-in, not called by UI) → `stopActiveTurn()` + re-queue interrupted at index 1; `emitMeta`.

### Data Model

| Entity | Field | Type | Notes |
|--------|-------|------|-------|
| `NormalizedEvent` (`types.ts`) | `edited` | `boolean?` | NEW — marks a superseding `user` event; replay keeps the **last** `user` per `turnId`. Migration: N. |
| `SessionMeta` (`types.ts`) | `queuedTurnIds` | `string[]` | NEW — turnIds still runnable in FIFO order (drives per-turn "queued" badge + affordances). `queueDepth` kept = `queuedTurnIds.length`. |
| `SessionMeta` | `editingTurnIds` | `string[]` | NEW — turnIds withdrawn into the editing hold (drives the "editing" state, R15). |
| in-memory `holds` Map | — | — | withheld turns during edit; no on-disk schema; no new durability (R19). |

### Key Decisions

#### Decision 1: "Send now" = jump-the-queue  ✅ RESOLVED
- **Decision:** `promoteQueuedTurn` default splices the target to `queue[0]` — it runs next after the active turn finishes; nothing is interrupted. A `preempt:true` branch (abort active turn, re-queue it at index 1, run target now) stays **wired in the daemon method but is NOT called by the UI**.
- **Rationale:** Jump-the-queue loses no output and raises no `--resume` ambiguity; it matches the "queue control" mental model. The existing **Stop** button already gives "stop, then send now" manually, so the UI needs no preempt path.
- **Where:** `jsonAgent.ts` `promoteQueuedTurn`; `routes/sessions.ts` promote endpoint (`preempt` flag accepted but UI omits it).

#### Decision 2: Edit = withdraw-for-edit + re-enqueue (not in-place PATCH)  ✅ RESOLVED
- **Decision:** Edit atomically **withdraws** the turn from `queue[]` into `holds` (so it cannot start mid-edit — eliminates the race, R8), returns its content + original index, and opens an inline editor. **Save** re-enqueues at the original index with a superseding `user` event (`edited:true`); **Discard**/blur re-enqueues unchanged. The daemon holds the turn until Save/Discard, so no ghost bubble and no silent loss (R15/R16).
- **Rationale:** Removes the start-while-editing race entirely and keeps `messages.jsonl` append-only (superseding event, never in-place rewrite; `persist` = `appendFileSync`, `jsonAgent.ts:554`). The queued `user` event is not necessarily the file tail (multiple queued turns), so "fix the last line" would be wrong.
- **Where:** `jsonAgent.ts` `beginEditQueuedTurn`/`resubmitQueuedTurn` + `holds`; `MessageList.groupEvents` (dedupe `user` by `turnId`, last wins); `useChat` (editing state from meta).

#### Decision 3: Queue/held membership is the authority (cross-tab + ordering)
- **Decision:** `edit` branches on `queue`-membership, `resubmit`/`promote` on `holds`/`queue`-membership — all evaluated synchronously on the daemon event loop (same atomic boundary as `cancelQueuedTurn`). Misses → `not_queued`/`not_editing`/`already_editing`. Re-enqueue index is clamped to the live queue length (R14).
- **Rationale:** The turn leaves `queue[]` only at `queue.shift()` (`:382`); single-threaded JS means withdraw/resubmit/promote and the shift never interleave — deterministic winner across tabs (R8/R9/R18).
- **Where:** `jsonAgent.ts:382` (shift boundary); new methods mirror `cancelQueuedTurn:328`.

#### Decision 4: Per-turn queued/editing state is broadcast, not inferred
- **Decision:** `SessionMeta` gains `queuedTurnIds` + `editingTurnIds`; the UI marks each rendered `user` event as queued (badge + ✎/⏭/✕) or editing (R15) from these, so all tabs converge without local guesswork.
- **Rationale:** The current optimistic `pending` bubble is short-lived (dropped once the authoritative `user` event lands); a durable per-turn state is needed to attach affordances and to show "editing" in other tabs.
- **Where:** `jsonAgent.ts` `getMeta`; `web-ui/src/api/types.ts` `SessionMeta`; `useChat`/`MessageList`.

### UI changes

| File | Change |
|------|--------|
| `web-ui/src/api/client.ts` | Add `beginEditQueuedTurn` (POST `/edit`), `resubmitQueuedTurn(sessionId, turnId, {edited, message?, attachmentIds?})` (POST `/resubmit`), `promoteQueuedTurn(sessionId, turnId)` (POST `/promote`), mirroring `cancelQueuedTurn` (`:685`). No preempt arg exposed. |
| `web-ui/src/hooks/useChat.ts` | Expose `editQueued` (begin → local editor state), `saveEdit`/`discardEdit` (resubmit), `sendNow` (promote); derive per-turn queued/editing from `meta.queuedTurnIds`/`editingTurnIds`; no-op when unqueued/empty (R11/R12). |
| `web-ui/src/components/chat/MessageList.tsx` | On queued `user` bubbles (identified via meta) add ✎ Edit + ⏭ Send now beside ✕ Cancel; render an **"editing"** state (inline textarea + `AttachmentChip` list) for `editingTurnIds`; auto-Discard on editor blur/close (R16); `groupEvents` dedupes `user` by `turnId` (last wins). |
| `web-ui/src/components/chat/Composer.tsx` | Share its attachment-draft + upload logic with the inline queued editor (extract a `useAttachmentDrafts` hook or pass an `editMode` prop). |
| `web-ui/src/components/chat/StatusBar.tsx` | No change (queueDepth already shown). |

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Held turn lost on client crash before Save/Discard | Daemon keeps it in `holds` (shows "editing" to all tabs, recoverable by reopening) until restart; consistent with v1 in-memory model (R19). No new durability. |
| 2 | Re-enqueue index when turns ahead dequeued during a long edit | Clamp to live queue length (R14); order among still-present turns preserved. |
| 3 | Superseded `user` event in a large transcript | One extra line per Save; `groupEvents` last-wins is O(n) — negligible. |
| 4 | Client-side vs server-side validation (R6/R7) | Validate both; server authoritative (reuse `ChatBody.refine` + `getAttachment`) on Save. |
| 5 | Preempt path shipped but UI-off | Daemon-only opt-in (Decision 1); document it isn't reachable from the web UI in v1. |

_No remaining OPEN product questions — KD1 (jump-the-queue) and KD2 (withdraw-for-edit) are both RESOLVED._

---

## Implementation Phases

### Phase 1 — Daemon queue methods + REST
- [ ] 1.1 `jsonAgent.ts`: add `holds: Map<turnId,{turn,index}>`; `beginEditQueuedTurn(turnId)` (splice `queue[]`→`holds`, return content+index, `emitMeta`); `resubmitQueuedTurn(turnId,{edited,message?,attachments?})` (holds→queue at clamped index; if `edited` overwrite input + append superseding `user`(edited:true); `emitMeta`; `kickDrain`).
- [ ] 1.2 `jsonAgent.ts`: `promoteQueuedTurn(turnId,{preempt})` — splice to index 0 (jump); `preempt` → `stopActiveTurn()` + re-queue interrupted at index 1 (daemon-only).
- [ ] 1.3 `jsonAgent.ts` `getMeta`: add `queuedTurnIds` (order of `queue[]`) + `editingTurnIds` (keys of `holds`); keep `queueDepth = queuedTurnIds.length`.
- [ ] 1.4 `types.ts` (+ web-ui `api/types.ts`): `NormalizedEvent.edited?`; `SessionMeta.queuedTurnIds`/`editingTurnIds`.
- [ ] 1.5 `routes/sessions.ts`: `POST …/chat/queue/:turnId/edit`, `/resubmit` (Zod: `edited` bool; when `edited`, `ChatBody`-style refine + resolve `attachmentIds` via `getAttachment`), `/promote` (`{preempt?}`); error mapping (`not_queued`→404, `already_editing`→409, `not_editing`→404). Drop the old `PATCH …/queue/:turnId`.

**Verify phase 1:**
- [ ] **1.T1** Unit — `beginEditQueuedTurn`: withdrawing a queued turn removes it from `queue[]`, records `{turn,index}` in `holds`, and `getMeta` now lists it in `editingTurnIds` (not `queuedTurnIds`); a non-queued turnId → `not_queued`; a second withdraw → `already_editing`.
- [ ] **1.T2** Unit — `resubmitQueuedTurn({edited:true,...})`: re-inserts at the original index, appends a `user` event with same `turnId`+`edited:true`; `{edited:false}` re-inserts unchanged with **no** new event; a drained-past index clamps to queue length (R14).
- [ ] **1.T3** Unit — `promoteQueuedTurn` (jump): `[A(active),B,C]` promote C → next dequeue C then B; nothing aborted. `preempt:true` → active aborted (`emitStopped` present), interrupted re-queued at index 1.
- [ ] **1.T4** Unit — **no race (R8):** a turn in `holds` is never selected by `drain` even when it is the only item + active turn completes → session `idle` (R17); resubmit then runs it.
- [ ] **1.T5** Integration — REST: `edit`→200 content+index; `resubmit{edited:true}` unknown attachment→400, empty text+no attachments→400; `resubmit{edited:false}` restores; `promote`/`edit` on a not-queued turn→404; second-tab `edit` on a held turn→409.
- [ ] **1.T6** Regression — `cancelQueuedTurn` + normal two-turn FIFO `drain` unchanged.

### Phase 2 — Web-UI affordances
- [ ] 2.1 `api/client.ts`: `beginEditQueuedTurn`, `resubmitQueuedTurn`, `promoteQueuedTurn` (no preempt arg).
- [ ] 2.2 `useChat.ts`: `editQueued`/`saveEdit`/`discardEdit`/`sendNow`; derive queued/editing per-turn from `meta.queuedTurnIds`/`editingTurnIds`; degrade to no-op when unqueued/empty (R11/R12).
- [ ] 2.3 `MessageList.tsx`: queued-bubble ✎/⏭ + ✕; inline editor for `editingTurnIds` with auto-Discard on blur/close (R16); `groupEvents` dedupes `user` by `turnId`.
- [ ] 2.4 `Composer.tsx`: share attachment-draft logic with the inline editor.

**Verify phase 2:**
- [ ] **2.T1** Unit — `groupEvents`: original + `edited` `user` events with the same `turnId` render **one** bubble with the edited text.
- [ ] **2.T2** Integration — ✎ withdraws (bubble → "editing" in this tab AND a second subscribed client via meta), prefills the editor; Save shows the new text + re-badges "queued".
- [ ] **2.T3** Integration — Discard (and editor blur, R16) re-enqueues unchanged; the bubble returns to "queued" with no extra event.
- [ ] **2.T4** Integration — ⏭ Send now → `promoteQueuedTurn`; the promoted bubble is the next to leave `queued` (via `session:meta`).
- [ ] **2.T5** Regression — cancel ✕ still works; a running/finished bubble shows none of ✎/⏭/editing (R9/R10/R15).

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/services/jsonAgent.ts` (+ test) | 1 | `holds` map, `beginEditQueuedTurn`, `resubmitQueuedTurn`, `promoteQueuedTurn`, meta queue/editing ids, superseding `user` event |
| `daemon/src/types.ts` | 1 | `NormalizedEvent.edited?`; `SessionMeta.queuedTurnIds`/`editingTurnIds` |
| `daemon/src/routes/sessions.ts` (+ test) | 1 | `edit`/`resubmit`/`promote` endpoints; drop old `PATCH` |
| `web-ui/src/api/types.ts` | 1 | mirror `edited?`, `queuedTurnIds`, `editingTurnIds` |
| `web-ui/src/api/client.ts` | 2 | `beginEditQueuedTurn`, `resubmitQueuedTurn`, `promoteQueuedTurn` |
| `web-ui/src/hooks/useChat.ts` (+ test) | 2 | `editQueued`/`saveEdit`/`discardEdit`/`sendNow`; per-turn state from meta |
| `web-ui/src/components/chat/MessageList.tsx` (+ test) | 2 | queued-bubble ✎/⏭/✕ + "editing" state; `groupEvents` dedupe |
| `web-ui/src/components/chat/QueuedTurnEditor.tsx` (NEW) | 2 | inline editor for a held turn (textarea + chips + save/discard) |
| `web-ui/src/hooks/useAttachmentDrafts.ts` (NEW) | 2 | attachment-draft/upload logic shared by `Composer` + `QueuedTurnEditor` |

---

## Review adjustments (fable, 2026-07-15) — RESOLVED, supersede the above where noted

A deep fable review found real blockers/gaps. All resolved as follows; this section is authoritative over any conflicting detail earlier in the doc.

**A1 — QueuedTurn data model (blocker).** `injectAttachments` runs in `enqueueChatTurn` *before* `agent.enqueue`, so the stored `input.message` carries the `[Attached files:]` path header and attachment **ids** are gone. Edit cannot prefill from that. **Fix:** `QueuedTurn` stores the **raw** user message + resolved `Attachment[]` (+ a monotonic `seq`); injection is **deferred to run time** in `runOneTurn` (`injectAttachments(rawMessage, attachments)` → the plugin's `message`/`attachmentPaths`). The daemon `user` event now carries the **raw** text (attachments render as chips) — this also fixes a pre-existing quirk where the sent bubble showed the injected path header. `beginEditQueuedTurn` returns `{ message: rawMessage, attachmentIds: attachments.map(id), queueIndex }`. `isFirstTurn`/system-prompt are computed at run time (`!firstTurnDone`), not stored per-turn.

**A2 — Re-insert ordering (blocker).** Numeric `min(heldIndex, len)` does NOT preserve relative order when a turn ahead is cancelled/dequeued/promoted. **Fix:** at withdraw record `aheadIds` (turnIds before it in the queue). On resubmit insert at `index = count of current queue members whose turnId ∈ aheadIds` (clamped to `queue.length`) — order preserved under arbitrary concurrent cancel/promote. Unit test adds the "cancel-ahead while editing" case.

**A3 — R16 blur race (blocker).** Auto-Discard on raw textarea `blur` races the Save click (blur fires first → `resubmit{edited:false}` → Save 404s → edit lost). **Fix:** auto-Discard fires only on explicit **Cancel / Escape / pane-close**, never on raw textarea blur. R16 restated accordingly.

**A4 — Lifecycle `working` on resubmit (major).** `drain` persists `idle` when the queue empties while a turn is held (R17); `resubmit` re-enqueues but nothing re-flips lifecycle → sidebar stuck idle while running. **Fix:** the `resubmit` route calls `persistLifecycleState(..., "working")` after re-enqueue (mirrors `POST /chat`). `promote` needs no change (requires an active turn).

**A5 — Held-turn recovery + cancel (major).** A held turn was unreachable (409 on re-edit) and un-cancellable (`cancelQueuedTurn` filtered `queue[]` only) → zombie until restart. **Fix:** drop `409 already_editing` — `beginEditQueuedTurn` on an already-held turn **re-acquires** it (returns the held content; Save is genuinely last-write-wins). `cancelQueuedTurn` and `abortAndDrain` also evict from `holds` + `emitMeta`, so an abandoned edit can be cancelled and a "clear-all" leaves no ghost.

**A6 — `ws/protocol.ts` schema mirror (major).** The Zod mirror of `types.ts` must gain `NormalizedEvent.edited` + `SessionMeta.queuedTurnIds`/`editingTurnIds` (+ `jsonProtocol.test.ts` assertions), else the declared mirror invariant drifts. Added to Phase 1.4.

**A7 — `groupEvents` dedupe position (major).** Render the `user` bubble at the **first** occurrence's position with the **latest** (edited) text/attachments — never teleport to the tail. `RenderItem.user` gains `turnId`; dedupe keeps a `turnId → item` index and updates in place.

**A8 — `preempt` cut (major, YAGNI).** The `preempt:true` branch (abort active + re-queue) is unreachable from the UI and semantically unresolved (dup `--resume` context, orphaned "Turn stopped" marker). **Removed from v1** — `promoteQueuedTurn(turnId)` only splices to index 0. Decision 1's preempt paragraph and test 1.T3's preempt half are dropped.

**A9 — UI failure salvage (major).** On a Save that 404s (turn started / daemon restart / another tab won), the edited text + attachment ids are **salvaged into the composer draft** (never dropped); an edit-begin 404 is a passive no-op (affordance already gone via meta). R18 restated: Save is *first-resubmit-wins*, loser salvages locally.

**A10 — restart/rebuilt meta (minor).** `buildMetaFromTranscript` + live `getMeta` always emit `queuedTurnIds`/`editingTurnIds` (empty when none); web `SessionMeta` types them required.

**A11 — Zod discard shape (minor).** `resubmit{edited:false}` ignores any `message`/`attachmentIds` (schema: content fields only consulted when `edited:true`).

**A12 — component structure (standards).** Inline editor is its **own** `QueuedTurnEditor.tsx` consuming a shared `useAttachmentDrafts` hook extracted from `Composer` — NOT an `editMode` prop on `Composer` and NOT inline bloat in `MessageList`. `MessageList` only decides *which* bubble swaps to the editor.

**A13 — deferred (noted, not in scope).** Larger refactors the review flagged as hygiene — extracting a `TurnQueue` module and moving `killProcessTree`/`collectDescendants` out of `jsonAgent.ts`, and splitting JSON-chat routes out of `sessions.ts` — are **deferred**: the new endpoints stay beside the existing chat endpoints (consistent placement), and `sessions.ts` remains under its ceiling. Also fixed a stale `web-ui/AGENTS.md` reference (the remount invariant lives in the root `AGENTS.md`).

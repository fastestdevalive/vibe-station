---
commit: d4509606bce09bf64b704d2a7d98f917de2e006e
date: 2026-09-06
---

# Subagent state-change: system event + delink proposal

## Answer (summary)

The current mechanism enqueues a plain-text `user`-kind event into the parent
agent's chat, making it look like a human sent the message. The right fix is a
new `kind: "message_generated"` (or `"system_event"`) event that:

1. Is stored in the transcript but **never submitted to the LLM** as a user turn
   — it is a log annotation, not an agent prompt.
2. Renders in the chat as a centred, small, muted "system pill" — visually
   distinct from both user bubbles and assistant bubbles.
3. Should **only fire on `waiting_for_human` transitions** (not `idle`/`done`/
   `exited`), keeping it actionable: the parent needs to know when a child
   *needs a reply*, not every time it idles.
4. Can be **injected immediately** — it is not a turn input, so there is no
   queue to preempt. The parent's current LLM turn is unaffected.

---

## Current mechanism (what's wrong)

### Daemon — `subagentNotify.ts`

| File | Line | What happens |
|------|------|-------------|
| `daemon/src/services/subagentNotify.ts` | 41-46 | `NOTABLE` set: `idle`, `waiting_for_human`, `done`, `exited` all trigger a parent wake |
| `subagentNotify.ts` | 161-166 | Text message string built: `"[vst] Subagent update…"` |
| `subagentNotify.ts` | 193 | `deps.enqueueTurn(parentId, message)` called |
| `daemon/src/services/lifecycle.ts` | 460-467 | `enqueueTurn` resolves the parent's `JsonAgent` and calls `agent.enqueue({ message })` |

### What `agent.enqueue` does (`jsonAgent.ts:603-636`)

```
enqueue()
  → emitUserEvent()    ← persists + broadcasts a kind:"user" event
  → queue.push()       ← adds a real LLM turn to the queue
  → kickDrain()        ← wakes the runner
```

The child state notice becomes a `kind: "user"` event in the parent's
transcript **and** a queued LLM turn. Both problems:

- **Visually:** renders as a user bubble — feels like the human sent it.
- **Semantically:** costs one full LLM turn per notice (model sees the text,
  must respond). With `MAX_NOTICES_PER_PARENT = 25` and 4 s coalescing, a
  busy child still costs the parent many turns.
- **Queue enqueue:** if the parent is already mid-turn the notice lands *after*
  whatever else is queued. It cannot jump ahead — it is a new FIFO entry.

### UI rendering (`MessageList.tsx:168-191`)

`kind: "user"` → `RenderItem type: "user"` → renders as a `TextMessage role="user"`.
There is currently no visual distinction: the notice looks identical to a real
user message.

The existing `kind: "status"` renders centred + muted (`chat-status-note`,
`chat.css:692-698`) but is used for internal metadata (mode changes, command
catalog updates) — it is never a prompt to the LLM.

---

## Proposed design

### 1. New `NormalizedEventKind`: `"message_generated"`

Add `"message_generated"` to the `kind` enum in:
- `daemon/src/ws/protocol.ts` — `NormalizedEventSchema.kind` (line 164-176)
- `web-ui/src/api/types.ts` — `NormalizedEventKind` (line 209-221)
- `daemon/src/types.ts` — wherever `NormalizedEvent` is defined

Fields needed (all optional beyond `id/ts/kind`):
```json
{
  "kind": "message_generated",
  "role": "system",          // or omit role — not user, not assistant
  "text": "…human-readable note…",
  "subagentId": "vs-82-a-xxx",
  "subagentName": "worker",
  "subagentState": "waiting_for_human"
}
```

### 2. Daemon changes — `subagentNotify.ts`

Replace `deps.enqueueTurn(parentId, message)` with a new dep:
`deps.emitSystemEvent(parentId, eventPayload)`.

The `emitSystemEvent` impl in `lifecycle.ts` would:
1. Call `agent.emitSystemEvent(payload)` — a new method on `JsonAgent`.
2. `emitSystemEvent()` persists + broadcasts the `message_generated` event.
3. **Does NOT push to `queue` and does NOT call `kickDrain`** — the parent's
   turn is unaffected.

This means delivery is **immediate** with no queue — the event appears in the
parent's chat transcript as soon as the child transitions, regardless of what
the parent is currently running.

### 3. Filter: only `waiting_for_human`

Reduce `NOTABLE` to just:
```ts
const NOTABLE: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  "waiting_for_human",
]);
```

- `idle` after a turn is noise — the parent cannot usefully act.
- `done` and `exited` are low signal; the parent learns these via the
  dashboard/session state WS events anyway.
- `waiting_for_human` is the only state where the child is **blocked** and
  needs the parent to act.

The coalescing window (`COALESCE_MS = 4000`) can stay — multiple children
going `waiting_for_human` within 4 s should still collapse into one event.

### 4. UI rendering — new `"message_generated"` branch in `MessageList.tsx`

`groupEvents()` handles it alongside `"status"`:
```tsx
case "message_generated":
  items.push({ type: "system_event", id: ev.id, text: ev.text ?? "",
               subagentId: ev.subagentId, subagentState: ev.subagentState });
  break;
```

Render in `MessageList`:
```tsx
case "system_event":
  node = (
    <div key={key} className="chat-system-event" role="note">
      {item.text}
    </div>
  );
  break;
```

CSS (new rule, `chat.css`):
```css
.chat-system-event {
  align-self: center;
  font-size: var(--font-size-sm);     /* smaller than status note */
  color: var(--fg-subtle);            /* even more muted */
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  background: var(--surface-subtle);  /* faint pill background */
  max-width: 60%;
  text-align: center;
}
```

---

## Questions answered

| Question | Recommendation |
|----------|---------------|
| Only on `waiting_for_human`, or all states? | **Only `waiting_for_human`** — other transitions are noise the parent can't act on |
| Preempt queue / send right away? | **Yes, unconditionally** — the event is not a turn input; it bypasses the queue entirely and is emitted immediately on child transition |
| Should it cost the parent an LLM turn? | **No** — removing the `enqueue` call is the core of this change |
| Persist to transcript? | **Yes** — same as `status` events, so replay includes it |
| Should it render for the user as well? | **Yes** — shows in both parent's session chat AND potentially in child's transcript as a "notified parent" annotation (optional) |

---

## Delink — severing the parent/child association

### Problem

`parentSessionId` is set at creation time and is currently permanent. Any
session spawned by an agent inside the same worktree is forever a "subagent"
of that parent: it receives state-change notifications, shows the ↑ Parent
chip, and appears in the parent's child list. There is no way to fire a truly
independent sibling session from within an agent without creating a whole new
worktree.

### Proposed UI — hover-reveal ✕ on the chips in `SubagentRow.tsx`

`SubagentRow` renders two kinds of chips (`chat-subagent-row__item`):
- `--parent` chip (↑ Parent · name) — shown on the child's own chat pane
- child chips (StatusDot + name) — shown on the parent's chat pane

Both get a **✕ button** that appears on hover and triggers a confirmation +
delink flow:

```tsx
// Pseudocode for the child chip (parent chip is symmetric)
<button className="chat-subagent-row__item" ...>
  <StatusDot … />
  <span className="chat-subagent-row__label">{sessionLabel(child)}</span>
  <button
    className="chat-subagent-row__delink"
    aria-label="Detach subagent"
    onClick={(e) => { e.stopPropagation(); openConfirm(child); }}
  >✕</button>
</button>
```

Confirmation: inline in the row (no modal) — replaces the chip text with:
> "Detach **worker**? It will no longer notify this agent. [Detach] [Cancel]"

Pressing **Detach** calls `PATCH /sessions/:id/delink` and the chip disappears
on the `session:updated` broadcast.

### Daemon — new `PATCH /sessions/:id/delink` endpoint (`sessions.ts`)

```
PATCH /sessions/:id/delink
  → sets session.parentSessionId = null in DB
  → broadcasts session:updated { sessionId, parentSessionId: null }
  → calls forgetSubagentNotify(id)  ← clears any buffered pending notice
```

`forgetSubagentNotify` already exists (`subagentNotify.ts:78-92`) and handles
exactly this: it removes the session from both its own pending buffer and from
any parent's buffer. So a delinked child mid-coalesce-window never delivers its
pending notice.

### Web-UI — handle `session:updated` with `parentSessionId: null`

`useServerSync` already applies `session:updated` patches to the store. Add
`parentSessionId` to the patched fields so the store record updates. `SubagentRow`
re-renders reactively: the chip disappears because the filter `s.parentSessionId
&& ancestors.has(s.parentSessionId)` no longer matches.

The `session:updated` WS schema (`protocol.ts`) needs `parentSessionId` added as
a nullable optional field — parallel to how `archivedAt`, `name`, and `supersededBy`
are already patched via the same event.

### CSS — hover reveal of ✕

```css
.chat-subagent-row__item { position: relative; }

.chat-subagent-row__delink {
  opacity: 0;
  position: absolute;
  right: var(--space-1);
  top: 50%;
  transform: translateY(-50%);
  font-size: var(--font-size-xs);
  color: var(--fg-muted);
  transition: opacity 0.1s;
  padding: 0 var(--space-1);
  line-height: 1;
}
.chat-subagent-row__item:hover .chat-subagent-row__delink,
.chat-subagent-row__item:focus-within .chat-subagent-row__delink {
  opacity: 1;
}
```

### What delink does NOT do

- Does not terminate the session — it keeps running.
- Does not move it to a different worktree.
- Does not affect the `SubagentRow` visibility in the child's own chat pane
  immediately (the child still sees "↑ Parent" until the `session:updated`
  patch lands, which is synchronous on the same WS connection).
- Does not suppress notifications that were already coalesced and queued before
  the delink (the coalesce flush fires before `forgetSubagentNotify` clears the
  entry if the timer already expired — acceptable race, one stray notice at most).

### `--no-parent` at spawn time (CLI complement)

For the "I know upfront I want a sibling" case, `vst session create` should
accept `--no-parent` to omit `sourceAgentId` from the POST body entirely.
Daemon-side `sourceAgentId` is already optional — the only change is the CLI
not defaulting it to `$VST_SESSION` when the flag is present.

---

## Not checked

- Whether `JsonAgent.emitSystemEvent` needs to handle the case where the agent
  has no stream open yet (race: child transitions before parent's `chat:open`
  arrives). The existing `emitUserEvent` path has this same exposure; the fix
  there is buffering in `jsonAgentStream.ts` — same approach would apply.
- Whether the `MAX_NOTICES_PER_PARENT` budget still makes sense once the
  change from `enqueue` to `emitSystemEvent` removes the LLM cost. It may be
  safe to raise or remove the cap since there's no token burn per event.
- Mobile / narrow-viewport rendering of the centred pill.
- The delink ✕ on the `--parent` chip (child's pane): should pressing it
  delink from the child's side or the parent's side? Both call the same
  endpoint (`PATCH /sessions/<child-id>/delink`) — the UX phrasing just
  differs ("Leave parent" vs "Detach subagent").

<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: Rich Chat block "Thinking..." indicator, scroll-lock, dot-sizing, and composer send/stop bugs

**Date:** 2026-08-24 · **Commit:** 13daa0042309ecadbb7a914b81dc7d2a2bb6e974 · **Scope:** web-ui rich chat (json channel) message rendering, agent block header, auto-scroll, StatusBar, Composer · **Method:** code reading, no device/browser available

## Answer

- **One root cause drives issues 1 + 2:** the daemon recomputes `turnState` from the kind of *every single normalized event* and re-emits meta each time (`daemon/src/services/jsonAgent.ts:1000-1019`, `:966-969`), so `thinking` flips `true→false→true` many times per turn. The UI mounts/unmounts `ThinkingHint` on that boolean (`MessageList.tsx:336,452-453,463`) and swaps it against `WorkingIndicator` (`MessageList.tsx:468`) → visible flicker. The *second* stacked "Thinking…" is a different component: every `thinking` event group also renders its own `ThinkingBlock` label (`ThinkingBlock.tsx:18-24,32`), and a turn emits many separate thinking groups because `groupEvents` only merges *adjacent* same-turn thinking events (`MessageList.tsx:126-134`).
- **No elapsed-time data model exists client-side:** `RenderItem` carries no timestamps (`MessageList.tsx:12-20`) even though every raw event has `ts` (`web-ui/src/api/types.ts:191`), so there is nothing today that could render "Thought for Xs" — it needs a new `startedTs`/`endedTs` on the thinking render item. Placement is also wrong-by-design: the hint is anchored *under the last user message*, i.e. above everything the agent then streams (`MessageList.tsx:329-336,452-453`).
- **Issues 3/4/5 are gaps left by the prior sub-feature, not new bugs:** the unconditional `scrollIntoView` on every content change was never made near-bottom-aware (only the *ResizeObserver* path was — `MessageList.tsx:285-288` vs `:307-325`); there is no jump-to-bottom control anywhere in the repo; dots are 6px/4px-gap (`chat.css:740-750`); and the `StatusBar` circular spinner was explicitly out of scope in the prior plan and still renders (`StatusBar.tsx:104`, `chat.css:1073-1082`).
- **Issue 6 (new): Composer hides Send while busy, even with text ready to send.** `busy` unconditionally swaps the button to `Stop` (`Composer.tsx:188-201`) — but sending while busy is a real, working action (it enqueues a turn into the tray, `ChatPane.tsx:217-218,243-253`), not a no-op. There is no queue-depth affordance on the button itself today.

## Evidence

| Claim | Source |
|-------|--------|
| `turnState` derived per-event kind, so it oscillates thinking→tool→responding→thinking within one turn | `daemon/src/services/jsonAgent.ts:1000-1019` |
| Every persisted event triggers `updateTurnState` + `emitMeta` (one meta push per token/tool event) | `daemon/src/services/jsonAgent.ts:966-969` |
| `thinking` prop is literally `turnState === "thinking"`; `turnActive` is the 3-state busy union | `web-ui/src/components/layout/ChatPane.tsx:84-88`, passed at `:200-201` |
| `ThinkingHint` renders only while `thinking` is true → unmounts on every flip | `MessageList.tsx:335-336`, `:452-453`, `:463` |
| `WorkingIndicator` is mutually exclusive with `ThinkingHint`, so the two swap on each flip | `MessageList.tsx:468` (`turnActive && !thinking`) |
| Per-block "Thinking…" label is `ThinkingBlock`, a *separate* component from `ThinkingHint` | `ThinkingBlock.tsx:18-24` (static, no-text case), `:32` (toggle case) |
| Thinking events merge into one item only when *immediately adjacent* and same `turnId` — a tool_use between them splits a new block | `MessageList.tsx:126-134` |
| Empty/signature-only thinking items are dropped only when a tool run is open, otherwise they render as a bare "Thinking…" | `MessageList.tsx:45-47` + `ThinkingBlock.tsx:18-24` |
| No elapsed/duration tracking: `RenderItem` union has no timestamp field | `MessageList.tsx:12-20` |
| Raw events *do* carry `ts` (ISO string) — the data exists, it's discarded at grouping | `web-ui/src/api/types.ts:188-215` |
| Unconditional scroll-to-bottom fires on items/pending/thinking/turnActive changes with no near-bottom guard | `MessageList.tsx:285-288` |
| The near-bottom guard (`distance < 80`) exists **only** in the ResizeObserver path | `MessageList.tsx:307-325` |
| No jump-to-bottom affordance exists | `$ grep -rn "jump-to-bottom\|scrollToBottom\|jumpTo" web-ui/src` → only `TerminalPane.tsx:451: term.scrollToBottom();` |
| Prior plan scoped only footer-resize-awareness; user-scroll respect covered only requirement 2a/2b, no jump button | `.vibekit/feature-plans/wip/chat-working-indicator-scroll-grow/plan-chat-working-indicator-scroll-grow.md` (Requirements table, Out of Scope) |
| Working dots are 6px with 4px gap + `--space-1` vertical padding | `web-ui/src/styles/chat.css:730-750` |
| Circular spinner rendered left of the Stop button in the status bar | `StatusBar.tsx:103-111` |
| Spinner is a 12px 2px-border rotating ring | `web-ui/src/styles/chat.css:1073-1082` |
| `.chat-statusbar__state` centers spinner against label (flex, `align-items: center`) | `web-ui/src/styles/chat.css:912-918` |
| Same `chat-spinner` class is reused elsewhere — removal must be scoped to StatusBar only | `ToolRunSummary.tsx:113,177`, `ChatPane.tsx:189` |
| No test asserts the StatusBar spinner (safe to remove) | `$ grep -n "spinner" web-ui/src/components/chat/*.test.tsx` → no output |
| Existing tests do assert working-indicator dots (will need updating if markup changes) | `MessageList.test.tsx:186,220` |
| `.chat-pane` is already a positioning context (usable for an overlay button) | `web-ui/src/styles/chat.css:146,165` |
| Scroll container is `.chat-pane__body` (`overflow-y:auto`), the list itself is unscrolled | `web-ui/src/styles/chat.css:171-175`, `:204-209` |
| Composer button is `Stop` whenever `busy`, regardless of textarea content | `Composer.tsx:188-201` |
| `canSend` (text or ready attachment present) is computed but only gates the `Send` branch — never consulted while `busy` | `Composer.tsx:96` |
| Sending while busy enqueues a real turn (queue tray), it is not blocked/ignored | `ChatPane.tsx:217-218` (`queueDepth={trayRows.length}`), `:243-253` (`onSend`) |
| `onKeyDown`'s Enter-to-send path calls the same `handleSend`, so Enter while busy-with-text also silently queues today, with no visual cue on the button | `Composer.tsx:98-109,116` |

## Detail

### 1. "Thinking..." header flickers / duplicates per block

- Root cause A (flicker): `thinking` is a *momentary* signal, not a phase.
  - `updateTurnState(ev.kind)` runs for every event: `thinking`→`thinking`, `text`→`responding`, `tool_use`→`tool` (`jsonAgent.ts:1000-1019`), each followed by `emitMeta()` (`jsonAgent.ts:966-969`).
  - `ChatPane.tsx:88` maps that straight to `thinking`; `MessageList.tsx:336,468` mount/unmount `ThinkingHint` and swap in `WorkingIndicator` on each flip.
- Root cause B (duplicate/stacked): two *different* components both say "Thinking…".
  - `ThinkingHint` (`MessageList.tsx:175-182`) — global, anchored under last user message.
  - `ThinkingBlock` (`ThinkingBlock.tsx:18-24,32`) — one per thinking item; `groupEvents` creates a new item whenever a non-thinking event intervenes (`MessageList.tsx:126-134`), so a tool-heavy turn yields N stacked "Thinking…" labels.
- Proposed fix:
  - Debounce/latch: derive a sticky `busy` phase in `ChatPane` (e.g. `thinking` sticky until `turnActive` goes false, or a ~300ms trailing debounce on `turnState`) instead of raw equality at `ChatPane.tsx:88`.
  - Render exactly one live affordance: drop `ThinkingHint` entirely and let the single trailing `WorkingIndicator` carry the label (also satisfies issue 5), OR keep the hint but suppress `ThinkingBlock`'s label while its block is the live one.
  - Collapse consecutive thinking groups in `groupEvents` across intervening empty items (extend the `MessageList.tsx:45-47` drop rule so empty thinking never opens a new block).

### 2. Stale "Thinking..." never resolves to "Thought for Xs" + placement

- Root cause: no duration data reaches the renderer.
  - `RenderItem` (`MessageList.tsx:12-20`) has `id`/`text`/`turnId` only — no `ts`, no `startedAt`/`completedAt`.
  - The source data has it: `NormalizedEvent.ts` (`web-ui/src/api/types.ts:191`), monotonic `logSeq` at `:214`.
  - Completion is implicit: a thinking block is "done" once any later event with the same `turnId` arrives, or the turn goes idle — nothing computes or stores that boundary today.
- Root cause (placement): the hint is emitted *after the last user item* (`MessageList.tsx:329-336`, insert at `:452-453`), so it always sits above the agent's streamed blocks, not attached to the block it describes.
- Proposed fix:
  - Extend the `thinking` `RenderItem` with `startedTs` (first thinking event's `ts`) and `endedTs` (`ts` of the first subsequent same-turn non-thinking event; unset while live).
  - `ThinkingBlock`: label = `Thinking…` + dots while `endedTs == null`; `Thought for ${round((ended-started)/1000)}s` once set (still expandable to the reasoning text).
  - Render the summary **below** the block's content (footer row of `.chat-thinking`), matching the "summarizes what's above" reading — requires reordering `ThinkingBlock.tsx:29-38` so the toggle row follows `__body`, or a second footer row.
  - Live-clock option: tick from `startedTs` while live so the number is visible before completion (needs a 1s interval in `ThinkingBlock`, gated on live).

### 3. Auto-scroll steals scroll position

- Root cause: the primary scroll effect has **no** near-bottom guard.

```
MessageList.tsx:285-288
useEffect(() => {
  bottomRef.current?.scrollIntoView({ block: "end" });
}, [items.length, pending.length, thinking, turnActive]);
```

- The guard the prior plan added lives only in the resize path (`MessageList.tsx:307-325`, `distance < 80`) — it does not protect the content-change path.
- `thinking`/`turnActive` are in the dep array, and (per issue 1) they flip constantly → the yank-to-bottom fires repeatedly mid-turn, not just on new messages.
- No jump-to-bottom control exists anywhere (`grep` above; only xterm's own `term.scrollToBottom()` in `TerminalPane.tsx:451`).
- Proposed fix:
  - Compute `distance = scrollHeight - scrollTop - clientHeight` fresh inside the effect (same technique/threshold as `:307-325`), scroll only when `distance < 80`; keep scrolling unconditionally on *own-user* sends (pending grows) so the composer still snaps down.
  - Add a `stuck`/`atBottom` state, updated from a `scroll` listener on `listRef.current.parentElement`, driving a floating ↓ button.
  - Placement: absolutely-positioned overlay bottom-right of the scroll viewport. `.chat-pane` is already `position: relative` (`chat.css:165`), but it also contains the footer — anchor to the pane and offset above the footer, or wrap `.chat-pane__body` in a relative wrapper so the button doesn't scroll away.
  - Multiple panes can be mounted (canvas mode) — scope by ref traversal, not global selectors (same constraint noted at `MessageList.tsx:296-306`).

### 4. Working 3-dot indicator too large

- Current sizing: `width/height: 6px`, `gap: 4px`, container `padding: var(--space-1) 0` (`chat.css:730-750`).
- Same 6px is used by `.chat-thinking-hint__dot` (`chat.css:713-719`) — shrinking one without the other will look inconsistent if both survive issue 1's cleanup.
- Proposed fix: 4px dots, 3px gap, drop container padding to 0 (or `--space-0`); if the label moves in (issue 5), size dots relatively (e.g. `0.35em`) so they track chat font-zoom (`ChatPane` overrides `--font-size-*` inline, `chat.css:154-162`).
- Tests assert `.chat-working-indicator__dot--on` counts (`MessageList.test.tsx:186,220`) — class names must survive or tests get updated.

### 5. Remove circular spinner; status text left of dots, baseline-aligned

- Current: `StatusBar.tsx:104` renders `<span className="chat-spinner" />` when `busy`, immediately left of the label (`:106`) and the Stop button (`:109-111`).
- `chat-spinner` is shared — `ToolRunSummary.tsx:113,177` (per-tool running) and `ChatPane.tsx:189` (history loading) must keep it; only the StatusBar usage is removed. The CSS rule (`chat.css:1073-1082`) stays.
- No test asserts it (`grep -n "spinner" web-ui/src/components/chat/*.test.tsx` → no output), so removal is test-safe.
- The label text itself comes from `turnLabel()` (`StatusBar.tsx:24-38`, "Thinking…"/"Responding…"/"Running tool…"), which lives in `StatusBar` — `MessageList` currently receives only booleans (`MessageList.tsx:240-244`), so moving the text into `WorkingIndicator` requires plumbing `turnState` (or a precomputed label) from `ChatPane.tsx:84-88` into `MessageList` → `WorkingIndicator`.
- Proposed fix:
  - Delete line `StatusBar.tsx:104`; leave `.chat-statusbar__state` flex rules (`chat.css:912-918`) or simplify to inline.
  - `WorkingIndicator({ label })` → `<span class="…__label">{label}</span><span class="…__dots">…</span>`.
  - Baseline alignment to the *bottom* line of a wrapping label: `.chat-working-indicator { display: flex; align-items: last baseline; }` and remove `align-items: center` from `__dots` (`chat.css:735-739`); fall back to `align-items: baseline` where `last baseline` is unsupported.

### 6. Composer: Send hidden behind Stop while agent is busy and text is typed

- Current: `{busy ? <Stop> : <Send disabled={!canSend}>}` (`Composer.tsx:188-201`) — `busy` alone decides the branch; `canSend` (text/attachment present) is never checked in the busy case.
- Effect: user types a follow-up while the agent works, sees only `Stop`, and Enter (`onKeyDown` → `handleSend`) *silently* enqueues the message with no button feedback that anything happened differently than "sending is blocked."
- Proposed fix:
  - Branch on `busy && !canSend` → `Stop`; `canSend` (any text/attachment ready, busy or not) → `Send`/queue icon.
  - While busy *and* `canSend`, use a distinct icon/label from the idle Send state — e.g. a "queue" glyph (▤/⏎-into-tray) or `Send · will queue` tooltip — so it's clear the click enqueues rather than sends immediately; reuse `queueDepth`/`trayRows.length` (already computed in `ChatPane.tsx:217`) to optionally badge the count.
  - Keep `Stop` reachable while busy with no text typed (today's only busy-with-empty-box case) — likely as a small icon-adjacent secondary control, or swap-on-hover, since one button can't be both `Stop` and `Send` at once; simplest: keep `Stop` as the button when the box is empty, swap to `Send`/queue the moment text/attachment appears, matching the `canSend` boundary exactly.

## Not checked

- No browser/device run — all findings are static; flicker cadence and dot sizes are inferred from code/CSS, not observed.
- Cursor/opencode providers' event cadence (whether they emit `thinking` events at all, which changes how often `turnState` flips) — only `jsonAgent.ts`'s generic mapping was read.
- Whether the daemon coalesces meta pushes over the WS before they reach `useChat` (throttle/dedupe on the client subscription path was not traced end-to-end).
- Whether any *other* consumer of `SessionMeta.turnState` depends on its high-frequency per-event granularity (a debounce there could regress them).
- Accessibility review of removing `ThinkingHint` (`role="status" aria-live="polite"` at `MessageList.tsx:177`) — the replacement must keep an aria-live announcement.

## Follow-ups

| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Debounce/latch `thinking` (and possibly `turnActive`) in `ChatPane.tsx:84-88` — client-side latch, or coalesce meta emission in `jsonAgent.ts:966-969`? | Fixes flicker at the source; client-side latch is lower-risk since other meta consumers are untraced |
| 2 | Consolidate to ONE live "Thinking…" affordance: drop `ThinkingHint` (`MessageList.tsx:175-182,452-453,463`) and let `ThinkingBlock` + trailing `WorkingIndicator` carry it? | Eliminates the stacked-duplicate label; also unblocks issue 5's label placement |
| 3 | Merge consecutive same-turn thinking groups across intervening empty/tool items in `groupEvents` (`MessageList.tsx:126-134`, `:45-47`) | Stops N "Thinking…" headers per tool-heavy turn |
| 4 | Add `startedTs`/`endedTs` to the `thinking` `RenderItem` (`MessageList.tsx:12-20`) from `NormalizedEvent.ts` and render `Thought for Xs` on completion | Only way to replace the stale live label with a terminal summary |
| 5 | Move the thinking summary line **below** the block body in `ThinkingBlock.tsx:29-38` — confirm this is wanted for the collapsed (no-content) case too | Placement change affects both live and completed states |
| 6 | Gate `MessageList.tsx:285-288` on the same `distance < 80` check as `:307-325`, with an exception for user-initiated sends | Stops the scroll yank; the exception keeps send→snap-to-bottom feeling right |
| 7 | Add a floating ↓ jump-to-bottom button — anchor above the footer inside `.chat-pane` (`chat.css:146-166`) or in a new relative wrapper around `.chat-pane__body` | Needs a layout decision before implementation; must work with multiple mounted panes |
| 8 | Shrink dots to ~4px/3px gap (`chat.css:730-750`); do the same for `.chat-thinking-hint__dot` (`:713`) if that component survives | Keeps the two dot styles consistent |
| 9 | Remove `StatusBar.tsx:104` only (keep `.chat-spinner` for `ToolRunSummary.tsx:113,177` and `ChatPane.tsx:189`) | Shared class — a blanket delete would break tool-running/loading indicators |
| 10 | Plumb `turnState` (or a label string) `ChatPane` → `MessageList` → `WorkingIndicator`, with `align-items: last baseline` | Required prop-drilling for issue 5's "text left of dots, baseline-aligned" |
| 11 | Rebranch `Composer.tsx:188-201` on `canSend` instead of raw `busy`, and design a distinct "will queue" affordance (icon/badge) for busy+canSend vs. idle Send | Restores the ability to send follow-ups while the agent works without hiding it behind a Stop-only button; needs a visual decision (icon vs. label vs. badge) before implementation |

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: Silent Subagent Notify

> When a child agent blocks on `waiting_for_human`, give the parent agent a dedicated notice slot so it can react — rendered as a subtle system pill, not as a human message bubble.

**Status:** Draft
**Technical plan:** _(link once the plan exists)_

---

## Problem

- The pill notification (`kind:"message_generated"`) informs the human but gives the parent agent no LLM turn, so it cannot react to a blocked child.
- Without a turn, the parent cannot reply to the child, spawn a replacement, or report back — breaking autonomous multi-agent flows.
- The old `kind:"user"` approach was removed because it rendered as a human-sent message and wasted an LLM turn visibly; a pure silent path did not exist.

## Goals

- Parent agent receives an LLM turn when any child enters `waiting_for_human`.
- Turn renders as a subtle system pill (like today's `<agent-1> finished` events) — not as a human message bubble.
- Existing UX (the centred pill) and safety caps are preserved unchanged.

## Non-goals

- Changing or replacing the pill notification — it stays as-is for the human.
- Removing or raising the `MAX_NOTICES_PER_PARENT` cap.

---

## Requirements

### Core delivery

| ID | Requirement | Reason |
|----|-------------|--------|
| R1 | When a child enters `waiting_for_human`, the parent also receives a notice (queued LLM turn) containing the notification text, alongside the existing pill. | The pill is for the human; the turn is for the agent so it can react. |
| R2 | The notice turn is marked `silent` — it renders no user bubble in the chat UI. | Prevents the parent's self-generated notification from appearing as a human message. |
| R5 | Each parent session holds at most one pending notice slot, outside the human message queue; a second flush merges into the slot rather than adding a new entry. | A dedicated slot removes all front-vs-back ordering ambiguity and means a notice can never jump a human message or be buried behind many of them. |
| R5b | The slot is consumed when the parent queue is empty and no turn is running; it never preempts a human-queued message. | Waits politely; human messages are never silently reordered. |

### Delivery ordering and atomicity

| ID | Requirement | Reason |
|----|-------------|--------|
| R8 | Notice slot is populated first, pill is emitted second, budget is charged third — all in one synchronous step; if slot population fails, neither pill nor budget charge happens. | Prevents pill-without-notice or budget burn-without-delivery divergence. |
| R9 | Turn text is composed at run time from stored child IDs, not at flush time; any child no longer `waiting_for_human` at run time is dropped, and if none remain the notice is discarded with no LLM turn fired. | Prevents the parent from being woken to reply to a child that has already unblocked. |

### Coalescing

| ID | Requirement | Reason |
|----|-------------|--------|
| R3 | If a notice slot already exists, any subsequent lifecycle event merges into it rather than creating a new slot. | The slot is the single coalescing point; existence-check is sufficient, no position check needed. |

### Tray and status bar

| ID | Requirement | Reason |
|----|-------------|--------|
| R10 | The notice slot is visible in the queue tray as a distinct muted system row labelled with the child name and state (e.g. "Waking parent — \<child\> is waiting for a reply"); no Edit or Send-now controls are shown. | Gives the human a legible cause for the parent entering a working state without offering controls that don't make sense. |
| R11 | A single Dismiss control is shown on the tray row; dismissing annotates the existing pill as dismissed rather than retracting it. | Dismissal is an explicit act; the transcript remains append-only and accurate. |
| R12 | While the notice turn is running, the status bar shows contextual text (e.g. "Checking on \<child name\>") instead of the generic working label. | Makes the composer going busy legible to the human without attributing it to a message they did not send. |
| R13 | Stop targets the notice turn with a labelled action (e.g. "Stop checking on \<child\>"); stopping a notice turn does not re-queue it and emits a short system annotation ("wake-up dropped; \<child\> is still waiting"). | Stop is unambiguous; the pill is never left implying a delivery that will not happen. |

### Abort and session lifecycle

| ID | Requirement | Reason |
|----|-------------|--------|
| R14 | Stopping the active turn or draining the human queue does not clear the notice slot; only session retire/delete does. | The notice survives abort and is re-validated at run time (R9), so a human pressing Stop does not silently kill the agent's wake-up. |

### Cap and budget

| ID | Requirement | Reason |
|----|-------------|--------|
| R6 | The `MAX_NOTICES_PER_PARENT` cap (25) applies to slot population; a failed delivery does not charge the budget. | Prevents unbounded spend; failed deliveries must not burn quota. |
| R15 | At cap exhaustion, the pill is still emitted (it costs nothing) but the notice slot is suppressed; on the first suppression only, a distinct warning pill is emitted ("auto-wake paused; reply here to resume"). | The human is informed once without repeated noise; the parent's silence is explained. |
| R16 | Whenever a child transitions out of `waiting_for_human` (for any reason), it is pruned from the parent's pending notice slot; if the slot is empty after pruning, it is discarded with no LLM turn fired. | The slot is always a reflection of current child state — the implementation watches state changes generically, not specific triggers like a human message. |

---

## Options considered

### How to hold and deliver the notice

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — dedicated per-session notice slot (outside human queue) | No ordering ambiguity; human messages never reordered; single coalescing point; no steer/enqueue branch | Notice waits indefinitely on a permanently busy parent | ✅ chosen |
| B — prepend to front of human queue | Immediate placement | Jumps human-queued messages; fights "Send now" promotions; fallback appends to back | ❌ rejected |
| C — steer when `canSteer=true`, enqueue otherwise | Delivers sooner when parent is idle | Steer fallback silently appends to back; steered path emits a `user` event the silent variant must suppress | ❌ rejected |

**Decision:** Option A because it has no ordering edge cases, no fallback path that violates placement, and makes coalescing trivial (one slot = one check).

---

## Resolved design questions

1. **Should the silent turn replace or accompany the pill?** — **Accompany.** The pill is the human-facing signal; the turn is the agent-facing one — they serve different audiences.
2. **Should coalescing happen at enqueue time or flush time?** — **At slot population time.** A pending slot is detected before a new one is created; no position check needed.
3. **Does the per-parent cap apply to the notice slot?** — **Yes, but only on success.** Failed delivery must not charge budget (R6).
4. **Should the parent's response to the notification be throttled or specially capped?** — **No.** The parent's reply is a standard outgoing message and follows the existing send path (`isSteering` → send now, otherwise enqueue); no new behaviour needed.
5. **Should turn text be composed at flush time or run time?** — **Run time.** Flush time creates stale notifications; run time lets stale entries be dropped cleanly (R9).
6. **Should the pill be retracted if the notice is dropped/dismissed?** — **No.** The transcript is append-only; a follow-up annotation is the correct signal (R13, R14).
7. **Should the notice slot be kept in sync with child state changes?** — **Yes** (R16). The slot is a live reflection of which children are currently blocked; any state change that takes a child out of `waiting_for_human` prunes it from the slot generically, regardless of what caused the transition.

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|------------------------|
| 1 | **What text should the notice slot contain?** | Child name + blocked state at run time; exact wording TBC with design. |
| 2 | **Should "Queued (N)" in the status bar count the notice slot?** | Likely no — the slot has its own tray row (R10); double-counting is confusing. Needs design sign-off. |
| 3 | **How should multi-level cascade be bounded?** | Each ancestor level burns its own cap; the 25-notice limit applies independently per parent. Unbounded cascade is theoretically possible but unlikely in practice — revisit if observed. |
| 4 | **Non-json parents receive no pill and no notice — is that acceptable?** | Yes for now (tmux channel parents are not multi-agent capable); document as a known limitation. |

/**
 * Subagent → parent state notifications (subagent-ux-v2).
 *
 * The problem this solves: a parent agent that spawns a subagent has no way to
 * learn anything about it afterwards. Its turn ends when it stops writing, and
 * nothing resumes it — so "I'll check back once it's done" is a promise the
 * model structurally cannot keep, and the user waits forever. A parent sitting
 * idle has no turn running, so SOMETHING has to create one; this module is that
 * something.
 *
 * Two rules shape the whole design:
 *
 *  1. **Never interrupt the parent.** Delivery goes through the notice slot
 *     mechanism in `JsonAgentSession`, not the human queue. The slot is
 *     consumed only when the human queue is empty and no turn is running, so
 *     a busy parent never gets interrupted.
 *  2. **Coalesce.** A subagent flips working→idle on every one of its turns,
 *     so notifying per raw transition would cost the parent one LLM turn per
 *     child turn — a 10-turn subagent would wake its parent 20 times. Changes
 *     are buffered per parent for `COALESCE_MS` and delivered as ONE turn
 *     describing the latest state of every child that moved.
 */
import type { LifecycleState } from "../types.js";
import { sessionChannel } from "./channel.js";

/** How long to gather further changes before waking the parent once. */
const COALESCE_MS = 4000;

/**
 * Per-parent budget. Bounds the parent→child→parent cycle: a woken parent may
 * spawn another child, whose changes wake it again. Every spawn is a deliberate
 * agent action so this is not a runaway loop, but it is unbounded SPEND without
 * a ceiling. Reset whenever a human sends the parent a turn (see `noteHumanTurn`).
 */
const MAX_NOTICES_PER_PARENT = 25;

/** Only `waiting_for_human` is actionable — it's the one state where the
 *  parent can actually do something (reply). `idle`/`done`/`exited` are
 *  surfaced via dashboard/WS state events and cost an LLM turn; suppressed. */
const NOTABLE: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  "waiting_for_human",
]);

interface Pending {
  /** childId → the most recent state seen for it. Later changes overwrite
   *  earlier ones, so a child that flips twice before the flush is reported
   *  once, at its final state. */
  children: Map<string, { name: string; state: LifecycleState }>;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
const noticeCount = new Map<string, number>();
/**
 * Tracks parents for which we've already emitted a cap-suppression warning pill
 * (R15 / KD-7). A second cap-hit on the same parent is silently suppressed.
 * Cleared by `forgetSubagentNotify` and `_resetSubagentNotifyForTest`.
 */
const suppressionWarned = new Set<string>();

/** Test seam — clears all buffered notices and budgets. */
export function _resetSubagentNotifyForTest(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  noticeCount.clear();
  suppressionWarned.clear();
}

/** A human (or any non-notice turn) engaged this parent — the budget that
 *  exists to stop unattended spend no longer applies. Also clears the
 *  suppression-warning flag so a fresh cap cycle emits the "auto-wake paused"
 *  pill again if the parent hits the cap a second time after replying. */
export function noteHumanTurn(parentSessionId: string): void {
  noticeCount.delete(parentSessionId);
  suppressionWarned.delete(parentSessionId);
}

/**
 * Drop all state for a deleted session, in BOTH roles: as a parent whose
 * budget and buffered notice we no longer need, and as a child sitting in some
 * other parent's buffer. Without this `noticeCount` grows one permanent entry
 * per parent ever notified, for the lifetime of the daemon.
 */
export function forgetSubagentNotify(sessionId: string): void {
  const own = pending.get(sessionId);
  if (own) {
    clearTimeout(own.timer);
    pending.delete(sessionId);
  }
  noticeCount.delete(sessionId);
  suppressionWarned.delete(sessionId);
  for (const [parentId, entry] of pending) {
    if (!entry.children.delete(sessionId)) continue;
    if (entry.children.size === 0) {
      clearTimeout(entry.timer);
      pending.delete(parentId);
    }
  }
}

export interface NotifyDeps {
  /** Resolve a session id to the record fields this module needs, or null. */
  lookup: (sessionId: string) => {
    id: string;
    name?: string | null;
    parentSessionId?: string | null;
    archivedAt?: string | null;
    supersededBy?: string | null;
    channel?: string;
    useTmux?: boolean;
    lifecycleState?: LifecycleState;
  } | null;
  /**
   * Sync. Populate (or merge into) the parent's notice slot with this child.
   * Returns true if the slot was populated/merged; false if the parent is at
   * cap (slot NOT populated — caller must NOT emit pill or charge budget).
   */
  populateNoticeSlot: (
    parentSessionId: string,
    childId: string,
    childName: string,
  ) => boolean;
  /**
   * Async. Emit the `message_generated` notification pill on the parent's
   * chat stream. Called ONLY when `populateNoticeSlot` returned true.
   */
  emitPill: (
    parentSessionId: string,
    payload: {
      subagentId: string;
      subagentName: string;
      subagentState: LifecycleState;
      text: string;
    },
  ) => Promise<void>;
  /**
   * Sync. Proactively remove a child from the parent's notice slot (R16 — child
   * left `waiting_for_human` before the slot was consumed). Called before the
   * NOTABLE gate so non-notable exits still trigger the prune.
   */
  pruneNoticeSlotChild: (parentSessionId: string, childSessionId: string) => void;
}

/**
 * Resolve the effective parent session id (following the supersededBy chain),
 * and verify it is a valid target. Returns the parent id string on success, or
 * null on failure (no parent, archived, done, non-json, or loop).
 */
function resolveParent(
  childSessionId: string,
  deps: NotifyDeps,
): { parentId: string; parent: NonNullable<ReturnType<NotifyDeps["lookup"]>> } | null {
  const child = deps.lookup(childSessionId);
  if (!child?.parentSessionId) return null; // not a subagent

  // Follow a reset parent forward to its live successor.
  let parentId: string | null = child.parentSessionId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const p = deps.lookup(parentId);
    if (!p?.supersededBy) break;
    parentId = p.supersededBy;
  }
  if (!parentId) return null;

  const parent = deps.lookup(parentId);
  if (!parent) return null; // deleted — dangling id is harmless by design
  if (parent.archivedAt) return null; // read-only; enqueueing would revive it
  if (parent.lifecycleState === "done") return null; // retired — must not burn tokens
  if (sessionChannel(parent as { channel?: never; useTmux?: boolean }) !== "json") return null; // tmux parent has no chat

  return { parentId, parent };
}

/**
 * Record a child's lifecycle transition. Cheap and synchronous: everything
 * expensive happens on the coalesced flush.
 */
export function noteSubagentStateChange(
  childSessionId: string,
  prevState: LifecycleState | undefined,
  newState: LifecycleState,
  deps: NotifyDeps,
): void {
  if (prevState === newState) return; // edges only

  // R16 — proactively prune from parent's notice slot when a child leaves
  // waiting_for_human (any reason, including non-notable exits). This fires
  // BEFORE the NOTABLE gate so non-notable transitions still trigger the prune.
  if (prevState === "waiting_for_human" && newState !== "waiting_for_human") {
    const resolved = resolveParent(childSessionId, deps);
    if (resolved) {
      deps.pruneNoticeSlotChild(resolved.parentId, childSessionId);
    }
  }

  if (!NOTABLE.has(newState)) return;

  const resolved = resolveParent(childSessionId, deps);
  if (!resolved) return;
  const { parentId } = resolved;

  // Cap guard (R15): do NOT return early here — flush() must still run at cap
  // so the notification pill and first-suppression warning pill can be emitted.
  // `populateNoticeSlot` enforces the cap; the pill path is independent of it.

  const child = deps.lookup(childSessionId);
  const entry = pending.get(parentId);
  const childInfo = { name: child?.name || childSessionId, state: newState };
  if (entry) {
    entry.children.set(childSessionId, childInfo);
    return; // timer already running — do NOT restart it, or a chatty child
    // could defer the flush indefinitely.
  }
  const timer = setTimeout(() => {
    void flush(parentId, deps);
  }, COALESCE_MS);
  // Never hold the process open just to deliver a notice.
  timer.unref?.();
  pending.set(parentId, { children: new Map([[childSessionId, childInfo]]), timer });
}

async function flush(parentId: string, deps: NotifyDeps): Promise<void> {
  const entry = pending.get(parentId);
  pending.delete(parentId);
  if (!entry) return;

  // Re-check the guards: the parent may have been archived, retired or deleted
  // during the coalescing window.
  const parent = deps.lookup(parentId);
  if (!parent || parent.archivedAt || parent.lifecycleState === "done") return;

  const currentCount = noticeCount.get(parentId) ?? 0;
  const atCap = currentCount >= MAX_NOTICES_PER_PARENT;

  if (atCap) {
    // FIX-C (R15): at cap, skip populateNoticeSlot (no LLM turn). Always emit
    // notification pills for every child — the user still sees who is waiting.
    // On the FIRST suppression only: also emit a cap-warning pill.
    for (const [childId, c] of entry.children) {
      await deps.emitPill(parentId, {
        subagentId: childId,
        subagentName: c.name,
        subagentState: c.state,
        text: ``,
      });
    }
    if (!suppressionWarned.has(parentId)) {
      suppressionWarned.add(parentId);
      await deps.emitPill(parentId, {
        subagentId: "",
        subagentName: "",
        subagentState: "waiting_for_human",
        text: "auto-wake paused; reply here to resume",
      });
    }
    return;
  }

  // Under cap — R8 atomicity: populate slot FIRST (sync); only on success emit
  // pill and charge budget. All children are attempted; at least one must
  // succeed for the budget to charge.
  let anySlotted = false;
  const slottedChildren: Array<[string, { name: string; state: LifecycleState }]> = [];

  for (const [childId, c] of entry.children) {
    const ok = deps.populateNoticeSlot(parentId, childId, c.name);
    if (ok) {
      anySlotted = true;
      slottedChildren.push([childId, c]);
    }
  }

  if (anySlotted) {
    // FIX-E (R8): emit pills BEFORE charging budget (populateSlot → emitPill → noticeCount).
    for (const [childId, c] of slottedChildren) {
      await deps.emitPill(parentId, {
        subagentId: childId,
        subagentName: c.name,
        subagentState: c.state,
        // Empty text: frontend composes "subagent <name> is now waiting..." (FIX-B)
        text: ``,
      });
    }
    // Charge budget ONCE per flush (not per child — KD-1 multi-child coalescing).
    noticeCount.set(parentId, currentCount + 1);
  }
  // If none slotted (all rejected by session for reasons OTHER than cap),
  // no pill is emitted — the session knows best why it rejected.
}

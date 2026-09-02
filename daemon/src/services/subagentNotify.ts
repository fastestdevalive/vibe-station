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
 *  1. **Never interrupt the parent.** Delivery always goes through
 *     `enqueue()`, never `submit()`. `submit()` steers on claude, which would
 *     inject the notice into whatever turn the parent is already running and
 *     derail it. Queued is the correct behaviour: the parent finishes what it
 *     is doing, then sees the notice as its next turn.
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

/** States worth waking a parent for. `working` is deliberately excluded — a
 *  child going busy tells the parent nothing it can act on, and it is the most
 *  frequent transition of all. */
const NOTABLE: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  "idle",
  "waiting_for_human",
  "done",
  "exited",
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

/** Test seam — clears all buffered notices and budgets. */
export function _resetSubagentNotifyForTest(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  noticeCount.clear();
}

/** A human (or any non-notice turn) engaged this parent — the budget that
 *  exists to stop unattended spend no longer applies. */
export function noteHumanTurn(parentSessionId: string): void {
  noticeCount.delete(parentSessionId);
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
  /** Enqueue (NEVER steer) a turn on the parent. */
  enqueueTurn: (parentSessionId: string, message: string) => Promise<void>;
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
  if (!NOTABLE.has(newState)) return;

  const child = deps.lookup(childSessionId);
  if (!child?.parentSessionId) return; // not a subagent

  // Follow a reset parent forward to its live successor: reset archives the old
  // row and mints a new id, and children keep pointing at the predecessor.
  let parentId: string | null = child.parentSessionId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const p = deps.lookup(parentId);
    if (!p?.supersededBy) break;
    parentId = p.supersededBy;
  }
  if (!parentId) return;

  const parent = deps.lookup(parentId);
  if (!parent) return; // deleted — a dangling parent id is harmless by design
  if (parent.archivedAt) return; // read-only; enqueuing would revive it
  if (parent.lifecycleState === "done") return; // retired — must not start burning tokens
  if (sessionChannel(parent as { channel?: never; useTmux?: boolean }) !== "json") return; // tmux parent has no chat to enqueue into

  if ((noticeCount.get(parentId) ?? 0) >= MAX_NOTICES_PER_PARENT) return;

  const entry = pending.get(parentId);
  const childInfo = { name: child.name || child.id, state: newState };
  if (entry) {
    entry.children.set(childSessionId, childInfo);
    return; // timer already running — do NOT restart it, or a chatty child
    // could defer the flush indefinitely.
  }
  const timer = setTimeout(() => {
    void flush(parentId as string, deps);
  }, COALESCE_MS);
  // Never hold the process open just to deliver a notice.
  timer.unref?.();
  pending.set(parentId, { children: new Map([[childSessionId, childInfo]]), timer });
}

const PHRASE: Record<string, string> = {
  idle: "finished its turn and is idle",
  waiting_for_human: "is waiting for a reply",
  done: "is done",
  exited: "exited",
};

async function flush(parentId: string, deps: NotifyDeps): Promise<void> {
  const entry = pending.get(parentId);
  pending.delete(parentId);
  if (!entry) return;

  // Re-check the guards: the parent may have been archived, retired or deleted
  // during the coalescing window.
  const parent = deps.lookup(parentId);
  if (!parent || parent.archivedAt || parent.lifecycleState === "done") return;

  const lines = [...entry.children.entries()].map(
    ([id, c]) => `- ${c.name} (${id}) ${PHRASE[c.state] ?? c.state}`,
  );
  const message =
    `[vst] Subagent update — you spawned these, and they have changed state:\n` +
    `${lines.join("\n")}\n\n` +
    `Read a subagent's work with \`vst session output <id>\`. If it has finished ` +
    `and you have consumed its result, terminate it with \`vst session terminate <id>\`. ` +
    `If it is waiting for a reply, answer it with \`vst chat <id> "..."\`. ` +
    `If nothing here needs action from you, say so briefly and stop.`;

  noticeCount.set(parentId, (noticeCount.get(parentId) ?? 0) + 1);
  await deps.enqueueTurn(parentId, message);
}

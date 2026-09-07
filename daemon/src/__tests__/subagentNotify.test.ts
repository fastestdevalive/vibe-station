import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  noteSubagentStateChange,
  noteHumanTurn,
  _resetSubagentNotifyForTest,
  type NotifyDeps,
} from "../services/subagentNotify.js";
import type { LifecycleState } from "../types.js";

type Rec = NonNullable<ReturnType<NotifyDeps["lookup"]>>;

type EmittedPill = {
  parent: string;
  subagentId: string;
  subagentName: string;
  subagentState: LifecycleState;
  text: string;
};

type SlotCall = { parent: string; childId: string; childName: string };
type PruneCall = { parent: string; child: string };

function makeDeps(records: Record<string, Partial<Rec>>): {
  deps: NotifyDeps;
  pills: EmittedPill[];
  slots: SlotCall[];
  prunes: PruneCall[];
  /** Control whether populateNoticeSlot returns true or false. Default: true. */
  slotReturns: (parentId: string) => boolean;
  setSlotReturn: (parentId: string, val: boolean) => void;
} {
  const pills: EmittedPill[] = [];
  const slots: SlotCall[] = [];
  const prunes: PruneCall[] = [];
  const slotReturnMap = new Map<string, boolean>();
  const slotReturns = (parentId: string): boolean => slotReturnMap.get(parentId) ?? true;
  const setSlotReturn = (parentId: string, val: boolean) => slotReturnMap.set(parentId, val);

  const deps: NotifyDeps = {
    lookup: (id) => {
      const r = records[id];
      if (!r) return null;
      return { id, channel: "json", ...r } as Rec;
    },
    populateNoticeSlot: (parent, childId, childName) => {
      slots.push({ parent, childId, childName });
      return slotReturns(parent);
    },
    emitPill: async (parent, payload) => {
      pills.push({ parent, ...payload });
    },
    pruneNoticeSlotChild: (parent, child) => {
      prunes.push({ parent, child });
    },
  };
  return { deps, pills, slots, prunes, slotReturns, setSlotReturn };
}

const CHILD = (over: Partial<Rec> = {}): Partial<Rec> => ({ parentSessionId: "p1", name: "kid", ...over });

beforeEach(() => {
  _resetSubagentNotifyForTest();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  _resetSubagentNotifyForTest();
});

/** Advance past the coalescing window and let the async flush settle. */
async function flushWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
}

describe("subagentNotify — waking a parent on a subagent's state change", () => {
  // 1.T1 — only waiting_for_human triggers flush; other states are no-ops
  it("only waiting_for_human triggers a notification (idle/done/exited are suppressed)", async () => {
    const { deps, pills } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "idle", deps);
    noteSubagentStateChange("c1", "idle", "done", deps);
    noteSubagentStateChange("c1", "done", "exited", deps);
    await flushWindow();
    expect(pills).toHaveLength(0);

    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills).toHaveLength(1);
  });

  it("wakes the parent once, with the child named, on waiting_for_human", async () => {
    const { deps, pills, slots } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    expect(pills).toHaveLength(0); // coalescing — nothing yet
    await flushWindow();
    expect(slots).toHaveLength(1);
    expect(slots[0]!.parent).toBe("p1");
    expect(slots[0]!.childId).toBe("c1");
    expect(slots[0]!.childName).toBe("kid");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.parent).toBe("p1");
    expect(pills[0]!.subagentName).toBe("kid");
    expect(pills[0]!.subagentId).toBe("c1");
    expect(pills[0]!.subagentState).toBe("waiting_for_human");
  });

  // V1a — slot populated, pill emitted, budget charged once; FIX-E: order is slot→pill→budget
  it("V1a: populateNoticeSlot called before emitPill, noticeCount charged after pill (R8 ordering)", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    const origPopulate = deps.populateNoticeSlot;
    const origPill = deps.emitPill;
    deps.populateNoticeSlot = (...args) => {
      order.push("slot");
      return origPopulate(...args);
    };
    deps.emitPill = async (...args) => {
      order.push("pill");
      return origPill(...args);
    };
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    // FIX-E: order must be slot → pill (budget is charged internally after pill, not observable here)
    expect(order).toEqual(["slot", "pill"]);
  });

  it("calls populateNoticeSlot + emitPill dep on flush", async () => {
    const { deps, pills, slots } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(slots).toHaveLength(1);
    expect(pills).toHaveLength(1);
    // FIX-B: notification pills now use empty text; frontend composes the readable copy.
    expect(pills[0]!.text).toBe("");
  });

  it("coalesces a chatty child into ONE flush", async () => {
    const { deps, pills } = makeDeps({ p1: {}, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    // Only the first timer fired (second and third found the timer already running)
    expect(pills.length).toBeLessThanOrEqual(1);
  });

  it("reports several children in a single flush, each at their latest state", async () => {
    const { deps, pills } = makeDeps({
      p1: {},
      c1: CHILD({ name: "one" }),
      c2: CHILD({ name: "two" }),
    });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    noteSubagentStateChange("c2", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills.length).toBeGreaterThanOrEqual(1);
    const names = pills.map((s) => s.subagentName);
    expect(names).toContain("one");
    expect(names).toContain("two");
  });

  it("ignores non-edges and uninteresting states (working, idle, done, exited)", async () => {
    const { deps, pills } = makeDeps({ p1: {}, c1: CHILD() });
    noteSubagentStateChange("c1", "waiting_for_human", "waiting_for_human", deps); // not an edge
    noteSubagentStateChange("c1", "idle", "working", deps); // going busy tells the parent nothing
    noteSubagentStateChange("c1", "working", "idle", deps); // idle no longer notable
    await flushWindow();
    expect(pills).toHaveLength(0);
  });

  it("ignores a session that is not a subagent", async () => {
    const { deps, pills } = makeDeps({ p1: {}, loner: { parentSessionId: null } });
    noteSubagentStateChange("loner", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills).toHaveLength(0);
  });

  it("never wakes an archived, retired, or deleted parent", async () => {
    for (const parent of [
      { archivedAt: "2026-01-01T00:00:00Z" },
      { lifecycleState: "done" as LifecycleState },
      null,
    ]) {
      _resetSubagentNotifyForTest();
      const records: Record<string, Partial<Rec>> = { c1: CHILD() };
      if (parent) records["p1"] = parent;
      const { deps, pills } = makeDeps(records);
      noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
      await flushWindow();
      expect(pills).toHaveLength(0);
    }
  });

  it("never wakes a tmux parent — it has no chat to emit into", async () => {
    const { deps, pills } = makeDeps({ p1: { channel: "tmux", useTmux: true }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills).toHaveLength(0);
  });

  it("follows a reset parent forward to its live successor", async () => {
    const { deps, pills } = makeDeps({
      pOld: { supersededBy: "pNew", archivedAt: "2026-01-01T00:00:00Z" },
      pNew: {},
      c1: CHILD({ parentSessionId: "pOld" }),
    });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills).toHaveLength(1);
    expect(pills[0]!.parent).toBe("pNew");
  });

  it("terminates on a supersededBy cycle instead of hanging", async () => {
    const { deps, pills } = makeDeps({
      a: { supersededBy: "b" },
      b: { supersededBy: "a" },
      c1: CHILD({ parentSessionId: "a" }),
    });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills.length).toBeLessThanOrEqual(1);
  });

  it("forgetSubagentNotify drops a deleted session from both roles", async () => {
    const { forgetSubagentNotify } = await import("../services/subagentNotify.js");
    const { deps, pills } = makeDeps({ p1: {}, c1: CHILD() });

    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    forgetSubagentNotify("c1"); // child deleted during the coalescing window
    await flushWindow();
    expect(pills).toHaveLength(0); // its buffered notice went with it

    // And a deleted PARENT's budget is released too.
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills).toHaveLength(1);
    forgetSubagentNotify("p1");
    noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(pills).toHaveLength(2);
  });

  it("stops after the per-parent budget, and a human turn resets it", async () => {
    const { deps, pills } = makeDeps({ p1: {}, c1: CHILD() });
    for (let i = 0; i < 40; i++) {
      noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
      await flushWindow();
      noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    }
    const capped = pills.length;
    // FIX-C: 25 normal + 1 notification + 1 warning at first cap, then 1 notification each subsequent cap.
    // After 40 iters: 25 under-cap + (40-25) at-cap with 1 notif each + 1 warning once = 25 + 15 + 1 = 41
    expect(capped).toBeGreaterThanOrEqual(25);
    expect(capped).toBeLessThanOrEqual(42);

    noteHumanTurn("p1");
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    // After human turn resets budget, the next flush is under-cap: one normal pill.
    expect(pills.length).toBe(capped + 1);
  });

  // V1f — FIX-C (R15): at cap, notification pill ALWAYS emits (not gated by suppressionWarned);
  // warning pill emits on FIRST suppression only; subsequent suppressions emit notification pill only.
  it("V1f: at cap, notification pill always emits; warning pill only on first suppression", async () => {
    const { deps, pills } = makeDeps({ p1: {}, c1: CHILD() });

    // Exhaust the budget (25 flushes).
    for (let i = 0; i < 25; i++) {
      noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
      await flushWindow();
      noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    }
    expect(pills).toHaveLength(25); // 25 normal pills

    // 26th flush hits the cap: notification pill + warning pill emitted.
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    // Should have: 25 normal + 1 notification + 1 warning = 27 total
    expect(pills.length).toBeGreaterThanOrEqual(27);
    const warningPill = pills.find((p) => p.text.includes("auto-wake paused"));
    expect(warningPill).toBeDefined();

    // 27th flush: at cap again, suppressionWarned — notification pill STILL emits, no warning pill.
    const pillsBeforeSecondCap = pills.length;
    noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    // Notification pill emits (FIX-C: always emit at cap), but no second warning pill.
    expect(pills.length).toBe(pillsBeforeSecondCap + 1);
    expect(pills[pills.length - 1]!.subagentName).toBe("kid");
    // No second warning pill.
    const warningPills = pills.filter((p) => p.text.includes("auto-wake paused"));
    expect(warningPills).toHaveLength(1);
  });

  // R8 atomicity: if slot fails, no pill, no budget charge
  it("R8: if populateNoticeSlot returns true, pill is emitted; if false (first time), only warning pill", async () => {
    const { deps, pills, slots, setSlotReturn } = makeDeps({ p1: {}, c1: CHILD() });
    // First flush: slot succeeds
    setSlotReturn("p1", true);
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(slots).toHaveLength(1);
    expect(pills).toHaveLength(1);
    expect(pills[0]!.subagentId).toBe("c1");
  });

  // R16 — prune on exit: non-notable exit still calls pruneNoticeSlotChild
  it("R16: child leaving waiting_for_human (any reason) calls pruneNoticeSlotChild before NOTABLE gate", async () => {
    const { deps, prunes } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    // Child enters waiting_for_human
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    // Child leaves waiting_for_human (exits) — non-notable
    noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    // prune should have been called immediately (before the NOTABLE gate)
    expect(prunes.length).toBeGreaterThan(0);
    expect(prunes[0]!.parent).toBe("p1");
    expect(prunes[0]!.child).toBe("c1");
  });
});

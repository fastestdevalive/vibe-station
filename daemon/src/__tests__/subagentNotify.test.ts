import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  noteSubagentStateChange,
  noteHumanTurn,
  _resetSubagentNotifyForTest,
  type NotifyDeps,
} from "../services/subagentNotify.js";
import type { LifecycleState } from "../types.js";

type Rec = NonNullable<ReturnType<NotifyDeps["lookup"]>>;

type EmittedNotice = {
  parent: string;
  subagentId: string;
  subagentName: string;
  subagentState: LifecycleState;
  text: string;
};

function makeDeps(records: Record<string, Partial<Rec>>): {
  deps: NotifyDeps;
  sent: EmittedNotice[];
} {
  const sent: EmittedNotice[] = [];
  const deps: NotifyDeps = {
    lookup: (id) => {
      const r = records[id];
      if (!r) return null;
      return { id, channel: "json", ...r } as Rec;
    },
    emitSystemEvent: async (parent, payload) => {
      sent.push({ parent, ...payload });
    },
  };
  return { deps, sent };
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
    const { deps, sent } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "idle", deps);
    noteSubagentStateChange("c1", "idle", "done", deps);
    noteSubagentStateChange("c1", "done", "exited", deps);
    await flushWindow();
    expect(sent).toHaveLength(0);

    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent).toHaveLength(1);
  });

  it("wakes the parent once, with the child named, on waiting_for_human", async () => {
    const { deps, sent } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    expect(sent).toHaveLength(0); // coalescing — nothing yet
    await flushWindow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.parent).toBe("p1");
    expect(sent[0]!.subagentName).toBe("kid");
    expect(sent[0]!.subagentId).toBe("c1");
    expect(sent[0]!.subagentState).toBe("waiting_for_human");
  });

  // 1.T2 — emitSystemEvent dep is called (not enqueueTurn) on flush
  it("calls emitSystemEvent dep (not enqueueTurn) on flush", async () => {
    const { deps, sent } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("kid");
    expect(sent[0]!.text).toContain("waiting");
  });

  it("coalesces a chatty child into ONE flush", async () => {
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    // Only the first timer fired (second and third found the timer already running)
    expect(sent.length).toBeLessThanOrEqual(1);
  });

  it("reports several children in a single flush, each at their latest state", async () => {
    const { deps, sent } = makeDeps({
      p1: {},
      c1: CHILD({ name: "one" }),
      c2: CHILD({ name: "two" }),
    });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    noteSubagentStateChange("c2", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const names = sent.map((s) => s.subagentName);
    expect(names).toContain("one");
    expect(names).toContain("two");
  });

  it("ignores non-edges and uninteresting states (working, idle, done, exited)", async () => {
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });
    noteSubagentStateChange("c1", "waiting_for_human", "waiting_for_human", deps); // not an edge
    noteSubagentStateChange("c1", "idle", "working", deps); // going busy tells the parent nothing
    noteSubagentStateChange("c1", "working", "idle", deps); // idle no longer notable
    await flushWindow();
    expect(sent).toHaveLength(0);
  });

  it("ignores a session that is not a subagent", async () => {
    const { deps, sent } = makeDeps({ p1: {}, loner: { parentSessionId: null } });
    noteSubagentStateChange("loner", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent).toHaveLength(0);
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
      const { deps, sent } = makeDeps(records);
      noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
      await flushWindow();
      expect(sent).toHaveLength(0);
    }
  });

  it("never wakes a tmux parent — it has no chat to emit into", async () => {
    const { deps, sent } = makeDeps({ p1: { channel: "tmux", useTmux: true }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent).toHaveLength(0);
  });

  it("follows a reset parent forward to its live successor", async () => {
    const { deps, sent } = makeDeps({
      pOld: { supersededBy: "pNew", archivedAt: "2026-01-01T00:00:00Z" },
      pNew: {},
      c1: CHILD({ parentSessionId: "pOld" }),
    });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.parent).toBe("pNew");
  });

  it("terminates on a supersededBy cycle instead of hanging", async () => {
    const { deps, sent } = makeDeps({
      a: { supersededBy: "b" },
      b: { supersededBy: "a" },
      c1: CHILD({ parentSessionId: "a" }),
    });
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent.length).toBeLessThanOrEqual(1);
  });

  it("forgetSubagentNotify drops a deleted session from both roles", async () => {
    const { forgetSubagentNotify } = await import("../services/subagentNotify.js");
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });

    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    forgetSubagentNotify("c1"); // child deleted during the coalescing window
    await flushWindow();
    expect(sent).toHaveLength(0); // its buffered notice went with it

    // And a deleted PARENT's budget is released too.
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent).toHaveLength(1);
    forgetSubagentNotify("p1");
    noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent).toHaveLength(2);
  });

  it("stops after the per-parent budget, and a human turn resets it", async () => {
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });
    for (let i = 0; i < 40; i++) {
      noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
      await flushWindow();
      noteSubagentStateChange("c1", "waiting_for_human", "working", deps);
    }
    const capped = sent.length;
    expect(capped).toBeLessThanOrEqual(25);

    noteHumanTurn("p1");
    noteSubagentStateChange("c1", "working", "waiting_for_human", deps);
    await flushWindow();
    expect(sent.length).toBe(capped + 1);
  });
});

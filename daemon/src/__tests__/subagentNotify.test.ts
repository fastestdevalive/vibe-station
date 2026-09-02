import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  noteSubagentStateChange,
  noteHumanTurn,
  _resetSubagentNotifyForTest,
  type NotifyDeps,
} from "../services/subagentNotify.js";
import type { LifecycleState } from "../types.js";

type Rec = NonNullable<ReturnType<NotifyDeps["lookup"]>>;

function makeDeps(records: Record<string, Partial<Rec>>): {
  deps: NotifyDeps;
  sent: Array<{ parent: string; message: string }>;
} {
  const sent: Array<{ parent: string; message: string }> = [];
  const deps: NotifyDeps = {
    lookup: (id) => {
      const r = records[id];
      if (!r) return null;
      return { id, channel: "json", ...r } as Rec;
    },
    enqueueTurn: async (parent, message) => {
      sent.push({ parent, message });
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
  it("wakes the parent once, with the child named, on a notable transition", async () => {
    const { deps, sent } = makeDeps({ p1: { channel: "json" }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "idle", deps);
    expect(sent).toHaveLength(0); // coalescing — nothing yet
    await flushWindow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.parent).toBe("p1");
    expect(sent[0]!.message).toContain("kid");
    expect(sent[0]!.message).toContain("c1");
  });

  it("coalesces a chatty child into ONE parent turn", async () => {
    // A subagent flips working<->idle every turn; without coalescing a 10-turn
    // child would cost the parent 20 LLM turns.
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "idle", deps);
    noteSubagentStateChange("c1", "idle", "waiting_for_human", deps);
    noteSubagentStateChange("c1", "waiting_for_human", "idle", deps);
    await flushWindow();
    expect(sent).toHaveLength(1);
  });

  it("reports several children in a single turn, at their latest state", async () => {
    const { deps, sent } = makeDeps({
      p1: {},
      c1: CHILD({ name: "one" }),
      c2: CHILD({ name: "two" }),
    });
    noteSubagentStateChange("c1", "working", "idle", deps);
    noteSubagentStateChange("c2", "working", "done", deps);
    await flushWindow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("one");
    expect(sent[0]!.message).toContain("two");
  });

  it("ignores non-edges and uninteresting states", async () => {
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });
    noteSubagentStateChange("c1", "idle", "idle", deps); // not an edge
    noteSubagentStateChange("c1", "idle", "working", deps); // going busy tells the parent nothing
    await flushWindow();
    expect(sent).toHaveLength(0);
  });

  it("ignores a session that is not a subagent", async () => {
    const { deps, sent } = makeDeps({ p1: {}, loner: { parentSessionId: null } });
    noteSubagentStateChange("loner", "working", "idle", deps);
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
      noteSubagentStateChange("c1", "working", "idle", deps);
      await flushWindow();
      expect(sent).toHaveLength(0);
    }
  });

  it("never wakes a tmux parent — it has no chat to enqueue into", async () => {
    const { deps, sent } = makeDeps({ p1: { channel: "tmux", useTmux: true }, c1: CHILD() });
    noteSubagentStateChange("c1", "working", "idle", deps);
    await flushWindow();
    expect(sent).toHaveLength(0);
  });

  it("follows a reset parent forward to its live successor", async () => {
    // Reset archives the old row and mints a new id; children keep pointing at
    // the predecessor, so without the forward walk the notice goes nowhere.
    const { deps, sent } = makeDeps({
      pOld: { supersededBy: "pNew", archivedAt: "2026-01-01T00:00:00Z" },
      pNew: {},
      c1: CHILD({ parentSessionId: "pOld" }),
    });
    noteSubagentStateChange("c1", "working", "idle", deps);
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
    noteSubagentStateChange("c1", "working", "idle", deps);
    await flushWindow();
    expect(sent.length).toBeLessThanOrEqual(1); // the point is that it returns at all
  });

  it("forgetSubagentNotify drops a deleted session from both roles", async () => {
    // Otherwise noticeCount grows one permanent entry per parent ever
    // notified, for the lifetime of the daemon.
    const { forgetSubagentNotify } = await import("../services/subagentNotify.js");
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });

    noteSubagentStateChange("c1", "working", "idle", deps);
    forgetSubagentNotify("c1"); // child deleted during the coalescing window
    await flushWindow();
    expect(sent).toHaveLength(0); // its buffered notice went with it

    // And a deleted PARENT's budget is released too.
    noteSubagentStateChange("c1", "working", "idle", deps);
    await flushWindow();
    expect(sent).toHaveLength(1);
    forgetSubagentNotify("p1");
    noteSubagentStateChange("c1", "idle", "done", deps);
    await flushWindow();
    expect(sent).toHaveLength(2);
  });

  it("stops after the per-parent budget, and a human turn resets it", async () => {
    const { deps, sent } = makeDeps({ p1: {}, c1: CHILD() });
    for (let i = 0; i < 40; i++) {
      noteSubagentStateChange("c1", "working", "idle", deps);
      await flushWindow();
      noteSubagentStateChange("c1", "idle", "working", deps);
    }
    const capped = sent.length;
    expect(capped).toBeLessThanOrEqual(25);

    noteHumanTurn("p1");
    noteSubagentStateChange("c1", "working", "idle", deps);
    await flushWindow();
    expect(sent.length).toBe(capped + 1);
  });
});

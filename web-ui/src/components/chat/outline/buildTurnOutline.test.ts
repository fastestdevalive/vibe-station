import { describe, expect, it } from "vitest";
import {
  buildTurnOutline,
  buildUnloadedNodes,
  createOutlineCache,
  mergeTurnOutline,
  nodeShapeSig,
  type OutlineCounts,
  type TurnNode,
} from "./buildTurnOutline";
import type { RenderItem } from "../MessageList";
import type { TranscriptOutlineTurn } from "@/api/types";
import { makeBeat, makeTurn } from "./outlineTestUtils";

/** A window turn starting at `seq`. */
function win(seq: number, key: string, label: string, tools = 0, errors = 0): TranscriptOutlineTurn {
  return { seq, turnKey: key, label, counts: { tools, edits: 0, errors } };
}

/** Summary counts of `total` turns in buckets of `bucketSize`, with the given per-bucket arrays. */
function counts(total: number, bucketSize = 1, arrays: Partial<Pick<OutlineCounts, "tools" | "edits" | "errors">> = {}): OutlineCounts {
  const n = Math.ceil(total / bucketSize);
  const zeros = Array.from({ length: n }, () => 0);
  return {
    totalTurns: total,
    bucketSize,
    tools: arrays.tools ?? zeros,
    edits: arrays.edits ?? zeros,
    errors: arrays.errors ?? zeros,
  };
}

/** Window turns of a chat whose turn i starts at seq (i + 1) * 10, one object per turn as the cache holds them. */
const WINDOW_TURNS = Array.from({ length: 50 }, (_, i) => win((i + 1) * 10, `t${i + 1}`, `Turn ${i + 1}`, 2));

/** The window's turn at each of `indexes`; other indexes are not loaded. */
function windowOf(indexes: number[]): (i: number) => TranscriptOutlineTurn | undefined {
  return (i) => (indexes.includes(i) ? WINDOW_TURNS[i] : undefined);
}

/** A loaded persisted turn (its user row has a seq). */
function persisted(key: string, num: number, seq: number): TurnNode {
  return { ...makeTurn(key, num, `Turn ${num}`), seq };
}

/** One turn: its user row plus a failed tool call (which becomes an error beat). */
function turn(n: number, failure: string): RenderItem[] {
  return [
    { type: "user", id: `u${n}`, turnId: `t${n}`, text: `Turn ${n}` },
    {
      type: "tool",
      id: `e${n}`,
      toolName: "Bash",
      turnId: `t${n}`,
      status: "failed",
      result: { content: failure },
    },
  ];
}

describe("buildTurnOutline", () => {
  it("numbers turns correctly when turnsBefore is given", () => {
    const items: RenderItem[] = [
      { type: "user", id: "u1", turnId: "t1", text: "First turn" },
      { type: "assistant", id: "a1", turnId: "t1", text: "Answer 1" },
      { type: "user", id: "u2", turnId: "t2", text: "Second turn" },
      { type: "assistant", id: "a2", turnId: "t2", text: "Answer 2" },
    ];

    const nodes = buildTurnOutline(items, { turnsBefore: 21 });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.number).toBe(22);
    expect(nodes[0]!.label).toBe("First turn");
    expect(nodes[1]!.number).toBe(23);
    expect(nodes[1]!.label).toBe("Second turn");
  });

  it("sets number to null when turnsBefore is null", () => {
    const items: RenderItem[] = [
      { type: "user", id: "u1", turnId: "t1", text: "First turn" },
    ];
    const nodes = buildTurnOutline(items, { turnsBefore: null });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.number).toBeNull();
  });

  it("accumulates edits and errors across tool calls in the turn", () => {
    const items: RenderItem[] = [
      { type: "user", id: "u1", turnId: "t1", text: "Fix bug" },
      {
        type: "tool",
        id: "tool1",
        toolName: "Edit",
        toolKind: "edit",
        turnId: "t1",
        status: "completed",
      },
      {
        type: "tool",
        id: "tool2",
        toolName: "Bash",
        turnId: "t1",
        status: "failed",
      },
      {
        type: "toolRun",
        id: "run1",
        tools: [
          {
            id: "tool3",
            toolName: "write_file",
            turnId: "t1",
            status: "completed",
          },
          {
            id: "tool4",
            toolName: "Read",
            turnId: "t1",
            status: "completed",
            result: { isError: true },
          },
        ],
      },
      { type: "error", id: "err1", text: "Fatal error" },
    ];

    const nodes = buildTurnOutline(items, { turnsBefore: 0 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.edits).toBe(2); // Edit (toolKind: edit) and write_file
    expect(nodes[0]!.errors).toBe(3); // failed tool2, error tool4, and error item err1
  });

  it("captures review comments, session break, and cancelled status", () => {
    const items: RenderItem[] = [
      {
        type: "session_break",
        id: "sb1",
        kind: "reset",
      },
      {
        type: "user",
        id: "u1",
        turnId: "t1",
        text: "Review changes",
        review: {
          name: "agent-1",
          comments: [
            {
              id: "c1",
              pin: 1,
              path: "foo.ts",
              pathKind: "repo",
              surface: "diff",
              side: "new",
              quote: "foo",
              anchor: "anchored",
              text: "fix this",
            },
          ],
        },
      },
      {
        type: "user",
        id: "u2",
        turnId: "t2",
        text: "Cancelled message",
        cancelled: true,
      },
    ];

    const nodes = buildTurnOutline(items, { activeTurnId: "t2", turnsBefore: 0 });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.breakBefore).toBe(true);
    expect(nodes[0]!.review).toEqual({ count: 1, name: "agent-1" });
    expect(nodes[1]!.cancelled).toBe(true);
    expect(nodes[1]!.live).toBe(true);
  });

  describe("TurnNode.beats integration", () => {
    it("reply-only turn has beats: []", () => {
      const items: RenderItem[] = [
        { type: "user", id: "u1", turnId: "t1", text: "Hello" },
        { type: "assistant", id: "a1", turnId: "t1", text: "Hi there! How can I help?" },
      ];
      const nodes = buildTurnOutline(items, {});
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.beats).toEqual([]);
    });

    it("a break between turns sets breakBefore and makes no beat", () => {
      const items: RenderItem[] = [
        { type: "user", id: "u1", turnId: "t1", text: "Turn 1" },
        { type: "session_break", id: "sb1", kind: "reset" },
        { type: "user", id: "u2", turnId: "t2", text: "Turn 2" },
      ];
      const nodes = buildTurnOutline(items, {});
      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.beats).toEqual([]);
      expect(nodes[1]!.breakBefore).toBe(true);
      expect(nodes[1]!.beats).toEqual([]);
    });

    it("todo baseline carries across turns and is rebuilt on re-run (Load earlier)", () => {
      const turn1Items: RenderItem[] = [
        { type: "user", id: "u1", turnId: "t1", text: "Start" },
        {
          type: "tool",
          id: "t_todo_1",
          toolName: "TodoWrite",
          toolInput: { todos: [{ content: "Task A", status: "completed" }] },
          status: "completed",
        },
      ];
      const turn2Items: RenderItem[] = [
        { type: "user", id: "u2", turnId: "t2", text: "Continue" },
        {
          type: "tool",
          id: "t_todo_2",
          toolName: "TodoWrite",
          toolInput: {
            todos: [
              { content: "Task A", status: "completed" },
              { content: "Task B", status: "completed" },
            ],
          },
          status: "completed",
        },
      ];

      const cache = createOutlineCache();
      const nodes = buildTurnOutline([...turn1Items, ...turn2Items], {}, cache);
      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.beats).toHaveLength(1);
      expect(nodes[0]!.beats[0]!.label).toBe("Done: Task A");
      expect(nodes[1]!.beats).toHaveLength(1);
      expect(nodes[1]!.beats[0]!.label).toBe("Done: Task B");

      // Simulating "Load earlier turns": prepending earlier items re-baselines from start
      const earlierItems: RenderItem[] = [
        { type: "user", id: "u0", turnId: "t0", text: "Earlier" },
        {
          type: "tool",
          id: "t_todo_0",
          toolName: "TodoWrite",
          toolInput: { todos: [{ content: "Task A", status: "completed" }] },
          status: "completed",
        },
      ];
      const allNodes = buildTurnOutline([...earlierItems, ...turn1Items, ...turn2Items], {}, cache);
      expect(allNodes).toHaveLength(3);
      expect(allNodes[0]!.beats[0]!.label).toBe("Done: Task A");
      // Turn 1's todo call had only Task A which is already done in Turn 0 -> 0 fresh -> beats: []
      expect(allNodes[1]!.beats).toHaveLength(0);
      expect(allNodes[2]!.beats[0]!.label).toBe("Done: Task B");
    });
  });

  describe("outline cache", () => {
    it("a streaming delta rebuilds only the live turn; settled turns keep their beats", () => {
      const cache = createOutlineCache();
      const base = [...turn(1, "One"), ...turn(2, "Two"), ...turn(3, "Three")];
      const first = buildTurnOutline(base, { activeTurnId: "t3" }, cache);
      expect(first[0]!.beats.map((b) => b.label)).toEqual(["Bash failed: One"]);

      // The delta: every row is a fresh object, the live turn gained a beat.
      const grown: RenderItem[] = [
        ...turn(1, "One"),
        ...turn(2, "Two"),
        ...turn(3, "Three"),
        { type: "tool", id: "e3b", toolName: "Bash", turnId: "t3", status: "failed", result: { content: "More" } },
      ];
      const second = buildTurnOutline(grown, { activeTurnId: "t3" }, cache);
      expect(second[0]!.beats).toBe(first[0]!.beats);
      expect(second[1]!.beats).toBe(first[1]!.beats);
      expect(second[2]!.beats).not.toBe(first[2]!.beats);
      // Consecutive failures fold into one error burst: the count grew.
      expect(second[2]!.beats.map((b) => [b.label, b.count])).toEqual([["Bash failed: Three", 2]]);
    });

    it("a settled turn whose items changed is rebuilt", () => {
      const cache = createOutlineCache();
      const first = buildTurnOutline([...turn(1, "One"), ...turn(2, "Two")], {}, cache);
      const second = buildTurnOutline([...turn(1, "One edited"), ...turn(2, "Two")], {}, cache);
      expect(second[0]!.beats).not.toBe(first[0]!.beats);
      expect(second[0]!.beats[0]!.label).toBe("Bash failed: One edited");
      expect(second[1]!.beats).toBe(first[1]!.beats);
    });

    it("turnsBefore / activeTurnId changes invalidate every cached turn", () => {
      const cache = createOutlineCache();
      const items = [...turn(1, "One"), ...turn(2, "Two")];
      const first = buildTurnOutline(items, { turnsBefore: 0 }, cache);
      const second = buildTurnOutline(items, { turnsBefore: 5, activeTurnId: "t2" }, cache);
      expect(second[0]!.beats).not.toBe(first[0]!.beats);
      expect(second[0]!.number).toBe(6);
      expect(second[1]!.live).toBe(true);
    });
  });

  describe("node identity and shape", () => {
    it("an unchanged turn keeps its node across builds; a changed one gets a new node", () => {
      const cache = createOutlineCache();
      const first = buildTurnOutline([...turn(1, "One"), ...turn(2, "Two")], {}, cache);
      const second = buildTurnOutline([...turn(1, "One"), ...turn(2, "Two edited")], {}, cache);
      expect(second[0]).toBe(first[0]);
      expect(second[1]).not.toBe(first[1]);
    });

    it("the shape signature ignores labels and tracks flags, anchors and beat kinds", () => {
      const a = makeTurn("t1", 1, "One");
      expect(nodeShapeSig({ ...a, label: "other", ts: "now" })).toBe(nodeShapeSig(a));
      expect(nodeShapeSig({ ...a, live: true })).not.toBe(nodeShapeSig(a));
      expect(nodeShapeSig({ ...a, errors: 2 })).toBe(nodeShapeSig({ ...a, errors: 1 }));
      expect(nodeShapeSig({ ...a, errors: 1 })).not.toBe(nodeShapeSig(a));
      expect(nodeShapeSig({ ...a, beats: [makeBeat("b", "error", "x")] })).not.toBe(nodeShapeSig({ ...a, beats: [makeBeat("b", "text", "x")] }));
    });
  });

  describe("buildUnloadedNodes", () => {
    it("a window turn gives a labelled row keyed by its index; the rest are placeholders", () => {
      const nodes = buildUnloadedNodes(counts(4), windowOf([1]), undefined);
      expect(nodes).toHaveLength(4);
      expect(nodes[1]).toMatchObject({ key: "n:1", anchor: "n:1", index: 1, number: 2, label: "Turn 2", seq: 20, tools: 2, unloaded: true, turnKey: "t2" });
      expect(nodes[1]!.skeleton).toBeUndefined();
      expect(nodes[0]).toMatchObject({ key: "n:0", label: "", skeleton: true, unloaded: true, number: 1 });
      expect(nodes[0]!.seq).toBeUndefined();
    });

    it("bucketSize 1 placeholders carry the exact bucket counts", () => {
      const nodes = buildUnloadedNodes(counts(3, 1, { tools: [4, 0, 1], edits: [1, 0, 0], errors: [0, 2, 0] }), () => undefined, undefined);
      expect(nodes.map((n) => [n.tools, n.edits, n.errors])).toEqual([[4, 1, 0], [0, 0, 2], [1, 0, 0]]);
    });

    it("bucketSize > 1: only the first placeholder of a bucket with errors is marked", () => {
      const nodes = buildUnloadedNodes(
        counts(5000, 5, { errors: [0, 3, 0] }),
        () => undefined,
        undefined,
      ).slice(0, 12);
      expect(nodes[5]!.errors).toBe(1);
      expect(nodes[6]!.errors).toBe(0);
      expect(nodes[0]!.errors).toBe(0);
      expect(nodes[5]!.tools).toBeUndefined();
    });

    it("the live turn is the window turn whose turnKey is the active turn", () => {
      const nodes = buildUnloadedNodes(counts(2), windowOf([0, 1]), "t2");
      expect(nodes[0]!.live).toBe(false);
      expect(nodes[1]!.live).toBe(true);
    });

    it("reuses unchanged entries of the previous base", () => {
      const first = buildUnloadedNodes(counts(3), windowOf([0]), undefined);
      const second = buildUnloadedNodes(counts(3), windowOf([0, 2]), undefined, first);
      expect(second[0]).toBe(first[0]);
      expect(second[1]).toBe(first[1]);
      expect(second[2]).not.toBe(first[2]);
    });

    it("a grown totalTurns or an identical-data summary keeps every existing row and allocates only the new ones", () => {
      const first = buildUnloadedNodes(counts(3), windowOf([0]), undefined);
      const grown = buildUnloadedNodes(counts(5), windowOf([0]), undefined, first);
      expect(grown).toHaveLength(5);
      for (let i = 0; i < 3; i++) expect(grown[i]).toBe(first[i]);
      expect(grown[3]!.key).toBe("n:3");
      const refetched = buildUnloadedNodes(counts(5), windowOf([0]), undefined, grown);
      expect(refetched.every((n, i) => n === grown[i])).toBe(true);
    });
  });

  describe("mergeTurnOutline", () => {
    const noSeq = () => undefined;

    it("loaded persisted turns replace their placeholders at turnsBefore + their place", () => {
      const base = buildUnloadedNodes(counts(5), windowOf([0, 1, 2, 3, 4]), undefined);
      const loaded = [persisted("t4", 4, 40), persisted("t5", 5, 50)];
      const { nodes } = mergeTurnOutline(base, loaded, { turnsBefore: 3, seqAnchor: (seq) => (seq === 40 ? "u:t4" : seq === 50 ? "u:t5" : undefined) });
      expect(nodes).toHaveLength(5);
      expect(nodes[0]!.unloaded).toBe(true);
      expect(nodes[3]).toBe(loaded[0]);
      expect(nodes[4]).toBe(loaded[1]);
      expect(nodes[3]!.number).toBe(4);
    });

    it("a loaded turn whose window turn is a different turn is appended after the server turns", () => {
      const base = buildUnloadedNodes(counts(3), windowOf([0, 1, 2]), undefined);
      const loaded = [persisted("x", 2, 999)];
      const { nodes } = mergeTurnOutline(base, loaded, { turnsBefore: 1, seqAnchor: noSeq });
      expect(nodes).toHaveLength(4);
      expect(nodes[1]!.unloaded).toBe(true);
      expect(nodes[3]!.key).toBe("x");
      expect(nodes[3]!.number).toBeNull();
    });

    it("a window turn matched by anchor (legacy seq) places the loaded turn", () => {
      const base = buildUnloadedNodes(counts(1), () => win(7, "seq:7", "legacy"), undefined);
      const loaded = [{ ...persisted("ev9", 1, 8), anchor: "u:ev9" }];
      const { nodes } = mergeTurnOutline(base, loaded, { turnsBefore: 0, seqAnchor: (seq) => (seq === 7 ? "u:ev9" : undefined) });
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toBe(loaded[0]);
    });

    it("a loaded turn without a seq (not persisted yet) is appended after the server turns", () => {
      const base = buildUnloadedNodes(counts(2), () => undefined, undefined);
      const loaded = [makeTurn("pending", 1, "Pending")];
      const { nodes } = mergeTurnOutline(base, loaded, { turnsBefore: 2, seqAnchor: noSeq });
      expect(nodes).toHaveLength(3);
      expect(nodes[2]!.key).toBe("pending");
    });

    it("an unloaded row keeps its i:<index> key and anchor after its window lands", () => {
      const before = buildUnloadedNodes(counts(2), () => undefined, undefined);
      const after = buildUnloadedNodes(counts(2), windowOf([1]), undefined);
      expect(before[1]!.key).toBe("n:1");
      expect(after[1]!.key).toBe("n:1");
      expect(after[1]!.anchor).toBe("n:1");
    });

    it("fetched steps are attached to their unloaded row without changing its key", () => {
      const base = buildUnloadedNodes(counts(2), windowOf([0]), undefined);
      const fetched = { ...makeTurn("x", 1, "x"), beats: [makeBeat("b1", "text", "first"), makeBeat("b2", "text", "second")] };
      const { nodes } = mergeTurnOutline(base, [], { turnsBefore: 0, seqAnchor: noSeq, steps: new Map([[0, fetched]]) });
      expect(nodes[0]!.key).toBe("n:0");
      expect(nodes[0]!.unloaded).toBe(true);
      expect(nodes[0]!.beats.map((b) => b.key)).toEqual(["b1", "b2"]);
      expect(base[0]!.beats).toEqual([]);
    });

    it("a 50k-turn chat merge reuses the base rows and only touches the loaded ones", () => {
      const total = 50_000;
      const windowed = new Map<number, TranscriptOutlineTurn>();
      for (let i = total - 40; i < total; i++) windowed.set(i, win((i + 1) * 10, `t${i + 1}`, `Turn ${i + 1}`));
      const base = buildUnloadedNodes(counts(total, 50), (i) => windowed.get(i), undefined);
      const loaded = [0, 1, 2].map((k) => persisted(`x${k}`, 1, (total - 3 + k + 1) * 10));
      const { nodes } = mergeTurnOutline(base, loaded, { turnsBefore: total - 3, seqAnchor: noSeq });
      expect(nodes).toHaveLength(total);
      expect(nodes[total - 1]!.key).toBe("x2");
      // Structural, not wall-clock: untouched base rows are reused by identity.
      expect(nodes[0]).toBe(base[0]);
      expect(nodes[total - 10]).toBe(base[total - 10]);
    });

    it("returns the previous result while base, steps, position and loaded nodes are unchanged", () => {
      const base = buildUnloadedNodes(counts(5), windowOf([0, 1, 2, 3, 4]), undefined);
      const loaded = [persisted("t4", 4, 40), persisted("t5", 5, 50)];
      const opts = { turnsBefore: 3, seqAnchor: (seq: number) => (seq === 40 ? "u:t4" : seq === 50 ? "u:t5" : undefined) };
      const first = mergeTurnOutline(base, loaded, opts);
      expect(mergeTurnOutline(base, [...loaded], opts, first)).toBe(first);
      const changed = mergeTurnOutline(base, [loaded[0]!, { ...loaded[1]!, label: "edited" }], opts, first);
      expect(changed).not.toBe(first);
      expect(changed.nodes[4]!.label).toBe("edited");
    });

    it("flags a mismatch only when a cached window turn disagrees with the loaded one", () => {
      const base = buildUnloadedNodes(counts(3), windowOf([0, 1, 2]), undefined);
      const loaded = [persisted("t2", 2, 999)];
      expect(mergeTurnOutline(base, loaded, { turnsBefore: 1, seqAnchor: noSeq }).mismatch).toBe(true);
      expect(mergeTurnOutline(base, [persisted("t2", 2, 20)], { turnsBefore: 1, seqAnchor: noSeq }).mismatch).toBe(false);
      const placeholders = buildUnloadedNodes(counts(3), () => undefined, undefined);
      expect(mergeTurnOutline(placeholders, loaded, { turnsBefore: 1, seqAnchor: noSeq }).mismatch).toBe(false);
    });

    it("the base is never mutated by a merge", () => {
      const base = buildUnloadedNodes(counts(2), windowOf([0]), undefined);
      const snapshot = [...base];
      mergeTurnOutline(base, [persisted("t1", 1, 10)], { turnsBefore: 0, seqAnchor: noSeq });
      expect(base).toEqual(snapshot);
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { TurnNode } from "./buildTurnOutline";
import { fakeNav, makeBeat, makeTurn, makeUserItem } from "./outlineTestUtils";

vi.mock("./chainGeometry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chainGeometry")>();
  return {
    ...actual,
    chainRows: vi.fn(actual.chainRows),
    chainMarks: vi.fn(actual.chainMarks),
    inViewBand: vi.fn(actual.inViewBand),
  };
});

import { chainMarks, chainRows, inViewBand } from "./chainGeometry";
import { TurnChain } from "./TurnChain";

const TOTAL = 50_000;

function bigChat(): TurnNode[] {
  const nodes: TurnNode[] = [];
  for (let i = 0; i < TOTAL; i++) nodes.push({ ...makeTurn(`n:${i}`, i + 1, ""), key: `n:${i}`, anchor: `n:${i}`, unloaded: true, skeleton: true });
  nodes[TOTAL - 1] = { ...makeTurn("live", TOTAL, "live"), live: true };
  return nodes;
}

describe("TurnChain: 50k turns while the live turn streams", () => {
  it("a delta that only changes the live node does not rebuild the geometry", () => {
    const items = [makeUserItem("live", "live")];
    const shape = {};
    const base = bigChat();
    const props = { items, hasMore: false, totalTurns: TOTAL, onJump: vi.fn(), nav: fakeNav([0, 0]), scrollElement: null } as const;
    const { rerender } = render(<TurnChain nodes={base} shape={shape} {...props} />);
    const built = {
      rows: vi.mocked(chainRows).mock.calls.length,
      marks: vi.mocked(chainMarks).mock.calls.length,
      band: vi.mocked(inViewBand).mock.calls.length,
    };
    expect(built.marks).toBeGreaterThan(0);

    for (let d = 1; d <= 50; d++) {
      const nodes = base.slice();
      nodes[TOTAL - 1] = { ...base[TOTAL - 1]!, label: `live ${d}`, beats: [] };
      rerender(<TurnChain nodes={nodes} shape={shape} {...props} />);
    }

    expect(vi.mocked(chainRows).mock.calls.length).toBe(built.rows);
    expect(vi.mocked(chainMarks).mock.calls.length).toBe(built.marks);
    expect(vi.mocked(inViewBand).mock.calls.length).toBe(built.band);

    // A change of shape (a beat was added to the live turn) does rebuild it.
    const withBeat = base.slice();
    withBeat[TOTAL - 1] = { ...base[TOTAL - 1]!, beats: [makeBeat("b", "error", "boom")] };
    rerender(<TurnChain nodes={withBeat} shape={{}} {...props} />);
    expect(vi.mocked(chainMarks).mock.calls.length).toBe(built.marks + 1);
    // No wall-clock budget: the call counts above are the invariant, and a loaded CI box made a time limit flaky.
  }, 60_000);
});

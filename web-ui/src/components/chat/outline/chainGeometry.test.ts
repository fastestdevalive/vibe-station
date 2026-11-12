import { describe, expect, it } from "vitest";
import type { TurnNode } from "./buildTurnOutline";
import type { Beat } from "./buildTurnBeats";
import { makeBeat } from "./outlineTestUtils";
import {
  BUCKET_PX,
  CHAIN_CAP_GAP,
  CHAIN_CAP_H,
  chainDensity,
  chainMarks,
  chainRows,
  chainTrack,
  inViewBand,
  rowCenterY,
  turnRowStarts,
  yToRow,
} from "./chainGeometry";

function beat(key: string, kind: Beat["kind"] = "text"): Beat {
  return makeBeat(key, kind, key);
}

function turn(key: string, beats: Beat[] = [], extra: Partial<TurnNode> = {}): TurnNode {
  return {
    key, anchor: `u:${key}`, index: 0, turnKey: key, number: null, label: key, edits: 0, errors: 0,
    live: false, breakBefore: false, cancelled: false, beats, ...extra,
  };
}

const NO_FIND = { visibleTurns: new Set<number>() };

describe("chainGeometry", () => {
  it("lays out a 50k-turn chain with one row per turn and step, in bounded marks", () => {
    const nodes = Array.from({ length: 50_000 }, (_, i) => turn(`n${i}`, i % 3 === 0 ? [beat(`b${i}`, "error")] : [], { number: i + 1, errors: i % 97 === 0 ? 1 : 0 }));
    const track = chainTrack(600, nodes.length + nodes.reduce((n, t) => n + t.beats.length, 0), false);
    const rows = chainRows(nodes);
    const starts = turnRowStarts(nodes);
    const marks = chainMarks(nodes, track, { visibleTurns: new Set([10_000]) });
    inViewBand(nodes, track, new Set([10_000]));
    // Structural, not wall-clock: one row per turn and step, and the marks never grow with the chat.
    expect(rows).toHaveLength(track.rows);
    expect(starts).toHaveLength(nodes.length + 1);
    expect(starts[nodes.length]).toBe(track.rows);
    expect(Object.values(marks).flat().length).toBeLessThanOrEqual(Math.ceil(track.height / BUCKET_PX) * 4 + 8);
  });

  it("flattens turns and every step in chat order", () => {
    const nodes = [turn("a", [beat("a1"), beat("a2")]), turn("b"), turn("c", [beat("c1")])];
    expect(chainRows(nodes)).toEqual([
      { turn: 0, beat: null }, { turn: 0, beat: 0 }, { turn: 0, beat: 1 },
      { turn: 1, beat: null },
      { turn: 2, beat: null }, { turn: 2, beat: 0 },
    ]);
    expect(turnRowStarts(nodes)).toEqual([0, 3, 4, 6]);
  });

  it("the track spans the whole chain, minus the cap when older turns are not loaded", () => {
    expect(chainTrack(600, 10, false)).toEqual({ top: 0, height: 600, rows: 10 });
    expect(chainTrack(600, 10, true)).toEqual({ top: CHAIN_CAP_H + CHAIN_CAP_GAP, height: 600 - CHAIN_CAP_H - CHAIN_CAP_GAP, rows: 10 });
    expect(chainTrack(4, 10, true).height).toBe(0);
  });

  it("maps y to a flat row proportionally and back to the row's centre", () => {
    const track = chainTrack(100, 10, false);
    expect(yToRow(track, 0)).toBe(0);
    expect(yToRow(track, 9.9)).toBe(0);
    expect(yToRow(track, 10)).toBe(1);
    expect(yToRow(track, 55)).toBe(5);
    expect(yToRow(track, 99.9)).toBe(9);
    for (let i = 0; i < 10; i++) expect(yToRow(track, rowCenterY(track, i))).toBe(i);
    expect(rowCenterY(track, 0)).toBe(5);
  });

  it("clamps at both ends, including the cap above the track", () => {
    const track = chainTrack(116, 10, true);
    expect(yToRow(track, -50)).toBe(0);
    expect(yToRow(track, 2)).toBe(0);
    expect(yToRow(track, 10_000)).toBe(9);
    expect(yToRow(chainTrack(100, 0, false), 50)).toBe(-1);
  });

  it("density: every row at >= 3px pitch, turns only below, buckets once turns are < 2px apart", () => {
    expect(chainDensity(chainTrack(300, 100, false), 10)).toBe("all");
    expect(chainDensity(chainTrack(299, 100, false), 10)).toBe("turns");
    expect(chainDensity(chainTrack(200, 1000, false), 100)).toBe("turns");
    expect(chainDensity(chainTrack(199, 1000, false), 100)).toBe("buckets");
  });

  it("all-rows mode draws one line per turn and per step, coloured by kind", () => {
    const nodes = [
      turn("a", [beat("a1"), beat("a2", "error"), beat("a3", "ask")]),
      turn("b", [], { errors: 1 }),
      turn("c", [], { live: true }),
      turn("d", [], { review: { count: 1, name: "r" } }),
    ];
    const track = chainTrack(70, 7, false);
    const m = chainMarks(nodes, track, { visibleTurns: new Set([0]) });
    expect(m.turnIn).toEqual([5]);
    expect(m.step).toEqual([15]);
    expect(m.stepErr).toEqual([25]);
    expect(m.stepAsk).toEqual([35]);
    expect(m.turnErr).toEqual([45]);
    expect(m.turnLive).toEqual([55]);
    expect(m.turnReview).toEqual([65]);
    expect(m.turn).toEqual([]);
  });

  it("turns-only mode keeps turn positions from the flat list, drops plain steps, keeps errors and asks", () => {
    const nodes = [turn("a", [beat("a1"), beat("a2"), beat("a3", "error")]), turn("b", [beat("b1", "ask")])];
    // 6 rows over 12px: pitch 2 (< 3), turn pitch 6 (>= 2)
    const track = chainTrack(12, 6, false);
    const m = chainMarks(nodes, track, NO_FIND);
    expect(m.turn).toEqual([1, 9]);
    expect(m.step).toEqual([]);
    expect(m.stepErr).toEqual([7]);
    expect(m.stepAsk).toEqual([11]);
  });

  it("bucket mode merges dense turns into one mark per bucket, the strongest kind winning", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => turn(`t${i}`, [], i === 10 ? { errors: 2 } : {}));
    const track = chainTrack(300, 300, false); // turn pitch 1px
    expect(chainDensity(track, nodes.length)).toBe("buckets");
    const m = chainMarks(nodes, track, NO_FIND);
    const total = m.turn.length + m.turnErr.length;
    expect(total).toBe(300 / BUCKET_PX);
    expect(m.turnErr).toHaveLength(1);
    expect(m.turn).not.toContain(m.turnErr[0]);
  });

  it("find hits always get a mark at their turn, the current and peeked turn their own", () => {
    const nodes = [turn("a"), turn("b"), turn("c")];
    const track = chainTrack(30, 3, false);
    const m = chainMarks(nodes, track, {
      visibleTurns: new Set(),
      hitTurns: new Set(["u:a", "u:c"]),
      currentTurn: "u:c",
      peekTurn: "u:b",
    });
    expect(m.hit).toEqual([5, 25]);
    expect(m.hitCur).toEqual([25]);
    expect(m.hitPeek).toEqual([15]);
  });

  it("the in-view band spans the visible turns and their steps, at least 4px", () => {
    const nodes = [turn("a", [beat("a1")]), turn("b", [beat("b1"), beat("b2")]), turn("c")];
    const track = chainTrack(60, 6, false);
    expect(inViewBand(nodes, track, new Set([1]))).toEqual({ top: 20, height: 30 });
    expect(inViewBand(nodes, track, new Set())).toBeNull();
    const dense = chainTrack(6, 6, false);
    expect(inViewBand(nodes, dense, new Set([2]))!.height).toBe(4);
  });

  it("5,000 unloaded turns fit the chain", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => turn(`t${i}`, [], { unloaded: true, seq: i + 1 }));
    const track = chainTrack(600, 5000, false);
    expect(track.top).toBe(0);
    expect(chainDensity(track, 5000)).toBe("buckets");
    const marks = chainMarks(nodes, track, { visibleTurns: new Set() });
    for (const y of marks.turn) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(600);
    }
    expect(yToRow(track, 599.9)).toBe(4999);
  });
});

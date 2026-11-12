import { describe, expect, it } from "vitest";
import type { TurnNode } from "./buildTurnOutline";
import type { Beat } from "./buildTurnBeats";
import { makeBeat } from "./outlineTestUtils";
import { currentTurnIndex, outlineKeyNav, outlineRowCount, rowOffsets } from "./outlineTree";

function dummyBeat(id: string, label: string): Beat {
  return makeBeat(id, "commit", label);
}

function makeNode(key: string, num: number, beats: Beat[] = [], live = false): TurnNode {
  return {
    key,
    anchor: `u:${key}`,
    index: num - 1,
    turnKey: key,
    number: num,
    label: `Turn ${num}`,
    edits: 0,
    errors: 0,
    live,
    breakBefore: false,
    cancelled: false,
    beats,
  };
}

describe("outlineTree", () => {
  describe("rowOffsets / outlineRowCount", () => {
    const nodes = [
      makeNode("t1", 1, [dummyBeat("a", "A"), dummyBeat("b", "B")]),
      makeNode("t2", 2),
      makeNode("t3", 3, [dummyBeat("c", "C"), dummyBeat("d", "D"), dummyBeat("e", "E")]),
    ];

    it("prefix-sums every turn and every step (all rows are always present)", () => {
      expect(rowOffsets(nodes, 32, 26)).toEqual([0, 32 + 52, 32 + 52 + 32, 32 + 52 + 32 + 32 + 78]);
      expect(rowOffsets(nodes, 44, 44)).toEqual([0, 44 + 88, 44 + 88 + 44, 44 + 88 + 44 + 44 + 132]);
      expect(outlineRowCount(nodes)).toBe(3 + 5);
    });

    it("an empty list is a single zero offset and no rows", () => {
      expect(rowOffsets([], 32, 26)).toEqual([0]);
      expect(outlineRowCount([])).toBe(0);
    });
  });

  describe("currentTurnIndex", () => {
    it("returns smallest visible index when set is populated", () => {
      expect(currentTurnIndex(new Set([3, 1, 5]), 10)).toBe(1);
    });

    it("returns n - 1 (min 0) when set is empty", () => {
      expect(currentTurnIndex(new Set(), 10)).toBe(9);
      expect(currentTurnIndex(new Set(), 0)).toBe(0);
    });

    it("falls back to n - 1 when min visible index is out of bounds", () => {
      expect(currentTurnIndex(new Set([15]), 10)).toBe(9);
    });
  });

  describe("outlineKeyNav: one flat run of rows", () => {
    const list: TurnNode[] = [
      makeNode("t1", 1, [dummyBeat("b1", "B1"), dummyBeat("b2", "B2")]),
      makeNode("t2", 2, [dummyBeat("b3", "B3"), dummyBeat("b4", "B4"), dummyBeat("b5", "B5")]),
      makeNode("t3", 3, []),
    ];
    const at = (turnKey: string, beat: number | null = null) => ({ turnKey, beat });

    it("null for an empty list, for any other key, and for the dropped fold keys ← / →", () => {
      expect(outlineKeyNav(at("t1"), "ArrowDown", [])).toBeNull();
      for (const key of ["KeyA", "Enter", "ArrowLeft", "ArrowRight"]) {
        expect(outlineKeyNav(at("t1"), key, list)).toBeNull();
      }
    });

    it("an unknown turn lands on the first row", () => {
      expect(outlineKeyNav(at("unknown"), "ArrowDown", list)).toEqual(at("t1"));
    });

    it("↓ walks turn, its steps, then the next turn, clamped at the end", () => {
      const seq = [at("t1")];
      for (let i = 0; i < 8; i++) seq.push(outlineKeyNav(seq[seq.length - 1]!, "ArrowDown", list)!);
      expect(seq).toEqual([
        at("t1"), at("t1", 0), at("t1", 1), at("t2"), at("t2", 0), at("t2", 1), at("t2", 2), at("t3"), at("t3"),
      ]);
    });

    it("↑ walks back the same run, clamped at the start", () => {
      const seq = [at("t3")];
      for (let i = 0; i < 8; i++) seq.push(outlineKeyNav(seq[seq.length - 1]!, "ArrowUp", list)!);
      expect(seq).toEqual([
        at("t3"), at("t2", 2), at("t2", 1), at("t2", 0), at("t2"), at("t1", 1), at("t1", 0), at("t1"), at("t1"),
      ]);
    });

    it("Home goes to the first turn; End to the last row (the last step when the last turn has steps)", () => {
      expect(outlineKeyNav(at("t2", 1), "Home", list)).toEqual(at("t1"));
      expect(outlineKeyNav(at("t1"), "End", list)).toEqual(at("t3"));
      expect(outlineKeyNav(at("t1"), "End", list.slice(0, 2))).toEqual(at("t2", 2));
    });
  });
});

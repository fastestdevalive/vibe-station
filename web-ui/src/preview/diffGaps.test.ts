import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, syntheticUntrackedHunks } from "./diffParser";
import { computeGaps } from "./diffGaps";

describe("computeGaps", () => {
  it("returns a gap before the first hunk, between two hunks, and after the last hunk", () => {
    // Two hunks: first covers new-lines 3..4, second covers new-lines 10..11.
    // fileLines has 15 lines total.
    const diff = [
      "@@ -3,2 +3,2 @@",
      " context3",
      " context4",
      "@@ -10,2 +10,2 @@",
      " context10",
      " context11",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    const fileLines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    expect(computeGaps(hunks, fileLines)).toEqual([
      { id: "gap-start", startLine: 1, endLine: 2, lineCount: 2, oldOffset: 0 },
      { id: "gap-0", startLine: 5, endLine: 9, lineCount: 5, oldOffset: 0 },
      { id: "gap-end", startLine: 12, endLine: 15, lineCount: 4, oldOffset: 0 },
    ]);
  });

  it("returns no gaps when hunks are adjacent (cover every line)", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " a",
      " b",
      " c",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    const fileLines = ["a", "b", "c"];
    expect(computeGaps(hunks, fileLines)).toEqual([]);
  });

  it("returns an empty array when fileLines is null", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(computeGaps(hunks, null)).toEqual([]);
  });

  it("returns an empty array when there are no hunks", () => {
    expect(computeGaps([], ["a", "b", "c"])).toEqual([]);
  });

  it("returns a trailing gap for a single hunk that does not reach the file end", () => {
    const diff = ["@@ -1,2 +1,2 @@", " a", " b"].join("\n");
    const hunks = parseUnifiedDiff(diff);
    const fileLines = Array.from({ length: 6 }, (_, i) => `line${i + 1}`);
    expect(computeGaps(hunks, fileLines)).toEqual([
      { id: "gap-end", startLine: 3, endLine: 6, lineCount: 4, oldOffset: 0 },
    ]);
  });

  it("computes a non-zero oldOffset for a gap after a hunk with more added than removed lines", () => {
    // Hunk replaces 1 old line with 3 new lines (net +2) covering new-lines 1..3;
    // the gap after it should report old-side numbers 2 lower than new-side.
    const diff = ["@@ -1,1 +1,3 @@", "-old1", "+new1", "+new2", "+new3"].join("\n");
    const hunks = parseUnifiedDiff(diff);
    const fileLines = Array.from({ length: 5 }, (_, i) => `line${i + 1}`);
    const gaps = computeGaps(hunks, fileLines);
    expect(gaps).toEqual([{ id: "gap-end", startLine: 4, endLine: 5, lineCount: 2, oldOffset: -2 }]);
  });

  it("returns no gaps for a synthetic untracked hunk (covers whole file)", () => {
    const hunks = syntheticUntrackedHunks("a\nb\nc\n");
    const fileLines = ["a", "b", "c"];
    expect(computeGaps(hunks, fileLines)).toEqual([]);
  });
});

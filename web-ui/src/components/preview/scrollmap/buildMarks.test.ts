import { describe, it, expect } from "vitest";
import { buildMarks, layoutMarks, buildDiffMarks } from "./buildMarks";
import type { GutterMarkKind } from "@/components/preview/CodeView";
import type { DiffHunk } from "@/preview/diffParser";

describe("buildMarks", () => {
  it("adjacent lines of same kind merge", () => {
    const gutter = new Map<number, Set<GutterMarkKind>>([
      [2, new Set(["added"])],
      [3, new Set(["added"])],
      [4, new Set(["added"])],
      [7, new Set(["modified"])],
      [8, new Set(["modified"])],
    ]);

    const marks = buildMarks({
      gutter,
      lineCount: 10,
    });

    expect(marks).toEqual([
      { kind: "added", startLine: 2, endLine: 4 },
      { kind: "modified", startLine: 7, endLine: 8 },
    ]);
  });

  it("merges adjacent comment lines and includes targetLine", () => {
    const marks = buildMarks({
      commentLines: [
        [3, 5],
        [6, 7],
      ],
      targetLine: 9,
      lineCount: 15,
    });

    expect(marks).toEqual([
      { kind: "comment", startLine: 3, endLine: 7 },
      { kind: "target", startLine: 9, endLine: 9 },
    ]);
  });
});

describe("layoutMarks", () => {
  it("priority resolves a shared pixel row and keeps all", () => {
    // Both marks map to roughly the same pixel position on a small track
    const marks = [
      { kind: "added" as const, startLine: 10, endLine: 10 },
      { kind: "comment" as const, startLine: 10, endLine: 10 },
    ];

    const pixelMarks = layoutMarks(marks, 100, 100);
    expect(pixelMarks).toHaveLength(1);
    // Priority: comment > deleted > modified > added > target
    expect(pixelMarks[0]!.kind).toBe("comment");
    expect(pixelMarks[0]!.all).toEqual(marks);
  });

  it("a 20,481-line file keeps 2px minimum marks", () => {
    const marks = [
      { kind: "added" as const, startLine: 100, endLine: 100 },
      { kind: "modified" as const, startLine: 500, endLine: 500 },
    ];

    const pixelMarks = layoutMarks(marks, 20481, 500);
    for (const pm of pixelMarks) {
      expect(pm.heightPx).toBeGreaterThanOrEqual(2);
    }
  });

  it("deleted scales with lines while target marks are fixed at 2px", () => {
    const marks = [
      { kind: "deleted" as const, startLine: 5, endLine: 5 },
      { kind: "target" as const, startLine: 20, endLine: 20 },
    ];

    const pixelMarks = layoutMarks(marks, 100, 400);
    expect(pixelMarks).toHaveLength(2);
    expect(pixelMarks[0]!.heightPx).toBe(4);
    expect(pixelMarks[1]!.heightPx).toBe(2);
  });

  it("multi-line deleted mark scales proportionally, single-line keeps 2px floor", () => {
    const multiLine = layoutMarks([{ kind: "deleted", startLine: 1, endLine: 50 }], 100, 500);
    expect(multiLine).toHaveLength(1);
    expect(multiLine[0]!.heightPx).toBe(250);

    const singleLine = layoutMarks([{ kind: "deleted", startLine: 500, endLine: 500 }], 10000, 500);
    expect(singleLine).toHaveLength(1);
    expect(singleLine[0]!.heightPx).toBe(2);
  });
});

describe("buildDiffMarks", () => {
  it("maps added / removed rows by row index", () => {
    const hunks: DiffHunk[] = [
      {
        header: "@@ -1,3 +1,4 @@",
        lines: [
          { type: "context", content: "c1", oldLineNumber: 1, newLineNumber: 1 },
          { type: "removed", content: "r1", oldLineNumber: 2, newLineNumber: null },
          { type: "removed", content: "r2", oldLineNumber: 3, newLineNumber: null },
          { type: "added", content: "a1", oldLineNumber: null, newLineNumber: 2 },
          { type: "added", content: "a2", oldLineNumber: null, newLineNumber: 3 },
          { type: "context", content: "c2", oldLineNumber: 4, newLineNumber: 4 },
        ],
      },
    ];

    const marks = buildDiffMarks(hunks);
    expect(marks).toEqual([
      { kind: "deleted", startLine: 2, endLine: 3 },
      { kind: "added", startLine: 4, endLine: 5 },
    ]);
  });
});

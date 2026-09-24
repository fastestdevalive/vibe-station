import { describe, expect, it } from "vitest";
import { pairHunkLines } from "./diffSideBySide";
import type { DiffLine } from "./diffParser";

function line(type: DiffLine["type"], content: string, oldN: number | null, newN: number | null): DiffLine {
  return { type, content, oldLineNumber: oldN, newLineNumber: newN };
}

describe("pairHunkLines (1.T1)", () => {
  it("mirrors a context line and pairs equal-length removed/added runs", () => {
    const lines: DiffLine[] = [
      line("context", "ctx", 1, 1),
      line("removed", "old1", 2, null),
      line("removed", "old2", 3, null),
      line("added", "new1", null, 2),
      line("added", "new2", null, 3),
    ];
    const rows = pairHunkLines(lines, 0);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ key: "0-0", left: lines[0], right: lines[0] });
    expect(rows[1]).toEqual({ key: "0-1", left: lines[1], right: lines[3] });
    expect(rows[2]).toEqual({ key: "0-2", left: lines[2], right: lines[4] });
  });
});

describe("pairHunkLines (1.T2)", () => {
  it("pads the shorter side with null when removed/added run lengths differ", () => {
    const lines: DiffLine[] = [
      line("removed", "old1", 1, null),
      line("removed", "old2", 2, null),
      line("added", "new1", null, 1),
    ];
    const rows = pairHunkLines(lines, 0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ key: "0-0", left: lines[0], right: lines[2] });
    expect(rows[1]).toEqual({ key: "0-1", left: lines[1], right: null });
  });
});

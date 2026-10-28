import { describe, expect, it } from "vitest";
import { makeComment } from "./testFixtures";
import { buildSurfaceComments, rowMarkRange, rowMarks } from "./rowIndex";
import { MAX_QUOTE_BYTES } from "./reviewLimits";

const span = (start: number, end: number, quote: string, over = {}) => makeComment({ lineStart: start, lineEnd: end, quote, ...over });

describe("rowMarkRange: the line span decides the rows, the quote only trims the first and last row", () => {
  const c = span(12, 14, "tail of first\nthe whole middle line\nhead of");

  it("marks a middle row in full, trims the first row to its tail and the last row to its head", () => {
    expect(rowMarkRange(c, "the whole middle line", 13)).toEqual({ start: 0, end: 21 });
    expect(rowMarkRange(c, "const a = tail of first", 12)).toEqual({ start: 10, end: 23 });
    expect(rowMarkRange(c, "head of the last line", 14)).toEqual({ start: 0, end: 7 });
  });

  it("a first row selected from column 0 is marked in full", () => {
    const whole = span(12, 13, "all of first\nhead");
    expect(rowMarkRange(whole, "all of first", 12)).toEqual({ start: 0, end: 12 });
  });

  it("is null outside the span and for a blank row (the row bar covers it)", () => {
    expect(rowMarkRange(c, "x", 11)).toBeNull();
    expect(rowMarkRange(c, "x", 15)).toBeNull();
    expect(rowMarkRange(c, "", 13)).toBeNull();
    expect(rowMarkRange(c, "\r", 13)).toBeNull();
  });

  it("CRLF files: a trailing \\r is not part of the row, so every row still gets its mark", () => {
    expect(rowMarkRange(c, "const a = tail of first\r", 12)).toEqual({ start: 10, end: 23 });
    expect(rowMarkRange(c, "the whole middle line\r", 13)).toEqual({ start: 0, end: 21 });
    expect(rowMarkRange(c, "head of the last line\r", 14)).toEqual({ start: 0, end: 7 });
    // a stored quote that still carries CRLF (older comments) is normalised too
    const crlf = span(12, 14, "tail of first\r\nthe whole middle line\r\nhead of");
    expect(rowMarkRange(crlf, "the whole middle line\r", 13)).toEqual({ start: 0, end: 21 });
  });

  it("a truncated 2 KB quote still marks every row of its span, and the last row in full", () => {
    const long = `tail of first\n${"x".repeat(MAX_QUOTE_BYTES)}`;
    const t = span(12, 16, long);
    for (const n of [13, 14, 15]) expect(rowMarkRange(t, "some middle row", n)).toEqual({ start: 0, end: 15 });
    expect(rowMarkRange(t, "last row of the span", 16)).toEqual({ start: 0, end: 20 });
  });

  it("a single-line quote is located in its row; one that is gone marks the whole row", () => {
    const one = span(5, 5, "needle");
    expect(rowMarkRange(one, "hay needle stack", 5)).toEqual({ start: 4, end: 10 });
    expect(rowMarkRange(one, "no match here", 5)).toEqual({ start: 0, end: 13 });
  });

  it("rowMarks flags outdated comments", () => {
    const o = span(5, 5, "needle", { id: "o", anchor: "outdated" });
    expect(rowMarks([o], "a needle", 5)).toEqual([{ start: 2, end: 8, id: "o", outdated: true, draft: false }]);
  });
});

describe("buildSurfaceComments covers", () => {
  it("covers every row of a span of 5000 lines (no walk cap)", () => {
    const view = buildSurfaceComments([span(1, 5000, "a\nb")], "file");
    expect(view.covers.get("new:4999")?.map((x) => x.id)).toEqual(["c1"]);
    expect(view.covers.get("new:5000")).toBeDefined();
    expect(view.covers.get("new:5001")).toBeUndefined();
    expect(view.ends.get("new:5000")).toBeDefined();
  });

  it("keeps the two sides of a diff apart", () => {
    const old = makeComment({ id: "o", surface: "diff", diffScope: "local", side: "old", lineStart: 3, lineEnd: 4 });
    const view = buildSurfaceComments([old], "diff", "local");
    expect(view.covers.get("old:4")).toBeDefined();
    expect(view.covers.get("new:4")).toBeUndefined();
  });
});

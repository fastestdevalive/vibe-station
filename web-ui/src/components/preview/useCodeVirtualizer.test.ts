import { describe, it, expect } from "vitest";
import { estimateRowHeight, visualCols } from "./useCodeVirtualizer";

describe("visualCols", () => {
  it("empty line = 0 columns", () => {
    expect(visualCols("", 4)).toBe(0);
  });

  it("counts each character as one column", () => {
    expect(visualCols("abc", 4)).toBe(3);
  });

  it("expands tabs per tab-size to the next multiple", () => {
    // "a\t" with tabSize 4 → a is col 1, tab advances to col 4 → 4 columns.
    expect(visualCols("a\t", 4)).toBe(4);
    // "\t" with tabSize 4 → advances to col 4.
    expect(visualCols("\t", 4)).toBe(4);
    // "abcd\t" → 4 cols then tab advances to col 8 → 8.
    expect(visualCols("abcd\t", 4)).toBe(8);
    // tabSize 2: "abc\t" → a,b,c = 3, tab advances to col 4 → 4.
    expect(visualCols("abc\t", 2)).toBe(4);
  });
});

describe("estimateRowHeight", () => {
  const LH = 20;

  it("empty line = 1 row", () => {
    expect(estimateRowHeight("", 80, LH, 4)).toBe(LH);
  });

  it("line of 2*colsPerRow+1 cols = 3 rows", () => {
    // 161 columns with 80 per row → ceil(161/80)=3 rows.
    expect(estimateRowHeight("x".repeat(161), 80, LH, 4)).toBe(3 * LH);
  });

  it("line fitting one row = 1 row", () => {
    expect(estimateRowHeight("x".repeat(80), 80, LH, 4)).toBe(LH);
  });

  it("tabs expand per tab-size before wrapping", () => {
    // colsPerRow 10, line "\t\t\t..." — tabs expand to tabSize multiples.
    // "abc\t" with tabSize 4 → 4 cols, fits one row.
    expect(estimateRowHeight("abc\t", 10, LH, 4)).toBe(LH);
    // "abc\t" with tabSize 20 → 20 cols → 2 rows over 10 cols/row.
    expect(estimateRowHeight("abc\t", 10, LH, 20)).toBe(2 * LH);
  });

  it("guards against colsPerRow of 0/NaN by using a minimum of 1 col/row", () => {
    // colsPerRow 0 or NaN clamps to 1 → "hello" (5 cols) wraps to 5 rows.
    expect(estimateRowHeight("hello", 0, LH, 4)).toBe(5 * LH);
    expect(estimateRowHeight("hello", NaN, LH, 4)).toBe(5 * LH);
  });
});

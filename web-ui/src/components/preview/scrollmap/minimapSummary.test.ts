import { describe, it, expect } from "vitest";
import {
  summarizeLines,
  bucketize,
  overMinimapCap,
  MINIMAP_MAX_LINES,
  MINIMAP_MAX_BYTES,
} from "./minimapSummary";

describe("minimapSummary", () => {
  it("indent / length clamp at 255", () => {
    // 300 spaces then 'x'
    const longIndent = " ".repeat(300) + "x";
    // 10 spaces then 400 'a's
    const longLine = " ".repeat(10) + "a".repeat(400);

    const summary = summarizeLines([longIndent, longLine]);
    expect(summary.indent[0]).toBe(255);
    expect(summary.length[0]).toBe(255);

    expect(summary.indent[1]).toBe(10);
    expect(summary.length[1]).toBe(255);
  });

  it("summarizeLines counts lines correctly", () => {
    const lines = Array.from({ length: 25_000 }, (_, i) => `line ${i}`);
    const summary = summarizeLines(lines);
    expect(summary.lines).toBe(25_000);
  });

  it("bucketize returns 4,096 buckets", () => {
    const lines = 100_000;
    const indent = new Uint8Array(lines);
    const length = new Uint8Array(lines);
    for (let i = 0; i < lines; i++) {
      indent[i] = (i % 20) * 4;
      length[i] = 40 + (i % 60);
    }

    const buckets = bucketize(indent, length, 4096);
    expect(buckets.maxLength.length).toBe(4096);
    expect(buckets.minIndent.length).toBe(4096);
    expect(buckets.nonBlankShare.length).toBe(4096);
  });

  it("overMinimapCap(1_000_001, 0) and overMinimapCap(10, 25 * 1024 * 1024 + 1) are true", () => {
    expect(overMinimapCap(1_000_001, 0)).toBe(true);
    expect(overMinimapCap(MINIMAP_MAX_LINES, 0)).toBe(false);
    expect(overMinimapCap(10, 25 * 1024 * 1024 + 1)).toBe(true);
    expect(overMinimapCap(10, MINIMAP_MAX_BYTES)).toBe(false);
  });
});

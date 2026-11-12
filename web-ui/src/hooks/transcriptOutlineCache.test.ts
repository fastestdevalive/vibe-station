import { beforeEach, describe, expect, it } from "vitest";
import type { OutlineSummaryState } from "./useTranscriptOutline";
import * as outlineCache from "./transcriptOutlineCache";

function summary(tag: string): OutlineSummaryState {
  return { status: "ready", totalTurns: 1, bucketSize: 1, tools: [0], edits: [0], errors: [0], revision: tag };
}

describe("transcriptOutlineCache", () => {
  beforeEach(() => {
    outlineCache.clear();
  });

  it("round-trips a saved summary", () => {
    const s = summary("r1");
    outlineCache.save("s1", s);
    expect(outlineCache.restore("s1")).toBe(s);
    expect(outlineCache.restore("missing")).toBeNull();
  });

  it("evict removes one session only, and clear removes everything", () => {
    outlineCache.save("s1", summary("a"));
    outlineCache.save("s2", summary("b"));
    outlineCache.evict("s1");
    expect(outlineCache.restore("s1")).toBeNull();
    expect(outlineCache.restore("s2")).not.toBeNull();
    outlineCache.clear();
    expect(outlineCache.restore("s2")).toBeNull();
  });

  it("the 21st session evicts the least recently saved one, and re-saving refreshes recency", () => {
    for (let i = 1; i <= 20; i++) outlineCache.save(`s${i}`, summary(`v${i}`));
    outlineCache.save("s1", summary("v1b"));
    outlineCache.save("s21", summary("v21"));
    expect(outlineCache.restore("s1")?.revision).toBe("v1b");
    expect(outlineCache.restore("s2")).toBeNull();
    expect(outlineCache.restore("s21")).not.toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzyMatch";

describe("4.T3 — fuzzyScore", () => {
  it("matches subsequences case-insensitively", () => {
    const scoreLower = fuzzyScore("abc", "AlphaBetaCharlie");
    expect(scoreLower).not.toBeNull();
    expect(scoreLower).toBeGreaterThan(0);

    const scoreUpper = fuzzyScore("ABC", "alphabetacharlie");
    expect(scoreUpper).not.toBeNull();
    expect(scoreUpper).toBe(scoreLower);
  });

  it("returns null on no match", () => {
    expect(fuzzyScore("xyz", "alphabet")).toBeNull();
    expect(fuzzyScore("ba", "ab")).toBeNull();
  });

  it("yields higher score for contiguous matches", () => {
    const contiguous = fuzzyScore("app", "apple");
    const nonContiguous = fuzzyScore("app", "a-p-p-l-e");
    expect(contiguous).not.toBeNull();
    expect(nonContiguous).not.toBeNull();
    expect(contiguous!).toBeGreaterThan(nonContiguous!);
  });
});

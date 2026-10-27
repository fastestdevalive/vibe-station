import { describe, it, expect } from "vitest";
import { highlightMatch, rankItems, scoreLabel } from "./mentionFilter";

describe("mentionFilter (1.T10)", () => {
  it("scores labels: prefix > word-start > substring > none", () => {
    const prefixScore = scoreLabel("sea", "search-bar");
    const wordStartScore = scoreLabel("sea", "file-search-fix");
    const substringScore = scoreLabel("sea", "research");
    const noneScore = scoreLabel("sea", "hello");

    expect(prefixScore).toBe(3);
    expect(wordStartScore).toBe(2);
    expect(substringScore).toBe(1);
    expect(noneScore).toBe(0);

    expect(prefixScore).toBeGreaterThan(wordStartScore);
    expect(wordStartScore).toBeGreaterThan(substringScore);
    expect(substringScore).toBeGreaterThan(noneScore);
  });

  it("rankItems ranks by score and drops non-matches; empty query keeps input order", () => {
    const items = [
      { label: "research" },
      { label: "search-bar" },
      { label: "hello" },
      { label: "file-search-fix" },
    ];

    const ranked = rankItems(items, "sea");
    expect(ranked.map((r) => r.label)).toEqual([
      "search-bar",
      "file-search-fix",
      "research",
    ]);

    const emptyRanked = rankItems(items, "");
    expect(emptyRanked.map((r) => r.label)).toEqual([
      "research",
      "search-bar",
      "hello",
      "file-search-fix",
    ]);
  });

  it("highlightMatch highlights the first case-insensitive substring match", () => {
    expect(highlightMatch("file-search-fix", "sea")).toEqual([
      { text: "file-", hit: false },
      { text: "sea", hit: true },
      { text: "rch-fix", hit: false },
    ]);

    expect(highlightMatch("SearchEngine", "sea")).toEqual([
      { text: "Sea", hit: true },
      { text: "rchEngine", hit: false },
    ]);

    expect(highlightMatch("nomatch", "sea")).toEqual([
      { text: "nomatch", hit: false },
    ]);
  });
});

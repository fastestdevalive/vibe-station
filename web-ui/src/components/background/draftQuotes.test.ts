import { describe, expect, it } from "vitest";
import { pickDraftQuote, quotes } from "./draftQuotes";

describe("draftQuotes (mobile DraftQuotes.kt parity)", () => {
  it("71 quotes loaded", () => {
    expect(quotes).toHaveLength(71);
    expect(quotes[0]).toEqual({ id: "q001", text: "Build something epic" });
    expect(quotes.every((q) => q.text.trim() !== "")).toBe(true);
  });

  it("same key same quote", () => {
    const first = pickDraftQuote("new");
    expect(first).not.toBeNull();
    expect(pickDraftQuote("new")).toEqual(first);
    expect(pickDraftQuote("draft-1")).toEqual(pickDraftQuote("draft-1"));
    // Keys that differ hash to different picks (mobile hashes `quote:<key>`).
    expect(pickDraftQuote("new")?.id).not.toBe(pickDraftQuote("draft-1")?.id);
  });
});

import { describe, it, expect } from "vitest";
import { generateProjectPrefix, makeUniquePrefix } from "../services/prefix.js";

describe("generateProjectPrefix", () => {
  it("uses short ids as-is", () => {
    expect(generateProjectPrefix("api")).toBe("api");
  });
  it("takes first 3 chars of a single word", () => {
    expect(generateProjectPrefix("testrepo")).toBe("tes");
  });
  it("uses initials for kebab/snake case", () => {
    expect(generateProjectPrefix("agent-orchestrator")).toBe("ao");
  });
});

describe("makeUniquePrefix", () => {
  const taken = (set: string[]) => (p: string) => set.includes(p);

  it("returns the base when free", () => {
    expect(makeUniquePrefix("tes", taken([]))).toBe("tes");
  });

  it("appends the next free numeric suffix on collision", () => {
    expect(makeUniquePrefix("tes", taken(["tes"]))).toBe("tes2");
    expect(makeUniquePrefix("tes", taken(["tes", "tes2"]))).toBe("tes3");
  });

  it("keeps the result within the 6-char cap by trimming the stem", () => {
    // base is already 6 chars — suffix must not push it over the cap.
    const out = makeUniquePrefix("abcdef", taken(["abcdef"]));
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out).toBe("abcde2");
  });
});

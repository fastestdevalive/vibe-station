import { describe, expect, it } from "vitest";
import { fmt } from "./formatTokens";

describe("fmt", () => {
  it("is exact below 1000 and compact above", () => {
    const cases: Array<[number, string]> = [
      [0, "0"], [999, "999"], [1000, "1k"], [1300, "1.3k"], [22800, "22.8k"],
      [100800, "100.8k"], [999900, "999.9k"], [999960, "1M"], [1000000, "1M"], [1250000, "1.3M"],
    ];
    for (const [n, out] of cases) expect(fmt(n)).toBe(out);
  });
});

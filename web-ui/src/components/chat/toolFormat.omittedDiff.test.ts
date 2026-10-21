import { describe, expect, it } from "vitest";
import { omittedDiffBytes } from "./toolFormat";

describe("omittedDiffBytes", () => {
  it("parses the daemon's size-cap placeholder", () => {
    expect(omittedDiffBytes({ path: "a.rs", newText: "(diff omitted — 41437 bytes)" })).toBe(41437);
  });

  it("returns null for a real diff", () => {
    expect(omittedDiffBytes({ path: "a.rs", newText: "fn main() {}\n" })).toBeNull();
    expect(omittedDiffBytes({ path: "a.rs", newText: "" })).toBeNull();
  });
});

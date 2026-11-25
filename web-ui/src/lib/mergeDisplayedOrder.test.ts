import { describe, expect, it } from "vitest";
import { mergeDisplayedOrder } from "./mergeDisplayedOrder";

describe("mergeDisplayedOrder", () => {
  it("keeps non-displayed ids at their relative position", () => {
    expect(mergeDisplayedOrder(["p1", "hidden", "p2"], ["p2", "p1"])).toEqual(["p2", "hidden", "p1"]);
  });
  it("appends everything when nothing is stored, preserving order", () => {
    expect(mergeDisplayedOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("places displayed-but-unstored ids before their displayed successor", () => {
    expect(mergeDisplayedOrder(["x", "y"], ["b", "a", "y", "x"])).toEqual(["b", "a", "y", "x"]);
  });
  it("appends trailing new ids after stored ids", () => {
    expect(mergeDisplayedOrder(["x", "gone"], ["x", "n"])).toEqual(["x", "gone", "n"]);
  });
  it("clamps to 500", () => {
    const stored = Array.from({ length: 600 }, (_, i) => `s${i}`);
    expect(mergeDisplayedOrder(stored, ["s0"]).length).toBe(500);
  });
});

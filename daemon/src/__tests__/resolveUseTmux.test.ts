// @ts-nocheck
import { describe, it, expect } from "vitest";
import { resolveUseTmux } from "../services/resolveUseTmux.js";

describe("resolveUseTmux", () => {
  it("1.T2 — undefined → true (back-compat default)", () => {
    expect(resolveUseTmux(undefined)).toBe(true);
  });

  it("1.T2 — true → true", () => {
    expect(resolveUseTmux(true)).toBe(true);
  });

  it("1.T2 — false → false", () => {
    expect(resolveUseTmux(false)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { apiErrorText } from "./apiErrorText";

describe("apiErrorText", () => {
  it("unwraps the daemon's { error } body", () => {
    expect(apiErrorText(new Error('{"error":"fire_at must be in the future"}'))).toBe("fire_at must be in the future");
  });
  it("passes plain messages through and falls back when empty", () => {
    expect(apiErrorText(new Error("Network down"))).toBe("Network down");
    expect(apiErrorText(undefined, "nope")).toBe("nope");
  });
});

import { describe, expect, it } from "vitest";
import { modelIconKey } from "./modelIcon";

describe("modelIconKey", () => {
  it("matches the segment after the last slash (vendor-qualified ids)", () => {
    expect(modelIconKey("openai/gpt-5")).toBe("codex");
    expect(modelIconKey("opencode/big-pickle")).toBeNull();
  });

  it("maps claude family names", () => {
    expect(modelIconKey("opus")).toBe("claude");
    expect(modelIconKey("sonnet-4-5")).toBe("claude");
    expect(modelIconKey("haiku")).toBe("claude");
    expect(modelIconKey("claude-opus-4-1")).toBe("claude");
  });

  it("maps deepseek anywhere in the segment", () => {
    expect(modelIconKey("deepseek-v4")).toBe("deepseek");
    expect(modelIconKey("opencode/deepseek-v4")).toBe("deepseek");
  });

  it("maps gpt / o-series / codex to codex", () => {
    expect(modelIconKey("gpt-5")).toBe("codex");
    expect(modelIconKey("o3-mini")).toBe("codex");
    expect(modelIconKey("codex-mini")).toBe("codex");
  });

  it("maps gemini to agy", () => {
    expect(modelIconKey("gemini-3")).toBe("agy");
    expect(modelIconKey("google/gemini-2.5-pro")).toBe("agy");
  });

  it("returns null for unknown vendors and empty ids", () => {
    expect(modelIconKey("kimi-k2")).toBeNull();
    expect(modelIconKey("big-pickle")).toBeNull();
    expect(modelIconKey("")).toBeNull();
    expect(modelIconKey(undefined)).toBeNull();
    expect(modelIconKey(null)).toBeNull();
  });
});

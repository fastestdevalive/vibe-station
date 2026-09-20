import { describe, it, expect } from "vitest";
import { deriveModeIcon, sessionModeId } from "./modeIcon";

describe("deriveModeIcon (mirrors daemon default_mode_icon)", () => {
  it("uses the CLI's own icon for claude/cursor/agy", () => {
    expect(deriveModeIcon("claude", "opus")).toBe("claude");
    expect(deriveModeIcon("cursor", null)).toBe("cursor");
    expect(deriveModeIcon("agy", "Gemini 3.5 Flash")).toBe("agy");
  });
  it("opencode is model-aware: deepseek (case-insensitive) else opencode", () => {
    expect(deriveModeIcon("opencode", "deepseek-local/deepseek-v4-flash")).toBe("deepseek");
    expect(deriveModeIcon("opencode", "DeepSeek-R1")).toBe("deepseek");
    expect(deriveModeIcon("opencode", "gpt-5")).toBe("opencode");
    expect(deriveModeIcon("opencode", null)).toBe("opencode");
  });
  it("returns null with no CLI chosen", () => {
    expect(deriveModeIcon("", "x")).toBeNull();
  });
});

describe("sessionModeId", () => {
  it("prefers the session's modeId", () => {
    expect(sessionModeId({ modeId: "m1", draftConfig: { entryPoint: "tab", modeId: "m2" } })).toBe("m1");
  });
  it("falls back to the draft's chosen mode after promotion (modeId not yet patched)", () => {
    expect(sessionModeId({ modeId: null, draftConfig: { entryPoint: "tab", modeId: "m2" } })).toBe("m2");
  });
  it("is null when neither is set", () => {
    expect(sessionModeId({ modeId: null, draftConfig: null })).toBeNull();
    expect(sessionModeId({ modeId: null })).toBeNull();
  });
});

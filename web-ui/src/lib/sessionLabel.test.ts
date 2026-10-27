import { describe, it, expect } from "vitest";
import { draftLabel, sessionLabel, worktreeLabel } from "./sessionLabel";

describe("sessionLabel (1.T9)", () => {
  it("draftLabel renders mention tokens without braces and handles empty prompts", () => {
    expect(draftLabel('hi {@file ["a/b.ts","b.ts"]} there')).toBe("hi @a/b.ts there");
    expect(draftLabel("")).toBe("New agent…");
    expect(draftLabel("   ")).toBe("New agent…");
    expect(draftLabel(null)).toBe("New agent…");
    expect(draftLabel(undefined)).toBe("New agent…");
  });

  it("sessionLabel returns name or fallback", () => {
    expect(sessionLabel({ name: "Custom", isMain: false, type: "agent" })).toBe("Custom");
    expect(sessionLabel({ name: "", isMain: true, type: "agent" })).toBe("main");
    expect(sessionLabel({ name: "", isMain: false, type: "agent" })).toBe("Agent");
    expect(sessionLabel({ name: "", isMain: false, type: "terminal" })).toBe("Terminal");
  });

  it("worktreeLabel returns name or branch", () => {
    expect(worktreeLabel({ name: "my-worktree", branch: "feat" })).toBe("my-worktree");
    expect(worktreeLabel({ name: null as unknown as string, branch: "feat" })).toBe("feat");
  });
});

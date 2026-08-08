import { describe, it, expect } from "vitest";
import { slugifyPrompt } from "../services/naming.js";

describe("slugifyPrompt", () => {
  it("3.T1 derives a 2-word slug, dropping stopwords/noise", () => {
    expect(slugifyPrompt("Implement the login flow described in SPEC.md")).toBe("implement-login-flow");
  });

  it("3.T2 strips path-shaped tokens entirely (no leaked path segments)", () => {
    const slug = slugifyPrompt("Review the diff at /tmp/pr.diff and summarise findings.");
    expect(slug).not.toContain("tmp");
    expect(slug).not.toContain("pr");
  });

  it("3.T3 empty/whitespace-only prompt -> \"\"", () => {
    expect(slugifyPrompt("")).toBe("");
    expect(slugifyPrompt("   \n\t  ")).toBe("");
  });

  it("3.T3 non-ASCII-only prompt -> \"\"", () => {
    expect(slugifyPrompt("ログインフローを実装してください")).toBe("");
  });

  it("3.T4 output length never exceeds 60 chars for a long run-on prompt", () => {
    const longPrompt = Array.from({ length: 40 }, (_, i) => `wordnumber${i}`).join(" ");
    const slug = slugifyPrompt(longPrompt, 40, 60);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it("caps at maxWords by default", () => {
    const slug = slugifyPrompt("refactor the authentication middleware logging pipeline completely");
    expect(slug.split("-").length).toBeLessThanOrEqual(3);
  });

  it("strips code fences and URLs", () => {
    const slug = slugifyPrompt("```const x = 1;``` fix the bug at https://example.com/issue/123 please");
    expect(slug).not.toContain("const");
    expect(slug).not.toContain("example");
  });
});

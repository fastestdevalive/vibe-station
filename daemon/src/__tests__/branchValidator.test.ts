// @ts-nocheck
import { describe, it, expect } from "vitest";
import { validateBranch } from "../services/branchValidator.js";

describe("validateBranch", () => {
  // Valid names
  it.each([
    "fix-auth",
    "feature/my-feature",
    "main",
    "v1.0.0",
    "release-1.2.3",
    "a",
    "ABC",
    "feat/JIRA-123-my-fix",
  ])("accepts valid branch name: %s", (name) => {
    expect(validateBranch(name).ok).toBe(true);
  });

  // Invalid names
  it("rejects empty string", () => {
    expect(validateBranch("").ok).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(validateBranch(".feature").ok).toBe(false);
  });

  it("rejects names starting with a slash", () => {
    expect(validateBranch("/feature").ok).toBe(false);
  });

  it('rejects names containing ".."', () => {
    expect(validateBranch("..feature").ok).toBe(false);
    expect(validateBranch("feat..ure").ok).toBe(false);
    expect(validateBranch("feature..").ok).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(validateBranch("my feature").ok).toBe(false);
  });

  it("rejects names with special chars (@, #, ~, ^)", () => {
    expect(validateBranch("feat@ure").ok).toBe(false);
    expect(validateBranch("feat#ure").ok).toBe(false);
    expect(validateBranch("feat~ure").ok).toBe(false);
    expect(validateBranch("feat^ure").ok).toBe(false);
  });

  it("rejects names exceeding 200 chars", () => {
    const longName = "a".repeat(201);
    const result = validateBranch(longName);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("200");
  });

  it("returns a reason string on failure", () => {
    const result = validateBranch("..bad");
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
import { parseMentionQuery } from "./mentionQuery";
import { MAX_MENTION_QUERY_LENGTH } from "./mentionOps";

describe("mentionQuery (1.T10)", () => {
  it("parses empty raw to all scope kinds", () => {
    expect(parseMentionQuery("")).toEqual({
      scope: null,
      query: "",
      scopeKinds: ["file", "agent", "worktree", "project"],
      raw: "",
    });
  });

  it("parses section prefixes to matching scope kind", () => {
    expect(parseMentionQuery("ag")).toEqual({
      scope: null,
      query: "ag",
      scopeKinds: ["agent"],
      raw: "ag",
    });

    expect(parseMentionQuery("agent")).toEqual({
      scope: null,
      query: "agent",
      scopeKinds: ["agent"],
      raw: "agent",
    });

    expect(parseMentionQuery("agents")).toEqual({
      scope: null,
      query: "agents",
      scopeKinds: ["agent"],
      raw: "agents",
    });

    expect(parseMentionQuery("p")).toEqual({
      scope: null,
      query: "p",
      scopeKinds: ["project"],
      raw: "p",
    });

    expect(parseMentionQuery("w")).toEqual({
      scope: null,
      query: "w",
      scopeKinds: ["worktree"],
      raw: "w",
    });
  });

  it("parses scoped queries case-insensitively with group query", () => {
    expect(parseMentionQuery("Agents:fo")).toEqual({
      scope: "agent",
      query: "fo",
      scopeKinds: [],
      raw: "Agents:fo",
    });

    expect(parseMentionQuery("file:x")).toEqual({
      scope: "file",
      query: "x",
      scopeKinds: [],
      raw: "file:x",
    });

    expect(parseMentionQuery("worktrees:feat")).toEqual({
      scope: "worktree",
      query: "feat",
      scopeKinds: [],
      raw: "worktrees:feat",
    });

    expect(parseMentionQuery("projects:test")).toEqual({
      scope: "project",
      query: "test",
      scopeKinds: [],
      raw: "projects:test",
    });
  });

  it("parses non-matching queries without scope or scopeKinds", () => {
    expect(parseMentionQuery("zzz")).toEqual({
      scope: null,
      query: "zzz",
      scopeKinds: [],
      raw: "zzz",
    });
  });
});

describe("mentionQuery spaces (F1)", () => {
  it("keeps spaces in unscoped and scoped queries", () => {
    expect(parseMentionQuery("Agent 2")).toMatchObject({ scope: null, query: "Agent 2", scopeKinds: [] });
    expect(parseMentionQuery("agents:Agent 2")).toMatchObject({ scope: "agent", query: "Agent 2" });
  });

  it("caps the query length at 40", () => {
    expect(MAX_MENTION_QUERY_LENGTH).toBe(40);
  });
});

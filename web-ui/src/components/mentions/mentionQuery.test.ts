import { describe, it, expect } from "vitest";
import { parseMentionQuery, splitProjectQuery } from "./mentionQuery";
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

  it("caps the query length at 80 (room for <project>:<worktree>)", () => {
    expect(MAX_MENTION_QUERY_LENGTH).toBe(80);
  });
});

describe("splitProjectQuery", () => {
  const projects = [
    { id: "p1", name: "alpha" },
    { id: "p2", name: "alpha:beta" },
    { id: "p3", name: "Alpha" },
    { id: "p4", name: "My Proj" },
  ];

  it("returns null until a full project name is followed by a colon", () => {
    expect(splitProjectQuery("alp", projects)).toBeNull();
    expect(splitProjectQuery("alpha", projects)).toBeNull();
  });

  it("splits on the project name and returns every project sharing it (case-insensitive)", () => {
    const r = splitProjectQuery("alpha:feat", projects)!;
    expect(r.rest).toBe("feat");
    expect(r.scope.projectIds).toEqual(["p1", "p3"]);
  });

  it("prefers the longest matching name (names may contain ':')", () => {
    const r = splitProjectQuery("alpha:beta:x", projects)!;
    expect(r.scope.projectIds).toEqual(["p2"]);
    expect(r.rest).toBe("x");
  });

  it("supports spaces and an empty worktree half", () => {
    const r = splitProjectQuery("my proj:", projects)!;
    expect(r.scope.projectName).toBe("My Proj");
    expect(r.rest).toBe("");
  });

  it("parseMentionQuery strips the project half for @agents: / @agent:, and never for files/projects", () => {
    for (const prefix of ["agents", "agent"]) {
      const p = parseMentionQuery(`${prefix}:alpha:main`, projects);
      expect(p.scope).toBe("agent");
      expect(p.query).toBe("main");
      expect(p.projectScope?.projectName).toBe("alpha");
    }
    expect(parseMentionQuery("files:alpha:x", projects).projectScope).toBeUndefined();
    expect(parseMentionQuery("projects:alpha:x", projects).projectScope).toBeUndefined();
  });

  it("parseMentionQuery strips the project half for @worktrees: and the singular alias", () => {
    for (const prefix of ["worktrees", "worktree"]) {
      const p = parseMentionQuery(`${prefix}:My Proj:fix`, projects);
      expect(p.scope).toBe("worktree");
      expect(p.query).toBe("fix");
      expect(p.projectScope?.projectIds).toEqual(["p4"]);
    }
    expect(parseMentionQuery("worktrees:My", projects).projectScope).toBeUndefined();
  });
});

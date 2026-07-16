import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import type { ProjectRecord, WorktreeRecord } from "../types.js";
import {
  resolvedContextOf,
  sessionDataDirFor,
  systemPromptPathFor,
  opencodeConfigPathFor,
} from "../services/context.js";

vi.mock("../services/paths.js", () => ({
  worktreePath: (p: string, w: string) => `/home/vst/.vibe-station/projects/${p}/worktrees/${w}`,
  sessionDataDir: (p: string, w: string, s: string) => `/data/${p}/wt/${w}/${s}`,
  directSessionDataDir: (p: string, s: string) => `/data/${p}/direct/${s}`,
  systemPromptPath: (p: string, w: string, s: string) => `/data/${p}/wt/${w}/${s}/system-prompt.md`,
  directSystemPromptPath: (p: string, s: string) => `/data/${p}/direct/${s}/system-prompt.md`,
  opencodeConfigPath: (p: string, w: string, s: string) => `/data/${p}/wt/${w}/${s}/oc.json`,
  directOpencodeConfigPath: (p: string, s: string) => `/data/${p}/direct/${s}/oc.json`,
}));

const project = { id: "proj-1", absolutePath: "/repos/proj-1" } as unknown as ProjectRecord;
const worktree = { id: "proj-1-w1" } as unknown as WorktreeRecord;

describe("resolvedContextOf", () => {
  it("worktree context: cwd is the worktree checkout, worktree present", () => {
    const ctx = resolvedContextOf(project, worktree);
    expect(ctx.ref).toEqual({ kind: "worktree", projectId: "proj-1", worktreeId: "proj-1-w1" });
    expect(ctx.worktree).toBe(worktree);
    expect(ctx.cwd).toBe("/home/vst/.vibe-station/projects/proj-1/worktrees/proj-1-w1");
  });

  it("project (direct) context: cwd is the project dir, worktree is null", () => {
    const ctx = resolvedContextOf(project, null);
    expect(ctx.ref).toEqual({ kind: "project", projectId: "proj-1" });
    expect(ctx.worktree).toBeNull();
    expect(ctx.cwd).toBe("/repos/proj-1");
  });
});

describe("context path helpers route by kind", () => {
  it("worktree context → worktree data dirs", () => {
    const ctx = resolvedContextOf(project, worktree);
    expect(sessionDataDirFor(ctx, "s1")).toBe("/data/proj-1/wt/proj-1-w1/s1");
    expect(systemPromptPathFor(ctx, "s1")).toBe("/data/proj-1/wt/proj-1-w1/s1/system-prompt.md");
    expect(opencodeConfigPathFor(ctx, "s1")).toBe("/data/proj-1/wt/proj-1-w1/s1/oc.json");
  });

  it("project context → direct data dirs (no fabricated worktree in the path)", () => {
    const ctx = resolvedContextOf(project, null);
    expect(sessionDataDirFor(ctx, "s1")).toBe("/data/proj-1/direct/s1");
    expect(systemPromptPathFor(ctx, "s1")).toBe("/data/proj-1/direct/s1/system-prompt.md");
    expect(opencodeConfigPathFor(ctx, "s1")).toBe("/data/proj-1/direct/s1/oc.json");
    // The old synthetic-worktree bug put "<project>-direct" in these paths.
    expect(sessionDataDirFor(ctx, "s1")).not.toContain("proj-1-direct");
  });
});

import { describe, it, expect, vi } from "vitest";
import type { ProjectRecord } from "../types.js";

const h = vi.hoisted(() => ({ projects: [] as unknown[] }));

vi.mock("../state/project-store.js", () => ({
  getAllProjects: () => h.projects,
}));

vi.mock("../services/paths.js", () => ({
  worktreePath: (p: string, w: string) => `/home/vst/.vibe-station/projects/${p}/worktrees/${w}`,
  sessionDataDir: (p: string, w: string, s: string) => `/data/${p}/wt/${w}/${s}`,
  directSessionDataDir: (p: string, s: string) => `/data/${p}/direct/${s}`,
  systemPromptPath: (p: string, w: string, s: string) => `/data/${p}/wt/${w}/${s}/system-prompt.md`,
  directSystemPromptPath: (p: string, s: string) => `/data/${p}/direct/${s}/system-prompt.md`,
  opencodeConfigPath: (p: string, w: string, s: string) => `/data/${p}/wt/${w}/${s}/oc.json`,
  directOpencodeConfigPath: (p: string, s: string) => `/data/${p}/direct/${s}/oc.json`,
}));

function seed() {
  h.projects = [
    {
      id: "proj-1",
      absolutePath: "/repos/proj-1",
      worktrees: [
        { id: "proj-1-w1", sessions: [{ id: "proj-1-w1-m" }] },
      ],
      directSessions: [{ id: "proj-1-d1" }],
    } as unknown as ProjectRecord,
  ];
}

describe("resolveContext", () => {
  it("resolves a worktree context to the worktree checkout", async () => {
    seed();
    const { resolveContext } = await import("../services/context.js");
    const ctx = resolveContext({ kind: "worktree", projectId: "proj-1", worktreeId: "proj-1-w1" });
    expect(ctx?.worktree?.id).toBe("proj-1-w1");
    expect(ctx?.cwd).toBe("/home/vst/.vibe-station/projects/proj-1/worktrees/proj-1-w1");
  });

  it("resolves a project context to the project dir, with worktree = null", async () => {
    seed();
    const { resolveContext } = await import("../services/context.js");
    const ctx = resolveContext({ kind: "project", projectId: "proj-1" });
    expect(ctx?.worktree).toBeNull();
    expect(ctx?.cwd).toBe("/repos/proj-1");
  });

  it("returns null when the project is gone", async () => {
    seed();
    const { resolveContext } = await import("../services/context.js");
    expect(resolveContext({ kind: "project", projectId: "nope" })).toBeNull();
  });

  it("returns null when the worktree is gone (not a silent project fallback)", async () => {
    seed();
    const { resolveContext } = await import("../services/context.js");
    expect(
      resolveContext({ kind: "worktree", projectId: "proj-1", worktreeId: "gone" }),
    ).toBeNull();
  });
});

describe("contextForSession", () => {
  it("finds a direct session and resolves its project context", async () => {
    seed();
    const { contextForSession } = await import("../services/context.js");
    const r = contextForSession("proj-1-d1");
    expect(r?.session.id).toBe("proj-1-d1");
    expect(r?.ctx.worktree).toBeNull();
    expect(r?.ctx.cwd).toBe("/repos/proj-1");
  });

  it("finds a worktree session and resolves its worktree context", async () => {
    seed();
    const { contextForSession } = await import("../services/context.js");
    const r = contextForSession("proj-1-w1-m");
    expect(r?.ctx.worktree?.id).toBe("proj-1-w1");
  });
});

describe("context path helpers route by kind", () => {
  it("uses the direct data dir for a project context", async () => {
    seed();
    const { resolveContext, sessionDataDirFor, systemPromptPathFor, opencodeConfigPathFor } =
      await import("../services/context.js");
    const ctx = resolveContext({ kind: "project", projectId: "proj-1" })!;
    expect(sessionDataDirFor(ctx, "s1")).toBe("/data/proj-1/direct/s1");
    expect(systemPromptPathFor(ctx, "s1")).toBe("/data/proj-1/direct/s1/system-prompt.md");
    expect(opencodeConfigPathFor(ctx, "s1")).toBe("/data/proj-1/direct/s1/oc.json");
  });

  it("uses the worktree data dir for a worktree context", async () => {
    seed();
    const { resolveContext, sessionDataDirFor, systemPromptPathFor } = await import(
      "../services/context.js"
    );
    const ctx = resolveContext({ kind: "worktree", projectId: "proj-1", worktreeId: "proj-1-w1" })!;
    expect(sessionDataDirFor(ctx, "s1")).toBe("/data/proj-1/wt/proj-1-w1/s1");
    expect(systemPromptPathFor(ctx, "s1")).toBe("/data/proj-1/wt/proj-1-w1/s1/system-prompt.md");
  });
});

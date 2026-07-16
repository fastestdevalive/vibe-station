import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectRecord, SessionRecord } from "../types.js";

const h = vi.hoisted(() => ({ projects: [] as unknown[] }));

vi.mock("../state/project-store.js", () => ({
  getAllProjects: () => h.projects,
}));

function session(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    slot: "m",
    type: "agent",
    tmuxName: `vr-${id}`,
    useTmux: true,
    lifecycle: { state: "idle", lastTransitionAt: "2026-01-01T00:00:00.000Z" },
    ...over,
  } as SessionRecord;
}

/**
 * Regression coverage for the WS session lookup.
 *
 * This function used to scan only project.worktrees, so every direct session
 * was invisible to session:open / session:input / session:resize: the daemon
 * answered "Session not found" while the agent was alive and healthy, and the
 * UI turned that error into a phantom "Session exited." banner.
 */
describe("findSessionRecord", () => {
  const wtSession = session("proj-1-w1-m");
  const directAgent = session("proj-1-d1", { slot: "d1" });
  const directTerminal = session("proj-1-d2", { slot: "d2", type: "terminal" });

  beforeEach(() => {
    h.projects = [
      {
        id: "proj-1",
        absolutePath: "/tmp/proj-1",
        prefix: "p1",
        isGit: true,
        defaultBranch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        worktrees: [
          {
            id: "proj-1-w1",
            branch: "feat",
            baseBranch: "main",
            baseSha: "",
            createdAt: "2026-01-01T00:00:00.000Z",
            sessions: [wtSession],
          },
        ],
        directSessions: [directAgent, directTerminal],
      } as unknown as ProjectRecord,
    ];
  });

  it("resolves a worktree session", async () => {
    const { findSessionRecord } = await import("../ws/handlers/sessionLookup.js");
    const result = findSessionRecord("proj-1-w1-m");
    expect(result?.session).toBe(wtSession);
    expect(result?.project.id).toBe("proj-1");
  });

  it("resolves a direct agent session (regression: used to return null)", async () => {
    const { findSessionRecord } = await import("../ws/handlers/sessionLookup.js");
    const result = findSessionRecord("proj-1-d1");
    expect(result).not.toBeNull();
    expect(result?.session).toBe(directAgent);
    expect(result?.project.id).toBe("proj-1");
  });

  it("resolves a direct terminal session (the terminal dock's auto-created shell)", async () => {
    const { findSessionRecord } = await import("../ws/handlers/sessionLookup.js");
    expect(findSessionRecord("proj-1-d2")?.session).toBe(directTerminal);
  });

  it("returns null for an unknown session id", async () => {
    const { findSessionRecord } = await import("../ws/handlers/sessionLookup.js");
    expect(findSessionRecord("nope")).toBeNull();
  });

  it("finds direct sessions across projects", async () => {
    const otherDirect = session("proj-2-d1", { slot: "d1" });
    (h.projects as ProjectRecord[]).push({
      id: "proj-2",
      worktrees: [],
      directSessions: [otherDirect],
    } as unknown as ProjectRecord);

    const { findSessionRecord } = await import("../ws/handlers/sessionLookup.js");
    expect(findSessionRecord("proj-2-d1")?.session).toBe(otherDirect);
  });
});

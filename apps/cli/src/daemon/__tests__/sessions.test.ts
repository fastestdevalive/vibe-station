import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vrunHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
  };
});

// Mock tmux so we don't need a real tmux server for session tests
vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  killSession: vi.fn().mockResolvedValue(undefined),
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  listSessions: vi.fn().mockResolvedValue([]),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {
      // Mock: do nothing
    }),
    spawnSessionFromArgv: vi.fn(async () => {
      // Mock: do nothing
    }),
  };
});

describe("Session routes", () => {
  let app: FastifyInstance;
  let projectId: string;
  let worktreeId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-sess-test-"));
    const repoDir = join(tempDir, "my-repo");
    execSync(
      `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`,
      { stdio: "ignore" },
    );

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    // Create modes.json with test modes
    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([
        {
          id: "bugfix",
          name: "Bug Fix",
          cli: "claude",
          context: "You are a bug fix expert",
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    // Reset modes cache and skill cache
    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const promptBuilderModule = await import("../services/promptBuilder.js");
    promptBuilderModule._resetSkillCacheForTest();

    app = await buildServer();

    // Bootstrap project + worktree
    const projRes = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    projectId = projRes.json<ProjectRecord>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "feat-sessions", modeId: "bugfix" },
    });
    worktreeId = wtRes.json<WorktreeRecord>().id;
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("GET /sessions?worktree=:id returns main session created with worktree", async () => {
    const res = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    expect(res.statusCode).toBe(200);
    const sessions = res.json<SessionRecord[]>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.slot).toBe("m");
  });

  it("GET /sessions/:id returns session details", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/sessions?worktree=${worktreeId}`,
    });
    const mainSession = listRes.json<SessionRecord[]>()[0]!;

    const res = await app.inject({ method: "GET", url: `/sessions/${mainSession.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionRecord>().id).toBe(mainSession.id);
  });

  it("POST /sessions creates a new agent session (a1)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    expect(res.statusCode).toBe(201);
    const session = res.json<SessionRecord>();
    expect(session.slot).toBe("a1");
    expect(session.type).toBe("agent");
  });

  it("POST /sessions creates terminal session without modeId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "terminal" },
    });
    expect(res.statusCode).toBe(201);
    const session = res.json<SessionRecord>();
    expect(session.slot).toBe("t1");
    expect(session.type).toBe("terminal");
  });

  it("POST /sessions 400 when agent missing modeId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /sessions/:id 400 for main session", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;

    const res = await app.inject({ method: "DELETE", url: `/sessions/${mainId}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("main session");
  });

  it("DELETE /sessions/:id removes non-main session", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "terminal" },
    });
    const sessionId = createRes.json<SessionRecord>().id;

    const delRes = await app.inject({ method: "DELETE", url: `/sessions/${sessionId}` });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);

    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const sessions = listRes.json<SessionRecord[]>();
    expect(sessions.find((s) => s.id === sessionId)).toBeUndefined();
  });

  it("POST /sessions/:id/resume changes state to working", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;

    const res = await app.inject({ method: "POST", url: `/sessions/${mainId}/resume` });
    expect(res.statusCode).toBe(200);
    const session = res.json<any>();
    expect(session.state).toBe("working");
  });

  it("assigns sequential slots for multiple sessions", async () => {
    // Create a1, a2 in sequence
    const r1 = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    expect(r1.json<SessionRecord>().slot).toBe("a1");
    expect(r2.json<SessionRecord>().slot).toBe("a2");
  });
});

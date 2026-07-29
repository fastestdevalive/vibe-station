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
    vstHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    cleanupSessionDataDir: () => {},
    cleanupDirectSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(tempDir, "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) =>
      pathJoin(tempDir, "projects", p, "sessions", s),
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
    tempDir = await mkdtemp(join(tmpdir(), "vst-sess-test-"));
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
    // Drain any in-flight runMainSpawnJob from the bootstrap worktree create
    // before tearing down — its delayed mutateProject would otherwise hit a
    // cleared store in the next beforeEach and surface as an unhandled rejection.
    await new Promise((r) => setTimeout(r, 150));
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

  it("POST /sessions creates terminal session with modeId explicitly null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "terminal", modeId: null },
    });
    expect(res.statusCode).toBe(201);
    const session = res.json<SessionRecord>();
    expect(session.type).toBe("terminal");
    expect(session.slot).toBe("t1");
  });

  it("POST /sessions 400 when agent missing modeId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /sessions 400 when agent has modeId null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: null },
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

  it("POST /sessions/:id/resume replays initialPrompt on a fresh-launch fallback (no agentChatId yet)", async () => {
    const { spawnSession } = await import("../services/spawn.js");
    const spawnMock = vi.mocked(spawnSession);
    spawnMock.mockClear();

    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", prompt: "fix the flaky test" },
    });
    expect(createRes.statusCode).toBe(201);
    const sessionId = createRes.json<SessionRecord>().id;
    // Initial create already triggers a background spawn — clear that call so
    // we only inspect the one triggered by /resume below.
    await new Promise((r) => setTimeout(r, 200));
    spawnMock.mockClear();

    const resumeRes = await app.inject({ method: "POST", url: `/sessions/${sessionId}/resume` });
    expect(resumeRes.statusCode).toBe(200);

    // No agentChatId was ever captured (mocked spawnSession never sets one),
    // and getRestoreCommand for `claude` finds nothing on disk in this sandboxed
    // cwd, so resume must fall into the fresh-launch branch and re-inject the
    // original prompt rather than dropping it.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]?.taskPrompt).toBe("fix the flaky test");
  });

  it("POST /sessions/:id/resume does NOT replay initialPrompt once a real conversation exists (agentChatId set)", async () => {
    const { spawnSession, spawnSessionFromArgv } = await import("../services/spawn.js");
    const spawnMock = vi.mocked(spawnSession);
    const spawnArgvMock = vi.mocked(spawnSessionFromArgv);

    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", prompt: "fix the flaky test" },
    });
    const sessionId = createRes.json<SessionRecord>().id;
    await new Promise((r) => setTimeout(r, 200));

    // Simulate a session that already ran a real turn and had its chat id
    // captured — mirrors what captureChatId would have set post-spawn.
    const { mutateProject } = await import("../state/project-store.js");
    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? { ...w, sessions: w.sessions.map((s) => (s.id === sessionId ? { ...s, agentChatId: "fake-uuid-1234" } : s)) }
          : w,
      ),
    }));

    spawnMock.mockClear();
    spawnArgvMock.mockClear();

    const resumeRes = await app.inject({ method: "POST", url: `/sessions/${sessionId}/resume` });
    expect(resumeRes.statusCode).toBe(200);

    // With an agentChatId present, claude's getRestoreCommand returns a
    // restore argv, so resume takes the spawnSessionFromArgv path — the
    // fresh-launch branch (and its initialPrompt replay) is never reached.
    expect(spawnArgvMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("POST /sessions/:id/resume is a no-op when the session's tmux pane is already alive", async () => {
    const { hasSession } = await import("../services/tmux.js");
    const { spawnSession, spawnSessionFromArgv } = await import("../services/spawn.js");
    const hasSessionMock = vi.mocked(hasSession);
    const spawnMock = vi.mocked(spawnSession);
    const spawnArgvMock = vi.mocked(spawnSessionFromArgv);

    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;
    await new Promise((r) => setTimeout(r, 200));

    spawnMock.mockClear();
    spawnArgvMock.mockClear();
    hasSessionMock.mockResolvedValueOnce(true);

    const res = await app.inject({ method: "POST", url: `/sessions/${mainId}/resume` });
    expect(res.statusCode).toBe(200);
    // Neither spawn path should run — an already-live pane must never be
    // killed and replaced by a racing resume.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnArgvMock).not.toHaveBeenCalled();
  });

  it("1.T4 — channel:json create carries channel through serializeSession and does NOT spawn", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", channel: "json" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; channel?: string; state: string }>();
    expect(created.channel).toBe("json");
    // JSON sessions do not spawn at create — no PTY/tmux job flips them working.
    expect(created.state).toBe("not_started");

    // Give any (incorrectly-scheduled) spawn job a chance to run, then confirm
    // the session is still not_started with channel json (no refetch needed).
    await new Promise((r) => setTimeout(r, 200));
    const getRes = await app.inject({ method: "GET", url: `/sessions/${created.id}` });
    const fetched = getRes.json<{ channel?: string; state: string }>();
    expect(fetched.channel).toBe("json");
    expect(fetched.state).toBe("not_started");
  });

  it("JSON gate — channel:json with a claude (supported) mode → 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", channel: "json" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ channel?: string }>().channel).toBe("json");
  });

  it("2.T4 — TTY (default channel) agent create still spawns (state → working)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; channel?: string }>();
    expect(created.channel).toBe("tmux");

    // The background spawn job (mocked spawnSession) flips the session working.
    await new Promise((r) => setTimeout(r, 250));
    const getRes = await app.inject({ method: "GET", url: `/sessions/${created.id}` });
    expect(getRes.json<{ state: string }>().state).toBe("working");
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

  it("does not reuse an agent slot/id after delete (monotonic)", async () => {
    const create = () =>
      app.inject({
        method: "POST",
        url: "/sessions",
        payload: { worktreeId, type: "agent", modeId: "bugfix" },
      });

    const first = (await create()).json<SessionRecord>();
    expect(first.slot).toBe("a1");

    const del = await app.inject({ method: "DELETE", url: `/sessions/${first.id}` });
    expect(del.statusCode).toBe(200);

    const second = (await create()).json<SessionRecord>();
    expect(second.slot).toBe("a2");
    expect(second.id).not.toBe(first.id);
  });

  it("legacy worktree: deleting ALL agents does not restart the next one at a1", async () => {
    const create = () =>
      app.inject({
        method: "POST",
        url: "/sessions",
        payload: { worktreeId, type: "agent", modeId: "bugfix" },
      });

    // Create a1 and a2, then simulate a LEGACY worktree by stripping agentSeq —
    // as if these agents predated the monotonic-slot counter.
    const a1 = (await create()).json<SessionRecord>();
    const a2 = (await create()).json<SessionRecord>();
    expect([a1.slot, a2.slot]).toEqual(["a1", "a2"]);

    const { mutateProject } = await import("../state/project-store.js");
    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId ? { ...w, agentSeq: undefined } : w,
      ),
    }));

    // Delete every agent BEFORE creating a new one — the reported failure mode.
    expect((await app.inject({ method: "DELETE", url: `/sessions/${a1.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/sessions/${a2.id}` })).statusCode).toBe(200);

    // The delete handler captured the high-water, so the next slot is a3 — not a1.
    const next = (await create()).json<SessionRecord>();
    expect(next.slot).toBe("a3");
    expect(next.id).toBe(`${worktreeId}-a3`);
  });
});

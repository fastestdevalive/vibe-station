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
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
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
    spawnDirectSession: vi.fn(async () => {
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
    expect(sessions[0]?.isMain).toBe(true);
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
    expect(session.name).toBe("Agent 1");
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
    expect(session.name).toBe("Terminal 1");
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
    expect(session.name).toBe("Terminal 1");
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

  it("3.T6 — PATCH /sessions/:id/rename { name: \"\" } clears to null; label falls back", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;

    const renameRes = await app.inject({
      method: "PATCH",
      url: `/sessions/${mainId}/rename`,
      payload: { name: "custom-name" },
    });
    expect(renameRes.statusCode).toBe(200);
    expect(renameRes.json<{ name: string | null }>().name).toBe("custom-name");

    const clearRes = await app.inject({
      method: "PATCH",
      url: `/sessions/${mainId}/rename`,
      payload: { name: "" },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json<{ name: string | null }>().name).toBeNull();

    const getRes = await app.inject({ method: "GET", url: `/sessions/${mainId}` });
    const session = getRes.json<{ name: string | null; label: string }>();
    expect(session.name).toBeNull();
    expect(session.label).toBe("main"); // UI-facing fallback for a cleared main session's name
  });

  it("Bug 4 fix: POST /sessions/:id/resume on an archived session returns 400 and does not spawn", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id as string;

    const resetRes = await app.inject({ method: "POST", url: `/sessions/${mainId}/reset`, payload: {} });
    expect(resetRes.statusCode).toBe(200);

    const spawnModule = await import("../services/spawn.js");
    vi.mocked(spawnModule.spawnSession).mockClear();
    vi.mocked(spawnModule.spawnSessionFromArgv).mockClear();

    const resumeRes = await app.inject({ method: "POST", url: `/sessions/${mainId}/resume` });
    expect(resumeRes.statusCode).toBe(400);
    expect(vi.mocked(spawnModule.spawnSession)).not.toHaveBeenCalled();
    expect(vi.mocked(spawnModule.spawnSessionFromArgv)).not.toHaveBeenCalled();
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

  // ─── POST /sessions/:id/done — releases resources, stays resumable ───────
  describe("POST /sessions/:id/done releases runtime resources", () => {
    async function mainSession(): Promise<SessionRecord> {
      const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
      return listRes.json<SessionRecord[]>()[0]!;
    }

    it("2.T1 — kills the tmux pane and keeps the session record", async () => {
      const tmux = await import("../services/tmux.js");
      vi.mocked(tmux.killSession).mockClear();
      const main = await mainSession();

      const res = await app.inject({ method: "POST", url: `/sessions/${main.id}/done` });
      expect(res.statusCode).toBe(200);

      expect(vi.mocked(tmux.killSession)).toHaveBeenCalledWith(main.tmuxName);

      // The record survives — "done" is a pause, not a delete.
      const after = await app.inject({ method: "GET", url: `/sessions/${main.id}` });
      expect(after.statusCode).toBe(200);
      expect(after.json<{ state: string }>().state).toBe("done");
    });

    it("2.T1b — is idempotent: a second call is a no-op that does not re-kill", async () => {
      const tmux = await import("../services/tmux.js");
      const main = await mainSession();

      expect((await app.inject({ method: "POST", url: `/sessions/${main.id}/done` })).statusCode).toBe(200);
      vi.mocked(tmux.killSession).mockClear();
      const second = await app.inject({ method: "POST", url: `/sessions/${main.id}/done` });

      expect(second.statusCode).toBe(200);
      expect(vi.mocked(tmux.killSession)).not.toHaveBeenCalled();
    });

    it("2.T2 — a done session still resumes (record + agentChatId survived the release)", async () => {
      const main = await mainSession();
      await app.inject({ method: "POST", url: `/sessions/${main.id}/done` });

      const res = await app.inject({ method: "POST", url: `/sessions/${main.id}/resume` });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ state: string }>().state).toBe("working");
    });

    it("2.T1c — DIRECT (project-level) agent: done kills its pane and stays resumable", async () => {
      const tmux = await import("../services/tmux.js");
      // Direct sessions live in project.directSessions and have no worktree —
      // the same release path has to reach them.
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: { projectId, target: "direct", type: "agent", modeId: "bugfix" },
      });
      expect(created.statusCode).toBe(201);
      const direct = created.json<SessionRecord>();
      expect(direct.name).toMatch(/^Direct \d+$/);

      vi.mocked(tmux.killSession).mockClear();
      const res = await app.inject({ method: "POST", url: `/sessions/${direct.id}/done` });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(tmux.killSession)).toHaveBeenCalledWith(direct.tmuxName);

      const after = await app.inject({ method: "GET", url: `/sessions/${direct.id}` });
      expect(after.json<{ state: string }>().state).toBe("done");

      const resumed = await app.inject({ method: "POST", url: `/sessions/${direct.id}/resume` });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json<{ state: string }>().state).toBe("working");
    });

    it("2.T1d — done DURING spawn: the spawn job must not resurrect the session", async () => {
      // Marking done while an agent is still spawning is easy to do (a spawn
      // takes seconds). The background job must neither clobber `done` nor
      // leave behind the pane it created after the release already ran.
      const spawnModule = await import("../services/spawn.js");
      const tmux = await import("../services/tmux.js");
      let releaseSpawn!: () => void;
      const gate = new Promise<void>((r) => {
        releaseSpawn = r;
      });
      vi.mocked(spawnModule.spawnSession).mockImplementationOnce(async () => {
        await gate;
      });

      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: { worktreeId, type: "agent", modeId: "bugfix" },
      });
      const sess = created.json<SessionRecord>();

      // Retire it while the spawn is parked.
      expect((await app.inject({ method: "POST", url: `/sessions/${sess.id}/done` })).statusCode).toBe(200);

      vi.mocked(tmux.killSession).mockClear();
      releaseSpawn();
      await new Promise((r) => setTimeout(r, 100));

      // State survived the job's completion write...
      const after = await app.inject({ method: "GET", url: `/sessions/${sess.id}` });
      expect(after.json<{ state: string }>().state).toBe("done");
      // ...and the pane the spawn created after our kill was reaped.
      expect(vi.mocked(tmux.killSession)).toHaveBeenCalledWith(sess.tmuxName);
    });

    it("2.T1e — done DURING a FAILING spawn also stays done", async () => {
      const spawnModule = await import("../services/spawn.js");
      let failSpawn!: () => void;
      const gate = new Promise<void>((_, rej) => {
        failSpawn = () => rej(new Error("boom"));
      });
      vi.mocked(spawnModule.spawnSession).mockImplementationOnce(async () => {
        await gate;
      });

      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: { worktreeId, type: "agent", modeId: "bugfix" },
      });
      const sess = created.json<SessionRecord>();
      await app.inject({ method: "POST", url: `/sessions/${sess.id}/done` });

      failSpawn();
      await new Promise((r) => setTimeout(r, 100));

      const after = await app.inject({ method: "GET", url: `/sessions/${sess.id}` });
      // The failure path used to write `exited` over the user's `done`.
      expect(after.json<{ state: string }>().state).toBe("done");
    });

    it("2.T2b — terminals are still rejected", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: { worktreeId, type: "terminal" },
      });
      const term = created.json<SessionRecord>();
      const res = await app.inject({ method: "POST", url: `/sessions/${term.id}/done` });
      expect(res.statusCode).toBe(400);
    });
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
    expect(r1.json<SessionRecord>().name).toBe("Agent 1");
    expect(r2.json<SessionRecord>().name).toBe("Agent 2");
  });

  it("does not reuse an agent slot/id after delete (monotonic)", async () => {
    const create = () =>
      app.inject({
        method: "POST",
        url: "/sessions",
        payload: { worktreeId, type: "agent", modeId: "bugfix" },
      });

    const first = (await create()).json<SessionRecord>();
    expect(first.name).toBe("Agent 1");

    const del = await app.inject({ method: "DELETE", url: `/sessions/${first.id}` });
    expect(del.statusCode).toBe(200);

    const second = (await create()).json<SessionRecord>();
    expect(second.name).toBe("Agent 2");
    expect(second.id).not.toBe(first.id);
  });

  it("deleting ALL agents does not restart the next default label at 'Agent 1' (Decision 5)", async () => {
    const create = () =>
      app.inject({
        method: "POST",
        url: "/sessions",
        payload: { worktreeId, type: "agent", modeId: "bugfix" },
      });

    // Create two agents — agentSeq is bumped at CREATE time only (Decision 5:
    // no id/slot-derived high-water recompute needed anymore, since ids are
    // independently generated and `agentSeq` alone is now the source of truth
    // for the next default label).
    const a1 = (await create()).json<SessionRecord>();
    const a2 = (await create()).json<SessionRecord>();
    expect([a1.name, a2.name]).toEqual(["Agent 1", "Agent 2"]);

    // Delete every agent BEFORE creating a new one — the reported failure mode.
    expect((await app.inject({ method: "DELETE", url: `/sessions/${a1.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/sessions/${a2.id}` })).statusCode).toBe(200);

    // The persisted counter alone carries the high-water — the next default
    // label is "Agent 3", not "Agent 1".
    const next = (await create()).json<SessionRecord>();
    expect(next.name).toBe("Agent 3");
  });
});

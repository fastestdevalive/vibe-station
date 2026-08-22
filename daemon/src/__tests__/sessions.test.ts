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

// `startJsonCreateTurn` would otherwise resolve a real JSON agent (spawning a
// CLI process) — mocked out so `skipAutoTurn` tests can assert on call
// presence/absence without needing a live agent.
vi.mock("../services/jsonAgentChat.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/jsonAgentChat.js")>();
  return {
    ...original,
    startJsonCreateTurn: vi.fn(async () => {
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

  it("DELETE /sessions/:id on main session with an eligible agent sibling promotes it and deletes the old main", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;

    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const siblingId = createRes.json<SessionRecord>().id;

    const delRes = await app.inject({ method: "DELETE", url: `/sessions/${mainId}` });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);

    const afterRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const after = afterRes.json<SessionRecord[]>();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(siblingId);
    expect(after[0]?.isMain).toBe(true);
    expect(after.find((s) => s.id === mainId)).toBeUndefined();
  });

  it("M1 — promotion carries the old main's pr forward immediately, no 30s gap", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id as string;

    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const siblingId = createRes.json<SessionRecord>().id as string;

    // Seed a `pr` on the main session directly via the store, simulating a
    // prior prPoller write, before triggering promotion.
    const { mutateProject } = await import("../state/project-store.js");
    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? {
              ...w,
              sessions: w.sessions.map((s) =>
                s.id === mainId
                  ? {
                      ...s,
                      pr: {
                        state: "open" as const,
                        number: 42,
                        url: "https://github.com/acme/widgets/pull/42",
                        checkedAt: new Date().toISOString(),
                        prBranch: "feat-sessions",
                      },
                    }
                  : s,
              ),
            }
          : w,
      ),
    }));

    await app.inject({ method: "DELETE", url: `/sessions/${mainId}` });

    // No delay, no waiting for a poll tick — the promoted session must
    // already carry the old main's `pr` in the very next read.
    const afterRes = await app.inject({ method: "GET", url: `/sessions/${siblingId}` });
    const after = afterRes.json<SessionRecord>();
    expect(after.isMain).toBe(true);
    expect(after.pr?.state).toBe("open");
    expect(after.pr?.number).toBe(42);
  });

  it("DELETE /sessions/:id on main session with only a terminal sibling still 400s (terminal ineligible)", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;

    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "terminal" },
    });

    const delRes = await app.inject({ method: "DELETE", url: `/sessions/${mainId}` });
    expect(delRes.statusCode).toBe(400);
    expect(delRes.json().error).toContain("no other agent session");
  });

  it("DELETE /sessions/:id on main session with only an archived agent sibling still 400s (archived ineligible)", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;

    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const siblingId = createRes.json<SessionRecord>().id;

    // Archive the sibling directly via the store so it's excluded from
    // promotion eligibility, without depending on the reset-flow route.
    const { mutateProject } = await import("../state/project-store.js");
    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? {
              ...w,
              sessions: w.sessions.map((s) =>
                s.id === siblingId ? { ...s, archivedAt: new Date().toISOString() } : s,
              ),
            }
          : w,
      ),
    }));

    const delRes = await app.inject({ method: "DELETE", url: `/sessions/${mainId}` });
    expect(delRes.statusCode).toBe(400);
    expect(delRes.json().error).toContain("no other agent session");
  });

  it("DELETE /sessions/:id promotion leaves the promoted sibling's name/nameSource unchanged", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id;

    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const sibling = createRes.json<SessionRecord>();
    expect(sibling.name).toBe("Agent 1");

    await app.inject({ method: "DELETE", url: `/sessions/${mainId}` });

    const afterRes = await app.inject({ method: "GET", url: `/sessions/${sibling.id}` });
    const after = afterRes.json<SessionRecord>();
    expect(after.name).toBe("Agent 1");
    expect(after.nameSource).toBe(sibling.nameSource);
    expect(after.isMain).toBe(true);
  });

  // M3 (reviewer): tightened from a single loosely-asserted race test into
  // two deterministic sub-tests. `app.inject()` calls dispatch (and their
  // `mutateProject` callbacks acquire the per-project lock) in the order
  // they're invoked in this test harness — confirmed empirically (10 runs
  // each direction, zero flakes) — so listing one request before the other
  // in the `Promise.all` array deterministically makes that one's commit win
  // the race, letting each ordering be asserted exactly rather than loosely.
  //
  // This test previously exposed a REAL bug during this revision: the plain
  // (non-main) delete path used to filter a session out by id unconditionally,
  // using only the `session.isMain` snapshot captured at the top of the
  // handler (BEFORE the lock). When session B raced session A's promotion —
  // B was not main when B's handler started, but became main via A's commit
  // before B's own commit ran — B's stale-snapshot-driven plain delete still
  // fired, removing the worktree's only main session and leaving ZERO live
  // sessions. Fixed by re-deriving "is this session main, and if so is there
  // an eligible sibling" fresh inside B's own locked `mutateProject`
  // callback too (`daemon/src/routes/sessions.ts`), not just inside the
  // already-flagged-as-main request's callback.
  async function seedMainPlusOneSibling(): Promise<{ mainId: string; siblingId: string }> {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const mainId = listRes.json<SessionRecord[]>()[0]?.id as string;
    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const siblingId = createRes.json<SessionRecord>().id as string;
    return { mainId, siblingId };
  }

  it("A1.T7 — concurrent DELETE, main-delete's commit wins: main promotes+deletes (200), sibling-delete then 400s (no sibling of its own)", async () => {
    const { mainId, siblingId } = await seedMainPlusOneSibling();

    const [mainDel, siblingDel] = await Promise.all([
      app.inject({ method: "DELETE", url: `/sessions/${mainId}` }),
      app.inject({ method: "DELETE", url: `/sessions/${siblingId}` }),
    ]);

    expect(mainDel.statusCode).toBe(200);
    expect(mainDel.json().ok).toBe(true);
    expect(siblingDel.statusCode).toBe(400);
    expect(siblingDel.json().error).toContain("no other agent session");

    const finalRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const final = finalRes.json<SessionRecord[]>();
    const live = final.filter((s) => s.archivedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(siblingId);
    expect(live[0]?.isMain).toBe(true);
  });

  it("A1.T7 — concurrent DELETE, sibling-delete's commit wins: sibling deletes plainly (200), main-delete then 400s (its sibling is already gone)", async () => {
    const { mainId, siblingId } = await seedMainPlusOneSibling();

    const [siblingDel, mainDel] = await Promise.all([
      app.inject({ method: "DELETE", url: `/sessions/${siblingId}` }),
      app.inject({ method: "DELETE", url: `/sessions/${mainId}` }),
    ]);

    expect(siblingDel.statusCode).toBe(200);
    expect(siblingDel.json().ok).toBe(true);
    expect(mainDel.statusCode).toBe(400);
    expect(mainDel.json().error).toContain("no other agent session");

    const finalRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const final = finalRes.json<SessionRecord[]>();
    const live = final.filter((s) => s.archivedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(mainId);
    expect(live[0]?.isMain).toBe(true);
  });

  it("3.T6 — PATCH /sessions/:id/rename { name: \"\" } clears to null", async () => {
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
    const session = getRes.json<{ name: string | null }>();
    // The UI-facing fallback ("main" for a cleared main session's name) is
    // computed client-side (`sessionLabel()` in web-ui/src/lib/sessionLabel.ts)
    // from `name`/`isMain`/`type` — the daemon only needs to confirm `name`
    // itself is correctly cleared.
    expect(session.name).toBeNull();
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

  it("serializeSession carries `pr` through the REST GET — the initial-load carrier a reload depends on", async () => {
    // `prStatusEquivalent` (prPoller.ts) means a steady-state PR never
    // re-broadcasts over WS — the REST fetch on page load is the ONLY path
    // that would ever surface it. If `serializeSession` ever dropped `pr`,
    // a reload would show nothing indefinitely with no test catching it.
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const { id: sessionId } = created.json<SessionRecord>();

    // No PR yet — REST must send an explicit `pr: null`, not an omitted key
    // (web-ui's `Session.pr` type is `PrStatus | null | undefined`, but the
    // wire contract here is always an explicit `null`).
    const beforeRes = await app.inject({ method: "GET", url: `/sessions/${sessionId}` });
    expect(beforeRes.json<{ pr: unknown }>().pr).toBeNull();

    const { updateSessionPr } = await import("../state/project-store.js");
    const pr = {
      state: "open" as const,
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      checkedAt: new Date().toISOString(),
      prBranch: "main",
    };
    const changed = await updateSessionPr(projectId, sessionId, pr);
    expect(changed).toBe(true);

    const afterRes = await app.inject({ method: "GET", url: `/sessions/${sessionId}` });
    expect(afterRes.json<{ pr: typeof pr }>().pr).toEqual(pr);
  });

  it("skipAutoTurn — worktree-scoped channel:json + prompt names the session but does NOT auto-enqueue turn 1", async () => {
    const jsonAgentChat = await import("../services/jsonAgentChat.js");
    const startJsonCreateTurnMock = vi.mocked(jsonAgentChat.startJsonCreateTurn);
    startJsonCreateTurnMock.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        worktreeId,
        type: "agent",
        modeId: "bugfix",
        channel: "json",
        prompt: "Implement the login flow described in SPEC.md",
        skipAutoTurn: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ name: string | null; nameSource: string | null }>();
    expect(created).toMatchObject({ name: "implement-login-flow", nameSource: "auto" });
    // A regression here would double-send the user's first message (once via
    // auto-enqueue, once via the caller's own sendJsonFirstTurn).
    expect(startJsonCreateTurnMock).not.toHaveBeenCalled();
  });

  it("skipAutoTurn — direct channel:json + prompt names the session but does NOT auto-enqueue turn 1", async () => {
    const jsonAgentChat = await import("../services/jsonAgentChat.js");
    const startJsonCreateTurnMock = vi.mocked(jsonAgentChat.startJsonCreateTurn);
    startJsonCreateTurnMock.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        projectId,
        target: "direct",
        type: "agent",
        modeId: "bugfix",
        channel: "json",
        prompt: "Implement the login flow described in SPEC.md",
        skipAutoTurn: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ name: string | null; nameSource: string | null }>();
    expect(created).toMatchObject({ name: "implement-login-flow", nameSource: "auto" });
    expect(startJsonCreateTurnMock).not.toHaveBeenCalled();
  });

  it("skipAutoTurn omitted — channel:json + prompt DOES auto-enqueue turn 1 (unchanged default)", async () => {
    const jsonAgentChat = await import("../services/jsonAgentChat.js");
    const startJsonCreateTurnMock = vi.mocked(jsonAgentChat.startJsonCreateTurn);
    startJsonCreateTurnMock.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        worktreeId,
        type: "agent",
        modeId: "bugfix",
        channel: "json",
        prompt: "Implement the login flow described in SPEC.md",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(startJsonCreateTurnMock).toHaveBeenCalledTimes(1);
  });

  it("4a.T1 — POST /sessions with sourceAgentId persists it as spawnedFrom on the new record", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", sourceAgentId: "sess-source-2" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; spawnedFrom: string | null }>();
    expect(created.spawnedFrom).toBe("sess-source-2");

    const getRes = await app.inject({ method: "GET", url: `/sessions/${created.id}` });
    expect(getRes.json<{ spawnedFrom: string | null }>().spawnedFrom).toBe("sess-source-2");
  });

  it("4a.T2 — POST /sessions omitting sourceAgentId still creates a session with spawnedFrom: null (regression)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ spawnedFrom: string | null }>().spawnedFrom).toBeNull();
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

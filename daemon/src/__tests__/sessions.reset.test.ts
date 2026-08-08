import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { SessionRecord } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) => pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    cleanupSessionDataDir: () => {},
    cleanupDirectSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) => pathJoin(tempDir, "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) => pathJoin(tempDir, "projects", p, "sessions", s),
  };
});

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {}),
    spawnDirectSession: vi.fn(async () => {}),
  };
});

vi.mock("../services/handoff.js", () => ({
  runHandoffTurn: vi.fn(async () => false),
  readHandoffFileOrNull: vi.fn(async () => null),
  readFreshHandoffFileOrNull: vi.fn(async () => null),
  HANDOFF_FRESHNESS_MS: 30_000,
}));

describe("POST /sessions/:id/reset", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;
  let mainSessionId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-reset-test-"));
    repoDir = join(tempDir, "repo");
    execSync(`mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m init`, {
      stdio: "ignore",
    });

    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([
        { id: "bug-fix", name: "Bug Fix", cli: "claude", context: "fix bugs", createdAt: new Date().toISOString() },
      ]),
    );
    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    app = await buildServer();

    const projRes = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    projectId = projRes.json<{ id: string }>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "reset-target", modeId: "bug-fix", prompt: "original task prompt" },
    });
    const wt = wtRes.json<{ id: string; mainSessionId: string }>();
    worktreeId = wt.id;
    mainSessionId = wt.mainSessionId;

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("4.T1 resetting a terminal session returns 400", async () => {
    const termRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "terminal" },
    });
    const termId = termRes.json<SessionRecord>().id;

    const res = await app.inject({ method: "POST", url: `/sessions/${termId}/reset`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("4.T2 resetting an already-archived session returns 400", async () => {
    const first = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(second.statusCode).toBe(400);
  });

  it("4.T3 reset with no args: new row's initialPrompt is undefined, name inherited, isMain/sortOrder inherited", async () => {
    const beforeRes = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    const before = beforeRes.json<{ name: string | null; isMain: boolean }>();

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; archivedSessionId: string; newSessionId: string }>();
    expect(body.archivedSessionId).toBe(mainSessionId);
    expect(body.newSessionId).not.toBe(mainSessionId);

    const newRes = await app.inject({ method: "GET", url: `/sessions/${body.newSessionId}` });
    expect(newRes.statusCode).toBe(200);
    const newSession = newRes.json<{ name: string | null; isMain: boolean; initialPrompt?: string }>();
    expect(newSession.name).toBe(before.name);
    expect(newSession.isMain).toBe(before.isMain);
    expect((newSession as { initialPrompt?: string }).initialPrompt).toBeUndefined();

    // Old session is archived.
    const oldRes = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    expect(oldRes.json<{ archivedAt: string | null }>().archivedAt).toBeTruthy();
  });

  it("4.T4 reset with { prompt } re-derives the name and sets initialPrompt to exactly the new prompt", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${mainSessionId}/reset`,
      payload: { prompt: "investigate the flaky test suite" },
    });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    const newRes = await app.inject({ method: "GET", url: `/sessions/${newSessionId}` });
    const newSession = newRes.json<{ name: string | null }>();
    expect(newSession.name).toBe("investigate-flaky-test");

    // The daemon route doesn't echo initialPrompt over the wire, so verify via
    // the store directly (original creation prompt must NEVER be resent).
    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const newRow = project.worktrees
      .find((w) => w.id === worktreeId)!
      .sessions.find((s) => s.id === newSessionId)!;
    expect(newRow.initialPrompt).toBe("investigate the flaky test suite");
  });

  it("4.T5 reset with { handoff: true } populates handoffSummary on the archived row and seeds the new row's initialPrompt", async () => {
    const handoffModule = await import("../services/handoff.js");
    vi.mocked(handoffModule.runHandoffTurn).mockResolvedValueOnce(true);
    vi.mocked(handoffModule.readHandoffFileOrNull).mockResolvedValueOnce("Handoff: finished the refactor, tests pending.");

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: { handoff: true } });
    expect(res.statusCode).toBe(200);
    const { archivedSessionId, newSessionId } = res.json<{ archivedSessionId: string; newSessionId: string }>();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const wt = project.worktrees.find((w) => w.id === worktreeId)!;
    const archived = wt.sessions.find((s) => s.id === archivedSessionId)!;
    expect(archived.handoffSummary).toBe("Handoff: finished the refactor, tests pending.");

    const newRow = wt.sessions.find((s) => s.id === newSessionId)!;
    expect(newRow.initialPrompt).toBe("Handoff: finished the refactor, tests pending.");
  });

  it("4.T6 a handoff timeout/failure still completes the reset with handoffSummary: null", async () => {
    const handoffModule = await import("../services/handoff.js");
    vi.mocked(handoffModule.runHandoffTurn).mockResolvedValueOnce(false); // simulated timeout

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: { handoff: true } });
    expect(res.statusCode).toBe(200);
    const { archivedSessionId } = res.json<{ archivedSessionId: string }>();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const archived = project.worktrees.find((w) => w.id === worktreeId)!.sessions.find((s) => s.id === archivedSessionId)!;
    // A timed-out/failed handoff never wrote a summary — the row's field is
    // absent (SQL NULL round-trips to `undefined`, same as "no handoff was
    // ever attempted"), not the literal string "null".
    expect(archived.handoffSummary).toBeFalsy();
  });

  it("Bug 6 fix — a fresh self-written HANDOFF.md is picked up WITHOUT the handoff flag and without running paste+poll", async () => {
    // Simulates the fixed `/vst reset --handoff` flow: the agent writes
    // .vibe-station/HANDOFF.md itself, then invokes `vst session reset`
    // WITHOUT --handoff. The daemon should opportunistically pick up that
    // fresh file and skip runHandoffTurn (paste+poll) entirely.
    const handoffModule = await import("../services/handoff.js");
    vi.mocked(handoffModule.readFreshHandoffFileOrNull).mockResolvedValueOnce(
      "Self-written handoff: refactor done, tests still red.",
    );

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    const { archivedSessionId, newSessionId } = res.json<{ archivedSessionId: string; newSessionId: string }>();

    expect(vi.mocked(handoffModule.runHandoffTurn)).not.toHaveBeenCalled();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const wt = project.worktrees.find((w) => w.id === worktreeId)!;
    const archived = wt.sessions.find((s) => s.id === archivedSessionId)!;
    expect(archived.handoffSummary).toBe("Self-written handoff: refactor done, tests still red.");
    const newRow = wt.sessions.find((s) => s.id === newSessionId)!;
    expect(newRow.initialPrompt).toBe("Self-written handoff: refactor done, tests still red.");
  });

  it("4.T7 the old session's tmux pane is actually released (releaseSessionRuntime called)", async () => {
    const tmux = await import("../services/tmux.js");
    const killSpy = vi.spyOn(tmux, "killSession");

    const sessRes = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    const tmuxName = sessRes.json<{ tmuxName: string }>().tmuxName;

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(killSpy).toHaveBeenCalledWith(tmuxName);
    killSpy.mockRestore();
  });

  it("4.T8 a mock WSConnection with an open stream on the old session id is detached and unregistered", async () => {
    const { registerConnection, unregisterConnection } = await import("../broadcaster.js");
    const { WSConnection } = await import("../ws/connection.js");

    const fakeWs = { readyState: 1, send: vi.fn(), bufferedAmount: 0 } as unknown as ConstructorParameters<
      typeof WSConnection
    >[0];
    const conn = new WSConnection(fakeWs);
    const detach = vi.fn(async () => {});
    const off = vi.fn();
    const fakeStream = { off, detach } as unknown as Parameters<typeof conn.registerOpenStream>[1]["stream"];
    conn.registerOpenStream(mainSessionId, {
      kind: "tmux",
      stream: fakeStream,
      subscriberId: "sub-1",
      onChunk: () => {},
    });
    registerConnection(conn);

    try {
      const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
      expect(res.statusCode).toBe(200);

      expect(off).toHaveBeenCalled();
      expect(detach).toHaveBeenCalledWith("sub-1");
      expect(conn.hasOpenStream(mainSessionId)).toBe(false);
    } finally {
      unregisterConnection(conn);
    }
  });

  it("Bug 3 fix — archiving clears the old row's isMain; GET /worktrees shows mainSessionId pointing at the NEW session", async () => {
    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    const oldRes = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    expect(oldRes.json<{ isMain: boolean }>().isMain).toBe(false);

    const newRes = await app.inject({ method: "GET", url: `/sessions/${newSessionId}` });
    expect(newRes.json<{ isMain: boolean }>().isMain).toBe(true);

    const wtRes = await app.inject({ method: "GET", url: `/worktrees?project=${projectId}` });
    const wt = wtRes.json<{ id: string; mainSessionId: string | null }[]>().find((w) => w.id === worktreeId)!;
    expect(wt.mainSessionId).toBe(newSessionId);
  });

  it("Bug 2 fix — spawnSession failure during reset is caught: no crash, new session ends up 'exited' not stuck", async () => {
    const spawnModule = await import("../services/spawn.js");
    vi.mocked(spawnModule.spawnSession).mockRejectedValueOnce(new Error("spawn boom"));

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    // Give the background (fire-and-forget) spawn job's rejection a tick to
    // land — it must be caught internally (runAgentSpawnJob's try/catch via
    // the shared spawnNewSessionForChannel helper), never surfaced as an
    // unhandled rejection that would crash the whole daemon process.
    await new Promise((r) => setTimeout(r, 100));

    const newRes = await app.inject({ method: "GET", url: `/sessions/${newSessionId}` });
    expect(newRes.json<{ state: string }>().state).toBe("exited");
  });

  it("Bug 2 fix — reset on a session whose mode was deleted returns 400 and does not archive/spawn", async () => {
    // Simulate the mode having been deleted after the session was created.
    await writeFile(join(tempDir, "modes.json"), JSON.stringify([]));
    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(400);

    // The original session must still be live (not silently archived with no replacement).
    const stillLive = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    expect(stillLive.json<{ archivedAt: string | null }>().archivedAt).toBeFalsy();
  });
});

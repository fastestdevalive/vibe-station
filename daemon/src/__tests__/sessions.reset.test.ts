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

// Mock tmux so no real tmux server is needed — without this, `POST /sessions
// {type: "terminal"}` in 4.T1 calls the route's own direct `newSession` call
// (routes/sessions.ts bypasses the mocked spawn.js for terminal sessions),
// leaking a real orphaned tmux session on every test run.
vi.mock("../services/tmux.js", () => {
  // `hasSession` defaults to `true` (a freshly spawned pane exists) so spawn's
  // own post-launch verification keeps passing, but tracks names `killSession`
  // has actually killed so `releaseSessionRuntime`'s post-kill verification
  // (sessionRuntime.ts) sees the correct `false` for THAT name instead of
  // spuriously warning "survived two kill-session attempts" on every reset.
  const killed = new Set<string>();
  return {
    newSession: vi.fn().mockResolvedValue(undefined),
    hasSession: vi.fn(async (name: string) => !killed.has(name)),
    killSession: vi.fn(async (name: string) => {
      killed.add(name);
    }),
    capturePane: vi.fn().mockResolvedValue(""),
    pasteBuffer: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    listSessionNames: vi.fn().mockResolvedValue(new Set()),
    listSessions: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../services/handoff.js", () => ({
  runHandoffTurn: vi.fn(async () => false),
  readHandoffFileOrNull: vi.fn(async () => null),
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
        // Second mode for reset-with-mode-switch tests — deliberately a
        // DIFFERENT `cli`, not just a different model, so 1.T4 actually
        // exercises the motivating scenario (switching CLIs on reset, e.g.
        // "agy main" -> "claude sonnet"), not just a same-CLI model change.
        {
          id: "plan-mode",
          name: "Plan Mode",
          cli: "cursor",
          model: "opus",
          context: "plan only",
          createdAt: new Date().toISOString(),
        },
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

  it("reset sets supersededBy on the archived row to the new session's id", async () => {
    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    const { archivedSessionId, newSessionId } = res.json<{ archivedSessionId: string; newSessionId: string }>();

    const getRes = await app.inject({ method: "GET", url: `/sessions/${archivedSessionId}` });
    expect(getRes.statusCode).toBe(200);
    const archived = getRes.json<{ supersededBy: string | null }>();
    expect(archived.supersededBy).toBe(newSessionId);
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

  it("1.T3 handoffText in the body is used directly (--handoff-file delivery), skipping runHandoffTurn entirely", async () => {
    // Simulates the `--handoff-file` flow: the CLI already read the agent's own
    // file locally and sends its contents directly as `handoffText` — no
    // `handoff` flag, no file lookup, no paste+poll.
    const handoffModule = await import("../services/handoff.js");
    const beforeRes = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    const before = beforeRes.json<{ name: string | null }>();

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${mainSessionId}/reset`,
      payload: { handoffText: "Self-written handoff: refactor done, tests still red." },
    });
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
    // Naming distinction (Decision 1): handoffText must never feed slugifyPrompt.
    expect(newRow.name).toBe(before.name);
  });

  it("1.T4 { handoffText, prompt } together: name derives from prompt only, initialPrompt joins both", async () => {
    const handoffModule = await import("../services/handoff.js");

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${mainSessionId}/reset`,
      payload: { handoffText: "Handoff: mid-refactor.", prompt: "also rename this" },
    });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    expect(vi.mocked(handoffModule.runHandoffTurn)).not.toHaveBeenCalled();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const newRow = project.worktrees.find((w) => w.id === worktreeId)!.sessions.find((s) => s.id === newSessionId)!;
    // "also" and "this" are stopwords (naming.ts) — only "rename" survives.
    expect(newRow.name).toBe("rename");
    expect(newRow.initialPrompt).toBe("Handoff: mid-refactor.\n\n---\n\nalso rename this");
  });

  // --- reset-with-mode-switch ---

  it("1.T1 reset with { modeId: <other id> }: new session's modeId is the requested one, not the old session's", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${mainSessionId}/reset`,
      payload: { modeId: "plan-mode" },
    });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const newRow = project.worktrees.find((w) => w.id === worktreeId)!.sessions.find((s) => s.id === newSessionId)!;
    expect(newRow.modeId).toBe("plan-mode");
  });

  it("1.T2 reset with { modeId: <name> } resolves by name, same as by id", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${mainSessionId}/reset`,
      payload: { modeId: "Plan Mode" },
    });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const newRow = project.worktrees.find((w) => w.id === worktreeId)!.sessions.find((s) => s.id === newSessionId)!;
    expect(newRow.modeId).toBe("plan-mode");
  });

  it("1.T3 reset with an unknown modeId returns 400 and does not archive the old session", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${mainSessionId}/reset`,
      payload: { modeId: "does-not-exist" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("does-not-exist");

    const stillLive = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    expect(stillLive.json<{ archivedAt: string | null }>().archivedAt).toBeFalsy();
  });

  it("1.T4 the spawned process uses the NEW mode's CLI plugin and model, not the outgoing session's", async () => {
    const spawnModule = await import("../services/spawn.js");
    vi.mocked(spawnModule.spawnSession).mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${mainSessionId}/reset`,
      payload: { modeId: "plan-mode" },
    });
    expect(res.statusCode).toBe(200);

    // Fire-and-forget spawn — give it a tick to land (same pattern as the
    // "Bug 2 fix — spawnSession failure" test above).
    await new Promise((r) => setTimeout(r, 100));

    // `mainSessionId`'s mode is "bug-fix" (cli: claude); "plan-mode" is a
    // genuinely different CLI (cursor) — asserting on `plugin.name` (not
    // just `model`) proves this exercises an actual CLI switch, the
    // motivating scenario for this feature, not just a same-CLI model change.
    expect(spawnModule.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "opus",
        plugin: expect.objectContaining({ name: "cursor" }),
      }),
    );
  });

  it("1.T5 reset with no modeId at all: mode unchanged, identical to pre-existing behavior", async () => {
    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const newRow = project.worktrees.find((w) => w.id === worktreeId)!.sessions.find((s) => s.id === newSessionId)!;
    expect(newRow.modeId).toBe("bug-fix");
  });

  it("1.T6 switching to a mode whose CLI does not support JSON downgrades channel json -> tmux", async () => {
    // Seed a json-channel session to reset. Direct sessions are simplest here
    // since they don't need a worktree main-session dance. Uses the REAL
    // jsonUnsupportedCli (claude genuinely supports json) so creation itself
    // isn't rejected by the same create-time gate.
    const directRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { target: "direct", projectId, type: "agent", modeId: "bug-fix", channel: "json" },
    });
    const directId = directRes.json<{ id: string }>().id;

    // No real CLI in this codebase currently lacks JSON support (all four
    // plugins return true from supportsJson()) — exercise the downgrade logic
    // itself by spying on jsonUnsupportedCli for just the reset call below,
    // the same seam the route calls.
    const modesModule = await import("../routes/modes.js");
    const unsupportedSpy = vi
      .spyOn(modesModule, "jsonUnsupportedCli")
      .mockResolvedValueOnce("claude");

    // Restore in `finally` — if the assertions below ever fail, the spy must
    // not leak into later tests in this file (vi.clearAllMocks() in
    // beforeEach clears mock state but does NOT restore a vi.spyOn override).
    let newSessionId: string;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/sessions/${directId}/reset`,
        payload: { modeId: "plan-mode" },
      });
      expect(res.statusCode).toBe(200);
      newSessionId = res.json<{ newSessionId: string }>().newSessionId;
    } finally {
      unsupportedSpy.mockRestore();
    }

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const newRow = project.directSessions.find((s) => s.id === newSessionId)!;
    expect(newRow.channel).toBe("tmux");
    expect(newRow.useTmux).toBe(true);
  });

  it("1.T7 switching to a mode whose CLI DOES support JSON keeps channel json (regression)", async () => {
    const directRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { target: "direct", projectId, type: "agent", modeId: "bug-fix", channel: "json" },
    });
    const directId = directRes.json<{ id: string }>().id;

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${directId}/reset`,
      payload: { modeId: "plan-mode" },
    });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    const { getProject } = await import("../state/project-store.js");
    const project = getProject(projectId)!;
    const newRow = project.directSessions.find((s) => s.id === newSessionId)!;
    expect(newRow.channel).toBe("json");
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

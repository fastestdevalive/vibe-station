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

vi.mock("../services/handoff.js", () => ({
  runHandoffTurn: vi.fn(async () => false),
  readHandoffFileOrNull: vi.fn(async () => null),
}));

describe("POST /sessions/:id/handoff", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;
  let mainSessionId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-handoff-route-test-"));
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
      payload: { projectId, branch: "handoff-target", modeId: "bug-fix", prompt: "original task prompt" },
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

  it("1.T3 handoff on a terminal session returns 400", async () => {
    const termRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "terminal" },
    });
    const termId = termRes.json<SessionRecord>().id;

    const res = await app.inject({ method: "POST", url: `/sessions/${termId}/handoff`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("1.T3 handoff on a nonexistent session id returns 404", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions/does-not-exist/handoff", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("1.T3 handoff on a valid agent session returns 200 with the handoff summary, without archiving or respawning", async () => {
    const handoffModule = await import("../services/handoff.js");
    vi.mocked(handoffModule.runHandoffTurn).mockResolvedValueOnce(true);
    vi.mocked(handoffModule.readHandoffFileOrNull).mockResolvedValueOnce("Handoff: mid-refactor, tests pending.");

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/handoff`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, handoffSummary: "Handoff: mid-refactor, tests pending." });

    // Write-only: the session must still be live, unarchived, and unchanged.
    const sessRes = await app.inject({ method: "GET", url: `/sessions/${mainSessionId}` });
    expect(sessRes.statusCode).toBe(200);
    const sess = sessRes.json<{ archivedAt: string | null; id: string }>();
    expect(sess.archivedAt).toBeFalsy();
    expect(sess.id).toBe(mainSessionId);
  });

  it("1.T3 a failed/timed-out handoff returns 200 with handoffSummary: null", async () => {
    const handoffModule = await import("../services/handoff.js");
    vi.mocked(handoffModule.runHandoffTurn).mockResolvedValueOnce(false);

    const res = await app.inject({ method: "POST", url: `/sessions/${mainSessionId}/handoff`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, handoffSummary: null });
  });
});

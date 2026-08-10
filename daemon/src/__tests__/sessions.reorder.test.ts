import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

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

// Mock tmux so no real tmux server is needed — without this, the "works for a
// direct (worktree-less) session too" test's `POST /sessions
// {type: "terminal"}` calls the route's own direct `newSession` call
// (routes/sessions.ts bypasses the mocked spawn.js for terminal sessions),
// leaking a real orphaned tmux session on every test run.
vi.mock("../services/tmux.js", () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  hasSession: vi.fn().mockResolvedValue(true),
  killSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  listSessionNames: vi.fn().mockResolvedValue(new Set()),
  listSessions: vi.fn().mockResolvedValue([]),
}));

describe("PATCH /sessions/:id/reorder", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;
  let mainSessionId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-session-reorder-test-"));
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
      payload: { projectId, branch: "reorder-target", modeId: "bug-fix" },
    });
    const wt = wtRes.json<{ id: string; mainSessionId: string }>();
    worktreeId = wt.id;
    mainSessionId = wt.mainSessionId;
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T2 rejects a non-finite sortOrder (NaN via bad JSON is unreachable; Infinity is rejected)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${mainSessionId}/reorder`,
      payload: { sortOrder: Infinity },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing sortOrder", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${mainSessionId}/reorder`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown session id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/does-not-exist/reorder`,
      payload: { sortOrder: 5 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("1.T3 persists the new sortOrder — GET /sessions shows it after the PATCH", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${mainSessionId}/reorder`,
      payload: { sortOrder: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; sortOrder: number }>().sortOrder).toBe(5);

    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const list = listRes.json<Array<{ id: string; sortOrder: number }>>();
    const updated = list.find((s) => s.id === mainSessionId);
    expect(updated?.sortOrder).toBe(5);
  });

  it("1.T1 GET /sessions includes sortOrder/nameSource/handoffSummary on every row", async () => {
    const listRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const list = listRes.json<
      Array<{ sortOrder: number; nameSource: string | null; handoffSummary: string | null }>
    >();
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(typeof s.sortOrder).toBe("number");
      expect(s).toHaveProperty("nameSource");
      expect(s).toHaveProperty("handoffSummary");
    }
  });

  it("works for a direct (worktree-less) session too", async () => {
    const directRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { target: "direct", projectId, type: "terminal" },
    });
    const directId = directRes.json<{ id: string }>().id;

    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${directId}/reorder`,
      payload: { sortOrder: -3.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ sortOrder: number }>().sortOrder).toBe(-3.5);
  });
});

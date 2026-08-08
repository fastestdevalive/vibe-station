import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord } from "../types.js";
import * as broadcasterNs from "../broadcaster.js";

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
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(tempDir, "projects", p, "session-data", w, s),
  };
});

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {
      // Mock: do nothing
    }),
  };
});

vi.mock("../broadcaster.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../broadcaster.js")>();
  return {
    ...original,
    broadcastAll: vi.fn(),
  };
});

describe("PATCH /worktrees/:id/reorder", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-wt-reorder-test-"));
    repoDir = join(tempDir, "my-repo");

    execSync(
      `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`,
      { stdio: "ignore" },
    );

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([
        {
          id: "bug-fix",
          name: "Bug Fix",
          cli: "claude",
          context: "You are a bug fix expert",
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const promptBuilderModule = await import("../services/promptBuilder.js");
    promptBuilderModule._resetSkillCacheForTest();

    app = await buildServer();

    const projRes = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    projectId = projRes.json<ProjectRecord>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "reorder-target", modeId: "bug-fix" },
    });
    worktreeId = wtRes.json<{ id: string }>().id;
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 150));
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T2 rejects a non-finite sortOrder", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/worktrees/${worktreeId}/reorder`,
      payload: { sortOrder: Infinity },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing sortOrder", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/worktrees/${worktreeId}/reorder`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown worktree id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/worktrees/does-not-exist/reorder`,
      payload: { sortOrder: 5 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("1.T3 persists the new sortOrder — GET /worktrees shows it after the PATCH", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/worktrees/${worktreeId}/reorder`,
      payload: { sortOrder: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; sortOrder: number }>().sortOrder).toBe(5);

    const listRes = await app.inject({ method: "GET", url: `/worktrees?project=${projectId}` });
    const list = listRes.json<Array<{ id: string; sortOrder: number }>>();
    const updated = list.find((w) => w.id === worktreeId);
    expect(updated?.sortOrder).toBe(5);
  });

  it("1.T1 GET /worktrees includes sortOrder on every row", async () => {
    const listRes = await app.inject({ method: "GET", url: `/worktrees?project=${projectId}` });
    const list = listRes.json<Array<{ sortOrder: number }>>();
    expect(list.length).toBeGreaterThan(0);
    for (const w of list) {
      expect(typeof w.sortOrder).toBe("number");
    }
  });

  // Regression: the reorder endpoint used to broadcast a `{ id, sortOrder }`
  // sliver over `worktree:updated`. The client's `applyWorktreeUpdated` does
  // a full-object replace (not a merge, unlike sessions), so that sliver
  // wiped every other field — including `projectId` — off the client's copy,
  // which made the dragged worktree vanish from its project's list in the
  // sidebar (it still grouped by `w.projectId`, now `undefined`). The fix:
  // broadcast the fully serialized worktree, same as pin/unpin already does.
  it("broadcasts the FULL worktree over worktree:updated, not a { id, sortOrder } sliver", async () => {
    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    broadcastAll.mockClear();

    const res = await app.inject({
      method: "PATCH",
      url: `/worktrees/${worktreeId}/reorder`,
      payload: { sortOrder: 7 },
    });
    expect(res.statusCode).toBe(200);

    const updatedCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === "worktree:updated",
    );
    expect(updatedCall).toBeDefined();
    const broadcastWorktree = (updatedCall![0] as { worktree: Record<string, unknown> }).worktree;
    expect(broadcastWorktree.id).toBe(worktreeId);
    expect(broadcastWorktree.sortOrder).toBe(7);
    // The fields a partial payload would have dropped:
    expect(broadcastWorktree.projectId).toBe(projectId);
    expect(broadcastWorktree.branch).toBe("reorder-target");
  });
});

describe("PATCH /worktrees/:id/rename — broadcast shape", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-wt-rename-test-"));
    repoDir = join(tempDir, "my-repo");

    execSync(
      `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`,
      { stdio: "ignore" },
    );

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([
        {
          id: "bug-fix",
          name: "Bug Fix",
          cli: "claude",
          context: "You are a bug fix expert",
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const promptBuilderModule = await import("../services/promptBuilder.js");
    promptBuilderModule._resetSkillCacheForTest();

    app = await buildServer();

    const projRes = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    projectId = projRes.json<ProjectRecord>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "rename-target", modeId: "bug-fix" },
    });
    worktreeId = wtRes.json<{ id: string }>().id;
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 150));
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // Same root cause as the reorder regression above — /rename had the
  // identical partial-broadcast bug.
  it("broadcasts the FULL worktree over worktree:updated, not a { id, name } sliver", async () => {
    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    broadcastAll.mockClear();

    const res = await app.inject({
      method: "PATCH",
      url: `/worktrees/${worktreeId}/rename`,
      payload: { name: "my custom name" },
    });
    expect(res.statusCode).toBe(200);

    const updatedCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === "worktree:updated",
    );
    expect(updatedCall).toBeDefined();
    const broadcastWorktree = (updatedCall![0] as { worktree: Record<string, unknown> }).worktree;
    expect(broadcastWorktree.id).toBe(worktreeId);
    expect(broadcastWorktree.name).toBe("my custom name");
    expect(broadcastWorktree.projectId).toBe(projectId);
    expect(broadcastWorktree.branch).toBe("rename-target");
  });
});

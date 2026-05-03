import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, WorktreeRecord } from "../types.js";

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

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {
      // Mock: do nothing
    }),
  };
});

describe("Worktree routes", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-wt-test-"));
    repoDir = join(tempDir, "my-repo");

    execSync(
      `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`,
      { stdio: "ignore" },
    );

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    // Create modes.json with a test mode
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

    // Reset modes cache and skill cache
    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const promptBuilderModule = await import("../services/promptBuilder.js");
    promptBuilderModule._resetSkillCacheForTest();

    app = await buildServer();

    // Create a project to work with
    const projRes = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    projectId = projRes.json<ProjectRecord>().id;
  });

  afterEach(async () => {
    // Drain any in-flight fire-and-forget runMainSpawnJob calls before we
    // tear down — otherwise their delayed mutateProject hits a cleared store
    // in the next test's beforeEach and surfaces as an unhandled rejection.
    await new Promise((r) => setTimeout(r, 150));
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("GET /worktrees?project=:id returns empty array initially", async () => {
    const res = await app.inject({ method: "GET", url: `/worktrees?project=${projectId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("POST /worktrees creates a worktree and main session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "fix-test-bug", modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ id: string; branch: string; baseSha: string }>();
    expect(wt.branch).toBe("fix-test-bug");
    expect(wt.id).toMatch(/^[a-z]+-\d+$/);
    expect(wt.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("GET changed-paths scope=local lists staged file", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "chg-local-scope", modeId: "bug-fix" },
    });
    expect(createRes.statusCode).toBe(201);
    const wt = createRes.json<{ id: string }>();
    const wtPath = join(tempDir, "projects", projectId, "worktrees", wt.id);
    await writeFile(join(wtPath, "tracked.txt"), "v1\n");
    execSync(`git -C "${wtPath}" add tracked.txt`, { stdio: "ignore" });

    const res = await app.inject({
      method: "GET",
      url: `/worktrees/${wt.id}/changed-paths?scope=local`,
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json<Array<{ path: string; status: string }>>();
    expect(entries.some((e) => e.path === "tracked.txt")).toBe(true);
  });

  it("GET changed-paths scope=branch lists commit-only paths vs fork base", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "chg-branch-scope", modeId: "bug-fix" },
    });
    expect(createRes.statusCode).toBe(201);
    const wt = createRes.json<{ id: string }>();
    const wtPath = join(tempDir, "projects", projectId, "worktrees", wt.id);
    await writeFile(join(wtPath, "branch-only.txt"), "hi\n");
    execSync(
      `git -C "${wtPath}" add branch-only.txt && git -C "${wtPath}" commit -m "branch-only"`,
      { stdio: "ignore" },
    );

    const res = await app.inject({
      method: "GET",
      url: `/worktrees/${wt.id}/changed-paths?scope=branch`,
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json<Array<{ path: string; status: string }>>();
    expect(entries.some((e) => e.path === "branch-only.txt")).toBe(true);
  });

  it("GET diff scope=local returns unified patch text", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "diff-local-scope", modeId: "bug-fix" },
    });
    expect(createRes.statusCode).toBe(201);
    const wt = createRes.json<{ id: string }>();
    const wtPath = join(tempDir, "projects", projectId, "worktrees", wt.id);
    await writeFile(join(wtPath, "t.md"), "# x\n");
    execSync(`git -C "${wtPath}" add t.md && git -C "${wtPath}" commit -m add-md`, {
      stdio: "ignore",
    });
    await writeFile(join(wtPath, "t.md"), "# x\n\nline\n");

    const res = await app.inject({
      method: "GET",
      url: `/worktrees/${wt.id}/diff/t.md?scope=local`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("@@");
    expect(res.body).toContain("+");
  });

  it("POST /worktrees 400 on invalid branch name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "..invalid", modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /worktrees 409 on existing branch", async () => {
    // Create worktree with 'fix-test-dup' branch
    await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "fix-test-dup", modeId: "bug-fix" },
    });
    // Try to create another worktree with the same branch
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "fix-test-dup", modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /worktrees 404 for unknown project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId: "nonexistent", branch: "test-branch", modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /worktrees/:id removes worktree", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "to-delete", modeId: "bug-fix" },
    });
    const wt = createRes.json<WorktreeRecord>();

    const delRes = await app.inject({ method: "DELETE", url: `/worktrees/${wt.id}` });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);

    const listRes = await app.inject({ method: "GET", url: `/worktrees?project=${projectId}` });
    expect(listRes.json<WorktreeRecord[]>()).toHaveLength(0);
  });

  it("DELETE /worktrees/:id 404 for unknown worktree", async () => {
    const res = await app.inject({ method: "DELETE", url: "/worktrees/wt-nonexistent-99" });
    expect(res.statusCode).toBe(404);
  });

  it("baseBranch defaults to project defaultBranch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "feat-no-base", modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<WorktreeRecord>();
    // Should use the project's detected default branch
    const project = (
      await app.inject({ method: "GET", url: "/projects" })
    ).json<ProjectRecord[]>()[0];
    expect(wt.baseBranch).toBe(project?.defaultBranch);
  });

  it("POST /worktrees returns 201 before slow spawn resolves (optimistic broadcasts)", async () => {
    const broadcast = await import("../broadcaster.js");
    const spy = vi.spyOn(broadcast, "broadcastAll");
    const spawnModule = await import("../services/spawn.js");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(spawnModule.spawnSession).mockImplementationOnce(() => gate);

    const injectPromise = app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: `opt-${Date.now()}`, modeId: "bug-fix" },
    });

    const res = await Promise.race([
      injectPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("response slower than 800ms")), 800),
      ),
    ]);

    expect(res.statusCode).toBe(201);

    const calls = spy.mock.calls.map((c) => (c[0] as { type?: string })?.type);
    expect(calls).toContain("worktree:created");
    expect(calls).toContain("session:created");

    release();
    await injectPromise;

    // Wait for runMainSpawnJob to settle so it doesn't leak a mutateProject
    // call into the next test's cleared store.
    const wt = (res as { json: <T>() => T }).json<{ id: string }>();
    const expectedSessionId = `${wt.id}-m`;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const found = spy.mock.calls
        .map((c) => c[0] as { type: string; sessionId?: string; state?: string })
        .find((m) => m.type === "session:state" && m.sessionId === expectedSessionId);
      if (found) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    spy.mockRestore();
    vi.mocked(spawnModule.spawnSession).mockResolvedValue(undefined);
  });

  it("broadcasts session:state=working after spawn completes", async () => {
    const broadcast = await import("../broadcaster.js");
    const spy = vi.spyOn(broadcast, "broadcastAll");
    const spawnModule = await import("../services/spawn.js");
    vi.mocked(spawnModule.spawnSession).mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: `working-${Date.now()}`, modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ id: string }>();

    // runMainSpawnJob is fire-and-forget; poll the spy until the expected
    // broadcast arrives or we time out.
    const expectedSessionId = `${wt.id}-m`;
    const deadline = Date.now() + 2000;
    let working: { type: string; sessionId?: string; state?: string } | undefined;
    while (Date.now() < deadline) {
      working = spy.mock.calls
        .map((c) => c[0] as { type: string; sessionId?: string; state?: string })
        .find((m) => m.type === "session:state" && m.state === "working" && m.sessionId === expectedSessionId);
      if (working) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(working).toBeDefined();
    spy.mockRestore();
  });

  it("spawn failure broadcasts session:state=exited with reason; worktree remains on disk", async () => {
    const { stat } = await import("node:fs/promises");
    const broadcast = await import("../broadcaster.js");
    const spy = vi.spyOn(broadcast, "broadcastAll");
    const spawnModule = await import("../services/spawn.js");
    vi.mocked(spawnModule.spawnSession).mockRejectedValueOnce(new Error("boom"));

    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: `failure-${Date.now()}`, modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ id: string }>();
    const expectedSessionId = `${wt.id}-m`;

    const deadline = Date.now() + 2000;
    let exited: { type: string; sessionId?: string; state?: string; reason?: string } | undefined;
    while (Date.now() < deadline) {
      exited = spy.mock.calls
        .map((c) => c[0] as { type: string; sessionId?: string; state?: string; reason?: string })
        .find((m) => m.type === "session:state" && m.state === "exited" && m.sessionId === expectedSessionId);
      if (exited) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(exited).toBeDefined();
    expect(exited?.reason).toContain("boom");

    // Worktree directory should still exist on disk.
    const wtPath = join(tempDir, "projects", projectId, "worktrees", wt.id);
    const st = await stat(wtPath);
    expect(st.isDirectory()).toBe(true);

    spy.mockRestore();
    vi.mocked(spawnModule.spawnSession).mockResolvedValue(undefined);
  });
});

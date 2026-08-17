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

describe("Worktree routes", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-wt-test-"));
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

  /** Shared worktree-creation helper — `prefix` namespaces the branch name per describe block. */
  async function createWorktree(prefix: string, branchSuffix: string) {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: `${prefix}-${branchSuffix}-${Date.now()}`, modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; pinnedAt: string | null }>();
  }

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

  it("4a.T1 — POST /worktrees with sourceAgentId persists it as spawnedFrom on the main session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: {
        projectId,
        branch: "spawned-from-test",
        modeId: "bug-fix",
        sourceAgentId: "sess-source-agent-1",
      },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ mainSessionId: string }>();

    const sessRes = await app.inject({ method: "GET", url: `/sessions/${wt.mainSessionId}` });
    expect(sessRes.statusCode).toBe(200);
    expect(sessRes.json<{ spawnedFrom: string | null }>().spawnedFrom).toBe("sess-source-agent-1");
  });

  it("4a.T2 — POST /worktrees omitting sourceAgentId creates a session with spawnedFrom: null (regression)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "no-source-agent-test", modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ mainSessionId: string }>();

    const sessRes = await app.inject({ method: "GET", url: `/sessions/${wt.mainSessionId}` });
    expect(sessRes.json<{ spawnedFrom: string | null }>().spawnedFrom).toBeNull();
  });

  it("3.T5 — POST /worktrees {prompt} (no name) derives the same slug for both worktree.name and the main session's name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: {
        projectId,
        branch: "naming-heuristic",
        modeId: "bug-fix",
        prompt: "Implement the login flow described in SPEC.md",
      },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ id: string; name: string | null; mainSessionId: string }>();
    expect(wt.name).toBe("implement-login-flow");

    const sessRes = await app.inject({ method: "GET", url: `/sessions/${wt.mainSessionId}` });
    expect(sessRes.statusCode).toBe(200);
    expect(sessRes.json<{ name: string | null }>().name).toBe("implement-login-flow");
  });

  // ── Branch-name-optional (F1 revisit) — resolution order ─────────────────

  it("branch-optional: explicit branch wins even when a prompt is also given", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: {
        projectId,
        branch: "explicit-branch-name",
        modeId: "bug-fix",
        prompt: "Implement the login flow described in SPEC.md",
      },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ branch: string; branchIsPlaceholder?: boolean }>();
    expect(wt.branch).toBe("explicit-branch-name");
    expect(wt.branchIsPlaceholder).toBeFalsy();
  });

  it("branch-optional: omitted branch + prompt derives the slug via slugifyPrompt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: {
        projectId,
        modeId: "bug-fix",
        prompt: "Implement the login flow described in SPEC.md",
      },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ branch: string; branchIsPlaceholder?: boolean }>();
    expect(wt.branch).toBe("implement-login-flow");
    expect(wt.branchIsPlaceholder).toBeFalsy();
  });

  it("branch-optional: omitted branch + a colliding prompt-derived slug falls back to a numbered variant", async () => {
    // Pre-create a branch matching the exact slug "Test the widget flow end to end" derives.
    const first = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "test-widget-flow", modeId: "bug-fix" },
    });
    expect(first.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, modeId: "bug-fix", prompt: "Test the widget flow end to end" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ branch: string; branchIsPlaceholder?: boolean }>();
    expect(wt.branch).toBe("test-widget-flow-2");
    expect(wt.branchIsPlaceholder).toBeFalsy();
  });

  it("branch-optional: omitted branch + no prompt auto-generates a wip/<wtId> placeholder", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ id: string; branch: string; branchIsPlaceholder?: boolean }>();
    expect(wt.branch).toBe(`wip/${wt.id}`);
    expect(wt.branchIsPlaceholder).toBe(true);
  });

  it("branch-optional: an empty-string branch is treated as omitted (not a validation error)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "", modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ id: string; branch: string; branchIsPlaceholder?: boolean }>();
    expect(wt.branch).toBe(`wip/${wt.id}`);
    expect(wt.branchIsPlaceholder).toBe(true);
  });

  it("JSON gate — POST /worktrees channel:json with a claude (supported) mode → 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "json-claude", modeId: "bug-fix", channel: "json" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("skipAutoTurn — channel:json + prompt derives name/initialPrompt but does NOT auto-enqueue turn 1", async () => {
    const jsonAgentChat = await import("../services/jsonAgentChat.js");
    const startJsonCreateTurnMock = vi.mocked(jsonAgentChat.startJsonCreateTurn);
    startJsonCreateTurnMock.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: {
        projectId,
        modeId: "bug-fix",
        channel: "json",
        prompt: "Implement the login flow described in SPEC.md",
        skipAutoTurn: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ name: string | null; mainSessionId: string }>();
    // Naming/initialPrompt derive from `prompt` exactly like the non-JSON path...
    expect(wt.name).toBe("implement-login-flow");
    const sessRes = await app.inject({ method: "GET", url: `/sessions/${wt.mainSessionId}` });
    expect(sessRes.json<{ name: string | null; nameSource: string | null }>()).toMatchObject({
      name: "implement-login-flow",
      nameSource: "auto",
    });
    // ...but turn 1 is never auto-enqueued — the caller is responsible for
    // sending it itself once attachments are uploaded (sendJsonFirstTurn).
    // A regression here would double-send the user's first message.
    expect(startJsonCreateTurnMock).not.toHaveBeenCalled();
  });

  it("skipAutoTurn omitted — channel:json + prompt DOES auto-enqueue turn 1 (unchanged default)", async () => {
    const jsonAgentChat = await import("../services/jsonAgentChat.js");
    const startJsonCreateTurnMock = vi.mocked(jsonAgentChat.startJsonCreateTurn);
    startJsonCreateTurnMock.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: {
        projectId,
        modeId: "bug-fix",
        channel: "json",
        prompt: "Implement the login flow described in SPEC.md",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(startJsonCreateTurnMock).toHaveBeenCalledTimes(1);
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

  it("GET /worktrees/:id/file-list returns flat list of files", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "file-list-basic", modeId: "bug-fix" },
    });
    expect(createRes.statusCode).toBe(201);
    const wt = createRes.json<{ id: string }>();
    const wtPath = join(tempDir, "projects", projectId, "worktrees", wt.id);
    await writeFile(join(wtPath, "alpha.txt"), "1\n");
    await writeFile(join(wtPath, "beta.txt"), "2\n");
    execSync(`mkdir -p "${wtPath}/sub" && echo c > "${wtPath}/sub/gamma.txt"`, { stdio: "ignore" });

    const res = await app.inject({
      method: "GET",
      url: `/worktrees/${wt.id}/file-list`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ files: string[]; truncated: boolean; source: string }>();
    expect(body.files).toEqual(expect.arrayContaining(["alpha.txt", "beta.txt", "sub/gamma.txt"]));
    expect(body.truncated).toBe(false);
    expect(["ripgrep", "node"]).toContain(body.source);
    // .git/ must be excluded.
    expect(body.files.some((f) => f.startsWith(".git/"))).toBe(false);
  });

  it("GET /worktrees/:id/file-list respects .gitignore", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "file-list-ignore", modeId: "bug-fix" },
    });
    expect(createRes.statusCode).toBe(201);
    const wt = createRes.json<{ id: string }>();
    const wtPath = join(tempDir, "projects", projectId, "worktrees", wt.id);
    await writeFile(join(wtPath, ".gitignore"), "ignored.txt\nsecret/\n");
    await writeFile(join(wtPath, "kept.txt"), "k\n");
    await writeFile(join(wtPath, "ignored.txt"), "i\n");
    execSync(`mkdir -p "${wtPath}/secret" && echo s > "${wtPath}/secret/x.txt"`, {
      stdio: "ignore",
    });

    const res = await app.inject({
      method: "GET",
      url: `/worktrees/${wt.id}/file-list`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ files: string[] }>();
    expect(body.files).toContain("kept.txt");
    expect(body.files).toContain(".gitignore");
    expect(body.files).not.toContain("ignored.txt");
    expect(body.files.some((f) => f.startsWith("secret/"))).toBe(false);
  });

  it("GET /worktrees/:id/file-list 404 for unknown worktree", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/worktrees/does-not-exist/file-list`,
    });
    expect(res.statusCode).toBe(404);
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
    const wt = (res as { json: <T>() => T }).json<{ id: string; mainSessionId: string }>();
    const expectedSessionId = wt.mainSessionId;
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
    const wt = res.json<{ id: string; mainSessionId: string }>();

    // runMainSpawnJob is fire-and-forget; poll the spy until the expected
    // broadcast arrives or we time out.
    const expectedSessionId = wt.mainSessionId;
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
    const wt = res.json<{ id: string; mainSessionId: string }>();
    const expectedSessionId = wt.mainSessionId;

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

  it("POST /worktrees/:id/done marks agent sessions as done and kills their panes", async () => {
    const tmux = await import("../services/tmux.js");
    const killSpy = vi.spyOn(tmux, "killSession"); // calls through: really kills the pane
    const res = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: `mark-done-${Date.now()}`, modeId: "bug-fix" },
    });
    expect(res.statusCode).toBe(201);
    const wt = res.json<{ id: string; mainSessionId: string }>();

    const doneRes = await app.inject({
      method: "POST",
      url: `/worktrees/${wt.id}/done`,
    });
    expect(doneRes.statusCode).toBe(200);
    const body = doneRes.json<{ ok: boolean; updated: number; terminalsReleased: number }>();
    expect(body.ok).toBe(true);
    expect(body.updated).toBeGreaterThanOrEqual(1);

    const sessRes = await app.inject({
      method: "GET",
      url: `/sessions/${wt.mainSessionId}`,
    });
    expect(sessRes.statusCode).toBe(200);
    const main = sessRes.json<{ state: string; tmuxName: string }>();
    expect(main.state).toBe("done");
    // The whole point of the feature: the pane is actually gone.
    expect(killSpy).toHaveBeenCalledWith(main.tmuxName);
    killSpy.mockRestore();
  });

  it("2.T4 — POST /worktrees/:id/done also releases terminals (marked exited)", async () => {
    const tmux = await import("../services/tmux.js");
    const killSpy = vi.spyOn(tmux, "killSession"); // calls through: really kills the pane
    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: `done-term-${Date.now()}`, modeId: "bug-fix" },
    });
    const wt = wtRes.json<{ id: string }>();

    const termRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId: wt.id, type: "terminal" },
    });
    expect(termRes.statusCode).toBe(201);
    const term = termRes.json<{ id: string; tmuxName: string }>();

    const doneRes = await app.inject({ method: "POST", url: `/worktrees/${wt.id}/done` });
    const body = doneRes.json<{ updated: number; terminalsReleased: number }>();
    expect(body.terminalsReleased).toBe(1);

    const after = await app.inject({ method: "GET", url: `/sessions/${term.id}` });
    // Terminals have no `done` state of their own — they retire as `exited`,
    // which is also what the UI's Resume banner keys off.
    expect(after.json<{ state: string }>().state).toBe("exited");
    expect(killSpy).toHaveBeenCalledWith(term.tmuxName);
    killSpy.mockRestore();
  });

  it("2.T5 — POST /worktrees/:id/done is idempotent (second call updates nothing)", async () => {
    const tmux = await import("../services/tmux.js");
    const killSpy = vi.spyOn(tmux, "killSession"); // calls through: really kills the pane
    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: `done-idem-${Date.now()}`, modeId: "bug-fix" },
    });
    const wt = wtRes.json<{ id: string }>();

    const first = await app.inject({ method: "POST", url: `/worktrees/${wt.id}/done` });
    expect(first.json<{ updated: number }>().updated).toBeGreaterThanOrEqual(1);

    killSpy.mockClear();
    const second = await app.inject({ method: "POST", url: `/worktrees/${wt.id}/done` });
    expect(second.statusCode).toBe(200);
    const body = second.json<{ updated: number; terminalsReleased: number }>();
    expect(body.updated).toBe(0);
    expect(body.terminalsReleased).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  // ─── PATCH /worktrees/:id/pin ───────────────────────────────────────────
  describe("PATCH /worktrees/:id/pin", () => {
    it("serializes pinnedAt as null for an unpinned worktree", async () => {
      const wt = await createWorktree("pin", "unpinned");
      expect(wt.pinnedAt).toBeNull();
    });

    it("PATCH { pinned: true } sets pinnedAt to an ISO timestamp", async () => {
      const wt = await createWorktree("pin", "set");
      const res = await app.inject({
        method: "PATCH",
        url: `/worktrees/${wt.id}/pin`,
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; worktree: { id: string; pinnedAt: string | null } }>();
      expect(body.ok).toBe(true);
      expect(body.worktree.id).toBe(wt.id);
      expect(body.worktree.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("PATCH { pinned: false } clears pinnedAt", async () => {
      const wt = await createWorktree("pin", "clear");
      await app.inject({ method: "PATCH", url: `/worktrees/${wt.id}/pin`, payload: { pinned: true } });
      const res = await app.inject({
        method: "PATCH",
        url: `/worktrees/${wt.id}/pin`,
        payload: { pinned: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ worktree: { pinnedAt: string | null } }>().worktree.pinnedAt).toBeNull();
    });

    it("is idempotent: pinning twice keeps the original timestamp", async () => {
      const wt = await createWorktree("pin", "idempotent");
      const first = await app.inject({
        method: "PATCH",
        url: `/worktrees/${wt.id}/pin`,
        payload: { pinned: true },
      });
      const ts1 = first.json<{ worktree: { pinnedAt: string } }>().worktree.pinnedAt;
      // Wait so a re-stamp would be observable.
      await new Promise((r) => setTimeout(r, 10));
      const second = await app.inject({
        method: "PATCH",
        url: `/worktrees/${wt.id}/pin`,
        payload: { pinned: true },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json<{ worktree: { pinnedAt: string } }>().worktree.pinnedAt).toBe(ts1);
    });

    it("returns 404 for an unknown worktree id", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/worktrees/does-not-exist/pin",
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for an invalid body", async () => {
      const wt = await createWorktree("pin", "badbody");
      const res = await app.inject({
        method: "PATCH",
        url: `/worktrees/${wt.id}/pin`,
        payload: { pinned: "yes" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 (not 500) when the worktree is deleted concurrently with the PATCH", async () => {
      // Simulates the TOCTOU window between the outer find and the lock by
      // monkey-patching mutateProject to delete the worktree just before our
      // mutator runs. Without the in-lock re-check, the non-null assertion
      // in the route would throw and Fastify would reply 500.
      const wt = await createWorktree("pin", "toctou");
      const store = await import("../state/project-store.js");
      const orig = store.mutateProject;
      const spy = vi.spyOn(store, "mutateProject").mockImplementation(async (id, fn) => {
        return orig(id, (p) => {
          // Drop the worktree under the lock right before the route's mutator
          // is invoked, mimicking a racing DELETE that wins the lock first.
          const stripped = { ...p, worktrees: p.worktrees.filter((w) => w.id !== wt.id) };
          return fn(stripped);
        });
      });
      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/worktrees/${wt.id}/pin`,
          payload: { pinned: true },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        spy.mockRestore();
      }
    });

    it("GET /worktrees response includes pinnedAt for every record", async () => {
      const wt = await createWorktree("pin", "listshape");
      await app.inject({
        method: "PATCH",
        url: `/worktrees/${wt.id}/pin`,
        payload: { pinned: true },
      });
      const res = await app.inject({ method: "GET", url: "/worktrees" });
      expect(res.statusCode).toBe(200);
      const items = res.json<Array<{ id: string; pinnedAt: string | null }>>();
      for (const w of items) {
        expect(w).toHaveProperty("pinnedAt");
      }
      const pinned = items.find((w) => w.id === wt.id);
      expect(pinned?.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ─── GET /worktrees/:id/commits and /pr ─────────────────────────────────
  describe("GET /worktrees/:id/commits and /pr", () => {
    it("Requirement 9 — GET /worktrees/:id/commits 404s for an unknown worktree", async () => {
      const res = await app.inject({ method: "GET", url: "/worktrees/does-not-exist/commits" });
      expect(res.statusCode).toBe(404);
    });

    it("Requirement 10 — GET /worktrees/:id/pr 404s for an unknown worktree", async () => {
      const res = await app.inject({ method: "GET", url: "/worktrees/does-not-exist/pr" });
      expect(res.statusCode).toBe(404);
    });

    it("Requirement 10 — GET /worktrees/:id/pr returns {kind:\"not_github\"} when the project repo has no origin remote", async () => {
      const wt = await createWorktree("vcs", "no-remote");
      const res = await app.inject({ method: "GET", url: `/worktrees/${wt.id}/pr` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kind: "not_github" });
    });

    it("GET /worktrees/:id/pr wires owner/repo/branch through to fetchPrForBranch correctly and returns its result verbatim", async () => {
      // Real git remote (getRemoteUrl + resolveGithubRemote run for real);
      // only the actual network call (fetchPrForBranch) is stubbed — this
      // proves the route's argument pass-through, not just the trivial
      // no-remote short-circuit that the test above covers.
      execSync(`git -C "${repoDir}" remote add origin git@github.com:acme/widgets.git`, {
        stdio: "ignore",
      });
      const createRes = await app.inject({
        method: "POST",
        url: "/worktrees",
        payload: { projectId, branch: "wired-branch-name", modeId: "bug-fix" },
      });
      expect(createRes.statusCode).toBe(201);
      const wt = createRes.json<{ id: string }>();

      const github = await import("../services/github.js");
      const spy = vi.spyOn(github, "fetchPrForBranch").mockResolvedValue({
        kind: "pr",
        pr: {
          number: 55,
          url: "https://github.com/acme/widgets/pull/55",
          title: "Wired-through PR",
          state: "open",
          merged: false,
          draft: false,
          author: "someone",
        },
      });

      const res = await app.inject({ method: "GET", url: `/worktrees/${wt.id}/pr` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        kind: "pr",
        pr: {
          number: 55,
          url: "https://github.com/acme/widgets/pull/55",
          title: "Wired-through PR",
          state: "open",
          merged: false,
          draft: false,
          author: "someone",
        },
      });
      expect(spy).toHaveBeenCalledWith("acme", "widgets", "wired-branch-name");
      spy.mockRestore();
    });

    it("GET /worktrees/:id/pr returns 503 {kind:\"no_credentials\"} without treating it as no PR", async () => {
      execSync(`git -C "${repoDir}" remote add origin git@github.com:acme/nocred.git`, {
        stdio: "ignore",
      });
      const createRes = await app.inject({
        method: "POST",
        url: "/worktrees",
        payload: { projectId, branch: "nocred-branch", modeId: "bug-fix" },
      });
      const wt = createRes.json<{ id: string }>();

      const github = await import("../services/github.js");
      const spy = vi
        .spyOn(github, "fetchPrForBranch")
        .mockResolvedValue({ kind: "no_credentials" });

      const res = await app.inject({ method: "GET", url: `/worktrees/${wt.id}/pr` });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ kind: "no_credentials" });
      spy.mockRestore();
    });

    it("Requirement 11 — GET /worktrees/:id/commits returns a non-zero diffstat for a real commit made in the worktree", async () => {
      const wt = await createWorktree("vcs", "with-commit");
      const wtPath = join(tempDir, "projects", projectId, "worktrees", wt.id);

      await writeFile(join(wtPath, "feature.txt"), "line one\nline two\n");
      execSync(`git -C "${wtPath}" add -A && git -C "${wtPath}" commit -q -m "add feature.txt"`, {
        stdio: "ignore",
      });

      const res = await app.inject({ method: "GET", url: `/worktrees/${wt.id}/commits` });
      expect(res.statusCode).toBe(200);
      const { commits } = res.json<{
        commits: Array<{ subject: string; insertions: number; deletions: number }>;
      }>();
      expect(commits.length).toBeGreaterThan(0);
      const top = commits[0]!;
      expect(top.subject).toBe("add feature.txt");
      expect(top.insertions).toBe(2);
    });
  });
});

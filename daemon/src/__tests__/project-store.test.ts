import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ProjectRecord } from "../types.js";

let tempDir: string;

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {
      // Mock: no real process/tmux/hook-file side effects.
    }),
  };
});

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
  };
});

const makeProject = (id: string): ProjectRecord => ({
  id,
  absolutePath: `/fake/${id}`,
  prefix: id.slice(0, 4),
  isGit: true,
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  directSessions: [],
  worktrees: [],
});

describe("project-store (SQL-backed)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-store-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("2.T1 mutateProject applied concurrently on the same project serializes (no lost update)", async () => {
    const { addProject, mutateProject, getProject } = await import("../state/project-store.js");
    await addProject(makeProject("conc-proj"));
    const before = getProject("conc-proj")?.nextWorktreeNum ?? 0;

    // Fire 20 concurrent increments of a counter field. Without serialization,
    // a naive read-modify-write would lose updates (each mutation starts from
    // a copy of the record captured before an earlier one has written back).
    const mutations = Array.from({ length: 20 }, () =>
      mutateProject("conc-proj", (p) => ({ ...p, nextWorktreeNum: (p.nextWorktreeNum ?? 0) + 1 })),
    );
    await Promise.all(mutations);

    // Every one of the 20 concurrent mutations must be reflected — none lost
    // to a stale read-modify-write race.
    expect(getProject("conc-proj")?.nextWorktreeNum).toBe(before + 20);
  });

  // --- Regressions: read caching (PR #39 fallout) ---

  it("serves repeat reads from memory instead of re-querying SQLite every call", async () => {
    // The first SQLite cut re-assembled the whole object graph on EVERY read.
    // These functions run on genuinely hot paths — `findSessionRecord` is
    // called once per WS frame, i.e. once per keystroke — so that was ~3.5 ms
    // of synchronous, event-loop-blocking work per keypress on a real install,
    // plus native prepared-statement churn that drove RSS (and therefore the
    // cost of every fork()) through the roof.
    const { addProject, getAllProjects } = await import("../state/project-store.js");
    const { getDb } = await import("../state/db.js");
    await addProject(makeProject("cache-proj"));

    getAllProjects(); // warm
    const db = getDb();
    const spy = vi.spyOn(db, "prepare");
    try {
      for (let i = 0; i < 25; i++) getAllProjects();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a write is visible to the very next read (cache invalidation)", async () => {
    const { addProject, mutateProject, getProject, deleteProject } = await import(
      "../state/project-store.js"
    );
    await addProject(makeProject("inval-proj"));
    expect(getProject("inval-proj")?.nextWorktreeNum).toBe(1);

    await mutateProject("inval-proj", (p) => ({ ...p, nextWorktreeNum: 42 }));
    expect(getProject("inval-proj")?.nextWorktreeNum).toBe(42);

    await deleteProject("inval-proj");
    expect(getProject("inval-proj")).toBeUndefined();
  });

  it("a mutation that throws leaves neither the DB nor the cache changed", async () => {
    // `fn` gets a CLONE and the result is installed only after the transaction
    // commits, so a failed write can never leave the cache holding a value the
    // DB never got.
    const { addProject, mutateProject, getProject } = await import("../state/project-store.js");
    await addProject(makeProject("rollback-proj"));

    await expect(
      mutateProject("rollback-proj", (p) => {
        // Mutating the argument in place must not touch the cached record.
        p.nextWorktreeNum = 999;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(getProject("rollback-proj")?.nextWorktreeNum).toBe(1);
  });

  it("updateSessionLifecycle writes one row and is reflected in the cached graph", async () => {
    // The lifecycle fast path: `mutateProject` would DELETE and re-INSERT every
    // worktree + session row of the project just to flip one session's state.
    const { addProject, updateSessionLifecycle, getProject } = await import(
      "../state/project-store.js"
    );
    const project = makeProject("lc-proj");
    project.worktrees = [
      {
        id: "lc-wt",
        branch: "b",
        baseBranch: "main",
        baseSha: "a".repeat(40),
        createdAt: new Date().toISOString(),
        sessions: [
          {
            id: "lc-sess",
            type: "agent",
            modeId: "m",
            tmuxName: "lc-pane",
            isMain: true,
            sortOrder: 0,
            lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
          },
        ],
      },
    ];
    await addProject(project);

    const ok = await updateSessionLifecycle("lc-proj", "lc-sess", {
      state: "idle",
      lastTransitionAt: new Date().toISOString(),
    });

    expect(ok).toBe(true);
    expect(getProject("lc-proj")!.worktrees[0]!.sessions[0]!.lifecycle.state).toBe("idle");
    // Unknown session id is a no-op, not a throw.
    expect(
      await updateSessionLifecycle("lc-proj", "nope", {
        state: "idle",
        lastTransitionAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("2.T3 POST /worktrees -> GET /worktrees round-trips correctly through the SQL-backed store", async () => {
    const { buildServer } = await import("../server.js");
    const repoDir = join(tempDir, "repo");
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

    const app = await buildServer();
    try {
      const projRes = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
      expect(projRes.statusCode).toBe(201);
      const project = projRes.json<ProjectRecord>();

      const wtRes = await app.inject({
        method: "POST",
        url: "/worktrees",
        payload: { projectId: project.id, branch: "feature-x", modeId: "bug-fix" },
      });
      expect(wtRes.statusCode).toBe(201);
      const created = wtRes.json<{ id: string; branch: string }>();

      const listRes = await app.inject({ method: "GET", url: `/worktrees?project=${project.id}` });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json<{ id: string; branch: string }[]>();
      expect(list.some((w) => w.id === created.id && w.branch === "feature-x")).toBe(true);
    } finally {
      await app.close();
    }
  });
});

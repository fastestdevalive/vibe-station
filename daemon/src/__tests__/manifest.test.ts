import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRecord } from "../types.js";

// We need to override vstHome for these tests.
// Use vi.mock to redirect path resolution.
import { vi } from "vitest";

let tempDir: string;

// We'll test manifest read/write directly by pointing at temp dirs
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

describe("manifest read/write", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips a manifest", async () => {
    const { writeManifest, readManifest } = await import("../services/manifest.js");
    const project = makeProject("my-project");
    await writeManifest(project);
    const loaded = await readManifest("my-project");
    expect(loaded).toEqual(project);
  });

  it("round-trips a session's initialPrompt", async () => {
    const { writeManifest, readManifest } = await import("../services/manifest.js");
    const project = makeProject("prompt-project");
    const withSession: ProjectRecord = {
      ...project,
      worktrees: [
        {
          id: "wt-1",
          branch: "feat",
          baseBranch: "main",
          baseSha: "deadbeef",
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "wt-1-m",
              slot: "m",
              type: "agent",
              modeId: "bugfix",
              tmuxName: "vr-wt-1-m",
              useTmux: true,
              lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
              initialPrompt: "fix the flaky test",
            },
          ],
        },
      ],
    };
    await writeManifest(withSession);
    const loaded = await readManifest("prompt-project");
    expect(loaded.worktrees[0]?.sessions[0]?.initialPrompt).toBe("fix the flaky test");
  });

  it("uses atomic write (tmp file is renamed)", async () => {
    const { writeManifest } = await import("../services/manifest.js");
    const { access } = await import("node:fs/promises");
    const { manifestTmpPath, manifestPath } = await import("../services/paths.js");

    const project = makeProject("atomic-test");
    await writeManifest(project);

    // Tmp file should be gone after successful rename
    await expect(access(manifestTmpPath("atomic-test"))).rejects.toThrow();
    // Final file should exist
    await expect(access(manifestPath("atomic-test"))).resolves.toBeUndefined();
  });

  it("overwrites an existing manifest safely", async () => {
    const { writeManifest, readManifest } = await import("../services/manifest.js");
    const project = makeProject("overwrite-test");
    await writeManifest(project);

    const updated = { ...project, defaultBranch: "develop" };
    await writeManifest(updated);

    const loaded = await readManifest("overwrite-test");
    expect(loaded.defaultBranch).toBe("develop");
  });

  it("1.T3 — SessionRecord without useTmux field deserializes with useTmux === true", async () => {
    const { writeManifest, readManifest } = await import("../services/manifest.js");
    const { writeFile, mkdir: mkdirFs } = await import("node:fs/promises");
    const { manifestPath, projectDir } = await import("../services/paths.js");

    // Write a manifest that lacks useTmux on the session (pre-feature format)
    const projectId = "legacy-project";
    const rawManifest = JSON.stringify({
      id: projectId,
      absolutePath: "/fake/path",
      prefix: "legp",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      worktrees: [
        {
          id: "wt-1",
          branch: "main",
          baseBranch: "main",
          baseSha: "abc123",
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "sess-1",
              slot: "m",
              type: "agent",
              tmuxName: "vst-abc-1-m",
              // useTmux intentionally absent
              lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
            },
          ],
        },
      ],
    });

    await mkdirFs(projectDir(projectId), { recursive: true });
    await writeFile(manifestPath(projectId), rawManifest, "utf8");

    const loaded = await readManifest(projectId);
    expect(loaded.worktrees[0]!.sessions[0]!.useTmux).toBe(true);
  });

  it("1.T3 — legacy manifest without `channel` backfills channel from useTmux; json pins useTmux=false", async () => {
    const { readManifest } = await import("../services/manifest.js");
    const { writeFile, mkdir: mkdirFs } = await import("node:fs/promises");
    const { manifestPath, projectDir } = await import("../services/paths.js");

    const projectId = "channel-backfill";
    const rawManifest = JSON.stringify({
      id: projectId,
      absolutePath: "/fake/path",
      prefix: "chbf",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [
        {
          id: "d1",
          slot: "d1",
          type: "agent",
          tmuxName: "__direct__-d1",
          useTmux: false,
          // channel intentionally absent → should backfill "pty"
          lifecycle: { state: "idle", lastTransitionAt: new Date().toISOString() },
        },
        {
          id: "d2",
          slot: "d2",
          type: "agent",
          tmuxName: "__direct__-d2",
          useTmux: true,
          channel: "json", // json must pin useTmux=false
          lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
        },
      ],
      worktrees: [
        {
          id: "wt-1",
          branch: "main",
          baseBranch: "main",
          baseSha: "abc123",
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "m",
              slot: "m",
              type: "agent",
              tmuxName: "vst-chbf-1-m",
              useTmux: true, // no channel → backfill "tmux"
              lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
            },
          ],
        },
      ],
    });

    await mkdirFs(projectDir(projectId), { recursive: true });
    await writeFile(manifestPath(projectId), rawManifest, "utf8");

    const loaded = await readManifest(projectId);
    expect(loaded.worktrees[0]!.sessions[0]!.channel).toBe("tmux");
    expect(loaded.directSessions[0]!.channel).toBe("pty");
    expect(loaded.directSessions[1]!.channel).toBe("json");
    expect(loaded.directSessions[1]!.useTmux).toBe(false);
  });
});

describe("project-store", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-test-"));
    // Reset module state between tests
    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loadAll() with empty projects dir loads nothing", async () => {
    const { loadAll, getAllProjects } = await import("../state/project-store.js");
    await loadAll();
    expect(getAllProjects()).toHaveLength(0);
  });

  it("loadAll() reads existing manifests into memory", async () => {
    const { writeManifest } = await import("../services/manifest.js");
    const p1 = makeProject("proj-a");
    const p2 = makeProject("proj-b");
    await writeManifest(p1);
    await writeManifest(p2);

    const { loadAll, getAllProjects } = await import("../state/project-store.js");
    await loadAll();
    const all = getAllProjects();
    expect(all.map((p) => p.id).sort()).toEqual(["proj-a", "proj-b"]);
  });

  it("addProject and getProject work correctly", async () => {
    const { addProject, getProject } = await import("../state/project-store.js");
    const project = makeProject("new-proj");
    await addProject(project);
    // The SQL-backed store always materializes the counter columns (they're
    // NOT NULL with defaults) even when the caller's in-memory record never
    // set them — unlike the old JSON store, which just echoed back whatever
    // object was stored in the Map verbatim.
    expect(getProject("new-proj")).toEqual({ ...project, directSessionSeq: 0, nextWorktreeNum: 1 });
  });

  it("addProject throws on duplicate id", async () => {
    const { addProject } = await import("../state/project-store.js");
    const project = makeProject("dup-proj");
    await addProject(project);
    await expect(addProject(project)).rejects.toThrow("already exists");
  });

  it("mutateProject persists (SQL is the sole source of truth, no cache to go stale)", async () => {
    const { addProject, mutateProject, getProject } = await import(
      "../state/project-store.js"
    );

    const project = makeProject("mut-proj");
    await addProject(project);
    await mutateProject("mut-proj", (p) => ({ ...p, defaultBranch: "develop" }));

    expect(getProject("mut-proj")?.defaultBranch).toBe("develop");
  });

  it("deleteProject removes from memory", async () => {
    const { addProject, deleteProject, getProject } = await import(
      "../state/project-store.js"
    );
    const project = makeProject("del-proj");
    await addProject(project);
    await deleteProject("del-proj");
    expect(getProject("del-proj")).toBeUndefined();
  });

  it("concurrent mutations under project mutex are serialized", async () => {
    const { addProject, mutateProject, getProject } = await import(
      "../state/project-store.js"
    );
    const project = makeProject("conc-proj");
    await addProject(project);

    let counter = 0;
    const mutations = Array.from({ length: 10 }, (_, i) =>
      mutateProject("conc-proj", (p) => {
        counter++;
        return { ...p, prefix: `p${i}` };
      }),
    );
    await Promise.all(mutations);
    expect(counter).toBe(10);
    // Final state should be one of the valid prefixes (last mutation wins)
    const final = getProject("conc-proj");
    expect(final?.prefix).toMatch(/^p\d$/);
  });
});

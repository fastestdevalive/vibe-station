import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRecord } from "../types.js";

// We need to override vrunHome for these tests.
// Use vi.mock to redirect path resolution.
import { vi } from "vitest";

let tempDir: string;

// We'll test manifest read/write directly by pointing at temp dirs
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

const makeProject = (id: string): ProjectRecord => ({
  id,
  absolutePath: `/fake/${id}`,
  prefix: id.slice(0, 4),
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  worktrees: [],
});

describe("manifest read/write", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-test-"));
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
});

describe("project-store", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-test-"));
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
    expect(getProject("new-proj")).toEqual(project);
  });

  it("addProject throws on duplicate id", async () => {
    const { addProject } = await import("../state/project-store.js");
    const project = makeProject("dup-proj");
    await addProject(project);
    await expect(addProject(project)).rejects.toThrow("already exists");
  });

  it("mutateProject updates memory and disk", async () => {
    const { addProject, mutateProject, getProject } = await import(
      "../state/project-store.js"
    );
    const { readManifest } = await import("../services/manifest.js");

    const project = makeProject("mut-proj");
    await addProject(project);
    await mutateProject("mut-proj", (p) => ({ ...p, defaultBranch: "develop" }));

    expect(getProject("mut-proj")?.defaultBranch).toBe("develop");
    const onDisk = await readManifest("mut-proj");
    expect(onDisk.defaultBranch).toBe("develop");
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

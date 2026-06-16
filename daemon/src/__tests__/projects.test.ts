import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord } from "../types.js";

let tempDir: string;
let repoDir: string;

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
  };
});

describe("GET /projects + POST /projects + DELETE /projects/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-proj-test-"));
    repoDir = join(tempDir, "my-repo");

    // Create a real git repo for testing
    execSync(`mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`, {
      stdio: "ignore",
    });

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("GET /projects returns empty array initially", async () => {
    const res = await app.inject({ method: "GET", url: "/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("POST /projects creates a project and returns it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ path: string }>();
    expect(body.path).toBe(repoDir);
    expect(body.id).toBeTruthy();
    expect(body.prefix).toBeTruthy();
    expect(body.defaultBranch).toBeTruthy();
  });

  it("POST /projects 400 if path is not a git repo", async () => {
    const notRepo = join(tempDir, "not-a-repo");
    execSync(`mkdir -p "${notRepo}"`);
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: notRepo },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /projects 409 on duplicate id", async () => {
    await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /projects 409 on prefix collision", async () => {
    // Create second repo
    const repo2 = join(tempDir, "my-repo-2");
    execSync(`mkdir -p "${repo2}" && git init "${repo2}" && git -C "${repo2}" commit --allow-empty -m "init"`, { stdio: "ignore" });

    // Both repos would produce the same prefix if named similarly
    // Use explicit override
    await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir, prefix: "xyzt" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repo2, name: "different-name", prefix: "xyzt" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("xyzt");
  });

  it("DELETE /projects/:id removes from store and disk", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    const project = createRes.json<ProjectRecord>();

    const delRes = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}`,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);

    const getRes = await app.inject({ method: "GET", url: "/projects" });
    expect(getRes.json<ProjectRecord[]>()).toHaveLength(0);
  });

  it("DELETE /projects/:id 404 for unknown project", async () => {
    const res = await app.inject({ method: "DELETE", url: "/projects/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /projects lists created project", async () => {
    await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    const res = await app.inject({ method: "GET", url: "/projects" });
    expect(res.json<ProjectRecord[]>()).toHaveLength(1);
  });

  it("GET /projects/:id/branches returns local branches and the default branch", async () => {
    // Add a couple of extra branches to the repo.
    execSync(
      `git -C "${repoDir}" branch feature-a && git -C "${repoDir}" branch feature-b`,
      { stdio: "ignore" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    const project = created.json<ProjectRecord>();

    const res = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/branches`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ branches: string[]; defaultBranch: string }>();
    expect(body.branches).toEqual(expect.arrayContaining(["feature-a", "feature-b"]));
    expect(body.branches).toContain(body.defaultBranch);
    expect(body.defaultBranch).toBeTruthy();
  });

  it("GET /projects/:id/branches 404 for unknown project", async () => {
    const res = await app.inject({ method: "GET", url: "/projects/nonexistent/branches" });
    expect(res.statusCode).toBe(404);
  });

  it("new projects serialize hidden:false by default", async () => {
    const res = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    expect(res.json<{ hidden: boolean }>().hidden).toBe(false);
  });

  it("PATCH /projects/:id { hidden:true } hides the project and persists across reload", async () => {
    const created = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    const project = created.json<ProjectRecord>();

    const patch = await app.inject({
      method: "PATCH",
      url: `/projects/${project.id}`,
      payload: { hidden: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ ok: boolean; project: { hidden: boolean } }>().project.hidden).toBe(true);

    // GET reflects it.
    const list = await app.inject({ method: "GET", url: "/projects" });
    expect(list.json<{ id: string; hidden: boolean }[]>().find((p) => p.id === project.id)?.hidden).toBe(true);

    // Persisted on disk: reload manifest from a fresh store.
    const { _clearStoreForTest, loadAll, getProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    await loadAll();
    expect(getProject(project.id)?.hidden).toBe(true);
  });

  it("PATCH /projects/:id { hidden:false } drops the field (clean manifest)", async () => {
    const created = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    const project = created.json<ProjectRecord>();

    await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { hidden: true } });
    const unhide = await app.inject({
      method: "PATCH",
      url: `/projects/${project.id}`,
      payload: { hidden: false },
    });
    expect(unhide.statusCode).toBe(200);
    expect(unhide.json<{ project: { hidden: boolean } }>().project.hidden).toBe(false);

    const { _clearStoreForTest, loadAll, getProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    await loadAll();
    const reloaded = getProject(project.id);
    expect(reloaded?.hidden).toBeUndefined();
  });

  it("PATCH /projects/:id 404 for unknown project", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/projects/nonexistent",
      payload: { hidden: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /projects/:id 400 on invalid body", async () => {
    const created = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    const project = created.json<ProjectRecord>();
    const res = await app.inject({
      method: "PATCH",
      url: `/projects/${project.id}`,
      payload: { hidden: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});

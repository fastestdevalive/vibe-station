import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { resetSkillCatalogForTests } from "../services/userSkillCatalog.js";
import type { FastifyInstance } from "fastify";

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

describe("GET/PATCH /settings — skillPaths (Phase 4)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-settings-test-"));
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    resetSkillCatalogForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("GET /settings defaults skillPaths to the well-known per-CLI skill dirs when unset", async () => {
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skillPaths).toEqual([
      join(homedir(), ".claude", "skills"),
      join(homedir(), ".gemini", "skills"),
    ]);
  });

  it("PATCH /settings rejects a non-absolute skillPaths entry with 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { skillPaths: ["relative/path"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /settings persists absolute skillPaths and a subsequent GET reflects them", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { skillPaths: ["/tmp/my-skills"] },
    });
    expect(res.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: "/settings" });
    expect(getRes.json().skillPaths).toEqual(["/tmp/my-skills"]);
  });

  it("4.T4 regression — PATCH with only defaultProjectsDir (no skillPaths) succeeds and leaves skillPaths unchanged", async () => {
    // First set a known skillPaths value.
    await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { skillPaths: ["/tmp/my-skills"] },
    });

    // Then PATCH only defaultProjectsDir.
    const res = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { defaultProjectsDir: "/tmp/some-project-dir" },
    });
    expect(res.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: "/settings" });
    const body = getRes.json();
    expect(body.defaultProjectsDir).toBe("/tmp/some-project-dir");
    expect(body.skillPaths).toEqual(["/tmp/my-skills"]);
  });
});

describe("GET /skills (Phase 4)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-skills-route-test-"));
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    resetSkillCatalogForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("4.T5 — GET /skills is reachable and returns the shape {skills, directories}, no error status", async () => {
    const res = await app.inject({ method: "GET", url: "/skills" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.skills)).toBe(true);
    expect(Array.isArray(body.directories)).toBe(true);
  });

  it("reflects a directory scanned after PATCH /settings sets skillPaths", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const skillsDir = join(tempDir, "my-skills");
    await mkdir(join(skillsDir, "greeter"), { recursive: true });
    await writeFile(
      join(skillsDir, "greeter", "SKILL.md"),
      "---\nname: greeter\ndescription: Says hello\n---\n",
      "utf8",
    );

    await app.inject({ method: "PATCH", url: "/settings", payload: { skillPaths: [skillsDir] } });

    const res = await app.inject({ method: "GET", url: "/skills" });
    const body = res.json();
    expect(body.skills.find((s: { name: string }) => s.name === "greeter")).toBeTruthy();
    expect(body.directories.find((d: { path: string }) => d.path === skillsDir)?.skillCount).toBe(1);
  });
});

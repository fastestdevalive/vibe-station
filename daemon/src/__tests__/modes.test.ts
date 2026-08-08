import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
  };
});

interface Mode {
  id: string;
  name: string;
  cli: string;
  context: string;
  createdAt: string;
}

describe("Mode routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-modes-test-"));
    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();
    const { _resetModesCacheForTest } = await import("../routes/modes.js");
    _resetModesCacheForTest();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("GET /modes returns empty array initially", async () => {
    const res = await app.inject({ method: "GET", url: "/modes" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("GET /supported-clis lists all CLIs with defaultModel + supportsJson + importsNativeHistory", async () => {
    const res = await app.inject({ method: "GET", url: "/supported-clis" });
    expect(res.statusCode).toBe(200);
    const body = res.json<
      Array<{ id: string; defaultModel: string; supportsJson: boolean; importsNativeHistory: boolean }>
    >();
    expect(body.find((c) => c.id === "claude")?.supportsJson).toBe(true);
    // claude + opencode ship a native-history importer; cursor + agy don't (yet).
    expect(body.find((c) => c.id === "claude")?.importsNativeHistory).toBe(true);
    expect(body.find((c) => c.id === "opencode")?.importsNativeHistory).toBe(true);
    expect(body.find((c) => c.id === "cursor")?.importsNativeHistory).toBe(false);
    // agy (Antigravity CLI) registers with JSON support enabled but no importer.
    expect(body.find((c) => c.id === "agy")).toEqual({
      id: "agy",
      defaultModel: "Gemini 3.1 Pro (High)",
      supportsJson: true,
      importsNativeHistory: false,
    });
    expect(body.map((c) => c.id).sort()).toEqual(["agy", "claude", "cursor", "opencode"]);
  });

  it("POST /modes accepts cli agy", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "agy-mode", cli: "agy", context: "Use Antigravity." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Mode>().cli).toBe("agy");
  });

  it("POST /modes rejects bogus cli", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "bad", cli: "bogus", context: "ctx" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /modes creates a mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "bug-fix", cli: "claude", context: "Fix bugs." },
    });
    expect(res.statusCode).toBe(201);
    const mode = res.json<Mode>();
    expect(mode.name).toBe("bug-fix");
    expect(mode.cli).toBe("claude");
    expect(mode.id).toBeTruthy();
  });

  it("POST /modes 409 on duplicate name", async () => {
    await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "dup", cli: "claude", context: "ctx" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "dup", cli: "cursor", context: "ctx2" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("PUT /modes/:id updates name and context", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "old-name", cli: "claude", context: "old ctx" },
    });
    const modeId = createRes.json<Mode>().id;

    const updateRes = await app.inject({
      method: "PUT",
      url: `/modes/${modeId}`,
      payload: { name: "new-name", context: "new ctx" },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = updateRes.json<Mode>();
    expect(updated.name).toBe("new-name");
    expect(updated.context).toBe("new ctx");
    // cli is immutable
    expect(updated.cli).toBe("claude");
  });

  it("DELETE /modes/:id removes the mode", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "to-delete", cli: "opencode", context: "ctx" },
    });
    const modeId = createRes.json<Mode>().id;

    const delRes = await app.inject({ method: "DELETE", url: `/modes/${modeId}` });
    expect(delRes.statusCode).toBe(200);

    const listRes = await app.inject({ method: "GET", url: "/modes" });
    expect(listRes.json<Mode[]>()).toHaveLength(0);
  });

  it("DELETE /modes/:id 404 for unknown mode", async () => {
    const res = await app.inject({ method: "DELETE", url: "/modes/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /modes/:id succeeds even when a session is using it, reporting the count", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "in-use", cli: "claude", context: "ctx" },
    });
    const modeId = createRes.json<Mode>().id;

    const { addProject } = await import("../state/project-store.js");
    await addProject({
      id: "proj-in-use",
      absolutePath: "/tmp/proj-in-use",
      prefix: "piu",
      isGit: true,
      createdAt: new Date().toISOString(),
      worktrees: [
        {
          id: "wt-1",
          branch: "wt-1",
          baseBranch: "main",
          baseSha: "abc123",
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "sess-1",
              slot: "m",
              type: "agent",
              modeId,
              tmuxName: "piu-wt-1-m",
              useTmux: true,
              lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
            },
          ],
        },
      ],
      directSessions: [
        {
          id: "sess-2",
          slot: "d1",
          type: "agent",
          modeId,
          tmuxName: "__direct__-sess-2",
          useTmux: true,
          lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
        },
      ],
    });

    // Still shows up as normal before deletion.
    const preList = await app.inject({ method: "GET", url: "/modes" });
    expect(preList.json<Mode[]>()).toHaveLength(1);

    const delRes = await app.inject({ method: "DELETE", url: `/modes/${modeId}` });
    expect(delRes.statusCode).toBe(200);
    // One worktree session + one direct session both reference this modeId.
    expect(delRes.json<{ ok: true; affectedSessions: number }>().affectedSessions).toBe(2);

    const postList = await app.inject({ method: "GET", url: "/modes" });
    expect(postList.json<Mode[]>()).toHaveLength(0);
  });

  it("GET /modes lists multiple created modes", async () => {
    await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "m1", cli: "claude", context: "c1" },
    });
    await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "m2", cli: "cursor", context: "c2" },
    });
    const res = await app.inject({ method: "GET", url: "/modes" });
    expect(res.json<Mode[]>()).toHaveLength(2);
  });
});

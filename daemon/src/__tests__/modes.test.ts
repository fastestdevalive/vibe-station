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

  it("GET /supported-clis lists all CLIs with defaultModel including gemini", async () => {
    const res = await app.inject({ method: "GET", url: "/supported-clis" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ id: string; defaultModel: string }>>();
    const gemini = body.find((c) => c.id === "gemini");
    expect(gemini).toEqual({ id: "gemini", defaultModel: "auto" });
    expect(body.map((c) => c.id).sort()).toEqual(["claude", "cursor", "gemini", "opencode"]);
  });

  it("POST /modes accepts cli gemini", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/modes",
      payload: { name: "gemini-mode", cli: "gemini", context: "Use Gemini." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Mode>().cli).toBe("gemini");
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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
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

vi.mock("../broadcaster.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../broadcaster.js")>();
  return {
    ...original,
    broadcastAll: vi.fn(),
  };
});

describe("GET/PUT /user/ordered-lists/:scopeKey", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-ordered-lists-test-"));
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T1 GET with no prior PUT returns an empty list and null updatedAt", async () => {
    const res = await app.inject({ method: "GET", url: "/user/ordered-lists/pinned-all" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scopeKey: "pinned-all", itemIds: [], updatedAt: null });
  });

  it("1.T2 PUT persists the order and a subsequent GET returns it", async () => {
    const putRes = await app.inject({
      method: "PUT",
      url: "/user/ordered-lists/pinned-all",
      payload: { itemIds: ["a", "b"] },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json<{ ok: boolean; scopeKey: string; itemIds: string[]; updatedAt: string }>();
    expect(putBody).toMatchObject({ ok: true, scopeKey: "pinned-all", itemIds: ["a", "b"] });
    expect(typeof putBody.updatedAt).toBe("string");

    const getRes = await app.inject({ method: "GET", url: "/user/ordered-lists/pinned-all" });
    expect(getRes.json<{ itemIds: string[] }>().itemIds).toEqual(["a", "b"]);
  });

  it("1.T3 rejects a non-array itemIds and an unknown scopeKey with 400", async () => {
    const badBody = await app.inject({
      method: "PUT",
      url: "/user/ordered-lists/pinned-all",
      payload: { itemIds: "not-an-array" },
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error).toBe("Validation error");

    const badScope = await app.inject({
      method: "PUT",
      url: "/user/ordered-lists/not-a-real-scope",
      payload: { itemIds: [] },
    });
    expect(badScope.statusCode).toBe(400);

    const badScopeGet = await app.inject({ method: "GET", url: "/user/ordered-lists/not-a-real-scope" });
    expect(badScopeGet.statusCode).toBe(400);
  });

  it("1.T4 broadcasts orderedList:updated on a successful PUT", async () => {
    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    broadcastAll.mockClear();

    const res = await app.inject({
      method: "PUT",
      url: "/user/ordered-lists/pinned-all",
      payload: { itemIds: ["x", "y"] },
    });
    expect(res.statusCode).toBe(200);

    const call = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === "orderedList:updated",
    );
    expect(call).toBeDefined();
    const event = call![0] as { scopeKey: string; itemIds: string[]; updatedAt: string };
    expect(event.scopeKey).toBe("pinned-all");
    expect(event.itemIds).toEqual(["x", "y"]);
    expect(typeof event.updatedAt).toBe("string");
  });
});

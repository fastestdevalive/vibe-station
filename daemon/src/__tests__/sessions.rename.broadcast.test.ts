import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
    worktreePath: (id: string, wtId: string) => pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    cleanupSessionDataDir: () => {},
    cleanupDirectSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) => pathJoin(tempDir, "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) => pathJoin(tempDir, "projects", p, "sessions", s),
  };
});

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {}),
    spawnDirectSession: vi.fn(async () => {}),
  };
});

vi.mock("../services/tmux.js", () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  hasSession: vi.fn().mockResolvedValue(true),
  killSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  listSessionNames: vi.fn().mockResolvedValue(new Set()),
  listSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../broadcaster.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../broadcaster.js")>();
  return {
    ...original,
    broadcastAll: vi.fn(),
  };
});

/**
 * Coverage for `PATCH /sessions/:id/rename`'s `session:updated` broadcast.
 *
 * This used to also assert a separate server-computed `label` field on the
 * response/broadcast (added, then removed again, during the investigation of
 * a real-time-rename bug — see git history and `.vibekit/handoff-flow.md`'s
 * sibling design notes for context). `label` no longer exists anywhere in
 * this contract: the client computes the display string itself from
 * `name`/`isMain`/`type` via `sessionLabel()` in
 * `web-ui/src/lib/sessionLabel.ts`, so broadcasting `name` alone is both
 * necessary and sufficient — there is no second value that can go stale.
 * These tests just lock in that the broadcast actually carries the new
 * `name` for every session shape (worktree, direct, and a clear-to-default).
 */
describe("PATCH /sessions/:id/rename broadcasts the new name", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;
  let mainSessionId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-session-rename-broadcast-test-"));
    repoDir = join(tempDir, "repo");
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

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    app = await buildServer();

    const projRes = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    projectId = projRes.json<{ id: string }>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "rename-broadcast-target", modeId: "bug-fix" },
    });
    const wt = wtRes.json<{ id: string; mainSessionId: string }>();
    worktreeId = wt.id;
    mainSessionId = wt.mainSessionId;

    vi.mocked(broadcasterNs.broadcastAll).mockClear();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("worktree session: broadcasts the new name", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${mainSessionId}/rename`,
      payload: { name: "my-custom-name" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: true; name: string | null }>()).toEqual({
      ok: true,
      name: "my-custom-name",
    });

    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    const updatedCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "session:updated",
    );
    expect(updatedCall).toBeDefined();
    expect(updatedCall![0]).toMatchObject({
      type: "session:updated",
      sessionId: mainSessionId,
      name: "my-custom-name",
    });
  });

  it("clearing the name back to empty broadcasts name: null", async () => {
    await app.inject({
      method: "PATCH",
      url: `/sessions/${mainSessionId}/rename`,
      payload: { name: "temporary-name" },
    });
    vi.mocked(broadcasterNs.broadcastAll).mockClear();

    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${mainSessionId}/rename`,
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string | null }>().name).toBeNull();

    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    const updatedCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "session:updated",
    );
    expect(updatedCall![0]).toMatchObject({
      type: "session:updated",
      sessionId: mainSessionId,
      name: null,
    });
  });

  it("direct (worktree-less) session: broadcasts the new name", async () => {
    const directRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { target: "direct", projectId, type: "terminal" },
    });
    const directId = directRes.json<{ id: string }>().id;
    vi.mocked(broadcasterNs.broadcastAll).mockClear();

    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${directId}/rename`,
      payload: { name: "renamed-direct-terminal" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string | null }>().name).toBe("renamed-direct-terminal");

    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    const updatedCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "session:updated",
    );
    expect(updatedCall![0]).toMatchObject({
      type: "session:updated",
      sessionId: directId,
      name: "renamed-direct-terminal",
    });
  });
});

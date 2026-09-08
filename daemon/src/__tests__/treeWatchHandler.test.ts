/**
 * Handler-level (not just `WSConnection`-method-level) coverage for the
 * refcounted watcher maps, closing the 1.T3 gap: "one simulated `WSConnection`
 * sends `tree:watch` for the same worktree twice ... then one `tree:unwatch`"
 * must be proven through the actual `handleTreeWatch`/`handleTreeUnwatch`
 * handlers (Decision 8, `.vibekit/feature-plans/pending/ui-improvements/`),
 * not just by calling `retainTreeWatcher`/`releaseTreeWatcher` directly —
 * `connection.test.ts` already covers those in isolation.
 *
 * Uses a real worktree directory and a real `FileWatcher` (chokidar) — the
 * refcounting behavior under test is entirely synchronous (the map entry is
 * set the moment `handleTreeWatch` runs, before chokidar's async readiness),
 * so no waiting for filesystem events is needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord } from "../types.js";
import { WSConnection } from "../ws/connection.js";
import { handleTreeWatch } from "../ws/handlers/treeWatch.js";
import { handleTreeUnwatch } from "../ws/handlers/treeUnwatch.js";

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
  return { ...original, spawnSession: vi.fn(async () => {}) };
});

function makeConn(): WSConnection {
  const fakeWs = { readyState: 1, send: vi.fn(), bufferedAmount: 0 } as unknown as ConstructorParameters<
    typeof WSConnection
  >[0];
  return new WSConnection(fakeWs);
}

describe("handleTreeWatch/handleTreeUnwatch refcounting (1.T3, integration-level)", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;
  let conn: WSConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-treewatch-handler-test-"));
    repoDir = join(tempDir, "my-repo");
    execSync(
      `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`,
      { stdio: "ignore" },
    );

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

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
    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();
    const promptBuilderModule = await import("../services/promptBuilder.js");
    promptBuilderModule._resetSkillCacheForTest();

    app = await buildServer();

    const projRes = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    projectId = projRes.json<ProjectRecord>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "tree-watch-handler-test", modeId: "bug-fix" },
    });
    worktreeId = wtRes.json<{ id: string }>().id;

    conn = makeConn();
  });

  afterEach(async () => {
    await conn.cleanup();
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("two tree:watch calls on the same connection/key retain instead of creating a second watcher; one tree:unwatch releases without closing, the second closes", async () => {
    const watchMsg = { type: "tree:watch" as const, worktreeId, path: undefined };
    const unwatchMsg = { type: "tree:unwatch" as const, worktreeId, path: undefined };
    const key = `tree:${worktreeId}:`;

    // First consumer: creates the watcher.
    handleTreeWatch(conn, watchMsg);
    expect(conn.treeWatches.has(key)).toBe(true);
    expect(conn.treeWatches.get(key)?.refCount).toBe(1);
    const watcherInstance = conn.treeWatches.get(key)?.watcher;

    // Second consumer (same connection, same key): retains, no second watcher.
    handleTreeWatch(conn, watchMsg);
    expect(conn.treeWatches.size).toBe(1);
    expect(conn.treeWatches.get(key)?.refCount).toBe(2);
    expect(conn.treeWatches.get(key)?.watcher).toBe(watcherInstance);

    // First tree:unwatch: releases one reference — watcher must stay open.
    await handleTreeUnwatch(conn, unwatchMsg);
    expect(conn.treeWatches.has(key)).toBe(true);
    expect(conn.treeWatches.get(key)?.refCount).toBe(1);
    expect(conn.treeWatches.get(key)?.watcher).toBe(watcherInstance);

    // Second tree:unwatch: refCount hits 0 — watcher is actually closed and removed.
    await handleTreeUnwatch(conn, unwatchMsg);
    expect(conn.treeWatches.has(key)).toBe(false);
  }, 15000);
});

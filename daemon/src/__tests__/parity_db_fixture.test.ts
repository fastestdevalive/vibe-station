import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Generate a genuine Node-daemon-populated `vibe-station.db` for the F4
// SQLite-compat fixture (part 10, task 3). This exercises the daemon's REAL
// storage layer through its HTTP routes (Fastify app.inject, no port bound) so
// the fixture is a true "written by the actual Node daemon" database — the
// project/worktree/session rows are created by the real handlers, not hand-
// inserted. Set PARITY_DB_OUT to write the DB to a path (the committed fixture).
//
// The existing `node-v1.sqlite` fixture is schema-only (0 rows); this one is
// data-populated so the Rust store can prove it READS back real Node data.
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
    cleanupDirectSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(tempDir, "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) =>
      pathJoin(tempDir, "projects", p, "sessions", s),
  };
});

vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  killSession: vi.fn().mockResolvedValue(undefined),
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  listSessions: vi.fn().mockResolvedValue([]),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {}),
    spawnSessionFromArgv: vi.fn(async () => {}),
    spawnDirectSession: vi.fn(async () => {}),
  };
});

import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

describe("parity DB fixture (node side)", () => {
  let app: FastifyInstance;
  let projectId: string;
  let worktreeId: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-parity-db-"));

    const repoDir = join(tempDir, "my-repo");
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
          id: "bugfix",
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

    const projRes = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    expect(projRes.statusCode).toBe(201);
    projectId = projRes.json<ProjectRecord>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "feat-db", modeId: "bugfix" },
    });
    expect(wtRes.statusCode).toBe(201);
    worktreeId = wtRes.json<WorktreeRecord>().id;

    const sessRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "terminal" },
    });
    expect(sessRes.statusCode).toBe(201);
    const session = sessRes.json<SessionRecord>();
    expect(session.type).toBe("terminal");
  });

  afterAll(async () => {
    // Close the Fastify app, then reset the singleton SQLite connection so its
    // WAL journal is checkpointed into the main DB file (journal_mode=WAL
    // writes go to a -wal file until the connection closes/checkpoints).
    // Copying before the checkpoint would produce an empty main DB with the
    // real data stranded in the -wal sidecar.
    await app.close();
    const { _resetDbForTest } = await import("../state/db.js");
    _resetDbForTest();
    const outPath = process.env.PARITY_DB_OUT;
    if (outPath) {
      await copyFile(join(tempDir, "vibe-station.db"), outPath);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a project, worktree, and terminal session in the isolated DB", () => {
    expect(projectId).toBeTruthy();
    expect(worktreeId).toBeTruthy();
  });
});

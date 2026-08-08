import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  };
});

function legacyManifest(id: string) {
  return {
    id,
    absolutePath: `/fake/${id}`,
    prefix: id.slice(0, 4),
    isGit: true,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    directSessions: [],
    worktrees: [
      {
        id: `${id}-1`,
        branch: "feature-x",
        baseBranch: "main",
        baseSha: "0".repeat(40),
        createdAt: new Date().toISOString(),
        sessions: [
          {
            id: `${id}-1-m`,
            slot: "m",
            type: "agent",
            modeId: "claude-default",
            tmuxName: `vr-${id}-1-m`,
            useTmux: true,
            lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
          },
          {
            id: `${id}-1-t1`,
            slot: "t1",
            type: "terminal",
            name: "Terminal 1",
            tmuxName: `vr-${id}-1-t1`,
            useTmux: true,
            lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
          },
        ],
      },
    ],
  };
}

async function writeLegacyManifest(id: string, content: unknown = legacyManifest(id)): Promise<void> {
  const dir = join(tempDir, "projects", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(content, null, 2), "utf8");
}

describe("migrateManifestsToSqlite", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-dbmig-test-"));
  });

  afterEach(async () => {
    const { _resetDbForTest } = await import("../state/db.js");
    _resetDbForTest();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T1 migrates a well-formed multi-project fixture with correct row counts", async () => {
    await writeLegacyManifest("proj-a");
    await writeLegacyManifest("proj-b");

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();
    await migrateManifestsToSqlite(db);

    expect((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM worktrees").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(4);

    // isMain backfilled from the removed slot==="m" check.
    const main = db.prepare("SELECT * FROM sessions WHERE id = ?").get("proj-a-1-m") as { isMain: number };
    expect(main.isMain).toBe(1);
    const term = db.prepare("SELECT * FROM sessions WHERE id = ?").get("proj-a-1-t1") as { isMain: number; name: string };
    expect(term.isMain).toBe(0);
    expect(term.name).toBe("Terminal 1");
  });

  it("1.T2 quarantines a malformed manifest.json without throwing or affecting other projects", async () => {
    await writeLegacyManifest("proj-good");
    await writeLegacyManifest("proj-bad", "{ not valid json");

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();

    await expect(migrateManifestsToSqlite(db)).resolves.toBeUndefined();

    const ids = (db.prepare("SELECT id FROM projects").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["proj-good"]);

    // manifest.json for the quarantined project is left on disk, untouched.
    const { readManifest } = await import("../services/manifest.js");
    await expect(readManifest("proj-bad")).rejects.toBeTruthy();
  });

  it("Bug 5 fix — a manifest missing the `worktrees` key migrates successfully instead of quarantining", async () => {
    const id = "proj-noworktrees";
    const manifest = legacyManifest(id) as { worktrees?: unknown };
    delete manifest.worktrees;
    await writeLegacyManifest(id, manifest);

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();

    await expect(migrateManifestsToSqlite(db)).resolves.toBeUndefined();

    // The project must NOT be quarantined — it migrates (with zero worktrees).
    const ids = (db.prepare("SELECT id FROM projects").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([id]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM worktrees WHERE projectId = ?").get(id) as { n: number }).n).toBe(
      0,
    );
  });

  it("Bug 5 fix — a manifest with `worktrees: null` also migrates successfully", async () => {
    const id = "proj-nullworktrees";
    const manifest = legacyManifest(id) as { worktrees: unknown };
    manifest.worktrees = null;
    await writeLegacyManifest(id, manifest);

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();

    await expect(migrateManifestsToSqlite(db)).resolves.toBeUndefined();
    const ids = (db.prepare("SELECT id FROM projects").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([id]);
  });

  it("1.T3 running migration twice is a no-op the second time (idempotent via user_version)", async () => {
    await writeLegacyManifest("proj-a");

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();
    await migrateManifestsToSqlite(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n).toBe(1);

    // A new project appears on disk after the first pass — a second call must
    // NOT pick it up (global user_version gate, not a per-project scan).
    await writeLegacyManifest("proj-b");
    await migrateManifestsToSqlite(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n).toBe(1);
  });

  it("1.T4 GET /projects returns both existing manifest-based projects post-migration", async () => {
    await writeLegacyManifest("proj-a");
    await writeLegacyManifest("proj-b");

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    await migrateManifestsToSqlite(getDb());

    const { buildServer } = await import("../server.js");
    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/projects" });
      expect(res.statusCode).toBe(200);
      const ids = (res.json<{ id: string }[]>()).map((p) => p.id).sort();
      expect(ids).toEqual(["proj-a", "proj-b"]);
    } finally {
      await app.close();
    }
  });

  it("1.T5 preserves a session's transcript file reference and leaves the transcript file itself untouched on disk", async () => {
    const id = "proj-transcript";
    // A realistic transcript layout: per-session data dir with messages.db
    // beside it, matching sqliteTranscriptStore's `transcriptDbPath` shape.
    const sessionDataDir = join(tempDir, "projects", id, "worktrees", `${id}-1`, "sessions", `${id}-1-m`);
    await mkdir(sessionDataDir, { recursive: true });
    const transcriptPath = join(sessionDataDir, "messages.db");
    const transcriptContent = "not a real sqlite file, just distinctive byte content for a diff check  ";
    await writeFile(transcriptPath, transcriptContent, "utf8");

    const manifest = legacyManifest(id);
    manifest.worktrees[0]!.sessions[0]!.transcriptRef = { kind: "vst-json", path: transcriptPath };
    await writeLegacyManifest(id, manifest);

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();
    await migrateManifestsToSqlite(db);

    const row = db.prepare("SELECT transcriptKind, transcriptPath FROM sessions WHERE id = ?").get(`${id}-1-m`) as {
      transcriptKind: string;
      transcriptPath: string;
    };
    expect(row.transcriptKind).toBe("vst-json");
    expect(row.transcriptPath).toBe(transcriptPath);

    // The transcript file itself must be byte-identical and untouched — migration
    // only records metadata, it never reads/moves/copies/mutates the file.
    const afterContent = await readFile(transcriptPath, "utf8");
    expect(afterContent).toBe(transcriptContent);
  });

  it("1.T6 copies tmux session identity (id/tmuxName) verbatim, including across a re-run", async () => {
    const id = "proj-tmux";
    const manifest = legacyManifest(id);
    // Distinctive, real-looking pre-existing tmux name — NOT the trivial
    // `vr-${id}-1-m` from the shared fixture — to catch any regeneration.
    const distinctiveId = `${id}-1-m`;
    const distinctiveTmuxName = "vr-proj-tmux-7-a3";
    manifest.worktrees[0]!.sessions[0]!.id = distinctiveId;
    manifest.worktrees[0]!.sessions[0]!.tmuxName = distinctiveTmuxName;
    await writeLegacyManifest(id, manifest);

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();
    await migrateManifestsToSqlite(db);

    const row1 = db.prepare("SELECT id, tmuxName FROM sessions WHERE id = ?").get(distinctiveId) as {
      id: string;
      tmuxName: string;
    };
    expect(row1.id).toBe(distinctiveId);
    expect(row1.tmuxName).toBe(distinctiveTmuxName);

    // Re-running migration (idempotent no-op via user_version) must not alter it.
    await migrateManifestsToSqlite(db);
    const row2 = db.prepare("SELECT id, tmuxName FROM sessions WHERE id = ?").get(distinctiveId) as {
      id: string;
      tmuxName: string;
    };
    expect(row2.id).toBe(distinctiveId);
    expect(row2.tmuxName).toBe(distinctiveTmuxName);
  });

  it("1.T7 preserves agentChatId unchanged", async () => {
    const id = "proj-chatid";
    const manifest = legacyManifest(id);
    const chatId = "chat_9f3a1e7b-resume-token";
    manifest.worktrees[0]!.sessions[0]!.agentChatId = chatId;
    await writeLegacyManifest(id, manifest);

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();
    await migrateManifestsToSqlite(db);

    const row = db.prepare("SELECT agentChatId FROM sessions WHERE id = ?").get(`${id}-1-m`) as {
      agentChatId: string;
    };
    expect(row.agentChatId).toBe(chatId);
  });

  it("1.T8 a migrated session's worktreeId FK correctly points at the migrated worktree row", async () => {
    const id = "proj-fk";
    await writeLegacyManifest(id);

    const { getDb } = await import("../state/db.js");
    const { migrateManifestsToSqlite } = await import("../services/dbMigration.js");
    const db = getDb();
    await migrateManifestsToSqlite(db);

    // Join sessions -> worktrees -> projects to confirm the FK resolves to the
    // right row, not just that the raw column value happens to match a string.
    const joined = db
      .prepare(
        `SELECT s.id AS sessionId, w.id AS worktreeId, w.projectId AS worktreeProjectId
         FROM sessions s
         JOIN worktrees w ON w.id = s.worktreeId
         WHERE s.id = ?`,
      )
      .get(`${id}-1-m`) as { sessionId: string; worktreeId: string; worktreeProjectId: string } | undefined;

    expect(joined).toBeDefined();
    expect(joined!.worktreeId).toBe(`${id}-1`);
    expect(joined!.worktreeProjectId).toBe(id);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSchema } from "../services/dbSchema.js";

let tempDir: string;

describe("ensureSchema — branchIsPlaceholder column (branch-name-optional)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-dbschema-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fresh database: CREATE TABLE already includes branchIsPlaceholder, defaulting to 0", () => {
    const db = new Database(join(tempDir, "fresh.db"));
    ensureSchema(db);

    const columns = db.pragma("table_info(worktrees)") as { name: string }[];
    expect(columns.some((c) => c.name === "branchIsPlaceholder")).toBe(true);

    db.prepare(
      `INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('proj-1', '/fake/proj-1', 'proj', 1, ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder)
       VALUES ('wt-1', 'proj-1', 'main-ish', ?, 0)`,
    ).run(new Date().toISOString());
    const row = db.prepare("SELECT branchIsPlaceholder FROM worktrees WHERE id = ?").get("wt-1") as {
      branchIsPlaceholder: number;
    };
    expect(row.branchIsPlaceholder).toBe(0);
    db.close();
  });

  it("already-migrated database (pre-existing worktrees table without the column) gets it backfilled via ALTER TABLE, preserving existing rows", () => {
    const dbPath = join(tempDir, "legacy.db");
    const db = new Database(dbPath);

    // Simulate a `worktrees` table shape from before this column existed —
    // i.e. what `CURRENT_SCHEMA_VERSION`'s CREATE TABLE looked like prior to
    // this feature, already populated with a real row.
    db.exec(`
      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT,
        branch TEXT NOT NULL,
        baseBranch TEXT,
        baseSha TEXT,
        createdAt TEXT NOT NULL,
        pinnedAt TEXT,
        sortOrder REAL NOT NULL,
        terminalSeq INTEGER NOT NULL DEFAULT 0,
        agentSeq INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      `INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder) VALUES ('wt-old', 'proj-old', 'legacy-branch', ?, 0)`,
    ).run(new Date().toISOString());

    let columns = db.pragma("table_info(worktrees)") as { name: string }[];
    expect(columns.some((c) => c.name === "branchIsPlaceholder")).toBe(false);

    // ensureSchema is called on every getDb() open — this is that boot pass
    // against an already-migrated (pre-this-feature) database.
    ensureSchema(db);

    columns = db.pragma("table_info(worktrees)") as { name: string }[];
    expect(columns.some((c) => c.name === "branchIsPlaceholder")).toBe(true);

    // The pre-existing row survived the ALTER TABLE, with the new column
    // defaulting to 0 (never a placeholder — it predates the concept).
    const row = db.prepare("SELECT * FROM worktrees WHERE id = ?").get("wt-old") as {
      branch: string;
      branchIsPlaceholder: number;
    };
    expect(row.branch).toBe("legacy-branch");
    expect(row.branchIsPlaceholder).toBe(0);

    // Calling ensureSchema again (next boot) must be a no-op, not a duplicate-column error.
    expect(() => ensureSchema(db)).not.toThrow();
    db.close();
  });
});

describe("ensureSchema — hiddenAt column (hide-worktrees)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-dbschema-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fresh database: CREATE TABLE already includes hiddenAt, defaulting to NULL", () => {
    const db = new Database(join(tempDir, "fresh.db"));
    ensureSchema(db);

    const columns = db.pragma("table_info(worktrees)") as { name: string }[];
    expect(columns.some((c) => c.name === "hiddenAt")).toBe(true);

    db.prepare(
      `INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('proj-1', '/fake/proj-1', 'proj', 1, ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder)
       VALUES ('wt-1', 'proj-1', 'main-ish', ?, 0)`,
    ).run(new Date().toISOString());
    const row = db.prepare("SELECT hiddenAt FROM worktrees WHERE id = ?").get("wt-1") as {
      hiddenAt: string | null;
    };
    expect(row.hiddenAt).toBeNull();
    db.close();
  });

  it("already-migrated database (pre-existing worktrees table without the column) gets it backfilled via ALTER TABLE, preserving existing rows", () => {
    const dbPath = join(tempDir, "legacy.db");
    const db = new Database(dbPath);

    // Simulate a `worktrees` table shape from before this feature existed.
    db.exec(`
      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT,
        branch TEXT NOT NULL,
        baseBranch TEXT,
        baseSha TEXT,
        createdAt TEXT NOT NULL,
        pinnedAt TEXT,
        sortOrder REAL NOT NULL,
        terminalSeq INTEGER NOT NULL DEFAULT 0,
        agentSeq INTEGER NOT NULL DEFAULT 0,
        branchIsPlaceholder INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      `INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder) VALUES ('wt-old', 'proj-old', 'legacy-branch', ?, 0)`,
    ).run(new Date().toISOString());

    let columns = db.pragma("table_info(worktrees)") as { name: string }[];
    expect(columns.some((c) => c.name === "hiddenAt")).toBe(false);

    ensureSchema(db);

    columns = db.pragma("table_info(worktrees)") as { name: string }[];
    expect(columns.some((c) => c.name === "hiddenAt")).toBe(true);

    const row = db.prepare("SELECT * FROM worktrees WHERE id = ?").get("wt-old") as {
      branch: string;
      hiddenAt: string | null;
    };
    expect(row.branch).toBe("legacy-branch");
    expect(row.hiddenAt).toBeNull();

    expect(() => ensureSchema(db)).not.toThrow();
    db.close();
  });
});

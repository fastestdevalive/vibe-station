/**
 * Project store — SQLite-backed (`vibe-station.db` is the sole source of
 * truth, no in-memory cache). Every read hits the DB directly; the
 * per-project mutex (`withProjectLock`) still serializes writes within one
 * process so a read-modify-write via `mutateProject` can't lose an update.
 *
 * Public function signatures are byte-identical to the pre-SQLite version —
 * every route handler and service depends on them staying that way,
 * INCLUDING `mutateProject`'s `Promise<ProjectRecord>` return (not `void`).
 */
import type { ProjectRecord, SessionRecord, WorktreeRecord } from "../types.js";
import { withProjectLock } from "../services/mutex.js";
import { getDb } from "./db.js";
import { migrateManifestsToSqlite } from "../services/dbMigration.js";
import {
  rowToProject,
  rowToWorktree,
  rowToSession,
  projectToRow,
  worktreeToRow,
  sessionToRow,
  type ProjectRow,
  type WorktreeRow,
  type SessionRow,
} from "./sqliteRowMappers.js";

/**
 * Boot-time entry point: migrate every project's `manifest.json` into
 * `vibe-station.db` (idempotent, see `dbMigration.ts`). There is no in-memory
 * store to "load" anymore — every read already goes straight to SQLite — this
 * just runs the one-time migration and kept its old name so `main.ts`'s boot
 * sequence didn't need to change shape.
 */
export async function loadAll(): Promise<void> {
  await migrateManifestsToSqlite(getDb());
}

/** Read one project (with its worktrees + sessions) straight from the DB. No caching. */
export function getProject(id: string): ProjectRecord | undefined {
  const db = getDb();
  const projectRow = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!projectRow) return undefined;
  return assembleProject(projectRow);
}

/** Read every project from the DB. No caching. */
export function getAllProjects(): ProjectRecord[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM projects").all() as ProjectRow[];
  return rows.map(assembleProject);
}

function assembleProject(projectRow: ProjectRow): ProjectRecord {
  const db = getDb();
  const worktreeRows = db
    .prepare("SELECT * FROM worktrees WHERE projectId = ? ORDER BY sortOrder ASC")
    .all(projectRow.id) as WorktreeRow[];
  const worktrees = worktreeRows.map((wRow) => {
    const sessionRows = db
      .prepare("SELECT * FROM sessions WHERE worktreeId = ? ORDER BY sortOrder ASC")
      .all(wRow.id) as SessionRow[];
    return rowToWorktree(wRow, sessionRows.map(rowToSession));
  });
  const directRows = db
    .prepare("SELECT * FROM sessions WHERE projectId = ? AND worktreeId IS NULL ORDER BY sortOrder ASC")
    .all(projectRow.id) as SessionRow[];
  return rowToProject(projectRow, worktrees, directRows.map(rowToSession));
}

/**
 * Replace every worktree/session row for a project with what's in `record`,
 * then upsert the project's own scalar columns. Simple full-replace strategy
 * (delete-then-reinsert children) rather than a diff — correct and easy to
 * reason about at the scale a local per-user daemon operates at. Runs inside
 * a single transaction so a mid-write failure never leaves the DB half
 * updated.
 */
function writeProjectFull(record: ProjectRecord): void {
  const db = getDb();
  const txn = db.transaction((p: ProjectRecord) => {
    const projectRow = projectToRow(p);
    db.prepare(
      `INSERT INTO projects (id, absolutePath, prefix, isGit, defaultBranch, createdAt, hidden, directSessionSeq, nextWorktreeNum)
       VALUES (@id, @absolutePath, @prefix, @isGit, @defaultBranch, @createdAt, @hidden, @directSessionSeq, @nextWorktreeNum)
       ON CONFLICT(id) DO UPDATE SET
         absolutePath = excluded.absolutePath,
         prefix = excluded.prefix,
         isGit = excluded.isGit,
         defaultBranch = excluded.defaultBranch,
         createdAt = excluded.createdAt,
         hidden = excluded.hidden,
         directSessionSeq = excluded.directSessionSeq,
         nextWorktreeNum = excluded.nextWorktreeNum`,
    ).run(projectRow);

    // Delete sessions first (covers both worktree-scoped and direct sessions
    // in one shot via `projectId`), then worktrees — avoids relying on FK
    // cascade ordering across two separate parent tables.
    db.prepare("DELETE FROM sessions WHERE projectId = ?").run(p.id);
    db.prepare("DELETE FROM worktrees WHERE projectId = ?").run(p.id);

    const insertWorktree = db.prepare(
      `INSERT INTO worktrees (id, projectId, name, branch, baseBranch, baseSha, createdAt, pinnedAt, sortOrder, terminalSeq, agentSeq, branchIsPlaceholder)
       VALUES (@id, @projectId, @name, @branch, @baseBranch, @baseSha, @createdAt, @pinnedAt, @sortOrder, @terminalSeq, @agentSeq, @branchIsPlaceholder)`,
    );
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, worktreeId, projectId, isMain, sortOrder, type, modeId, name, nameSource, tmuxName, useTmux, channel, state, reason, lastTransitionAt, transcriptKind, transcriptPath, agentChatId, modelOverride, pinnedAt, initialPrompt, archivedAt, handoffSummary)
       VALUES (@id, @worktreeId, @projectId, @isMain, @sortOrder, @type, @modeId, @name, @nameSource, @tmuxName, @useTmux, @channel, @state, @reason, @lastTransitionAt, @transcriptKind, @transcriptPath, @agentChatId, @modelOverride, @pinnedAt, @initialPrompt, @archivedAt, @handoffSummary)`,
    );

    for (const w of p.worktrees) {
      insertWorktree.run(worktreeToRow(w, p.id));
      for (const s of w.sessions) {
        insertSession.run(sessionToRow(s, p.id, w.id));
      }
    }
    for (const s of p.directSessions) {
      insertSession.run(sessionToRow(s, p.id, null));
    }
  });
  txn(record);
}

/**
 * Atomically mutate a project and persist it to `vibe-station.db`.
 * The mutation function receives the current record and MUST return the updated record.
 * If the project doesn't exist, throws an error.
 */
export async function mutateProject(
  id: string,
  fn: (record: ProjectRecord) => ProjectRecord,
): Promise<ProjectRecord> {
  return withProjectLock(id, async () => {
    const existing = getProject(id);
    if (!existing) {
      throw new Error(`Project '${id}' not found`);
    }
    const updated = fn(existing);
    writeProjectFull(updated);
    return updated;
  });
}

/**
 * Add a new project to the DB.
 * Throws if a project with the same id already exists.
 */
export async function addProject(record: ProjectRecord): Promise<void> {
  return withProjectLock(record.id, async () => {
    if (getProject(record.id)) {
      throw new Error(`Project '${record.id}' already exists`);
    }
    writeProjectFull(record);
  });
}

/**
 * Remove a project (and, via ON DELETE CASCADE, its worktrees/sessions rows)
 * from the DB. Does NOT clean up worktree directories or tmux sessions — caller must do that.
 */
export async function deleteProject(id: string): Promise<void> {
  return withProjectLock(id, async () => {
    const db = getDb();
    if (!getProject(id)) {
      throw new Error(`Project '${id}' not found`);
    }
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  });
}

/** For testing: wipe every row so tests start from a clean DB. */
export function _clearStoreForTest(): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM worktrees").run();
  db.prepare("DELETE FROM projects").run();
}

// Re-exported so callers that previously imported types alongside this module
// keep working without an extra import line.
export type { ProjectRecord, WorktreeRecord, SessionRecord };

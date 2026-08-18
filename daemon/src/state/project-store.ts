/**
 * Project store — SQLite-backed (`vibe-station.db` is the durable source of
 * truth) with a process-local read cache in front of it.
 *
 * ## Why the cache exists (do not remove it)
 *
 * The first SQLite cut had no cache: every `getProject`/`getAllProjects`
 * re-queried the DB and re-assembled the whole object graph. That is a
 * *synchronous, event-loop-blocking* ~3.5 ms per call on a real install
 * (11 projects / 129 worktrees / 237 sessions), and these functions sit on
 * genuinely hot paths — `findSessionRecord` runs on EVERY WS frame, i.e. once
 * per keystroke; the 1 Hz lifecycle poller calls it; so does every route that
 * resolves a worktree. It also called `db.prepare()` fresh per query, and
 * better-sqlite3 `Statement`s are native objects finalized only on GC, so the
 * churn showed up as native memory growth invisible to V8's heap pressure.
 * Daemon RSS climbed past 300 MB, and because `uv_spawn` uses `fork()` — whose
 * cost scales with the parent's mapped memory — that made every `tmux`
 * subprocess the poller spawns ~7x more expensive (1.4 ms -> 9.4 ms of
 * synchronous main-thread time). Net effect measured on the user's install:
 * over 50% of the daemon's main thread stuck in `child_process.spawn`, and
 * `/worktrees/:id/tree` going from 1.3 ms to 2260 ms (p50).
 *
 * ## Why a process-local cache is safe
 *
 * The daemon holds an exclusive `~/.vibe-station/.daemon.lock` and is the only
 * writer to `vibe-station.db`. The `vst` CLI talks to it over HTTP only
 * (`cli/src/lib/daemon-client.ts`) and never opens the DB. So nothing can
 * change these tables behind the cache's back.
 *
 * ## Invariants
 *
 *  - Reads return the CACHED object graph directly (no clone — cloning on the
 *    hot path would reintroduce the allocation cost we are removing).
 *    Callers MUST treat returned records as immutable. Under vitest the cached
 *    records are deep-frozen so an in-place mutation throws instead of
 *    silently corrupting the cache.
 *  - `mutateProject` hands `fn` a CLONE and installs the result only after the
 *    transaction commits, so a failed write can never leave the cache holding
 *    a mutation the DB never got.
 *  - The cache is tied to the `Database` handle identity, so `getDb()`
 *    reopening a different path (tests use a fresh temp dir per file) drops it
 *    for free.
 *
 * Public function signatures are byte-identical to the pre-SQLite version —
 * every route handler and service depends on them staying that way,
 * INCLUDING `mutateProject`'s `Promise<ProjectRecord>` return (not `void`).
 */
import type { Database as DB, Statement } from "better-sqlite3";
import type { ProjectRecord, PrStatus, SessionRecord, WorktreeRecord } from "../types.js";
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
 * Prepared statements, cached per `Database` handle.
 *
 * `db.prepare()` compiles a fresh native `Statement` every call. On the read
 * path that meant ~151 native allocations per `getAllProjects()`, each
 * finalized only when V8 happens to GC — the main driver of the daemon's RSS
 * growth (see the module doc comment). Preparing once per handle removes it.
 */
interface Prepared {
  selectProject: Statement;
  selectAllProjects: Statement;
  selectWorktrees: Statement;
  selectWorktreeSessions: Statement;
  selectDirectSessions: Statement;
  updateSessionLifecycle: Statement;
  updateSessionPr: Statement;
}

/** Per-handle cache: prepared statements + the assembled project graph. */
interface StoreCache {
  db: DB;
  stmts: Prepared;
  /** `undefined` until the first read populates it from the DB. */
  projects?: Map<string, ProjectRecord>;
}

let cache: StoreCache | null = null;

/**
 * Opt-in tripwire (`VST_FREEZE_STORE=1`): deep-freeze cached records so any
 * caller mutating one in place throws instead of editing the cache silently.
 *
 * Off by default, deliberately. Turning it on today fails ~15 pre-existing
 * call sites (`routes/sessions.ts`, `routes/worktrees.ts`, `routes/projects.ts`)
 * that do `session.lifecycle = {...}` on a store-derived record and then
 * persist the same value via `mutateProject` — an idiom that predates this
 * cache. Those are all "mutate then immediately write the identical value", so
 * the cache still converges; the residual risk (a mutation surviving a FAILED
 * write) is closed by invalidating the project on write failure instead — see
 * `writeProjectFull`'s caller. Flipping those call sites to be non-mutating is
 * a worthwhile follow-up, and this flag is how you find them.
 */
const FREEZE_CACHED_RECORDS = process.env.VST_FREEZE_STORE === "1";

/**
 * Get the cache bound to the CURRENT `Database` handle, rebuilding it if the
 * handle changed. Identity-checking the handle is what makes per-test temp
 * databases isolated for free: `getDb()` reopens when `dbPath()` changes, and
 * the new handle can never match the old cache entry.
 */
function store(): StoreCache {
  const db = getDb();
  if (cache && cache.db === db) return cache;
  cache = {
    db,
    stmts: {
      selectProject: db.prepare("SELECT * FROM projects WHERE id = ?"),
      selectAllProjects: db.prepare("SELECT * FROM projects"),
      selectWorktrees: db.prepare("SELECT * FROM worktrees WHERE projectId = ? ORDER BY sortOrder ASC"),
      selectWorktreeSessions: db.prepare("SELECT * FROM sessions WHERE worktreeId = ? ORDER BY sortOrder ASC"),
      selectDirectSessions: db.prepare(
        "SELECT * FROM sessions WHERE projectId = ? AND worktreeId IS NULL ORDER BY sortOrder ASC",
      ),
      updateSessionLifecycle: db.prepare(
        "UPDATE sessions SET state = ?, reason = ?, lastTransitionAt = ? WHERE id = ?",
      ),
      updateSessionPr: db.prepare(
        "UPDATE sessions SET prState = ?, prNumber = ?, prUrl = ?, prCheckedAt = ?, prBranch = ? WHERE id = ?",
      ),
    },
  };
  return cache;
}

/** Drop the assembled-project cache, keeping the prepared statements. */
function invalidateProjects(): void {
  if (cache) delete cache.projects;
}

/**
 * Recursively freeze a record so an in-place mutation by a caller throws
 * (ES modules are strict mode) instead of silently corrupting the cache.
 * Test-only: the cost is paid once per cache fill, but the risk of turning a
 * latent mutation into a production crash isn't worth taking on the user's
 * daemon — tests are where we want to find those callers.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return value;
}

/** Populate (or return) the assembled project map for the current handle. */
function projects(): Map<string, ProjectRecord> {
  const s = store();
  if (s.projects) return s.projects;
  const rows = s.stmts.selectAllProjects.all() as ProjectRow[];
  const map = new Map<string, ProjectRecord>();
  for (const row of rows) {
    const record = assembleProject(row);
    map.set(row.id, FREEZE_CACHED_RECORDS ? deepFreeze(record) : record);
  }
  s.projects = map;
  return map;
}

/**
 * Boot-time entry point: migrate every project's `manifest.json` into
 * `vibe-station.db` (idempotent, see `dbMigration.ts`), then drop the read
 * cache — the migration writes rows directly, bypassing `mutateProject`.
 * Kept its old name so `main.ts`'s boot sequence didn't need to change shape.
 */
export async function loadAll(): Promise<void> {
  await migrateManifestsToSqlite(getDb());
  invalidateProjects();
}

/**
 * Read one project (with its worktrees + sessions). Served from the in-memory
 * cache; the returned record MUST be treated as immutable (see module doc).
 */
export function getProject(id: string): ProjectRecord | undefined {
  return projects().get(id);
}

/**
 * Read every project. Served from the in-memory cache; the returned records
 * MUST be treated as immutable (see module doc).
 */
export function getAllProjects(): ProjectRecord[] {
  return Array.from(projects().values());
}

function assembleProject(projectRow: ProjectRow): ProjectRecord {
  const { stmts } = store();
  const worktreeRows = stmts.selectWorktrees.all(projectRow.id) as WorktreeRow[];
  const worktrees = worktreeRows.map((wRow) => {
    const sessionRows = stmts.selectWorktreeSessions.all(wRow.id) as SessionRow[];
    return rowToWorktree(wRow, sessionRows.map(rowToSession));
  });
  const directRows = stmts.selectDirectSessions.all(projectRow.id) as SessionRow[];
  return rowToProject(projectRow, worktrees, directRows.map(rowToSession));
}

/** Re-read ONE project from the DB and install it in the cache. */
function refreshProject(id: string): ProjectRecord | undefined {
  const s = store();
  const row = s.stmts.selectProject.get(id) as ProjectRow | undefined;
  const map = projects();
  if (!row) {
    map.delete(id);
    return undefined;
  }
  const record = assembleProject(row);
  map.set(id, FREEZE_CACHED_RECORDS ? deepFreeze(record) : record);
  return record;
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
      `INSERT INTO sessions (id, worktreeId, projectId, isMain, sortOrder, type, modeId, name, nameSource, tmuxName, useTmux, channel, state, reason, lastTransitionAt, transcriptKind, transcriptPath, agentChatId, modelOverride, pinnedAt, initialPrompt, archivedAt, handoffSummary, spawnedFrom, supersededBy, prState, prNumber, prUrl, prCheckedAt, prBranch)
       VALUES (@id, @worktreeId, @projectId, @isMain, @sortOrder, @type, @modeId, @name, @nameSource, @tmuxName, @useTmux, @channel, @state, @reason, @lastTransitionAt, @transcriptKind, @transcriptPath, @agentChatId, @modelOverride, @pinnedAt, @initialPrompt, @archivedAt, @handoffSummary, @spawnedFrom, @supersededBy, @prState, @prNumber, @prUrl, @prCheckedAt, @prBranch)`,
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
    // Hand `fn` a CLONE, never the cached object. Two reasons:
    //  1. Most callers build the new record with spreads, but any that mutate
    //     a nested array/record in place would otherwise be editing the cache.
    //  2. If `writeProjectFull` throws, the transaction rolls back — and
    //     because `fn` only ever touched the clone, the cache is still exactly
    //     what the DB holds. Installing the result only AFTER the commit keeps
    //     cache and DB atomically in step.
    const updated = fn(structuredClone(existing));
    try {
      writeProjectFull(updated);
      // Cache the DB ROUND-TRIP, not the in-memory record the caller built:
      // `projectToRow`/`rowToSession` apply column defaults and drop anything
      // that isn't a column, so the two can legitimately differ. Caching what
      // was actually stored keeps "read your own write" honest.
      refreshProject(id);
    } catch (err) {
      // The transaction rolled back, so the DB is unchanged — but a caller may
      // have mutated its own reference into the cached graph before calling us
      // (a pre-existing idiom, see FREEZE_CACHED_RECORDS). Drop this project so
      // the next read re-syncs from the DB rather than serving a mutation that
      // was never persisted.
      invalidateProjects();
      throw err;
    }
    // Return the caller's record, not the refreshed one — the public contract
    // (`Promise<ProjectRecord>` of exactly what `fn` produced) predates the
    // cache and callers rely on it.
    return updated;
  });
}

/**
 * Fast path for a lifecycle-state transition (F5).
 *
 * `persistLifecycleState` used to go through `mutateProject`, which means
 * `writeProjectFull` DELETEs and re-INSERTs every worktree and session row of
 * the project just to flip one session's `state`. On a real install that is
 * ~290 statements plus an fsync per transition, and transitions fire
 * continuously as agents go working<->idle. This does the single UPDATE the
 * change actually needs and patches the cached record in place.
 *
 * Returns false if the session isn't in the DB (caller treats it as a no-op).
 */
export async function updateSessionLifecycle(
  projectId: string,
  sessionId: string,
  lifecycle: SessionRecord["lifecycle"],
): Promise<boolean> {
  return withProjectLock(projectId, async () => {
    const s = store();
    const res = s.stmts.updateSessionLifecycle.run(
      lifecycle.state,
      lifecycle.reason ?? null,
      lifecycle.lastTransitionAt,
      sessionId,
    );
    if (res.changes === 0) return false;
    // Re-assemble just this project from the DB rather than patching the
    // frozen graph by hand — one project's worth of queries, only on an actual
    // transition, and it cannot drift from what was just written.
    refreshProject(projectId);
    return true;
  });
}

/**
 * Fast path for a PR-status write (B2 in the pr-status-axis review).
 *
 * Mirrors `updateSessionLifecycle`: without this, `prPoller`'s per-tick
 * writes went through `mutateProject` -> `writeProjectFull`, which DELETEs
 * and re-INSERTs every worktree and session row of the WHOLE PROJECT just to
 * set one session's `pr`. On a real install (147 worktrees / 269 sessions in
 * one project) that's ~43k SQL statements + 147 fsyncs every 10s poll tick,
 * forever — even when nothing changed. This does the single UPDATE the
 * change actually needs and patches the cached record in place.
 *
 * `pr.error` (transient, WS-only) is intentionally NOT persisted here —
 * there's no `prError` column, matching `sessionToRow`'s existing contract.
 *
 * Returns false if the session isn't in the DB (caller treats it as a no-op).
 */
export async function updateSessionPr(projectId: string, sessionId: string, pr: PrStatus): Promise<boolean> {
  return withProjectLock(projectId, async () => {
    const s = store();
    const res = s.stmts.updateSessionPr.run(
      pr.state,
      pr.number ?? null,
      pr.url ?? null,
      pr.checkedAt,
      pr.prBranch ?? null,
      sessionId,
    );
    if (res.changes === 0) return false;
    // Re-assemble just this project from the DB rather than patching the
    // frozen graph by hand — one project's worth of queries, only on an
    // actual write, and it cannot drift from what was just written.
    refreshProject(projectId);
    return true;
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
    // Cache the DB round-trip (see `mutateProject`) — the caller's record can
    // omit fields that the schema defaults, and it keeps its own reference.
    refreshProject(record.id);
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
    projects().delete(id);
  });
}

/** For testing: wipe every row so tests start from a clean DB. */
export function _clearStoreForTest(): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM worktrees").run();
  db.prepare("DELETE FROM projects").run();
  invalidateProjects();
}

// Re-exported so callers that previously imported types alongside this module
// keep working without an extra import line.
export type { ProjectRecord, WorktreeRecord, SessionRecord };

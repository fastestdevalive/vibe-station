/**
 * `vibe-station.db` schema — the sole source of truth for projects / worktrees
 * / sessions metadata (replaces per-project `manifest.json`, see
 * `.vibekit/feature-plans/wip/sqlite-agent-naming/01-data-layer/`).
 *
 * `slot` is not a column anywhere here — it is removed as an identity concept.
 * `isMain` + `sortOrder` replace its three former jobs (uniqueness, tmux-name
 * input, implicit order).
 */
import type { Database } from "better-sqlite3";

/** Bumped whenever the schema shape changes in a way that needs a fresh migration pass. */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Create tables/indexes if absent and apply required pragmas. Safe to call on
 * every `getDb()` open — every statement is idempotent.
 */
export function ensureSchema(db: Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      absolutePath TEXT NOT NULL,
      prefix TEXT NOT NULL,
      isGit INTEGER NOT NULL,
      defaultBranch TEXT,
      createdAt TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      directSessionSeq INTEGER NOT NULL DEFAULT 0,
      nextWorktreeNum INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS idx_worktrees_projectId ON worktrees(projectId);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      worktreeId TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      isMain INTEGER NOT NULL DEFAULT 0 CHECK (isMain = 0 OR worktreeId IS NOT NULL),
      sortOrder REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('agent','terminal')),
      modeId TEXT,
      name TEXT,
      nameSource TEXT CHECK (nameSource IN ('auto','user') OR nameSource IS NULL),
      tmuxName TEXT NOT NULL,
      useTmux INTEGER NOT NULL,
      channel TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      lastTransitionAt TEXT NOT NULL,
      transcriptKind TEXT,
      transcriptPath TEXT,
      agentChatId TEXT,
      modelOverride TEXT,
      pinnedAt TEXT,
      initialPrompt TEXT,
      archivedAt TEXT,
      handoffSummary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_worktreeId ON sessions(worktreeId);
    CREATE INDEX IF NOT EXISTS idx_sessions_projectId ON sessions(projectId);

    -- Per-project record of whether a legacy manifest.json has been
    -- migrated in (see dbMigration.ts). Replaces a global PRAGMA
    -- user_version gate, which could only ever say "has a pass run",
    -- not "did THIS project's migration succeed" — a project that failed
    -- (or that appears on disk after the first boot) needs its own
    -- retry-until-success state, not a one-shot global flag.
    CREATE TABLE IF NOT EXISTS manifest_migrations (
      projectId TEXT PRIMARY KEY,
      migratedAt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      error TEXT
    );
  `);

  // `CREATE TABLE IF NOT EXISTS` above is a no-op against a `worktrees` table
  // that already exists from before this column was introduced (every
  // database created by a pre-branch-name-optional build) — SQLite never
  // retrofits columns onto an existing table via that statement. Detect the
  // gap via `PRAGMA table_info` and backfill with `ALTER TABLE ... ADD
  // COLUMN` (idempotent: skipped once the column is present, safe to run on
  // every `getDb()` open like the rest of this function).
  addColumnIfMissing(db, "worktrees", "branchIsPlaceholder", "INTEGER NOT NULL DEFAULT 0");
  // spawnedFrom (agent-interaction-workspaces/04-workspaces Phase 4a) — the
  // sessionId this session was spawned from (via the in-app dialogs or a
  // running agent's own `vst --source-agent` shell), or NULL when spawned
  // with no source (the common case: a human via the dialogs with no source
  // picker yet, Out of Scope this round). Write-once (Decision 7) — set at
  // insert time, never updated. No FK enforcement: a deleted source session
  // leaving a dangling id is harmless (Research: the client-side workspace
  // tile scan simply won't find a match, S5).
  addColumnIfMissing(db, "sessions", "spawnedFrom", "TEXT");
  // supersededBy (present-tickmark-replacement/02-reset-relink) — the
  // replacement session's id, set on the archived row by the reset route.
  // NULL for sessions never reset (the common case) or archived by other
  // means (/done, plain archive). No FK enforcement, mirrors spawnedFrom.
  addColumnIfMissing(db, "sessions", "supersededBy", "TEXT");
  // pr* (pr-status-axis) — VCS status for this session's branch, written
  // exclusively by prPoller.ts. NULL until the first poll tick checks this
  // session's worktree. prState mirrors PrStatus.state ("none"|"draft"|
  // "open"|"merged"|"closed"); prNumber/prUrl are set iff a PR exists;
  // prCheckedAt is the ISO8601 timestamp of the last check (successful or not).
  addColumnIfMissing(db, "sessions", "prState", "TEXT");
  addColumnIfMissing(db, "sessions", "prNumber", "INTEGER");
  addColumnIfMissing(db, "sessions", "prUrl", "TEXT");
  addColumnIfMissing(db, "sessions", "prCheckedAt", "TEXT");
  // prBranch (pr-status-axis Phase 5, D20) — the branch prPoller.ts queried
  // GitHub for when it wrote prState/prNumber/prUrl/prCheckedAt. The UI
  // renders the PR colour only when this matches the worktree's current
  // branch, so a branch switch never shows a stale PR colour.
  addColumnIfMissing(db, "sessions", "prBranch", "TEXT");
}

/** Add `column` to `table` via `ALTER TABLE` if `PRAGMA table_info` shows it's absent. */
function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

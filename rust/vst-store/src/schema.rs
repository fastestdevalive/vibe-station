//! SQLite schema — ports `daemon/src/services/dbSchema.ts` (`ensureSchema`).
//!
//! Creates tables/indexes if absent and applies required pragmas. Safe to call
//! on every store open — every statement is idempotent.

use rusqlite::Connection;

/// Bumped whenever the schema shape changes in a way that needs a fresh
/// migration pass. Mirrors `CURRENT_SCHEMA_VERSION` in dbSchema.ts.
pub const CURRENT_SCHEMA_VERSION: i64 = 1;

/// Create tables/indexes if absent and apply required pragmas. Idempotent.
pub fn ensure_schema(db: &Connection) -> rusqlite::Result<()> {
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "foreign_keys", "ON")?;

    db.execute_batch(
        "
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
      hiddenAt TEXT,
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

    CREATE TABLE IF NOT EXISTS manifest_migrations (
      projectId TEXT PRIMARY KEY,
      migratedAt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS user_ordered_lists (
      userId TEXT NOT NULL,
      scopeKey TEXT NOT NULL,
      itemIds TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (userId, scopeKey)
    );

    CREATE TABLE IF NOT EXISTS tunnel_state (
      id         INTEGER PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 0,
      currentUrl TEXT,
      currentPid INTEGER,
      startedAt  TEXT,
      port       INTEGER
    );

    CREATE TABLE IF NOT EXISTS global_drafts (
      id         TEXT PRIMARY KEY,
      draftPrompt TEXT,
      draftConfig TEXT,
      createdAt  TEXT NOT NULL
    );
  ",
    )?;

    add_column_if_missing(db, "global_drafts", "name", "TEXT")?;
    add_column_if_missing(db, "global_drafts", "nameSource", "TEXT")?;
    add_column_if_missing(db, "global_drafts", "sortOrder", "REAL")?;
    add_column_if_missing(
        db,
        "worktrees",
        "branchIsPlaceholder",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(db, "worktrees", "hiddenAt", "TEXT")?;
    add_column_if_missing(db, "sessions", "spawnedFrom", "TEXT")?;
    add_column_if_missing(db, "sessions", "supersededBy", "TEXT")?;
    add_column_if_missing(db, "sessions", "prState", "TEXT")?;
    add_column_if_missing(db, "sessions", "prNumber", "INTEGER")?;
    add_column_if_missing(db, "sessions", "prUrl", "TEXT")?;
    add_column_if_missing(db, "sessions", "prCheckedAt", "TEXT")?;
    add_column_if_missing(db, "sessions", "prBranch", "TEXT")?;
    add_column_if_missing(db, "sessions", "acpSessionId", "TEXT")?;
    add_column_if_missing(db, "sessions", "draftPrompt", "TEXT")?;
    add_column_if_missing(db, "sessions", "draftConfig", "TEXT")?;

    Ok(())
}

/// Add `column` to `table` via `ALTER TABLE` if `PRAGMA table_info` shows it's
/// absent. Idempotent — skipped once present.
fn add_column_if_missing(
    db: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> rusqlite::Result<()> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = db.prepare(&sql)?;
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    if cols.iter().any(|c| c == column) {
        return Ok(());
    }
    let alter = format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}");
    db.execute_batch(&alter)
}

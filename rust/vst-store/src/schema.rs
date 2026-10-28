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
      nextWorktreeNum INTEGER NOT NULL DEFAULT 1,
      lspEnabled INTEGER
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
      branchIsPlaceholder INTEGER NOT NULL DEFAULT 0,
      lspEnabled INTEGER
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

    -- NO foreign key to sessions on purpose: every project save deletes and
    -- re-inserts that project's sessions (see `save_project`), and an
    -- `ON DELETE CASCADE` here silently wiped every pending scheduled message.
    -- Rows for genuinely deleted sessions are purged explicitly
    -- (`purge_scheduled_messages_for_missing_sessions`).
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id            TEXT PRIMARY KEY,
      sessionId     TEXT NOT NULL,
      message       TEXT NOT NULL,
      attachments   TEXT,
      fireAt        TEXT NOT NULL,
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','cancelled','failed')),
      sentAt        TEXT,
      sentTurnId    TEXT,
      failureReason TEXT,
      claimedAt     TEXT
    );
  ",
    )?;

    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_scheduled_messages_sessionId ON scheduled_messages(sessionId);",
    )?;
    // Delivery claim (set while a delivery is in flight) — added as a column so
    // databases that already created the table pick it up.
    add_column_if_missing(db, "scheduled_messages", "claimedAt", "TEXT")?;
    drop_scheduled_messages_session_fk(db)?;
    // Terminal-delivery columns. MUST come after the FK rebuild above: that
    // rebuild copies a fixed column list, so a column added before it would be
    // dropped on a legacy database.
    add_column_if_missing(db, "scheduled_messages", "channel", "TEXT")?;
    add_column_if_missing(db, "scheduled_messages", "deliveryPhase", "TEXT")?;
    add_column_if_missing(db, "scheduled_messages", "failureKind", "TEXT")?;
    add_column_if_missing(db, "scheduled_messages", "commentsSnapshot", "TEXT")?;
    add_column_if_missing(db, "scheduled_messages", "origin", "TEXT")?;
    // The poller's due-scan: `status = 'pending' AND fireAt <= now`.
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(status, fireAt);",
    )?;

    // Artifacts: files agents wrote, per worktree/project scope. NO foreign
    // keys on purpose (same reason as `scheduled_messages`: a project save
    // re-inserts worktrees/sessions, so a cascade would wipe every row);
    // `scopeId` / `writers` are soft references, purged explicitly
    // (`purge_scope`, `purge_orphan_artifacts`). `CURRENT_SCHEMA_VERSION` stays
    // 1 (additive). Later columns MUST go through `add_column_if_missing`
    // below, never only into this `CREATE TABLE`.
    db.execute_batch(
        "
    CREATE TABLE IF NOT EXISTS artifacts (
      id            TEXT PRIMARY KEY,
      scopeKind     TEXT NOT NULL CHECK (scopeKind IN ('worktree','project')),
      scopeId       TEXT NOT NULL,
      path          TEXT NOT NULL,
      pathKey       TEXT NOT NULL,
      inRepo        INTEGER NOT NULL,
      hash          TEXT,
      size          INTEGER,
      mtimeMs       INTEGER,
      pinned        INTEGER NOT NULL DEFAULT 0,
      pinnedAt      TEXT,
      hidden        INTEGER NOT NULL DEFAULT 0,
      missing       INTEGER NOT NULL DEFAULT 0,
      editCount     INTEGER NOT NULL DEFAULT 1,
      writers       TEXT NOT NULL DEFAULT '[]',
      addedVia      TEXT NOT NULL DEFAULT 'capture',
      createdAt     TEXT NOT NULL,
      lastWrittenAt TEXT NOT NULL,
      checkedAt     TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_scope_pathkey ON artifacts(scopeKind, scopeId, pathKey);
    CREATE INDEX IF NOT EXISTS idx_artifacts_scope_written ON artifacts(scopeKind, scopeId, lastWrittenAt DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_scope_hash ON artifacts(scopeKind, scopeId, hash);
  ",
    )?;

    // Review comments and their pin numbers (`MAX(pin)+1` per scope). A Rich Chat send marks
    // rows `heldBy` (hidden from every reader) until the turn persists. NO
    // foreign keys on purpose (same reason as above: a project save re-inserts
    // worktrees/sessions); `scopeId` / `sessionId` are soft references, purged
    // explicitly. Later columns MUST go through `add_column_if_missing`.
    db.execute_batch(
        "
    CREATE TABLE IF NOT EXISTS comments (
      id              TEXT PRIMARY KEY,
      scopeKind       TEXT NOT NULL CHECK (scopeKind IN ('worktree','project')),
      scopeId         TEXT NOT NULL,
      pin             INTEGER NOT NULL,
      path            TEXT NOT NULL,
      pathKind        TEXT NOT NULL CHECK (pathKind IN ('repo','artifact')),
      surface         TEXT NOT NULL,
      diffScope       TEXT,
      baseSha         TEXT,
      side            TEXT,
      lineStart       INTEGER,
      lineEnd         INTEGER,
      oldStart        INTEGER,
      oldEnd          INTEGER,
      newStart        INTEGER,
      newEnd          INTEGER,
      quote           TEXT NOT NULL,
      prefix          TEXT NOT NULL DEFAULT '',
      suffix          TEXT NOT NULL DEFAULT '',
      occurrence      INTEGER NOT NULL DEFAULT 0,
      text            TEXT NOT NULL,
      anchor          TEXT NOT NULL DEFAULT 'anchored',
      anchorReason    TEXT,
      curStart        INTEGER,
      curEnd          INTEGER,
      movedFrom       TEXT,
      attachedTo      TEXT,
      attachedAt      TEXT,
      attachTouchedAt TEXT,
      restoredReason  TEXT,
      blockBytes      INTEGER NOT NULL DEFAULT 0,
      version         INTEGER NOT NULL DEFAULT 1,
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_scope_path ON comments(scopeKind, scopeId, path);
    CREATE INDEX IF NOT EXISTS idx_comments_attachedTo ON comments(attachedTo);

  ",
    )?;

    for col in ["heldBy", "heldSession", "heldTurn", "heldAt"] {
        add_column_if_missing(db, "comments", col, "TEXT")?;
    }
    db.execute_batch(
        "
    DROP INDEX IF EXISTS idx_comments_scope_pin;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_scope_pin_live
      ON comments(scopeKind, scopeId, pin) WHERE heldBy IS NULL;
    CREATE INDEX IF NOT EXISTS idx_comments_heldBy ON comments(heldBy) WHERE heldBy IS NOT NULL;
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
    add_column_if_missing(db, "projects", "lspEnabled", "INTEGER")?;
    add_column_if_missing(db, "worktrees", "lspEnabled", "INTEGER")?;
    add_column_if_missing(db, "worktrees", "hiddenAt", "TEXT")?;
    add_column_if_missing(db, "projects", "openFiles", "TEXT")?;
    add_column_if_missing(db, "worktrees", "openFiles", "TEXT")?;
    add_column_if_missing(db, "sessions", "spawnedFrom", "TEXT")?;
    add_column_if_missing(db, "sessions", "supersededBy", "TEXT")?;
    add_column_if_missing(db, "sessions", "prState", "TEXT")?;
    add_column_if_missing(db, "sessions", "prNumber", "INTEGER")?;
    add_column_if_missing(db, "sessions", "prUrl", "TEXT")?;
    add_column_if_missing(db, "sessions", "prCheckedAt", "TEXT")?;
    add_column_if_missing(db, "sessions", "prBranch", "TEXT")?;
    add_column_if_missing(db, "sessions", "prError", "TEXT")?;
    add_column_if_missing(db, "sessions", "prErrorKind", "TEXT")?;
    add_column_if_missing(db, "sessions", "acpSessionId", "TEXT")?;
    add_column_if_missing(db, "sessions", "draftPrompt", "TEXT")?;
    add_column_if_missing(db, "sessions", "draftConfig", "TEXT")?;
    add_column_if_missing(db, "sessions", "modeIcon", "TEXT")?;
    add_column_if_missing(db, "sessions", "lastActivityAt", "TEXT")?;
    add_column_if_missing(db, "sessions", "lastLine", "TEXT")?;
    add_column_if_missing(db, "sessions", "lastToolName", "TEXT")?;
    add_column_if_missing(db, "sessions", "lastToolDetail", "TEXT")?;
    add_column_if_missing(db, "sessions", "handoffCarryOver", "TEXT")?;

    Ok(())
}

/// Add `column` to `table` via `ALTER TABLE` if `PRAGMA table_info` shows it's
/// absent. Idempotent — skipped once present.
/// Early dev builds created `scheduled_messages` with
/// `sessionId REFERENCES sessions(id) ON DELETE CASCADE`; because a project
/// save deletes and re-inserts its sessions, that cascade wiped every pending
/// scheduled message. Rebuild such a table without the foreign key (rows kept).
fn drop_scheduled_messages_session_fk(db: &Connection) -> rusqlite::Result<()> {
    let sql: Option<String> = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_messages'",
            [],
            |r| r.get(0),
        )
        .ok();
    if !sql.is_some_and(|s| s.contains("REFERENCES")) {
        return Ok(());
    }
    db.execute_batch(
        "
    BEGIN;
    ALTER TABLE scheduled_messages RENAME TO scheduled_messages_old;
    CREATE TABLE scheduled_messages (
      id            TEXT PRIMARY KEY,
      sessionId     TEXT NOT NULL,
      message       TEXT NOT NULL,
      attachments   TEXT,
      fireAt        TEXT NOT NULL,
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','cancelled','failed')),
      sentAt        TEXT,
      sentTurnId    TEXT,
      failureReason TEXT,
      claimedAt     TEXT
    );
    INSERT INTO scheduled_messages
      (id, sessionId, message, attachments, fireAt, createdAt, updatedAt, status, sentAt, sentTurnId, failureReason, claimedAt)
      SELECT id, sessionId, message, attachments, fireAt, createdAt, updatedAt, status, sentAt, sentTurnId, failureReason, claimedAt
      FROM scheduled_messages_old;
    DROP TABLE scheduled_messages_old;
    COMMIT;
    ",
    )
}

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

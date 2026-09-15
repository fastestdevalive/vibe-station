//! Behavior contract for `dbSchema.ts` (part 01-storage).
//! Ported 1:1 from `daemon/src/__tests__/dbSchema.test.ts`.

use rusqlite::Connection;
use vst_store::schema::ensure_schema;

fn columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    cols
}

fn tables(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .unwrap();
    let names: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    names
}

#[test]
fn fresh_db_includes_branch_is_placeholder_default_0() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    let cols = columns(&conn, "worktrees");
    assert!(cols.iter().any(|c| c == "branchIsPlaceholder"));
    conn.execute(
        "INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('proj-1', '/fake/proj-1', 'proj', 1, ?1)",
        ["2024-01-01T00:00:00.000Z"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder) VALUES ('wt-1', 'proj-1', 'main-ish', ?1, 0)",
        ["2024-01-01T00:00:00.000Z"],
    )
    .unwrap();
    let val: i64 = conn
        .query_row(
            "SELECT branchIsPlaceholder FROM worktrees WHERE id = 'wt-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(val, 0);
}

#[test]
fn pre_existing_worktrees_without_branch_is_placeholder_gets_backfilled() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE worktrees (
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
        );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder) VALUES ('wt-old', 'proj-old', 'legacy-branch', ?1, 0)",
        ["2024-01-01T00:00:00.000Z"],
    )
    .unwrap();
    assert!(!columns(&conn, "worktrees")
        .iter()
        .any(|c| c == "branchIsPlaceholder"));
    ensure_schema(&conn).unwrap();
    let cols = columns(&conn, "worktrees");
    assert!(cols.iter().any(|c| c == "branchIsPlaceholder"));
    let (branch, ph): (String, i64) = conn
        .query_row(
            "SELECT branch, branchIsPlaceholder FROM worktrees WHERE id='wt-old'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(branch, "legacy-branch");
    assert_eq!(ph, 0);
    ensure_schema(&conn).unwrap();
}

#[test]
fn pre_existing_worktrees_without_hidden_at_gets_backfilled() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE worktrees (
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
        );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder) VALUES ('wt-old', 'proj-old', 'legacy-branch', ?1, 0)",
        ["2024-01-01T00:00:00.000Z"],
    )
    .unwrap();
    assert!(!columns(&conn, "worktrees").iter().any(|c| c == "hiddenAt"));
    ensure_schema(&conn).unwrap();
    assert!(columns(&conn, "worktrees").iter().any(|c| c == "hiddenAt"));
    let (branch, hidden): (String, Option<String>) = conn
        .query_row(
            "SELECT branch, hiddenAt FROM worktrees WHERE id='wt-old'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(branch, "legacy-branch");
    assert!(hidden.is_none());
    ensure_schema(&conn).unwrap();
}

#[test]
fn fresh_db_has_tunnel_state_table() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    let ts = tables(&conn);
    assert!(ts.iter().any(|t| t == "tunnel_state"));
}

#[test]
fn leaves_legacy_auth_sessions_table_untouched() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE auth_sessions (
            nonce TEXT PRIMARY KEY,
            createdAt TEXT NOT NULL,
            createdVia TEXT NOT NULL
        );",
    )
    .unwrap();
    conn.execute("INSERT INTO auth_sessions (nonce, createdAt, createdVia) VALUES ('n-old', '1', 'password')", [])
        .unwrap();
    ensure_schema(&conn).unwrap();
    let cols = columns(&conn, "auth_sessions");
    assert!(!cols.iter().any(|c| c == "tunnelUrl"));
    let n: String = conn
        .query_row(
            "SELECT nonce FROM auth_sessions WHERE nonce='n-old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, "n-old");
}

#[test]
fn fresh_db_does_not_create_auth_sessions_table() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    let ts = tables(&conn);
    assert!(!ts.iter().any(|t| t == "auth_sessions"));
}

#[test]
fn ensure_schema_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    ensure_schema(&conn).unwrap();
}

#[test]
fn all_expected_tables_present() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    for t in [
        "projects",
        "worktrees",
        "sessions",
        "manifest_migrations",
        "user_ordered_lists",
        "tunnel_state",
        "global_drafts",
    ] {
        assert!(tables(&conn).iter().any(|x| x == t), "missing table {t}");
    }
}

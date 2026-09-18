#![forbid(unsafe_code)]

//! `vst-store` — SQLite schema, migrations, and typed registries for
//! projects / worktrees / sessions / transcripts / ordered lists / tunnels.
//!
//! Ports the part-01 `daemon/src/**` storage files (see the daemon-rust-port
//! file-map). The public handle is `StoreHandle(Arc<Inner>)` per the
//! AppState/handle convention (arch Gotcha #14) — constructed with an explicit
//! DB path, no globals.
//!
//! **Async/blocking hygiene (Gotcha #4):** `rusqlite` is synchronous and is
//! never called directly on a tokio worker. Every DB-touching method routes its
//! work through `tokio::task::spawn_blocking`; per-project writes are further
//! serialized by a keyed async lock (mirroring the TS `withProjectLock`). Reads
//! are served from a process-local cache (`Inner.cache`) so hot read paths never
//! hit the DB.

pub mod migration;
pub mod row_mappers;
pub mod schema;
pub mod transcript;

pub mod ordered_lists;
pub mod tunnel;

pub mod global_drafts;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::{params, Connection, OptionalExtension};
use vst_types::{ProjectRecord, SessionLifecycle, SessionRecord, WorktreeRecord};

use crate::row_mappers::{
    project_to_row, row_to_project, row_to_session, row_to_worktree, session_to_row,
    worktree_to_row, ProjectRow, SessionRow, WorktreeRow,
};
use crate::schema::ensure_schema;

/// Errors surfaced by `vst-store`.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("project '{0}' not found")]
    NotFound(String),
    #[error("project '{0}' already exists")]
    AlreadyExists(String),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("mutation failed: {0}")]
    Mutation(String),
    #[error("migration failed for project '{0}': {1}")]
    Migration(String, String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Convenience result alias for the crate.
pub type StoreResult<T> = Result<T, StoreError>;

struct Inner {
    /// The single SQLite connection to `vibe-station.db` (single-writer).
    conn: Mutex<Connection>,
    /// Process-local read cache of assembled projects.
    cache: RwLock<HashMap<String, ProjectRecord>>,
    /// True once the cache has been loaded from the DB at least once.
    loaded: AtomicBool,
    /// Serializes the first (cold) cache load.
    load_lock: tokio::sync::Mutex<()>,
    /// Per-project keyed async locks (mirrors `withProjectLock`).
    project_locks: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// The store handle. Clone is cheap; all DB work is off the tokio worker.
#[derive(Clone)]
pub struct StoreHandle(Arc<Inner>);

impl std::fmt::Debug for StoreHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreHandle").finish_non_exhaustive()
    }
}

impl StoreHandle {
    /// Open (creating if absent) the store at `db_path`, applying the schema.
    pub fn open(db_path: impl AsRef<Path>) -> StoreResult<Self> {
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(db_path)?;
        ensure_schema(&conn)?;
        Ok(StoreHandle(Arc::new(Inner {
            conn: Mutex::new(conn),
            cache: RwLock::new(HashMap::new()),
            loaded: AtomicBool::new(false),
            load_lock: tokio::sync::Mutex::new(()),
            project_locks: std::sync::Mutex::new(HashMap::new()),
        })))
    }

    /// Test-only access to the raw connection. NOT for use on a tokio worker in
    /// production (Gotcha #4); provided so tests can inspect DB contents
    /// directly on a plain (non-runtime) thread.
    #[doc(hidden)]
    pub fn raw_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.conn.lock().unwrap()
    }

    /// Acquire the per-project async lock for `id`.
    async fn project_lock(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let arc = {
            let mut map = self.0.project_locks.lock().unwrap();
            map.entry(id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        arc.lock_owned().await
    }

    /// Load the read cache from the DB once (idempotent, race-safe).
    async fn ensure_loaded(&self) {
        if self.0.loaded.load(Ordering::Acquire) {
            return;
        }
        let _guard = self.0.load_lock.lock().await;
        if self.0.loaded.load(Ordering::Acquire) {
            return;
        }
        let inner = self.0.clone();
        let inner2 = inner.clone();
        let map = tokio::task::spawn_blocking(move || load_all_projects(&inner2))
            .await
            .unwrap_or_default();
        *inner.cache.write().unwrap() = map;
        inner.loaded.store(true, Ordering::Release);
    }

    /// Read one project (with worktrees + sessions) from the cache.
    pub async fn get_project(&self, id: &str) -> Option<ProjectRecord> {
        self.ensure_loaded().await;
        self.0.cache.read().unwrap().get(id).cloned()
    }

    /// Read every project from the cache.
    pub async fn get_all_projects(&self) -> Vec<ProjectRecord> {
        self.ensure_loaded().await;
        self.0.cache.read().unwrap().values().cloned().collect()
    }

    /// Resolve a session id to its `(project, session)` pair, scanning worktree
    /// sessions AND direct sessions (a project's `direct_sessions` have no
    /// worktree — a prior Node bug hid them from the WS lookup entirely and
    /// answered "Session not found" for live, healthy agents).
    ///
    /// This exists so the hot WS paths (`session:open`/`input`/`resize`) do not
    /// have to deep-clone the ENTIRE store via `get_all_projects()` on every
    /// single message just to find one record: only the matched pair is cloned.
    ///
    /// `ensure_loaded()` first, exactly like `get_project`/`get_all_projects` —
    /// without it this silently returns `None` (read as "session not found") on
    /// the very first message after a cold daemon start.
    pub async fn find_session(&self, session_id: &str) -> Option<(ProjectRecord, SessionRecord)> {
        self.ensure_loaded().await;
        let cache = self.0.cache.read().unwrap();
        for project in cache.values() {
            for worktree in &project.worktrees {
                if let Some(session) = worktree.sessions.iter().find(|s| s.id == session_id) {
                    return Some((project.clone(), session.clone()));
                }
            }
            if let Some(direct) = project.direct_sessions.iter().find(|s| s.id == session_id) {
                return Some((project.clone(), direct.clone()));
            }
        }
        None
    }

    /// Synchronous read of a session from the in-memory cache without awaiting
    /// `ensure_loaded()`. Used by non-async caller paths (e.g. `NotifyDeps::lookup`).
    pub fn find_session_cached(&self, session_id: &str) -> Option<(ProjectRecord, SessionRecord)> {
        let cache = self.0.cache.read().unwrap();
        for project in cache.values() {
            for worktree in &project.worktrees {
                if let Some(session) = worktree.sessions.iter().find(|s| s.id == session_id) {
                    return Some((project.clone(), session.clone()));
                }
            }
            if let Some(direct) = project.direct_sessions.iter().find(|s| s.id == session_id) {
                return Some((project.clone(), direct.clone()));
            }
        }
        None
    }

    /// Add a new project. Errors if a project with the same id already exists.
    pub async fn add_project(&self, record: ProjectRecord) -> StoreResult<()> {
        let _lock = self.project_lock(&record.id).await;
        self.ensure_loaded().await;
        if self.0.cache.read().unwrap().contains_key(&record.id) {
            return Err(StoreError::AlreadyExists(record.id.clone()));
        }
        let inner = self.0.clone();
        let rec = record.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.conn.lock().unwrap();
            write_project_full(&conn, &rec)?;
            let refreshed = refresh_project(&conn, &rec.id);
            if let Some(p) = refreshed {
                inner.cache.write().unwrap().insert(rec.id.clone(), p);
            }
            Ok::<(), StoreError>(())
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))??;
        Ok(())
    }

    /// Atomically mutate a project and persist it. `f` receives the current
    /// record (a clone) and must return the updated record.
    pub async fn mutate_project<F>(&self, id: &str, f: F) -> StoreResult<ProjectRecord>
    where
        F: FnOnce(&mut ProjectRecord) -> Result<ProjectRecord, StoreError> + Send + 'static,
    {
        let _lock = self.project_lock(id).await;
        self.ensure_loaded().await;
        let existing = self
            .0
            .cache
            .read()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| StoreError::NotFound(id.to_string()))?;

        let mut candidate = existing;
        let updated = f(&mut candidate)?;

        let inner = self.0.clone();
        let updated_clone = updated.clone();
        let id_owned = id.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<()> {
            let conn = inner.conn.lock().unwrap();
            write_project_full(&conn, &updated_clone)?;
            // Cache the DB round-trip, not the in-memory record.
            if let Some(p) = refresh_project(&conn, &id_owned) {
                inner.cache.write().unwrap().insert(id_owned, p);
            }
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))??;

        Ok(updated)
    }

    /// Remove a project (cascade deletes worktrees/sessions rows). Does NOT
    /// clean up worktree directories or tmux sessions — caller must do that.
    pub async fn delete_project(&self, id: &str) -> StoreResult<()> {
        let _lock = self.project_lock(id).await;
        self.ensure_loaded().await;
        if !self.0.cache.read().unwrap().contains_key(id) {
            return Err(StoreError::NotFound(id.to_string()));
        }
        let inner = self.0.clone();
        let id_owned = id.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<()> {
            let conn = inner.conn.lock().unwrap();
            conn.execute("DELETE FROM projects WHERE id = ?1", [&id_owned])?;
            inner.cache.write().unwrap().remove(&id_owned);
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))??;
        Ok(())
    }

    /// Fast-path lifecycle-state transition. Returns false if the session
    /// isn't in the DB (no-op).
    pub async fn update_session_lifecycle(
        &self,
        project_id: &str,
        session_id: &str,
        lifecycle: SessionLifecycle,
    ) -> StoreResult<bool> {
        let _lock = self.project_lock(project_id).await;
        self.ensure_loaded().await;
        let inner = self.0.clone();
        let project_id = project_id.to_string();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let changes = conn.execute(
                "UPDATE sessions SET state = ?1, reason = ?2, lastTransitionAt = ?3 WHERE id = ?4",
                params![
                    lifecycle_state_str(lifecycle.state),
                    lifecycle.reason,
                    lifecycle.last_transition_at,
                    session_id
                ],
            )?;
            if changes == 0 {
                return Ok(false);
            }
            if let Some(p) = refresh_project(&conn, &project_id) {
                inner.cache.write().unwrap().insert(project_id.clone(), p);
            }
            Ok(true)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Fast-path PR-status write. Returns false if the session isn't in the DB.
    pub async fn update_session_pr(
        &self,
        project_id: &str,
        session_id: &str,
        pr: vst_types::PrStatus,
    ) -> StoreResult<bool> {
        let _lock = self.project_lock(project_id).await;
        self.ensure_loaded().await;
        let inner = self.0.clone();
        let project_id = project_id.to_string();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let changes = conn.execute(
                "UPDATE sessions SET prState = ?1, prNumber = ?2, prUrl = ?3, prCheckedAt = ?4, prBranch = ?5 WHERE id = ?6",
                params![
                    pr_state_str(pr.state),
                    pr.number,
                    pr.url,
                    pr.checked_at,
                    pr.pr_branch,
                    session_id
                ],
            )?;
            if changes == 0 {
                return Ok(false);
            }
            if let Some(p) = refresh_project(&conn, &project_id) {
                inner.cache.write().unwrap().insert(project_id.clone(), p);
            }
            Ok(true)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Boot migration: migrate every project's `manifest.json` under
    /// `projects_dir` into the store, then drop the read cache.
    pub async fn migrate_manifests(&self, projects_dir: impl AsRef<Path>) -> StoreResult<()> {
        let inner = self.0.clone();
        let projects_dir = projects_dir.as_ref().to_path_buf();
        tokio::task::spawn_blocking(move || -> StoreResult<()> {
            let mut conn = inner.conn.lock().unwrap();
            crate::migration::migrate_manifests_to_sqlite(&mut conn, &projects_dir)?;
            // Drop the cache — migration writes rows directly, bypassing the store.
            inner.cache.write().unwrap().clear();
            inner.loaded.store(false, Ordering::Release);
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }
}

fn lifecycle_state_str(s: vst_types::LifecycleState) -> &'static str {
    match s {
        vst_types::LifecycleState::NotStarted => "not_started",
        vst_types::LifecycleState::Working => "working",
        vst_types::LifecycleState::Idle => "idle",
        vst_types::LifecycleState::WaitingForHuman => "waiting_for_human",
        vst_types::LifecycleState::Done => "done",
        vst_types::LifecycleState::Exited => "exited",
        vst_types::LifecycleState::Drafting => "drafting",
    }
}

fn pr_state_str(s: vst_types::PrState) -> &'static str {
    match s {
        vst_types::PrState::None => "none",
        vst_types::PrState::Draft => "draft",
        vst_types::PrState::Open => "open",
        vst_types::PrState::Merged => "merged",
        vst_types::PrState::Closed => "closed",
    }
}

// --- SQL helpers (all invoked from within spawn_blocking) ---

const SESSION_COLS: &str = "id, worktreeId, projectId, isMain, sortOrder, type, modeId, name, nameSource, tmuxName, useTmux, channel, state, reason, lastTransitionAt, transcriptKind, transcriptPath, agentChatId, acpSessionId, modelOverride, pinnedAt, initialPrompt, archivedAt, handoffSummary, draftPrompt, draftConfig, spawnedFrom, supersededBy, prState, prNumber, prUrl, prCheckedAt, prBranch";

fn session_from_row(r: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: r.get(0)?,
        worktree_id: r.get(1)?,
        project_id: r.get(2)?,
        is_main: r.get(3)?,
        sort_order: r.get(4)?,
        r#type: r.get(5)?,
        mode_id: r.get(6)?,
        name: r.get(7)?,
        name_source: r.get(8)?,
        tmux_name: r.get(9)?,
        use_tmux: r.get(10)?,
        channel: r.get(11)?,
        state: r.get(12)?,
        reason: r.get(13)?,
        last_transition_at: r.get(14)?,
        transcript_kind: r.get(15)?,
        transcript_path: r.get(16)?,
        agent_chat_id: r.get(17)?,
        acp_session_id: r.get(18)?,
        model_override: r.get(19)?,
        pinned_at: r.get(20)?,
        initial_prompt: r.get(21)?,
        archived_at: r.get(22)?,
        handoff_summary: r.get(23)?,
        draft_prompt: r.get(24)?,
        draft_config: r.get(25)?,
        spawned_from: r.get(26)?,
        superseded_by: r.get(27)?,
        pr_state: r.get(28)?,
        pr_number: r.get(29)?,
        pr_url: r.get(30)?,
        pr_checked_at: r.get(31)?,
        pr_branch: r.get(32)?,
    })
}

#[allow(dead_code)]
fn select_session(conn: &Connection, id: &str) -> rusqlite::Result<Option<SessionRow>> {
    let sql = format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1");
    conn.query_row(&sql, [id], session_from_row).optional()
}

fn select_worktree_sessions(
    conn: &Connection,
    worktree_id: &str,
) -> rusqlite::Result<Vec<SessionRow>> {
    let sql =
        format!("SELECT {SESSION_COLS} FROM sessions WHERE worktreeId = ?1 ORDER BY sortOrder ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([worktree_id], session_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn select_direct_sessions(
    conn: &Connection,
    project_id: &str,
) -> rusqlite::Result<Vec<SessionRow>> {
    let sql = format!(
        "SELECT {SESSION_COLS} FROM sessions WHERE projectId = ?1 AND worktreeId IS NULL ORDER BY sortOrder ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([project_id], session_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn worktree_from_row(r: &rusqlite::Row) -> rusqlite::Result<WorktreeRow> {
    Ok(WorktreeRow {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        branch: r.get(3)?,
        base_branch: r.get(4)?,
        base_sha: r.get(5)?,
        created_at: r.get(6)?,
        pinned_at: r.get(7)?,
        hidden_at: r.get(8)?,
        sort_order: r.get(9)?,
        terminal_seq: r.get(10)?,
        agent_seq: r.get(11)?,
        branch_is_placeholder: r.get(12)?,
    })
}

fn select_worktrees(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<WorktreeRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, projectId, name, branch, baseBranch, baseSha, createdAt, pinnedAt, hiddenAt, sortOrder, terminalSeq, agentSeq, branchIsPlaceholder FROM worktrees WHERE projectId = ?1 ORDER BY sortOrder ASC",
    )?;
    let rows = stmt
        .query_map([project_id], worktree_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn project_from_row(r: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: r.get(0)?,
        absolute_path: r.get(1)?,
        prefix: r.get(2)?,
        is_git: r.get(3)?,
        default_branch: r.get(4)?,
        created_at: r.get(5)?,
        hidden: r.get(6)?,
        direct_session_seq: r.get(7)?,
        next_worktree_num: r.get(8)?,
    })
}

fn select_project(conn: &Connection, id: &str) -> rusqlite::Result<Option<ProjectRow>> {
    conn.query_row(
        "SELECT id, absolutePath, prefix, isGit, defaultBranch, createdAt, hidden, directSessionSeq, nextWorktreeNum FROM projects WHERE id = ?1",
        [id],
        project_from_row,
    )
    .optional()
}

fn select_all_projects(conn: &Connection) -> rusqlite::Result<Vec<ProjectRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, absolutePath, prefix, isGit, defaultBranch, createdAt, hidden, directSessionSeq, nextWorktreeNum FROM projects",
    )?;
    let rows = stmt
        .query_map([], project_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn assemble_project(conn: &Connection, row: &ProjectRow) -> rusqlite::Result<ProjectRecord> {
    let worktree_rows = select_worktrees(conn, &row.id)?;
    let mut worktrees: Vec<WorktreeRecord> = Vec::new();
    for w in &worktree_rows {
        let sessions = select_worktree_sessions(conn, &w.id)?
            .iter()
            .map(row_to_session)
            .collect();
        worktrees.push(row_to_worktree(w, sessions));
    }
    let direct = select_direct_sessions(conn, &row.id)?
        .iter()
        .map(row_to_session)
        .collect();
    Ok(row_to_project(row, worktrees, direct))
}

fn load_all_projects(inner: &Inner) -> HashMap<String, ProjectRecord> {
    let Ok(conn) = inner.conn.lock() else {
        return HashMap::new();
    };
    let Ok(rows) = select_all_projects(&conn) else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for row in rows {
        if let Ok(record) = assemble_project(&conn, &row) {
            map.insert(row.id.clone(), record);
        }
    }
    map
}

fn refresh_project(conn: &Connection, id: &str) -> Option<ProjectRecord> {
    let row = select_project(conn, id).ok()??;
    assemble_project(conn, &row).ok()
}

/// Full-replace a project's worktrees/sessions, then upsert the project's own
/// scalar columns. Single transaction (delete-then-reinsert children).
fn write_project_full(conn: &Connection, record: &ProjectRecord) -> StoreResult<()> {
    let txn = conn.unchecked_transaction()?;
    {
        let proj = project_to_row(record);
        txn.execute(
            "INSERT INTO projects (id, absolutePath, prefix, isGit, defaultBranch, createdAt, hidden, directSessionSeq, nextWorktreeNum)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               absolutePath = excluded.absolutePath,
               prefix = excluded.prefix,
               isGit = excluded.isGit,
               defaultBranch = excluded.defaultBranch,
               createdAt = excluded.createdAt,
               hidden = excluded.hidden,
               directSessionSeq = excluded.directSessionSeq,
               nextWorktreeNum = excluded.nextWorktreeNum",
            params![
                proj.id,
                proj.absolute_path,
                proj.prefix,
                proj.is_git,
                proj.default_branch,
                proj.created_at,
                proj.hidden,
                proj.direct_session_seq,
                proj.next_worktree_num
            ],
        )?;

        txn.execute("DELETE FROM sessions WHERE projectId = ?1", [&record.id])?;
        txn.execute("DELETE FROM worktrees WHERE projectId = ?1", [&record.id])?;

        for w in &record.worktrees {
            let wt = worktree_to_row(w, &record.id);
            txn.execute(
                "INSERT INTO worktrees (id, projectId, name, branch, baseBranch, baseSha, createdAt, pinnedAt, hiddenAt, sortOrder, terminalSeq, agentSeq, branchIsPlaceholder)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    wt.id, wt.project_id, wt.name, wt.branch, wt.base_branch, wt.base_sha, wt.created_at,
                    wt.pinned_at, wt.hidden_at, wt.sort_order, wt.terminal_seq, wt.agent_seq, wt.branch_is_placeholder
                ],
            )?;
            for s in &w.sessions {
                insert_session(&txn, s, &record.id, Some(&w.id))?;
            }
        }
        for s in &record.direct_sessions {
            insert_session(&txn, s, &record.id, None)?;
        }
    }
    txn.commit()?;
    Ok(())
}

fn insert_session(
    conn: &Connection,
    s: &SessionRecord,
    project_id: &str,
    worktree_id: Option<&str>,
) -> StoreResult<()> {
    let row = session_to_row(s, project_id, worktree_id);
    conn.execute(
        "INSERT INTO sessions (id, worktreeId, projectId, isMain, sortOrder, type, modeId, name, nameSource, tmuxName, useTmux, channel, state, reason, lastTransitionAt, transcriptKind, transcriptPath, agentChatId, acpSessionId, modelOverride, pinnedAt, initialPrompt, archivedAt, handoffSummary, spawnedFrom, supersededBy, prState, prNumber, prUrl, prCheckedAt, prBranch, draftPrompt, draftConfig)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33)",
        params![
            row.id, row.worktree_id, row.project_id, row.is_main, row.sort_order, row.r#type, row.mode_id,
            row.name, row.name_source, row.tmux_name, row.use_tmux, row.channel, row.state, row.reason,
            row.last_transition_at, row.transcript_kind, row.transcript_path, row.agent_chat_id,
            row.acp_session_id, row.model_override, row.pinned_at, row.initial_prompt, row.archived_at,
            row.handoff_summary, row.spawned_from, row.superseded_by, row.pr_state, row.pr_number,
            row.pr_url, row.pr_checked_at, row.pr_branch, row.draft_prompt, row.draft_config
        ],
    )?;
    Ok(())
}

pub use global_drafts::{GlobalDraftPatch, GlobalDraftRow};
pub use ordered_lists::OrderedList;
pub use tunnel::TunnelStateRow;

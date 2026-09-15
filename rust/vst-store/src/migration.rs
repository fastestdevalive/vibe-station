//! Boot migration: `manifest.json` (per project) -> `vibe-station.db` — ports
//! `daemon/src/services/dbMigration.ts`.
//!
//! Additive and non-destructive: `manifest.json` is never deleted, and one
//! corrupt project's migration failure never blocks the others (per-project
//! try/catch). Gated per-project via the `manifest_migrations` table; a project
//! recorded `status: 'ok'` is skipped outright on every boot.
//!
//! NOTE: the legacy `manifest.json` reader normally provided by `readManifest`
//! (`manifest.ts`, owned by part 05) is implemented here, scoped to the
//! migration's on-disk needs so this part is self-contained and testable
//! (flagged in the part's report for reconciliation when part 05 lands).

use std::path::Path;

use rusqlite::{params, Connection};
use serde::Deserialize;
use vst_types::Channel;

use crate::schema::ensure_schema;

/// Shape of a legacy manifest as it actually exists on disk (with the removed
/// `slot` field and without the new `worktreeId`/`isMain`/`sortOrder` columns).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySession {
    id: String,
    slot: Option<String>,
    r#type: String,
    mode_id: Option<String>,
    name: Option<String>,
    tmux_name: String,
    use_tmux: bool,
    channel: Option<String>,
    lifecycle: LegacyLifecycle,
    transcript_ref: Option<LegacyTranscriptRef>,
    agent_chat_id: Option<String>,
    model_override: Option<String>,
    pinned_at: Option<String>,
    initial_prompt: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLifecycle {
    state: String,
    reason: Option<String>,
    last_transition_at: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTranscriptRef {
    kind: String,
    path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWorktree {
    id: String,
    name: Option<String>,
    branch: String,
    base_branch: Option<String>,
    base_sha: Option<String>,
    created_at: String,
    pinned_at: Option<String>,
    terminal_seq: Option<i64>,
    agent_seq: Option<i64>,
    #[serde(default)]
    sessions: Vec<LegacySession>,
}

/// Deserialize an explicit `null` (or missing) JSON value into an empty `Vec`.
/// `#[serde(default)]` alone only covers a *missing* field; a legacy manifest
/// may carry `"worktrees": null` / `"directSessions": null`, which would
/// otherwise fail `Vec::deserialize` outright and quarantine the whole project.
fn de_nullable_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    let opt = Option::<Vec<T>>::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProject {
    id: String,
    absolute_path: String,
    prefix: String,
    is_git: bool,
    default_branch: Option<String>,
    created_at: String,
    hidden: Option<bool>,
    #[serde(default, deserialize_with = "de_nullable_vec")]
    direct_sessions: Vec<LegacySession>,
    direct_session_seq: Option<i64>,
    #[serde(default, deserialize_with = "de_nullable_vec")]
    worktrees: Vec<LegacyWorktree>,
    next_worktree_num: Option<i64>,
}

fn channel_str(c: &str) -> Option<&'static str> {
    match c {
        "tmux" => Some("tmux"),
        "pty" => Some("pty"),
        "json" => Some("json"),
        _ => None,
    }
}

fn insert_legacy_session(
    conn: &Connection,
    s: &LegacySession,
    worktree_id: Option<&str>,
    project_id: &str,
    sort_order: i64,
) -> rusqlite::Result<()> {
    let is_main = s.slot.as_deref() == Some("m");
    let mut name = s.name.clone();
    if name.is_none() && s.r#type == "agent" {
        if let Some(slot) = &s.slot {
            if let Some(num) = slot.strip_prefix('a') {
                if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
                    name = Some(format!("Agent {num}"));
                }
            }
        }
    }
    let name_source = if name.is_some() { Some("auto") } else { None };
    let channel = s.channel.as_deref().and_then(channel_str);

    conn.execute(
        "INSERT INTO sessions (id, worktreeId, projectId, isMain, sortOrder, type, modeId, name, nameSource, tmuxName, useTmux, channel, state, reason, lastTransitionAt, transcriptKind, transcriptPath, agentChatId, modelOverride, pinnedAt, initialPrompt, archivedAt, handoffSummary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
         ON CONFLICT(id) DO NOTHING",
        params![
            s.id,
            worktree_id,
            project_id,
            if is_main { 1 } else { 0 },
            sort_order,
            s.r#type,
            s.mode_id,
            name,
            name_source,
            s.tmux_name,
            if s.use_tmux { 1 } else { 0 },
            channel,
            s.lifecycle.state,
            s.lifecycle.reason,
            s.lifecycle.last_transition_at,
            s.transcript_ref.as_ref().map(|t| &t.kind),
            s.transcript_ref.as_ref().and_then(|t| t.path.as_ref()),
            s.agent_chat_id,
            s.model_override,
            s.pinned_at,
            s.initial_prompt,
            Option::<String>::None,
            Option::<String>::None,
        ],
    )?;
    Ok(())
}

/// Derive a safe `next_worktree_num` floor from the highest `<prefix>-<n>`
/// worktree id actually present, rather than trusting an absent/stale field.
fn safe_next_worktree_num(legacy: &LegacyProject) -> i64 {
    let declared = legacy.next_worktree_num;
    let mut highest_seen: i64 = 0;
    for w in &legacy.worktrees {
        if let Some(n) = prefix_number(&w.id, &legacy.prefix) {
            highest_seen = highest_seen.max(n);
        }
    }
    let floor = highest_seen + 1;
    match declared {
        Some(d) if d >= floor => d,
        _ => floor,
    }
}

/// Matches `^<literal-prefix>-(\d+)$` — a worktree id whose suffix after
/// `<prefix>-` is entirely digits. No regex dependency needed.
fn prefix_number(id: &str, prefix: &str) -> Option<i64> {
    let rest = id.strip_prefix(prefix)?.strip_prefix('-')?;
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    rest.parse::<i64>().ok()
}

fn insert_legacy_project(conn: &mut Connection, legacy: &LegacyProject) -> rusqlite::Result<()> {
    let txn = conn.transaction()?;
    {
        txn.execute(
            "INSERT INTO projects (id, absolutePath, prefix, isGit, defaultBranch, createdAt, hidden, directSessionSeq, nextWorktreeNum)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO NOTHING",
            params![
                legacy.id,
                legacy.absolute_path,
                legacy.prefix,
                if legacy.is_git { 1 } else { 0 },
                legacy.default_branch,
                legacy.created_at,
                if legacy.hidden.unwrap_or(false) { 1 } else { 0 },
                legacy.direct_session_seq.unwrap_or(0),
                safe_next_worktree_num(legacy),
            ],
        )?;

        for (wi, w) in legacy.worktrees.iter().enumerate() {
            txn.execute(
                "INSERT INTO worktrees (id, projectId, name, branch, baseBranch, baseSha, createdAt, pinnedAt, sortOrder, terminalSeq, agentSeq, branchIsPlaceholder)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO NOTHING",
                params![
                    w.id,
                    legacy.id,
                    w.name,
                    w.branch,
                    w.base_branch,
                    w.base_sha,
                    w.created_at,
                    w.pinned_at,
                    wi as i64,
                    w.terminal_seq.unwrap_or(0),
                    w.agent_seq.unwrap_or(0),
                    0, // branchIsPlaceholder: every pre-existing worktree had an explicit branch
                ],
            )?;
            for (si, s) in w.sessions.iter().enumerate() {
                insert_legacy_session(&txn, s, Some(&w.id), &legacy.id, si as i64)?;
            }
        }

        for (si, s) in legacy.direct_sessions.iter().enumerate() {
            insert_legacy_session(&txn, s, None, &legacy.id, si as i64)?;
        }
    }
    txn.commit()
}

fn get_migration_status(conn: &Connection, project_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT status FROM manifest_migrations WHERE projectId = ?1",
        [project_id],
        |r| r.get(0),
    )
    .optional()
}

fn record_migration_outcome(
    conn: &Connection,
    project_id: &str,
    outcome: &str,
    error: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO manifest_migrations (projectId, migratedAt, status, error)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(projectId) DO UPDATE SET migratedAt = excluded.migratedAt, status = excluded.status, error = excluded.error",
        params![
            project_id,
            // ISO8601 UTC timestamp.
            chrono_now(),
            outcome,
            error,
        ],
    )?;
    Ok(())
}

/// Best-effort ISO8601 UTC timestamp without pulling in chrono.
fn chrono_now() -> String {
    // A stable, sortable timestamp. The daemon's exact timestamp format is a
    // cosmetic detail here; the migration table only needs an ISO8601-ish value.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // ISO8601 without subsecond precision.
    let days = secs / 86_400;
    let mut y = 1970_i64;
    let mut remaining = days;
    loop {
        let year_days = if is_leap(y) { 366 } else { 365 };
        if remaining < year_days {
            break;
        }
        remaining -= year_days;
        y += 1;
    }
    let (month, day) = month_day(y, remaining as i64);
    let sec_of_day = secs % 86_400;
    let (h, mi, s) = (sec_of_day / 3600, (sec_of_day % 3600) / 60, sec_of_day % 60);
    format!("{y:04}-{month:02}-{day:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn month_day(y: i64, day_of_year: i64) -> (i64, i64) {
    let month_days = [
        31,
        if is_leap(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut d = day_of_year;
    for (i, m) in month_days.iter().enumerate() {
        if d < *m {
            return (i as i64 + 1, d + 1);
        }
        d -= m;
    }
    (12, 31)
}

/// Migrate every not-yet-successfully-migrated `manifest.json` project under
/// `projects_dir` into `conn`. Idempotent; safe to call on every boot.
pub fn migrate_manifests_to_sqlite(
    conn: &mut Connection,
    projects_dir: &Path,
) -> crate::StoreResult<()> {
    ensure_schema(conn)?;

    let entries = match std::fs::read_dir(projects_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // no projects dir yet
    };
    let mut project_ids: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if dir.join("manifest.json").exists() {
            if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
                project_ids.push(name.to_string());
            }
        }
    }

    for project_id in project_ids {
        if get_migration_status(conn, &project_id)? == Some("ok".to_string()) {
            continue; // already migrated — never re-attempt.
        }
        let manifest_path = projects_dir.join(&project_id).join("manifest.json");
        match read_legacy_manifest(&manifest_path) {
            Ok(legacy) => {
                if let Err(e) = insert_legacy_project(conn, &legacy) {
                    let msg = e.to_string();
                    tracing::error!("[dbMigration] project '{project_id}' migration failed: {msg}");
                    record_migration_outcome(conn, &project_id, "failed", Some(&msg))?;
                } else {
                    record_migration_outcome(conn, &project_id, "ok", None)?;
                }
            }
            Err(msg) => {
                tracing::error!("[dbMigration] project '{project_id}' migration failed: {msg}");
                record_migration_outcome(conn, &project_id, "failed", Some(&msg))?;
            }
        }
    }
    Ok(())
}

fn read_legacy_manifest(path: &Path) -> Result<LegacyProject, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let legacy: LegacyProject = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(legacy)
}

// Used by tests via `StoreHandle::raw_conn` + this function.
#[allow(unused_imports)]
use rusqlite::OptionalExtension;

/// Helper so `Channel` import is not dead (migration writes channel as string
/// directly; kept for API completeness of this module).
#[allow(dead_code)]
fn _channel_api(_c: Channel) {}

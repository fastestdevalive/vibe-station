//! Project manifest read/write — ports `services/manifest.ts`.
//!
//! Behavior contract:
//! - Atomic write: serialize → write `.tmp` → sync_data → rename over final.
//! - On read: backfill `is_git=true`, `direct_sessions=[]`, `worktrees=[]` for
//!   legacy records that omit those fields.
//! - `normalize_channel` applied to every session during read to ensure the
//!   `channel` field is always set.
//! - `use_tmux` absent on a legacy session record → treated as `true` (back-compat).

use std::io::Write;
use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type ManifestResult<T> = Result<T, ManifestError>;

/// Write a project manifest atomically (tmp → sync_data → rename).
pub async fn write_manifest(manifest_path: &Path, value: &serde_json::Value) -> ManifestResult<()> {
    let tmp_path = {
        let mut p = manifest_path.to_path_buf();
        let fname = p
            .file_name()
            .map(|n| format!("{}.tmp", n.to_string_lossy()))
            .unwrap_or_else(|| "manifest.json.tmp".to_string());
        p.set_file_name(fname);
        p
    };

    let json_bytes = serde_json::to_vec(value)?;
    let tmp = tmp_path.clone();
    let mp = manifest_path.to_path_buf();

    tokio::task::spawn_blocking(move || -> ManifestResult<()> {
        // Write to .tmp.
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json_bytes)?;
        f.sync_data()?;
        drop(f);
        // Atomic rename over final path.
        std::fs::rename(&tmp, &mp)?;
        Ok(())
    })
    .await
    .map_err(|e| ManifestError::Io(std::io::Error::other(e.to_string())))??;

    Ok(())
}

/// Read and backfill-normalize a project manifest from disk.
///
/// Backfills applied:
/// - `isGit` absent → `true`
/// - `directSessions` absent → `[]`
/// - `worktrees` absent → `[]`
/// - Per session: `useTmux` absent → `true`; `channel` derived via `normalize_channel`
pub async fn read_manifest(manifest_path: &Path) -> ManifestResult<serde_json::Value> {
    let mp = manifest_path.to_path_buf();
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&mp))
        .await
        .map_err(|e| ManifestError::Io(std::io::Error::other(e.to_string())))??;

    let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;

    if let Some(obj) = value.as_object_mut() {
        obj.entry("isGit").or_insert(serde_json::Value::Bool(true));
        obj.entry("directSessions")
            .or_insert(serde_json::Value::Array(vec![]));
        obj.entry("worktrees")
            .or_insert(serde_json::Value::Array(vec![]));

        backfill_sessions_in_list(obj.get_mut("directSessions"));
        if let Some(wts) = obj.get_mut("worktrees").and_then(|v| v.as_array_mut()) {
            for wt in wts.iter_mut() {
                backfill_sessions_in_list(wt.as_object_mut().and_then(|w| w.get_mut("sessions")));
            }
        }
    }

    Ok(value)
}

fn backfill_sessions_in_list(sessions_val: Option<&mut serde_json::Value>) {
    let Some(sessions) = sessions_val.and_then(|v| v.as_array_mut()) else {
        return;
    };
    for session in sessions.iter_mut() {
        let Some(s) = session.as_object_mut() else {
            continue;
        };
        // Backfill useTmux: absent → true.
        let use_tmux = s.get("useTmux").and_then(|v| v.as_bool()).unwrap_or(true);
        s.entry("useTmux").or_insert(serde_json::Value::Bool(true));

        // Backfill channel via normalize_channel logic.
        if !s.contains_key("channel") {
            let ch = if s.get("channel").and_then(|v| v.as_str()) == Some("json") {
                "json"
            } else if use_tmux {
                "tmux"
            } else {
                "pty"
            };
            s.insert(
                "channel".to_string(),
                serde_json::Value::String(ch.to_string()),
            );
        }
        // Enforce json → useTmux=false.
        if s.get("channel").and_then(|v| v.as_str()) == Some("json") {
            s.insert("useTmux".to_string(), serde_json::Value::Bool(false));
        }
    }
}

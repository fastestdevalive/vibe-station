//! `GET .../stat/*path` (in-root only) and `GET .../artifacts/:artifactId/stat`
//! (outside-root artifacts). Two gates, never mixed: the path route never
//! consults the artifact gate, and the artifact route only calls
//! `ArtifactsHandle::stat_content` (the hardened open, scope-checked).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use vst_artifacts::{ArtifactStatOutcome, ArtifactsHandle};
use vst_types::artifacts::ScopeKey;
use vst_types::rest::worktrees::{FileStat, FileStatKind};

use crate::artifact_gate::confine_only;

/// Largest in-root text file whose lines are counted.
const LINE_COUNT_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Leading bytes probed for a NUL before counting lines.
const NUL_PROBE_BYTES: usize = 8 * 1024;

/// Why a stat was refused. Maps to 404 (`NotFound`) or 403 (`Denied`).
#[derive(Debug, PartialEq, Eq)]
pub enum StatError {
    NotFound(String),
    Denied(String),
}

/// Stat an in-root path. `lexical` is the path resolved lexically inside
/// `root`; `None` means the caller gave an absolute path that is not inside
/// it, which is refused here without consulting the artifact gate.
pub async fn stat_in_root(
    root: &Path,
    file_path: &str,
    lexical: Option<PathBuf>,
) -> Result<FileStat, StatError> {
    let Some(abs) = lexical else {
        return Err(StatError::Denied(format!(
            "Access denied: absolute path outside the root: {file_path}"
        )));
    };
    confine_only(root, &abs).await.map_err(|_| {
        StatError::Denied("Access denied: path resolves outside the root".to_string())
    })?;

    let meta = match tokio::fs::metadata(&abs).await {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(StatError::NotFound(format!("File not found: {file_path}")));
        }
        Err(_) => {
            return Err(StatError::Denied(format!(
                "Access denied: cannot stat {file_path}"
            )));
        }
    };

    let (kind, size) = if meta.is_dir() {
        (FileStatKind::Dir, None)
    } else if meta.is_file() {
        (FileStatKind::File, Some(meta.len()))
    } else {
        (FileStatKind::Other, None)
    };
    let line_count = if kind == FileStatKind::File && meta.len() <= LINE_COUNT_MAX_BYTES {
        count_lines(&abs).await
    } else {
        None
    };
    let absolute_path = tokio::fs::canonicalize(&abs)
        .await
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);

    Ok(FileStat {
        path: file_path.to_string(),
        absolute_path,
        kind,
        size,
        modified_ms,
        line_count,
        in_root: true,
    })
}

/// Stat an artifact row of `scope` through the hardened artifact stat only.
/// `art = None` (no artifact store wired) is "not found".
pub async fn stat_artifact(
    art: Option<&ArtifactsHandle>,
    scope: &ScopeKey,
    id: &str,
) -> Result<FileStat, StatError> {
    let Some(art) = art else {
        return Err(StatError::NotFound(format!("Artifact '{id}' not found")));
    };
    match art.stat_content(scope, id).await {
        ArtifactStatOutcome::Found {
            size,
            modified_ms,
            path,
            in_repo,
        } => Ok(FileStat {
            path: path.clone(),
            absolute_path: Some(path),
            kind: FileStatKind::File,
            size: Some(size),
            modified_ms: Some(modified_ms),
            line_count: None,
            in_root: in_repo,
        }),
        ArtifactStatOutcome::NotFound => {
            Err(StatError::NotFound(format!("Artifact '{id}' not found")))
        }
        ArtifactStatOutcome::Missing => Err(StatError::NotFound(format!(
            "Artifact '{id}' file is missing"
        ))),
        ArtifactStatOutcome::Denied | ArtifactStatOutcome::Unreadable => Err(StatError::Denied(
            format!("Access denied: artifact '{id}' cannot be read"),
        )),
    }
}

/// Line count of a small text file: `None` when a NUL shows up in the first
/// 8 KiB (binary) or the file cannot be read. A final line without a newline
/// still counts.
async fn count_lines(path: &Path) -> Option<u64> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let probe = &bytes[..bytes.len().min(NUL_PROBE_BYTES)];
    if probe.contains(&0) {
        return None;
    }
    if bytes.is_empty() {
        return Some(0);
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
    Some(if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    })
}

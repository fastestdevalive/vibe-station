//! The read gate of the in-root file routes (plan Decision 6).
//!
//! `resolve_inside_worktree`/`resolve_inside_dir` are lexical: a symlink inside
//! the repo can point anywhere. This module adds the canonical check on top:
//!
//! - [`gate_read`] (`get_file`): the canonical target must live under the
//!   canonical root, otherwise it must be a live artifact row of the SCOPE, in
//!   which case the caller serves it through
//!   [`ArtifactsHandle::read_content`] (never `read_file_response`).
//! - [`confine_only`] (`gutter`, `tree`): canonical confinement, no exception.
//! - [`open_files_key`] (open/close-file): an absolute path is accepted only
//!   for a live artifact row.
//!
//! Without an [`ArtifactsHandle`] confinement still applies and the artifact
//! exception is off.

use std::path::{Path, PathBuf};

use vst_artifacts::paths::{confine_to_root, ConfineError};
use vst_artifacts::{ArtifactId, ArtifactsHandle};
use vst_types::artifacts::ScopeKey;

/// Where a gated read resolved to.
#[derive(Debug, PartialEq, Eq)]
pub enum Gated {
    /// Canonical path inside the canonical root; safe for the plain reader.
    InRoot(PathBuf),
    /// Outside the root but a live artifact: serve via `read_content(id)`.
    Artifact(ArtifactId),
}

#[derive(Debug, PartialEq, Eq)]
pub enum GateError {
    /// ENOENT on a path that is lexically inside the root: callers keep 404.
    NotFound,
    /// Not allowed (403).
    Denied(String),
}

const NOT_REGULAR_MSG: &str = "Access denied: not a regular file";
const OUTSIDE_MSG: &str = "Access denied: path resolves outside the root";

/// Turn a lexical-resolver result into "lexically inside" (`Some`) or "absolute
/// path outside the root" (`None`, a candidate artifact path). A relative path
/// that escapes lexically (`..`) keeps its original error.
pub fn lexical_or_absolute<E>(
    lexical: Result<PathBuf, E>,
    file_path: &str,
) -> Result<Option<PathBuf>, E> {
    match lexical {
        Ok(p) => Ok(Some(p)),
        Err(_) if Path::new(file_path).is_absolute() => Ok(None),
        Err(e) => Err(e),
    }
}

enum Resolved {
    Inside(PathBuf),
    Outside(PathBuf),
    NotFound,
    Failed,
}

fn resolve_blocking(root: PathBuf, target: PathBuf) -> Resolved {
    match confine_to_root(&root, &target) {
        Ok(canon) => Resolved::Inside(canon),
        Err(ConfineError::NotFound) => Resolved::NotFound,
        Err(ConfineError::Io(_)) => Resolved::Failed,
        Err(ConfineError::Escape) => match std::fs::canonicalize(&target) {
            Ok(c) => Resolved::Outside(c),
            Err(_) => Resolved::Failed,
        },
    }
}

async fn resolve(root: &Path, target: PathBuf) -> Resolved {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || resolve_blocking(root, target))
        .await
        .unwrap_or(Resolved::Failed)
}

async fn authorize(
    art: Option<&ArtifactsHandle>,
    scope: &ScopeKey,
    canonical: &Path,
) -> Option<ArtifactId> {
    art?.authorize_read(scope, canonical).await
}

/// Gate for `get_file`. `lexical` is `Some(abs)` for a path the lexical check
/// accepted and `None` for an absolute path outside the root.
pub async fn gate_read(
    art: Option<&ArtifactsHandle>,
    scope: &ScopeKey,
    root: &Path,
    file_path: &str,
    lexical: Option<PathBuf>,
) -> Result<Gated, GateError> {
    let absolute_only = lexical.is_none();
    let target = lexical.unwrap_or_else(|| PathBuf::from(file_path));
    match resolve(root, target).await {
        Resolved::Inside(c) => {
            // A FIFO/device inside the repo would block the plain reader forever.
            let probe = c.clone();
            let regular = tokio::task::spawn_blocking(move || std::fs::metadata(probe))
                .await
                .ok()
                .and_then(|r| r.ok())
                .map(|m| m.is_file());
            match regular {
                Some(false) => Err(GateError::Denied(NOT_REGULAR_MSG.to_string())),
                _ => Ok(Gated::InRoot(c)),
            }
        }
        // A missing path that is not under the root must not become an
        // existence oracle for arbitrary absolute paths.
        Resolved::NotFound if absolute_only => Err(GateError::Denied(OUTSIDE_MSG.to_string())),
        Resolved::NotFound => Err(GateError::NotFound),
        Resolved::Failed => Err(GateError::Denied(OUTSIDE_MSG.to_string())),
        Resolved::Outside(c) => match authorize(art, scope, &c).await {
            Some(id) => Ok(Gated::Artifact(id)),
            None => Err(GateError::Denied(OUTSIDE_MSG.to_string())),
        },
    }
}

/// Gate for `gutter` and `tree`: the canonical target must be inside the
/// canonical root, no artifact exception. A missing target passes so the
/// caller's own 404 is unchanged.
pub async fn confine_only(root: &Path, lexical_abs: &Path) -> Result<(), GateError> {
    match resolve(root, lexical_abs.to_path_buf()).await {
        Resolved::Inside(_) | Resolved::NotFound => Ok(()),
        Resolved::Outside(_) | Resolved::Failed => Err(GateError::Denied(OUTSIDE_MSG.to_string())),
    }
}

/// Open-files gate for an absolute path the lexical check refused: returns the
/// canonical absolute path to persist when it is a live artifact of the scope.
pub async fn artifact_open_path(
    art: Option<&ArtifactsHandle>,
    scope: &ScopeKey,
    file_path: &str,
) -> Result<String, GateError> {
    let p = PathBuf::from(file_path);
    let canon = tokio::task::spawn_blocking(move || std::fs::canonicalize(p))
        .await
        .ok()
        .and_then(|r| r.ok());
    let denied = || GateError::Denied(OUTSIDE_MSG.to_string());
    let canon = canon.ok_or_else(denied)?;
    authorize(art, scope, &canon).await.ok_or_else(denied)?;
    Ok(canon.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[tokio::test]
    async fn inside_symlink_to_inside_is_allowed_and_outside_is_denied() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("root");
        let outside = t.path().join("outside");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("docs/a.md"), "a").unwrap();
        std::fs::write(outside.join("secret"), "s").unwrap();
        symlink(root.join("docs/a.md"), root.join("ok")).unwrap();
        symlink(outside.join("secret"), root.join("leak")).unwrap();
        symlink(&outside, root.join("dirleak")).unwrap();
        let scope = ScopeKey::worktree("w");

        let ok = gate_read(None, &scope, &root, "ok", Some(root.join("ok"))).await;
        assert!(matches!(ok, Ok(Gated::InRoot(_))));
        for p in ["leak", "dirleak/secret"] {
            let r = gate_read(None, &scope, &root, p, Some(root.join(p))).await;
            assert!(matches!(r, Err(GateError::Denied(_))), "{p}: {r:?}");
        }
        let missing = gate_read(None, &scope, &root, "nope", Some(root.join("nope"))).await;
        assert_eq!(missing, Err(GateError::NotFound));
        // absolute, outside, not an artifact -> 403 even when it does not exist
        let abs = gate_read(None, &scope, &root, "/definitely/not/here", None).await;
        assert!(matches!(abs, Err(GateError::Denied(_))));
        assert!(confine_only(&root, &root.join("dirleak")).await.is_err());
        assert!(confine_only(&root, &root.join("nope")).await.is_ok());
    }

    #[test]
    fn relative_escape_keeps_its_error() {
        let r: Result<PathBuf, &str> = Err("traversal");
        assert_eq!(lexical_or_absolute(r, "../x"), Err("traversal"));
        let r: Result<PathBuf, &str> = Err("traversal");
        assert_eq!(lexical_or_absolute(r, "/etc/passwd"), Ok(None));
    }
}

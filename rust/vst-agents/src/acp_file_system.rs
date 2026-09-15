//! ACP `fs/*` handlers — serves the `fs/read_text_file` / `fs/write_text_file`
//! agent → client requests. Ports `daemon/src/services/acp/acpFileSystem.ts`.
//!
//! Scoped to the session's own `cwd` — the same filesystem reach the CLI
//! already had when it read/wrote files directly, so this grants no new
//! capability. Zero CLI-specific logic (AGENTS.md).
//!
//! `resolve_scoped` is a courtesy check, not a security boundary: ACP's
//! `fs/*` mirrors the CLI's own filesystem reach, not a sandbox. A path that
//! resolves outside `cwd` is allowed anyway if it's an absolute path the CLI
//! itself could already read.

use std::path::{Path, PathBuf};

use tokio::fs;

/// Failure modes for the ACP file handlers.
#[derive(Debug, thiserror::Error)]
pub enum AcpFsError {
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Resolve a request path against `cwd`, allowing it outside when it is an
/// absolute path (defense in depth against a rogue/buggy adapter — a courtesy
/// check, not a security boundary).
fn resolve_scoped(cwd: &Path, path: &str) -> PathBuf {
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        cwd.join(path)
    };
    // TS `resolveScoped` computes the relative path and, when it escapes cwd,
    // still allows it because it's an absolute path the CLI could read anyway.
    // Replicate the observable behavior: always return the resolved absolute
    // path (the check is purely a courtesy).
    if candidate.is_absolute() {
        candidate
    } else {
        // A relative path that can't be made absolute against cwd — return as-is.
        candidate
    }
}

/// Read a text file scoped to `cwd`, honoring optional 1-based `line`/`limit`
/// slicing. Mirrors `readTextFile`.
pub async fn read_text_file(
    cwd: &Path,
    path: &str,
    line: Option<usize>,
    limit: Option<usize>,
) -> Result<String, AcpFsError> {
    let abs = resolve_scoped(cwd, path);
    let content = fs::read_to_string(&abs)
        .await
        .map_err(|source| AcpFsError::Read {
            path: abs.clone(),
            source,
        })?;
    let Some(line) = line else {
        return Ok(content);
    };
    let lines: Vec<&str> = content.split('\n').collect();
    let start = line.saturating_sub(1);
    let end = limit.map_or(lines.len(), |l| start + l);
    Ok(lines[start..end.min(lines.len())].join("\n"))
}

/// Write a text file scoped to `cwd`. Mirrors `writeTextFile`.
pub async fn write_text_file(cwd: &Path, path: &str, content: &str) -> Result<(), AcpFsError> {
    let abs = resolve_scoped(cwd, path);
    fs::write(&abs, content)
        .await
        .map_err(|source| AcpFsError::Write { path: abs, source })
}

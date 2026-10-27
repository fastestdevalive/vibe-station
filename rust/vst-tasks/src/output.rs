//! Hardened reader for a background command's output file.
//!
//! The path comes from free text in a tool result (plan K5), so it is treated
//! as untrusted: validated lexically when parsed, then re-validated against
//! the filesystem on every read (canonical path under an allowlisted root,
//! `claude-<uid>` segment, `/tasks/<task_id>.output`, a regular file, no
//! symlink as the final component, no FIFO hang, bounded size and time).

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use crate::{MAX_TAIL_BYTES, OUTPUT_READ_TIMEOUT_MS};

/// Why a read was refused. Every variant maps to `OUTPUT_UNAVAILABLE`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputError {
    /// Path failed validation (shape, root, symlink, not a regular file).
    Rejected,
    /// I/O failure while opening or reading.
    Io,
    /// The read exceeded its time bound.
    Timeout,
}

/// The decoded tail of an output file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileTail {
    pub lines: Vec<String>,
    /// Older content exists that was not returned.
    pub truncated: bool,
    pub total_bytes: u64,
}

/// Roots under which the adapter writes task output: canonical `/tmp`,
/// `/private/tmp` and `$TMPDIR`.
#[must_use]
pub fn default_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut candidates: Vec<PathBuf> = vec![PathBuf::from("/tmp"), PathBuf::from("/private/tmp")];
    if let Some(t) = std::env::var_os("TMPDIR") {
        candidates.push(PathBuf::from(t));
    }
    for c in candidates {
        if let Ok(canon) = c.canonicalize() {
            if !roots.contains(&canon) {
                roots.push(canon);
            }
        }
    }
    roots
}

fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_claude_uid_segment(s: &str) -> bool {
    s.strip_prefix("claude-")
        .is_some_and(|u| !u.is_empty() && u.chars().all(|c| c.is_ascii_digit()))
}

/// Shape checks shared by the lexical and the canonical form of a path.
fn shape_ok(path: &Path, task_id: &str) -> bool {
    if !valid_task_id(task_id) {
        return false;
    }
    let file_ok = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == format!("{task_id}.output"));
    let parent_ok = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "tasks");
    let has_uid = path.components().any(
        |c| matches!(c, Component::Normal(s) if s.to_str().is_some_and(is_claude_uid_segment)),
    );
    file_ok && parent_ok && has_uid
}

/// Filesystem-free validation done when the path is parsed from a tool result:
/// absolute, no `..` component, right shape. Failing it means "no output file".
#[must_use]
pub(crate) fn lexical_ok(path: &str, task_id: &str) -> bool {
    let p = Path::new(path);
    p.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        && shape_ok(p, task_id)
}

/// Full validation against the filesystem; returns the canonical path.
pub(crate) fn resolve(
    path: &str,
    task_id: &str,
    roots: &[PathBuf],
) -> Result<PathBuf, OutputError> {
    // `..` is rejected BEFORE canonicalising, never normalised away.
    if !lexical_ok(path, task_id) {
        return Err(OutputError::Rejected);
    }
    let p = Path::new(path);
    // `lstat` of the FINAL component: a symlink (or FIFO/dir) is refused
    // without ever opening it. Parent symlinks (macOS /tmp) are fine and are
    // checked through the canonical path below.
    let lmeta = std::fs::symlink_metadata(p).map_err(|_| OutputError::Io)?;
    if lmeta.file_type().is_symlink() || !lmeta.file_type().is_file() {
        return Err(OutputError::Rejected);
    }
    let canon = p.canonicalize().map_err(|_| OutputError::Io)?;
    if !roots.iter().any(|r| canon.starts_with(r)) || !shape_ok(&canon, task_id) {
        return Err(OutputError::Rejected);
    }
    Ok(canon)
}

#[cfg(unix)]
fn open_nofollow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_nofollow(path: &Path) -> std::io::Result<std::fs::File> {
    OpenOptions::new().read(true).open(path)
}

fn read_blocking(canon: &Path, tail_lines: usize) -> Result<FileTail, OutputError> {
    let mut file = open_nofollow(canon).map_err(|_| OutputError::Io)?;
    let meta = file.metadata().map_err(|_| OutputError::Io)?;
    if !meta.is_file() {
        return Err(OutputError::Rejected);
    }
    let total = meta.len();
    let start = total.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| OutputError::Io)?;
    let mut buf = Vec::new();
    file.take(MAX_TAIL_BYTES)
        .read_to_end(&mut buf)
        .map_err(|_| OutputError::Io)?;
    // The cut may split a UTF-8 sequence: decode lossily.
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let over = lines.len().saturating_sub(tail_lines);
    let lines: Vec<String> = lines[over..]
        .iter()
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    Ok(FileTail {
        lines,
        truncated: start > 0 || over > 0,
        total_bytes: total,
    })
}

/// Validate and read the last `tail_lines` lines (<= 256 KiB) of a task's
/// output file, off the async runtime and under a 2 s timeout.
pub async fn read_output_file(
    path: &str,
    task_id: &str,
    roots: &[PathBuf],
    tail_lines: usize,
) -> Result<FileTail, OutputError> {
    let canon = resolve(path, task_id, roots)?;
    let work = tokio::task::spawn_blocking(move || read_blocking(&canon, tail_lines));
    match tokio::time::timeout(Duration::from_millis(OUTPUT_READ_TIMEOUT_MS), work).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err(OutputError::Io),
        Err(_) => Err(OutputError::Timeout),
    }
}

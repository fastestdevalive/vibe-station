//! Applying a native hand-over: move just this session's history file(s) from
//! the old account folder into the new one.
//!
//! Safety rules (Decision 7 / nodeterm's shape): every path is canonicalised
//! and must stay inside its root (a symlink escape is refused). An existing
//! target is replaced only when it is a byte prefix of the source (an earlier
//! copy of the same append-only conversation); a target that already holds
//! the whole source (the source is its byte prefix) is left alone, and
//! anything else (a symlink, a directory, diverged or unrelated content) is
//! refused untouched. A hard link is verified by length and falls back to a copy when the link
//! fails (EXDEV), and copies go through a temp name + rename so a crash can
//! never leave a half-written file in the new account's history.

use std::fs;
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};

use vst_types::{FileTransfer, TransferMode};

/// What `apply` did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ApplyReport {
    pub applied: usize,
    /// Already present and complete, or no source to hand over (nothing to do).
    pub skipped: usize,
    /// An earlier copy (byte prefix) at the target was replaced.
    pub replaced: usize,
    /// Hard link failed, so the file was copied instead.
    pub copied_after_link_failure: usize,
}

/// Why a hand-over failed. Any error aborts the switch with the old session
/// intact (the caller reports `handover_failed`).
#[derive(Debug, thiserror::Error)]
pub enum HandoverError {
    #[error("transfer source is outside the old account folder: {0}")]
    SourceOutsideRoot(String),
    #[error("transfer target is outside the new account folder: {0}")]
    TargetOutsideRoot(String),
    #[error("refusing to overwrite a different file at {0}")]
    WouldClobber(String),
    #[error("hand-over failed")]
    Io(#[from] io::Error),
}

/// Apply every transfer. A missing source is skipped (nothing to hand over),
/// never an error.
///
/// # Errors
///
/// A source or target outside its root (incl. a symlink escape), an existing
/// different file at the target, or a filesystem failure.
pub fn apply(
    transfers: &[FileTransfer],
    from_root: &Path,
    to_root: &Path,
) -> Result<ApplyReport, HandoverError> {
    let from_root = fs::canonicalize(from_root)?;
    let to_root = fs::canonicalize(to_root)?;
    let mut report = ApplyReport::default();
    for transfer in transfers {
        if fs::symlink_metadata(&transfer.from).is_err() {
            report.skipped += 1;
            continue;
        }
        let source = fs::canonicalize(&transfer.from)?;
        if !source.starts_with(&from_root) {
            return Err(HandoverError::SourceOutsideRoot(
                transfer.from.display().to_string(),
            ));
        }
        let target = resolve_target(&transfer.to, &to_root)?;
        match classify_target(&source, &target)? {
            Existing::Missing => {}
            Existing::HasSource => {
                report.skipped += 1;
                continue;
            }
            Existing::EarlierCopy => {
                // A hard link cannot replace an existing name, so always copy.
                copy_into_place(&source, &target)?;
                report.replaced += 1;
                continue;
            }
            Existing::Different => {
                return Err(HandoverError::WouldClobber(target.display().to_string()));
            }
        }
        match transfer.mode {
            TransferMode::Copy => copy_into_place(&source, &target)?,
            TransferMode::HardLink => {
                if hard_link_verified(&source, &target)? {
                    report.copied_after_link_failure += 1;
                }
            }
        }
        report.applied += 1;
    }
    Ok(report)
}

/// What is already at a transfer's target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Existing {
    Missing,
    /// The source is a byte prefix of the target (equal files included).
    HasSource,
    /// The target is a shorter byte prefix of the source.
    EarlierCopy,
    /// Anything else: not a regular file, or diverged content.
    Different,
}

fn classify_target(source: &Path, target: &Path) -> io::Result<Existing> {
    let Ok(meta) = fs::symlink_metadata(target) else {
        return Ok(Existing::Missing);
    };
    if !meta.file_type().is_file() {
        return Ok(Existing::Different);
    }
    if is_prefix_of(source, target)? {
        Ok(Existing::HasSource)
    } else if is_prefix_of(target, source)? {
        Ok(Existing::EarlierCopy)
    } else {
        Ok(Existing::Different)
    }
}

/// Whether `short`'s bytes are the first bytes of `long`; compared in 64 KiB
/// chunks, never reading a whole file.
fn is_prefix_of(short: &Path, long: &Path) -> io::Result<bool> {
    let short_len = fs::metadata(short)?.len();
    if short_len > fs::metadata(long)?.len() {
        return Ok(false);
    }
    let mut a = BufReader::new(fs::File::open(short)?);
    let mut b = BufReader::new(fs::File::open(long)?).take(short_len);
    let (mut ba, mut bb) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = read_full(&mut a, &mut ba)?;
        let m = read_full(&mut b, &mut bb[..n])?;
        if m != n || ba[..n] != bb[..n] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Fill `buf` unless EOF comes first; returns the bytes read.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..])? {
            0 => break,
            n => got += n,
        }
    }
    Ok(got)
}

/// Resolve `to` to an absolute path inside `root`, creating missing parents.
fn resolve_target(to: &Path, root: &Path) -> Result<PathBuf, HandoverError> {
    let parent = to
        .parent()
        .ok_or_else(|| HandoverError::TargetOutsideRoot(to.display().to_string()))?;
    let name = to
        .file_name()
        .ok_or_else(|| HandoverError::TargetOutsideRoot(to.display().to_string()))?;
    let canon_parent = ensure_dir_inside(parent, root)?;
    Ok(canon_parent.join(name))
}

/// Create `dir` (with parents) after proving it lands inside `root` — the
/// nearest existing ancestor is canonicalised first, so a symlinked parent
/// cannot smuggle the write outside.
fn ensure_dir_inside(dir: &Path, root: &Path) -> Result<PathBuf, HandoverError> {
    let mut probe = dir;
    loop {
        if fs::symlink_metadata(probe).is_ok() {
            break;
        }
        probe = probe
            .parent()
            .ok_or_else(|| HandoverError::TargetOutsideRoot(dir.display().to_string()))?;
    }
    if !fs::canonicalize(probe)?.starts_with(root) {
        return Err(HandoverError::TargetOutsideRoot(dir.display().to_string()));
    }
    fs::create_dir_all(dir)?;
    let canon = fs::canonicalize(dir)?;
    if !canon.starts_with(root) {
        return Err(HandoverError::TargetOutsideRoot(dir.display().to_string()));
    }
    Ok(canon)
}

/// Hard-link `source` to `target` and verify the length. `Ok(true)` = the link
/// was refused (e.g. EXDEV) and the file was copied instead.
fn hard_link_verified(source: &Path, target: &Path) -> Result<bool, HandoverError> {
    if fs::hard_link(source, target).is_err() {
        copy_into_place(source, target)?;
        return Ok(true);
    }
    let linked = fs::metadata(target)?.len();
    if linked != fs::metadata(source)?.len() {
        return Err(HandoverError::Io(io::Error::other(
            "hard link length mismatch",
        )));
    }
    Ok(false)
}

/// Copy `source` to `target` through a temp name + rename.
fn copy_into_place(source: &Path, target: &Path) -> Result<(), HandoverError> {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("history");
    let tmp = target.with_file_name(format!(".{name}.vst-tmp"));
    fs::copy(source, &tmp)?;
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp); // best-effort cleanup; the error is returned
        return Err(e.into());
    }
    Ok(())
}

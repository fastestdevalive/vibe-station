//! Account folders: `<root>/<cli>/<name>` (mode 0700) plus the symlinks that
//! bring the CLI's own shared entries (skills, settings, …) into it. `<name>`
//! is an account id, or a slug of the label for "create for me" folders.
//!
//! Linking is best-effort: a missing or dangling source entry is skipped, a
//! failed link is only logged, and an existing target is never overwritten —
//! losing a shared entry must never stop an account from being created.

use std::fs;
use std::io;
use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use vst_types::{SharedEntries, SharedSet};

/// Mode of every account directory.
pub const DIR_MODE: u32 = 0o700;

/// Longest slug produced by [`slugify`] (bytes; the slug is ASCII).
const SLUG_MAX: usize = 40;

/// Highest collision suffix tried by [`create_managed_dir`] (`-2` ..= `-99`).
const MAX_SUFFIX: u32 = 99;

/// Lowercase ASCII slug of `label`: every run of non-`[a-z0-9]` characters
/// becomes one `-`, leading/trailing `-` are trimmed, capped at 40. Empty when
/// nothing usable remains (the caller then uses the account id).
#[must_use]
pub fn slugify(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let capped: String = out.trim_matches('-').chars().take(SLUG_MAX).collect();
    capped.trim_end_matches('-').to_string()
}

/// Create a managed folder `<root>/<cli>/<name>` for "create for me" (Decision 11).
/// `<name>` is the slug of `preferred`, or `id` when that is empty; a taken name
/// tries `-2` .. `-99`. The leaf is created non-recursively so a race fails
/// atomically and moves on to the next suffix.
///
/// # Errors
///
/// A filesystem error other than "name taken", or every candidate taken.
pub fn create_managed_dir(
    root: &Path,
    cli: &str,
    preferred: &str,
    id: &str,
) -> io::Result<PathBuf> {
    let slug = slugify(preferred);
    let base = if slug.is_empty() {
        id.to_string()
    } else {
        slug
    };
    let parent = root.join(cli);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(DIR_MODE);
    builder.create(&parent)?;
    for n in 1..=MAX_SUFFIX {
        let name = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let dir = parent.join(name);
        match make_leaf(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free folder name",
    ))
}

/// Create one leaf folder (non-recursive, mode 0700) and pin its mode.
fn make_leaf(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.mode(DIR_MODE);
    builder.create(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(DIR_MODE))
}

/// True iff `dir` is exactly `<root>/<cli>/<name>` (path-only; the dir need not exist).
#[must_use]
pub fn is_managed_dir(root: &Path, cli: &str, dir: &Path) -> bool {
    let Some(name) = dir.file_name() else {
        return false;
    };
    let Some(parent) = dir.parent().and_then(|p| p.canonicalize().ok()) else {
        return false;
    };
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    parent.file_name() == Some(std::ffi::OsStr::new(cli))
        && parent.parent() == Some(root.as_path())
        && !name.is_empty()
}

/// Remove `dir` only if [`is_managed_dir`] holds. Returns `Ok(true)` when
/// something was removed. A symlink is unlinked, never followed.
///
/// # Errors
///
/// A filesystem error other than "not found".
pub fn remove_managed_dir(root: &Path, cli: &str, dir: &Path) -> io::Result<bool> {
    if !is_managed_dir(root, cli, dir) {
        return Ok(false);
    }
    let (Some(parent), Some(name)) = (
        dir.parent().and_then(|p| p.canonicalize().ok()),
        dir.file_name(),
    ) else {
        return Ok(false);
    };
    let target = parent.join(name);
    match fs::symlink_metadata(&target) {
        Ok(m) if m.file_type().is_symlink() => fs::remove_file(&target).map(|()| true),
        Ok(_) => fs::remove_dir_all(&target).map(|()| true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Create `<root>/<cli>/<id>` (and its parents) with mode 0700.
///
/// # Errors
///
/// Propagates any filesystem error from creating or chmod-ing the folder.
pub fn create_account_dir(root: &Path, cli: &str, id: &str) -> io::Result<PathBuf> {
    let dir = account_dir(root, cli, id);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(DIR_MODE);
    builder.create(&dir)?;
    // `mode()` on DirBuilder only applies to directories it creates; an
    // existing dir keeps its mode, so set it explicitly.
    fs::set_permissions(&dir, fs::Permissions::from_mode(DIR_MODE))?;
    Ok(dir)
}

/// The account folder path (not created).
#[must_use]
pub fn account_dir(root: &Path, cli: &str, id: &str) -> PathBuf {
    root.join(cli).join(id)
}

/// Symlink the CLI's shared entries into `dir`. Never overwrites, never fails
/// the caller: every problem is a `tracing::warn!`.
pub fn link_shared_entries(dir: &Path, entries: &SharedEntries) {
    match &entries.set {
        SharedSet::Named(names) => {
            for name in names {
                let source = entries.source_dir.join(name);
                link_one(dir, &source);
            }
        }
        SharedSet::AllExcept(excluded) => {
            let Ok(read) = fs::read_dir(&entries.source_dir) else {
                tracing::warn!(
                    dir = %entries.source_dir.display(),
                    "account shared entries: source dir unreadable"
                );
                return;
            };
            for entry in read.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if excluded.iter().any(|e| *e == name) {
                    continue;
                }
                link_one(dir, &entry.path());
            }
        }
    }
}

/// Link one source entry as `dir/<basename>`, skipping missing/dangling
/// sources and existing targets.
fn link_one(dir: &Path, source: &Path) {
    // Follows symlinks: a dangling source is skipped, not linked.
    if fs::metadata(source).is_err() {
        return;
    }
    let Some(name) = source.file_name() else {
        return;
    };
    let target = dir.join(name);
    if target.symlink_metadata().is_ok() {
        return;
    }
    if let Err(e) = symlink(source, &target) {
        tracing::warn!(
            source = %source.display(),
            target = %target.display(),
            "account shared entry link failed: {e}"
        );
    }
}

//! Atomic multi-file replace with `.prev` backups. Adapters are renamed first and `vst` LAST, so a crash midway leaves
//! `vst --version` reporting the old version and the update still offered.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use vst_types::rest::update::{UpdateError, UpdateReason};

use super::install_err;

/// EVERY binary the CLI archive has ever shipped: the single source for what an
/// install looks like (`detect.rs`'s sibling-adapter test derives from it), which
/// stale `.new`/`.prev` files are cleaned, and which `.prev` files a rollback
/// restores. Never remove a name (old installs must stay recognised and rolled
/// back); add a new binary here when the archive starts shipping it.
///
/// Today's tarball is `vst` + `claude-acp` + `codex-acp`
/// (`scripts/package-cli-tarball.sh`). Legacy: `agy-acp` shipped in older releases
/// (agy Rich Chat is now the `vst agy-stream-acp` subcommand) and `vst-agy` was an
/// older adapter name.
pub(crate) const KNOWN_NAMES: [&str; 5] = ["agy-acp", "claude-acp", "codex-acp", "vst", "vst-agy"];
const SMOKE_TIMEOUT: Duration = Duration::from_secs(10);

fn dot(name: &str, suffix: &str) -> String {
    format!(".{name}.{suffix}")
}

/// Map a post-download write error to the same reasons preflight uses:
/// ENOSPC -> `DiskFull`, EACCES/EPERM/EROFS -> `PermissionDenied`.
pub(crate) fn io_reason(e: &io::Error) -> UpdateReason {
    // `ErrorKind::StorageFull`/`ReadOnlyFilesystem` need a newer MSRV than
    // this workspace pins, so match the raw errno instead.
    if e.raw_os_error() == Some(libc::ENOSPC) {
        UpdateReason::DiskFull
    } else if e.kind() == io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(libc::EROFS) {
        UpdateReason::PermissionDenied
    } else {
        UpdateReason::WriteFailed
    }
}

fn io_err(what: &str, e: &io::Error) -> UpdateError {
    install_err(io_reason(e), format!("{what}: {e}"))
}

/// Remove stale `.<n>.new` working files for the known names.
pub fn clean_stale_new(dir: &Path) {
    for n in KNOWN_NAMES {
        let _ = fs::remove_file(dir.join(dot(n, "new")));
    }
}

/// Adapters (alphabetical) first, `vst` last.
fn ordered_names(new_files: &[PathBuf]) -> Vec<String> {
    let mut names: Vec<String> = new_files
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    names.sort();
    names.dedup();
    let (mut rest, vst): (Vec<_>, Vec<_>) = names.into_iter().partition(|n| n != "vst");
    rest.extend(vst);
    rest
}

fn set_exec(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// Hardlink `src` to `dst` (pinning the old inode), falling back to a copy.
fn link_or_copy(src: &Path, dst: &Path) -> io::Result<()> {
    let _ = fs::remove_file(dst);
    fs::hard_link(src, dst).or_else(|_| fs::copy(src, dst).map(|_| ()))
}

/// Run `prog --version` with a 10 s timeout; first stdout line, trimmed.
fn smoke_version(prog: &Path) -> Option<String> {
    crate::update::exec::run_first_line(prog, &["--version"], SMOKE_TIMEOUT)
}

/// A CLI set staged as `.<n>.new` beside its live files and smoke-tested,
/// not yet renamed into place (staging + smoke belong to `Verifying`).
#[derive(Debug, Clone)]
pub struct StagedCliSet {
    pub dir: PathBuf,
    pub names: Vec<String>,
}

impl StagedCliSet {
    /// Remove every staged `.new` file (idempotent; a no-op after commit).
    pub fn discard(&self) {
        for n in &self.names {
            let _ = fs::remove_file(self.dir.join(dot(n, "new")));
        }
    }
}

/// Stage every file of `new_files` beside its destination in `dir` and run
/// the smoke test on the staged `vst`. Nothing live is touched; on any error
/// the staged files are removed.
pub fn stage_cli_set(
    dir: &Path,
    new_files: &[PathBuf],
    latest: &str,
) -> Result<StagedCliSet, UpdateError> {
    let names = ordered_names(new_files);
    if !names.iter().any(|n| n == "vst") {
        return Err(install_err(
            UpdateReason::WriteFailed,
            "update set has no 'vst' binary",
        ));
    }
    clean_stale_new(dir);
    let staged = StagedCliSet {
        dir: dir.to_path_buf(),
        names,
    };
    // Stage every new file beside its destination (same filesystem).
    for src in new_files {
        let Some(n) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let tmp = dir.join(dot(&n, "new"));
        let ok = fs::copy(src, &tmp).and_then(|_| set_exec(&tmp));
        if let Err(e) = ok {
            staged.discard();
            return Err(io_err(&format!("cannot stage {n}"), &e));
        }
    }
    // Smoke test the new `vst` before touching anything live.
    let got = smoke_version(&dir.join(dot("vst", "new")));
    if got.as_deref() != Some(latest) {
        staged.discard();
        return Err(install_err(
            UpdateReason::SmokeFailed,
            format!(
                "the downloaded vst reported version {} instead of {latest}; nothing was replaced",
                got.as_deref().unwrap_or("(no output)")
            ),
        ));
    }
    Ok(staged)
}

/// Stage, smoke and commit in one call (tests; the installer calls the two
/// halves separately so the smoke test runs while the stage is `Verifying`).
pub fn replace_cli_set(
    dir: &Path,
    new_files: &[PathBuf],
    latest: &str,
    keep_prev: bool,
) -> Result<Vec<String>, UpdateError> {
    replace_cli_set_hooked(dir, new_files, latest, keep_prev, &mut |_| Ok(()))
}

pub(crate) fn replace_cli_set_hooked(
    dir: &Path,
    new_files: &[PathBuf],
    latest: &str,
    keep_prev: bool,
    before_rename: &mut dyn FnMut(&str) -> io::Result<()>,
) -> Result<Vec<String>, UpdateError> {
    let staged = stage_cli_set(dir, new_files, latest)?;
    commit_cli_set_hooked(&staged, keep_prev, before_rename)
}

/// Rename a staged set into place; returns the replaced names in rename
/// order (adapters first, `vst` last). See module docs for ordering.
///
/// `keep_prev`: a restart is still pending for this directory, so the
/// files on disk are a build that has NOT booted yet. The existing `.prev`
/// set (the build that is actually running, which the rollback watcher must
/// restore) is then left untouched; only names without a `.prev` get one.
pub fn commit_cli_set(staged: &StagedCliSet, keep_prev: bool) -> Result<Vec<String>, UpdateError> {
    commit_cli_set_hooked(staged, keep_prev, &mut |_| Ok(()))
}

/// [`commit_cli_set`] with a hook invoked with each file name immediately
/// BEFORE its rename (tests assert order and inject failures through it).
pub(crate) fn commit_cli_set_hooked(
    staged: &StagedCliSet,
    keep_prev: bool,
    before_rename: &mut dyn FnMut(&str) -> io::Result<()>,
) -> Result<Vec<String>, UpdateError> {
    let (dir, names) = (staged.dir.as_path(), &staged.names);
    // The prior `.prev` set.
    if !keep_prev {
        for n in KNOWN_NAMES
            .iter()
            .map(|s| s.to_string())
            .chain(names.iter().cloned())
        {
            let _ = fs::remove_file(dir.join(dot(&n, "prev")));
        }
    }
    let mut done = Vec::new();
    for n in names {
        let live = dir.join(n);
        let step = (|| -> io::Result<()> {
            before_rename(n)?;
            let prev = dir.join(dot(n, "prev"));
            if live.exists() && !(keep_prev && prev.exists()) {
                link_or_copy(&live, &prev)?;
            }
            fs::rename(dir.join(dot(n, "new")), &live)
        })();
        if let Err(e) = step {
            staged.discard();
            return Err(io_err(&format!("cannot replace {n}"), &e));
        }
        done.push(n.clone());
    }
    Ok(done)
}

/// Replace a single file (an AppImage): stage `.<name>.new` beside `path`
/// (0755), hardlink the old one to `.<name>.prev`, then `rename`.
pub fn replace_single(path: &Path, new_file: &Path) -> Result<(), UpdateError> {
    let (Some(dir), Some(name)) = (
        path.parent(),
        path.file_name().map(|n| n.to_string_lossy().into_owned()),
    ) else {
        return Err(install_err(
            UpdateReason::WriteFailed,
            "invalid install target path",
        ));
    };
    let tmp = dir.join(dot(&name, "new"));
    let prev = dir.join(dot(&name, "prev"));
    let _ = fs::remove_file(&tmp);
    let result = (|| -> io::Result<()> {
        fs::copy(new_file, &tmp)?;
        set_exec(&tmp)?;
        if path.exists() {
            link_or_copy(path, &prev)?;
        }
        fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err(&format!("cannot replace {name}"), &e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(path: &Path, ver: &str) {
        fs::write(path, format!("#!/bin/sh\necho {ver}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn setup() -> (tempfile::TempDir, PathBuf, Vec<PathBuf>) {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("bin");
        let new = t.path().join("new");
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&new).unwrap();
        for n in ["vst", "claude-acp"] {
            script(&live.join(n), "1.0.0");
        }
        let files: Vec<PathBuf> = ["vst", "claude-acp", "codex-acp"]
            .iter()
            .map(|n| {
                let p = new.join(n);
                script(&p, "2.0.0");
                p
            })
            .collect();
        (t, live, files)
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn replaces_with_prev_and_vst_last() {
        let (_t, live, files) = setup();
        // a prior .prev set must be deleted
        fs::write(live.join(".vst.prev"), "ancient").unwrap();
        fs::write(live.join(".vst.new"), "stale").unwrap();
        let mut order = Vec::new();
        let done = replace_cli_set_hooked(&live, &files, "2.0.0", false, &mut |n| {
            order.push(n.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(order, ["claude-acp", "codex-acp", "vst"]);
        assert_eq!(done, order);
        assert!(read(&live.join("vst")).contains("2.0.0"));
        assert!(read(&live.join(".vst.prev")).contains("1.0.0"));
        assert!(read(&live.join(".claude-acp.prev")).contains("1.0.0"));
        // codex-acp is new in this release: no .prev
        assert!(!live.join(".codex-acp.prev").exists());
        assert!(!live.join(".vst.new").exists());
        // second install drops the prior .prev set (now holds 2.0.0)
        replace_cli_set(&live, &files, "2.0.0", false).unwrap();
        assert!(read(&live.join(".vst.prev")).contains("2.0.0"));
    }

    #[test]
    fn keep_prev_preserves_running_build_across_second_install_d10() {
        let (_t, live, files) = setup();
        // install v2 (not restarted): .vst.prev = v1
        replace_cli_set(&live, &files, "2.0.0", false).unwrap();
        assert!(read(&live.join(".vst.prev")).contains("1.0.0"));
        // install v3 with the restart still pending: .prev must stay v1
        for p in &files {
            script(p, "3.0.0");
        }
        let v3 = files;
        replace_cli_set(&live, &v3, "3.0.0", true).unwrap();
        assert!(read(&live.join("vst")).contains("3.0.0"));
        assert!(read(&live.join(".vst.prev")).contains("1.0.0"));
        assert!(read(&live.join(".claude-acp.prev")).contains("1.0.0"));
        // codex-acp had no .prev (new in v2): it gets one now
        assert!(read(&live.join(".codex-acp.prev")).contains("2.0.0"));
    }

    #[test]
    fn failure_after_adapters_leaves_vst_old() {
        let (_t, live, files) = setup();
        let r = replace_cli_set_hooked(&live, &files, "2.0.0", false, &mut |n| {
            if n == "vst" {
                Err(io::Error::other("injected"))
            } else {
                Ok(())
            }
        });
        assert_eq!(r.unwrap_err().reason, UpdateReason::WriteFailed);
        let out = std::process::Command::new(live.join("vst"))
            .arg("--version")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "1.0.0");
        assert!(read(&live.join("claude-acp")).contains("2.0.0"));
        assert!(!live.join(".vst.new").exists());
    }

    #[test]
    fn smoke_mismatch_touches_nothing() {
        let (_t, live, files) = setup();
        let e = replace_cli_set(&live, &files, "3.0.0", false).unwrap_err();
        assert_eq!(e.reason, UpdateReason::SmokeFailed);
        assert!(read(&live.join("vst")).contains("1.0.0"));
        assert!(read(&live.join("claude-acp")).contains("1.0.0"));
        assert!(!live.join(".vst.new").exists() && !live.join(".codex-acp.new").exists());
    }

    #[test]
    fn io_reason_maps_enospc_and_erofs_d17() {
        let e = io::Error::from_raw_os_error(libc::ENOSPC);
        assert_eq!(io_reason(&e), UpdateReason::DiskFull);
        assert_eq!(io_err("x", &e).reason, UpdateReason::DiskFull);
        let e = io::Error::from_raw_os_error(libc::EROFS);
        assert_eq!(io_reason(&e), UpdateReason::PermissionDenied);
        let e = io::Error::from_raw_os_error(libc::EACCES);
        assert_eq!(io_reason(&e), UpdateReason::PermissionDenied);
        let e = io::Error::from_raw_os_error(libc::EIO);
        assert_eq!(io_reason(&e), UpdateReason::WriteFailed);
    }

    #[test]
    fn stage_smoke_failure_is_before_any_live_change_d19() {
        let (_t, live, files) = setup();
        fs::write(live.join(".vst.prev"), "keep-me").unwrap();
        let e = stage_cli_set(&live, &files, "3.0.0").unwrap_err();
        assert_eq!(e.reason, UpdateReason::SmokeFailed);
        // a failed stage must not even drop the previous .prev set
        assert_eq!(read(&live.join(".vst.prev")), "keep-me");
        let ok = stage_cli_set(&live, &files, "2.0.0").unwrap();
        assert!(live.join(".vst.new").exists());
        assert!(read(&live.join("vst")).contains("1.0.0"));
        commit_cli_set(&ok, false).unwrap();
        assert!(read(&live.join("vst")).contains("2.0.0"));
    }

    #[test]
    fn replace_single_keeps_prev() {
        let t = tempfile::tempdir().unwrap();
        let app = t.path().join("app.AppImage");
        fs::write(&app, "old").unwrap();
        let new = t.path().join("dl.AppImage");
        fs::write(&new, "new").unwrap();
        replace_single(&app, &new).unwrap();
        assert_eq!(read(&app), "new");
        assert_eq!(read(&t.path().join(".app.AppImage.prev")), "old");
        assert_eq!(
            fs::metadata(&app).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}

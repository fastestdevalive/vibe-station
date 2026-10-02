#![forbid(unsafe_code)]

//! Environment setup, vst shim, shell config patching, and harness skill installation.
//! Ports `daemon/src/lib/resolveVstPaths.ts` and `daemon/src/lib/harnessSkillDirs.ts`.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use vst_agents::home::home_dir;

const SHELL_PATH_MARKER: &str = "added by vibe-station";

struct ShellConfig {
    path: PathBuf,
    line: &'static str,
}

fn shell_configs() -> Vec<ShellConfig> {
    let home = home_dir();
    vec![
        ShellConfig {
            path: home.join(".zshrc"),
            line: "\nexport PATH=\"$HOME/.vibe-station/bin:$PATH\"  # added by vibe-station\n",
        },
        ShellConfig {
            path: home.join(".bashrc"),
            line: "\nexport PATH=\"$HOME/.vibe-station/bin:$PATH\"  # added by vibe-station\n",
        },
        ShellConfig {
            path: home.join(".profile"),
            line: "\nexport PATH=\"$HOME/.vibe-station/bin:$PATH\"  # added by vibe-station\n",
        },
        ShellConfig {
            path: home.join(".zprofile"),
            line: "\nexport PATH=\"$HOME/.vibe-station/bin:$PATH\"  # added by vibe-station\n",
        },
        ShellConfig {
            path: home.join(".config").join("fish").join("config.fish"),
            line: "\nfish_add_path $HOME/.vibe-station/bin  # added by vibe-station\n",
        },
    ]
}

/// Resolve the source of the vst CLI binary.
pub fn resolve_vst_cli_bin_source() -> Option<PathBuf> {
    if let Ok(bin) = std::env::var("VST_CLI_BIN") {
        let p = PathBuf::from(bin);
        if p.exists() {
            return Some(p);
        }
    }

    // Try relative to current executable or workspace dev fallback
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent()?;
        for name in &["vst", "vst-cli"] {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

/// The single copy of the vst skill, embedded at compile time from the repo's
/// `skill/SKILL.md`. Every on-disk copy — the `~/.vibe-station/skill/vst`
/// install and the `~/.claude`/`~/.gemini` harness links — refers back to this
/// one source; nothing is ever read back off the filesystem to re-seed it.
const VST_SKILL_MD: &str = include_str!("../../../skill/SKILL.md");

/// Write ~/.vibe-station/bin/vst shim and install the embedded vst skill to
/// ~/.vibe-station/skill/vst/SKILL.md.
pub async fn setup_vst_environment(vst_home: &Path) {
    let bin_dir = vst_home.join("bin");
    let shim_path = bin_dir.join("vst");

    // ── shim ─────────────────────────────────────────────────────────────
    if let Some(src) = resolve_vst_cli_bin_source() {
        if let Err(e) = (|| -> std::io::Result<()> {
            fs::create_dir_all(&bin_dir)?;
            let src_str = src.to_string_lossy();
            let shim_content = format!("#!/bin/sh\nexec \"{src_str}\" \"$@\"\n");
            fs::write(&shim_path, shim_content)?;
            let mut perms = fs::metadata(&shim_path)?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&shim_path, perms)?;
            Ok(())
        })() {
            tracing::warn!("[vst] could not write vst shim: {e}");
        }
    } else {
        tracing::debug!("[vst] VST_CLI_BIN not set and fallback not found — skipping vst shim");
    }

    // ── skill ────────────────────────────────────────────────────────────
    // Always written from the embedded string (never read back from the
    // filesystem), atomically and only when the bytes differ.
    if let Err(e) = install_vst_skill(vst_home) {
        tracing::warn!("[vst] could not install embedded vst SKILL.md: {e}");
    }
}

/// Write the embedded vst skill to `~/.vibe-station/skill/vst/SKILL.md`,
/// atomically (tmp + rename) and only when the on-disk bytes differ.
fn install_vst_skill(vst_home: &Path) -> std::io::Result<()> {
    let dest = vst_home.join("skill").join("vst").join("SKILL.md");
    let already_current = fs::read(&dest).is_ok_and(|b| b.as_slice() == VST_SKILL_MD.as_bytes());
    if already_current {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dest.with_extension("tmp");
    fs::write(&tmp, VST_SKILL_MD)?;
    fs::rename(&tmp, &dest)?;
    Ok(())
}

/// Idempotently patch shell configuration files (~/.zshrc, ~/.bashrc, etc.)
/// to ensure ~/.vibe-station/bin is in PATH.
pub async fn patch_shell_configs(vst_home: &Path) {
    let sentinel = vst_home.join(".shell-path-installed");
    if sentinel.exists() {
        return;
    }

    for cfg in shell_configs() {
        if cfg.path.exists() {
            if let Ok(content) = fs::read_to_string(&cfg.path) {
                if content.contains(SHELL_PATH_MARKER) {
                    continue;
                }
                let mut new_content = content;
                new_content.push_str(cfg.line);
                let _ = fs::write(&cfg.path, new_content);
            }
        }
    }

    // Write sentinel
    let _ = fs::create_dir_all(vst_home);
    let _ = fs::write(sentinel, "installed\n");
}

/// Resolve directories where external harnesses look for skills.
pub fn resolve_harness_skill_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let claude = std::env::var("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".claude"))
        .join("skills");
    let gemini = std::env::var("GEMINI_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".gemini"))
        .join("skills");
    vec![claude, gemini]
}

/// Install `~/.vibe-station/skill/vst` into each harness skill dir as a
/// **directory symlink** — one copy on disk, many harnesses referring to it.
/// Create the link when missing; migrate a daemon-written real directory left
/// by the old installer; leave alone a real directory a user owns or a link
/// pointing somewhere else (each left-alone path is logged once).
pub async fn install_harness_skill_dirs(vst_home: &Path) {
    let target = vst_home.join("skill").join("vst");
    install_harness_links(&resolve_harness_skill_dirs(), &target);
}

/// Ensure `<dir>/vst` is a directory symlink to `target` for every harness dir.
/// No-op when the install dir has no `SKILL.md` yet (nothing to point at).
fn install_harness_links(harness_dirs: &[PathBuf], target: &Path) {
    if !target.join("SKILL.md").exists() {
        return;
    }
    for dir in harness_dirs {
        let link = dir.join("vst");
        match ensure_harness_skill_link(dir, target) {
            Ok(()) => {}
            Err(HarnessLinkSkip::RealDir) => {
                tracing::info!(
                    "[vst] leaving {} alone (already a real directory) — no auto-update for that harness link",
                    link.display()
                );
            }
            Err(HarnessLinkSkip::LinkElsewhere) => {
                tracing::warn!(
                    "[vst] leaving {} alone (symlink points elsewhere) — no auto-update for that harness link",
                    link.display()
                );
            }
            Err(HarnessLinkSkip::Io(e)) => {
                tracing::warn!(
                    "[vst] could not link {} to the install: {e}",
                    link.display()
                );
            }
        }
    }
}

/// Why `ensure_harness_skill_link` declined to touch an existing path.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HarnessLinkSkip {
    /// A real directory the user owns — informational, expected.
    RealDir,
    /// A symlink pointing somewhere other than the install — worth a warning.
    LinkElsewhere,
    /// A real I/O failure while creating or migrating the link.
    Io(String),
}

/// Ensure `<dir>/vst` is a directory symlink to `target`. Creates it when
/// missing (including the parent dir); migrates a real directory that holds a
/// daemon-written `SKILL.md`; declines to touch a user-owned real directory or
/// a symlink pointing somewhere other than `target`.
fn ensure_harness_skill_link(dir: &Path, target: &Path) -> Result<(), HarnessLinkSkip> {
    let link = dir.join("vst");
    match fs::symlink_metadata(&link) {
        Err(_) => {
            fs::create_dir_all(dir).map_err(|e| HarnessLinkSkip::Io(e.to_string()))?;
            std::os::unix::fs::symlink(target, &link)
                .map_err(|e| HarnessLinkSkip::Io(e.to_string()))?;
            Ok(())
        }
        Ok(meta) if meta.file_type().is_symlink() => {
            if link_points_at(&link, target) {
                Ok(())
            } else {
                Err(HarnessLinkSkip::LinkElsewhere)
            }
        }
        Ok(_) => {
            if is_daemon_written_skill_dir(&link) {
                // Create the new link first, then swap it over the old dir, so
                // a symlink-creation failure can't leave the harness with no
                // skill at all. rename() over a non-empty dir fails on Unix,
                // so the dir is removed first; by then the link already exists.
                let tmp_link = dir.join(".vst-skill-link.tmp");
                let _ = fs::remove_file(&tmp_link);
                std::os::unix::fs::symlink(target, &tmp_link)
                    .map_err(|e| HarnessLinkSkip::Io(e.to_string()))?;
                fs::remove_dir_all(&link).map_err(|e| HarnessLinkSkip::Io(e.to_string()))?;
                fs::rename(&tmp_link, &link).map_err(|e| HarnessLinkSkip::Io(e.to_string()))?;
                Ok(())
            } else {
                Err(HarnessLinkSkip::RealDir)
            }
        }
    }
}

/// True if `link` resolves (through any symlinks) to the same directory as
/// `target`. Falls back to comparing the link's literal target when the paths
/// can't be canonicalized (e.g. a broken link).
fn link_points_at(link: &Path, target: &Path) -> bool {
    match (fs::canonicalize(link), fs::canonicalize(target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => fs::read_link(link).is_ok_and(|t| t == target),
    }
}

/// True if `dir` is a real directory holding exactly one `SKILL.md` whose
/// first line is the old installer's `<!-- vst-skill-version: … -->` marker —
/// i.e. it was written by a previous version of the daemon, not the user.
fn is_daemon_written_skill_dir(dir: &Path) -> bool {
    let names: Vec<_> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect(),
        Err(_) => return false,
    };
    if names.len() != 1 || names[0] != "SKILL.md" {
        return false;
    }
    fs::read_to_string(dir.join("SKILL.md"))
        .ok()
        .and_then(|s| s.lines().next().map(str::to_owned))
        .is_some_and(|l| l.starts_with("<!-- vst-skill-version:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_skill_writes_when_missing_then_only_when_bytes_differ() {
        let tmp = tempfile::tempdir().unwrap();
        let vst_home = tmp.path();
        let dest = vst_home.join("skill").join("vst").join("SKILL.md");

        // Missing → written.
        install_vst_skill(vst_home).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), VST_SKILL_MD);
        assert!(!dest.with_extension("tmp").exists());

        // Different bytes → rewritten.
        fs::write(&dest, "stale\n").unwrap();
        let rewritten_inode = inode_of(&dest);
        install_vst_skill(vst_home).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), VST_SKILL_MD);
        let current_inode = inode_of(&dest);
        assert_ne!(
            rewritten_inode, current_inode,
            "rewrite must swap in the tmp+rename file"
        );

        // Identical bytes → left alone (same inode, no tmp left behind).
        let before_inode = current_inode;
        install_vst_skill(vst_home).unwrap();
        assert_eq!(
            inode_of(&dest),
            before_inode,
            "must not rewrite when bytes match"
        );
        assert!(!dest.with_extension("tmp").exists());
    }

    #[test]
    fn harness_link_created_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vibe").join("skill").join("vst");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), VST_SKILL_MD).unwrap();

        let harness = tmp.path().join("claude").join("skills");
        let link = harness.join("vst");

        ensure_harness_skill_link(&harness, &target).unwrap();
        let meta = fs::symlink_metadata(&link).unwrap();
        assert!(meta.file_type().is_symlink(), "must be a directory symlink");
        assert_eq!(fs::read_link(&link).unwrap(), target);
        // Symlink resolves to the real install.
        assert!(link.join("SKILL.md").exists());
    }

    #[test]
    fn harness_link_left_alone_when_real_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vibe").join("skill").join("vst");
        let harness = tmp.path().join("claude").join("skills");
        let link = harness.join("vst");
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("SKILL.md"), "user copy\n").unwrap();

        let result = ensure_harness_skill_link(&harness, &target);
        assert_eq!(
            result,
            Err(HarnessLinkSkip::RealDir),
            "real dir must be left alone"
        );
        assert!(!fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(link.join("SKILL.md")).unwrap(),
            "user copy\n"
        );
    }

    #[test]
    fn harness_link_left_alone_when_link_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vibe").join("skill").join("vst");
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let harness = tmp.path().join("claude").join("skills");
        let link = harness.join("vst");
        fs::create_dir_all(&harness).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();

        let result = ensure_harness_skill_link(&harness, &target);
        assert_eq!(
            result,
            Err(HarnessLinkSkip::LinkElsewhere),
            "link pointing elsewhere must be left alone"
        );
        assert_eq!(fs::read_link(&link).unwrap(), elsewhere);
    }

    #[test]
    fn harness_link_left_alone_when_already_correct() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vibe").join("skill").join("vst");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), VST_SKILL_MD).unwrap();

        let harness = tmp.path().join("claude").join("skills");
        let link = harness.join("vst");
        fs::create_dir_all(&harness).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        ensure_harness_skill_link(&harness, &target).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), target);
    }

    #[test]
    fn harness_link_migrates_daemon_written_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vibe").join("skill").join("vst");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), VST_SKILL_MD).unwrap();

        // A real dir left by the old installer: exactly one SKILL.md whose
        // first line is the old daemon's marker.
        let harness = tmp.path().join("claude").join("skills");
        let link = harness.join("vst");
        fs::create_dir_all(&link).unwrap();
        fs::write(
            link.join("SKILL.md"),
            "<!-- vst-skill-version: 0.0.0 -->\n---\nname: vst\n",
        )
        .unwrap();

        ensure_harness_skill_link(&harness, &target).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), target);
        assert!(link.join("SKILL.md").exists());
    }

    #[test]
    fn install_harness_links_creates_links_in_each_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vibe").join("skill").join("vst");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), VST_SKILL_MD).unwrap();

        let claude = tmp.path().join("claude").join("skills");
        let gemini = tmp.path().join("gemini").join("skills");

        install_harness_links(&[claude.clone(), gemini.clone()], &target);

        for dir in [&claude, &gemini] {
            let link = dir.join("vst");
            assert!(fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(fs::read_link(&link).unwrap(), target);
        }
    }

    #[test]
    fn install_harness_links_creates_no_links_when_skill_missing() {
        let tmp = tempfile::tempdir().unwrap();
        // No skill/vst/SKILL.md under this target — the early-return guard fires.
        let target = tmp.path().join("vibe").join("skill").join("vst");
        let harness = tmp.path().join("claude").join("skills");

        install_harness_links(std::slice::from_ref(&harness), &target);

        assert!(!harness.join("vst").exists());
    }

    #[test]
    fn harness_link_left_alone_when_marked_dir_has_extra_files() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vibe").join("skill").join("vst");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), VST_SKILL_MD).unwrap();

        // A daemon-marker SKILL.md plus a user file: NOT purely daemon-written,
        // so it must be left alone even though SKILL.md carries the marker.
        let harness = tmp.path().join("claude").join("skills");
        let link = harness.join("vst");
        fs::create_dir_all(&link).unwrap();
        fs::write(
            link.join("SKILL.md"),
            "<!-- vst-skill-version: 0.0.0 -->\n---\nname: vst\n",
        )
        .unwrap();
        fs::write(link.join("NOTES.md"), "user notes\n").unwrap();

        let result = ensure_harness_skill_link(&harness, &target);
        assert_eq!(result, Err(HarnessLinkSkip::RealDir));
        assert!(!fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(link.join("NOTES.md").exists());
    }

    fn inode_of(path: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(path).unwrap().ino()
    }
}

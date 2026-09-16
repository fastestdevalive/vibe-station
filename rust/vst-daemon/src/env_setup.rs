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
        let candidate = dir.join("vst");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// Resolve the source of SKILL.md.
pub fn resolve_vst_skill_source() -> Option<PathBuf> {
    if let Ok(val) = std::env::var("VST_SKILL_PATH") {
        let p = PathBuf::from(val);
        if p.exists() {
            return Some(p);
        }
    }

    // Try repo-relative skill/SKILL.md
    let candidates = [
        PathBuf::from("skill/SKILL.md"),
        home_dir().join(".vibe-station/skill/vst/SKILL.md"),
    ];

    for c in &candidates {
        if c.exists() {
            return Some(c.clone());
        }
    }

    None
}

/// Write ~/.vibe-station/bin/vst shim and copy SKILL.md to ~/.vibe-station/skill/vst/SKILL.md.
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
    if let Some(skill_src) = resolve_vst_skill_source() {
        let skill_dest = vst_home.join("skill").join("vst").join("SKILL.md");
        if let Err(e) = (|| -> std::io::Result<()> {
            if let Some(parent) = skill_dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let tmp = skill_dest.with_extension("tmp");
            fs::copy(&skill_src, &tmp)?;
            fs::rename(&tmp, &skill_dest)?;
            Ok(())
        })() {
            tracing::warn!("[vst] could not install vst SKILL.md: {e}");
        }
    } else {
        tracing::debug!(
            "[vst] VST_SKILL_PATH not set and fallback not found — skipping skill install"
        );
    }
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

/// Install ~/.vibe-station/skill/vst/SKILL.md into each harness skill dir.
pub async fn install_harness_skill_dirs(vst_home: &Path) {
    let vst_skill_dest = vst_home.join("skill").join("vst").join("SKILL.md");
    let skill_src = if vst_skill_dest.exists() {
        Some(vst_skill_dest)
    } else {
        resolve_vst_skill_source()
    };

    let Some(src_path) = skill_src else {
        return;
    };

    let Ok(src_content) = fs::read_to_string(&src_path) else {
        return;
    };

    // Extract version from frontmatter (e.g. "version: 0.1.0")
    let version = src_content
        .lines()
        .find_map(|l| {
            if l.starts_with("version:") {
                Some(l.trim_start_matches("version:").trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "0.0.0".to_string());

    let marker = format!("<!-- vst-skill-version: {version} -->");
    let content_with_marker = format!("{marker}\n{src_content}");

    for dir in resolve_harness_skill_dirs() {
        let dest = dir.join("vst").join("SKILL.md");
        if let Ok(installed) = fs::read_to_string(&dest) {
            if installed.lines().next().unwrap_or("") == marker {
                continue;
            }
        }
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(dest, &content_with_marker);
    }
}

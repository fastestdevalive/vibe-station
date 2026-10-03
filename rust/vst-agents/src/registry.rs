//! Agent plugin registry — ports `agent-plugins/registry.ts`.
//!
//! Resolves a concrete [`AgentPlugin`] implementation by CLI id. Per
//! `AGENTS.md` § Agent plugin + arch Gotcha #2 / System Boundaries, callers
//! dispatch through the returned trait object — they never match on a `CliId`
//! enum after resolving.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use crate::agy::create_agy_plugin;
use crate::claude::create_claude_plugin;
use crate::codex::create_codex_plugin;
use crate::context::effective_path;
use crate::cursor::create_cursor_plugin;
use crate::opencode::create_opencode_plugin;
use crate::pi::create_pi_plugin;
use crate::plugin::AgentPlugin;
use vst_types::CliId;

/// Check if a binary exists on the effective PATH.
pub fn check_binary(binary: &str) -> bool {
    resolve_binary(binary, &effective_path()).is_some()
}

/// Resolve `binary` to an absolute executable path by searching the
/// colon-joined `path`. An entry already containing a path separator is
/// treated as an absolute path and returned if executable. Requires the
/// executable bit (mode & 0o111).
pub fn resolve_binary(binary: &str, path: &str) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if binary.contains('/') {
        vec![PathBuf::from(binary)]
    } else {
        path.split(':')
            .filter(|d| !d.is_empty() && d.starts_with('/'))
            .map(|d| PathBuf::from(d).join(binary))
            .collect()
    };
    candidates.into_iter().find(|c| is_executable(c))
}

fn is_executable(p: &PathBuf) -> bool {
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Ensure the plugin's binary resolves on the given env's `PATH`, returning a
/// readable error naming the binary and the searched dirs when it does not.
pub fn ensure_binary_on_path(
    plugin: &dyn AgentPlugin,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let binary = plugin.binary_name();
    let path = env.get("PATH").map(String::as_str).unwrap_or("");
    if resolve_binary(binary, path).is_some() {
        return Ok(());
    }
    Err(format!("`{binary}` not found on PATH (searched: {path})"))
}

/// All supported CLI ids, in registry order. Mirrors `SUPPORTED_CLIS`.
pub const SUPPORTED_CLIS: [CliId; 6] = [
    CliId::Claude,
    CliId::Cursor,
    CliId::Opencode,
    CliId::Agy,
    CliId::Codex,
    CliId::Pi,
];

/// Resolve a concrete [`AgentPlugin`] for the given CLI identifier.
///
/// Returns a fresh plugin instance per call, mirroring the TS
/// `PLUGIN_MAP[cli]()` factories. Panics (programmer error) on an unknown CLI.
pub fn resolve_plugin(cli: CliId) -> Box<dyn AgentPlugin> {
    match cli {
        CliId::Claude => Box::new(create_claude_plugin()),
        CliId::Cursor => Box::new(create_cursor_plugin()),
        CliId::Opencode => Box::new(create_opencode_plugin()),
        CliId::Agy => Box::new(create_agy_plugin()),
        CliId::Codex => Box::new(create_codex_plugin()),
        CliId::Pi => Box::new(create_pi_plugin()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::domain::Channel;

    #[test]
    fn check_binary_finds_present_binary() {
        // `sh` is guaranteed present on any POSIX runner.
        assert!(check_binary("sh"));
    }

    #[test]
    fn check_binary_rejects_absent_binary() {
        assert!(!check_binary("definitely-not-a-real-binary-xyz"));
    }

    /// Invariant (plan Decision 7 / M4): a plugin that defaults to the JSON
    /// channel MUST also `supports_json()`, or every default-path create would
    /// 400 for it. Iterates every registry-known CLI so a future 5th plugin
    /// that violates this fails here at compile-adjacent test time.
    #[test]
    fn json_default_plugins_support_json() {
        for cli in SUPPORTED_CLIS {
            let plugin = resolve_plugin(cli);
            assert!(
                !(plugin.default_channel() == Channel::Json) || plugin.supports_json(),
                "{cli:?} defaults to Json but does not supports_json()"
            );
        }
    }

    fn make_executable(dir: &std::path::Path, name: &str) {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&p, perms).unwrap();
    }

    fn unique_tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "vst-registry-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn resolve_binary_finds_executable_only_when_dir_on_path() {
        let dir = unique_tmp("on-path");
        std::fs::create_dir_all(&dir).unwrap();
        make_executable(&dir, "probe-bin");
        let path_str = dir.display().to_string();

        // Found when the dir is on the path.
        let found = resolve_binary("probe-bin", &path_str);
        assert!(found.is_some());
        assert_eq!(found.unwrap(), dir.join("probe-bin"));

        // Not found when the dir is NOT on the path.
        assert!(resolve_binary("probe-bin", "/usr/bin:/bin").is_none());

        // Not found when the entry is relative (dropped).
        assert!(resolve_binary("probe-bin", ".").is_none());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_binary_requires_exec_bit() {
        let dir = unique_tmp("exec-bit");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("noexec");
        std::fs::write(&p, "data").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(resolve_binary("noexec", &dir.display().to_string()).is_none());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_binary_passes_absolute_path_through() {
        let dir = unique_tmp("abs");
        std::fs::create_dir_all(&dir).unwrap();
        make_executable(&dir, "abs-probe");
        let abs = dir.join("abs-probe").display().to_string();

        assert_eq!(
            resolve_binary(&abs, "/usr/bin:/bin"),
            Some(dir.join("abs-probe"))
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ensure_binary_on_path_error_names_binary_and_searched() {
        let env: HashMap<String, String> =
            HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        let plugin = resolve_plugin(CliId::Pi);
        let err = ensure_binary_on_path(plugin.as_ref(), &env).unwrap_err();
        assert!(err.contains("pi"), "got {err}");
        assert!(err.contains("searched:"), "got {err}");
        assert!(err.contains("/usr/bin:/bin"), "got {err}");
    }
}

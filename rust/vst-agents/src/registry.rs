//! Agent plugin registry — ports `agent-plugins/registry.ts`.
//!
//! Resolves a concrete [`AgentPlugin`] implementation by CLI id. Per
//! `AGENTS.md` § Agent plugin + arch Gotcha #2 / System Boundaries, callers
//! dispatch through the returned trait object — they never match on a `CliId`
//! enum after resolving.

use std::process::Command;

use crate::agy::create_agy_plugin;
use crate::claude::create_claude_plugin;
use crate::codex::create_codex_plugin;
use crate::cursor::create_cursor_plugin;
use crate::opencode::create_opencode_plugin;
use crate::pi::create_pi_plugin;
use crate::plugin::AgentPlugin;
use vst_types::CliId;

/// Check if a binary exists on PATH using `which <binary>`.
pub fn check_binary(binary: &str) -> bool {
    Command::new("which")
        .arg(binary)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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
}

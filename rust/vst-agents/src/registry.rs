//! Agent plugin registry — ports `agent-plugins/registry.ts`.
//!
//! Resolves a concrete [`AgentPlugin`] implementation by CLI id. Per
//! `AGENTS.md` § Agent plugin + arch Gotcha #2 / System Boundaries, callers
//! dispatch through the returned trait object — they never match on a `CliId`
//! enum after resolving.

use crate::agy::create_agy_plugin;
use crate::claude::create_claude_plugin;
use crate::cursor::create_cursor_plugin;
use crate::opencode::create_opencode_plugin;
use crate::plugin::AgentPlugin;
use vst_types::CliId;

/// All supported CLI ids, in registry order. Mirrors `SUPPORTED_CLIS`.
pub const SUPPORTED_CLIS: [CliId; 4] = [CliId::Claude, CliId::Cursor, CliId::Opencode, CliId::Agy];

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
    }
}

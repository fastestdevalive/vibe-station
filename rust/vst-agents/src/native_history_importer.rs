//! NativeHistoryImporter — read a CLI's *at-rest* native store and normalize its
//! terminal-phase turns into `NormalizedEvent`s (R0.5–R0.9). Ports
//! `services/nativeHistoryImporter.ts`.
//!
//! The importer registry is the P3 toggle GATE: claude + opencode ship here;
//! cursor + agy are DEFERRED and intentionally absent.

use vst_types::NormalizedEvent;

use crate::claude_import::claude_history_importer;
use crate::opencode_import::opencode_history_importer;

/// Inputs to one import pass.
#[derive(Clone, Debug)]
pub struct NativeImportRequest {
    /// OUR session id — stamped on every emitted `NormalizedEvent`.
    pub session_id: String,
    /// The harness chat/session id that locates the native store.
    pub agent_chat_id: String,
    /// Session cwd (worktree/project path) — resolves the native store location.
    pub cwd: String,
    /// The native cursor watermark from the previous import (per-CLI coordinate).
    pub watermark: Option<String>,
}

/// Result of one import pass.
#[derive(Clone, Debug)]
pub struct NativeImportResult {
    /// Normalized events for every native turn PAST the watermark, in order.
    pub events: Vec<NormalizedEvent>,
    /// The native cursor to persist for the next import.
    pub next_watermark: String,
}

/// Per-CLI at-rest adapter.
pub trait NativeHistoryImporter: Send + Sync {
    fn cli(&self) -> &'static str;
    fn import(&self, req: &NativeImportRequest) -> NativeImportResult;
}

/// A concrete importer created from a test seam (an injected store path).
pub fn get_native_history_importer(cli: &str) -> Option<&'static dyn NativeHistoryImporter> {
    match cli {
        "claude" => Some(claude_history_importer()),
        "opencode" => Some(opencode_history_importer()),
        _ => None,
    }
}

/// Whether a CLI can import terminal-phase history (the P3 toggle gate).
pub fn has_native_history_importer(cli: &str) -> bool {
    matches!(cli, "claude" | "opencode")
}

// Re-export the store-path resolvers for the test seams.
pub use crate::claude_import::claude_native_store_path;
pub use crate::opencode_import::opencode_native_store_path;

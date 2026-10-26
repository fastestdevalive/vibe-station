//! NativeHistoryImporter — read a CLI's *at-rest* native store and normalize its
//! terminal-phase turns into `NormalizedEvent`s (R0.5–R0.9). Ports
//! `services/nativeHistoryImporter.ts`.
//!
//! The importer itself is reached as an [`crate::plugin::AgentPlugin`] method
//! (`native_history_importer()`, default `None`) — NOT a `match cli` registry
//! (AGENTS.md § Agent plugin). claude + opencode + codex + omp return their
//! singletons; cursor + agy (+ pi, terminal-only) are DEFERRED and absent.

use vst_types::NormalizedEvent;

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
    /// The native cursor sealing the watermark at the CURRENT end of the store,
    /// without importing (Decision 9: json→tty seals so ACP-written turns are never
    /// re-imported). Default `None` = no seal (plugins without an importer, and
    /// importers whose store can't be read).
    fn current_cursor(&self, _req: &NativeImportRequest) -> Option<String> {
        None
    }
}

// The per-CLI store-path resolvers, re-exported for the test seams.
pub use crate::claude_import::claude_native_store_path;
pub use crate::codex_import::codex_native_store_path;
pub use crate::opencode_import::opencode_native_store_path;

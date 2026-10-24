//! Writes an opencode JSON config file pointing at system-prompt instruction
//! files — ports `services/opencodeConfig.ts` (officially part `04c`, pulled
//! forward here because 04a's `opencode` plugin's `get_environment` writes it).
//!
//! ## OWNERSHIP NOTE (read before editing)
//!
//! The TS source for this module (`daemon/src/services/opencodeConfig.ts`) is
//! assigned to part **04c** in `file-map.tsv`, **not** 04a. It is implemented
//! here only because 04a's `opencode` plugin's `get_environment` writes this
//! config file as part of its (tested) behavior. **When 04c runs: read this
//! file first and adopt/extend it rather than re-deriving from the TS source —
//! do not create a second, conflicting implementation.** This is a deliberate,
//! precedented stopgap (same shape as part 03's `DirectPtyRegistry`).
//!
//! Both writers below (async, used by the ACP/Rich-Chat turn path; blocking,
//! used by the synchronous `get_environment`) render through the same
//! [`render_config`], so the on-disk shape can never drift between the two
//! channels.

use std::path::Path;

use serde::Serialize;
use serde_json::json;
use tokio::fs;

/// The opencode config shape (`OpenCodeConfig`).
#[derive(Serialize)]
struct OpenCodeConfig<'a> {
    instructions: &'a [String],
    permission: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
}

/// Render `{ instructions: [<paths>], permission: {"*":{"*":"allow"}}[, model] }`.
///
/// `model` is how opencode **v2** selects a session's model (its top-level
/// `-m/--model` flag was removed — see
/// `rust/vst-agents/src/opencode.rs`'s `OpencodeCli`). Passing it also on v1 is
/// harmless: v1 additionally receives `-m <model>` with the same value.
fn render_config(instruction_files: &[String], model: Option<&str>) -> String {
    let config = OpenCodeConfig {
        instructions: instruction_files,
        permission: json!({ "*": { "*": "allow" } }),
        model: model.filter(|m| !m.is_empty()),
    };
    let pretty = serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".to_string());
    format!("{pretty}\n")
}

/// Write the config for a Rich Chat (ACP) turn. Mirrors `writeOpenCodeConfig`.
pub async fn write_opencode_config(
    config_path: &Path,
    instruction_files: &[String],
    model: Option<&str>,
) {
    let _ = fs::write(config_path, render_config(instruction_files, model)).await;
}

/// Synchronous twin of [`write_opencode_config`] for `AgentPlugin::get_environment`
/// (which is a sync fn) — same bytes on disk, no runtime needed.
pub fn write_opencode_config_blocking(
    config_path: &Path,
    instruction_files: &[String],
    model: Option<&str>,
) {
    let _ = std::fs::write(config_path, render_config(instruction_files, model));
}

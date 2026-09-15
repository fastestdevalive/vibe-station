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

/// Write `{ instructions: [<paths>], permission: {"*":{"*":"allow"}}[, model] }`
/// to `config_path`. Mirrors `writeOpenCodeConfig`.
pub async fn write_opencode_config(
    config_path: &Path,
    instruction_files: &[String],
    model: Option<&str>,
) {
    let config = OpenCodeConfig {
        instructions: instruction_files,
        permission: json!({ "*": { "*": "allow" } }),
        model,
    };
    let pretty = serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".to_string());
    let _ = fs::write(config_path, format!("{pretty}\n")).await;
}

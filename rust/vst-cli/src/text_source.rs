use std::fs;
use std::path::Path;

use crate::output::{die, warn};

/// Convert raw user text (typed on the command line or read from a file) to the
/// skill-grammar wire form the daemon expects for every user message: `\` ->
/// `\\`, `{` -> `\{`. The daemon converts back to plain text exactly once, at
/// delivery to the agent, so text round-trips byte-for-byte. Single
/// implementation: `vst_agents::skill_tokens::escape_skill_text`.
pub fn to_wire_text(raw: &str) -> String {
    vst_agents::skill_tokens::escape_skill_text(raw)
}

/// Resolve a text value supplied either inline or via a file path with custom error/warn handling.
pub fn try_resolve_file_or_inline(
    inline: Option<String>,
    file_path: Option<String>,
    file_flag: &str,
) -> Result<Option<String>, String> {
    let path_str = match file_path {
        Some(p) => p,
        None => return Ok(inline),
    };

    let contents = match fs::read_to_string(Path::new(&path_str)) {
        Ok(s) => s,
        Err(err) => {
            return Err(format!("Cannot read {file_flag} {path_str}: {err}"));
        }
    };

    if contents.trim().is_empty() {
        warn(&format!(
            "{file_flag} {path_str} is empty — the agent will start with no task."
        ));
        return Ok(None);
    }

    Ok(Some(contents))
}

/// Resolve a text value supplied either inline or via a file path.
///
/// Used by the `--prompt` / `--prompt-file` and `--context` / `--context-file` flag pairs.
///
/// Reading the file is deliberately fail-loud: a prompt the caller explicitly asked for must never
/// be silently dropped.
pub fn resolve_file_or_inline(
    inline: Option<String>,
    file_path: Option<String>,
    file_flag: &str,
) -> Option<String> {
    match try_resolve_file_or_inline(inline, file_path, file_flag) {
        Ok(res) => res,
        Err(err) => die(&err, Some(1)),
    }
}

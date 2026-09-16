//! `vst worktree rename <id> <name>`
//!
//! Sends `PATCH /worktrees/:id/rename`. Mirrors `cli/src/commands/worktree/rename.ts`.

use vst_types::rest::worktrees::RenameWorktreeResult;

use crate::client::{daemon_patch, DaemonResult};
use crate::output::success;
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorktreeRenameOptions {
    pub id: String,
    pub name: String,
}

pub fn parse_worktree_rename_options(args: &[String]) -> Result<WorktreeRenameOptions, String> {
    let mut positional = Vec::new();

    for arg in args {
        if arg.starts_with('-') {
            return Err(format!("Unknown option: {arg}"));
        }
        positional.push(arg.clone());
    }

    if positional.len() < 2 {
        return Err("Usage: vst worktree rename <id> <name>".to_string());
    }

    Ok(WorktreeRenameOptions {
        id: positional[0].clone(),
        name: positional[1].clone(),
    })
}

pub async fn run_worktree_rename(opts: WorktreeRenameOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let encoded = percent_encode(&opts.id);
    let body = serde_json::json!({ "name": opts.name });

    let result = daemon_patch::<RenameWorktreeResult, _>(
        &format!("/worktrees/{encoded}/rename"),
        Some(&body),
    )
    .await
    .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if let Some(new_name) = data.name {
                success(&format!("Renamed to: {new_name}"));
            } else {
                success("Name cleared");
            }
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

/// Percent-encode characters not safe in URL path segments.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

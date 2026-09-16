//! `vst worktree done <id>`
//!
//! Sends `POST /worktrees/:id/done`. Mirrors `cli/src/commands/worktree/done.ts`.

use vst_types::rest::worktrees::WorktreeDoneResult;

use crate::client::{daemon_post, DaemonResult};
use crate::output::success;
use crate::preflight::preflight;

pub async fn run_worktree_done(id: &str) -> Result<(), (String, i32)> {
    preflight().await;

    let encoded = percent_encode(id);
    let result = daemon_post::<WorktreeDoneResult, ()>(&format!("/worktrees/{encoded}/done"), None)
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            success(&format!(
                "Worktree marked as done: {id} ({} agent session(s) done, {} terminal(s) released)",
                data.updated, data.terminals_released
            ));
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

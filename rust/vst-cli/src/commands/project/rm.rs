//! `vst project rm <id>`
//!
//! Sends `DELETE /projects/:id`. Mirrors `cli/src/commands/project/rm.ts`.

use crate::client::{daemon_delete, DaemonResult};
use crate::confirm::confirm_by_typing_name;
use crate::output::success;
use crate::preflight::preflight;

pub async fn run_project_rm(id: &str) -> Result<(), (String, i32)> {
    confirm_by_typing_name(
        id,
        &format!("This will delete project \"{id}\" and all its worktrees/sessions."),
    );

    preflight().await;

    let result = daemon_delete::<serde_json::Value>(&format!("/projects/{id}"))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { .. } => {
            success(&format!("Project removed: {id}"));
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

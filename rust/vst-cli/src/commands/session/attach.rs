use std::process::Command;
use vst_types::rest::sessions::SessionOrDraft;

use crate::client::{daemon_get, DaemonResult};
use crate::preflight::preflight;

pub async fn run_session_attach(id: &str) -> Result<(), (String, i32)> {
    if id.is_empty() {
        return Err(("Session ID is required".to_string(), 1));
    }

    preflight().await;

    let result = daemon_get::<SessionOrDraft>(&format!("/sessions/{id}"))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    let tmux_name = match result {
        DaemonResult::Ok { data, .. } => {
            let name = match data {
                SessionOrDraft::Session(s) => s.tmux_name,
                SessionOrDraft::GlobalDraft(g) => g.tmux_name,
            };
            if name.is_empty() {
                return Err(("Session does not have a tmux target".to_string(), 1));
            }
            name
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            return Err((error, code));
        }
    };

    let status = Command::new("tmux")
        .args(["attach", "-t", &tmux_name])
        .status()
        .map_err(|e| (format!("Failed to execute tmux: {e}"), 1))?;

    let code = status.code().unwrap_or(0);
    if code != 0 {
        return Err((String::new(), code));
    }

    Ok(())
}

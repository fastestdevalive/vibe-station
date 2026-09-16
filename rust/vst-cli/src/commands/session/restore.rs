use crate::client::{daemon_post, DaemonResult};
use crate::output::success;
use crate::preflight::preflight;

pub async fn run_session_restore(id: &str) -> Result<(), (String, i32)> {
    if id.is_empty() {
        return Err(("Session ID is required".to_string(), 1));
    }

    preflight().await;

    let result = daemon_post::<serde_json::Value, ()>(&format!("/sessions/{id}/resume"), None)
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { .. } => {
            success(&format!("Session restored: {id}"));
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

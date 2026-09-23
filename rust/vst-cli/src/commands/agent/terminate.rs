use crate::client::{daemon_delete, DaemonResult};
use crate::env::get_vst_session;
use crate::output::success;
use crate::preflight::preflight;

pub async fn run_session_terminate(id: Option<String>) -> Result<(), (String, i32)> {
    let target_id = id.or_else(get_vst_session);
    let target_id = match target_id {
        Some(t) if !t.is_empty() => t,
        _ => {
            return Err((
                "No session id given and $VST_SESSION is not set — pass an id explicitly."
                    .to_string(),
                1,
            ))
        }
    };

    preflight().await;

    let result = daemon_delete::<serde_json::Value>(&format!("/sessions/{target_id}"))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { .. } => {
            success(&format!("Session terminated: {target_id}"));
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

use crate::client::{daemon_delete, DaemonResult};
use crate::confirm::confirm_by_typing_name;
use crate::output::success;
use crate::preflight::preflight;

pub async fn run_mode_rm(id: &str) -> Result<(), (String, i32)> {
    if id.is_empty() {
        return Err(("Mode ID is required".to_string(), 1));
    }

    preflight().await;
    confirm_by_typing_name(id, &format!("This will delete mode \"{id}\"."));

    let result = daemon_delete::<serde_json::Value>(&format!("/modes/{id}"))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { .. } => {
            success(&format!("Mode removed: {id}"));
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

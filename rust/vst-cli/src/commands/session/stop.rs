use crate::client::{daemon_post, DaemonResult};
use crate::preflight::preflight;

pub async fn run_session_stop(id: &str) -> Result<(), (String, i32)> {
    if id.is_empty() {
        return Err(("Session ID is required".to_string(), 1));
    }

    preflight().await;

    let mut encoded = String::new();
    for byte in id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
    }

    let result =
        daemon_post::<serde_json::Value, ()>(&format!("/sessions/{encoded}/chat/stop"), None)
            .await
            .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { .. } => {
            println!("ok");
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

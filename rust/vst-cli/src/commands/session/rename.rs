use vst_types::rest::sessions::RenameSessionResult;

use crate::client::{daemon_patch, DaemonResult};
use crate::output::success;
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionRenameOptions {
    pub id: String,
    pub name: String,
}

pub fn parse_session_rename_options(args: &[String]) -> Result<SessionRenameOptions, String> {
    let mut positional = Vec::new();

    for arg in args {
        if arg.starts_with('-') {
            return Err(format!("Unknown option: {arg}"));
        }
        positional.push(arg.clone());
    }

    if positional.len() < 2 {
        return Err("Usage: vst session rename <id> <name>".to_string());
    }

    Ok(SessionRenameOptions {
        id: positional[0].clone(),
        name: positional[1].clone(),
    })
}

pub async fn run_session_rename(opts: SessionRenameOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let mut encoded = String::new();
    for byte in opts.id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
    }

    let body = serde_json::json!({ "name": opts.name });
    let result =
        daemon_patch::<RenameSessionResult, _>(&format!("/sessions/{encoded}/rename"), Some(&body))
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

use vst_types::rest::sessions::SessionOrDraft;

use crate::client::{daemon_get, DaemonResult};
use crate::output::print_json;
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionInfoOptions {
    pub id: String,
    pub json: bool,
}

pub fn parse_session_info_options(args: &[String]) -> Result<SessionInfoOptions, String> {
    let mut opts = SessionInfoOptions::default();
    let mut positional = Vec::new();

    for arg in args {
        match arg.as_str() {
            "--json" => {
                opts.json = true;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            other => {
                positional.push(other.to_string());
            }
        }
    }

    if positional.is_empty() {
        return Err("Session ID is required".to_string());
    }
    opts.id = positional[0].clone();

    Ok(opts)
}

pub async fn run_session_info(opts: SessionInfoOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<SessionOrDraft>(&format!("/sessions/{}", opts.id))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }

            match data {
                SessionOrDraft::Session(s) => {
                    println!("Session: {}", s.id);
                    println!("Worktree: {}", s.worktree_id.as_deref().unwrap_or(""));
                    println!(
                        "Type: {}",
                        serde_json::to_value(s.r#type)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default()
                    );
                    println!(
                        "State: {}",
                        serde_json::to_value(s.state)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default()
                    );
                    if !s.tmux_name.is_empty() {
                        println!("Tmux: {}", s.tmux_name);
                    }
                    if !s.created_at.is_empty() {
                        println!("Created: {}", s.created_at);
                    }
                }
                SessionOrDraft::GlobalDraft(g) => {
                    println!("Session: {}", g.id);
                    println!("Worktree: {}", g.worktree_id.as_deref().unwrap_or(""));
                    println!(
                        "Type: {}",
                        serde_json::to_value(g.r#type)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default()
                    );
                    println!(
                        "State: {}",
                        serde_json::to_value(g.state)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default()
                    );
                    if !g.tmux_name.is_empty() {
                        println!("Tmux: {}", g.tmux_name);
                    }
                    if !g.created_at.is_empty() {
                        println!("Created: {}", g.created_at);
                    }
                }
            }
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

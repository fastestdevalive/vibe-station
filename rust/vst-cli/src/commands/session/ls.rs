use vst_types::rest::sessions::SessionOrDraft;

use crate::client::{daemon_get, DaemonResult};
use crate::output::{print_json, print_table};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionLsOptions {
    pub worktree: Option<String>,
    pub name: Option<String>,
    pub json: bool,
}

pub fn parse_session_ls_options(args: &[String]) -> Result<SessionLsOptions, String> {
    let mut opts = SessionLsOptions::default();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--worktree" => {
                opts.worktree = iter.next().cloned();
            }
            s if s.starts_with("--worktree=") => {
                opts.worktree = Some(s.trim_start_matches("--worktree=").to_string());
            }
            "--name" => {
                opts.name = iter.next().cloned();
            }
            s if s.starts_with("--name=") => {
                opts.name = Some(s.trim_start_matches("--name=").to_string());
            }
            "--json" => {
                opts.json = true;
            }
            other => {
                return Err(format!("Unknown option: {other}"));
            }
        }
    }

    Ok(opts)
}

pub async fn run_session_ls(opts: SessionLsOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let path = if let Some(wt) = &opts.worktree {
        let mut encoded = String::new();
        for byte in wt.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char);
                }
                _ => {
                    encoded.push_str(&format!("%{byte:02X}"));
                }
            }
        }
        format!("/sessions?worktree={encoded}")
    } else {
        "/sessions".to_string()
    };

    let result = daemon_get::<Vec<SessionOrDraft>>(&path)
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            let filtered: Vec<SessionOrDraft> = if let Some(target_name) = &opts.name {
                data.into_iter()
                    .filter(|s| match s {
                        SessionOrDraft::Session(item) => item.name.as_deref() == Some(target_name),
                        SessionOrDraft::GlobalDraft(item) => {
                            item.name.as_deref() == Some(target_name)
                        }
                    })
                    .collect()
            } else {
                data
            };

            if opts.json {
                print_json(&filtered);
            }

            let rows: Vec<Vec<String>> = filtered
                .iter()
                .map(|s| match s {
                    SessionOrDraft::Session(item) => vec![
                        item.id.clone(),
                        item.worktree_id.clone().unwrap_or_default(),
                        serde_json::to_value(item.r#type)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default(),
                        serde_json::to_value(item.state)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default(),
                    ],
                    SessionOrDraft::GlobalDraft(item) => vec![
                        item.id.clone(),
                        item.worktree_id.clone().unwrap_or_default(),
                        serde_json::to_value(item.r#type)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default(),
                        serde_json::to_value(item.state)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default(),
                    ],
                })
                .collect();

            print_table(&["ID", "Worktree", "Type", "State"], &rows);
            Ok(())
        }
        DaemonResult::Err { error, .. } => Err((error, 1)),
    }
}

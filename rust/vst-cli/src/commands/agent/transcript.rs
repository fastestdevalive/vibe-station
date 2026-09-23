use std::process;
use vst_types::rest::sessions::AllEvents;

use crate::client::{daemon_get, DaemonResult};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionTranscriptOptions {
    pub id: String,
    pub json: bool,
}

pub fn parse_session_transcript_options(
    args: &[String],
) -> Result<SessionTranscriptOptions, String> {
    let mut opts = SessionTranscriptOptions::default();
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

pub async fn run_session_transcript(opts: SessionTranscriptOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<AllEvents>(&format!("/sessions/{}/transcript", opts.id))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            let events = data.events;
            if opts.json {
                for ev in events {
                    if let Ok(line) = serde_json::to_string(&ev) {
                        println!("{line}");
                    }
                }
                process::exit(0);
            }

            if events.is_empty() {
                println!("(no transcript yet)");
                return Ok(());
            }

            for ev in events {
                let kind_str = serde_json::to_value(ev.kind)
                    .ok()
                    .and_then(|v| v.as_str().map(ToString::to_string))
                    .unwrap_or_default();
                let role_str = ev
                    .role
                    .and_then(|r| serde_json::to_value(r).ok())
                    .and_then(|v| v.as_str().map(ToString::to_string));

                let who = if let Some(r) = role_str {
                    format!("{kind_str}/{r}")
                } else {
                    kind_str
                };

                let body = ev
                    .text
                    .or(ev.tool_name)
                    .or_else(|| ev.tool_result.and_then(|tr| tr.content))
                    .unwrap_or_default();

                let one_line = body.split_whitespace().collect::<Vec<_>>().join(" ");
                let truncated: String = one_line.chars().take(200).collect();
                println!("[{who}] {truncated}");
            }

            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

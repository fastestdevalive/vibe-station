//! `vst status [--project <id>] [--json]`
//!
//! Shows daemon and session status. Fetches `GET /sessions[?project=<id>]` and
//! prints JSON or a per-session line with a state icon. Mirrors
//! `cli/src/commands/status.ts` (top-level `vst status` — distinct from
//! `vst daemon status`, which is ported in `commands/daemon/status.rs`).

use vst_types::domain::LifecycleState;
use vst_types::rest::sessions::SessionOrDraft;

use crate::client::{daemon_get, DaemonResult};
use crate::env::get_vst_project;
use crate::output::{die, print_json};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatusOptions {
    pub project: Option<String>,
    pub json: bool,
}

pub fn parse_status_options(args: &[String]) -> Result<StatusOptions, String> {
    let mut opts = StatusOptions::default();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => {
                opts.json = true;
            }
            "--project" => {
                opts.project = iter.next().cloned();
            }
            s if s.starts_with("--project=") => {
                opts.project = Some(s.trim_start_matches("--project=").to_string());
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            _ => {}
        }
    }

    Ok(opts)
}

/// The state icon for a session in the human-readable status output.
///
/// The TS `status.ts` keyed its icon off the older `"idle"`/`"running"`/`"error"`
/// strings, which don't exist in the daemon's canonical `LifecycleState` enum.
/// The pragmatic translation used here: idle → green, busy/starting
/// (Working/NotStarted) → yellow, terminal (Done/Exited) → red, everything else
/// → dim.
pub fn state_icon(state: &LifecycleState) -> String {
    match state {
        LifecycleState::Idle => "\x1b[32m●\x1b[0m".to_string(),
        LifecycleState::Working | LifecycleState::NotStarted => "\x1b[33m●\x1b[0m".to_string(),
        LifecycleState::Done | LifecycleState::Exited => "\x1b[31m●\x1b[0m".to_string(),
        _ => "\x1b[2m●\x1b[0m".to_string(),
    }
}

fn state_str(state: &LifecycleState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|v| v.as_str().map(ToString::to_string))
        .unwrap_or_default()
}

fn session_id(s: &SessionOrDraft) -> String {
    match s {
        SessionOrDraft::Session(item) => item.id.clone(),
        SessionOrDraft::GlobalDraft(item) => item.id.clone(),
    }
}

fn session_state(s: &SessionOrDraft) -> &LifecycleState {
    match s {
        SessionOrDraft::Session(item) => &item.state,
        SessionOrDraft::GlobalDraft(item) => &item.state,
    }
}

pub async fn run_status(opts: StatusOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let project_id = opts.project.or_else(get_vst_project);
    let query = match &project_id {
        Some(id) => format!("?project={id}"),
        None => String::new(),
    };

    let result = daemon_get::<Vec<SessionOrDraft>>(&format!("/sessions{query}"))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    let data = match result {
        DaemonResult::Ok { data, .. } => data,
        DaemonResult::Err { error, .. } => die(&error, Some(1)),
    };

    if opts.json {
        print_json(&data);
    }

    if data.is_empty() {
        println!("No active sessions");
        return Ok(());
    }

    for session in &data {
        let id = session_id(session);
        let state = session_state(session);
        println!("{} {id} ({})", state_icon(state), state_str(state));
    }

    Ok(())
}

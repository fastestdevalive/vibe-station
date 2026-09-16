//! `vst summary [--json] [--project <id>]`
//!
//! Summarizes sessions grouped by worktree. Fetches `GET /worktrees` and
//! `GET /sessions`, merges them, and prints either a JSON snapshot or a
//! human-readable per-worktree line. Mirrors `cli/src/commands/summary.ts`.

use serde_json::{json, Value};

use vst_types::domain::LifecycleState;
use vst_types::rest::sessions::SessionOrDraft;
use vst_types::rest::shared::Worktree;

use crate::client::{daemon_get, DaemonResult};
use crate::env::get_vst_project;
use crate::output::die;
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SummaryOptions {
    pub json: bool,
    pub project: Option<String>,
}

pub fn parse_summary_options(args: &[String]) -> Result<SummaryOptions, String> {
    let mut opts = SummaryOptions::default();
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

/// The glyph for a session's lifecycle state in the human-readable summary.
pub fn glyph_for_state(state: &LifecycleState) -> String {
    match state {
        LifecycleState::Working => "\x1b[32m●\x1b[0m".to_string(),
        LifecycleState::Idle => "\x1b[2m○\x1b[0m".to_string(),
        LifecycleState::NotStarted => "\x1b[33m◐\x1b[0m".to_string(),
        LifecycleState::Done => "\x1b[34m✓\x1b[0m".to_string(),
        LifecycleState::Exited => "\x1b[31m×\x1b[0m".to_string(),
        _ => "\x1b[2m·\x1b[0m".to_string(),
    }
}

fn state_str(state: &LifecycleState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|v| v.as_str().map(ToString::to_string))
        .unwrap_or_default()
}

fn type_str(s: &SessionOrDraft) -> String {
    let ty = match s {
        SessionOrDraft::Session(item) => &item.r#type,
        SessionOrDraft::GlobalDraft(item) => &item.r#type,
    };
    serde_json::to_value(ty)
        .ok()
        .and_then(|v| v.as_str().map(ToString::to_string))
        .unwrap_or_default()
}

/// Build the summary JSON snapshot from the fetched worktrees and sessions.
///
/// Sessions whose `worktreeId` matches no listed worktree are dropped. The
/// shape is a CLI-produced snapshot (not a daemon wire type), so it is built
/// as a `serde_json::Value`.
pub fn build_summary_json(worktrees: &[Worktree], sessions: &[SessionOrDraft]) -> Value {
    let worktrees_json: Vec<Value> = worktrees
        .iter()
        .map(|w| {
            let sess: Vec<Value> = sessions
                .iter()
                .filter(|s| {
                    let wid = match s {
                        SessionOrDraft::Session(item) => item.worktree_id.as_deref(),
                        SessionOrDraft::GlobalDraft(item) => item.worktree_id.as_deref(),
                    };
                    wid == Some(w.id.as_str())
                })
                .map(|s| {
                    let (id, is_main, state, created_at) = match s {
                        SessionOrDraft::Session(item) => (
                            item.id.clone(),
                            item.is_main,
                            state_str(&item.state),
                            item.created_at.clone(),
                        ),
                        SessionOrDraft::GlobalDraft(item) => (
                            item.id.clone(),
                            item.is_main,
                            state_str(&item.state),
                            item.created_at.clone(),
                        ),
                    };
                    json!({
                        "id": id,
                        "isMain": is_main,
                        "state": state,
                        "type": type_str(s),
                        "lastTransitionAt": created_at,
                    })
                })
                .collect();

            json!({
                "id": w.id,
                "branch": w.branch,
                "sessions": sess,
            })
        })
        .collect();

    json!({
        "generatedAt": iso_now(),
        "worktrees": worktrees_json,
    })
}

/// Current UTC time in ISO-8601 format (`generatedAt`), matching JS
/// `new Date().toISOString()` (e.g. `2026-09-15T12:34:56.789Z`).
fn iso_now() -> String {
    // No chrono dependency in this crate; build an ISO-8601 timestamp from the
    // system clock with fixed "Z" (UTC) designation, matching `new Date().toISOString()`.
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    let secs_of_day = secs % 86_400;
    let h = secs_of_day / 3600;
    let mi = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;

    format!(
        "{year:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{:03}Z",
        (now.duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis())
    )
}

pub async fn run_summary(opts: SummaryOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let wt_res = daemon_get::<Vec<Worktree>>("/worktrees")
        .await
        .map_err(|e| (e.to_string(), 1))?;
    let sess_res = daemon_get::<Vec<SessionOrDraft>>("/sessions")
        .await
        .map_err(|e| (e.to_string(), 1))?;

    let worktrees = match wt_res {
        DaemonResult::Ok { data, .. } => data,
        DaemonResult::Err { error, .. } => die(&error, Some(1)),
    };
    let sessions = match sess_res {
        DaemonResult::Ok { data, .. } => data,
        DaemonResult::Err { error, .. } => die(&error, Some(1)),
    };

    let filter_project = opts.project.or_else(get_vst_project);
    let worktrees: Vec<Worktree> = match &filter_project {
        Some(pid) => worktrees
            .into_iter()
            .filter(|w| w.project_id == *pid)
            .collect(),
        None => worktrees,
    };

    let payload = build_summary_json(&worktrees, &sessions);

    if opts.json {
        crate::output::print_json(&payload);
    }

    let wt_list: Vec<Value> = payload
        .get("worktrees")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if wt_list.is_empty() {
        println!("No worktrees match filter.");
        return Ok(());
    }

    for w in &wt_list {
        let id = w["id"].as_str().unwrap_or("");
        let branch = w["branch"].as_str().unwrap_or("");
        let sess: Vec<Value> = w
            .get("sessions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let count = sess.len();
        let glyphs: String = sess
            .iter()
            .map(|s| {
                let state = s["state"].as_str().unwrap_or("");
                state_to_glyph(state)
            })
            .collect();
        let glyphs = if glyphs.is_empty() {
            "\x1b[2m(none)\x1b[0m".to_string()
        } else {
            glyphs
        };
        println!("{id} [{branch}] · {count} sessions · {glyphs}");
    }

    Ok(())
}

fn state_to_glyph(state: &str) -> String {
    match state {
        "working" => "\x1b[32m●\x1b[0m".to_string(),
        "idle" => "\x1b[2m○\x1b[0m".to_string(),
        "not_started" => "\x1b[33m◐\x1b[0m".to_string(),
        "done" => "\x1b[34m✓\x1b[0m".to_string(),
        "exited" => "\x1b[31m×\x1b[0m".to_string(),
        _ => "\x1b[2m·\x1b[0m".to_string(),
    }
}

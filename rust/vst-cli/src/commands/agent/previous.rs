//! `vst agent previous` — list the earlier sessions of this chat's
//! superseded chain (newest first), with mode, how it ended, archive time and
//! any carried summary.

use serde::Serialize;
use vst_types::rest::sessions::SessionOrDraft;
use vst_types::rest::shared::{Mode, Session};

use crate::client::{daemon_get, DaemonResult};
use crate::output::print_table;
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionPreviousOptions {
    pub id: String,
    pub json: bool,
}

pub fn parse_session_previous_options(args: &[String]) -> Result<SessionPreviousOptions, String> {
    let mut opts = SessionPreviousOptions::default();
    let mut positional = Vec::new();

    for arg in args {
        match arg.as_str() {
            "--json" => opts.json = true,
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            other => positional.push(other.to_string()),
        }
    }

    let mut positional = positional.into_iter();
    opts.id = positional
        .next()
        .ok_or_else(|| "Session ID is required".to_string())?;
    if let Some(extra) = positional.next() {
        return Err(format!("Unexpected argument: {extra}"));
    }

    Ok(opts)
}

/// One row of `vst agent previous` output.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousSessionRow {
    pub id: String,
    /// Mode display name (falls back to the mode id, then empty).
    pub mode: Option<String>,
    pub mode_id: Option<String>,
    /// `"fresh"` when the successor kept the same mode, `"switch"` when the
    /// mode changed (mirrors the UI's "Started fresh" / "Switched to …").
    pub kind: String,
    pub archived_at: Option<String>,
    /// What the reset/switch carried into its successor: `"none"`,
    /// `"summary"` or `"transcript"`; `null` for records archived before the
    /// mode was recorded.
    pub carry_over: Option<vst_types::domain::CarryOver>,
    pub summary: Option<String>,
}

/// Walk `supersededBy` backwards from `head_id`, newest-first, agent sessions
/// only. Cycle-guarded and bounded by the list length (mirrors
/// `listPredecessors` in `web-ui/src/lib/sessionVisibility.ts`).
pub fn predecessors<'a>(head_id: &str, sessions: &'a [Session]) -> Vec<&'a Session> {
    let Some(head) = sessions.iter().find(|s| s.id == head_id) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    seen.insert(head_id.to_string());
    let mut cur = head;
    let mut out = Vec::new();
    for _ in 0..sessions.len() {
        let Some(pred) = sessions
            .iter()
            .find(|s| s.superseded_by.as_deref() == Some(cur.id.as_str()) && !seen.contains(&s.id))
        else {
            break;
        };
        seen.insert(pred.id.clone());
        if pred.r#type == vst_types::domain::SessionType::Agent {
            out.push(pred);
        }
        cur = pred;
    }
    out
}

/// Build the output rows, resolving mode ids to display names where possible.
pub fn build_rows(head_id: &str, sessions: &[Session], modes: &[Mode]) -> Vec<PreviousSessionRow> {
    let mode_name = |mode_id: Option<&str>| -> Option<String> {
        let id = mode_id?;
        Some(
            modes
                .iter()
                .find(|m| m.id == id)
                .map(|m| m.name.clone())
                .unwrap_or_else(|| id.to_string()),
        )
    };

    predecessors(head_id, sessions)
        .into_iter()
        .map(|s| {
            let successor = s
                .superseded_by
                .as_deref()
                .and_then(|id| sessions.iter().find(|x| x.id == id));
            let kind = match successor {
                Some(next) if next.mode_id != s.mode_id => "switch",
                _ => "fresh",
            };
            PreviousSessionRow {
                id: s.id.clone(),
                mode: mode_name(s.mode_id.as_deref()),
                mode_id: s.mode_id.clone(),
                kind: kind.to_string(),
                archived_at: s.archived_at.clone(),
                carry_over: s.carry_over,
                summary: s.handoff_summary.clone(),
            }
        })
        .collect()
}

/// Table label for the recorded carry mode (`unrecorded` for older records).
fn carry_label(c: Option<vst_types::domain::CarryOver>) -> &'static str {
    use vst_types::domain::CarryOver;
    match c {
        Some(CarryOver::Nothing) => "none",
        Some(CarryOver::Summary) => "summary",
        Some(CarryOver::Transcript) => "transcript",
        None => "unrecorded",
    }
}

fn one_line_summary(summary: &str) -> String {
    let collapsed = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = collapsed.chars().take(80).collect();
    if collapsed.chars().count() > 80 {
        out.push('…');
    }
    out
}

pub async fn run_session_previous(opts: SessionPreviousOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let list = daemon_get::<Vec<SessionOrDraft>>("/sessions")
        .await
        .map_err(|e| (e.to_string(), 1))?;
    let sessions: Vec<Session> = match list {
        DaemonResult::Ok { data, .. } => data
            .into_iter()
            .filter_map(|item| match item {
                SessionOrDraft::Session(s) => Some(s),
                SessionOrDraft::GlobalDraft(_) => None,
            })
            .collect(),
        DaemonResult::Err { error, .. } => return Err((error, 1)),
    };

    if !sessions.iter().any(|s| s.id == opts.id) {
        return Err((format!("Session '{}' not found", opts.id), 2));
    }

    let modes = match daemon_get::<Vec<Mode>>("/modes").await {
        Ok(DaemonResult::Ok { data, .. }) => data,
        _ => Vec::new(),
    };

    let rows = build_rows(&opts.id, &sessions, &modes);

    if opts.json {
        match serde_json::to_string(&rows) {
            Ok(json) => println!("{json}"),
            Err(err) => eprintln!("error: failed to serialize json: {err}"),
        }
        return Ok(());
    }

    let table: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            vec![
                r.id.clone(),
                r.mode.clone().unwrap_or_default(),
                r.kind.clone(),
                r.archived_at
                    .as_deref()
                    .map(format_archived_at)
                    .unwrap_or_default(),
                carry_label(r.carry_over).to_string(),
                r.summary
                    .as_deref()
                    .map(one_line_summary)
                    .unwrap_or_default(),
            ]
        })
        .collect();
    print_table(
        &["ID", "Mode", "Kind", "Archived", "Carried", "Summary"],
        &table,
    );
    Ok(())
}

/// Epoch milliseconds (the wire value) as `YYYY-MM-DD HH:MM` UTC for the
/// table; anything unparseable is shown as-is. `--json` keeps the raw value.
fn format_archived_at(raw: &str) -> String {
    let Ok(ms) = raw.parse::<i64>() else {
        return raw.to_string();
    };
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant), days since 1970-01-01.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60
    )
}

#[cfg(test)]
mod format_tests {
    use super::format_archived_at;

    #[test]
    fn formats_epoch_ms_as_utc_and_passes_through_junk() {
        assert_eq!(format_archived_at("0"), "1970-01-01 00:00");
        assert_eq!(format_archived_at("1792985702742"), "2026-10-26 03:35");
        assert_eq!(format_archived_at("not-a-number"), "not-a-number");
    }
}

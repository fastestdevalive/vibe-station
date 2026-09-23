use vst_types::rest::sessions::{ResetBody, ResetResult};

use crate::client::{daemon_post, DaemonResult};
use crate::env::get_vst_session;
use crate::output::success;
use crate::preflight::preflight;
use crate::text_source::resolve_file_or_inline;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionResetOptions {
    pub id: String,
    pub handoff: bool,
    pub prompt: Option<String>,
    pub mode: Option<String>,
    pub handoff_file: Option<String>,
}

pub fn parse_session_reset_options(args: &[String]) -> Result<SessionResetOptions, String> {
    let mut opts = SessionResetOptions::default();
    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--handoff" => {
                opts.handoff = true;
            }
            "--prompt" => {
                opts.prompt = iter.next().cloned();
            }
            s if s.starts_with("--prompt=") => {
                opts.prompt = Some(s.trim_start_matches("--prompt=").to_string());
            }
            "--mode" => {
                opts.mode = iter.next().cloned();
            }
            s if s.starts_with("--mode=") => {
                opts.mode = Some(s.trim_start_matches("--mode=").to_string());
            }
            "--handoff-file" => {
                opts.handoff_file = iter.next().cloned();
            }
            s if s.starts_with("--handoff-file=") => {
                opts.handoff_file = Some(s.trim_start_matches("--handoff-file=").to_string());
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

pub async fn run_session_reset(opts: SessionResetOptions) -> Result<(), (String, i32)> {
    if opts.handoff {
        if let Some(vst_session) = get_vst_session() {
            if vst_session == opts.id {
                return Err((
                    format!(
                        "Cannot use --handoff on the session you are running inside ({}). \
                        You are blocked on this command, so the daemon cannot ask you for a summary. \
                        Instead: write your handoff summary to any file, then run \
                        `vst session reset {} --handoff-file <path>` (not --handoff). \
                        The `/vst reset --handoff` in-chat command does exactly this.",
                        opts.id, opts.id
                    ),
                    1,
                ));
            }
        }
    }

    let handoff_text = resolve_file_or_inline(None, opts.handoff_file, "--handoff-file");

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

    let body = ResetBody {
        handoff: if opts.handoff { Some(true) } else { None },
        prompt: opts.prompt,
        handoff_text,
        mode_id: opts.mode,
    };

    let result = daemon_post::<ResetResult, _>(&format!("/sessions/{encoded}/reset"), Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            success(&format!(
                "Archived: {}, New: {}",
                data.archived_session_id, data.new_session_id
            ));
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

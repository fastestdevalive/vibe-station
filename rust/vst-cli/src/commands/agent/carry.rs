//! Shared flags and request plumbing for `vst agent start-fresh` / `switch`.
//!
//! Both commands POST the same `POST /sessions/:id/reset` route; they differ
//! only in their defaults and in whether a `--mode` is required. Everything
//! that must stay identical between them (flag parsing, the self-target guard,
//! the request body, the success/JSON output, the exit codes) lives here.

use serde_json::Value;
use vst_types::domain::{Channel, SessionBreakKind};
use vst_types::rest::sessions::{CarryOver, QueuedPolicy, ResetBody, ResetResult, WhenBusy};

use crate::client::{daemon_post, DaemonResult};
use crate::env::get_vst_session;
use crate::preflight::preflight;
use crate::text_source::try_resolve_file_or_inline;

/// Message shown when the daemon refused to write a summary (409).
pub const SUMMARY_FAILED: &str =
    "Summary was not written; nothing changed. Retry with --carry=transcript.";

/// The parsed flags common to `start-fresh` and `switch`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CarryOptions {
    pub id: String,
    /// `None` means "use this command's default" (none / summary).
    pub carry: Option<CarryOver>,
    pub summary_file: Option<String>,
    pub when_busy: WhenBusy,
    pub queued: QueuedPolicy,
    pub channel: Option<Channel>,
    pub prompt: Option<String>,
    pub json: bool,
}

impl CarryOptions {
    /// The carry mode this command will actually request.
    pub fn effective_carry(&self, default: CarryOver) -> CarryOver {
        self.carry.unwrap_or(default)
    }
}

/// Parse the flags shared by `start-fresh` and `switch`.
///
/// `allow_mode` is true only for `switch`; any other caller rejects `--mode`
/// as an unknown option. Returns the parsed options plus the requested mode
/// (name or id), which the caller validates/requires itself.
pub fn parse_carry_args(
    args: &[String],
    allow_mode: bool,
) -> Result<(CarryOptions, Option<String>), String> {
    let mut opts = CarryOptions {
        when_busy: WhenBusy::Stop,
        queued: QueuedPolicy::Carry,
        ..Default::default()
    };
    let mut mode: Option<String> = None;
    let mut positional: Vec<String> = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--carry" => {
                let val = iter
                    .next()
                    .ok_or_else(|| "--carry requires an argument".to_string())?;
                opts.carry = Some(parse_carry(val)?);
            }
            s if s.starts_with("--carry=") => {
                opts.carry = Some(parse_carry(s.trim_start_matches("--carry="))?);
            }
            "--summary-file" => {
                opts.summary_file = Some(
                    iter.next()
                        .cloned()
                        .ok_or_else(|| "--summary-file requires an argument".to_string())?,
                );
            }
            s if s.starts_with("--summary-file=") => {
                opts.summary_file = Some(s.trim_start_matches("--summary-file=").to_string());
            }
            "--when-busy" => {
                let val = iter
                    .next()
                    .ok_or_else(|| "--when-busy requires an argument".to_string())?;
                opts.when_busy = parse_when_busy(val)?;
            }
            s if s.starts_with("--when-busy=") => {
                opts.when_busy = parse_when_busy(s.trim_start_matches("--when-busy="))?;
            }
            "--queued" => {
                let val = iter
                    .next()
                    .ok_or_else(|| "--queued requires an argument".to_string())?;
                opts.queued = parse_queued(val)?;
            }
            s if s.starts_with("--queued=") => {
                opts.queued = parse_queued(s.trim_start_matches("--queued="))?;
            }
            "--channel" => {
                let val = iter
                    .next()
                    .ok_or_else(|| "--channel requires an argument".to_string())?;
                opts.channel = Some(parse_channel(val)?);
            }
            s if s.starts_with("--channel=") => {
                opts.channel = Some(parse_channel(s.trim_start_matches("--channel="))?);
            }
            "--prompt" => {
                opts.prompt = iter.next().cloned();
            }
            s if s.starts_with("--prompt=") => {
                opts.prompt = Some(s.trim_start_matches("--prompt=").to_string());
            }
            "--mode" => {
                if !allow_mode {
                    return Err(
                        "Unknown option: --mode (only `vst agent switch` takes a mode)".to_string(),
                    );
                }
                mode = Some(
                    iter.next()
                        .cloned()
                        .ok_or_else(|| "--mode requires an argument".to_string())?,
                );
            }
            s if s.starts_with("--mode=") => {
                if !allow_mode {
                    return Err(
                        "Unknown option: --mode (only `vst agent switch` takes a mode)".to_string(),
                    );
                }
                mode = Some(s.trim_start_matches("--mode=").to_string());
            }
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

    let mut positional = positional.into_iter();
    opts.id = positional
        .next()
        .ok_or_else(|| "Session ID is required".to_string())?;
    if let Some(extra) = positional.next() {
        return Err(format!("Unexpected argument: {extra}"));
    }

    Ok((opts, mode))
}

pub fn parse_carry(value: &str) -> Result<CarryOver, String> {
    match value {
        "none" => Ok(CarryOver::Nothing),
        "summary" => Ok(CarryOver::Summary),
        "transcript" => Ok(CarryOver::Transcript),
        other => Err(format!(
            "Invalid --carry value: {other}. Use one of none, summary, transcript."
        )),
    }
}

pub fn parse_when_busy(value: &str) -> Result<WhenBusy, String> {
    match value {
        "stop" => Ok(WhenBusy::Stop),
        "wait" => Ok(WhenBusy::Wait),
        other => Err(format!(
            "Invalid --when-busy value: {other}. Use one of stop, wait."
        )),
    }
}

pub fn parse_queued(value: &str) -> Result<QueuedPolicy, String> {
    match value {
        "carry" => Ok(QueuedPolicy::Carry),
        "drop" => Ok(QueuedPolicy::Drop),
        other => Err(format!(
            "Invalid --queued value: {other}. Use one of carry, drop."
        )),
    }
}

pub fn parse_channel(value: &str) -> Result<Channel, String> {
    match value {
        "json" => Ok(Channel::Json),
        "tmux" => Ok(Channel::Tmux),
        other => Err(format!(
            "Invalid --channel value: {other}. Use one of json, tmux."
        )),
    }
}

/// Read `--summary-file` (the caller's own summary). Fails loudly when the
/// file cannot be read, so a summary the caller explicitly asked for is never
/// silently dropped.
pub fn resolve_summary_text(opts: &CarryOptions) -> Result<Option<String>, String> {
    try_resolve_file_or_inline(None, opts.summary_file.clone(), "--summary-file")
}

/// Refuse the two combinations that cannot work when the target is the
/// session this command is running inside (the caller is blocked on the
/// command, so the daemon can never ask it for a summary, and a `wait` would
/// deadlock for up to ten minutes).
pub fn check_self_target(opts: &CarryOptions, carry: CarryOver) -> Result<(), (String, i32)> {
    let Some(vst_session) = get_vst_session() else {
        return Ok(());
    };
    if vst_session != opts.id {
        return Ok(());
    }
    if carry == CarryOver::Summary && opts.summary_file.is_none() {
        return Err((
            format!(
                "Cannot use --carry=summary on the session you are running inside ({}). \
                 You are blocked on this command, so the daemon cannot ask you for a summary. \
                 Write the summary to any file and pass --summary-file=<path> instead, \
                 or use --carry=transcript.",
                opts.id
            ),
            1,
        ));
    }
    if opts.when_busy == WhenBusy::Wait {
        return Err((
            format!(
                "Cannot use --when-busy=wait on the session you are running inside ({}). \
                 It would wait for your own turn to finish, which cannot happen while you are \
                 blocked on this command. Use --when-busy=stop (the default).",
                opts.id
            ),
            1,
        ));
    }
    Ok(())
}

/// Build the `POST /sessions/:id/reset` body for either command.
pub fn reset_body(
    opts: &CarryOptions,
    carry: CarryOver,
    mode_id: Option<String>,
    handoff_text: Option<String>,
) -> ResetBody {
    ResetBody {
        carry_over: Some(carry),
        when_busy: Some(opts.when_busy),
        queued: Some(opts.queued),
        channel: opts.channel,
        prompt: opts.prompt.clone(),
        mode_id,
        handoff_text,
        ..Default::default()
    }
}

pub fn carry_name(carry: CarryOver) -> &'static str {
    match carry {
        CarryOver::Nothing => "none",
        CarryOver::Summary => "summary",
        CarryOver::Transcript => "transcript",
    }
}

/// The human success line (`verb` is "Started fresh" / "Switched").
pub fn success_line(verb: &str, data: &ResetResult) -> String {
    format!(
        "{verb}. Archived: {}, New: {} (carried: {})",
        data.archived_session_id,
        data.new_session_id,
        carry_name(data.carry_over)
    )
}

/// The `--json` shape (compact, per the CLI/skill draft).
pub fn result_json(data: &ResetResult) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("ok".to_string(), Value::Bool(data.ok));
    map.insert(
        "archivedSessionId".to_string(),
        Value::String(data.archived_session_id.clone()),
    );
    map.insert(
        "newSessionId".to_string(),
        Value::String(data.new_session_id.clone()),
    );
    map.insert(
        "carryOver".to_string(),
        Value::String(carry_name(data.carry_over).to_string()),
    );
    if let Some(kind) = data.break_kind {
        map.insert(
            "breakKind".to_string(),
            Value::String(
                match kind {
                    SessionBreakKind::Reset => "reset",
                    SessionBreakKind::Switch => "switch",
                }
                .to_string(),
            ),
        );
    }
    Value::Object(map)
}

/// Preflight + POST the reset and print the result. Shared by both commands.
pub async fn run_reset(
    opts: &CarryOptions,
    carry: CarryOver,
    mode_id: Option<String>,
    handoff_text: Option<String>,
    verb: &str,
) -> Result<(), (String, i32)> {
    preflight().await;
    post_reset(opts, carry, mode_id, handoff_text, verb).await
}

/// POST the reset and print the result, assuming the daemon is already known
/// to be reachable (callers that make their own GETs first preflight once).
pub async fn post_reset(
    opts: &CarryOptions,
    carry: CarryOver,
    mode_id: Option<String>,
    handoff_text: Option<String>,
    verb: &str,
) -> Result<(), (String, i32)> {
    let encoded = encode_id(&opts.id);
    let body = reset_body(opts, carry, mode_id, handoff_text);
    let result = daemon_post::<ResetResult, _>(&format!("/sessions/{encoded}/reset"), Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                match serde_json::to_string(&result_json(&data)) {
                    Ok(json) => println!("{json}"),
                    Err(err) => eprintln!("error: failed to serialize json: {err}"),
                }
            } else {
                crate::output::success(&success_line(verb, &data));
            }
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            let message = if status == 409 && carry == CarryOver::Summary {
                SUMMARY_FAILED.to_string()
            } else {
                error
            };
            Err((message, code))
        }
    }
}

/// Percent-encode a session id for use as a path segment.
pub fn encode_id(id: &str) -> String {
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
    encoded
}

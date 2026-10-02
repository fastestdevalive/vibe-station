//! Building `LspFailure`s (daemon-authored summaries + remediation) and the
//! bounded per-server log that supplies their raw `message` text.

use std::collections::VecDeque;

use vst_types::rest::lsp::{LspFailure, LspFailureKind, LspRemediation, LspRemediationKind};

/// Cap on `LspFailure::message` (raw server text).
pub const MESSAGE_CAP: usize = 2048;
/// How many crash restarts the daemon attempts on its own before latching.
pub const MAX_CRASH_RESTARTS: u32 = 3;
/// Summary-line cap for the first line of a server's init error.
const SUMMARY_LINE_CAP: usize = 140;

const LOG_MAX_LINES: usize = 200;
const LOG_MAX_BYTES: usize = 32 * 1024;
const LOG_LINE_CAP: usize = 1024;

pub fn is_dependency_kind(kind: LspFailureKind) -> bool {
    matches!(
        kind,
        LspFailureKind::MissingDependency | LspFailureKind::IncompatibleDependency
    )
}

fn truncate_at_char(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Keeps the END of `s` (the most recent output), within `max` bytes.
fn keep_tail(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// The raw message for a failure: the server's own error first (when there is
/// one), then the stderr/log tail. Capped at `MESSAGE_CAP`.
pub fn compose_message(primary: Option<&str>, log_tail: &str) -> Option<String> {
    let log_tail = log_tail.trim();
    let out = match (primary.map(str::trim).filter(|p| !p.is_empty()), log_tail) {
        (None, "") => return None,
        (Some(p), "") => truncate_at_char(p, MESSAGE_CAP).to_string(),
        (None, tail) => keep_tail(tail, MESSAGE_CAP).to_string(),
        (Some(p), tail) => {
            let p = truncate_at_char(p, MESSAGE_CAP / 2);
            let room = MESSAGE_CAP.saturating_sub(p.len() + "\n\nServer log:\n".len());
            format!("{p}\n\nServer log:\n{}", keep_tail(tail, room))
        }
    };
    Some(out)
}

fn first_line(message: &str) -> String {
    let line = message
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    // Strip the JSON-RPC wrapper ts-ls & co. add; the rest is the server's words.
    let line = line
        .strip_prefix("Request initialize failed with message: ")
        .unwrap_or(line);
    let cut = truncate_at_char(line, SUMMARY_LINE_CAP);
    if cut.len() < line.len() {
        format!("{cut}…")
    } else {
        cut.to_string()
    }
}

fn remediation(install: Option<String>) -> Vec<LspRemediation> {
    let mut out = Vec::new();
    if let Some(command) = install {
        out.push(LspRemediation {
            kind: LspRemediationKind::CopyCommand,
            label: "Copy install command".to_string(),
            command: Some(command),
        });
    }
    out.push(LspRemediation {
        kind: LspRemediationKind::Retry,
        label: "Retry".to_string(),
        command: None,
    });
    out
}

/// A dependency failure (from the structural probe or a hint-upgraded init
/// error). `auto_retry`: the daemon keeps re-probing until it's fixed.
pub fn dependency_failure(
    kind: LspFailureKind,
    summary: String,
    install: Option<String>,
    message: Option<String>,
) -> LspFailure {
    LspFailure {
        kind,
        summary,
        message,
        exit_code: None,
        remediation: remediation(install),
        auto_retry: true,
    }
}

/// A phase-classified failure for server binary `command`.
pub fn phase_failure(
    kind: LspFailureKind,
    command: &str,
    server_error: Option<&str>,
    log_tail: &str,
    exit_code: Option<i32>,
) -> LspFailure {
    let summary = match kind {
        LspFailureKind::InitFailed => match server_error.map(first_line) {
            Some(line) if !line.is_empty() => format!("{command} failed to start: {line}"),
            _ => format!("{command} failed to start."),
        },
        LspFailureKind::ExitedOnStart => match exit_code {
            Some(code) => format!("{command} exited during startup (exit code {code})."),
            None => format!("{command} exited during startup."),
        },
        LspFailureKind::InitTimeout => format!("{command} didn't respond within 10 s."),
        LspFailureKind::SpawnFailed => match server_error {
            Some(e) => format!("{command} could not be started: {}", first_line(e)),
            None => format!("{command} could not be started."),
        },
        // Callers use `crash_failure` / `dependency_failure` for these.
        LspFailureKind::Crashed
        | LspFailureKind::MissingDependency
        | LspFailureKind::IncompatibleDependency => format!("{command} failed to start."),
    };
    LspFailure {
        kind,
        summary,
        message: compose_message(server_error, log_tail),
        exit_code,
        remediation: remediation(None),
        auto_retry: false,
    }
}

/// A crash after a successful initialize. `crash_count` is this crash's
/// ordinal within the current window (1-based); up to `MAX_CRASH_RESTARTS`
/// the daemon restarts on its own.
pub fn crash_failure(
    command: &str,
    crash_count: u32,
    window_secs: u64,
    log_tail: &str,
    exit_code: Option<i32>,
) -> LspFailure {
    let auto_retry = crash_count <= MAX_CRASH_RESTARTS;
    let summary = if auto_retry {
        format!(
            "{command} stopped unexpectedly — restarting (attempt {crash_count} of {MAX_CRASH_RESTARTS})."
        )
    } else {
        let minutes = window_secs.div_ceil(60).max(1);
        format!("{command} keeps crashing ({crash_count} times in {minutes} min).")
    };
    LspFailure {
        kind: LspFailureKind::Crashed,
        summary,
        message: compose_message(None, log_tail),
        exit_code,
        remediation: remediation(None),
        auto_retry,
    }
}

/// Bounded ring buffer of a server's stderr lines and `window/logMessage` /
/// `window/showMessage` text: ≤200 lines, ≤32 KB, each line ≤1 KB.
#[derive(Debug, Default)]
pub struct ServerLog {
    lines: VecDeque<String>,
    bytes: usize,
}

impl ServerLog {
    pub fn push(&mut self, line: &str) {
        let line = line.trim_end_matches(['\n', '\r']);
        let line = if line.len() > LOG_LINE_CAP {
            format!("{}…", truncate_at_char(line, LOG_LINE_CAP))
        } else {
            line.to_string()
        };
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > LOG_MAX_LINES || self.bytes > LOG_MAX_BYTES {
            match self.lines.pop_front() {
                Some(old) => self.bytes -= old.len(),
                None => break,
            }
        }
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// The most recent lines, joined, within `max_bytes`.
    pub fn tail(&self, max_bytes: usize) -> String {
        let mut picked: Vec<&str> = Vec::new();
        let mut used = 0;
        for line in self.lines.iter().rev() {
            if used + line.len() + 1 > max_bytes {
                break;
            }
            used += line.len() + 1;
            picked.push(line);
        }
        picked.reverse();
        picked.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_failed_summary_uses_first_line_without_rpc_wrapper() {
        let f = phase_failure(
            LspFailureKind::InitFailed,
            "typescript-language-server",
            Some("Request initialize failed with message: Could not find a valid TypeScript installation.\nmore"),
            "",
            None,
        );
        assert_eq!(
            f.summary,
            "typescript-language-server failed to start: Could not find a valid TypeScript installation."
        );
        assert!(f.message.as_deref().unwrap().contains("\nmore"));
        assert!(!f.auto_retry);
        assert_eq!(f.remediation.len(), 1);
        assert_eq!(f.remediation[0].kind, LspRemediationKind::Retry);
    }

    #[test]
    fn long_first_line_is_capped() {
        let long = "x".repeat(500);
        let f = phase_failure(LspFailureKind::InitFailed, "srv", Some(&long), "", None);
        assert!(f.summary.len() < 200, "{}", f.summary.len());
        assert!(f.summary.ends_with('…'));
    }

    #[test]
    fn exited_on_start_names_exit_code_and_carries_stderr() {
        let f = phase_failure(
            LspFailureKind::ExitedOnStart,
            "srv",
            None,
            "boom: missing lib\n",
            Some(1),
        );
        assert_eq!(f.summary, "srv exited during startup (exit code 1).");
        assert_eq!(f.message.as_deref(), Some("boom: missing lib"));
        assert_eq!(f.exit_code, Some(1));
    }

    #[test]
    fn message_is_capped_at_2kb() {
        let big = "e".repeat(10_000);
        let m = compose_message(Some(&big), &big).unwrap();
        assert!(m.len() <= MESSAGE_CAP, "{}", m.len());
        assert!(compose_message(None, &big).unwrap().len() <= MESSAGE_CAP);
        assert_eq!(compose_message(None, "  "), None);
    }

    #[test]
    fn crash_restarts_then_latches() {
        let f = crash_failure("srv", 2, 30, "", Some(139));
        assert!(f.auto_retry);
        assert_eq!(
            f.summary,
            "srv stopped unexpectedly — restarting (attempt 2 of 3)."
        );
        let f = crash_failure("srv", 4, 100, "", None);
        assert!(!f.auto_retry);
        assert_eq!(f.summary, "srv keeps crashing (4 times in 2 min).");
    }

    #[test]
    fn dependency_failure_offers_copy_then_retry() {
        let f = dependency_failure(
            LspFailureKind::MissingDependency,
            "TS missing".into(),
            Some("npm i -D \"typescript@<7\"".into()),
            None,
        );
        assert!(f.auto_retry);
        let kinds: Vec<_> = f.remediation.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            [LspRemediationKind::CopyCommand, LspRemediationKind::Retry]
        );
        assert_eq!(
            f.remediation[0].command.as_deref(),
            Some("npm i -D \"typescript@<7\"")
        );
    }

    #[test]
    fn server_log_stays_bounded() {
        let mut log = ServerLog::default();
        for i in 0..10_000 {
            log.push(&format!("line {i} {}", "y".repeat(300)));
        }
        assert!(log.len() <= 200);
        assert!(log.bytes() <= 32 * 1024);
        log.push(&"z".repeat(5000));
        assert!(log.tail(usize::MAX).lines().last().unwrap().len() <= 1024 + 3);
        let tail = log.tail(100);
        assert!(tail.len() <= 100);
    }
}

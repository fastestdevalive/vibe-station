//! Claude plan-limit probe — reads the user's subscription usage windows by
//! sending a `get_usage` control request to the user's OWN `claude` binary.
//!
//! This is Decision 1 of the harness-limits plan: no ACP, no adapter, no
//! Node/bun, no JS helper. We spawn the vendor binary (`-p --input-format
//! stream-json --output-format stream-json --verbose --no-session-persistence
//! --strict-mcp-config --settings {"disableAllHooks":true}`), write one
//! `get_usage` `control_request` line to stdin, read stdout until the matching
//! `control_response`, then kill the child.
//!
//! Boundaries (AGENTS.md § System Boundaries): never reads tokens, credential
//! files or user config; never panics; bounded by [`PROBE_TIMEOUT`]; every
//! failure is folded into `LimitsResult.status` (the caller never sees an
//! `Err`). `get_usage` is experimental on the vendor side, so the parser here
//! is deliberately tolerant (`serde_json::Value` navigation only) and the
//! failure fallback returns a visible `Error` reason rather than hiding behind
//! `Unsupported`.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use vst_types::{LimitStatus, LimitsResult};

/// This harness's plugin id / binary name.
pub const HARNESS: &str = "claude";
/// Per-probe wall-clock bound; a hung `claude` cannot wedge the scheduler.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// The two plan windows claude reports, with their cadence in minutes.
pub const WINDOWS: [(&str, u32); 2] = [("five_hour", 300), ("seven_day", 10080)];

/// Pure. `msg` = one parsed stdout JSON line of type `"control_response"`.
///
/// Tolerant, `Value` navigation only. Rules (see plan § 2.3):
/// - `response.subtype == "error"` → `Error` failure with the error text.
/// - `rate_limits_available == false` or `rate_limits` null → `NoPlanLimits`
///   ("No plan limits: signed out or using an API key") with both windows as
///   placeholders.
/// - else each present `five_hour`/`seven_day` object with a numeric
///   `utilization` yields a real window; missing/non-numeric windows become
///   `NoData` placeholders. Result `status` is `Ok` if ≥1 window has data,
///   else `NoData` ("Claude returned no 5-hour or weekly window").
pub fn interpret_claude_response(msg: &serde_json::Value, as_of: &str) -> LimitsResult {
    let resp = msg.get("response");
    if resp.and_then(|r| r.get("subtype")).and_then(|s| s.as_str()) == Some("error") {
        let detail = resp
            .and_then(|r| r.get("error"))
            .and_then(|e| e.as_str())
            .unwrap_or("claude get_usage failed");
        return placeholder_result(LimitStatus::Error, detail, as_of);
    }
    let rate_limits = resp
        .and_then(|r| r.get("response"))
        .and_then(|r| r.get("rate_limits"));
    let available = resp
        .and_then(|r| r.get("response"))
        .and_then(|r| r.get("rate_limits_available"))
        .and_then(|v| v.as_bool());
    if available == Some(false)
        || rate_limits.is_none()
        || rate_limits == Some(&serde_json::Value::Null)
    {
        return placeholder_result(
            LimitStatus::NoPlanLimits,
            "No plan limits: signed out or using an API key",
            as_of,
        );
    }

    let mut windows = Vec::with_capacity(WINDOWS.len());
    let mut any_data = false;
    for (id, cadence) in WINDOWS {
        let slot = rate_limits
            .and_then(|rl| rl.get(id))
            .filter(|v| v.is_object());
        let utilization = slot
            .and_then(|s| s.get("utilization"))
            .and_then(|u| u.as_f64());
        let window = match (slot, utilization) {
            (Some(s), Some(util)) => {
                any_data = true;
                vst_types::LimitWindow {
                    harness: HARNESS.into(),
                    window_id: id.into(),
                    cadence_minutes: Some(cadence),
                    used_pct: Some(util),
                    resets_at: s
                        .get("resets_at")
                        .and_then(|r| r.as_str())
                        .map(normalize_iso),
                    as_of: as_of.into(),
                    status: LimitStatus::Ok,
                }
            }
            _ => vst_types::LimitWindow::placeholder(
                HARNESS,
                id,
                Some(cadence),
                LimitStatus::NoData,
                as_of,
            ),
        };
        windows.push(window);
    }

    if any_data {
        LimitsResult {
            harness: HARNESS.into(),
            status: LimitStatus::Ok,
            message: None,
            as_of: as_of.into(),
            windows,
        }
    } else {
        LimitsResult {
            harness: HARNESS.into(),
            status: LimitStatus::NoData,
            message: Some("Claude returned no 5-hour or weekly window".into()),
            as_of: as_of.into(),
            windows,
        }
    }
}

/// A failure result carrying both plan windows as `used_pct: None` placeholders.
fn placeholder_result(status: LimitStatus, message: &str, as_of: &str) -> LimitsResult {
    let windows: Vec<(&str, Option<u32>)> = WINDOWS.iter().map(|(id, c)| (*id, Some(*c))).collect();
    LimitsResult::failure(HARNESS, status, message, as_of, &windows)
}

/// `Err` = ready-to-return NotInstalled result (message "<binary> is not
/// installed (not found on PATH)", one placeholder per `windows` entry). Wraps
/// [`crate::registry::resolve_binary`].
pub(crate) fn resolve_or_not_installed(
    binary: &str,
    harness: &str,
    path: &str,
    windows: &[(&str, Option<u32>)],
    as_of: &str,
) -> Result<PathBuf, LimitsResult> {
    match crate::registry::resolve_binary(binary, path) {
        Some(p) => Ok(p),
        None => Err(LimitsResult::failure(
            harness,
            LimitStatus::NotInstalled,
            format!("{binary} is not installed (not found on PATH)"),
            as_of,
            windows,
        )),
    }
}

/// Normalise a vendor RFC3339 timestamp to the wire's millis-`Z` ISO-8601 form.
/// Falls back to the raw string when it does not parse.
fn normalize_iso(s: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(s) {
        Ok(dt) => crate::util::ms_to_iso_8601(dt.timestamp_millis()),
        Err(_) => s.to_string(),
    }
}

/// Spawns `claude`, bounded; never panics.
pub async fn probe_claude_limits() -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, probe_claude_limits_inner()).await;
    match outcome {
        Ok(r) => r,
        Err(_) => placeholder_result(LimitStatus::Error, "timed out after 20s", &as_of),
    }
}

async fn probe_claude_limits_inner() -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let path = match resolve_or_not_installed(
        HARNESS,
        HARNESS,
        &crate::context::effective_path(),
        &window_placeholders(),
        &as_of,
    ) {
        Ok(p) => p,
        Err(r) => return r,
    };

    let probe_dir = crate::home::home_dir()
        .join(".vibe-station")
        .join("model-probe");
    if let Err(e) = tokio::fs::create_dir_all(&probe_dir).await {
        return placeholder_result(
            LimitStatus::Error,
            &format!("couldn't create the probe directory: {e}"),
            &as_of,
        );
    }

    let mut child = match tokio::process::Command::new(&path)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--settings",
            "{\"disableAllHooks\":true}",
        ])
        .current_dir(&probe_dir)
        .env("PATH", crate::context::effective_path())
        .env("CLAUDE_CODE_AUTO_CONNECT_IDE", "false")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return placeholder_result(
                LimitStatus::Error,
                &format!("couldn't start claude: {e}"),
                &as_of,
            )
        }
    };

    // Keep stdin alive until the response is read: dropping it = EOF, and
    // claude may exit before answering.
    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            return placeholder_result(LimitStatus::Error, "couldn't open claude stdin", &as_of)
        }
    };
    if let Err(e) = stdin
        .write_all(b"{\"type\":\"control_request\",\"request_id\":\"vst-limits-1\",\"request\":{\"subtype\":\"get_usage\"}}\n")
        .await
    {
        let _ = child.kill().await;
        return placeholder_result(LimitStatus::Error, &format!("couldn't write to claude stdin: {e}"), &as_of);
    }
    if let Err(e) = stdin.flush().await {
        let _ = child.kill().await;
        return placeholder_result(
            LimitStatus::Error,
            &format!("couldn't flush claude stdin: {e}"),
            &as_of,
        );
    }

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            return placeholder_result(LimitStatus::Error, "couldn't open claude stdout", &as_of);
        }
    };
    let mut lines = BufReader::new(stdout).lines();
    let mut result = None;
    while let Some(line) = lines.next_line().await.unwrap_or(None) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let is_match = v.get("type").and_then(|t| t.as_str()) == Some("control_response")
            && v.get("response")
                .and_then(|r| r.get("request_id"))
                .and_then(|r| r.as_str())
                == Some("vst-limits-1");
        if is_match {
            result = Some(interpret_claude_response(&v, &as_of));
            break;
        }
    }

    let _ = child.kill().await;
    match result {
        Some(r) => r,
        None => placeholder_result(
            LimitStatus::Error,
            "claude exited without answering",
            &as_of,
        ),
    }
}

fn window_placeholders() -> Vec<(&'static str, Option<u32>)> {
    WINDOWS.iter().map(|(id, c)| (*id, Some(*c))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn make_executable(dir: &std::path::Path, name: &str) {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&p, perms).unwrap();
    }

    fn unique_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vst-limits-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn resolve_or_not_installed_not_installed() {
        let dir = unique_tmp("not-installed");
        std::fs::create_dir_all(&dir).unwrap();
        let as_of = crate::util::now_iso_8601();
        let windows = [("five_hour", Some(300)), ("seven_day", Some(10080))];
        let err = resolve_or_not_installed(
            "claude",
            "claude",
            &dir.display().to_string(),
            &windows,
            &as_of,
        )
        .unwrap_err();
        assert_eq!(err.status, LimitStatus::NotInstalled);
        assert!(err.message.as_deref().unwrap().contains("claude"));
        assert_eq!(err.windows.len(), 2);
        assert!(err.windows.iter().all(|w| w.used_pct.is_none()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_or_not_installed_found() {
        let dir = unique_tmp("found");
        std::fs::create_dir_all(&dir).unwrap();
        make_executable(&dir, "claude");
        let as_of = crate::util::now_iso_8601();
        let windows = [("five_hour", Some(300))];
        let path = resolve_or_not_installed(
            "claude",
            "claude",
            &dir.display().to_string(),
            &windows,
            &as_of,
        )
        .unwrap();
        assert_eq!(path, dir.join("claude"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_or_not_installed_codex_found() {
        let dir = unique_tmp("codex-found");
        std::fs::create_dir_all(&dir).unwrap();
        make_executable(&dir, "codex");
        let as_of = crate::util::now_iso_8601();
        let windows = [("primary", None)];
        let path = resolve_or_not_installed(
            "codex",
            "codex",
            &dir.display().to_string(),
            &windows,
            &as_of,
        )
        .unwrap();
        assert_eq!(path, dir.join("codex"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

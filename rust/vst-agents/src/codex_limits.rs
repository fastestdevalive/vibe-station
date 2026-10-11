//! Codex rate-limit probe — reads the user's subscription usage windows by
//! driving `codex app-server` over stdio (Decision 2 of the harness-limits
//! plan). `initialize` → notify `initialized` → `account/rateLimits/read`,
//! then parse `result.rateLimits.{primary,secondary}`.
//!
//! Boundaries: newline-delimited JSON with NO `jsonrpc` field; never reads
//! tokens/credential files; never panics; bounded by [`PROBE_TIMEOUT`];
//! failures are folded into `LimitsResult.status`.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use vst_types::{LimitStatus, LimitsResult};

/// This harness's plugin id / binary name.
pub const HARNESS: &str = "codex";
/// Per-probe wall-clock bound.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Placeholder windows used when codex reports no usable data.
const PLACEHOLDERS: [(&str, Option<u32>); 1] = [("primary", None)];

/// Pure. `msg` = the parsed `id == 2` (`account/rateLimits/read`) response line.
pub fn interpret_codex_rate_limits(msg: &serde_json::Value, as_of: &str) -> LimitsResult {
    if let Some(err) = msg.get("error") {
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("codex rate-limits request failed");
        let status = if message.to_lowercase().contains("authentication") {
            LimitStatus::SignedOut
        } else {
            LimitStatus::Error
        };
        let text = if status == LimitStatus::SignedOut {
            "Not signed in to Codex (run `codex login`)"
        } else {
            message
        };
        return LimitsResult::failure(HARNESS, status, text, as_of, &PLACEHOLDERS);
    }

    let rate_limits = msg
        .get("result")
        .and_then(|r| r.get("rateLimits"))
        .filter(|v| v.is_object());

    let mut windows = Vec::new();
    if let Some(rl) = rate_limits {
        for (id, json) in [
            ("primary", rl.get("primary")),
            ("secondary", rl.get("secondary")),
        ] {
            let Some(obj) = json.filter(|v| v.is_object()) else {
                continue;
            };
            let Some(used) = obj.get("usedPercent").and_then(|u| u.as_f64()) else {
                continue;
            };
            let cadence = obj
                .get("windowDurationMins")
                .and_then(|c| c.as_f64())
                .and_then(|c| (c > 0.0).then_some(c as u32));
            let resets_at = obj
                .get("resetsAt")
                .and_then(|r| r.as_f64())
                .map(|secs| crate::util::ms_to_iso_8601((secs as i64).saturating_mul(1000)));
            windows.push(vst_types::LimitWindow {
                harness: HARNESS.into(),
                window_id: id.into(),
                cadence_minutes: cadence,
                used_pct: Some(used),
                resets_at,
                as_of: as_of.into(),
                status: LimitStatus::Ok,
            });
        }
    }

    if windows.is_empty() {
        return LimitsResult::failure(
            HARNESS,
            LimitStatus::NoData,
            "Codex returned no rate-limit windows",
            as_of,
            &PLACEHOLDERS,
        );
    }

    LimitsResult {
        harness: HARNESS.into(),
        status: LimitStatus::Ok,
        message: None,
        as_of: as_of.into(),
        windows,
    }
}

/// Spawns `codex app-server`, bounded; never panics.
pub async fn probe_codex_limits() -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, probe_codex_limits_inner()).await;
    match outcome {
        Ok(r) => r,
        Err(_) => LimitsResult::failure(
            HARNESS,
            LimitStatus::Error,
            "timed out after 20s",
            &as_of,
            &PLACEHOLDERS,
        ),
    }
}

async fn probe_codex_limits_inner() -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let path = match crate::claude_limits::resolve_or_not_installed(
        HARNESS,
        HARNESS,
        &crate::context::effective_path(),
        &PLACEHOLDERS,
        &as_of,
    ) {
        Ok(p) => p,
        Err(r) => return r,
    };

    let probe_dir = crate::home::home_dir()
        .join(".vibe-station")
        .join("model-probe");
    if let Err(e) = tokio::fs::create_dir_all(&probe_dir).await {
        return LimitsResult::failure(
            HARNESS,
            LimitStatus::Error,
            format!("couldn't create the probe directory: {e}"),
            &as_of,
            &PLACEHOLDERS,
        );
    }

    let mut child = match tokio::process::Command::new(&path)
        .args(["app-server"])
        .current_dir(&probe_dir)
        .env("PATH", crate::context::effective_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return LimitsResult::failure(
                HARNESS,
                LimitStatus::Error,
                format!("couldn't start codex: {e}"),
                &as_of,
                &PLACEHOLDERS,
            )
        }
    };

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            return LimitsResult::failure(
                HARNESS,
                LimitStatus::Error,
                "couldn't open codex stdin",
                &as_of,
                &PLACEHOLDERS,
            );
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            return LimitsResult::failure(
                HARNESS,
                LimitStatus::Error,
                "couldn't open codex stdout",
                &as_of,
                &PLACEHOLDERS,
            );
        }
    };

    let mut lines = BufReader::new(stdout).lines();
    let mut initialized = false;
    let mut result = None;

    // Send the `initialize` request first; codex waits for it before anything else.
    let init = serde_json::json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "vst-limits", "version": env!("CARGO_PKG_VERSION")}}}).to_string();
    if let Err(e) = send_line(&mut stdin, &init).await {
        let _ = child.kill().await;
        return LimitsResult::failure(
            HARNESS,
            LimitStatus::Error,
            format!("couldn't write to codex stdin: {e}"),
            &as_of,
            &PLACEHOLDERS,
        );
    }

    while let Some(line) = lines.next_line().await.unwrap_or(None) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let id = v.get("id").and_then(|i| i.as_u64());

        if !initialized {
            // Await the initialize result (id==1), then send `initialized`.
            if id == Some(1) {
                if v.get("error").is_some() {
                    let _ = child.kill().await;
                    let msg = v
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("codex initialize failed");
                    return LimitsResult::failure(
                        HARNESS,
                        LimitStatus::Error,
                        msg,
                        &as_of,
                        &PLACEHOLDERS,
                    );
                }
                initialized = true;
                let notified = serde_json::json!({"method": "initialized"}).to_string();
                let read =
                    serde_json::json!({"id": 2, "method": "account/rateLimits/read"}).to_string();
                if let Err(e) = send_line(&mut stdin, &notified).await {
                    let _ = child.kill().await;
                    return LimitsResult::failure(
                        HARNESS,
                        LimitStatus::Error,
                        format!("couldn't write to codex stdin: {e}"),
                        &as_of,
                        &PLACEHOLDERS,
                    );
                }
                if let Err(e) = send_line(&mut stdin, &read).await {
                    let _ = child.kill().await;
                    return LimitsResult::failure(
                        HARNESS,
                        LimitStatus::Error,
                        format!("couldn't write to codex stdin: {e}"),
                        &as_of,
                        &PLACEHOLDERS,
                    );
                }
            }
            continue;
        }

        if id == Some(2) {
            result = Some(interpret_codex_rate_limits(&v, &as_of));
            break;
        }
    }

    let _ = child.kill().await;
    match result {
        Some(r) => r,
        None => LimitsResult::failure(
            HARNESS,
            LimitStatus::Error,
            "codex exited without answering",
            &as_of,
            &PLACEHOLDERS,
        ),
    }
}

/// Write a newline-terminated JSON line to `stdin` and flush. Keeps stdin alive
/// (the caller holds it) so codex doesn't see EOF before answering.
async fn send_line(stdin: &mut tokio::process::ChildStdin, payload: &str) -> std::io::Result<()> {
    stdin.write_all(payload.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

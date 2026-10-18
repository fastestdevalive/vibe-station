//! Agy usage-limit probe — reads the user's plan usage windows by driving the
//! read-only `/usage` slash command of the user's OWN `agy` binary.
//!
//! This is the agy leg of the harness-limits plan: no ACP, no adapter, no
//! Node/bun, no JS helper. We spawn the vendor binary (`-p "/usage"
//! --output-format json`), parse the `command.data.groups[].buckets[]` JSON,
//! and never read the TSV `response` string (Decision 1).
//!
//! Boundaries (AGENTS.md § Vendors / System Boundaries): never reads tokens,
//! credential files or user config; never panics; bounded by [`PROBE_TIMEOUT`];
//! every failure is folded into `LimitsResult.status`. The `/usage` JSON shape
//! is vendor-unstable, so the parser is deliberately tolerant
//! (`serde_json::Value` navigation only) and any unparseable output degrades to
//! `NoData`/`Error` rather than hiding behind `Unsupported`.

use std::process::Stdio;

use vst_types::{LimitStatus, LimitsResult};

/// This harness's plugin id / binary name.
pub const HARNESS: &str = "agy";
/// Per-probe wall-clock bound; a hung `agy` cannot wedge the scheduler.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Placeholder windows used for non-`Error` failures (SignedOut / NoData /
/// NotInstalled). Probe-level `Error`s may carry them too (as codex does);
/// placeholders have no `used_pct`, so the merge still keeps last-good numbers.
const PLACEHOLDERS: [(&str, Option<u32>); 2] =
    [("gemini_5h", Some(300)), ("gemini_weekly", Some(10080))];

/// Case-insensitive auth markers in the top-level `response` string. When the
/// probe didn't `SUCCESS`, a match means the user is signed out rather than
/// the vendor being broken (Decision 6).
const AUTH_MARKERS: [&str; 7] = [
    "sign in",
    "signed out",
    "log in",
    "not logged in",
    "login required",
    "unauthenticated",
    "not authenticated",
];

/// Pure. `msg` = the parsed whole `agy -p "/usage" --output-format json`
/// output (one JSON object).
///
/// Tolerant, `Value` navigation only. Rules (see plan Decisions 2, 4, 5, 6, 7):
/// - top-level `status != "SUCCESS"` → `SignedOut` if the `response` string
///   matches [`AUTH_MARKERS`], else `Error` with the vendor `response` text
///   (or "agy usage probe failed").
/// - else each `command.data.groups[].buckets[]` with a numeric
///   `remaining_fraction` yields a real window; a bucket without one is
///   skipped. `window_id` = bucket `id` lowercased with non-alphanumeric runs
///   collapsed to `_`; `used_pct = (1 - remaining_fraction) * 100` clamped to
///   0..=100; `cadence_minutes` from bucket `window`; `resets_at` from
///   `reset_time`. Result `status` is `Ok` if ≥1 bucket parsed, else `NoData`
///   ("agy returned no usage windows").
pub fn interpret_agy_usage(msg: &serde_json::Value, as_of: &str) -> LimitsResult {
    let status = msg.get("status").and_then(|s| s.as_str());
    if status != Some("SUCCESS") {
        let response_text = msg.get("response").and_then(|r| r.as_str()).unwrap_or("");
        if is_auth_text(response_text) {
            return LimitsResult::failure(
                HARNESS,
                LimitStatus::SignedOut,
                "Not signed in to agy (run `agy`)",
                as_of,
                &PLACEHOLDERS,
            );
        }
        let message = if response_text.is_empty() {
            "agy usage probe failed"
        } else {
            response_text
        };
        return LimitsResult::failure(HARNESS, LimitStatus::Error, message, as_of, &[]);
    }

    let groups = msg
        .get("command")
        .and_then(|c| c.get("data"))
        .and_then(|d| d.get("groups"))
        .and_then(|g| g.as_array());

    let mut windows: Vec<vst_types::LimitWindow> = Vec::new();
    if let Some(groups) = groups {
        for group in groups {
            let Some(buckets) = group.get("buckets").and_then(|b| b.as_array()) else {
                continue;
            };
            for bucket in buckets {
                let Some(remaining) = bucket.get("remaining_fraction").and_then(|r| r.as_f64())
                else {
                    continue;
                };
                let Some(id) = bucket.get("id").and_then(|i| i.as_str()) else {
                    continue;
                };
                let used_pct = ((1.0 - remaining) * 100.0).clamp(0.0, 100.0);
                let cadence = bucket
                    .get("window")
                    .and_then(|w| w.as_str())
                    .and_then(cadence_minutes);
                let resets_at = bucket
                    .get("reset_time")
                    .and_then(|r| r.as_str())
                    .map(crate::claude_limits::normalize_iso);
                let window_id = normalize_window_id(id);
                // An id that normalises to nothing can't be pinned, and a repeated
                // id would collide as a React key / slot ref.
                if window_id.is_empty() || windows.iter().any(|w| w.window_id == window_id) {
                    continue;
                }
                windows.push(vst_types::LimitWindow {
                    harness: HARNESS.into(),
                    window_id,
                    cadence_minutes: cadence,
                    used_pct: Some(used_pct),
                    resets_at,
                    as_of: as_of.into(),
                    status: LimitStatus::Ok,
                });
            }
        }
    }

    if windows.is_empty() {
        return LimitsResult::failure(
            HARNESS,
            LimitStatus::NoData,
            "agy returned no usage windows",
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

/// True when `text` contains any [`AUTH_MARKERS`] entry, case-insensitively.
fn is_auth_text(text: &str) -> bool {
    let lower = text.to_lowercase();
    AUTH_MARKERS.iter().any(|m| lower.contains(m))
}

/// Collapse every run of non-alphanumeric chars in `id` to a single `_`, and
/// lowercase the result (`3p-5h` → `3p_5h`, `gemini-weekly` → `gemini_weekly`).
fn normalize_window_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    let mut pending_sep = false;
    for c in id.chars() {
        if c.is_alphanumeric() {
            if pending_sep && !out.is_empty() {
                out.push('_');
            }
            pending_sep = false;
            out.push(c.to_ascii_lowercase());
        } else {
            pending_sep = true;
        }
    }
    out
}

/// Cadence in minutes from a bucket `window` value (Decision 5): `"5h"` → 300,
/// `"weekly"` → 10080, a numeric `"<n>m|h|d"` → parsed, anything else → `None`.
fn cadence_minutes(window: &str) -> Option<u32> {
    match window {
        "5h" => Some(300),
        "weekly" => Some(10080),
        w => parse_cadence(w),
    }
}

/// Parse a `"<n>m"` / `"<n>h"` / `"<n>d"` duration into minutes.
fn parse_cadence(w: &str) -> Option<u32> {
    let w = w.trim();
    if w.len() < 2 {
        return None;
    }
    let (num, unit) = w.split_at(w.len() - 1);
    let n: u32 = num.parse().ok()?;
    match unit {
        "m" => Some(n),
        "h" => n.checked_mul(60),
        "d" => n.checked_mul(24 * 60),
        _ => None,
    }
}

/// Spawns `agy -p "/usage" --output-format json`, bounded; never panics.
///
/// Runs the read-only `/usage` slash command of the user's OWN `agy` binary
/// (Decision 1, 9, 11): the binary is resolved via [`crate::agy::resolve_agy_binary`]
/// so `AGY_BIN` works in sandboxes; stdout AND stderr are both piped; the child
/// is killed on drop and wall-clock bounded by [`PROBE_TIMEOUT`]. `agy` never
/// produces streaming output for `/usage`, so we `wait_with_output()` and parse
/// the captured stdout as ONE JSON object — no NDJSON loop (unlike codex).
pub async fn probe_agy_limits() -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, probe_agy_limits_inner()).await;
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

async fn probe_agy_limits_inner() -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let binary = crate::agy::resolve_agy_binary();
    let path = match crate::claude_limits::resolve_or_not_installed(
        &binary,
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

    let output = match tokio::process::Command::new(&path)
        .args(["-p", "/usage", "--output-format", "json"])
        .current_dir(&probe_dir)
        .env("PATH", crate::context::effective_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            return LimitsResult::failure(
                HARNESS,
                LimitStatus::Error,
                format!("couldn't start agy: {e}"),
                &as_of,
                &PLACEHOLDERS,
            )
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Parse stdout as ONE JSON object. Prefer the whole (trimmed) output; if it
    // is not a single object, fall back to the last non-empty line (agy may emit
    // a TUI progress banner first). Any remaining parse failure → Error.
    let parsed = parse_usage_json(&stdout).or_else(|| parse_usage_json(&stderr));

    match parsed {
        Some(msg) if msg.is_object() => {
            // Non-zero exit with a parsable object is folded into the parser
            // (its `status` field decides SignedOut vs Error). A zero exit that
            // parsed is handed straight to the interpreter.
            interpret_agy_usage(&msg, &as_of)
        }
        Some(_) | None if !output.status.success() => {
            // Non-zero exit with no parsable JSON → Error, prefer the vendor's
            // own message. Match auth markers against stdout+stderr text so a
            // signed-out agy reports SignedOut even when it doesn't return JSON.
            let text = combine_text(&stdout, &stderr);
            if is_auth_text(&text) {
                return LimitsResult::failure(
                    HARNESS,
                    LimitStatus::SignedOut,
                    "Not signed in to agy (run `agy`)",
                    &as_of,
                    &PLACEHOLDERS,
                );
            }
            let message = if text.trim().is_empty() {
                "agy usage probe failed"
            } else {
                text.trim()
            };
            LimitsResult::failure(HARNESS, LimitStatus::Error, message, &as_of, &[])
        }
        Some(_) | None => {
            // Zero exit but nothing parsable → not really usage data.
            LimitsResult::failure(
                HARNESS,
                LimitStatus::Error,
                "agy usage probe failed",
                &as_of,
                &PLACEHOLDERS,
            )
        }
    }
}

/// Parse `text` as a single JSON object (trimmed); if that fails, parse the
/// last non-empty line. Returns `None` when nothing parses as an object.
fn parse_usage_json(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return Some(v);
        }
    }
    text.lines().rev().find_map(|line| {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        serde_json::from_str::<serde_json::Value>(line).ok()
    })
}

/// Concatenate stdout + stderr (in that order) for auth-marker matching.
fn combine_text(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (true, true) => String::new(),
    }
}

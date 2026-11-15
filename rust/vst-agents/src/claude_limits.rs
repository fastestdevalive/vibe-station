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

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use vst_types::{LimitSignal, LimitStatus, LimitsResult};

/// This harness's plugin id / binary name.
pub const HARNESS: &str = "claude";
/// Shown for `rate_limits_available: false` / null `rate_limits`. Claude sends
/// exactly this for a signed-out CLI, an API key AND a long-lived
/// `claude setup-token` login (inference-only: no plan attached), so the text
/// names all three rather than implying the user is signed out.
pub const NO_PLAN_LIMITS_MESSAGE: &str =
    "No plan limits: signed out, an API key, or a setup-token login (run `claude login` for plan limits)";
/// Per-probe wall-clock bound; a hung `claude` cannot wedge the scheduler.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// The two plan windows claude reports, with their cadence in minutes.
pub const WINDOWS: [(&str, u32); 2] = [("five_hour", 300), ("seven_day", 10080)];

/// `rate_limits` keys that carry a `utilization` field (or look like windows)
/// but are NOT usage windows: the overage-credit feature, the spend block and
/// the per-surface breakdown. Never turned into windows by the generic scan.
const NON_WINDOW_KEYS: [&str; 3] = ["extra_usage", "spend", "seven_day_breakdown"];
/// Cap on any vendor-supplied label / id fragment we put on the wire.
const MAX_LABEL: usize = 48;

/// Pure. `msg` = one parsed stdout JSON line of type `"control_response"`.
///
/// Tolerant, `Value` navigation only. Rules (see plan § 2.3; the wire shape is
/// summarised in `docs/API-CONTRACT.md` § Harness limits):
/// - `response.subtype == "error"` → `Error` failure with the error text.
/// - `rate_limits_available == false` or `rate_limits` null → `NoPlanLimits`
///   ("No plan limits: signed out, an API key, or a setup-token login") with both windows as
///   placeholders.
/// - `five_hour` / `seven_day` keep their ids and cadences; a null / missing /
///   non-numeric one becomes a `NoData` placeholder (never a fake 0).
/// - Then every other bucket that carries a numeric value becomes an extra
///   window, present ONLY when it has data: scoped entries of `limits[]`
///   (`weekly_scoped` + `scope.model.display_name` → `seven_day:model:fable`),
///   `model_scoped[]` not already covered, and any other object key with a
///   numeric `utilization` (id = key, label = prettified key). A numeric
///   `limit_dollars` marks a dollar bucket (see [`vst_types::LimitDollars`]).
///   `limits[]` entries that duplicate `five_hour`/`seven_day`
///   (`session`, `weekly_all`) are skipped.
/// - `status` is `Ok` if ≥1 window has data, else `NoData`
///   ("Claude returned no 5-hour or weekly window").
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
        return placeholder_result(LimitStatus::NoPlanLimits, NO_PLAN_LIMITS_MESSAGE, as_of);
    }

    let mut windows = Vec::with_capacity(WINDOWS.len());
    let mut any_data = false;
    for (id, cadence) in WINDOWS {
        let slot = rate_limits
            .and_then(|rl| rl.get(id))
            .filter(|v| v.is_object());
        let window = match slot.and_then(|s| bucket_window(id, None, Some(cadence), s, as_of)) {
            Some(w) => {
                any_data = true;
                w
            }
            None => vst_types::LimitWindow::placeholder(
                HARNESS,
                id,
                Some(cadence),
                LimitStatus::NoData,
                as_of,
            ),
        };
        windows.push(window);
    }

    if let Some(rl) = rate_limits {
        for w in extra_windows(rl, as_of) {
            if windows.iter().all(|x| x.window_id != w.window_id) {
                any_data = true;
                windows.push(w);
            }
        }
    }

    if any_data {
        LimitsResult {
            harness: HARNESS.into(),
            account_id: None,
            status: LimitStatus::Ok,
            message: None,
            as_of: as_of.into(),
            windows,
        }
    } else {
        LimitsResult {
            harness: HARNESS.into(),
            account_id: None,
            status: LimitStatus::NoData,
            message: Some("Claude returned no 5-hour or weekly window".into()),
            as_of: as_of.into(),
            windows,
        }
    }
}

/// One window from a bucket object `{utilization, resets_at, limit_dollars, ...}`;
/// `None` unless `utilization` is a finite number.
fn bucket_window(
    id: &str,
    label: Option<String>,
    cadence: Option<u32>,
    obj: &serde_json::Value,
    as_of: &str,
) -> Option<vst_types::LimitWindow> {
    let util = finite(obj.get("utilization"))?;
    Some(make_window(
        id,
        label,
        cadence,
        util,
        obj.get("resets_at"),
        dollars_of(obj),
        as_of,
    ))
}

fn make_window(
    id: &str,
    label: Option<String>,
    cadence: Option<u32>,
    used_pct: f64,
    resets_at: Option<&serde_json::Value>,
    dollars: Option<vst_types::LimitDollars>,
    as_of: &str,
) -> vst_types::LimitWindow {
    vst_types::LimitWindow {
        harness: HARNESS.into(),
        window_id: id.into(),
        account_id: None,
        cadence_minutes: cadence,
        used_pct: Some(used_pct),
        resets_at: resets_at.and_then(|r| r.as_str()).map(normalize_iso),
        as_of: as_of.into(),
        status: LimitStatus::Ok,
        label,
        dollars,
    }
}

fn finite(v: Option<&serde_json::Value>) -> Option<f64> {
    v.and_then(|u| u.as_f64()).filter(|u| u.is_finite())
}

/// A dollar bucket iff `limit_dollars` is a number; `used`/`remaining` ride along when sent.
fn dollars_of(obj: &serde_json::Value) -> Option<vst_types::LimitDollars> {
    let limit = finite(obj.get("limit_dollars"))?;
    Some(vst_types::LimitDollars {
        limit: Some(limit),
        used: finite(obj.get("used_dollars")),
        remaining: finite(obj.get("remaining_dollars")),
    })
}

/// Windows beyond `five_hour` / `seven_day`, each with data. Order: scoped
/// `limits[]`, then `model_scoped[]`, then the generic key scan.
fn extra_windows(rl: &serde_json::Value, as_of: &str) -> Vec<vst_types::LimitWindow> {
    let mut out: Vec<vst_types::LimitWindow> = Vec::new();
    fn push(w: vst_types::LimitWindow, out: &mut Vec<vst_types::LimitWindow>) {
        if !w.window_id.is_empty()
            && !w.window_id.ends_with(':')
            && out.iter().all(|x| x.window_id != w.window_id)
        {
            out.push(w);
        }
    }

    for entry in rl
        .get("limits")
        .and_then(|l| l.as_array())
        .into_iter()
        .flatten()
    {
        let kind = entry.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        // These two restate `five_hour` / `seven_day`.
        if matches!(kind, "session" | "weekly_all") {
            continue;
        }
        let Some(pct) = finite(entry.get("percent")) else {
            continue;
        };
        let group = entry.get("group").and_then(|g| g.as_str()).unwrap_or("");
        let (prefix, cadence) = match group {
            "session" => ("five_hour", Some(300)),
            "weekly" => ("seven_day", Some(10080)),
            _ => ("limit", None),
        };
        let scope = entry.get("scope").filter(|s| s.is_object());
        let (tag, label) = scope_label(scope).unwrap_or_else(|| ("kind", pretty(kind)));
        if label.is_empty() {
            continue;
        }
        let id = if tag == "kind" {
            format!("{prefix}:{}", slug(kind))
        } else {
            format!("{prefix}:{tag}:{}", slug(&label))
        };
        push(
            make_window(
                &id,
                Some(label),
                cadence,
                pct,
                entry.get("resets_at"),
                None,
                as_of,
            ),
            &mut out,
        );
    }

    for entry in rl
        .get("model_scoped")
        .and_then(|l| l.as_array())
        .into_iter()
        .flatten()
    {
        let Some(name) = entry.get("display_name").and_then(|n| n.as_str()) else {
            continue;
        };
        let label = clean(name);
        let Some(pct) = finite(entry.get("utilization")) else {
            continue;
        };
        if label.is_empty() {
            continue;
        }
        let id = format!("seven_day:model:{}", slug(&label));
        push(
            make_window(
                &id,
                Some(label),
                Some(10080),
                pct,
                entry.get("resets_at"),
                None,
                as_of,
            ),
            &mut out,
        );
    }

    if let Some(obj) = rl.as_object() {
        for (key, v) in obj {
            if WINDOWS.iter().any(|(id, _)| id == key)
                || NON_WINDOW_KEYS.contains(&key.as_str())
                || !v.is_object()
            {
                continue;
            }
            // `seven_day_opus` & co. restate a model-scoped meter already added above.
            if let Some(suffix) = key.strip_prefix("seven_day_") {
                let tail = format!(":{}", slug(suffix));
                if out.iter().any(|w| w.window_id.ends_with(&tail)) {
                    continue;
                }
            }
            let cadence = key.starts_with("seven_day").then_some(10080);
            if let Some(w) = bucket_window(&slug(key), Some(pretty(key)), cadence, v, as_of) {
                push(w, &mut out);
            }
        }
    }
    out
}

/// `(tag, label)` of a limit's scope: model first, then surface. `None` = unscoped / unreadable.
fn scope_label(scope: Option<&serde_json::Value>) -> Option<(&'static str, String)> {
    let scope = scope?;
    let named = |v: Option<&serde_json::Value>| {
        let v = v?;
        let raw = v
            .as_str()
            .or_else(|| v.get("display_name").and_then(|n| n.as_str()))?;
        let c = clean(raw);
        (!c.is_empty()).then_some(c)
    };
    named(scope.get("model"))
        .map(|l| ("model", l))
        .or_else(|| named(scope.get("surface")).map(|l| ("surface", l)))
}

/// Strip control characters, collapse whitespace, cap length (vendor text is untrusted).
fn clean(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(MAX_LABEL).collect()
}

/// `iguana_necktie` → "Iguana necktie".
fn pretty(s: &str) -> String {
    let c = clean(&s.replace('_', " "));
    let mut chars = c.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Lowercase, non-alphanumeric runs → `_`, so the id never contains `/` or `:`.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().take(MAX_LABEL) {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
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
) -> Result<PathBuf, Box<LimitsResult>> {
    match crate::registry::resolve_binary(binary, path) {
        Some(p) => Ok(p),
        None => Err(Box::new(LimitsResult::failure(
            harness,
            LimitStatus::NotInstalled,
            format!("{binary} is not installed (not found on PATH)"),
            as_of,
            windows,
        ))),
    }
}

/// Normalise a vendor RFC3339 timestamp to the wire's millis-`Z` ISO-8601 form.
/// Falls back to the raw string when it does not parse.
pub(crate) fn normalize_iso(s: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(s) {
        Ok(dt) => crate::util::ms_to_iso_8601(dt.timestamp_millis()),
        Err(_) => s.to_string(),
    }
}

/// Spawns `claude`, bounded; never panics.
///
/// `env` is the account's env (Decision 9): the probe must read THAT account's
/// windows, so the vendor binary runs under its login directory.
pub async fn probe_claude_limits(env: BTreeMap<String, String>) -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, probe_claude_limits_inner(env)).await;
    match outcome {
        Ok(r) => r,
        Err(_) => placeholder_result(LimitStatus::Error, "timed out after 20s", &as_of),
    }
}

async fn probe_claude_limits_inner(env: BTreeMap<String, String>) -> LimitsResult {
    let as_of = crate::util::now_iso_8601();
    let path = match resolve_or_not_installed(
        HARNESS,
        HARNESS,
        &crate::context::effective_path(),
        &window_placeholders(),
        &as_of,
    ) {
        Ok(p) => p,
        Err(r) => return *r,
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

    let mut cmd = tokio::process::Command::new(&path);
    // Removals first: the account's own env (applied after) still wins.
    for name in probe_env_removals(&env) {
        cmd.env_remove(name);
    }
    let spawned = cmd
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
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
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

/// The env var that marks a named Claude config folder (set by `account_env`).
const CONFIG_DIR_ENV_VAR: &str = "CLAUDE_CONFIG_DIR";

/// Inherited token vars the probe removes. Only a named folder (its env sets
/// `CLAUDE_CONFIG_DIR`) loses them; the System login keeps its own environment.
fn probe_env_removals(env: &BTreeMap<String, String>) -> Vec<&'static str> {
    if env.contains_key(CONFIG_DIR_ENV_VAR) {
        crate::claude_accounts::ENV_TOKENS_TO_UNSET.to_vec()
    } else {
        Vec::new()
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

    #[test]
    fn probe_removes_token_env_when_config_dir_set() {
        let mut env = BTreeMap::new();
        assert!(probe_env_removals(&env).is_empty(), "System login: none");
        env.insert(CONFIG_DIR_ENV_VAR.to_string(), "/x".to_string());
        assert_eq!(
            probe_env_removals(&env),
            vec![
                "CLAUDE_CODE_OAUTH_TOKEN",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN"
            ]
        );
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

// ---------------------------------------------------------------------------
// Structured chat limit signal (`_claude/sdkMessage` rate_limit_event)
// ---------------------------------------------------------------------------

/// `_claude/sdkMessage` carrying `{type: "rate_limit_event"}` (Decision 10).
///
/// Not reachable in production today (V11): the adapter's raw-SDK filter matches
/// `{type, subtype}` pairs and the event has no subtype, so this only runs on
/// the hand-written fixtures. Tolerant: any shape mismatch is `None`.
#[must_use]
pub fn rate_limit_signal(method: &str, params: &Value) -> Option<LimitSignal> {
    if method != "_claude/sdkMessage" {
        return None;
    }
    let message = params.get("message")?.as_object()?;
    if message.get("type")?.as_str()? != "rate_limit_event" {
        return None;
    }
    let info = message.get("rate_limit_info")?.as_object()?;
    let (window_id, window) = pick_window(info.get("unifiedWindows")?)?;
    let utilization = window.get("utilization")?.as_f64()?;
    let rejected = window.get("status").and_then(Value::as_str) == Some("rejected");
    Some(LimitSignal {
        window_id,
        used_pct: (utilization * 100.0).clamp(0.0, 100.0),
        resets_at: window.get("resetsAt").and_then(resets_to_iso),
        rejected,
    })
}

/// The rejected window, else the full one, else the first (an object keyed by
/// window id, or an array carrying `windowId`/`window_id`/`type`).
fn pick_window(windows: &Value) -> Option<(String, &serde_json::Map<String, Value>)> {
    let mut candidates: Vec<(String, &serde_json::Map<String, Value>)> = Vec::new();
    match windows {
        Value::Object(map) => {
            for (id, value) in map {
                if let Some(obj) = value.as_object() {
                    if obj.contains_key("utilization") {
                        candidates.push((id.clone(), obj));
                    }
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                if !obj.contains_key("utilization") {
                    continue;
                }
                let id = ["windowId", "window_id", "type"]
                    .iter()
                    .find_map(|key| obj.get(*key).and_then(Value::as_str))
                    .map(str::to_string)?;
                candidates.push((id, obj));
            }
        }
        _ => return None,
    }
    let is_rejected = |w: &&(String, &serde_json::Map<String, Value>)| {
        w.1.get("status").and_then(Value::as_str) == Some("rejected")
    };
    let is_full = |w: &&(String, &serde_json::Map<String, Value>)| {
        w.1.get("utilization")
            .and_then(Value::as_f64)
            .is_some_and(|u| u >= 1.0)
    };
    let picked = candidates
        .iter()
        .find(is_rejected)
        .or_else(|| candidates.iter().find(is_full))
        .or_else(|| candidates.first())?;
    Some((picked.0.clone(), picked.1))
}

/// `resetsAt` as epoch seconds (number or numeric string) or an ISO8601 string.
fn resets_to_iso(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        if chrono::DateTime::parse_from_rfc3339(text).is_ok() {
            return Some(text.to_string());
        }
        let secs = text.parse::<i64>().ok()?;
        return Some(crate::util::ms_to_iso_8601(secs.saturating_mul(1000)));
    }
    let secs = value.as_i64()?;
    Some(crate::util::ms_to_iso_8601(secs.saturating_mul(1000)))
}

//! Claude Code account facts — this harness's account env names, login/identity
//! argv, shared entries and native hand-over (R1).
//!
//! Spike facts (`docs/MULTI-ACCOUNT.md`): V1 `CLAUDE_CONFIG_DIR` and
//! `claude auth login|status`; V2 `.claude.json` carries identity, so it is
//! never shared; V3 the account env reaches the ACP adapter's child by
//! inheritance; V11 the adapter does NOT forward `rate_limit_event`, so the
//! signal parser is fixture-only — production "limited" comes from the poller.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use vst_types::{
    AccountHandover, AccountIdentity, AccountLinkMeta, FileTransfer, HandoverArgs, LimitSignal,
    ResolvedAccount, SharedEntries, SharedSet, TransferMode,
};

/// Claude's own config dir env var (V1).
const CONFIG_DIR_ENV: &str = "CLAUDE_CONFIG_DIR";
/// Claude's API-key env var (read by both the TUI and the SDK).
const API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// Entry NAMES that mark a folder as a Claude config folder (never contents).
const LOOKS_VALID_NAMES: [&str; 4] = [".claude.json", "projects", "settings.json", "sessions"];

/// Env vars that would authenticate a named folder with the daemon's own login
/// (Decision 9). Removed by `env -u` wrapping on every launch path.
pub const ENV_TOKENS_TO_UNSET: [&str; 3] = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
];

/// `CLAUDE_CONFIG_DIR=<dir>` for a named account; empty for System (the daemon
/// env already is `~/.claude`).
#[must_use]
pub fn account_env(acct: &ResolvedAccount) -> BTreeMap<String, String> {
    crate::account_env::dir_env(CONFIG_DIR_ENV, acct)
}

/// The System login folder: `$CLAUDE_CONFIG_DIR` when absolute, else `~/.claude`.
fn system_config_dir() -> PathBuf {
    crate::home::env_dir_or(CONFIG_DIR_ENV, ".claude")
}

/// The add-folder copy for Claude: `~/.claude-work`-style example, its own
/// `~/.claude` as the system folder.
#[must_use]
pub fn account_link_meta() -> AccountLinkMeta {
    AccountLinkMeta {
        example_path: "~/.claude-work".to_string(),
        field_label: "Claude config folder".to_string(),
        field_note: None,
        system_dir: Some(system_config_dir()),
        verifies_identity: false,
        first_run_note: Some(
            "The first Terminal agent in a new Claude folder opens Claude's own first-run setup (theme, folder trust). Answer it once in the terminal. Rich Chat agents skip it."
                .to_string(),
        ),
    }
}

/// Whether `names` (a folder's direct entry names) contains a Claude config entry.
#[must_use]
pub fn account_folder_looks_valid(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| LOOKS_VALID_NAMES.contains(&name.as_str()))
}

/// The inherited token vars to unset for a named folder; none for the System
/// login. The account's own API key is set after the unset, so it is kept.
#[must_use]
pub fn account_env_unset(acct: &ResolvedAccount) -> Vec<&'static str> {
    if acct.dir.is_none() {
        return Vec::new();
    }
    ENV_TOKENS_TO_UNSET
        .into_iter()
        .filter(|name| !(*name == API_KEY_ENV && acct.api_key.is_some()))
        .collect()
}

/// The API-key method exists for claude.
#[must_use]
pub fn account_api_key_env() -> Option<&'static str> {
    Some(API_KEY_ENV)
}

/// `claude auth login` (V1).
#[must_use]
pub fn account_login_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec![
        "claude".to_string(),
        "auth".to_string(),
        "login".to_string(),
    ])
}

/// `claude auth status` — read-only, JSON by default (V1).
#[must_use]
pub fn account_identity_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec![
        "claude".to_string(),
        "auth".to_string(),
        "status".to_string(),
    ])
}

/// `{"loggedIn", "email", "subscriptionType"/"planTier"}`; anything else is
/// "unknown".
#[must_use]
pub fn parse_account_identity(stdout: &str, _exit_ok: bool) -> AccountIdentity {
    let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) else {
        return AccountIdentity::default();
    };
    let signed_in = value.get("loggedIn").and_then(Value::as_bool);
    let email = non_empty_str(&value, "email");
    let plan =
        non_empty_str(&value, "subscriptionType").or_else(|| non_empty_str(&value, "planTier"));
    AccountIdentity {
        signed_in,
        email,
        plan,
    }
}

/// `~/.claude` minus `.claude.json` (identity, V2).
#[must_use]
pub fn account_shared_entries() -> Option<SharedEntries> {
    Some(SharedEntries {
        source_dir: system_config_dir(),
        set: SharedSet::Named(vec![
            "skills",
            "settings.json",
            "agents",
            "commands",
            "CLAUDE.md",
        ]),
    })
}

/// `Files(Copy)` of `<from>/projects/<slug>/<chatId>.jsonl` into the same
/// `<slug>` directory of the target account folder (the JSONL `claude --resume`
/// replays). The source is FOUND by chat id, never by a re-derived slug; the
/// System login's folder is `~/.claude`.
#[must_use]
pub fn account_session_handover(args: &HandoverArgs<'_>) -> AccountHandover {
    let Some(chat_id) = args
        .session
        .agent_chat_id
        .as_deref()
        .or(args.session.acp_session_id.as_deref())
        .filter(|id| !id.is_empty())
    else {
        return AccountHandover::Unsupported;
    };
    let Some(from) = crate::claude_import::find_claude_conversation(
        &config_dir(args.from).join("projects"),
        chat_id,
    ) else {
        // Nothing to hand over: the planner downgrades to Transcript/Fresh.
        return AccountHandover::Unsupported;
    };
    let Some(slug_dir) = from.parent().and_then(|p| p.file_name()) else {
        return AccountHandover::Unsupported;
    };
    let to = config_dir(args.to)
        .join("projects")
        .join(slug_dir)
        .join(format!("{chat_id}.jsonl"));
    AccountHandover::Files(vec![FileTransfer {
        from,
        to,
        mode: TransferMode::Copy,
    }])
}

/// The account's Claude config folder: its own, or `~/.claude` for System.
fn config_dir(acct: &ResolvedAccount) -> PathBuf {
    acct.dir.clone().unwrap_or_else(system_config_dir)
}

/// `_claude/sdkMessage` carrying `{type: "rate_limit_event"}` (Decision 10).
/// Fixture-only in production (V11); the parser lives in `claude_limits.rs`.
#[must_use]
pub fn account_limit_signal(method: &str, params: &Value) -> Option<LimitSignal> {
    crate::claude_limits::rate_limit_signal(method, params)
}

fn non_empty_str(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

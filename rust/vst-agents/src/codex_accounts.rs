//! Codex account facts (R1). Spike facts (`docs/MULTI-ACCOUNT.md`):
//! V4 `CODEX_HOME` is honoured, `codex login` / `codex login status` exist and
//! the status line carries no email; V5 the pinned codex-acp port does NOT
//! forward `account/rateLimits/updated`, and only Terminal codex resumes by its
//! native rollout id — so a Rich Chat switch is transcript-only and codex's
//! "limited" state comes from the poller.

use std::collections::BTreeMap;
use std::path::Path;

use vst_types::{
    AccountHandover, AccountIdentity, AccountLinkMeta, Channel, FileTransfer, HandoverArgs,
    ResolvedAccount, SharedEntries, SharedSet, TransferMode,
};

use crate::codex_import::{codex_home_for, find_rollout, RolloutSearch};

/// Codex's own home dir env var (V4).
const CODEX_HOME_ENV: &str = "CODEX_HOME";
/// `OpenAI`'s API-key env var, read by codex's model client (V4).
const API_KEY_ENV: &str = "OPENAI_API_KEY";
/// Entry NAMES that mark a folder as a Codex home (never contents).
const LOOKS_VALID_NAMES: [&str; 4] = ["config.toml", "sessions", "auth.json", "history.jsonl"];

/// `CODEX_HOME=<dir>` for a named account; empty for the System login.
#[must_use]
pub fn account_env(acct: &ResolvedAccount) -> BTreeMap<String, String> {
    crate::account_env::dir_env(CODEX_HOME_ENV, acct)
}

/// The add-folder copy for Codex: `~/.codex-work`-style example, `~/.codex` as
/// the system folder.
#[must_use]
pub fn account_link_meta() -> AccountLinkMeta {
    AccountLinkMeta {
        example_path: "~/.codex-work".to_string(),
        field_label: "Codex home folder".to_string(),
        field_note: None,
        system_dir: Some(crate::home::home_dir().join(".codex")),
        verifies_identity: false,
        first_run_note: None,
    }
}

/// Whether `names` (a folder's direct entry names) contains a Codex home entry.
#[must_use]
pub fn account_folder_looks_valid(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| LOOKS_VALID_NAMES.contains(&name.as_str()))
}

/// The API-key method exists for codex.
#[must_use]
pub fn account_api_key_env() -> Option<&'static str> {
    Some(API_KEY_ENV)
}

/// `codex login` (V4).
#[must_use]
pub fn account_login_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec!["codex".to_string(), "login".to_string()])
}

/// `codex login status` — read-only, one line (V4).
#[must_use]
pub fn account_identity_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec![
        "codex".to_string(),
        "login".to_string(),
        "status".to_string(),
    ])
}

/// Text parse (V4): a line saying "Logged in" ⇒ signed in, "not logged in" ⇒
/// signed out. No email is available, so the display name falls back to the
/// label or the id.
#[must_use]
pub fn parse_account_identity(stdout: &str, exit_ok: bool) -> AccountIdentity {
    let lower = stdout.to_lowercase();
    let signed_in = if lower.contains("not logged in") || lower.contains("logged out") {
        Some(false)
    } else if exit_ok && lower.contains("logged in") {
        Some(true)
    } else {
        None
    };
    AccountIdentity {
        signed_in,
        email: None,
        plan: None,
    }
}

/// `~/.codex`'s portable entries (never `auth.json`).
#[must_use]
pub fn account_shared_entries() -> Option<SharedEntries> {
    Some(SharedEntries {
        source_dir: codex_home_for(None),
        set: SharedSet::Named(vec!["skills", "config.toml", "AGENTS.md"]),
    })
}

/// `Files(HardLink)` of the rollout found under `<from>/sessions` into the same
/// relative path under `<to>/sessions` (V5).
///
/// V5 fallback: the ACP session id is not proven to load a rollout from another
/// `CODEX_HOME`, so a Rich Chat session returns `Unsupported` (⇒ Transcript).
/// Terminal codex resumes by `codex resume <id>`, which reads the rollout, so
/// the file hand-over is native there.
#[must_use]
pub fn account_session_handover(args: &HandoverArgs<'_>) -> AccountHandover {
    if args.session.channel == Some(Channel::Json) {
        return AccountHandover::Unsupported;
    }
    let Some(chat_id) = args
        .session
        .agent_chat_id
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return AccountHandover::Unsupported;
    };
    let Some(to_dir) = args.to.dir.as_ref() else {
        return AccountHandover::Unsupported;
    };
    let from_root = sessions_root(args.from.dir.as_deref());
    let RolloutSearch::Found(from) = find_rollout(&from_root, chat_id) else {
        // Missing (or unproven) rollout: nothing to hand over.
        return AccountHandover::Unsupported;
    };
    let Ok(relative) = from.strip_prefix(&from_root) else {
        // Found in the sibling `archived_sessions`: not a path we can mirror.
        return AccountHandover::Unsupported;
    };
    let to = sessions_root(Some(to_dir)).join(relative);
    AccountHandover::Files(vec![FileTransfer {
        from,
        to,
        mode: TransferMode::HardLink,
    }])
}

/// `<codex home>/sessions`, preferring an account folder when given.
fn sessions_root(account_dir: Option<&Path>) -> std::path::PathBuf {
    codex_home_for(account_dir).join("sessions")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_parses_v4_lines() {
        assert_eq!(
            parse_account_identity("Logged in using ChatGPT", true).signed_in,
            Some(true)
        );
        assert_eq!(
            parse_account_identity("Not logged in", true).signed_in,
            Some(false)
        );
        assert_eq!(parse_account_identity("", true).signed_in, None);
        assert_eq!(
            parse_account_identity("Not logged in", false).signed_in,
            Some(false),
            "not logged in exits non-zero"
        );
        assert_eq!(
            parse_account_identity("Logged in using ChatGPT", false),
            AccountIdentity::default(),
            "a failed command never proves a login"
        );
    }
}

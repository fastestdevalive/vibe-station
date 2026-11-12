//! Cursor account facts (R1).
//!
//! UNVERIFIED (`docs/MULTI-ACCOUNT.md` V6): `cursor-agent` is not installed on
//! this machine, so the login/identity argv and the `status` output shape are
//! written from the vendor's documented CLI and parsed tolerantly. Re-check
//! once a binary is available.
//!
//! A private `XDG_CONFIG_HOME` would hide `~/.config/gh`, `~/.config/git`, ...
//! from the agent's own tools, so every other `~/.config` entry is symlinked
//! into the account folder and only `cursor` stays private (V6).

use std::collections::BTreeMap;

use vst_types::{
    AccountHandover, AccountIdentity, AccountLinkMeta, HandoverArgs, ResolvedAccount,
    SharedEntries, SharedSet,
};

/// The dir env var cursor honours for its own config (V6, unverified).
const CONFIG_DIR_ENV: &str = "XDG_CONFIG_HOME";
/// Cursor's API-key env var.
const API_KEY_ENV: &str = "CURSOR_API_KEY";
/// The one `~/.config` entry that must stay private to the account.
const PRIVATE_CONFIG_ENTRY: &str = "cursor";
/// Entry NAMES that mark a folder as a cursor config root (never contents).
const LOOKS_VALID_NAMES: [&str; 1] = ["cursor"];
/// Helper text for an XDG-root folder field (shared copy with opencode).
const XDG_NOTE: &str = "This is an XDG root: tools such as gh and git read their config from it, so a new folder hides that from the agent.";

/// `XDG_CONFIG_HOME=<account dir>` for a named account; empty for System.
#[must_use]
pub fn account_env(acct: &ResolvedAccount) -> BTreeMap<String, String> {
    crate::account_env::dir_env(CONFIG_DIR_ENV, acct)
}

/// The System config root: `$XDG_CONFIG_HOME` when absolute, else `~/.config`.
fn system_config_dir() -> std::path::PathBuf {
    crate::home::env_dir_or(CONFIG_DIR_ENV, ".config")
}

/// The add-folder copy for cursor: an XDG root, `~/.config` as the system folder.
#[must_use]
pub fn account_link_meta() -> AccountLinkMeta {
    AccountLinkMeta {
        example_path: "~/cursor-work-config".to_string(),
        field_label: "XDG root folder".to_string(),
        field_note: Some(XDG_NOTE.to_string()),
        system_dir: Some(system_config_dir()),
        verifies_identity: false,
        first_run_note: None,
    }
}

/// Whether `names` (a folder's direct entry names) contains a cursor config entry.
#[must_use]
pub fn account_folder_looks_valid(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| LOOKS_VALID_NAMES.contains(&name.as_str()))
}

/// The API-key method exists for cursor.
#[must_use]
pub fn account_api_key_env() -> Option<&'static str> {
    Some(API_KEY_ENV)
}

/// `cursor-agent login` (V6, unverified).
#[must_use]
pub fn account_login_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec!["cursor-agent".to_string(), "login".to_string()])
}

/// `cursor-agent status` (V6, unverified).
#[must_use]
pub fn account_identity_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec!["cursor-agent".to_string(), "status".to_string()])
}

/// Tolerant text parse: "not logged in"/"signed out" ⇒ signed out, "logged in"
/// ⇒ signed in, an e-mail-looking token becomes the email; anything else is
/// "unknown".
#[must_use]
pub fn parse_account_identity(stdout: &str, exit_ok: bool) -> AccountIdentity {
    let lower = stdout.to_lowercase();
    let signed_in = if lower.contains("not logged in")
        || lower.contains("logged out")
        || lower.contains("signed out")
    {
        Some(false)
    } else if exit_ok && (lower.contains("logged in") || lower.contains("signed in")) {
        Some(true)
    } else {
        None
    };
    let email = if exit_ok {
        stdout
            .split_whitespace()
            .map(|t| t.trim_matches(|c: char| !c.is_ascii_graphic()))
            .find(|t| is_email(t))
            .map(str::to_string)
    } else {
        None
    };
    AccountIdentity {
        signed_in,
        email,
        plan: None,
    }
}

fn is_email(token: &str) -> bool {
    let Some((local, domain)) = token.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
}

/// `~/.config` minus `cursor`: the agent's tools keep their own configs.
#[must_use]
pub fn account_shared_entries() -> Option<SharedEntries> {
    Some(SharedEntries {
        source_dir: system_config_dir(),
        set: SharedSet::AllExcept(vec![PRIVATE_CONFIG_ENTRY]),
    })
}

/// No bridge from an ACP session to cursor's own resume flag (V6): transcript.
#[must_use]
pub fn account_session_handover(_args: &HandoverArgs<'_>) -> AccountHandover {
    AccountHandover::Unsupported
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_tolerant() {
        assert_eq!(
            parse_account_identity("Logged in as a@b.dev", true)
                .email
                .as_deref(),
            Some("a@b.dev")
        );
        assert_eq!(
            parse_account_identity("Not logged in", true).signed_in,
            Some(false)
        );
        assert_eq!(parse_account_identity("whatever", true).signed_in, None);
        assert_eq!(
            parse_account_identity("Not logged in", false).signed_in,
            Some(false)
        );
        assert_eq!(
            parse_account_identity("Logged in as a@b.dev", false),
            AccountIdentity::default()
        );
    }
}

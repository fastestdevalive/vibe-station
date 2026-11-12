//! opencode account facts (R1).
//!
//! Spike facts (`docs/MULTI-ACCOUNT.md`): V7 opencode resolves its auth as
//! `$XDG_DATA_HOME/opencode/auth.json`, and `opencode auth` offers `login` /
//! `logout` / `list` / `switch` (never `export`/`import` — `export` prints
//! secrets). No API-key env var was found, so this CLI has no API-key method.
//! V8 the native store is ONE sqlite file holding every session, so copying it
//! would mix histories: an account switch is transcript-only.

use std::collections::BTreeMap;

use vst_types::{
    AccountHandover, AccountIdentity, AccountLinkMeta, HandoverArgs, ResolvedAccount,
    SharedEntries, SharedSet,
};

/// The dir env var opencode resolves its auth under (V7).
const DATA_DIR_ENV: &str = "XDG_DATA_HOME";
/// Entry NAMES that mark a folder as an opencode data root (never contents).
const LOOKS_VALID_NAMES: [&str; 1] = ["opencode"];
/// Helper text for an XDG-root folder field (shared copy with cursor).
const XDG_NOTE: &str = "This is an XDG root: tools such as gh and git read their config from it, so a new folder hides that from the agent.";

/// `XDG_DATA_HOME=<account dir>` for a named account; empty for System.
#[must_use]
pub fn account_env(acct: &ResolvedAccount) -> BTreeMap<String, String> {
    crate::account_env::dir_env(DATA_DIR_ENV, acct)
}

/// The System data root: `$XDG_DATA_HOME` when absolute, else `~/.local/share`.
fn system_data_dir() -> std::path::PathBuf {
    crate::home::env_dir_or(DATA_DIR_ENV, ".local/share")
}

/// The add-folder copy for opencode: an XDG root, `~/.local/share` as the system
/// folder.
#[must_use]
pub fn account_link_meta() -> AccountLinkMeta {
    AccountLinkMeta {
        example_path: "~/opencode-work-data".to_string(),
        field_label: "XDG root folder".to_string(),
        field_note: Some(XDG_NOTE.to_string()),
        system_dir: Some(system_data_dir()),
        verifies_identity: false,
        first_run_note: None,
    }
}

/// Whether `names` (a folder's direct entry names) contains an opencode data entry.
#[must_use]
pub fn account_folder_looks_valid(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| LOOKS_VALID_NAMES.contains(&name.as_str()))
}

/// No API-key method was found for opencode (V7).
#[must_use]
pub fn account_api_key_env() -> Option<&'static str> {
    None
}

/// `opencode auth login` (V7).
#[must_use]
pub fn account_login_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec![
        "opencode".to_string(),
        "auth".to_string(),
        "login".to_string(),
    ])
}

/// `opencode auth list` — names only, never `auth export` (V7).
#[must_use]
pub fn account_identity_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec![
        "opencode".to_string(),
        "auth".to_string(),
        "list".to_string(),
    ])
}

/// Tolerant: `opencode auth list` ends with an `N credentials` footer; `N > 0`
/// ⇒ signed in, `0` ⇒ signed out, no such line ⇒ unknown. No email/plan is
/// available, so the display name falls back to label/id.
#[must_use]
pub fn parse_account_identity(stdout: &str, exit_ok: bool) -> AccountIdentity {
    if !exit_ok {
        return AccountIdentity::default();
    }
    AccountIdentity {
        signed_in: credential_count(stdout).map(|n| n > 0),
        email: None,
        plan: None,
    }
}

/// The `<integer>` of a line whose words end `<integer> credential(s)`.
fn credential_count(stdout: &str) -> Option<u64> {
    stdout.lines().find_map(|line| {
        let words: Vec<&str> = line
            .split_whitespace()
            .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
            .filter(|w| !w.is_empty())
            .collect();
        let [.., count, noun] = words.as_slice() else {
            return None;
        };
        matches!(*noun, "credential" | "credentials")
            .then(|| count.parse().ok())
            .flatten()
    })
}

/// `XDG_DATA_HOME` is redirected, so every other tool's `~/.local/share/*`
/// entry is linked into the account folder; only `opencode/` (auth + store)
/// stays private. The config dir (`XDG_CONFIG_HOME`) is untouched.
#[must_use]
pub fn account_shared_entries() -> Option<SharedEntries> {
    Some(SharedEntries {
        source_dir: system_data_dir(),
        set: SharedSet::AllExcept(vec!["opencode"]),
    })
}

/// One sqlite store holds every conversation (V8): no per-session file exists
/// to copy, so the switch is transcript-only.
#[must_use]
pub fn account_session_handover(_args: &HandoverArgs<'_>) -> AccountHandover {
    AccountHandover::Unsupported
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_uses_the_provider_list() {
        let with = "┌  Credentials ~/x/auth.json\n│\n●  Anthropic oauth\n│\n└  1 credentials\n";
        let none = "┌  Credentials ~/x/auth.json\n│\n└  0 credentials\n";
        assert_eq!(parse_account_identity(with, true).signed_in, Some(true));
        assert_eq!(parse_account_identity(none, true).signed_in, Some(false));
        assert_eq!(parse_account_identity("anthropic\n", true).signed_in, None);
        assert_eq!(
            parse_account_identity("anthropic", false),
            AccountIdentity::default()
        );
    }
}

//! omp account facts (R1). Spike fact V10: `PI_CODING_AGENT_DIR` is omp's
//! agent dir, and its per-vst session store lives under the WORKTREE
//! (`<cwd>/.vibe-station/omp-sessions/<id>`), so it is account-independent —
//! an account switch keeps the conversation in place (`InPlace`).

use std::collections::BTreeMap;

use vst_types::{
    AccountHandover, AccountIdentity, AccountLinkMeta, HandoverArgs, ResolvedAccount,
    SharedEntries, SharedSet,
};

/// omp's agent dir env var (V10).
const AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
/// Entry NAMES that mark a folder as an omp agent dir (never contents).
const LOOKS_VALID_NAMES: [&str; 4] = ["sessions", "skills", "config", "settings.json"];

/// `PI_CODING_AGENT_DIR=<account dir>` for a named account; empty for System.
#[must_use]
pub fn account_env(acct: &ResolvedAccount) -> BTreeMap<String, String> {
    crate::account_env::dir_env(AGENT_DIR_ENV, acct)
}

/// The add-folder copy for omp: `~/.omp-work`-style example, `~/.omp/agent` as
/// the system folder.
#[must_use]
pub fn account_link_meta() -> AccountLinkMeta {
    AccountLinkMeta {
        example_path: "~/.omp-work".to_string(),
        field_label: "Agent folder".to_string(),
        field_note: None,
        system_dir: Some(crate::home::home_dir().join(".omp/agent")),
        verifies_identity: false,
        first_run_note: None,
    }
}

/// Whether `names` (a folder's direct entry names) contains an omp agent entry.
#[must_use]
pub fn account_folder_looks_valid(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| LOOKS_VALID_NAMES.contains(&name.as_str()))
}

/// omp is signed in through its own UI: the user finishes the login there.
#[must_use]
pub fn account_sign_in_hint() -> Option<&'static str> {
    Some("Run the command, then use /login inside.")
}

/// omp has no API-key method of its own (in-CLI provider login).
#[must_use]
pub fn account_api_key_env() -> Option<&'static str> {
    None
}

/// `omp` — the in-CLI sign-in (V10).
#[must_use]
pub fn account_login_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec!["omp".to_string()])
}

/// omp reports its sign-in through the CLI's own UI, not a status command, so
/// `auth` stays `unknown` and the display name falls back to label/id.
#[must_use]
pub fn account_identity_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    None
}

/// The account's answer is "unknown": there is nothing to parse.
#[must_use]
pub fn parse_account_identity(_stdout: &str, _exit_ok: bool) -> AccountIdentity {
    AccountIdentity::default()
}

/// `~/.omp/agent`'s portable entries.
#[must_use]
pub fn account_shared_entries() -> Option<SharedEntries> {
    Some(SharedEntries {
        source_dir: crate::home::home_dir().join(".omp").join("agent"),
        set: SharedSet::Named(vec!["skills", "config"]),
    })
}

/// The conversation store lives under the worktree (V10), so a switch needs no
/// file: the replacement session resumes the same private store.
#[must_use]
pub fn account_session_handover(_args: &HandoverArgs<'_>) -> AccountHandover {
    AccountHandover::InPlace
}

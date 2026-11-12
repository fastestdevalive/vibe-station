//! pi account facts (R1). Spike fact V10: `PI_CODING_AGENT_DIR` is pi's agent
//! dir and its conversations are `<ts>_<id>.jsonl` files under
//! `<agent dir>/sessions`, so an account switch can copy this session's own
//! file (`Files(Copy)`), matched by the `_<id>.jsonl` suffix.

use std::collections::BTreeMap;
use std::path::Path;

use vst_types::{
    AccountHandover, AccountIdentity, AccountLinkMeta, FileTransfer, HandoverArgs, ResolvedAccount,
    SharedEntries, SharedSet, TransferMode,
};

/// pi's agent dir env var (V10).
const AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
/// Entry NAMES that mark a folder as a pi agent dir (never contents).
const LOOKS_VALID_NAMES: [&str; 4] = ["sessions", "skills", "config", "settings.json"];

/// `PI_CODING_AGENT_DIR=<account dir>` for a named account; empty for System.
#[must_use]
pub fn account_env(acct: &ResolvedAccount) -> BTreeMap<String, String> {
    crate::account_env::dir_env(AGENT_DIR_ENV, acct)
}

/// The add-folder copy for pi: `~/.pi-work`-style example, `~/.pi/agent` as the
/// system folder.
#[must_use]
pub fn account_link_meta() -> AccountLinkMeta {
    AccountLinkMeta {
        example_path: "~/.pi-work".to_string(),
        field_label: "Agent folder".to_string(),
        field_note: None,
        system_dir: Some(crate::home::home_dir().join(".pi/agent")),
        verifies_identity: false,
        first_run_note: None,
    }
}

/// Whether `names` (a folder's direct entry names) contains a pi agent entry.
#[must_use]
pub fn account_folder_looks_valid(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| LOOKS_VALID_NAMES.contains(&name.as_str()))
}

/// pi is signed in through its own UI: the user finishes the login there.
#[must_use]
pub fn account_sign_in_hint() -> Option<&'static str> {
    Some("Run the command, then use /login inside.")
}

/// pi has no API-key method of its own (in-CLI provider login).
#[must_use]
pub fn account_api_key_env() -> Option<&'static str> {
    None
}

/// `pi` — the in-CLI sign-in (V10).
#[must_use]
pub fn account_login_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    Some(vec!["pi".to_string()])
}

/// pi reports its sign-in through the CLI's own UI, so `auth` stays `unknown`.
#[must_use]
pub fn account_identity_command(_acct: &ResolvedAccount) -> Option<Vec<String>> {
    None
}

/// The account's answer is "unknown": there is nothing to parse.
#[must_use]
pub fn parse_account_identity(_stdout: &str, _exit_ok: bool) -> AccountIdentity {
    AccountIdentity::default()
}

/// `~/.pi/agent`'s portable entries.
#[must_use]
pub fn account_shared_entries() -> Option<SharedEntries> {
    Some(SharedEntries {
        source_dir: crate::home::home_dir().join(".pi").join("agent"),
        set: SharedSet::Named(vec!["skills", "config"]),
    })
}

/// `Files(Copy)` of the `<ts>_<id>.jsonl` found under `<from>/sessions` into
/// `<to>/sessions` (V10). pi finds its session files by suffix under the whole
/// sessions root, so a top-level copy is loadable.
#[must_use]
pub fn account_session_handover(args: &HandoverArgs<'_>) -> AccountHandover {
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
    let Some(from) = crate::pi::find_pi_session_file(&from_root, chat_id) else {
        return AccountHandover::Unsupported;
    };
    let Some(name) = from.file_name().map(std::borrow::ToOwned::to_owned) else {
        return AccountHandover::Unsupported;
    };
    AccountHandover::Files(vec![FileTransfer {
        from,
        to: sessions_root(Some(to_dir)).join(name),
        mode: TransferMode::Copy,
    }])
}

/// `<agent dir>/sessions`, preferring an account folder when given.
fn sessions_root(account_dir: Option<&Path>) -> std::path::PathBuf {
    match account_dir {
        Some(dir) => dir.join("sessions"),
        None => crate::pi::pi_sessions_root(None),
    }
}

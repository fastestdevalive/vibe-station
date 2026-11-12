//! Default account resolution (Decision 11): explicit > parent > CLI default >
//! System login. Pure over a small [`AccountView`] so it is trivially testable
//! and CLI-agnostic (R2).
//!
//! The caller validates the result before spawning (exists, same CLI, not
//! pending, not signed out); this function only picks.

/// What `select_account` needs to know about the registry.
pub trait AccountView {
    /// Whether `account_id` exists for `cli`.
    fn exists(&self, cli: &str, account_id: &str) -> bool;
    /// The id of the account whose label matches `label` (case-insensitive).
    fn id_for_label(&self, cli: &str, label: &str) -> Option<String>;
    /// The CLI's configured default (`None` = System login).
    fn default_for(&self, cli: &str) -> Option<String>;
}

/// Why selection failed: an explicit pick that does not exist must be an error
/// (never a silent fallback to the default — R7).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SelectError {
    #[error("account not found")]
    UnknownExplicit,
}

/// Pick the account for a new session of `cli`.
///
/// * `explicit` — the id, label or `"system"` the caller asked for.
/// * `parent` — the parent session's `(cli, account id)`, ignored when its CLI
///   differs (a subagent cannot inherit an account of another harness).
///
/// # Errors
///
/// [`SelectError::UnknownExplicit`] when the explicit pick matches no account id
/// or label (never a silent fallback to the default).
pub fn select_account(
    view: &dyn AccountView,
    cli: &str,
    explicit: Option<&str>,
    parent: Option<(&str, &str)>,
) -> Result<Option<String>, SelectError> {
    if let Some(pick) = explicit.map(str::trim).filter(|p| !p.is_empty()) {
        if pick == vst_types::SYSTEM_ACCOUNT_ID {
            return Ok(None);
        }
        if view.exists(cli, pick) {
            return Ok(Some(pick.to_string()));
        }
        if let Some(id) = view.id_for_label(cli, pick) {
            return Ok(Some(id));
        }
        return Err(SelectError::UnknownExplicit);
    }
    if let Some((parent_cli, parent_id)) = parent {
        if parent_cli == cli && view.exists(cli, parent_id) {
            return Ok(Some(parent_id.to_string()));
        }
    }
    Ok(view.default_for(cli))
}

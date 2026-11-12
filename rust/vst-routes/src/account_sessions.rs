//! Account rules for session creation and sign-out (multi-account plan
//! A3.7a/A3.9, Decisions 11/12).
//!
//! One owner for "which account does this session run under" on the CREATE side
//! ([`new_session_account`], the `select_account` precedence + spawn-time
//! validation) and for the only effect of a sign-out
//! ([`SessionRoutes::halt_sessions_for_account`]: release the runtimes, never
//! write lifecycle — AGENTS.md "Status indicators" has one lifecycle writer),
//! plus the read-only usage twin. The switch planner lives in
//! `account_sessions/switch.rs`, its hand-over table in `account_sessions/handover.rs`.
//!
//! Harness separation (R1/R2): every CLI-specific fact comes from the plugin;
//! this module never names a harness.

use vst_accounts::{select_account, usage_remove_plan, AccountView, AccountsHandle, UsageRow};
use vst_types::{
    AccountPort, AccountResolveError, AccountUsage, LifecycleState, SessionRecord, SessionType,
    SYSTEM_ACCOUNT_ID,
};

use crate::modes::{find_mode, load_modes};
use crate::sessions::SessionRoutes;

mod handover;
mod launch_env;
mod switch;

pub(crate) use launch_env::{account_launch_env, account_unset_argv, tmux_key_safe_launch};

/// A typed account refusal. The route layer maps it to exactly one HTTP status
/// (`code()` / `status()`), so a caller never string-matches a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountProblem {
    /// An EXPLICIT pick that matches no account: 404 `account_not_found`.
    NotFound,
    /// An id stored on a session (or inherited) that no longer exists:
    /// 409 `account_removed` — never a silent System fallback.
    Removed(String),
    /// 409 `account_signed_out` (R7: never retry under another account).
    SignedOut(String),
    /// 409 `account_pending`.
    Pending(String),
    /// The pick belongs to another CLI: 400 `account_cli_mismatch`.
    CliMismatch(String),
}

impl AccountProblem {
    /// The wire `code` of this refusal.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            AccountProblem::NotFound => "account_not_found",
            AccountProblem::Removed(_) => "account_removed",
            AccountProblem::SignedOut(_) => "account_signed_out",
            AccountProblem::Pending(_) => "account_pending",
            AccountProblem::CliMismatch(_) => "account_cli_mismatch",
        }
    }

    /// The HTTP status of this refusal.
    #[must_use]
    pub fn status(&self) -> u16 {
        match self {
            AccountProblem::NotFound => 404,
            AccountProblem::Removed(_)
            | AccountProblem::SignedOut(_)
            | AccountProblem::Pending(_) => 409,
            AccountProblem::CliMismatch(_) => 400,
        }
    }

    /// The account id carried as the extra `accountId` field (only the 409s).
    #[must_use]
    pub fn account_id(&self) -> Option<&str> {
        match self {
            AccountProblem::NotFound | AccountProblem::CliMismatch(_) => None,
            AccountProblem::Removed(id)
            | AccountProblem::SignedOut(id)
            | AccountProblem::Pending(id) => Some(id),
        }
    }

    /// A human message for the envelope's `error` field.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            AccountProblem::NotFound => "The chosen account does not exist.".to_string(),
            AccountProblem::Removed(_) => {
                "This session's account was removed. Pick another account.".to_string()
            }
            AccountProblem::SignedOut(_) => {
                "This account is signed out. Sign in from Settings, then try again.".to_string()
            }
            AccountProblem::Pending(_) => {
                "This account is waiting for sign-in. Finish signing in first.".to_string()
            }
            AccountProblem::CliMismatch(_) => {
                "That account belongs to a different CLI.".to_string()
            }
        }
    }
}

impl std::fmt::Display for AccountProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// The registry as [`select_account`] needs it, over `AccountsHandle`'s public
/// lookups (`locate` ignores auth/pending, which is exactly what selection
/// needs; validation happens afterwards).
pub(crate) struct HandleView<'a>(pub(crate) &'a AccountsHandle);

impl AccountView for HandleView<'_> {
    fn exists(&self, cli: &str, account_id: &str) -> bool {
        self.0.locate(cli, Some(account_id)).is_some()
    }

    fn id_for_label(&self, cli: &str, label: &str) -> Option<String> {
        self.0
            .list()
            .into_iter()
            .find(|a| {
                a.cli == cli
                    && a.id != SYSTEM_ACCOUNT_ID
                    && a.label
                        .as_deref()
                        .is_some_and(|l| l.eq_ignore_ascii_case(label.trim()))
            })
            .map(|a| a.id)
    }

    fn default_for(&self, cli: &str) -> Option<String> {
        self.0.default_for(cli)
    }
}

/// The CLI an account id belongs to, across every CLI the registry lists.
pub(crate) fn account_cli_of(accounts: &AccountsHandle, account_id: &str) -> Option<String> {
    accounts
        .list()
        .into_iter()
        .find(|a| a.id == account_id && a.id != SYSTEM_ACCOUNT_ID)
        .map(|a| a.cli)
}

/// Resolve the account a NEW session of `cli` runs under (Decision 11):
/// explicit pick > parent session (same CLI only) > CLI default > System.
///
/// `accounts == None` (tests / no registry wired) means every session is the
/// System login. The result is validated against the spawn-time rules, so a
/// signed-out default is a typed error here instead of a failed spawn later.
///
/// # Errors
///
/// [`AccountProblem`]: `NotFound` for an explicit pick that matches no account,
/// `CliMismatch` for another CLI's id, `SignedOut` / `Pending` / `Removed` for
/// the selected account.
pub fn new_session_account(
    accounts: Option<&AccountsHandle>,
    cli: &str,
    explicit: Option<&str>,
    parent: Option<&SessionRecord>,
) -> Result<Option<String>, AccountProblem> {
    let Some(accounts) = accounts else {
        return Ok(None);
    };
    let raw = explicit.map(str::trim).filter(|s| !s.is_empty());
    if let Some(pick) = raw.filter(|p| *p != SYSTEM_ACCOUNT_ID) {
        if let Some(other) = account_cli_of(accounts, pick) {
            if other != cli {
                return Err(AccountProblem::CliMismatch(pick.to_string()));
            }
        }
    }
    let parent_pair = parent.and_then(|p| {
        let parent_cli = p
            .mode_id
            .as_deref()
            .and_then(find_mode)
            .map(|m| m.cli.as_str().to_string())?;
        Some((parent_cli, p.account_id.clone()?))
    });
    let selected = select_account(
        &HandleView(accounts),
        cli,
        raw,
        parent_pair
            .as_ref()
            .map(|(c, id)| (c.as_str(), id.as_str())),
    )
    .map_err(|_| AccountProblem::NotFound)?;
    validate_selected(accounts, cli, selected, raw.is_some())
}

/// Map a spawn-time lookup failure for an account id STORED on a session to its
/// HTTP meaning: `NotFound` ⇒ 409 `account_removed` (never 404 — the caller did
/// not pick the id; Decision 11 / Risk 6).
#[must_use]
pub fn stored_account_problem(
    error: AccountResolveError,
    account_id: Option<&str>,
) -> AccountProblem {
    let id = account_id.unwrap_or_default().to_string();
    match error {
        AccountResolveError::NotFound => AccountProblem::Removed(id),
        AccountResolveError::SignedOut => AccountProblem::SignedOut(id),
        AccountResolveError::Pending => AccountProblem::Pending(id),
    }
}

/// Validate the selected account against the spawn-time rules (R7).
pub(crate) fn validate_selected(
    accounts: &AccountsHandle,
    cli: &str,
    selected: Option<String>,
    explicit: bool,
) -> Result<Option<String>, AccountProblem> {
    let Some(id) = selected else {
        return Ok(None);
    };
    match accounts.resolve(cli, Some(&id)) {
        Ok(_) => Ok(Some(id)),
        Err(AccountResolveError::SignedOut) => Err(AccountProblem::SignedOut(id)),
        Err(AccountResolveError::Pending) => Err(AccountProblem::Pending(id)),
        // A vanished id: the caller PICKED it ⇒ 404; a stored/inherited one
        // ⇒ 409 `account_removed` (Risk 6).
        Err(AccountResolveError::NotFound) => Err(if explicit {
            AccountProblem::NotFound
        } else {
            AccountProblem::Removed(id)
        }),
    }
}

/// One session row of an account (`running` = a removal would stop it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountSessionRow {
    /// The session id.
    pub id: String,
    /// Its display name, when it has one.
    pub name: Option<String>,
    /// `true` while the session is live: not archived, not exited, not done.
    pub running: bool,
}

impl SessionRoutes {
    /// Every agent session of `cli` under `account_id` (`None` = System).
    async fn agent_sessions_on(&self, cli: &str, account_id: Option<&str>) -> Vec<SessionRecord> {
        let modes = load_modes();
        let cli_of = |s: &SessionRecord| {
            s.mode_id
                .as_deref()
                .and_then(|id| modes.iter().find(|m| m.id == id))
                .map(|m| m.cli.as_str().to_string())
        };
        let mut found = Vec::new();
        for project in self.store.get_all_projects().await {
            let sessions = project
                .worktrees
                .iter()
                .flat_map(|w| w.sessions.iter())
                .chain(project.direct_sessions.iter());
            for s in sessions {
                if s.r#type == SessionType::Agent
                    && s.account_id.as_deref() == account_id
                    && cli_of(s).as_deref() == Some(cli)
                {
                    found.push(s.clone());
                }
            }
        }
        found
    }

    /// Release the runtime of every live agent session of this account. Writes
    /// NO lifecycle — the 1 s poller owns that axis (Decision 12).
    pub async fn halt_sessions_for_account(&self, cli: &str, account_id: &str) -> Vec<String> {
        let affected: Vec<SessionRecord> = self
            .agent_sessions_on(cli, Some(account_id))
            .await
            .into_iter()
            .filter(|s| s.archived_at.is_none())
            .collect();
        for session in &affected {
            self.release_session_runtime(session, false).await;
        }
        affected.into_iter().map(|s| s.id).collect()
    }

    /// Every session of `cli` running under `account_id` (`None` = System).
    pub async fn sessions_for_account(
        &self,
        cli: &str,
        account_id: Option<&str>,
    ) -> Vec<AccountSessionRow> {
        self.agent_sessions_on(cli, account_id)
            .await
            .into_iter()
            // A superseded session is the archived half of an account switch:
            // the user cannot see it, and its chain head is counted instead.
            .filter(|s| s.superseded_by.is_none())
            .map(|s| AccountSessionRow {
                running: s.archived_at.is_none()
                    && !matches!(
                        s.lifecycle.state,
                        LifecycleState::Exited | LifecycleState::Done
                    ),
                id: s.id,
                name: s.name,
            })
            .collect()
    }

    /// `GET /accounts/:cli/:id/usage` plus the ids a removal would stop.
    pub async fn usage_for_account(
        &self,
        cli: &str,
        account_id: Option<&str>,
    ) -> (AccountUsage, Vec<String>) {
        let rows = self.sessions_for_account(cli, account_id).await;
        let refs: Vec<UsageRow<'_>> = rows
            .iter()
            .map(|r| UsageRow {
                session_id: &r.id,
                name: r.name.as_deref(),
                cli,
                account_id,
                running: r.running,
            })
            .collect();
        usage_remove_plan(&refs, cli, account_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_account_problem_never_404s() {
        assert_eq!(
            stored_account_problem(AccountResolveError::NotFound, Some("acc_gone")),
            AccountProblem::Removed("acc_gone".to_string())
        );
        assert_eq!(
            stored_account_problem(AccountResolveError::SignedOut, Some("acc_1")),
            AccountProblem::SignedOut("acc_1".to_string())
        );
        assert_eq!(
            stored_account_problem(AccountResolveError::Pending, Some("acc_1")),
            AccountProblem::Pending("acc_1".to_string())
        );
        assert_eq!(AccountProblem::NotFound.status(), 404);
        assert_eq!(AccountProblem::Removed("x".into()).status(), 409);
        assert_eq!(AccountProblem::CliMismatch("x".into()).status(), 400);
    }
}

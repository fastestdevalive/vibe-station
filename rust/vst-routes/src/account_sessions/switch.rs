//! The account-switch planner (multi-account plan A3.8, Decision 7).
//!
//! `reset_session` asks this for the replacement's account, hand-over, carry and
//! break marker. The pure table is in `handover.rs`; selection rules are
//! in `account_sessions.rs`.

use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use vst_accounts::{select_account, AccountsHandle};
use vst_agents::plugin::CaptureArgs;
use vst_agents::resolve_plugin;
use vst_git::paths::Paths;
use vst_lifecycle::channel::session_channel;
use vst_types::rest::modes::AccountSwitchSupport;
use vst_types::rest::sessions::ResetBody;
use vst_types::{
    AccountHandover, CarryOver, Channel, CliId, HandoverArgs, LifecycleState, ResolvedAccount,
    SessionRecord, SYSTEM_ACCOUNT_ID,
};

use super::handover::{choose_handover, AccountSwitchPlan, Handover};
use super::{account_cli_of, validate_selected, AccountProblem, HandleView};
use crate::modes::{find_mode, resolve_mode_id};
use crate::sessions::{ResetError, SessionRoutes};

/// How long a switch waits for the plugin's recorded chat id.
const RECORDED_CHAT_ID_TIMEOUT: Duration = Duration::from_secs(2);

/// The CLI of a session's mode (`None` when the mode is gone).
fn session_cli_of(session: &SessionRecord) -> Option<String> {
    session
        .mode_id
        .as_deref()
        .and_then(find_mode)
        .map(|m| m.cli.as_str().to_string())
}

/// The root a native hand-over must stay inside: the account folder, or the
/// harness's own folder (`account_link_meta().system_dir`) for the System
/// login, falling back to the daemon home.
fn account_root(acct: &ResolvedAccount) -> Option<PathBuf> {
    acct.dir.clone().or_else(|| {
        plugin_for(&acct.cli)
            .and_then(|p| p.account_link_meta().system_dir)
            .or_else(|| Some(vst_agents::home::home_dir()))
    })
}

/// The display name of one account (System included).
fn display_for(
    accounts: Option<&AccountsHandle>,
    cli: Option<&str>,
    account_id: Option<&str>,
) -> Option<String> {
    let accounts = accounts?;
    let cli = cli?;
    accounts.summary(cli, account_id).map(|a| a.display_name)
}

/// The plugin for a CLI id, or `None` for an unknown id.
fn plugin_for(cli: &str) -> Option<Box<dyn vst_agents::plugin::AgentPlugin>> {
    CliId::from_str(cli).ok().map(resolve_plugin)
}

/// The explicit `accountId` of a reset body (trimmed, empty = absent).
fn explicit_account_id(body: &ResetBody) -> Option<&str> {
    body.account_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The CLI the replacement runs under: the requested mode's, else the
/// session's own.
fn target_cli_of(
    requested_mode: Option<&str>,
    session_cli: Option<String>,
) -> Result<Option<String>, ResetError> {
    let Some(req) = requested_mode else {
        return Ok(session_cli);
    };
    let id = resolve_mode_id(req)
        .ok_or_else(|| ResetError::ModeNotFound(format!("Mode '{req}' not found")))?;
    find_mode(&id)
        .map(|m| Some(m.cli.as_str().to_string()))
        .ok_or_else(|| ResetError::ModeNotFound(format!("Mode '{req}' not found")))
}

/// Busy rule (Decision 7): a Terminal switch never stops the agent before
/// `prepare_carry`, so a native copy could catch a half-written file. Rich Chat
/// stops its turns first, so only a Terminal target waits.
fn check_switch_busy(
    explicit: bool,
    channel: Channel,
    state: LifecycleState,
) -> Result<(), ResetError> {
    if explicit && channel != Channel::Json && state == LifecycleState::Working {
        return Err(ResetError::AgentBusy(
            "Wait for the agent to finish, then switch.".to_string(),
        ));
    }
    Ok(())
}

/// The account a hand-over probe needs, plus whether the source resolves at all
/// (a removed/signed-out source downgrades the hand-over, never an error).
fn locate_for(
    accounts: Option<&AccountsHandle>,
    cli: Option<&str>,
    account_id: Option<&str>,
) -> (ResolvedAccount, bool) {
    let resolved = accounts.and_then(|h| h.locate(cli?, account_id));
    let system = ResolvedAccount::system(cli.unwrap_or_default());
    let resolvable = resolved.is_some();
    (resolved.unwrap_or(system), resolvable)
}

/// Ask the plugin what it can hand over (never when the CLI changed).
fn handover_of(
    session: &SessionRecord,
    cwd: &str,
    target_cli: Option<&str>,
    cli_changed: bool,
    from: &ResolvedAccount,
    to: &ResolvedAccount,
) -> AccountHandover {
    if cli_changed {
        return AccountHandover::Unsupported;
    }
    match target_cli.and_then(plugin_for) {
        Some(plugin) => plugin.account_session_handover(&HandoverArgs {
            session,
            cwd,
            from,
            to,
        }),
        None => AccountHandover::Unsupported,
    }
}

/// Carry DERIVED from the hand-over; an explicit `carryOver: summary` is the one
/// override that keeps the existing summary path (Decision 7). `None` unless the
/// caller sent an `accountId`.
fn derived_carry(
    explicit: bool,
    handover: &Handover,
    requested: Option<CarryOver>,
) -> Option<CarryOver> {
    if !explicit {
        return None;
    }
    Some(match handover {
        Handover::Native(_) | Handover::NativeInPlace => CarryOver::Native,
        Handover::Transcript => CarryOver::Transcript,
        Handover::Fresh if requested == Some(CarryOver::Summary) => CarryOver::Summary,
        Handover::Fresh => CarryOver::Nothing,
    })
}

impl SessionRoutes {
    /// Plan the replacement's account for `reset_session` (Decision 7).
    ///
    /// Steps, in order: target CLI (requested mode, else the session's own);
    /// target account (explicit > kept > new CLI's default, validated);
    /// busy rule; hand-over; marker names.
    ///
    /// # Errors
    ///
    /// [`ResetError`] variants: mode not found, the account refusals
    /// (`Account`), `AlreadyOnAccount` (400) and `AgentBusy` (409).
    pub async fn plan_account_switch(
        &self,
        session: &SessionRecord,
        body: &ResetBody,
    ) -> Result<AccountSwitchPlan, ResetError> {
        let session_cli = session_cli_of(session);
        let target_cli = target_cli_of(body.mode_id.as_deref(), session_cli.clone())?;
        let cli_changed = target_cli != session_cli;
        let explicit = explicit_account_id(body);
        let to = self.target_account(explicit, target_cli.as_deref(), session, cli_changed)?;
        if explicit.is_some() && !cli_changed && to == session.account_id {
            return Err(ResetError::AlreadyOnAccount(
                "This session already runs under that account.".to_string(),
            ));
        }
        let channel = session_channel(session.channel, Some(session.use_tmux));
        check_switch_busy(explicit.is_some(), channel, session.lifecycle.state)?;

        let cwd = self.session_cwd(session).await;
        let accounts = self.accounts.as_ref();
        let (from_acct, from_resolvable) = locate_for(
            accounts,
            session_cli.as_deref(),
            session.account_id.as_deref(),
        );
        let (to_acct, _) = locate_for(accounts, target_cli.as_deref(), to.as_deref());
        let recorded = if explicit.is_some() && !cli_changed && channel != Channel::Json {
            self.with_recorded_chat_id(session, &cwd, &from_acct).await
        } else {
            None
        };
        let session = recorded.as_ref().unwrap_or(session);
        let plugin_says = handover_of(
            session,
            &cwd,
            target_cli.as_deref(),
            cli_changed,
            &from_acct,
            &to_acct,
        );
        let has_chat_id = session.agent_chat_id.is_some() || session.acp_session_id.is_some();
        let handover = choose_handover(
            plugin_says,
            from_resolvable,
            channel,
            has_chat_id,
            cli_changed,
            body.carry_over,
        );
        Ok(AccountSwitchPlan {
            explicit: explicit.is_some(),
            from: session.account_id.clone(),
            to: to.clone(),
            from_root: account_root(&from_acct),
            to_root: account_root(&to_acct),
            handover: handover.clone(),
            old_chat_id: session.agent_chat_id.clone(),
            old_acp_id: session.acp_session_id.clone(),
            from_display: display_for(
                accounts,
                session_cli.as_deref(),
                session.account_id.as_deref(),
            ),
            to_display: display_for(accounts, target_cli.as_deref(), to.as_deref()),
            carry: derived_carry(explicit.is_some(), &handover, body.carry_over),
        })
    }

    /// A Terminal session created fresh never had its chat id stored (the
    /// post-spawn capture only runs after a pasted prompt). For a CLI that can
    /// hand a conversation over natively, read the plugin's own record now and
    /// store it (the plugin deletes the record on read). `None` when nothing
    /// applies or nothing was recorded.
    async fn with_recorded_chat_id(
        &self,
        session: &SessionRecord,
        cwd: &str,
        from: &ResolvedAccount,
    ) -> Option<SessionRecord> {
        if session.agent_chat_id.is_some() {
            return None;
        }
        let plugin = session_cli_of(session).as_deref().and_then(plugin_for)?;
        if plugin.account_switch_support() != AccountSwitchSupport::Native {
            return None;
        }
        let project = self.store.get_project(&session.project_id).await?;
        let captured = tokio::time::timeout(
            RECORDED_CHAT_ID_TIMEOUT,
            plugin.capture_chat_id(CaptureArgs {
                session,
                project: &project,
                cwd,
                worktree: None,
                account_dir: from.dir.clone(),
            }),
        )
        .await
        .ok()??;
        if captured.is_empty() {
            return None;
        }
        self.persist_agent_chat_id(&session.id, captured.clone())
            .await;
        let mut rec = session.clone();
        rec.agent_chat_id = Some(captured);
        Some(rec)
    }

    /// Resolve the replacement's account id (planner step 2).
    fn target_account(
        &self,
        explicit: Option<&str>,
        target_cli: Option<&str>,
        session: &SessionRecord,
        cli_changed: bool,
    ) -> Result<Option<String>, ResetError> {
        let Some(accounts) = self.accounts.as_ref() else {
            return Ok(if cli_changed {
                None
            } else {
                session.account_id.clone()
            });
        };
        let Some(cli) = target_cli else {
            return Err(ResetError::Account(AccountProblem::NotFound));
        };
        let to = match explicit {
            Some(pick) => explicit_target(accounts, cli, pick)?,
            None if !cli_changed => {
                validate_selected(accounts, cli, session.account_id.clone(), false)
                    .map_err(ResetError::Account)?
            }
            None => validate_selected(
                accounts,
                cli,
                select_account(&HandleView(accounts), cli, None, None)
                    .map_err(|_| ResetError::Account(AccountProblem::NotFound))?,
                false,
            )
            .map_err(ResetError::Account)?,
        };
        Ok(to)
    }

    /// The cwd a hand-over probe needs (`<cwd>/.vibe-station/...` stores).
    async fn session_cwd(&self, session: &SessionRecord) -> String {
        match self.store.get_project(&session.project_id).await {
            Some(project) => match &session.worktree_id {
                Some(wt_id) => Paths::default()
                    .worktree_path(&project.id, wt_id)
                    .display()
                    .to_string(),
                None => project.absolute_path.clone(),
            },
            None => String::new(),
        }
    }
}

fn explicit_target(
    accounts: &AccountsHandle,
    cli: &str,
    pick: &str,
) -> Result<Option<String>, ResetError> {
    if pick != SYSTEM_ACCOUNT_ID {
        if let Some(other) = account_cli_of(accounts, pick) {
            if other != cli {
                return Err(ResetError::Account(AccountProblem::CliMismatch(
                    pick.to_string(),
                )));
            }
        }
    }
    let selected = select_account(&HandleView(accounts), cli, Some(pick), None)
        .map_err(|_| ResetError::Account(AccountProblem::NotFound))?;
    validate_selected(accounts, cli, selected, true).map_err(ResetError::Account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_to_system_uses_plugin_system_dir_as_root() {
        let home = tempfile::tempdir().expect("home");
        let _guard = vst_agents::home::with_home(home.path().to_path_buf());
        // The harness's own folder is the System root, not the whole home.
        let root = account_root(&ResolvedAccount::system("claude")).expect("root");
        assert_eq!(root, home.path().join(".claude"));
        // An unknown CLI falls back to the daemon home.
        let fallback = account_root(&ResolvedAccount::system("nosuchcli")).expect("root");
        assert_eq!(fallback, home.path());
        // A named account keeps its own folder.
        let named = ResolvedAccount {
            cli: "claude".into(),
            id: Some("acc_1".into()),
            dir: Some(home.path().join("work")),
            api_key: None,
        };
        assert_eq!(account_root(&named), Some(home.path().join("work")));
    }
}

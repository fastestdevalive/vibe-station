//! Sign-in orchestration glue (multi-account plan A3.5, Decision 5).
//!
//! A sign-in runs in a NORMAL Terminal session: the daemon creates it, pastes
//! the vendor's login line (`exec env ... <login argv>`), and treats the
//! session exiting as completion — no pane scraping. The attempt's folder,
//! pending record, expiry and duplicate check live in `vst-accounts`; this file
//! only owns the Terminal-session side and the `attempt -> session` wiring.
//!
//! Re-sign-in of an EXISTING (signed-out) account reuses the same shape without
//! a pending record: the registry's attempt table only mints NEW account ids,
//! so this module tracks the correlation id for that flow itself (the account
//! itself is untouched until the identity command confirms the login).

use std::str::FromStr;
use std::time::Duration;

use tokio::sync::broadcast::error::RecvError;
use tokio::sync::broadcast::Receiver;
use vst_accounts::labels::LabelRow;
use vst_accounts::{label_taken, AccountsHandle};
use vst_agents::account_cmd::login_shell_line;
use vst_agents::resolve_plugin;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::sessions::{CreateSessionBody, CreateTarget, InputBody, SessionOrDraft};
use vst_types::{Channel, CliId, LifecycleState, SessionType, SignInState, StartSignInResponse};

use crate::accounts_wiring::check_identity;
use vst_routes::sessions::SessionRoutes;

/// Why a sign-in could not start. Mapped to the documented HTTP codes.
#[derive(Debug)]
pub enum SignInStartError {
    /// 404 `unknown_cli`.
    UnknownCli(String),
    /// 400 `accounts_unsupported`.
    Unsupported(String),
    /// 404 `worktree_not_found`.
    WorktreeNotFound(String),
    /// 400 `label_required` (empty, too long or control characters).
    InvalidLabel(String),
    /// 409 `label_taken`.
    LabelTaken,
    /// 404 `account_not_found`.
    NotFound(String),
    /// 500 `signin_start_failed`.
    Failed(String),
}

impl SignInStartError {
    /// The wire `code` of this refusal.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            SignInStartError::UnknownCli(_) => "unknown_cli",
            SignInStartError::Unsupported(_) => "accounts_unsupported",
            SignInStartError::WorktreeNotFound(_) => "worktree_not_found",
            SignInStartError::InvalidLabel(_) => "label_required",
            SignInStartError::LabelTaken => "label_taken",
            SignInStartError::NotFound(_) => "account_not_found",
            SignInStartError::Failed(_) => "signin_start_failed",
        }
    }

    /// The HTTP status of this refusal.
    #[must_use]
    pub fn status(&self) -> u16 {
        match self {
            SignInStartError::UnknownCli(_)
            | SignInStartError::WorktreeNotFound(_)
            | SignInStartError::NotFound(_) => 404,
            SignInStartError::Unsupported(_) | SignInStartError::InvalidLabel(_) => 400,
            SignInStartError::LabelTaken => 409,
            SignInStartError::Failed(_) => 500,
        }
    }

    /// A human message for the envelope's `error` field.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            SignInStartError::UnknownCli(cli) => format!("Unknown CLI '{cli}'."),
            SignInStartError::Unsupported(cli) => {
                format!("Accounts are not supported for '{cli}'.")
            }
            SignInStartError::WorktreeNotFound(id) => format!("Worktree '{id}' not found."),
            SignInStartError::InvalidLabel(m) => m.clone(),
            SignInStartError::LabelTaken => "That name is already taken for this CLI.".to_string(),
            SignInStartError::NotFound(id) => format!("Account '{id}' not found."),
            SignInStartError::Failed(m) => m.clone(),
        }
    }
}

/// Start signing a NEW account in: create the Terminal session, begin the
/// attempt, paste the login line, and finish on session exit.
///
/// # Errors
///
/// See [`SignInStartError`]; the Terminal session is deleted again when the
/// attempt or the paste fails.
pub async fn start_sign_in(
    accounts: &AccountsHandle,
    routes: &SessionRoutes,
    broadcaster: &Broadcaster,
    cli: &str,
    worktree_id: &str,
    label: Option<&str>,
) -> Result<StartSignInResponse, SignInStartError> {
    let cli_id = CliId::from_str(cli).map_err(|_| SignInStartError::UnknownCli(cli.to_string()))?;
    if !accounts.supports(cli) {
        return Err(SignInStartError::Unsupported(cli.to_string()));
    }
    ensure_worktree(routes, worktree_id).await?;
    if let Some(label) = label {
        vst_accounts::normalize_label(label)
            .map_err(|e| SignInStartError::InvalidLabel(e.to_string()))?;
        if label_is_taken(accounts, cli, label) {
            return Err(SignInStartError::LabelTaken);
        }
    }
    // The account id is minted by `begin_sign_in`, so the session's display name
    // uses the chosen label (or the CLI id) and is renamed by the user later.
    let display = label.unwrap_or(cli);
    // Subscribe before the login can run, so an instant exit is never missed.
    let exit_rx = broadcaster.subscribe();
    let session_id = create_login_session(routes, worktree_id, display).await?;
    let started = match accounts.begin_sign_in(cli, &session_id, label) {
        Ok(started) => started,
        Err(e) => {
            let _ = routes.delete_session(&session_id).await;
            return Err(map_begin_error(e, cli));
        }
    };
    if let Err(e) = paste_login_line(
        accounts,
        routes,
        cli_id,
        cli,
        Some(&started.account_id),
        &session_id,
    )
    .await
    {
        let _ = accounts.cancel_sign_in(&started.attempt_id);
        let _ = routes.delete_session(&session_id).await;
        return Err(e);
    }
    spawn_finish_on_exit(
        accounts.clone(),
        exit_rx,
        started.attempt_id.clone(),
        session_id,
    );
    Ok(started)
}

/// Re-sign-in of an EXISTING signed-out account (same account id, no pending
/// record, no duplicate check).
///
/// # Errors
///
/// See [`SignInStartError`]; the Terminal session is deleted again when the
/// paste fails.
pub async fn restart_sign_in(
    accounts: &AccountsHandle,
    routes: &SessionRoutes,
    broadcaster: &Broadcaster,
    cli: &str,
    account_id: &str,
    worktree_id: &str,
) -> Result<StartSignInResponse, SignInStartError> {
    let cli_id = CliId::from_str(cli).map_err(|_| SignInStartError::UnknownCli(cli.to_string()))?;
    if !accounts.supports(cli) {
        return Err(SignInStartError::Unsupported(cli.to_string()));
    }
    ensure_worktree(routes, worktree_id).await?;
    // `"system"` is the System login, which has no account id (Decision 4).
    let account = vst_types::normalize_account_id(Some(account_id));
    if accounts.locate(cli, account.as_deref()).is_none() {
        return Err(SignInStartError::NotFound(account_id.to_string()));
    }
    let display = display_of(accounts, cli, account_id).unwrap_or_else(|| account_id.to_string());
    let exit_rx = broadcaster.subscribe();
    let session_id = create_login_session(routes, worktree_id, &display).await?;
    if let Err(e) = paste_login_line(
        accounts,
        routes,
        cli_id,
        cli,
        account.as_deref(),
        &session_id,
    )
    .await
    {
        let _ = routes.delete_session(&session_id).await;
        return Err(e);
    }
    let attempt_id = new_attempt_id();
    broadcaster.send(ServerEvent::AccountSignin {
        attempt_id: attempt_id.clone(),
        cli: cli.to_string(),
        account_id: account_id.to_string(),
        state: SignInState::Waiting,
        email: None,
        plan: None,
        message: None,
    });
    spawn_restart_finish(
        accounts.clone(),
        routes.clone(),
        broadcaster.clone(),
        exit_rx,
        attempt_id.clone(),
        cli.to_string(),
        account_id.to_string(),
        account,
        session_id.clone(),
    );
    Ok(StartSignInResponse {
        attempt_id,
        account_id: account_id.to_string(),
        session_id,
    })
}

/// The account's display name (label, else email, else id).
fn display_of(accounts: &AccountsHandle, cli: &str, account_id: &str) -> Option<String> {
    let account = vst_types::normalize_account_id(Some(account_id));
    accounts
        .summary(cli, account.as_deref())
        .map(|a| a.display_name)
}

/// A label (or effective display name) already used by another account of `cli`.
fn label_is_taken(accounts: &AccountsHandle, cli: &str, label: &str) -> bool {
    let summaries: Vec<_> = accounts
        .list()
        .into_iter()
        .filter(|a| a.cli == cli)
        .collect();
    let rows: Vec<LabelRow<'_>> = summaries
        .iter()
        .map(|a| (a.cli.as_str(), a.id.as_str(), a.display_name.as_str()))
        .collect();
    label_taken(&rows, cli, label, None)
}

/// Validate the worktree that will host the login Terminal.
async fn ensure_worktree(
    routes: &SessionRoutes,
    worktree_id: &str,
) -> Result<(), SignInStartError> {
    vst_routes::sessions::find_worktree_context(&routes.store, worktree_id)
        .await
        .ok_or_else(|| SignInStartError::WorktreeNotFound(worktree_id.to_string()))?;
    Ok(())
}

/// Create the Terminal session the vendor login runs in.
async fn create_login_session(
    routes: &SessionRoutes,
    worktree_id: &str,
    display: &str,
) -> Result<String, SignInStartError> {
    let body = CreateSessionBody {
        target: Some(CreateTarget::Worktree),
        worktree_id: Some(worktree_id.to_string()),
        project_id: None,
        r#type: SessionType::Terminal,
        mode_id: None,
        prompt: None,
        use_tmux: None,
        channel: Some(Channel::Tmux),
        name: Some(format!("Sign in: {display}")),
        source_agent_id: None,
        skip_auto_turn: None,
        only_if_none: None,
        account_id: None,
    };
    let value = serde_json::to_value(body)
        .map_err(|e| SignInStartError::Failed(format!("Could not build the login session: {e}")))?;
    match routes.create_session(&value).await {
        Ok(SessionOrDraft::Session(s)) => Ok(s.id),
        Ok(SessionOrDraft::GlobalDraft(_)) => Err(SignInStartError::Failed(
            "A login Terminal needs a worktree.".to_string(),
        )),
        Err(e) => Err(SignInStartError::Failed(format!(
            "Could not create the login Terminal: {e:?}"
        ))),
    }
}

/// Paste the vendor's login line into the login Terminal.
async fn paste_login_line(
    accounts: &AccountsHandle,
    routes: &SessionRoutes,
    cli_id: CliId,
    cli: &str,
    account_id: Option<&str>,
    session_id: &str,
) -> Result<(), SignInStartError> {
    let resolved = accounts
        .locate(cli, account_id)
        .ok_or_else(|| SignInStartError::Failed("The account folder is missing.".to_string()))?;
    let plugin = resolve_plugin(cli_id);
    let line = login_shell_line(&*plugin, &resolved).ok_or_else(|| {
        SignInStartError::Failed(format!("'{cli}' has no non-interactive login command."))
    })?;
    routes
        .send_session(
            session_id,
            InputBody {
                data: line,
                send_enter: Some(true),
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .map_err(|e| SignInStartError::Failed(format!("Could not start the login: {e:?}")))?;
    Ok(())
}

/// Wait for the login Terminal to exit, then finalise the registry attempt.
fn spawn_finish_on_exit(
    accounts: AccountsHandle,
    exit_rx: Receiver<ServerEvent>,
    attempt_id: String,
    session_id: String,
) {
    tokio::spawn(async move {
        if !wait_for_exit(exit_rx, &session_id, SIGNIN_TTL).await {
            tracing::warn!(session = %session_id, "login Terminal did not exit before the sign-in expired");
            return;
        }
        if let Err(e) = accounts.on_login_exited(&attempt_id).await {
            tracing::warn!(attempt = %attempt_id, "could not finish the sign-in: {e}");
        }
    });
}

/// Wait for the re-sign-in's Terminal to exit, then confirm the identity.
#[allow(clippy::too_many_arguments)]
fn spawn_restart_finish(
    accounts: AccountsHandle,
    routes: SessionRoutes,
    broadcaster: Broadcaster,
    exit_rx: Receiver<ServerEvent>,
    attempt_id: String,
    cli: String,
    account_id: String,
    account: Option<String>,
    session_id: String,
) {
    tokio::spawn(async move {
        let mut identity = None;
        let state = if wait_for_exit(exit_rx, &session_id, SIGNIN_TTL).await {
            identity = check_identity(&accounts, &routes, &cli, account.as_deref()).await;
            let signed_in = identity
                .as_ref()
                .is_some_and(|s| s.auth == vst_types::AccountAuth::SignedIn);
            if signed_in {
                SignInState::Done
            } else {
                SignInState::Failed
            }
        } else {
            SignInState::Expired
        };
        broadcaster.send(ServerEvent::AccountSignin {
            attempt_id,
            cli,
            account_id,
            state,
            email: identity.as_ref().and_then(|s| s.email.clone()),
            plan: identity.as_ref().and_then(|s| s.plan.clone()),
            message: match state {
                SignInState::Failed => Some("The login did not finish signed in.".to_string()),
                SignInState::Expired => Some("The sign-in timed out.".to_string()),
                _ => None,
            },
        });
    });
}

/// Budget for one login session (Decision 5's 15-minute expiry).
const SIGNIN_TTL: Duration = Duration::from_secs(15 * 60);

/// Wait until `session_id` exits (state `exited` or deleted); `false` = the
/// budget ran out.
async fn wait_for_exit(mut rx: Receiver<ServerEvent>, session_id: &str, budget: Duration) -> bool {
    let wait = async {
        loop {
            match rx.recv().await {
                Ok(ServerEvent::SessionState {
                    session_id: id,
                    state: LifecycleState::Exited,
                    ..
                }) if id == session_id => return,
                Ok(ServerEvent::SessionDeleted { session_id: id }) if id == session_id => return,
                Ok(_) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            }
        }
    };
    tokio::time::timeout(budget, wait).await.is_ok()
}

static ATTEMPT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A correlation id for a re-sign-in attempt (unique per process + ms).
fn new_attempt_id() -> String {
    let n = ATTEMPT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("att_{:x}{n:x}", chrono::Utc::now().timestamp_millis())
}

/// Map a `begin_sign_in` failure onto the route's codes.
fn map_begin_error(e: vst_accounts::AccountsError, cli: &str) -> SignInStartError {
    use vst_accounts::AccountsError;
    match e {
        AccountsError::Unsupported => SignInStartError::Unsupported(cli.to_string()),
        AccountsError::Label(l) => SignInStartError::InvalidLabel(l.to_string()),
        AccountsError::LabelTaken => SignInStartError::LabelTaken,
        AccountsError::Poisoned | AccountsError::Io(_) | AccountsError::Secret(_) => {
            SignInStartError::Failed("Could not prepare the account folder.".to_string())
        }
        other => SignInStartError::Failed(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exit_before_wait_is_still_seen() {
        let broadcaster = Broadcaster::new(16);
        let rx = broadcaster.subscribe();
        broadcaster.send(ServerEvent::SessionDeleted {
            session_id: "s1".into(),
        });
        assert!(wait_for_exit(rx, "s1", Duration::from_millis(200)).await);
    }
}

//! Sign-in attempts (Decision 5).
//!
//! An attempt owns a half-made account folder (mode 0700, shared entries
//! linked, record `pending: true` — never listed), the Terminal session running
//! the vendor login, and a 15-minute expiry timer. Completion is decided by the
//! session exiting: the daemon calls [`AccountsHandle::on_login_exited`], which
//! runs the plugin's identity command, applies the duplicate check and
//! broadcasts `account:signin`. Nothing is ever scraped from the pane.

use std::path::{Path, PathBuf};
use std::time::Duration;

use vst_types::{
    AccountMethod, AccountRecord, AccountSummary, ServerEvent, SignInState, StartSignInResponse,
    SYSTEM_ACCOUNT_ID,
};

use crate::identity_ops::note_identity_locked;
use crate::labels::{display_name, normalize_label};
use crate::ops::remove_owned_folder;
use crate::registry::{
    new_account_id, record_dir, record_locked, save_file, summary_locked, taken_in, State,
};
use crate::{folders, AccountsError, AccountsHandle};

/// An attempt expires after 15 minutes.
pub const SIGNIN_TTL_SECS: u64 = 15 * 60;
/// Longest vendor message we put on the wire (chars).
const MAX_MESSAGE_CHARS: usize = 200;

/// One in-flight sign-in.
#[derive(Clone, Debug)]
pub struct Attempt {
    pub attempt_id: String,
    pub account_id: String,
    pub cli: String,
    /// The Terminal session running the vendor login.
    pub session_id: String,
    pub state: SignInState,
    pub started_at: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub message: Option<String>,
}

impl AccountsHandle {
    /// Start a sign-in: mint the account id, make its folder, write a pending
    /// record, and arm the expiry timer.
    ///
    /// # Errors
    ///
    /// Accounts unsupported for this CLI, an invalid/taken label, or a
    /// storage/folder failure.
    pub fn begin_sign_in(
        &self,
        cli: &str,
        session_id: &str,
        label: Option<&str>,
    ) -> Result<StartSignInResponse, AccountsError> {
        if !self.supports(cli) {
            return Err(AccountsError::Unsupported);
        }
        let label = label.map(normalize_label).transpose()?;
        let (account_id, attempt_id) = {
            let state = self.lock()?;
            if let Some(l) = &label {
                if taken_in(&state, cli, l, None) {
                    return Err(AccountsError::LabelTaken);
                }
            }
            let account_id = new_account_id(&state);
            let attempt_id = new_attempt_id(|candidate| state.attempts.contains_key(candidate));
            (account_id, attempt_id)
        };
        let dir = folders::create_account_dir(self.root(), cli, &account_id)?;
        if let Some(shared) = self.shared_entries(cli) {
            folders::link_shared_entries(&dir, &shared);
        }
        let attempt = Attempt {
            attempt_id: attempt_id.clone(),
            account_id: account_id.clone(),
            cli: cli.to_string(),
            session_id: session_id.to_string(),
            state: SignInState::Waiting,
            started_at: crate::now_iso(),
            email: None,
            plan: None,
            message: None,
        };
        {
            let mut state = self.lock()?;
            let record = AccountRecord {
                id: account_id.clone(),
                cli: cli.to_string(),
                label,
                method: AccountMethod::SignIn,
                email: None,
                plan: None,
                auth: vst_types::AccountAuth::Unknown,
                pending: true,
                created_at: crate::now_iso(),
                dir: Some(dir.to_string_lossy().into_owned()),
                created_by_us: true,
                extra: serde_json::Map::new(),
            };
            state.registry.accounts.push(record);
            state.attempts.insert(attempt_id.clone(), attempt.clone());
            save_file(self.root(), &state.registry)?;
        }
        let handle = self.spawn_expiry(&attempt_id);
        if let Ok(mut state) = self.lock() {
            state.timers.insert(attempt_id.clone(), handle);
        }
        self.broadcast(signin_event(&attempt, SignInState::Waiting));
        Ok(StartSignInResponse {
            attempt_id,
            account_id,
            session_id: session_id.to_string(),
        })
    }

    /// Cancel an attempt (idempotent): drop the folder and the pending record.
    ///
    /// # Errors
    ///
    /// A lock/storage/folder failure (an unknown attempt is not an error).
    pub fn cancel_sign_in(&self, attempt_id: &str) -> Result<(), AccountsError> {
        let (cancelled, owned) = {
            let mut state = self.lock()?;
            let Some(attempt) = state.attempts.remove(attempt_id) else {
                return Ok(());
            };
            abort_timer(&mut state, attempt_id);
            let owned = owned_folder(&state, self.root(), &attempt.cli, &attempt.account_id);
            drop_pending_record(&mut state, &attempt);
            save_file(self.root(), &state.registry)?;
            (attempt, owned)
        };
        if let Some(dir) = owned {
            remove_owned_folder(self.root(), &cancelled.cli, &dir)?;
        }
        Ok(())
    }

    /// The login session exited: read the identity, dedupe, broadcast the state.
    ///
    /// # Errors
    ///
    /// [`AccountsError::AttemptNotFound`] for an unknown attempt, or a
    /// lock/storage failure.
    pub async fn on_login_exited(&self, attempt_id: &str) -> Result<SignInState, AccountsError> {
        let attempt = {
            let state = self.lock()?;
            state
                .attempts
                .get(attempt_id)
                .cloned()
                .ok_or(AccountsError::AttemptNotFound)?
        };
        if attempt.state != SignInState::Waiting {
            return Ok(attempt.state);
        }
        let Some(resolved) = self.locate(&attempt.cli, Some(&attempt.account_id)) else {
            return Err(AccountsError::NotFound);
        };
        let identity = self.identity(resolved).await;
        if identity.email.is_some() {
            // The duplicate check compares against the System login too, and its
            // identity is cached on boot — ask once if it is not known yet.
            let _ = self.system_identity(&attempt.cli).await;
        }
        let (next, message, owned) = {
            let mut state = self.lock()?;
            let owned = owned_folder(&state, self.root(), &attempt.cli, &attempt.account_id);
            let duplicate = identity.email.as_deref().is_some_and(|email| {
                email_taken_locked(&state, &attempt.cli, email, &attempt.account_id)
            });
            let next = if duplicate {
                drop_pending_record(&mut state, &attempt);
                SignInState::Duplicate
            } else if identity.signed_in == Some(false) {
                drop_pending_record(&mut state, &attempt);
                SignInState::Failed
            } else {
                // The UI learns the account itself at `finish_sign_in`
                // (`account:updated`), so the per-account event is not re-emitted.
                let _ = note_identity_locked(
                    &mut state,
                    self.root(),
                    &attempt.cli,
                    Some(&attempt.account_id),
                    &identity,
                );
                SignInState::Done
            };
            let message = (next == SignInState::Failed)
                .then(|| "The login did not finish signed in.".to_string());
            if let Some(a) = state.attempts.get_mut(attempt_id) {
                a.state = next;
                a.email.clone_from(&identity.email);
                a.plan.clone_from(&identity.plan);
                a.message.clone_from(&message);
            }
            if next != SignInState::Done {
                abort_timer(&mut state, attempt_id);
            }
            save_file(self.root(), &state.registry)?;
            (next, message, owned)
        };
        if let (Some(dir), true) = (
            owned,
            matches!(next, SignInState::Duplicate | SignInState::Failed),
        ) {
            remove_owned_folder(self.root(), &attempt.cli, &dir)?;
        }
        let mut done = attempt;
        done.state = next;
        done.email = identity.email;
        done.plan = identity.plan;
        done.message = message.map(cap_message);
        self.broadcast(signin_event(&done, next));
        Ok(next)
    }

    /// Finalise a finished attempt with the name chosen in the dialog. The
    /// duplicate check runs again here, because the System identity may have
    /// become known since the login exited.
    ///
    /// # Errors
    ///
    /// An unknown/unfinished attempt, a duplicate login, a taken/invalid label,
    /// or a lock/storage/folder failure.
    pub async fn finish_sign_in(
        &self,
        attempt_id: &str,
        label: Option<&str>,
    ) -> Result<AccountSummary, AccountsError> {
        let attempt = {
            let state = self.lock()?;
            state
                .attempts
                .get(attempt_id)
                .cloned()
                .ok_or(AccountsError::AttemptNotFound)?
        };
        if attempt.state != SignInState::Done {
            return Err(AccountsError::AttemptNotDone);
        }
        let email = {
            let state = self.lock()?;
            record_locked(&state, &attempt.cli, &attempt.account_id).and_then(|r| r.email.clone())
        };
        if let Some(email) = email.as_deref() {
            let _ = self.system_identity(&attempt.cli).await;
            let duplicate = {
                let state = self.lock()?;
                email_taken_locked(&state, &attempt.cli, email, &attempt.account_id)
            };
            if duplicate {
                let mut state = self.lock()?;
                let owned = owned_folder(&state, self.root(), &attempt.cli, &attempt.account_id);
                drop_pending_record(&mut state, &attempt);
                if let Some(a) = state.attempts.get_mut(attempt_id) {
                    a.state = SignInState::Duplicate;
                }
                save_file(self.root(), &state.registry)?;
                drop(state);
                if let Some(dir) = owned {
                    remove_owned_folder(self.root(), &attempt.cli, &dir)?;
                }
                self.broadcast(signin_event(&attempt, SignInState::Duplicate));
                return Err(AccountsError::Duplicate);
            }
        }
        let name = {
            let fallback = email
                .as_deref()
                .filter(|e| !e.trim().is_empty())
                .unwrap_or(&attempt.account_id);
            normalize_label(label.unwrap_or(fallback))?
        };
        let (summary, event) = {
            let mut state = self.lock()?;
            if taken_in(&state, &attempt.cli, &name, Some(&attempt.account_id)) {
                return Err(AccountsError::LabelTaken);
            }
            let record = state
                .registry
                .accounts
                .iter_mut()
                .find(|r| r.cli == attempt.cli && r.id == attempt.account_id)
                .ok_or(AccountsError::NotFound)?;
            record.pending = false;
            record.label = Some(name);
            abort_timer(&mut state, attempt_id);
            state.attempts.remove(attempt_id);
            save_file(self.root(), &state.registry)?;
            let summary = summary_locked(&state, &attempt.cli, Some(&attempt.account_id))
                .ok_or(AccountsError::NotFound)?;
            (
                summary.clone(),
                ServerEvent::AccountUpdated { account: summary },
            )
        };
        self.broadcast(event);
        Ok(summary)
    }

    /// Arm the 15-minute expiry for an attempt.
    fn spawn_expiry(&self, attempt_id: &str) -> tokio::task::JoinHandle<()> {
        let handle = self.clone();
        let id = attempt_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(SIGNIN_TTL_SECS)).await;
            handle.expire_sign_in(&id);
        })
    }

    /// The timer fired: expire a still-waiting attempt.
    fn expire_sign_in(&self, attempt_id: &str) {
        let (expired, owned) = {
            let Ok(mut state) = self.lock() else {
                tracing::error!("accounts registry lock poisoned while expiring a sign-in");
                return;
            };
            let Some(current) = state.attempts.get(attempt_id) else {
                return;
            };
            if current.state != SignInState::Waiting {
                return;
            }
            let mut expired = current.clone();
            expired.state = SignInState::Expired;
            expired.message = Some("The sign-in timed out.".to_string());
            if let Some(entry) = state.attempts.get_mut(attempt_id) {
                entry.state = SignInState::Expired;
            }
            let owned = owned_folder(&state, self.root(), &expired.cli, &expired.account_id);
            drop_pending_record(&mut state, &expired);
            state.timers.remove(attempt_id);
            if let Err(e) = save_file(self.root(), &state.registry) {
                tracing::error!("could not persist the expired sign-in: {e}");
            }
            (expired, owned)
        };
        if let Some(dir) = owned {
            if let Err(e) = remove_owned_folder(self.root(), &expired.cli, &dir) {
                tracing::warn!("could not remove an expired sign-in folder: {e}");
            }
        }
        self.broadcast(signin_event(&expired, SignInState::Expired));
    }
}

/// The folder a record owns, when vibe-station created it AND the record is
/// still pending; a finished account's folder is never the attempt's to delete.
fn owned_folder(state: &State, root: &Path, cli: &str, account_id: &str) -> Option<PathBuf> {
    record_locked(state, cli, account_id)
        .filter(|r| r.created_by_us && r.pending)
        .map(|r| record_dir(root, r))
}

/// Remove an attempt's still-pending registry record (its folder is the caller's).
fn drop_pending_record(state: &mut State, attempt: &Attempt) {
    state
        .registry
        .accounts
        .retain(|r| !(r.cli == attempt.cli && r.id == attempt.account_id && r.pending));
}

/// Abort and forget an attempt's expiry timer.
fn abort_timer(state: &mut State, attempt_id: &str) {
    if let Some(handle) = state.timers.remove(attempt_id) {
        handle.abort();
    }
}

/// Whether `email` already belongs to another account of `cli` (System row
/// included), case-insensitively.
pub(crate) fn email_taken_locked(state: &State, cli: &str, email: &str, except_id: &str) -> bool {
    email_owner_locked(state, cli, email, except_id).is_some()
}

/// The display name of the other account of `cli` that already holds `email`
/// (case-insensitive; the System row included), if there is one.
pub(crate) fn email_owner_locked(
    state: &State,
    cli: &str,
    email: &str,
    except_id: &str,
) -> Option<String> {
    let wanted = email.trim().to_lowercase();
    let holds = |e: Option<&str>| e.is_some_and(|e| e.trim().to_lowercase() == wanted);
    let named = state
        .registry
        .accounts
        .iter()
        .find(|r| r.cli == cli && r.id != except_id && holds(r.email.as_deref()));
    if let Some(r) = named {
        return Some(crate::registry::record_display_name(r));
    }
    let row = state.system.get(cli)?;
    holds(row.email.as_deref()).then(|| {
        display_name(
            state.registry.system_labels.get(cli).map(String::as_str),
            row.email.as_deref(),
            SYSTEM_ACCOUNT_ID,
            true,
        )
    })
}

fn new_attempt_id(taken: impl Fn(&str) -> bool) -> String {
    for _ in 0..64 {
        let candidate = format!("att_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("att_{}", &uuid::Uuid::new_v4().simple().to_string()[..16])
}

/// The `account:signin` event for an attempt.
fn signin_event(attempt: &Attempt, state: SignInState) -> ServerEvent {
    ServerEvent::AccountSignin {
        attempt_id: attempt.attempt_id.clone(),
        cli: attempt.cli.clone(),
        account_id: attempt.account_id.clone(),
        state,
        email: attempt.email.clone(),
        plan: attempt.plan.clone(),
        message: attempt.message.clone().map(cap_message),
    }
}

/// Cap vendor text so unbounded output never reaches clients.
fn cap_message(message: String) -> String {
    if message.chars().count() <= MAX_MESSAGE_CHARS {
        return message;
    }
    let mut out: String = message.chars().take(MAX_MESSAGE_CHARS).collect();
    out.push('…');
    out
}

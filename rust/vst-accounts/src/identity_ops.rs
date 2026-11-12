//! Identity bookkeeping: applying an identity read to the registry state, and
//! the re-read operations built on it (`refresh_identity`, `system_identity`).

use std::path::Path;

use vst_types::{
    AccountAuth, AccountIdentity, AccountMethod, AccountSummary, ResolvedAccount, ServerEvent,
};

use crate::limit_state::auth_from_identity;
use crate::registry::{self, save_file, summary_locked, system_summary, State};
use crate::{AccountsError, AccountsHandle};

/// Copy the identity's known parts in; returns whether anything changed.
fn apply_identity(
    auth: &mut AccountAuth,
    email: &mut Option<String>,
    plan: &mut Option<String>,
    new_auth: Option<AccountAuth>,
    identity: &AccountIdentity,
) -> bool {
    let mut changed = false;
    if let Some(a) = new_auth.filter(|a| *a != *auth) {
        *auth = a;
        changed = true;
    }
    for (slot, value) in [(email, &identity.email), (plan, &identity.plan)] {
        if let Some(v) = value.clone().filter(|v| !v.is_empty()) {
            if slot.as_deref() != Some(v.as_str()) {
                *slot = Some(v);
                changed = true;
            }
        }
    }
    changed
}

/// Record an auth change. The System row lives only in memory; a named
/// account's auth is persisted.
pub(crate) fn note_auth_locked(
    state: &mut State,
    root: &Path,
    cli: &str,
    account_id: Option<&str>,
    auth: AccountAuth,
) -> Option<ServerEvent> {
    match account_id {
        None => {
            let row = state.system.entry(cli.to_string()).or_default();
            if row.auth == auth {
                return None;
            }
            row.auth = auth;
            Some(ServerEvent::AccountUpdated {
                account: system_summary(state, cli),
            })
        }
        Some(id) => {
            let changed = {
                let record = state
                    .registry
                    .accounts
                    .iter_mut()
                    .find(|r| r.cli == cli && r.id == id)?;
                if record.auth == auth {
                    false
                } else {
                    record.auth = auth;
                    true
                }
            };
            if !changed {
                return None;
            }
            if let Err(e) = save_file(root, &state.registry) {
                tracing::error!("could not persist the account auth change: {e}");
            }
            summary_locked(state, cli, Some(id))
                .map(|account| ServerEvent::AccountUpdated { account })
        }
    }
}

/// Record an identity read (auth + email + plan). Broadcasting only on change.
pub(crate) fn note_identity_locked(
    state: &mut State,
    root: &Path,
    cli: &str,
    account_id: Option<&str>,
    identity: &AccountIdentity,
) -> Option<ServerEvent> {
    let auth = auth_from_identity(identity);
    match account_id {
        None => {
            let row = state.system.entry(cli.to_string()).or_default();
            let changed =
                apply_identity(&mut row.auth, &mut row.email, &mut row.plan, auth, identity);
            changed.then(|| ServerEvent::AccountUpdated {
                account: system_summary(state, cli),
            })
        }
        Some(id) => {
            let changed = {
                let record = state
                    .registry
                    .accounts
                    .iter_mut()
                    .find(|r| r.cli == cli && r.id == id)?;
                apply_identity(
                    &mut record.auth,
                    &mut record.email,
                    &mut record.plan,
                    auth,
                    identity,
                )
            };
            if !changed {
                return None;
            }
            if let Err(e) = save_file(root, &state.registry) {
                tracing::error!("could not persist the account auth change: {e}");
            }
            summary_locked(state, cli, Some(id))
                .map(|account| ServerEvent::AccountUpdated { account })
        }
    }
}

impl AccountsHandle {
    /// Re-read an account's identity through the vendor's own command.
    ///
    /// # Errors
    ///
    /// [`AccountsError::NotFound`] for an unknown account, or a lock/storage
    /// failure.
    pub async fn refresh_identity(
        &self,
        cli: &str,
        account_id: Option<&str>,
    ) -> Result<AccountSummary, AccountsError> {
        let resolved = self
            .locate(cli, account_id)
            .ok_or(AccountsError::NotFound)?;
        // An API-key account is decided by its key, never by a vendor login (Decision 12).
        if let Some(id) = account_id {
            let state = self.lock()?;
            let is_api_key = registry::record_locked(&state, cli, id)
                .is_some_and(|r| r.method == AccountMethod::ApiKey);
            if is_api_key {
                return registry::summary_locked(&state, cli, account_id)
                    .ok_or(AccountsError::NotFound);
            }
        }
        // Concurrent checks for one account share the first one's result.
        let _flight = match account_id {
            Some(id) => match self.try_begin(cli, id) {
                Some(guard) => Some(guard),
                None => return self.summary(cli, account_id).ok_or(AccountsError::NotFound),
            },
            None => None,
        };
        let identity = self.identity(resolved).await;
        if let Some(id) = account_id.filter(|id| self.is_pending(cli, id)) {
            return self.settle_pending(cli, id, &identity).await;
        }
        let (summary, event) = {
            let mut state = self.lock()?;
            let event = note_identity_locked(&mut state, self.root(), cli, account_id, &identity);
            let summary =
                registry::summary_locked(&state, cli, account_id).ok_or(AccountsError::NotFound)?;
            (summary, event)
        };
        if let Some(ev) = event {
            self.broadcast(ev);
        }
        Ok(summary)
    }

    /// The System row's identity: the cached value, or one identity-command run
    /// (cached afterwards). Feeds the duplicate check and the signed-out banner;
    /// it never halts anything (Decision 12).
    pub(crate) async fn system_identity(&self, cli: &str) -> AccountIdentity {
        let cached = match self.lock() {
            Ok(state) => state.system.get(cli).cloned(),
            Err(_) => None,
        };
        if let Some(row) = cached {
            if row.email.is_some() {
                return AccountIdentity {
                    signed_in: auth_to_signed_in(row.auth),
                    email: row.email,
                    plan: row.plan,
                };
            }
        }
        let identity = self.identity(ResolvedAccount::system(cli)).await;
        if let Err(e) = self.note_identity(cli, None, &identity) {
            tracing::error!("could not cache the System identity: {e}");
        }
        identity
    }
}

/// `AccountAuth` -> the identity's tri-state (for the cached System row).
fn auth_to_signed_in(auth: AccountAuth) -> Option<bool> {
    match auth {
        AccountAuth::SignedIn => Some(true),
        AccountAuth::SignedOut => Some(false),
        AccountAuth::Unknown => None,
    }
}

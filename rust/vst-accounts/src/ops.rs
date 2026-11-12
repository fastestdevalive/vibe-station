//! Every mutation of the accounts registry.
//!
//! Each operation locks once, mutates, saves, drops the guard and only then
//! broadcasts — never broadcasting while a guard is live.

use std::io;
use std::path::{Path, PathBuf};

use vst_types::{
    AccountAuth, AccountLimited, AccountMethod, AccountSummary, ServerEvent, SYSTEM_ACCOUNT_ID,
};

use crate::labels::normalize_label;
use crate::registry::{
    self, new_account_id, record_locked, save_file, summary_locked, system_summary, taken_in,
};
use crate::{folders, secret, AccountsError, AccountsHandle};

/// Delete an account folder and its API-key file, but only for a folder that
/// `folders::is_managed_dir` confirms is exactly `<root>/<cli>/<name>`. A
/// tampered `dir` deletes nothing; the key file goes only after that guard
/// says managed. Returns whether the folder itself was removed.
///
/// # Errors
///
/// A filesystem error while removing the folder or its key file.
pub(crate) fn remove_owned_folder(root: &Path, cli: &str, dir: &Path) -> io::Result<bool> {
    if !folders::is_managed_dir(root, cli, dir) {
        return Ok(false);
    }
    // Key file first: a failure removing the folder must not leave a 0600 key
    // behind for an account whose record is already gone.
    secret::remove_api_key(dir)?;
    folders::remove_managed_dir(root, cli, dir)
}

impl AccountsHandle {
    /// Create an API-key account: folder 0700, key file 0600, shared entries.
    ///
    /// # Errors
    ///
    /// Accounts unsupported for this CLI, an invalid/taken label, an invalid
    /// key, or a storage failure.
    pub fn add_api_key(
        &self,
        cli: &str,
        api_key: &str,
        label: &str,
    ) -> Result<AccountSummary, AccountsError> {
        if !self.supports(cli) {
            return Err(AccountsError::Unsupported);
        }
        let label = normalize_label(label)?;
        let api_key = api_key.trim();
        secret::validate_key(api_key)?;
        let id = {
            let state = self.lock()?;
            if taken_in(&state, cli, &label, None) {
                return Err(AccountsError::LabelTaken);
            }
            new_account_id(&state)
        };
        let dir = folders::create_account_dir(self.root(), cli, &id)?;
        if let Some(shared) = self.shared_entries(cli) {
            folders::link_shared_entries(&dir, &shared);
        }
        if let Err(e) = secret::write_api_key(&dir, api_key) {
            let _ = remove_owned_folder(self.root(), cli, &dir);
            return Err(e.into());
        }
        match self.push_api_key_record(cli, &id, label, &dir) {
            Ok((summary, event)) => {
                self.broadcast(event);
                Ok(summary)
            }
            Err(e) => {
                let _ = remove_owned_folder(self.root(), cli, &dir);
                Err(e)
            }
        }
    }

    /// Register the record of a freshly created API-key folder. The label is
    /// re-checked under this lock (a concurrent add may have taken it); on any
    /// error nothing stays in the registry.
    fn push_api_key_record(
        &self,
        cli: &str,
        id: &str,
        label: String,
        dir: &Path,
    ) -> Result<(AccountSummary, ServerEvent), AccountsError> {
        let mut state = self.lock()?;
        if taken_in(&state, cli, &label, None) {
            return Err(AccountsError::LabelTaken);
        }
        let record = vst_types::AccountRecord {
            id: id.to_string(),
            cli: cli.to_string(),
            label: Some(label),
            method: AccountMethod::ApiKey,
            email: None,
            plan: None,
            auth: AccountAuth::Unknown,
            pending: false,
            created_at: crate::now_iso(),
            dir: Some(dir.to_string_lossy().into_owned()),
            created_by_us: true,
            extra: serde_json::Map::new(),
        };
        let summary = registry::named_summary(&state, &record);
        let event = ServerEvent::AccountUpdated {
            account: summary.clone(),
        };
        state.registry.accounts.push(record);
        if let Err(e) = save_file(self.root(), &state.registry) {
            state.registry.accounts.retain(|r| r.id != id);
            return Err(e);
        }
        Ok((summary, event))
    }

    /// Rename a named account, or the CLI's System row (`id == "system"`).
    ///
    /// # Errors
    ///
    /// An invalid/taken label, an unknown account, or a storage failure.
    pub fn rename(
        &self,
        cli: &str,
        id: &str,
        label: Option<String>,
    ) -> Result<AccountSummary, AccountsError> {
        if !self.supports(cli) {
            return Err(AccountsError::Unsupported);
        }
        let label = label.map(|l| normalize_label(&l)).transpose()?;
        let (summary, event) = {
            let mut state = self.lock()?;
            if let Some(new_label) = &label {
                if taken_in(&state, cli, new_label, Some(id)) {
                    return Err(AccountsError::LabelTaken);
                }
            }
            if id == SYSTEM_ACCOUNT_ID {
                match label {
                    Some(l) => {
                        state.registry.system_labels.insert(cli.to_string(), l);
                    }
                    None => {
                        state.registry.system_labels.remove(cli);
                    }
                }
                save_file(self.root(), &state.registry)?;
                let summary = system_summary(&state, cli);
                (
                    summary.clone(),
                    ServerEvent::AccountUpdated { account: summary },
                )
            } else {
                {
                    let record = state
                        .registry
                        .accounts
                        .iter_mut()
                        .find(|r| r.cli == cli && r.id == id)
                        .ok_or(AccountsError::NotFound)?;
                    record.label = label;
                }
                save_file(self.root(), &state.registry)?;
                let summary =
                    summary_locked(&state, cli, Some(id)).ok_or(AccountsError::NotFound)?;
                (
                    summary.clone(),
                    ServerEvent::AccountUpdated { account: summary },
                )
            }
        };
        self.broadcast(event);
        Ok(summary)
    }

    /// Make `account_id` (`"system"` allowed) the CLI's default. A signed-out
    /// account can never become the default (R7).
    ///
    /// # Errors
    ///
    /// An unknown account, a signed-out account, or a storage failure.
    pub fn set_default(&self, cli: &str, account_id: &str) -> Result<(), AccountsError> {
        if !self.supports(cli) {
            return Err(AccountsError::Unsupported);
        }
        let events = {
            let mut state = self.lock()?;
            let previous = state.registry.defaults.get(cli).cloned();
            if account_id == SYSTEM_ACCOUNT_ID {
                state.registry.defaults.remove(cli);
            } else {
                let record =
                    record_locked(&state, cli, account_id).ok_or(AccountsError::NotFound)?;
                if record.pending {
                    return Err(AccountsError::NotFound);
                }
                if record.auth == AccountAuth::SignedOut {
                    return Err(AccountsError::SignedOut);
                }
                state
                    .registry
                    .defaults
                    .insert(cli.to_string(), account_id.to_string());
            }
            save_file(self.root(), &state.registry)?;
            // Every row whose `isDefault` flipped must be broadcast (at most two).
            let mut changed = Vec::new();
            if account_id == SYSTEM_ACCOUNT_ID {
                changed.push(system_summary(&state, cli));
            } else if let Some(s) = summary_locked(&state, cli, Some(account_id)) {
                changed.push(s);
            }
            match previous {
                Some(prev) if prev != account_id => {
                    if let Some(s) = summary_locked(&state, cli, Some(prev.as_str())) {
                        changed.push(s);
                    }
                }
                None if account_id != SYSTEM_ACCOUNT_ID => {
                    changed.push(system_summary(&state, cli));
                }
                _ => {}
            }
            changed
                .into_iter()
                .map(|account| ServerEvent::AccountUpdated { account })
                .collect::<Vec<_>>()
        };
        for event in events {
            self.broadcast(event);
        }
        Ok(())
    }

    /// Remove a named account: record + (when we created it) its folder and key
    /// file + the CLI default if it pointed here. A chosen folder is never
    /// touched. The System login cannot be removed.
    ///
    /// Returns whether the account folder was deleted.
    ///
    /// # Errors
    ///
    /// [`AccountsError::SystemAccount`] for the System login, an unknown account,
    /// or a storage failure of the registry file.
    pub fn remove(&self, cli: &str, id: &str) -> Result<bool, AccountsError> {
        if id == SYSTEM_ACCOUNT_ID {
            return Err(AccountsError::SystemAccount);
        }
        let (owned, default_cleared) = {
            let mut state = self.lock()?;
            let owned = record_locked(&state, cli, id)
                .filter(|r| r.created_by_us)
                .map(|r| registry::record_dir(self.root(), r));
            let before = state.registry.accounts.len();
            state
                .registry
                .accounts
                .retain(|r| !(r.cli == cli && r.id == id));
            if state.registry.accounts.len() == before {
                return Err(AccountsError::NotFound);
            }
            let cleared = state.registry.defaults.get(cli).is_some_and(|d| d == id);
            if cleared {
                state.registry.defaults.remove(cli);
            }
            state
                .limited
                .remove(&(cli.to_string(), Some(id.to_string())));
            save_file(self.root(), &state.registry)?;
            (owned, cleared.then(|| system_summary(&state, cli)))
        };
        // The record is already gone: a leftover folder must not hide that.
        let folder_deleted = match owned {
            Some(dir) => remove_owned_folder(self.root(), cli, &dir).unwrap_or_else(|e| {
                tracing::warn!(
                    cli,
                    account = id,
                    "could not remove the account folder: {e}"
                );
                false
            }),
            None => false,
        };
        self.broadcast(ServerEvent::AccountRemoved {
            cli: cli.to_string(),
            account_id: id.to_string(),
        });
        // The System row became the default, so its summary changed too.
        if let Some(account) = default_cleared {
            self.broadcast(ServerEvent::AccountUpdated { account });
        }
        Ok(folder_deleted)
    }

    /// The ONLY writer of the "limited" state; broadcasts on change.
    ///
    /// # Errors
    ///
    /// Only a poisoned registry lock.
    pub fn set_limited(
        &self,
        cli: &str,
        account_id: Option<&str>,
        limited: Option<AccountLimited>,
    ) -> Result<(), AccountsError> {
        let event = {
            let mut state = self.lock()?;
            let key = (cli.to_string(), account_id.map(str::to_string));
            if state.limited.get(&key) == limited.as_ref() {
                None
            } else {
                match &limited {
                    Some(l) => {
                        state.limited.insert(key, l.clone());
                    }
                    None => {
                        state.limited.remove(&key);
                    }
                }
                Some(ServerEvent::AccountLimited {
                    cli: cli.to_string(),
                    account_id: account_id.map(str::to_string),
                    limited,
                })
            }
        };
        if let Some(ev) = event {
            self.broadcast(ev);
        }
        Ok(())
    }

    /// Drop half-made sign-ins left by a crash: pending records + their folders.
    ///
    /// # Errors
    ///
    /// A storage failure while saving the registry.
    pub fn sweep_pending_on_boot(&self) -> Result<Vec<String>, AccountsError> {
        let (removed, events) = {
            let mut state = self.lock()?;
            let removed: Vec<(String, String, Option<PathBuf>)> = state
                .registry
                .accounts
                .iter()
                .filter(|r| r.pending)
                .map(|r| {
                    let owned = r
                        .created_by_us
                        .then(|| registry::record_dir(self.root(), r));
                    (r.cli.clone(), r.id.clone(), owned)
                })
                .collect();
            if removed.is_empty() {
                return Ok(Vec::new());
            }
            state.registry.accounts.retain(|r| !r.pending);
            for handle in std::mem::take(&mut state.timers).into_values() {
                handle.abort();
            }
            state.attempts.clear();
            save_file(self.root(), &state.registry)?;
            let events: Vec<ServerEvent> = removed
                .iter()
                .map(|(cli, id, _)| ServerEvent::AccountRemoved {
                    cli: cli.clone(),
                    account_id: id.clone(),
                })
                .collect();
            (removed, events)
        };
        for (cli, id, owned) in &removed {
            let Some(dir) = owned else { continue };
            if let Err(e) = remove_owned_folder(self.root(), cli, dir) {
                tracing::warn!(cli = %cli, account = %id, "could not remove a pending account folder: {e}");
            }
        }
        for event in events {
            self.broadcast(event);
        }
        Ok(removed.into_iter().map(|(_, id, _)| id).collect())
    }
}

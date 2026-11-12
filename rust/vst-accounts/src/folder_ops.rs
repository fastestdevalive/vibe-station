//! Folder accounts (Decisions 1, 5, 8, 11): validate a chosen or to-be-created
//! folder, add it as a pending row, and finish that row once its identity is
//! confirmed (or, for a harness that cannot verify identity, when the user
//! says "I've signed in"). A duplicate identity removes the row again.
//!
//! Lock discipline: no `State` guard is ever held across an `.await`; the
//! identity command always runs with the registry unlocked.

use std::path::{Path, PathBuf};

use vst_types::{
    AccountAuth, AccountIdentity, AccountMethod, AccountRecord, AccountSummary, ServerEvent,
};

use crate::identity_ops::note_identity_locked;
use crate::ops::remove_owned_folder;
use crate::registry::{
    new_account_id, record_dir, record_locked, save_file, summary_locked, taken_in,
};
use crate::signin::email_owner_locked;
use crate::{folders, AccountsError, AccountsHandle, FolderDeps};

/// What the user chose for an account's folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FolderSpec {
    /// vibe-station makes a folder `<root>/<cli>/<slug of the label>`.
    Create,
    /// An existing folder, as typed (`~` allowed).
    Choose(String),
}

/// The read-only outcome of [`AccountsHandle::validate_folder`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderCheck {
    /// The canonical folder (or the planned one for `Create`).
    pub resolved: PathBuf,
    /// Whether the folder exists already.
    pub exists: bool,
    /// Whether it has no entries.
    pub is_empty: bool,
    /// The plugin's verdict on the entry names (`true` for an empty folder).
    pub looks_valid: bool,
}

/// Holds one `(cli, id)` in-flight slot and releases it on drop.
pub struct FlightGuard {
    handle: AccountsHandle,
    key: (String, String),
}

impl FlightGuard {
    pub(crate) fn new(handle: AccountsHandle, key: (String, String)) -> Self {
        Self { handle, key }
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        self.handle.end_flight(&self.key);
    }
}

impl AccountsHandle {
    /// Add a folder account. It is written as a pending row; unless the CLI
    /// cannot verify identity, the identity command then runs once and a
    /// signed-in result finishes the row. Duplicate identity removes it again.
    ///
    /// # Errors
    ///
    /// As [`AccountsHandle::validate_folder`], plus [`AccountsError::FolderCreate`],
    /// [`AccountsError::DuplicateIdentity`] or a registry storage failure.
    pub async fn add_folder(
        &self,
        cli: &str,
        spec: FolderSpec,
        label: Option<&str>,
    ) -> Result<AccountSummary, AccountsError> {
        let deps = self.folder_deps(cli)?;
        let label = self.check_label(cli, label)?;
        let id = {
            let state = self.lock()?;
            new_account_id(&state)
        };
        // A chosen folder is probed only when it is non-empty AND looks like a
        // login folder. An empty one cannot hold a login, and a foreign one is
        // not ours: the vendor command would write its own state files
        // (`.claude.json`, lock, backups) into a folder the user only selected.
        // "Check again" (`confirm_pending`) still runs the identity command.
        let (dir, created_by_us, probe) = match &spec {
            FolderSpec::Create => {
                let dir = self.make_folder(cli, label.as_deref().unwrap_or(""), &id)?;
                (dir, true, true)
            }
            FolderSpec::Choose(input) => {
                let checked = self.choose_folder(cli, &deps, input)?;
                let probe = !checked.is_empty && (deps.looks_valid)(cli, &checked.names);
                (checked.resolved, false, probe)
            }
        };
        let pushed = self.push_pending(cli, &deps, &id, label, &dir, created_by_us);
        let pending = match pushed {
            Ok(summary) => summary,
            Err(e) => {
                if created_by_us {
                    let _ = remove_owned_folder(self.root(), cli, &dir);
                }
                return Err(e);
            }
        };
        let summary = if probe && self.verifies_identity(cli) {
            let resolved = self.locate(cli, Some(&id)).ok_or(AccountsError::NotFound)?;
            let identity = self.identity(resolved).await;
            self.settle_pending(cli, &id, &identity).await?
        } else {
            pending
        };
        if summary.pending {
            self.broadcast(ServerEvent::AccountUpdated {
                account: summary.clone(),
            });
        }
        Ok(summary)
    }

    /// The user confirmed a pending row (`POST /accounts/:cli/:id/refresh`).
    /// A verifiable row is checked and finishes only when signed in; an
    /// unverifiable one (no identity command) finishes on this explicit
    /// confirmation.
    /// Concurrent calls for one account return the current summary at once.
    ///
    /// # Errors
    ///
    /// [`AccountsError::NotFound`], [`AccountsError::DuplicateIdentity`] or a
    /// registry storage failure.
    pub async fn confirm_pending(
        &self,
        cli: &str,
        id: &str,
    ) -> Result<AccountSummary, AccountsError> {
        let Some(_flight) = self.try_begin(cli, id) else {
            return self.summary(cli, Some(id)).ok_or(AccountsError::NotFound);
        };
        if !self.is_pending(cli, id) {
            return self.summary(cli, Some(id)).ok_or(AccountsError::NotFound);
        }
        if !self.verifies_identity(cli) {
            return self.finish_pending(cli, id).await;
        }
        let resolved = self.locate(cli, Some(id)).ok_or(AccountsError::NotFound)?;
        let identity = self.identity(resolved).await;
        self.settle_pending(cli, id, &identity).await
    }

    /// Decide a pending row from one identity read. Only a verifiable CLI that
    /// reports `signed_in == Some(true)` finishes; anything else leaves it pending.
    pub(crate) async fn settle_pending(
        &self,
        cli: &str,
        id: &str,
        identity: &AccountIdentity,
    ) -> Result<AccountSummary, AccountsError> {
        if !self.verifies_identity(cli) || identity.signed_in != Some(true) {
            return self.summary(cli, Some(id)).ok_or(AccountsError::NotFound);
        }
        self.absorb_identity(cli, id, identity)?;
        self.finish_pending(cli, id).await
    }

    /// Whether the CLI can confirm sign-in itself (`AccountLinkMeta::verifies_identity`).
    fn verifies_identity(&self, cli: &str) -> bool {
        self.folder()
            .and_then(|d| (d.link_meta)(cli))
            .is_some_and(|m| m.verifies_identity)
    }

    /// Make a managed folder and link the CLI's shared entries into it.
    fn make_folder(&self, cli: &str, preferred: &str, id: &str) -> Result<PathBuf, AccountsError> {
        let dir = folders::create_managed_dir(self.root(), cli, preferred, id)
            .map_err(|_| AccountsError::FolderCreate)?;
        if let Some(shared) = self.shared_entries(cli) {
            folders::link_shared_entries(&dir, &shared);
        }
        Ok(dir)
    }

    /// Register the pending row. A chosen folder is checked again under the
    /// lock, so two adds of one folder cannot both win.
    fn push_pending(
        &self,
        cli: &str,
        deps: &FolderDeps,
        id: &str,
        label: Option<String>,
        dir: &Path,
        created_by_us: bool,
    ) -> Result<AccountSummary, AccountsError> {
        let mut state = self.lock()?;
        if !created_by_us {
            self.choose_locked(&state, cli, deps, &dir.to_string_lossy())?;
        }
        if let Some(label) = &label {
            if taken_in(&state, cli, label, None) {
                return Err(AccountsError::LabelTaken);
            }
        }
        state.registry.accounts.push(AccountRecord {
            id: id.to_string(),
            cli: cli.to_string(),
            label,
            method: AccountMethod::SignIn,
            email: None,
            plan: None,
            auth: AccountAuth::Unknown,
            pending: true,
            created_at: crate::now_iso(),
            dir: Some(dir.to_string_lossy().into_owned()),
            created_by_us,
            extra: serde_json::Map::new(),
        });
        if let Err(e) = save_file(self.root(), &state.registry) {
            state.registry.accounts.retain(|r| r.id != id);
            return Err(e);
        }
        summary_locked(&state, cli, Some(id)).ok_or(AccountsError::NotFound)
    }

    /// Record an identity read on a pending row. No broadcast: the row is
    /// announced when it is added or finished.
    fn absorb_identity(
        &self,
        cli: &str,
        id: &str,
        identity: &AccountIdentity,
    ) -> Result<(), AccountsError> {
        let mut state = self.lock()?;
        let _ = note_identity_locked(&mut state, self.root(), cli, Some(id), identity);
        Ok(())
    }

    /// Finish a pending row: duplicate-identity check, then `pending = false`.
    async fn finish_pending(&self, cli: &str, id: &str) -> Result<AccountSummary, AccountsError> {
        let email = {
            let state = self.lock()?;
            record_locked(&state, cli, id).and_then(|r| r.email.clone())
        };
        if let Some(email) = email {
            let _ = self.system_identity(cli).await;
            let owner = {
                let state = self.lock()?;
                email_owner_locked(&state, cli, &email, id)
            };
            if let Some(name) = owner {
                return self.reject_duplicate(cli, id, email, name);
            }
        }
        let (summary, event) = {
            let mut state = self.lock()?;
            let record = state
                .registry
                .accounts
                .iter_mut()
                .find(|r| r.cli == cli && r.id == id)
                .ok_or(AccountsError::NotFound)?;
            record.pending = false;
            save_file(self.root(), &state.registry)?;
            let summary = summary_locked(&state, cli, Some(id)).ok_or(AccountsError::NotFound)?;
            (
                summary.clone(),
                ServerEvent::AccountUpdated { account: summary },
            )
        };
        self.broadcast(event);
        Ok(summary)
    }

    /// Drop a duplicate pending row. Its folder goes only if we created it.
    fn reject_duplicate(
        &self,
        cli: &str,
        id: &str,
        email: String,
        name: String,
    ) -> Result<AccountSummary, AccountsError> {
        let owned = {
            let mut state = self.lock()?;
            let owned = record_locked(&state, cli, id)
                .filter(|r| r.created_by_us)
                .map(|r| record_dir(self.root(), r));
            state
                .registry
                .accounts
                .retain(|r| !(r.cli == cli && r.id == id));
            save_file(self.root(), &state.registry)?;
            owned
        };
        let mut folder_deleted = false;
        if let Some(dir) = owned {
            match remove_owned_folder(self.root(), cli, &dir) {
                Ok(deleted) => folder_deleted = deleted,
                Err(e) => tracing::warn!(
                    cli,
                    account = id,
                    "could not remove a duplicate's folder: {e}"
                ),
            }
        }
        self.broadcast(ServerEvent::AccountRemoved {
            cli: cli.to_string(),
            account_id: id.to_string(),
        });
        Err(AccountsError::DuplicateIdentity {
            email,
            name,
            folder_deleted,
        })
    }
}

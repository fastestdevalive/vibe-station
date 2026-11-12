//! Folder validation (`POST /accounts/validate-path`, the read-only half of
//! Decision 7): the chosen-folder checks under the registry lock, the planned
//! name for "create for me", and the account-name check. Nothing here writes.

use std::path::PathBuf;
use std::sync::Arc;

use crate::folder_ops::{FolderCheck, FolderSpec};
use crate::labels::normalize_label;
use crate::paths::{self, Checked, OtherAccount};
use crate::registry::{record_dir, taken_in, State};
use crate::{folders, AccountsError, AccountsHandle, FolderDeps};

/// Highest collision suffix tried when previewing a folder name (`-2` ..= `-99`).
const PREVIEW_SUFFIX_MAX: u32 = 99;

/// Name used for a "create for me" folder whose label is empty (preview only;
/// the real folder is named after the account id).
const PREVIEW_FALLBACK_NAME: &str = "account";

impl AccountsHandle {
    /// Check a folder without writing anything (`POST /accounts/validate-path`).
    ///
    /// # Errors
    ///
    /// Unsupported CLI or folder support, an invalid/taken name, or a folder
    /// the path rules refuse ([`AccountsError::Path`]).
    pub fn validate_folder(
        &self,
        cli: &str,
        spec: &FolderSpec,
        label: Option<&str>,
    ) -> Result<FolderCheck, AccountsError> {
        let deps = self.folder_deps(cli)?;
        let label = self.check_label(cli, label)?;
        match spec {
            FolderSpec::Choose(input) => {
                let checked = self.choose_folder(cli, &deps, input)?;
                Ok(FolderCheck {
                    looks_valid: checked.is_empty || (deps.looks_valid)(cli, &checked.names),
                    resolved: checked.resolved,
                    exists: true,
                    is_empty: checked.is_empty,
                })
            }
            FolderSpec::Create => {
                let base = folders::slugify(label.as_deref().unwrap_or(""));
                let base = if base.is_empty() {
                    PREVIEW_FALLBACK_NAME.to_string()
                } else {
                    base
                };
                Ok(FolderCheck {
                    resolved: self.planned_folder(cli, &base)?,
                    exists: false,
                    is_empty: true,
                    looks_valid: true,
                })
            }
        }
    }

    /// The folder support for `cli`, or `Unsupported`.
    pub(crate) fn folder_deps(&self, cli: &str) -> Result<Arc<FolderDeps>, AccountsError> {
        if !self.supports(cli) {
            return Err(AccountsError::Unsupported);
        }
        let deps = self.folder().ok_or(AccountsError::Unsupported)?;
        if (deps.link_meta)(cli).is_none() {
            return Err(AccountsError::Unsupported);
        }
        Ok(deps)
    }

    /// Normalise an optional name (blank = none) and refuse one another account has.
    pub(crate) fn check_label(
        &self,
        cli: &str,
        label: Option<&str>,
    ) -> Result<Option<String>, AccountsError> {
        let Some(raw) = label.map(str::trim).filter(|l| !l.is_empty()) else {
            return Ok(None);
        };
        let label = normalize_label(raw)?;
        let state = self.lock()?;
        if taken_in(&state, cli, &label, None) {
            return Err(AccountsError::LabelTaken);
        }
        Ok(Some(label))
    }

    /// Validate a chosen folder under the registry lock.
    pub(crate) fn choose_folder(
        &self,
        cli: &str,
        deps: &FolderDeps,
        input: &str,
    ) -> Result<Checked, AccountsError> {
        let state = self.lock()?;
        self.choose_locked(&state, cli, deps, input)
    }

    pub(crate) fn choose_locked(
        &self,
        state: &State,
        cli: &str,
        deps: &FolderDeps,
        input: &str,
    ) -> Result<Checked, AccountsError> {
        let others: Vec<OtherAccount> = state
            .registry
            .accounts
            .iter()
            .map(|r| OtherAccount {
                id: r.id.clone(),
                name: crate::registry::record_display_name(r),
                dir: record_dir(self.root(), r),
            })
            .collect();
        let system_dir = (deps.link_meta)(cli).and_then(|m| m.system_dir);
        paths::check_chosen(
            input,
            &deps.home,
            self.root(),
            system_dir.as_deref(),
            &others,
        )
        .map_err(AccountsError::Path)
    }

    /// The first free `<root>/<cli>/<base>` (`-2` .. `-99`), without creating it.
    fn planned_folder(&self, cli: &str, base: &str) -> Result<PathBuf, AccountsError> {
        let parent = self.root().join(cli);
        for n in 1..=PREVIEW_SUFFIX_MAX {
            let name = if n == 1 {
                base.to_string()
            } else {
                format!("{base}-{n}")
            };
            let candidate = parent.join(name);
            if candidate.symlink_metadata().is_err() {
                return Ok(candidate);
            }
        }
        Err(AccountsError::FolderCreate)
    }
}

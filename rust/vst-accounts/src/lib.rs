#![forbid(unsafe_code)]
//! `vst-accounts` — the accounts registry (`docs/MULTI-ACCOUNT.md`, Decision 1).
//!
//! Owns exactly one fact set (R4): the registry file, account folders, the
//! API-key file, labels, sign-in attempts, the "limited" state, `select_account`
//! and hand-over file application. Per-CLI behaviour arrives only through the
//! injected closures in [`AccountsDeps`] (built in
//! `vst-daemon/src/accounts_wiring.rs`), so this crate never names a harness
//! (R2) and never depends on `vst-agents`.
//!
//! The spawn path sees this crate only through [`vst_types::AccountPort`]
//! (implemented in `port.rs`); sign-in, the identity command, `/refresh` and
//! limits probes use [`AccountsHandle::locate`], which ignores `auth`/`pending`.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use vst_types::{
    AccountAuth, AccountIdentity, AccountLinkMeta, AccountSummary, ResolvedAccount, ServerEvent,
    SharedEntries, SignInSteps,
};

mod folder_check;
pub mod folder_ops;
pub mod folders;
pub mod handover;
mod identity_ops;
pub mod labels;
pub mod limit_state;
mod migrate;
pub mod ops;
pub mod paths;
mod port;
pub mod registry;
pub mod secret;
pub mod select;
pub mod signin;

pub use folder_ops::{FolderCheck, FolderSpec};
pub use handover::{ApplyReport, HandoverError};
pub use labels::{display_name, label_taken, normalize_label, LabelError};
pub use limit_state::{
    auth_from_identity, from_result as limited_from_result, from_signal as limited_from_signal,
    needs_identity_check,
};
pub use port::{usage_remove_plan, UsageRow};
pub use select::{select_account, AccountView, SelectError};

/// A pending identity read: the plugin's read-only vendor command.
pub type IdentityFuture = Pin<Box<dyn Future<Output = AccountIdentity> + Send>>;

/// Runs the CLI's identity command for one account (`locate`-style lookup).
pub type IdentityFn = Arc<dyn Fn(ResolvedAccount) -> IdentityFuture + Send + Sync>;

/// The CLI's own shared entries to symlink into a new account folder, by CLI id.
pub type SharedEntriesFn = Arc<dyn Fn(&str) -> Option<SharedEntries> + Send + Sync>;

/// Whether this CLI supports named accounts (`AgentPlugin::supports_accounts`).
pub type SupportsFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Reads a CLI's folder-link facts (`None` = folder accounts unsupported).
pub type LinkMetaFn = Arc<dyn Fn(&str) -> Option<AccountLinkMeta> + Send + Sync>;

/// Checks a chosen folder's entry NAMES (never contents) for this CLI.
pub type LooksValidFn = Arc<dyn Fn(&str, &[String]) -> bool + Send + Sync>;

/// The sign-in steps shown for one pending or signed-out folder account.
pub type SignInStepsFn = Arc<dyn Fn(&ResolvedAccount) -> SignInSteps + Send + Sync>;

/// Folder-account support, injected once through
/// [`AccountsHandle::with_folder_support`]. Without it, folder operations return
/// [`AccountsError::Unsupported`] and summaries leave `dir`/`signIn` unset.
pub struct FolderDeps {
    /// The user's home folder (`~` expansion and display).
    pub home: PathBuf,
    pub link_meta: LinkMetaFn,
    pub looks_valid: LooksValidFn,
    pub sign_in_steps: SignInStepsFn,
}

impl std::fmt::Debug for FolderDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FolderDeps")
            .field("home", &self.home)
            .finish_non_exhaustive()
    }
}

/// Everything `AccountsHandle` needs from the daemon. Built once in
/// `vst-daemon/src/accounts_wiring.rs` and moved in.
pub struct AccountsDeps {
    /// `<vst_home>/accounts`.
    pub root: PathBuf,
    pub broadcaster: vst_types::Broadcaster,
    pub identity: IdentityFn,
    pub shared_entries: SharedEntriesFn,
    pub supports: SupportsFn,
}

/// The registry handle. Cheap to clone; every clone shares one state.
#[derive(Clone)]
pub struct AccountsHandle {
    inner: Arc<Inner>,
}

struct Inner {
    deps: AccountsDeps,
    state: Mutex<registry::State>,
    /// `(cli, id)` pairs with an identity check or pending confirm running.
    in_flight: Mutex<HashSet<(String, String)>>,
}

/// Everything that can go wrong. One error type for the whole crate: the
/// routes map these onto the documented HTTP codes (A3).
#[derive(Debug, thiserror::Error)]
pub enum AccountsError {
    #[error("accounts registry lock poisoned")]
    Poisoned,
    #[error("accounts storage failure")]
    Io(#[from] std::io::Error),
    #[error("invalid label: {0}")]
    Label(#[from] LabelError),
    #[error("label already taken for this CLI")]
    LabelTaken,
    #[error("accounts are not supported for this CLI")]
    Unsupported,
    #[error("account not found")]
    NotFound,
    #[error("the System login cannot be removed")]
    SystemAccount,
    #[error("account is signed out")]
    SignedOut,
    #[error("sign-in attempt not found")]
    AttemptNotFound,
    #[error("sign-in has not finished")]
    AttemptNotDone,
    #[error("this login is already added")]
    Duplicate,
    #[error("invalid API key: {0}")]
    InvalidKey(#[from] secret::KeyError),
    #[error("could not write the API key file: {0}")]
    Secret(#[from] secret::SecretError),
    /// A chosen folder was refused (the daemon turns it into a code and text).
    #[error("the account folder was refused: {0:?}")]
    Path(paths::PathRefusal),
    #[error("could not create the account folder")]
    FolderCreate,
    /// The sign-in's identity is already another account of this CLI.
    #[error("this login is already added as {name}")]
    DuplicateIdentity {
        email: String,
        name: String,
        /// True when the row's own created folder was removed.
        folder_deleted: bool,
    },
}

/// The current UTC time in the wire's ISO8601 form.
#[must_use]
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl AccountsHandle {
    /// Load the registry from `deps.root` and start empty in-memory state.
    /// A corrupt registry file is logged, copied to `accounts.json.corrupt` and
    /// treated as empty (the first mutation rewrites the file).
    #[must_use]
    pub fn new(deps: AccountsDeps) -> Self {
        let state = registry::State::load(&deps.root);
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(state),
                in_flight: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// Enable folder accounts (validation, add, pending sign-in) with the
    /// CLI-specific facts injected by the daemon wiring.
    #[must_use]
    pub fn with_folder_support(self, deps: FolderDeps) -> Self {
        if let Ok(mut state) = self.lock() {
            state.folder = Some(Arc::new(deps));
        } else {
            tracing::error!("accounts registry lock poisoned; folder support not set");
        }
        self
    }

    /// Whether `(cli, id)` is a pending (not yet added) sign-in row.
    #[must_use]
    pub fn is_pending(&self, cli: &str, id: &str) -> bool {
        self.lock()
            .is_ok_and(|state| registry::record_locked(&state, cli, id).is_some_and(|r| r.pending))
    }

    /// The accounts root (`<vst_home>/accounts`).
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.inner.deps.root
    }

    /// Whether this CLI supports named accounts.
    #[must_use]
    pub fn supports(&self, cli: &str) -> bool {
        (self.inner.deps.supports)(cli)
    }

    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, registry::State>, AccountsError> {
        self.inner.state.lock().map_err(|_| AccountsError::Poisoned)
    }

    /// The folder support, or `None` when it was never injected.
    pub(crate) fn folder(&self) -> Option<Arc<FolderDeps>> {
        self.lock().ok().and_then(|state| state.folder.clone())
    }

    /// Claim the `(cli, id)` in-flight slot; `None` when one is already running.
    pub(crate) fn try_begin(&self, cli: &str, id: &str) -> Option<folder_ops::FlightGuard> {
        let key = (cli.to_string(), id.to_string());
        let mut set = self
            .inner
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !set.insert(key.clone()) {
            return None;
        }
        Some(folder_ops::FlightGuard::new(self.clone(), key))
    }

    /// Release an in-flight slot (called by [`folder_ops::FlightGuard`]).
    pub(crate) fn end_flight(&self, key: &(String, String)) {
        self.inner
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(key);
    }

    pub(crate) fn broadcast(&self, event: ServerEvent) {
        self.inner.deps.broadcaster.send(event);
    }

    pub(crate) fn identity(&self, resolved: ResolvedAccount) -> IdentityFuture {
        (self.inner.deps.identity)(resolved)
    }

    pub(crate) fn shared_entries(&self, cli: &str) -> Option<SharedEntries> {
        (self.inner.deps.shared_entries)(cli)
    }

    /// Look an account up ignoring `auth` and `pending` — the ONLY lookup that
    /// sign-in, the identity command, `/refresh` and limits probes may use.
    /// `None` id = the System login; an unknown id = `None`.
    #[must_use]
    pub fn locate(&self, cli: &str, account_id: Option<&str>) -> Option<ResolvedAccount> {
        let Ok(state) = self.lock() else {
            tracing::error!("accounts registry lock poisoned during locate");
            return None;
        };
        registry::locate_locked(&state, &self.inner.deps.root, cli, account_id)
    }

    /// The CLI's configured default account (`None` = System login).
    #[must_use]
    pub fn default_for(&self, cli: &str) -> Option<String> {
        let Ok(state) = self.lock() else {
            tracing::error!("accounts registry lock poisoned during default_for");
            return None;
        };
        state.registry.defaults.get(cli).cloned()
    }

    /// Every account of every CLI that supports accounts, each CLI's virtual
    /// System row first, then that CLI's accounts by `created_at`. Pending
    /// folder sign-ins are included (`pending: true`).
    #[must_use]
    pub fn list(&self) -> Vec<AccountSummary> {
        let Ok(state) = self.lock() else {
            tracing::error!("accounts registry lock poisoned during list");
            return Vec::new();
        };
        registry::list_locked(&state, &self.inner.deps.supports)
    }

    /// One account's summary (`None` id = the System row). `None` for an
    /// unknown account; a pending sign-in row is included.
    #[must_use]
    pub fn summary(&self, cli: &str, account_id: Option<&str>) -> Option<AccountSummary> {
        if !self.supports(cli) {
            return None;
        }
        let state = self.lock().ok()?;
        registry::summary_locked(&state, cli, account_id)
    }

    /// Record an auth change (the ONLY writer is a plugin identity read).
    ///
    /// # Errors
    ///
    /// Only a poisoned registry lock.
    pub fn note_auth(
        &self,
        cli: &str,
        account_id: Option<&str>,
        auth: AccountAuth,
    ) -> Result<(), AccountsError> {
        let mut state = self.lock()?;
        let event = identity_ops::note_auth_locked(&mut state, self.root(), cli, account_id, auth);
        drop(state);
        if let Some(ev) = event {
            self.broadcast(ev);
        }
        Ok(())
    }

    /// Record a full identity read for a named account or (with `None` id) the
    /// in-memory System row. Broadcasts only on a real change.
    ///
    /// # Errors
    ///
    /// Only a poisoned registry lock.
    pub fn note_identity(
        &self,
        cli: &str,
        account_id: Option<&str>,
        identity: &AccountIdentity,
    ) -> Result<(), AccountsError> {
        let mut state = self.lock()?;
        let event =
            identity_ops::note_identity_locked(&mut state, self.root(), cli, account_id, identity);
        drop(state);
        if let Some(ev) = event {
            self.broadcast(ev);
        }
        Ok(())
    }
}

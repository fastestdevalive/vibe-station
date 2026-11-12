//! Accounts wiring: the ONE place `vst-daemon` builds the accounts registry and
//! injects per-CLI behaviour into it (multi-account plan A3.1, Decisions 1/12).
//!
//! Everything CLI-specific arrives as a closure over `resolve_plugin`; this
//! file never names a harness (R2). The derivation task is a poller-shaped
//! owner (AGENTS.md "Pollers"): an in-flight guard per `(cli, account)`, an
//! identity run only on a limits-status CHANGE, last-known state kept on a
//! transient failure, and a broadcast on real change only (the registry does
//! that).
//!
//! Sign-out is decided ONLY by the plugin's identity command (Decision 12): a
//! limits read is a trigger, never the verdict. A signed-out NON-System account
//! releases its sessions' runtimes and writes no lifecycle (AGENTS.md "Status
//! indicators": one lifecycle writer).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use vst_accounts::{
    AccountsDeps, AccountsHandle, FolderDeps, IdentityFn, IdentityFuture, SharedEntriesFn,
    SupportsFn,
};
use vst_agents::{resolve_plugin, SUPPORTED_CLIS};
use vst_git::paths::Paths;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{
    AccountAuth, AccountIdentity, AccountLinkMeta, AccountSummary, CliId, LimitStatus,
    LimitsSnapshot, ResolvedAccount, SignInState, SignInSteps,
};

use vst_routes::sessions::SessionRoutes;

/// The `(cli, account id)` key of every per-account guard; `None` = System.
type Key = (String, Option<String>);

/// Build the accounts registry with its three injected closures.
///
/// `store` is accepted for symmetry with the other wiring builders; the
/// registry persists to `<vst_home>/accounts/accounts.json`, not SQLite.
#[must_use]
pub fn build_accounts_handle(
    _store: &vst_store::StoreHandle,
    broadcaster: &Broadcaster,
) -> AccountsHandle {
    let supports: SupportsFn =
        Arc::new(|cli| CliId::from_str(cli).is_ok_and(|id| resolve_plugin(id).supports_accounts()));
    let shared_entries: SharedEntriesFn = Arc::new(|cli| {
        CliId::from_str(cli)
            .ok()
            .and_then(|id| resolve_plugin(id).account_shared_entries())
    });
    let identity: IdentityFn = Arc::new(|acct| {
        let cli = acct.cli.clone();
        let future: IdentityFuture = Box::pin(async move {
            match CliId::from_str(&cli) {
                Ok(id) => vst_agents::account_cmd::run_identity(&*resolve_plugin(id), &acct).await,
                Err(_) => AccountIdentity::default(),
            }
        });
        future
    });
    AccountsHandle::new(AccountsDeps {
        root: absolute(Paths::default_home().vst_home().join("accounts")),
        broadcaster: broadcaster.clone(),
        identity,
        shared_entries,
        supports,
    })
    .with_folder_support(FolderDeps {
        home: absolute(vst_agents::home::home_dir()),
        link_meta: Arc::new(link_meta_of),
        looks_valid: Arc::new(|cli, names| {
            CliId::from_str(cli)
                .is_ok_and(|id| resolve_plugin(id).account_folder_looks_valid(names))
        }),
        sign_in_steps: Arc::new(sign_in_steps_of),
    })
}

/// A relative path (HOME unset or empty) made absolute against the daemon's
/// current directory, once, so an account dir never resolves against an
/// agent's cwd.
fn absolute(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    // `std::path::absolute` is stable only since Rust 1.79; the workspace MSRV is 1.77.
    std::env::current_dir().map_or(path.clone(), |cwd| cwd.join(path))
}

/// The folder-link facts of `cli` (`None` = folder accounts unsupported). The
/// identity-verification flag is derived here, from the plugin's identity
/// command, so no plugin states it twice (A2c.1).
fn link_meta_of(cli: &str) -> Option<AccountLinkMeta> {
    let plugin = resolve_plugin(CliId::from_str(cli).ok()?);
    if !plugin.supports_accounts() {
        return None;
    }
    let mut meta = plugin.account_link_meta();
    meta.verifies_identity = plugin
        .account_identity_command(&ResolvedAccount::system(cli))
        .is_some();
    Some(meta)
}

/// The copyable sign-in steps of one folder account, built from its plugin.
fn sign_in_steps_of(acct: &ResolvedAccount) -> SignInSteps {
    let home = vst_agents::home::home_dir();
    CliId::from_str(&acct.cli).map_or_else(
        |_| SignInSteps::default(),
        |id| vst_agents::account_cmd::sign_in_steps(&*resolve_plugin(id), acct, &home),
    )
}

/// Run the identity command for one account and apply it.
///
/// The ONLY "identity then auth" function (Decision 12): `/refresh`, the boot
/// sweep, the post-sign-in check and every limits-status trigger call it. A
/// signed-out NON-System account has its sessions' runtimes released here;
/// the System login only changes its row (banner/Settings), never halts.
pub async fn check_identity(
    accounts: &AccountsHandle,
    session_routes: &SessionRoutes,
    cli: &str,
    account_id: Option<&str>,
) -> Option<AccountSummary> {
    let before = auth_of(accounts, cli, account_id);
    let summary = accounts.refresh_identity(cli, account_id).await.ok()?;
    if summary.auth == AccountAuth::SignedOut && before != Some(AccountAuth::SignedOut) {
        if let Some(id) = account_id {
            let released = session_routes.halt_sessions_for_account(cli, id).await;
            tracing::info!(
                cli = %cli,
                account = %id,
                sessions = released.len(),
                "account signed out; released its sessions (no lifecycle write)"
            );
        }
    }
    Some(summary)
}

/// The cached auth of one account (System included), if known.
fn auth_of(accounts: &AccountsHandle, cli: &str, account_id: Option<&str>) -> Option<AccountAuth> {
    accounts.summary(cli, account_id).map(|a| a.auth)
}

/// The guarded identity checker the derivation task owns (Decision 12).
///
/// * in-flight: a second trigger for the same `(cli, account)` while one runs
///   is dropped;
/// * change-only: a limits trigger runs the identity command only when that
///   result's status differs from the last one seen for the key (a steady
///   `no_plan_limits` must not re-spawn the CLI every minute).
#[derive(Clone)]
pub struct IdentityChecker {
    accounts: AccountsHandle,
    session_routes: SessionRoutes,
    last_status: Arc<Mutex<HashMap<Key, LimitStatus>>>,
    in_flight: Arc<Mutex<HashSet<Key>>>,
}

impl IdentityChecker {
    /// A checker over `accounts`, halting through `session_routes`.
    #[must_use]
    pub fn new(accounts: AccountsHandle, session_routes: SessionRoutes) -> Self {
        Self {
            accounts,
            session_routes,
            last_status: Arc::new(Mutex::new(HashMap::new())),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Run the identity command now, unless one is already in flight for the
    /// same `(cli, account)`.
    pub async fn check(&self, cli: &str, account_id: Option<&str>) -> Option<AccountSummary> {
        let key = key_of(cli, account_id);
        if !self.begin(&key) {
            return None;
        }
        let result = check_identity(&self.accounts, &self.session_routes, cli, account_id).await;
        self.end(&key);
        result
    }

    /// Run the identity command only when `status` changed for the key.
    pub async fn check_on_status(
        &self,
        cli: &str,
        account_id: Option<&str>,
        status: LimitStatus,
    ) -> Option<AccountSummary> {
        let key = key_of(cli, account_id);
        {
            let mut last = lock(&self.last_status);
            if last.get(&key) == Some(&status) {
                return None;
            }
            last.insert(key, status);
        }
        self.check(cli, account_id).await
    }

    /// Mark the key in flight; `false` = another check owns it.
    fn begin(&self, key: &Key) -> bool {
        lock(&self.in_flight).insert(key.clone())
    }

    fn end(&self, key: &Key) {
        lock(&self.in_flight).remove(key);
    }
}

/// A poisoned guard is treated as empty: this is best-effort bookkeeping, never
/// a fact the daemon serves.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn key_of(cli: &str, account_id: Option<&str>) -> Key {
    (cli.to_string(), account_id.map(str::to_string))
}

/// The CLIs that support accounts (data-driven: the registry's own predicate).
fn supported_clis(accounts: &AccountsHandle) -> Vec<String> {
    SUPPORTED_CLIS
        .iter()
        .map(|cli| cli.as_str().to_string())
        .filter(|cli| accounts.supports(cli))
        .collect()
}

/// Start the accounts derivation task (A3.1):
/// 1. boot: the System identity of every supported CLI (background, bounded,
///    never blocks serving, never halts);
/// 2. limits: derive "limited" and trigger the identity check on a status
///    change;
/// 3. after a finished sign-in: the System identity of that CLI;
/// 4. sign-out (identity only): release a non-System account's sessions.
pub fn spawn_derivation_task(
    accounts: AccountsHandle,
    broadcaster: Broadcaster,
    session_routes: SessionRoutes,
) -> JoinHandle<()> {
    let checker = IdentityChecker::new(accounts.clone(), session_routes);
    let boot_checker = checker.clone();
    tokio::spawn(async move {
        for cli in supported_clis(&boot_checker.accounts) {
            let _ = boot_checker.check(&cli, None).await;
        }
    });
    tokio::spawn(async move {
        let mut rx = broadcaster.subscribe();
        loop {
            match rx.recv().await {
                Ok(ServerEvent::LimitsUpdated { limits }) => {
                    on_limits_updated(&checker, &accounts, &limits).await;
                }
                Ok(ServerEvent::AccountSignin {
                    state: SignInState::Done,
                    cli,
                    ..
                }) => {
                    let _ = checker.check(&cli, None).await;
                }
                Ok(_) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            }
        }
    })
}

/// Derive "limited" from one limits snapshot and trigger the identity check
/// where the status changed (Decision 10/12). Public so the derivation tests can
/// drive one snapshot without the broadcast loop.
pub async fn on_limits_updated(
    checker: &IdentityChecker,
    accounts: &AccountsHandle,
    limits: &LimitsSnapshot,
) {
    let now = vst_accounts::now_iso();
    for result in &limits.harnesses {
        // A transient probe failure keeps the last-known "limited" value
        // (AGENTS.md "Pollers"), never clears it.
        if matches!(
            result.status,
            LimitStatus::Error | LimitStatus::Unsupported | LimitStatus::NotInstalled
        ) {
            continue;
        }
        if let Err(e) = accounts.set_limited(
            &result.harness,
            result.account_id.as_deref(),
            vst_accounts::limited_from_result(result, &now),
        ) {
            tracing::error!("could not record the account limited state: {e}");
        }
        if !vst_accounts::needs_identity_check(result) {
            continue;
        }
        // Only the System login and sign-in accounts have an identity command;
        // an API-key account is decided by its key, never by a vendor login.
        let eligible = accounts
            .locate(&result.harness, result.account_id.as_deref())
            .is_some_and(|a| a.api_key.is_none());
        // A pending row is invisible to background paths (Decision 2).
        let pending = accounts
            .summary(&result.harness, result.account_id.as_deref())
            .is_some_and(|s| s.pending);
        if !eligible || pending {
            continue;
        }
        let _ = checker
            .check_on_status(&result.harness, result.account_id.as_deref(), result.status)
            .await;
    }
}

#[cfg(test)]
mod absolute_tests {
    use super::absolute;
    use std::path::PathBuf;

    #[test]
    fn relative_becomes_absolute_and_absolute_is_unchanged() {
        assert!(absolute(PathBuf::from("rel/x")).is_absolute());
        assert_eq!(absolute(PathBuf::from("/a/b")), PathBuf::from("/a/b"));
    }
}

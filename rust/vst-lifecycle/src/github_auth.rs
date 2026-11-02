//! GitHub credential resolution — ports `services/githubAuth.ts`.
//!
//! Behavior contract (poller-redesign plan, Decision 8):
//! - `gh` CLI is the primary credential source (`gh auth status`). Accounts whose
//!   network validation failed (`Timeout/Failed to log in to github.com account X`)
//!   still count as configured logins; tokens come from the local `gh auth token`.
//!   (`vst doctor` may therefore report such an account as logged in.)
//! - `GITHUB_TOKEN` / `GH_TOKEN` env vars synthesize a fallback account when
//!   `gh` is absent or yields no usable login.
//! - `GH_TOKEN_<LOGIN>` env var per login (LOGIN uppercased) overrides.
//! - `NoCredentials` only when `gh auth status` ran cleanly (exit 0, or a
//!   non-zero exit that says "not logged in") or `gh` is not installed, with
//!   zero logins AND no env token. A timeout / exec error / failed run that
//!   does not say "signed out" is `Transient` (the env fallback still applies
//!   to the latter), never `NoCredentials` — that false positive is what flipped
//!   sessions to `no_credentials` when `gh` was merely slow.
//! - Every `gh` process is bounded (5 s timeout) and `kill_on_drop(true)`.
//! - `AccountCache` is a TTL cache with an injectable clock and TTL, owned by
//!   the poller; `invalidate()` forces a re-list after a 401.
//! - Never panics.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tokio::time::Instant;

/// Timeout applied to every `gh` exec.
pub const GH_TIMEOUT: Duration = Duration::from_secs(5);

/// Default account-cache TTL (Decision 8: 10 minutes).
pub const ACCOUNT_CACHE_TTL: Duration = Duration::from_secs(600);

/// A GitHub account credential resolved from the chain.
#[derive(Clone, Debug, PartialEq)]
pub struct GithubAccount {
    pub login: String,
    pub token: Option<String>,
}

/// Outcome of resolving GitHub credentials (Decision 8).
///
/// `Transient` is deliberately distinct from `NoCredentials`: a slow or
/// failing `gh` must never write `no_credentials` over a known-good value.
#[derive(Clone, Debug, PartialEq)]
pub enum AccountsOutcome {
    /// At least one login with a usable token was found (token-less logins are
    /// skipped; if none has a token and there is no env token the outcome is
    /// `Transient`; `Accounts` may hold a synthetic `env:GITHUB_TOKEN` account).
    Accounts(Vec<GithubAccount>),
    /// `gh` ran cleanly with zero logins and no env token.
    NoCredentials,
    /// Timeout / exec error: retry next run, keep last-known values.
    Transient(String),
}

/// Internal failure classification for one `gh` exec.
enum GhFailure {
    /// The binary is not on PATH (`ErrorKind::NotFound`).
    NotFound,
    /// Timeout or any other spawn/IO error.
    Other(String),
    /// `gh` ran, failed, and did not say "signed out".
    BadStatus(String),
}

/// Run one `gh` invocation, bounded by `timeout` and killed on drop.
async fn run_gh(
    gh_path: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, GhFailure> {
    let mut cmd = tokio::process::Command::new(gh_path);
    cmd.args(args).kill_on_drop(true);

    match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => Err(GhFailure::Other(format!(
            "`{} {}` timed out after {timeout:?}",
            gh_path.display(),
            args.join(" ")
        ))),
        Ok(Err(err)) if err.kind() == std::io::ErrorKind::NotFound => Err(GhFailure::NotFound),
        Ok(Err(err)) => Err(GhFailure::Other(err.to_string())),
        Ok(Ok(output)) => Ok(output),
    }
}

/// Parse logged-in logins out of `gh auth status` output.
fn parse_logged_in_logins(output: &std::process::Output) -> Vec<String> {
    // Combine stdout + stderr for parsing (gh may print warnings on stderr).
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&output.stderr));

    // `gh auth status` validates every token over the network. When that fails
    // it still lists the account, on a line like `Timeout trying to log in to
    // github.com account alice (keyring)` / `Failed to log in to ...`, so every
    // line mentioning `log in to github.com account ` names a configured login
    // (the local `gh auth token` then supplies its token without the network).
    const LOGGED_IN: &str = "Logged in to github.com account ";
    const LOG_IN_TO: &str = "log in to github.com account ";
    let mut logins = Vec::new();
    for line in text.lines() {
        let rest = if let Some(pos) = line.find(LOGGED_IN) {
            &line[pos + LOGGED_IN.len()..]
        } else if let Some(pos) = line.find(LOG_IN_TO) {
            &line[pos + LOG_IN_TO.len()..]
        } else {
            continue;
        };
        // Parse the login name — regex ([A-Za-z0-9-]+)
        let login: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        if !login.is_empty() && !logins.contains(&login) {
            logins.push(login);
        }
    }
    logins
}

/// True when `gh auth status` output says the user is signed out (wording is
/// matched loosely on purpose).
fn says_not_logged_in(output: &std::process::Output) -> bool {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_lowercase();
    text.contains("not logged in") || text.contains("not found among authenticated hosts")
}

/// Run `gh auth status --hostname github.com` and parse logged-in logins.
///
/// Parses output regardless of exit code — `gh` exits non-zero if any
/// account's token is stale but still prints valid accounts. A missing `gh`
/// binary means "zero logins" (the env-token fallback still applies).
async fn gh_logged_in_logins(gh_path: &Path, timeout: Duration) -> Result<Vec<String>, GhFailure> {
    match run_gh(
        gh_path,
        &["auth", "status", "--hostname", "github.com"],
        timeout,
    )
    .await
    {
        Ok(output) => {
            let logins = parse_logged_in_logins(&output);
            if logins.is_empty() && !output.status.success() && !says_not_logged_in(&output) {
                return Err(GhFailure::BadStatus(format!(
                    "`gh auth status` failed: {}",
                    output.status
                )));
            }
            Ok(logins)
        }
        Err(GhFailure::NotFound) => Ok(Vec::new()),
        Err(GhFailure::Other(err)) => Err(GhFailure::Other(err)),
        Err(GhFailure::BadStatus(err)) => Err(GhFailure::BadStatus(err)),
    }
}

/// Run `gh auth token --user <login> --hostname github.com` and return the token.
///
/// A non-zero exit is treated as "no token" (stale login), matching today's
/// behaviour; only a timeout/spawn error is transient.
async fn gh_token_for_user(
    gh_path: &Path,
    login: &str,
    timeout: Duration,
) -> Result<Option<String>, GhFailure> {
    let output = match run_gh(
        gh_path,
        &["auth", "token", "--user", login, "--hostname", "github.com"],
        timeout,
    )
    .await
    {
        Ok(output) => output,
        Err(GhFailure::NotFound) => return Ok(None),
        Err(GhFailure::Other(err) | GhFailure::BadStatus(err)) => {
            return Err(GhFailure::Other(err))
        }
    };

    if output.status.success() {
        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if token.is_empty() {
            Ok(None)
        } else {
            Ok(Some(token))
        }
    } else {
        Ok(None)
    }
}

/// Read `GITHUB_TOKEN` then `GH_TOKEN` via an injected env reader; returns the
/// first non-empty one.
fn env_generic_token_with<F>(env_fn: &F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    env_fn("GITHUB_TOKEN")
        .filter(|t| !t.is_empty())
        .or_else(|| env_fn("GH_TOKEN").filter(|t| !t.is_empty()))
}

/// Check `GITHUB_TOKEN` then `GH_TOKEN` process env vars; returns first
/// non-empty one.
pub fn env_generic_token() -> Option<String> {
    env_generic_token_with(&|key: &str| std::env::var(key).ok())
}

/// Apply `GH_TOKEN_<LOGIN>` env var override (LOGIN uppercased).
fn apply_per_login_env<F>(acc: &mut GithubAccount, env_fn: &F)
where
    F: Fn(&str) -> Option<String>,
{
    let env_key = format!("GH_TOKEN_{}", acc.login.to_ascii_uppercase());
    if let Some(token) = env_fn(&env_key) {
        if !token.is_empty() {
            acc.token = Some(token);
        }
    }
}

/// Resolve GitHub accounts using the full credential chain, with an injected
/// `gh` binary path, env reader and exec timeout (test seam — no PATH/env
/// mutation).
///
/// 1. `gh auth status` → logins; `gh auth token` → tokens
/// 2. `GH_TOKEN_<LOGIN>` env overrides per account
/// 3. If no account has a usable token: `GITHUB_TOKEN`/`GH_TOKEN` synthesizes
///    a fallback account
pub async fn list_accounts_with_timeout<F>(
    gh_path: &Path,
    env_fn: F,
    timeout: Duration,
) -> AccountsOutcome
where
    F: Fn(&str) -> Option<String>,
{
    let logins = match gh_logged_in_logins(gh_path, timeout).await {
        Ok(logins) => logins,
        Err(GhFailure::NotFound) => Vec::new(),
        Err(GhFailure::Other(err)) => return AccountsOutcome::Transient(err),
        Err(GhFailure::BadStatus(err)) => match env_generic_token_with(&env_fn) {
            Some(_) => Vec::new(),
            None => return AccountsOutcome::Transient(err),
        },
    };

    let had_logins = !logins.is_empty();

    let mut accounts = Vec::new();
    for login in logins {
        let token = match gh_token_for_user(gh_path, &login, timeout).await {
            Ok(token) => token,
            Err(GhFailure::NotFound) => None,
            Err(GhFailure::Other(err) | GhFailure::BadStatus(err)) => {
                return AccountsOutcome::Transient(err);
            }
        };
        let mut account = GithubAccount { login, token };
        apply_per_login_env(&mut account, &env_fn);
        if account.token.is_some() {
            accounts.push(account);
        }
    }

    // Synthetic account from the generic env token when no login yielded a
    // usable token (gh absent, zero logins, or a locked keyring).
    if accounts.is_empty() {
        if let Some(token) = env_generic_token_with(&env_fn) {
            accounts.push(GithubAccount {
                login: "env:GITHUB_TOKEN".into(),
                token: Some(token),
            });
        }
    }

    if had_logins && accounts.is_empty() {
        return AccountsOutcome::Transient("gh auth token failed for all accounts".to_string());
    }

    if accounts.is_empty() {
        AccountsOutcome::NoCredentials
    } else {
        AccountsOutcome::Accounts(accounts)
    }
}

/// Resolve GitHub accounts with the production `gh` binary, process env and
/// the 5 s exec timeout.
pub async fn list_accounts_with<F>(gh_path: &Path, env_fn: F) -> AccountsOutcome
where
    F: Fn(&str) -> Option<String>,
{
    list_accounts_with_timeout(gh_path, env_fn, GH_TIMEOUT).await
}

/// A TTL cache of resolved accounts, owned by the poller (Decision 8).
///
/// `get`/`put` take an explicit [`Instant`] so TTL behaviour is testable
/// without pausing tokio time. Transient outcomes are never cached — the next
/// run retries `gh`.
#[derive(Debug)]
pub struct AccountCache {
    ttl: Duration,
    entry: Mutex<Option<(Instant, AccountsOutcome)>>,
}

impl AccountCache {
    /// Build a cache with an injectable TTL.
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entry: Mutex::new(None),
        }
    }

    /// The cached outcome, if it is still within `ttl` of `now`.
    pub fn get(&self, now: Instant) -> Option<AccountsOutcome> {
        let guard = self.entry.lock().ok()?;
        let (at, outcome) = guard.as_ref()?;
        if now.saturating_duration_since(*at) < self.ttl {
            Some(outcome.clone())
        } else {
            None
        }
    }

    /// Cache a resolved outcome. `Transient` is deliberately a no-op: the next
    /// run must retry `gh` instead of serving a failure for 10 minutes.
    pub fn put(&self, now: Instant, outcome: AccountsOutcome) {
        if matches!(outcome, AccountsOutcome::Transient(_)) {
            return;
        }
        if let Ok(mut guard) = self.entry.lock() {
            *guard = Some((now, outcome));
        }
    }

    /// Drop the cached outcome — called after a 401 so the run re-lists once.
    pub fn invalidate(&self) {
        if let Ok(mut guard) = self.entry.lock() {
            *guard = None;
        }
    }
}

impl AccountCache {
    /// Drop the cached outcome only when it is `NoCredentials`. A deliberate
    /// user action (focus hint, Refresh) uses this so a fresh `gh auth login`
    /// is noticed without waiting out the TTL; a cached `Accounts` stays.
    pub fn invalidate_if_no_credentials(&self) {
        if let Ok(mut guard) = self.entry.lock() {
            if matches!(guard.as_ref(), Some((_, AccountsOutcome::NoCredentials))) {
                *guard = None;
            }
        }
    }
}

impl Default for AccountCache {
    fn default() -> Self {
        Self::new(ACCOUNT_CACHE_TTL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn write_script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write fake gh script");
        let mut perms = std::fs::metadata(&path).expect("stat").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    /// `list_accounts_with`, retried while the freshly written fake `gh` is
    /// still "Text file busy" (ETXTBSY): on Linux a concurrent test thread that
    /// forks while this thread holds the script open for writing makes the first
    /// `exec` fail for a few milliseconds. Test-only; the product code is
    /// correct to treat a spawn error as transient.
    async fn list_retry<F>(gh: &Path, env: F) -> AccountsOutcome
    where
        F: Fn(&str) -> Option<String> + Copy,
    {
        let mut outcome = list_accounts_with(gh, env).await;
        for _ in 0..40 {
            match &outcome {
                AccountsOutcome::Transient(msg) if msg.contains("busy") => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    outcome = list_accounts_with(gh, env).await;
                }
                _ => break,
            }
        }
        outcome
    }

    fn no_env(_key: &str) -> Option<String> {
        None
    }

    #[test]
    fn invalidate_if_no_credentials_clears_only_no_credentials() {
        let now = Instant::now();
        let cache = AccountCache::default();
        cache.put(now, AccountsOutcome::NoCredentials);
        cache.invalidate_if_no_credentials();
        assert!(cache.get(now).is_none());

        let accounts = AccountsOutcome::Accounts(vec![GithubAccount {
            login: "alice".into(),
            token: Some("tok".into()),
        }]);
        cache.put(now, accounts.clone());
        cache.invalidate_if_no_credentials();
        assert_eq!(cache.get(now), Some(accounts));
    }

    #[tokio::test]
    async fn clean_zero_logins_is_no_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = write_script(dir.path(), "gh", "#!/bin/sh\nexit 0\n");

        let outcome = list_retry(&gh, no_env).await;
        assert_eq!(outcome, AccountsOutcome::NoCredentials);
    }

    #[tokio::test]
    async fn missing_gh_binary_without_env_token_is_no_credentials() {
        let missing = Path::new("/nonexistent/vst-test-gh");
        let outcome = list_retry(missing, no_env).await;
        assert_eq!(outcome, AccountsOutcome::NoCredentials);
    }

    #[tokio::test]
    async fn env_token_with_zero_logins_is_accounts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = write_script(dir.path(), "gh", "#!/bin/sh\nexit 0\n");
        let env = |key: &str| (key == "GITHUB_TOKEN").then(|| "env-token-value".to_string());

        let outcome = list_retry(&gh, env).await;
        assert_eq!(
            outcome,
            AccountsOutcome::Accounts(vec![GithubAccount {
                login: "env:GITHUB_TOKEN".into(),
                token: Some("env-token-value".into()),
            }])
        );
    }

    #[tokio::test]
    async fn gh_logins_and_per_login_env_override() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = write_script(
            dir.path(),
            "gh",
            "#!/bin/sh\n\
             if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then\n\
             \tprintf 'github.com\\n  \\342\\234\\223 Logged in to github.com account alice (keyring)\\n'\n\
             \texit 0\n\
             fi\n\
             exit 1\n",
        );
        let env = |key: &str| (key == "GH_TOKEN_ALICE").then(|| "pat-alice".to_string());

        let outcome = list_retry(&gh, env).await;
        assert_eq!(
            outcome,
            AccountsOutcome::Accounts(vec![GithubAccount {
                login: "alice".into(),
                token: Some("pat-alice".into()),
            }])
        );
    }

    fn status_script(dir: &Path, status_body: &str) -> std::path::PathBuf {
        write_script(
            dir,
            "gh",
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then\n\
                 {status_body}\n\
                 exit 1\n\
                 fi\n\
                 if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"token\" ]; then\n\
                 echo tok\n\
                 exit 0\n\
                 fi\n\
                 exit 1\n"
            ),
        )
    }

    #[tokio::test]
    async fn timeout_validation_line_still_yields_the_account() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = status_script(
            dir.path(),
            "printf 'github.com\\n  X Timeout trying to log in to github.com account alice (keyring)\\n'",
        );
        let outcome = list_retry(&gh, no_env).await;
        assert_eq!(
            outcome,
            AccountsOutcome::Accounts(vec![GithubAccount {
                login: "alice".into(),
                token: Some("tok".into()),
            }])
        );
    }

    #[tokio::test]
    async fn failed_validation_line_still_yields_the_account() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = status_script(
            dir.path(),
            "printf 'github.com\\n  X Failed to log in to github.com account alice (keyring)\\n'",
        );
        let outcome = list_retry(&gh, no_env).await;
        assert_eq!(
            outcome,
            AccountsOutcome::Accounts(vec![GithubAccount {
                login: "alice".into(),
                token: Some("tok".into()),
            }])
        );
    }

    #[tokio::test]
    async fn logged_in_and_timeout_lines_give_both_accounts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = status_script(
            dir.path(),
            "printf 'github.com\\n  ok Logged in to github.com account alice (keyring)\\n  X Timeout trying to log in to github.com account bob (keyring)\\n'",
        );
        let outcome = list_retry(&gh, no_env).await;
        let logins: Vec<String> = match outcome {
            AccountsOutcome::Accounts(a) => a.into_iter().map(|a| a.login).collect(),
            other => panic!("expected Accounts, got {other:?}"),
        };
        assert_eq!(logins, vec!["alice".to_string(), "bob".to_string()]);
    }

    #[tokio::test]
    async fn not_logged_in_message_is_no_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = status_script(
            dir.path(),
            "printf 'You are not logged into any GitHub hosts. To log in, run: gh auth login\\n'",
        );
        let outcome = list_retry(&gh, no_env).await;
        assert_eq!(outcome, AccountsOutcome::NoCredentials);
    }

    #[tokio::test]
    async fn sleeping_gh_past_the_timeout_is_transient() {
        let dir = tempfile::tempdir().expect("tempdir");
        // `exec` replaces the shell so killing the child also kills the sleep.
        let gh = write_script(dir.path(), "gh", "#!/bin/sh\nexec sleep 30\n");

        let outcome = list_accounts_with_timeout(&gh, no_env, Duration::from_millis(100)).await;
        match outcome {
            AccountsOutcome::Transient(msg) => {
                assert!(msg.contains("timed out"), "unexpected message: {msg}");
            }
            other => panic!("expected Transient, got {other:?}"),
        }
    }

    #[test]
    fn cache_honours_ttl_and_invalidate() {
        let cache = AccountCache::new(Duration::from_secs(600));
        let now = Instant::now();
        let accounts = vec![GithubAccount {
            login: "alice".into(),
            token: Some("tok".into()),
        }];

        assert_eq!(cache.get(now), None);
        cache.put(now, AccountsOutcome::Accounts(accounts.clone()));
        assert_eq!(
            cache.get(now),
            Some(AccountsOutcome::Accounts(accounts.clone()))
        );
        assert_eq!(
            cache.get(now + Duration::from_secs(599)),
            Some(AccountsOutcome::Accounts(accounts))
        );
        assert_eq!(cache.get(now + Duration::from_secs(601)), None);

        cache.put(now, AccountsOutcome::NoCredentials);
        assert_eq!(cache.get(now), Some(AccountsOutcome::NoCredentials));
        cache.invalidate();
        assert_eq!(cache.get(now), None);
    }

    #[tokio::test]
    async fn failed_status_with_unrecognised_output_is_transient() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = status_script(dir.path(), "printf 'error connecting to api.github.com\\n'");
        let outcome = list_retry(&gh, no_env).await;
        assert!(
            matches!(outcome, AccountsOutcome::Transient(_)),
            "{outcome:?}"
        );
        let cache = AccountCache::new(Duration::from_secs(600));
        let now = Instant::now();
        cache.put(now, outcome);
        assert_eq!(cache.get(now), None);
    }

    #[tokio::test]
    async fn failed_status_with_empty_output_is_transient() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = status_script(dir.path(), ":");
        let outcome = list_retry(&gh, no_env).await;
        assert!(
            matches!(outcome, AccountsOutcome::Transient(_)),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn failed_status_with_env_token_falls_back_to_env_account() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = status_script(dir.path(), "printf 'error connecting to api.github.com\\n'");
        let env = |k: &str| (k == "GITHUB_TOKEN").then(|| "envtok".to_string());
        let outcome = list_retry(&gh, env).await;
        assert_eq!(
            outcome,
            AccountsOutcome::Accounts(vec![GithubAccount {
                login: "env:GITHUB_TOKEN".into(),
                token: Some("envtok".into()),
            }])
        );
    }

    #[tokio::test]
    async fn status_lists_login_but_token_exits_one_is_transient() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = write_script(
            dir.path(),
            "gh",
            "#!/bin/sh\n\
             if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then\n\
             \tprintf 'github.com\\n  \\342\\234\\223 Logged in to github.com account alice (keyring)\\n'\n\
             \texit 0\n\
             fi\n\
             if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"token\" ]; then\n\
             \texit 1\n\
             fi\n\
             exit 1\n",
        );
        let outcome = list_retry(&gh, no_env).await;
        assert!(
            matches!(outcome, AccountsOutcome::Transient(_)),
            "expected Transient, got {outcome:?}"
        );
    }

    #[tokio::test]
    async fn clean_exit_with_no_output_is_no_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gh = write_script(dir.path(), "gh", "#!/bin/sh\nexit 0\n");
        let outcome = list_retry(&gh, no_env).await;
        assert_eq!(outcome, AccountsOutcome::NoCredentials);
    }

    #[test]
    fn transient_is_never_cached() {
        let cache = AccountCache::new(Duration::from_secs(600));
        let now = Instant::now();
        cache.put(now, AccountsOutcome::Transient("gh timed out".into()));
        assert_eq!(cache.get(now), None);
    }
}

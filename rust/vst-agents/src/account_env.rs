//! The ONE place a session's account reaches a process environment.
//!
//! Every spawn site (the three terminal launch merges in `vst-routes`, the ACP
//! connection, the limits probe) calls [`merge_account_env`] right after its
//! plugin env is applied, so the four sites cannot drift and a typed error is
//! the single place "never spawn on a broken account" (R7) is enforced
//! (Decision 3). CLI-specific env names live in the plugin's `account_env`
//! (this file holds none — R1/R2).

use std::collections::BTreeMap;

use vst_types::{AccountPort, AccountResolveError, ResolvedAccount};

use crate::plugin::AgentPlugin;

/// `key=<dir>` for a named account, empty for the System login. Names no
/// harness: each plugin passes its own env var name.
#[must_use]
pub(crate) fn dir_env(key: &str, acct: &ResolvedAccount) -> BTreeMap<String, String> {
    match &acct.dir {
        Some(dir) => BTreeMap::from([(key.to_string(), dir.to_string_lossy().into_owned())]),
        None => BTreeMap::new(),
    }
}

/// The absolute `env` binary the unset wrapper runs through. Absolute on purpose:
/// ACP logs and errors print `command args`, so the wrapper must be a fixed,
/// readable path rather than whatever `env` the PATH resolves to.
pub const ENV_BIN: &str = "/usr/bin/env";

/// Prefix `argv` with `/usr/bin/env -u NAME ...` for every name in `unset`, so the
/// child runs without those inherited variables (Decision 9). Empty `unset` returns
/// `argv` unchanged.
#[must_use]
pub fn wrap_unset(argv: Vec<String>, unset: &[&str]) -> Vec<String> {
    if unset.is_empty() {
        return argv;
    }
    let mut wrapped = vec![ENV_BIN.to_string()];
    for name in unset {
        wrapped.push("-u".to_string());
        wrapped.push((*name).to_string());
    }
    wrapped.extend(argv);
    wrapped
}

/// A launch as a person reads it: the program and its args, without the
/// `/usr/bin/env -u NAME ...` unset wrapper [`wrap_unset`] adds, trimmed (no
/// trailing space for an arg-less program).
#[must_use]
pub fn describe_command(command: &str, args: &[String]) -> String {
    let mut parts: Vec<&str> = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .collect();
    if parts.first() == Some(&ENV_BIN) {
        let mut i = 1;
        while parts.get(i) == Some(&"-u") && i + 1 < parts.len() {
            i += 2;
        }
        parts.drain(..i);
    }
    parts.join(" ").trim().to_string()
}

/// The inherited env names `acct` must not see: the plugin's list (empty for the
/// System login, which is the daemon's own login).
#[must_use]
pub fn account_unset(plugin: &dyn AgentPlugin, resolved: &ResolvedAccount) -> Vec<&'static str> {
    plugin.account_env_unset(resolved)
}

/// Apply `account_id`'s account to `env`.
///
/// `account_id: None` = the CLI's System login (Decision 4); with no port wired
/// (tests, single-account daemons) everything is the System login and `env` is
/// left untouched.
///
/// # Errors
///
/// Propagates the port's [`AccountResolveError`] (`NotFound` / `SignedOut` /
/// `Pending`). The caller must NOT spawn on an error and never falls back to
/// another account (R7).
pub fn merge_account_env(
    plugin: &dyn AgentPlugin,
    port: Option<&dyn AccountPort>,
    cli: &str,
    account_id: Option<&str>,
    env: &mut impl Extend<(String, String)>,
) -> Result<ResolvedAccount, AccountResolveError> {
    let Some(port) = port else {
        return Ok(ResolvedAccount::system(cli));
    };
    let resolved = port.resolve(cli, account_id)?;
    // Dir env: empty for the System login, so nothing is overridden there.
    env.extend(plugin.account_env(&resolved));
    if let (Some(key), Some(var)) = (resolved.api_key.as_ref(), plugin.account_api_key_env()) {
        // The key exists only in the child's env: never argv, never logged.
        env.extend([(var.to_string(), key.expose().to_string())]);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::*;
    use crate::plugin::{
        AsyncResult, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
        PromptDelivery, ReadySignal,
    };
    use vst_types::{ApiKey, Channel};

    /// The account var this fake harness redirects; the real names live in the
    /// per-harness files (`claude_accounts.rs`, ...), never here.
    const DIR_VAR: &str = "FAKE_ACCOUNT_DIR";
    const KEY_VAR: &str = "FAKE_API_KEY";

    struct FakePlugin;

    impl AgentPlugin for FakePlugin {
        fn name(&self) -> &str {
            "fake"
        }
        fn default_model(&self) -> &str {
            ""
        }
        fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
            "fake"
        }
        fn prompt_delivery(&self) -> PromptDelivery {
            PromptDelivery::Inline
        }
        fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
            vec![]
        }
        fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
            BTreeMap::new()
        }
        fn get_ready_signal(&self) -> ReadySignal {
            ReadySignal {
                sentinel: None,
                fallback_ms: 0,
            }
        }
        fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
            ComposePromptResult::default()
        }
        fn default_channel(&self) -> Channel {
            Channel::Json
        }
        fn list_models(&self) -> AsyncResult<ListModelsResult> {
            Box::pin(async { ListModelsResult::default() })
        }
        fn account_env(&self, acct: &ResolvedAccount) -> BTreeMap<String, String> {
            match &acct.dir {
                Some(dir) => {
                    BTreeMap::from([(DIR_VAR.to_string(), dir.to_string_lossy().into_owned())])
                }
                None => BTreeMap::new(),
            }
        }
        fn account_api_key_env(&self) -> Option<&'static str> {
            Some(KEY_VAR)
        }
    }

    /// A port with one named account (and the System login).
    struct FakePort {
        account: ResolvedAccount,
        error: Option<AccountResolveError>,
    }

    impl FakePort {
        fn named(dir: &str) -> Self {
            Self {
                account: ResolvedAccount {
                    cli: "fake".to_string(),
                    id: Some("acc_00000001".to_string()),
                    dir: Some(PathBuf::from(dir)),
                    api_key: None,
                },
                error: None,
            }
        }

        fn failing(error: AccountResolveError) -> Self {
            Self {
                account: ResolvedAccount::system("fake"),
                error: Some(error),
            }
        }
    }

    impl AccountPort for FakePort {
        fn resolve(
            &self,
            _cli: &str,
            _account_id: Option<&str>,
        ) -> Result<ResolvedAccount, AccountResolveError> {
            match self.error {
                Some(e) => Err(e),
                None => Ok(self.account.clone()),
            }
        }

        fn report_limit(
            &self,
            _cli: &str,
            _account_id: Option<&str>,
            _signal: vst_types::LimitSignal,
        ) {
        }
    }

    fn port(p: FakePort) -> Arc<dyn AccountPort> {
        Arc::new(p)
    }

    #[test]
    fn merge_account_env_applies_after_plugin_env() {
        // The plugin's own env already named a dir; the account must win.
        let mut env = BTreeMap::from([(DIR_VAR.to_string(), "/from-plugin".to_string())]);
        let port = port(FakePort::named("/accounts/fake/acc_00000001"));
        let resolved = merge_account_env(
            &FakePlugin,
            Some(&*port),
            "fake",
            Some("acc_00000001"),
            &mut env,
        )
        .expect("named account resolves");
        assert_eq!(resolved.id.as_deref(), Some("acc_00000001"));
        assert_eq!(env[DIR_VAR], "/accounts/fake/acc_00000001");
        assert!(!env.contains_key(KEY_VAR), "sign-in account carries no key");
    }

    #[test]
    fn merge_account_env_signed_out_is_err() {
        let mut env = BTreeMap::new();
        let port = port(FakePort::failing(AccountResolveError::SignedOut));
        let err = merge_account_env(&FakePlugin, Some(&*port), "fake", None, &mut env)
            .expect_err("a signed-out account must not spawn");
        assert_eq!(err, AccountResolveError::SignedOut);
        assert!(env.is_empty(), "nothing is applied on an error");
    }

    #[test]
    fn merge_account_env_no_port_is_system() {
        let mut env = BTreeMap::from([(DIR_VAR.to_string(), "/keep".to_string())]);
        let resolved = merge_account_env(&FakePlugin, None, "fake", Some("acc_00000001"), &mut env)
            .expect("no port = System login");
        assert_eq!(resolved, ResolvedAccount::system("fake"));
        assert_eq!(env[DIR_VAR], "/keep", "System login applies no env");
    }

    #[test]
    fn merge_account_env_injects_api_key_only_into_env() {
        let mut env = BTreeMap::new();
        let mut account = FakePort::named("/accounts/fake/acc_00000001");
        account.account.api_key = Some(ApiKey::from("sk-test-secret".to_string()));
        let port = port(account);
        let resolved =
            merge_account_env(&FakePlugin, Some(&*port), "fake", None, &mut env).unwrap();
        assert_eq!(env[KEY_VAR], "sk-test-secret");
        assert_eq!(env[DIR_VAR], "/accounts/fake/acc_00000001");
        // Nothing but the env map ever sees the key.
        let debug = format!("{resolved:?}");
        assert!(debug.contains("<redacted>"), "{debug}");
        assert!(!debug.contains("sk-test-secret"), "{debug}");
    }

    #[test]
    fn wrap_unset_prefixes_usr_bin_env_u() {
        let argv = vec!["claude".to_string(), "--x".to_string()];
        assert_eq!(
            wrap_unset(argv, &["A_TOKEN", "B_TOKEN"]),
            vec![
                "/usr/bin/env",
                "-u",
                "A_TOKEN",
                "-u",
                "B_TOKEN",
                "claude",
                "--x"
            ]
        );
    }

    #[test]
    fn describe_command_drops_the_unset_wrapper_and_trailing_space() {
        let wrapped = wrap_unset(vec!["claude-acp".to_string()], &["A_TOKEN", "B_TOKEN"]);
        let (command, args) = wrapped.split_first().unwrap();
        assert_eq!(describe_command(command, args), "claude-acp");
        assert_eq!(describe_command("claude-acp", &[]), "claude-acp");
        assert_eq!(
            describe_command("codex-acp", &["--x".to_string()]),
            "codex-acp --x"
        );
    }

    #[test]
    fn wrap_unset_empty_is_identity() {
        let argv = vec!["claude".to_string()];
        assert_eq!(wrap_unset(argv.clone(), &[]), argv);
    }
}

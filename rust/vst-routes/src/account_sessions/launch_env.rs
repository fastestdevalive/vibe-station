//! The env a terminal launch runs with, and how an API key reaches a tmux pane.
//!
//! Harness separation: every CLI-specific fact comes from the plugin.

use std::collections::HashMap;

use vst_agents::account_env::{account_unset, merge_account_env, wrap_unset};
use vst_agents::context::{build_vst_env, BuildVstEnvOptions};
use vst_agents::plugin::AgentPlugin;
use vst_agents::LaunchConfig;
use vst_types::{AccountPort, AccountResolveError, ResolvedAccount};

/// The env every terminal launch runs with: vst env, then the plugin's, then the
/// session's account LAST (Decision 3). `Err` => the caller must NOT spawn (R7).
pub(crate) fn account_launch_env(
    plugin: &dyn AgentPlugin,
    accounts: Option<&dyn AccountPort>,
    cli: &str,
    launch_cfg: &LaunchConfig,
) -> Result<(HashMap<String, String>, ResolvedAccount), AccountResolveError> {
    let mut env = build_vst_env(&BuildVstEnvOptions {
        project: launch_cfg.project.clone(),
        worktree: launch_cfg.ctx.worktree.clone(),
        session: launch_cfg.session.clone(),
        daemon_port: launch_cfg.daemon_port,
    });
    env.extend(plugin.get_environment(launch_cfg));
    let resolved = merge_account_env(
        plugin,
        accounts,
        cli,
        launch_cfg.session.account_id.as_deref(),
        &mut env,
    )?;
    Ok((env, resolved))
}

/// Reads the key file named by `$2` into the variable named by `$1`, then runs the rest.
const KEY_FROM_FILE_SH: &str =
    r#"v=$1; f=$2; shift 2; k=$(cat "$f") || exit 1; export "$v=$k"; exec "$@""#;

/// tmux gets a session's env as `-e KEY=VALUE` on its client argv (visible in `ps`,
/// echoed by `TmuxError`). An API key must never travel that way: drop it from `env`
/// and let the pane read it from the account's own 0600 key file instead.
pub(crate) fn tmux_key_safe_launch(
    plugin: &dyn AgentPlugin,
    resolved: &ResolvedAccount,
    env: &mut HashMap<String, String>,
    argv: Vec<String>,
) -> Vec<String> {
    let (Some(_), Some(var), Some(dir)) = (
        resolved.api_key.as_ref(),
        plugin.account_api_key_env(),
        resolved.dir.as_ref(),
    ) else {
        return argv;
    };
    env.remove(var);
    let key_file = vst_accounts::secret::key_path(dir);
    let mut wrapped = vec![
        "/bin/sh".to_string(),
        "-c".to_string(),
        KEY_FROM_FILE_SH.to_string(),
        "sh".to_string(),
        var.to_string(),
        key_file.to_string_lossy().into_owned(),
    ];
    wrapped.extend(argv);
    wrapped
}

/// Every spawn path (tmux and direct PTY) runs its argv through this, once and
/// unconditionally: the inherited tokens the account must not see are removed from
/// `env` and the argv is prefixed with `/usr/bin/env -u ...` (Decision 9). Call it
/// BEFORE [`tmux_key_safe_launch`], so the key wrapper stays the outer one.
pub(crate) fn account_unset_argv(
    plugin: &dyn AgentPlugin,
    resolved: &ResolvedAccount,
    env: &mut HashMap<String, String>,
    argv: Vec<String>,
) -> Vec<String> {
    let unset = account_unset(plugin, resolved);
    for name in &unset {
        env.remove(*name);
    }
    wrap_unset(argv, &unset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use vst_agents::resolve_plugin;
    use vst_types::{
        ApiKey, Channel, CliId, LifecycleState, LimitSignal, ProjectRecord, SessionLifecycle,
        SessionRecord, SessionType,
    };

    const SECRET: &str = "sk-secret";

    fn keyed(dir: &Path) -> ResolvedAccount {
        ResolvedAccount {
            cli: "claude".to_string(),
            id: Some("acc_1".to_string()),
            dir: Some(dir.to_path_buf()),
            api_key: Some(ApiKey::from(SECRET.to_string())),
        }
    }

    fn key_var(plugin: &dyn AgentPlugin) -> &'static str {
        plugin.account_api_key_env().expect("claude has a key var")
    }

    #[test]
    fn tmux_launch_never_carries_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("acct");
        std::fs::create_dir_all(&dir).unwrap();
        let plugin = resolve_plugin(CliId::Claude);
        let var = key_var(plugin.as_ref());
        let mut env = HashMap::from([(var.to_string(), SECRET.to_string())]);
        let argv = tmux_key_safe_launch(
            plugin.as_ref(),
            &keyed(&dir),
            &mut env,
            vec!["claude".to_string()],
        );
        assert!(!env.contains_key(var));
        assert!(argv.iter().all(|a| !a.contains(SECRET)), "{argv:?}");
        let key_file = vst_accounts::secret::key_path(&dir);
        assert!(argv.iter().any(|a| a == key_file.to_str().unwrap()));
    }

    #[test]
    fn tmux_launch_exports_the_key_from_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("acct");
        std::fs::create_dir_all(&dir).unwrap();
        let plugin = resolve_plugin(CliId::Claude);
        let var = key_var(plugin.as_ref());
        std::fs::write(vst_accounts::secret::key_path(&dir), SECRET).unwrap();
        let mut env = HashMap::new();
        let argv = tmux_key_safe_launch(
            plugin.as_ref(),
            &keyed(&dir),
            &mut env,
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                format!("printf %s \"${var}\""),
            ],
        );
        let out = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .env_remove(var)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), SECRET);
    }

    const CLAUDE_TOKENS: [&str; 3] = [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
    ];

    fn named_dir(dir: &Path) -> ResolvedAccount {
        ResolvedAccount {
            cli: "claude".to_string(),
            id: Some("acc_1".to_string()),
            dir: Some(dir.to_path_buf()),
            api_key: None,
        }
    }

    #[test]
    fn pty_launch_argv_is_unset_wrapped() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = resolve_plugin(CliId::Claude);
        let mut env: HashMap<String, String> = CLAUDE_TOKENS
            .iter()
            .map(|n| ((*n).to_string(), "t".to_string()))
            .collect();
        let argv = account_unset_argv(
            plugin.as_ref(),
            &named_dir(tmp.path()),
            &mut env,
            vec!["claude".to_string()],
        );
        assert_eq!(
            argv[..7],
            [
                "/usr/bin/env",
                "-u",
                CLAUDE_TOKENS[0],
                "-u",
                CLAUDE_TOKENS[1],
                "-u",
                CLAUDE_TOKENS[2]
            ]
        );
        assert_eq!(argv.last().map(String::as_str), Some("claude"));
        assert!(CLAUDE_TOKENS.iter().all(|n| !env.contains_key(*n)));
    }

    #[test]
    fn account_unset_argv_keeps_own_api_key_var() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = resolve_plugin(CliId::Claude);
        let mut resolved = keyed(tmp.path());
        resolved.api_key = Some(ApiKey::from(SECRET.to_string()));
        let var = key_var(plugin.as_ref());
        let mut env = HashMap::from([(var.to_string(), SECRET.to_string())]);
        let argv = account_unset_argv(plugin.as_ref(), &resolved, &mut env, vec!["c".to_string()]);
        assert!(!argv.iter().any(|a| a == var), "{argv:?}");
        assert_eq!(env.get(var).map(String::as_str), Some(SECRET));
    }

    #[test]
    fn account_unset_argv_system_unchanged() {
        let plugin = resolve_plugin(CliId::Claude);
        let mut env = HashMap::from([("A".to_string(), "b".to_string())]);
        let argv = vec!["claude".to_string()];
        let out = account_unset_argv(
            plugin.as_ref(),
            &ResolvedAccount::system("claude"),
            &mut env,
            argv.clone(),
        );
        assert_eq!(out, argv);
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn unset_wraps_inside_key_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = resolve_plugin(CliId::Claude);
        let resolved = keyed(tmp.path());
        let mut env = HashMap::new();
        let inner = account_unset_argv(
            plugin.as_ref(),
            &resolved,
            &mut env,
            vec!["claude".to_string()],
        );
        let outer = tmux_key_safe_launch(plugin.as_ref(), &resolved, &mut env, inner);
        assert_eq!(outer[..2], ["/bin/sh", "-c"]);
        assert_eq!(
            outer[6], "/usr/bin/env",
            "unset is the inner wrapper: {outer:?}"
        );
    }

    #[test]
    fn tmux_launch_unchanged_without_key() {
        let plugin = resolve_plugin(CliId::Claude);
        let mut env = HashMap::from([("A".to_string(), "b".to_string())]);
        let argv = vec!["claude".to_string(), "--x".to_string()];
        let out = tmux_key_safe_launch(
            plugin.as_ref(),
            &ResolvedAccount::system("claude"),
            &mut env,
            argv.clone(),
        );
        assert_eq!(out, argv);
        assert_eq!(env.len(), 1);
    }

    struct FakePort(Result<ResolvedAccount, AccountResolveError>);

    impl AccountPort for FakePort {
        fn resolve(
            &self,
            _cli: &str,
            _account_id: Option<&str>,
        ) -> Result<ResolvedAccount, AccountResolveError> {
            self.0.clone()
        }
        fn report_limit(&self, _cli: &str, _account_id: Option<&str>, _signal: LimitSignal) {}
    }

    fn launch_cfg() -> LaunchConfig {
        let project = ProjectRecord {
            id: "p1".into(),
            absolute_path: "/tmp/p1".into(),
            prefix: "p".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: Some(0),
            worktrees: vec![],
            next_worktree_num: Some(1),
            lsp_enabled: None,
            open_files: vec![],
        };
        let session = SessionRecord {
            id: "s1".into(),
            worktree_id: None,
            project_id: "p1".into(),
            is_main: false,
            sort_order: 1.0,
            r#type: SessionType::Agent,
            mode_id: None,
            mode_icon: None,
            account_id: Some("acc_1".into()),
            name: None,
            name_source: None,
            tmux_name: "vst-s1".into(),
            use_tmux: true,
            channel: Some(Channel::Tmux),
            lifecycle: SessionLifecycle {
                state: LifecycleState::Idle,
                reason: None,
                last_transition_at: "2026-01-01T00:00:00.000Z".into(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            draft_prompt: None,
            draft_config: None,
            archived_at: None,
            handoff_summary: None,
            carry_over: None,
            parent_session_id: None,
            superseded_by: None,
            pr: None,
            last_activity_at: None,
            last_line: None,
            last_tool: None,
        };
        LaunchConfig {
            project,
            ctx: vst_agents::PluginContext {
                cwd: "/tmp/p1".into(),
                project_id: "p1".into(),
                worktree: None,
            },
            session,
            daemon_port: 7000,
            model: None,
            account_dir: None,
        }
    }

    #[test]
    fn launch_env_carries_account_dir_and_key() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = resolve_plugin(CliId::Claude);
        let resolved = keyed(tmp.path());
        let port = FakePort(Ok(resolved.clone()));
        let (env, got) =
            account_launch_env(plugin.as_ref(), Some(&port), "claude", &launch_cfg()).unwrap();
        assert_eq!(got, resolved);
        for (k, v) in plugin.account_env(&resolved) {
            assert_eq!(env.get(&k), Some(&v));
        }
        assert_eq!(
            env.get(key_var(plugin.as_ref())).map(String::as_str),
            Some(SECRET)
        );
    }

    #[test]
    fn launch_env_system_adds_nothing() {
        let plugin = resolve_plugin(CliId::Claude);
        let port = FakePort(Ok(ResolvedAccount::system("claude")));
        let (env, _) =
            account_launch_env(plugin.as_ref(), Some(&port), "claude", &launch_cfg()).unwrap();
        assert!(!env.contains_key(key_var(plugin.as_ref())));
        assert!(plugin
            .account_env(&ResolvedAccount::system("claude"))
            .keys()
            .all(|k| !env.contains_key(k)));
    }

    #[test]
    fn launch_env_error_propagates() {
        let plugin = resolve_plugin(CliId::Claude);
        let port = FakePort(Err(AccountResolveError::SignedOut));
        let err =
            account_launch_env(plugin.as_ref(), Some(&port), "claude", &launch_cfg()).unwrap_err();
        assert_eq!(err, AccountResolveError::SignedOut);
    }
}

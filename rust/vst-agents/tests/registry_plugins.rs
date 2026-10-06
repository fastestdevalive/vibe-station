//! Behavior contract for the plugin registry + per-plugin pure methods —
//! ports the portable parts of `daemon/src/__tests__/plugins.test.ts`.
//!
//! NOT ported here (out of 04a scope, deferred): the `spawnSession`
//! orchestration tests (`spawn.test.ts`, needs `vst-proc` tmux + context path
//! helpers) and the full-server integration tests (T10.12/T10.13, need
//! `vst-routes`/`vst-store`).

mod common;

use vst_agents::agy::create_agy_plugin;
use vst_agents::claude::create_claude_plugin;
use vst_agents::codex::create_codex_plugin;
use vst_agents::cursor::create_cursor_plugin;
use vst_agents::home::with_home;
use vst_agents::opencode::create_opencode_plugin;
use vst_agents::paths::Paths;
use vst_agents::pi::create_pi_plugin;
use vst_agents::plugin::{CaptureArgs, CaptureNativeChatIdArgs, ComposePromptInput, RestoreArgs};
use vst_agents::{resolve_plugin, AgentPlugin, CliId};
use vst_types::Channel;

use common::{make_project, make_session, proj_launch, wt_launch};

fn launch_cfg_worktree() -> vst_agents::LaunchConfig {
    wt_launch("p1", make_session("sess-test"), "/tmp/vst-test/wt")
}

fn compose_input(task: Option<&str>) -> ComposePromptInput {
    let mut cfg = launch_cfg_worktree();
    cfg.session.id = "sess-test".into();
    ComposePromptInput {
        system_prompt: "You are helpful".into(),
        task_prompt: task.map(str::to_string),
        session_id: "sess-test".into(),
        system_prompt_file: "/tmp/system-prompt.md".into(),
        launch_cfg: cfg,
    }
}

mod resolution {
    use super::*;

    #[test]
    fn resolves_each_cli_to_its_name() {
        assert_eq!(resolve_plugin(CliId::Claude).name(), "claude");
        assert_eq!(resolve_plugin(CliId::Cursor).name(), "cursor");
        assert_eq!(resolve_plugin(CliId::Opencode).name(), "opencode");
        assert_eq!(resolve_plugin(CliId::Agy).name(), "agy");
        assert_eq!(resolve_plugin(CliId::Codex).name(), "codex");
        assert_eq!(resolve_plugin(CliId::Pi).name(), "pi");
    }

    #[test]
    fn default_model_matches_plugin_defaults() {
        assert_eq!(resolve_plugin(CliId::Claude).default_model(), "");
        assert_eq!(resolve_plugin(CliId::Cursor).default_model(), "auto");
        assert_eq!(
            resolve_plugin(CliId::Opencode).default_model(),
            "opencode/big-pickle"
        );
        assert_eq!(
            resolve_plugin(CliId::Agy).default_model(),
            "Gemini 3.8 Flash (Medium)"
        );
    }

    #[test]
    fn agy_is_terminal_only() {
        let p = resolve_plugin(CliId::Agy);
        assert_eq!(p.name(), "agy");
        // TEMPORARY: agy is terminal-only until terminal<->ACP conversation ids
        // are bridged — it must not support (or default to) the JSON channel.
        assert!(!p.supports_json());
        assert_eq!(p.default_channel(), Channel::Tmux);
    }

    #[test]
    fn supported_clis_are_all_resolvable() {
        for cli in vst_agents::SUPPORTED_CLIS {
            let p = resolve_plugin(cli);
            assert!(!p.name().is_empty());
        }
    }
}

mod claude_plugin {
    use super::*;

    #[test]
    fn launch_command_starts_with_claude() {
        assert_eq!(
            create_claude_plugin().get_launch_command(&launch_cfg_worktree())[0],
            "claude"
        );
    }

    #[test]
    fn compose_launch_prompt_with_system_and_task() {
        let result =
            create_claude_plugin().compose_launch_prompt(compose_input(Some("Fix the bug")));
        assert!(result.use_shell);
        let shell_line = result.shell_line.unwrap();
        assert!(shell_line.contains("--dangerously-skip-permissions"));
        assert!(shell_line.contains("--system-prompt"));
        assert!(shell_line.contains("$(cat "));
        assert!(shell_line.contains("/tmp/system-prompt.md"));
        assert!(shell_line.contains("Fix the bug"));
        assert!(!shell_line.contains("VSTPRMT:"));
        assert!(result.post_launch_input.is_none());
    }

    /// Regression: a task prompt containing an apostrophe ("don't") used to be
    /// wrapped in unescaped single quotes, so `sh -lc` hit a syntax error and
    /// the tmux pane died instantly — the agent never started, and resume
    /// (which replays the same initial prompt) died the same way.
    #[test]
    fn compose_launch_prompt_escapes_apostrophe_in_task() {
        let result = create_claude_plugin()
            .compose_launch_prompt(compose_input(Some("we don't need (that)")));
        let shell_line = result.shell_line.unwrap();
        let out = std::process::Command::new("sh")
            .args(["-n", "-c", &shell_line])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "shell line must parse: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(shell_line.contains(r"'we don'\''t need (that)'"));
    }

    #[test]
    fn compose_launch_prompt_no_task() {
        let result = create_claude_plugin().compose_launch_prompt(compose_input(None));
        assert!(result.use_shell);
        let shell_line = result.shell_line.unwrap();
        assert!(shell_line.contains("--dangerously-skip-permissions"));
        assert!(shell_line.contains("--system-prompt"));
        assert!(shell_line.contains("$(cat "));
        assert!(result.post_launch_input.is_none());
        assert!(!shell_line.contains("VSTPRMT:"));
    }

    #[test]
    fn environment_has_claudecode() {
        let env = create_claude_plugin().get_environment(&launch_cfg_worktree());
        assert_eq!(env.get("CLAUDECODE").map(|s| s.as_str()), Some("1"));
        assert_eq!(
            env.get("CLAUDE_CODE_ENTRYPOINT").map(|s| s.as_str()),
            Some("cli")
        );
    }

    #[test]
    fn ready_signal_has_sentinel() {
        let signal = create_claude_plugin().get_ready_signal();
        assert_eq!(signal.sentinel, Some("> "));
        assert!(signal.fallback_ms >= 10_000);
    }

    #[test]
    fn acp_meta_forwards_model_verbatim() {
        let plugin = create_claude_plugin();

        let meta_sonnet = plugin.acp_meta("sonnet").expect("should have acp_meta");
        assert_eq!(meta_sonnet["claudeCode"]["options"]["model"], "sonnet");
        assert_eq!(
            meta_sonnet["claudeCode"]["options"]["betas"][0],
            "context-1m-2025-08-07"
        );

        let meta_explicit = plugin.acp_meta("sonnet[1m]").expect("should have acp_meta");
        assert_eq!(
            meta_explicit["claudeCode"]["options"]["model"],
            "sonnet[1m]"
        );

        // Non-claude plugins return None
        assert_eq!(create_cursor_plugin().acp_meta("auto"), None);
        assert_eq!(create_opencode_plugin().acp_meta("big-pickle"), None);
        assert_eq!(create_agy_plugin().acp_meta("Gemini 3.1 Pro (High)"), None);
    }

    #[test]
    fn opencode_sets_model_over_acp_but_never_an_empty_one() {
        let p = create_opencode_plugin();
        assert_eq!(
            p.acp_initial_config_option("x"),
            Some(("model".to_string(), "x".to_string()))
        );
        assert_eq!(p.acp_initial_config_option(""), None);
        // Plugins without the hook are untouched.
        assert_eq!(create_cursor_plugin().acp_initial_config_option("x"), None);
    }

    #[test]
    fn claude_re_pins_model_over_acp_so_session_load_cannot_drift() {
        let p = create_claude_plugin();
        assert_eq!(
            p.acp_initial_config_option("sonnet"),
            Some(("model".to_string(), "sonnet".to_string()))
        );
        assert_eq!(p.acp_initial_config_option(""), None);
        assert!(p.acp_model_refusal_is_final());
        assert!(!create_opencode_plugin().acp_model_refusal_is_final());
    }

    #[test]
    fn claude_pins_anthropic_model_env_to_the_session_model() {
        let p = create_claude_plugin();
        let env = p.acp_model_env("sonnet");
        assert_eq!(
            env.get("ANTHROPIC_MODEL").map(|s| s.as_str()),
            Some("sonnet")
        );
        assert_eq!(env.len(), 1);
        // No mode model: the user's own env is left alone, not forced.
        assert!(p.acp_model_env("").is_empty());
        // Plugins without the hook add nothing.
        assert!(create_opencode_plugin().acp_model_env("x").is_empty());
        assert!(create_cursor_plugin().acp_model_env("auto").is_empty());
    }

    #[test]
    fn claude_terminal_env_leaves_anthropic_model_to_the_model_flag() {
        // Terminal: `--model` already beats an inherited `ANTHROPIC_MODEL`,
        // and without a mode model the user's env is their default.
        let p = create_claude_plugin();
        let mut cfg = launch_cfg_worktree();
        cfg.model = Some("sonnet".to_string());
        let env = p.get_environment(&cfg);
        assert!(!env.contains_key("ANTHROPIC_MODEL"));
    }

    #[tokio::test]
    async fn restore_command_null_when_no_uuid() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_claude_plugin();
        let session = make_session("s1");
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/tmp/vst-test-cwd",
                model: None,
            })
            .await;
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn restore_command_uses_agent_chat_id_without_fs() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_claude_plugin();
        let mut session = make_session("s1");
        session.agent_chat_id = Some("known-uuid".into());
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/tmp/vst-test-cwd",
                model: None,
            })
            .await;
        assert_eq!(
            result,
            Some(vec![
                "claude".into(),
                "--resume".into(),
                "known-uuid".into(),
                "--dangerously-skip-permissions".into(),
                "--chrome".into(),
            ])
        );
    }

    #[test]
    fn fork_command_present_for_claude_only() {
        assert_eq!(
            create_claude_plugin().get_fork_command(),
            Some(vec!["--fork-session".to_string()])
        );
        assert_eq!(create_cursor_plugin().get_fork_command(), None);
        assert_eq!(create_opencode_plugin().get_fork_command(), None);
        assert_eq!(create_agy_plugin().get_fork_command(), None);
    }
}

mod claude_hooks {
    use super::*;

    async fn run_hooks(dir: &std::path::Path) {
        create_claude_plugin()
            .setup_workspace_hooks(dir.to_str().unwrap())
            .await;
    }

    #[tokio::test]
    async fn creates_vibe_recorder_and_settings() {
        let dir = tempfile::tempdir().unwrap();
        run_hooks(dir.path()).await;
        let script =
            std::fs::read_to_string(dir.path().join(".claude").join("vibe-recorder.sh")).unwrap();
        assert!(script.contains("VST_SPAWN_TOKEN"));
        assert!(script.contains("jq"));
        assert!(script.contains("agent-chat-ids"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(".claude").join("vibe-recorder.sh"))
                .unwrap()
                .permissions()
                .mode();
            assert_ne!(mode & 0o111, 0);
        }
        let settings_raw =
            std::fs::read_to_string(dir.path().join(".claude").join("settings.json")).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&settings_raw).unwrap();
        let session_start = settings
            .pointer("/hooks/SessionStart")
            .unwrap()
            .as_array()
            .unwrap();
        let has_recorder = session_start.iter().any(|e| {
            e.get("hooks")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.get("command").and_then(|c| c.as_str())
                            == Some(".claude/vibe-recorder.sh")
                    })
                })
                .unwrap_or(false)
        });
        assert!(has_recorder);
    }

    #[tokio::test]
    async fn merges_with_existing_user_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let existing =
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"my-hook.sh"}]}]}}"#;
        std::fs::write(claude_dir.join("settings.json"), existing).unwrap();
        run_hooks(dir.path()).await;
        let raw = std::fs::read_to_string(claude_dir.join("settings.json")).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let hooks = settings
            .pointer("/hooks/SessionStart")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(hooks.len(), 2);
        let has_mine = hooks.iter().any(|e| {
            e.get("hooks")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter()
                        .any(|h| h.get("command").and_then(|c| c.as_str()) == Some("my-hook.sh"))
                })
                .unwrap_or(false)
        });
        let has_recorder = hooks.iter().any(|e| {
            e.get("hooks")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.get("command").and_then(|c| c.as_str())
                            == Some(".claude/vibe-recorder.sh")
                    })
                })
                .unwrap_or(false)
        });
        assert!(has_mine && has_recorder);
    }

    #[tokio::test]
    async fn idempotent_no_duplicate_entry() {
        let dir = tempfile::tempdir().unwrap();
        run_hooks(dir.path()).await;
        run_hooks(dir.path()).await;
        let raw =
            std::fs::read_to_string(dir.path().join(".claude").join("settings.json")).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let hooks = settings
            .pointer("/hooks/SessionStart")
            .unwrap()
            .as_array()
            .unwrap();
        let ours = hooks
            .iter()
            .filter(|e| {
                e.get("hooks")
                    .and_then(|h| h.as_array())
                    .map(|hs| {
                        hs.iter().any(|h| {
                            h.get("command").and_then(|c| c.as_str())
                                == Some(".claude/vibe-recorder.sh")
                        })
                    })
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(ours, 1);
    }

    #[tokio::test]
    async fn writes_vst_command_content() {
        let dir = tempfile::tempdir().unwrap();
        run_hooks(dir.path()).await;
        let content =
            std::fs::read_to_string(dir.path().join(".claude").join("commands").join("vst.md"))
                .unwrap();
        assert!(content.contains("vst session reset $VST_SESSION"));
        assert!(content.contains("vst session reset $VST_SESSION --handoff-file <path>"));
        assert!(content.contains("Do NOT pass `--handoff`"));
        assert!(!content.contains(".vibe-station/HANDOFF.md"));
        assert!(content.contains("vst session reset $VST_SESSION --mode \"<name>\""));
        assert!(content.contains("vst session handoff $VST_SESSION"));
        assert!(content.contains("vst session rename $VST_SESSION \"<name>\""));
        assert!(content.contains("vst worktree rename $VST_WORKTREE \"<name>\""));
        assert!(content.contains("$VST_WORKTREE"));
        assert!(content.contains("isn't part of a worktree"));
        assert!(content.contains("$ARGUMENTS"));
    }

    #[tokio::test]
    async fn vst_command_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        run_hooks(dir.path()).await;
        let first =
            std::fs::read_to_string(dir.path().join(".claude").join("commands").join("vst.md"))
                .unwrap();
        run_hooks(dir.path()).await;
        let second =
            std::fs::read_to_string(dir.path().join(".claude").join("commands").join("vst.md"))
                .unwrap();
        assert_eq!(second, first);
    }
}

mod cursor_plugin {
    use super::*;

    #[test]
    fn compose_launch_prompt_shell_line() {
        let result =
            create_cursor_plugin().compose_launch_prompt(compose_input(Some("Fix the bug")));
        assert!(result.use_shell);
        let shell_line = result.shell_line.unwrap();
        assert!(shell_line.contains("cursor-agent"));
        assert!(shell_line.contains("$("));
        assert!(shell_line.contains("/tmp/system-prompt.md"));
        assert!(shell_line.contains("Fix the bug"));
        assert!(result.launch_args.is_none());
        assert!(result.post_launch_input.is_none());
    }

    #[test]
    fn launch_command_has_force_sandbox_approve_mcps() {
        let cmd = create_cursor_plugin().get_launch_command(&launch_cfg_worktree());
        assert!(cmd.iter().any(|a| a == "--force"));
        assert!(cmd.iter().any(|a| a == "--sandbox"));
        assert!(cmd.iter().any(|a| a == "disabled"));
        assert!(cmd.iter().any(|a| a == "--approve-mcps"));
        assert!(!cmd.iter().any(|a| a == "--print"));
    }

    #[test]
    fn launch_command_resumes_with_agent_chat_id() {
        let mut cfg = launch_cfg_worktree();
        cfg.session.agent_chat_id = Some("uuid-abc".into());
        let cmd = create_cursor_plugin().get_launch_command(&cfg);
        let resume_idx = cmd.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(cmd[resume_idx + 1], "uuid-abc");
    }

    #[test]
    fn launch_command_no_resume_without_agent_chat_id() {
        let cmd = create_cursor_plugin().get_launch_command(&launch_cfg_worktree());
        assert!(!cmd.iter().any(|a| a == "--resume"));
    }

    #[tokio::test]
    async fn restore_command_uses_agent_chat_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_cursor_plugin();
        let mut session = make_session("s1");
        session.agent_chat_id = Some("cursor-uuid-xyz".into());
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/repos/p1",
                model: None,
            })
            .await;
        let argv = result.expect("some argv");
        assert!(argv.iter().any(|a| a == "--resume"));
        assert!(argv.iter().any(|a| a == "cursor-uuid-xyz"));
        assert!(argv.iter().any(|a| a == "/repos/p1"));
        assert!(!argv.join(" ").contains("undefined"));
    }

    #[tokio::test]
    async fn restore_command_null_without_agent_chat_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_cursor_plugin();
        let session = make_session("s1");
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/tmp/vst-test-cwd-no-chats",
                model: None,
            })
            .await;
        assert_eq!(result, None);
    }

    #[test]
    fn direct_context_uses_project_dir_as_workspace() {
        let cfg = proj_launch("p1", make_session("s1"), "/repos/p1");
        let cmd = create_cursor_plugin().get_launch_command(&cfg);
        let ws_idx = cmd.iter().position(|a| a == "--workspace").unwrap();
        assert_eq!(cmd[ws_idx + 1], "/repos/p1");
        assert!(!cmd.join(" ").contains("p1-direct"));
        assert!(!cmd.join(" ").contains("worktrees"));
    }
}

mod cursor_hooks {
    use super::*;

    #[tokio::test]
    async fn writes_vst_command_no_arg_substitution() {
        let dir = tempfile::tempdir().unwrap();
        create_cursor_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let content =
            std::fs::read_to_string(dir.path().join(".cursor").join("commands").join("vst.md"))
                .unwrap();
        assert!(content.contains("vst session reset $VST_SESSION"));
        assert!(content.contains("vst session reset $VST_SESSION --handoff-file <path>"));
        assert!(content.contains("Do NOT pass `--handoff`"));
        assert!(!content.contains(".vibe-station/HANDOFF.md"));
        assert!(content.contains("vst session reset $VST_SESSION --mode \"<name>\""));
        assert!(content.contains("vst session handoff $VST_SESSION"));
        assert!(content.contains("vst session rename $VST_SESSION \"<name>\""));
        assert!(content.contains("vst worktree rename $VST_WORKTREE \"<name>\""));
        assert!(content.contains("isn't part of a worktree"));
        assert!(!content.contains("$ARGUMENTS"));
    }

    #[tokio::test]
    async fn vst_command_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = create_cursor_plugin();
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let first =
            std::fs::read_to_string(dir.path().join(".cursor").join("commands").join("vst.md"))
                .unwrap();
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let second =
            std::fs::read_to_string(dir.path().join(".cursor").join("commands").join("vst.md"))
                .unwrap();
        assert_eq!(second, first);
    }

    #[tokio::test]
    async fn adds_cursor_to_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        create_cursor_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let gitignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l.trim() == ".cursor/"));
    }

    #[tokio::test]
    async fn gitignore_not_duplicated() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = create_cursor_plugin();
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let gitignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        let occurrences = gitignore.lines().filter(|l| l.trim() == ".cursor/").count();
        assert_eq!(occurrences, 1);
    }
}

mod opencode_plugin {
    use super::*;

    #[test]
    fn compose_launch_prompt_task_and_needle_not_system_prompt() {
        let result =
            create_opencode_plugin().compose_launch_prompt(compose_input(Some("Fix the bug")));
        assert!(result.launch_args.is_none());
        let input = result.post_launch_input.expect("post-launch input present");
        assert!(!input.contains("You are helpful"));
        assert!(input.contains("Fix the bug"));
        assert!(input.contains("VSTPRMT:sess-test"));
        assert!(result.post_launch_submit);
    }

    #[tokio::test]
    async fn restore_command_with_agent_chat_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_opencode_plugin();
        let mut session = make_session("s1");
        session.agent_chat_id = Some("ses_abc".into());
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/repos/p1",
                model: None,
            })
            .await;
        assert_eq!(
            result,
            Some(vec![
                "opencode".into(),
                "--session".into(),
                "ses_abc".into()
            ])
        );
    }

    #[tokio::test]
    async fn restore_command_null_without_agent_chat_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_opencode_plugin();
        let session = make_session("s1");
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/repos/p1",
                model: None,
            })
            .await;
        assert_eq!(result, None);
    }

    #[test]
    fn direct_context_config_resolves_to_direct_session_data_dir() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let cfg = proj_launch("p1", make_session("s1"), "/repos/p1");
        let env = create_opencode_plugin().get_environment(&cfg);
        // The plugin derives the path via `Paths::default()` (rooted at
        // `home/.vibe-station`), which respects the home override set above.
        let expected = Paths::default()
            .direct_opencode_config_path("p1", "s1")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            env.get("OPENCODE_CONFIG").map(|s| s.as_str()),
            Some(expected.as_str())
        );
        assert!(!expected.contains("p1-direct"));
        assert!(!expected.contains("worktrees"));
    }
}

mod opencode_hooks {
    use super::*;

    #[tokio::test]
    async fn writes_vst_recorder_plugin() {
        let dir = tempfile::tempdir().unwrap();
        create_opencode_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let content = std::fs::read_to_string(
            dir.path()
                .join(".opencode")
                .join("plugins")
                .join("vst-recorder.ts"),
        )
        .unwrap();
        assert!(content.contains("VstRecorder"));
        assert!(content.contains("session.created"));
        assert!(content.contains("VST_SPAWN_TOKEN"));
    }

    #[tokio::test]
    async fn idempotent_no_rewrite_if_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = create_opencode_plugin();
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let path = dir
            .path()
            .join(".opencode")
            .join("plugins")
            .join("vst-recorder.ts");
        let mtime_before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let mtime_after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime_after, mtime_before);
    }

    #[tokio::test]
    async fn writes_vst_command_with_arg_substitution() {
        let dir = tempfile::tempdir().unwrap();
        create_opencode_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let content =
            std::fs::read_to_string(dir.path().join(".opencode").join("commands").join("vst.md"))
                .unwrap();
        assert!(content.contains("$ARGUMENTS"));
        assert!(content.contains("vst session reset $VST_SESSION"));
        assert!(content.contains("vst session reset $VST_SESSION --handoff-file <path>"));
        assert!(content.contains("Do NOT pass `--handoff`"));
        assert!(!content.contains(".vibe-station/HANDOFF.md"));
        assert!(content.contains("vst session reset $VST_SESSION --mode \"<name>\""));
        assert!(content.contains("vst session handoff $VST_SESSION"));
        assert!(content.contains("vst session rename $VST_SESSION \"<name>\""));
        assert!(content.contains("vst worktree rename $VST_WORKTREE \"<name>\""));
        assert!(content.contains("isn't part of a worktree"));
    }

    #[tokio::test]
    async fn vst_command_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = create_opencode_plugin();
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let first =
            std::fs::read_to_string(dir.path().join(".opencode").join("commands").join("vst.md"))
                .unwrap();
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let second =
            std::fs::read_to_string(dir.path().join(".opencode").join("commands").join("vst.md"))
                .unwrap();
        assert_eq!(second, first);
    }

    #[tokio::test]
    async fn adds_opencode_to_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        create_opencode_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let gitignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l.trim() == ".opencode/"));
    }

    #[tokio::test]
    async fn gitignore_not_duplicated() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = create_opencode_plugin();
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        plugin
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let gitignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        let occurrences = gitignore
            .lines()
            .filter(|l| l.trim() == ".opencode/")
            .count();
        assert_eq!(occurrences, 1);
    }
}

mod codex_plugin {
    use super::*;

    const LIVE_ID: &str = "01a0ffb0-70ee-7ac0-86ea-d98c15c32eaf";
    const T1: &str = "01a0ffb0-0000-7000-8000-000000000001";
    const T2: &str = "01a0ffb0-0000-7000-8000-000000000002";
    const STALE_ID: &str = "01a0ff4a-8b99-70d2-a7bb-272b461b37c1";

    /// Create the rollout file codex would have written for `id` under `home`.
    fn seed_rollout(home: &std::path::Path, id: &str) {
        let day = home.join(".codex/sessions/2026/01/01");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-01-01T00-00-00-{id}.jsonl")),
            b"",
        )
        .unwrap();
    }

    #[test]
    fn launch_command_starts_with_codex() {
        assert_eq!(
            create_codex_plugin().get_launch_command(&launch_cfg_worktree())[0],
            "codex"
        );
    }

    #[test]
    fn launch_command_resumes_with_agent_chat_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_rollout(home.path(), LIVE_ID);
        let mut cfg = launch_cfg_worktree();
        cfg.session.agent_chat_id = Some(LIVE_ID.into());
        let cmd = create_codex_plugin().get_launch_command(&cfg);
        let resume_idx = cmd.iter().position(|a| a == "resume").unwrap();
        assert_eq!(cmd[resume_idx + 1], LIVE_ID);
    }

    #[test]
    fn launch_command_and_prompt_skip_resume_when_the_rollout_is_gone() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let mut cfg = launch_cfg_worktree();
        cfg.session.agent_chat_id = Some(STALE_ID.into());
        let cmd = create_codex_plugin().get_launch_command(&cfg);
        assert!(!cmd.iter().any(|a| a == "resume"), "{cmd:?}");
        let mut input = compose_input(Some("task"));
        input.launch_cfg.session.agent_chat_id = Some(STALE_ID.into());
        let line = create_codex_plugin()
            .compose_launch_prompt(input)
            .shell_line
            .unwrap();
        assert!(!line.contains("resume"), "{line}");
    }

    #[test]
    fn launch_command_includes_hook_trust_fresh_and_resume() {
        let fresh = create_codex_plugin().get_launch_command(&launch_cfg_worktree());
        assert!(
            fresh.iter().any(|a| a == "--dangerously-bypass-hook-trust"),
            "fresh launch argv must include --dangerously-bypass-hook-trust: {fresh:?}"
        );
        let bypass_idx = fresh
            .iter()
            .position(|a| a == "--dangerously-bypass-approvals-and-sandbox")
            .unwrap();
        assert_eq!(
            fresh.get(bypass_idx + 1).map(String::as_str),
            Some("--dangerously-bypass-hook-trust"),
            "hook-trust must immediately follow the sandbox-bypass flag"
        );

        let mut cfg = launch_cfg_worktree();
        cfg.session.agent_chat_id = Some("uuid-abc".into());
        let resume = create_codex_plugin().get_launch_command(&cfg);
        assert!(
            resume
                .iter()
                .any(|a| a == "--dangerously-bypass-hook-trust"),
            "resume launch argv must include --dangerously-bypass-hook-trust: {resume:?}"
        );
    }

    #[test]
    fn compose_launch_prompt_shell_line_includes_hook_trust() {
        let result =
            create_codex_plugin().compose_launch_prompt(compose_input(Some("do the thing")));
        let shell_line = result
            .shell_line
            .expect("task prompt must yield a shell line");
        assert!(
            shell_line.contains("--dangerously-bypass-hook-trust"),
            "shell_line must include --dangerously-bypass-hook-trust: {shell_line}"
        );
    }

    #[tokio::test]
    async fn restore_command_uses_agent_chat_id_without_fs() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_rollout(home.path(), LIVE_ID);
        let plugin = create_codex_plugin();
        let mut session = make_session("s1");
        session.agent_chat_id = Some(LIVE_ID.into());
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/tmp/vst-test-cwd",
                model: None,
            })
            .await;
        let argv = result.expect("restore command must be Some");
        let resume_idx = argv
            .iter()
            .position(|a| a == "resume")
            .expect("must contain resume");
        assert_eq!(argv.get(resume_idx + 1).map(String::as_str), Some(LIVE_ID));
        assert_eq!(
            argv,
            vec![
                "codex".to_string(),
                "--no-daemon".to_string(),
                "--no-alt-screen".to_string(),
                "resume".to_string(),
                LIVE_ID.to_string(),
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
                "--dangerously-bypass-hook-trust".to_string(),
                "-c".to_string(),
                "hooks.SessionStart=[{hooks=[{type=\"command\",command=\"/tmp/vst-test-cwd/.codex/vibe-recorder.sh\"}]}]".to_string(),
                "-c".to_string(),
                "hooks.UserPromptSubmit=[{hooks=[{type=\"command\",command=\"/tmp/vst-test-cwd/.codex/vibe-uploads.sh\"}]}]".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn restore_command_null_without_agent_chat_id_or_fs_match() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_codex_plugin();
        let session = make_session("s1");
        let result = plugin
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/tmp/vst-test-cwd",
                model: None,
            })
            .await;
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn capture_chat_id_reads_and_consumes_the_per_session_token_file() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let ids = dir.path().join(".vibe-station/agent-chat-ids");
        std::fs::create_dir_all(&ids).unwrap();
        std::fs::write(ids.join("s1"), "thread-for-s1\n").unwrap();
        std::fs::write(ids.join("s2"), "thread-for-s2").unwrap();

        let plugin = create_codex_plugin();
        let args = |sid: &str| (make_session(sid), make_project("p1"));
        let (s1, p1) = args("s1");
        let id = plugin
            .capture_chat_id(CaptureArgs {
                session: &s1,
                project: &p1,
                cwd,
                worktree: None,
            })
            .await;
        assert_eq!(id.as_deref(), Some("thread-for-s1"));
        assert!(!ids.join("s1").exists(), "token file is consumed");
        // The sibling session in the same worktree keeps ITS id.
        assert!(ids.join("s2").exists());
        let (s2, p2) = args("s2");
        let id2 = plugin
            .capture_chat_id(CaptureArgs {
                session: &s2,
                project: &p2,
                cwd,
                worktree: None,
            })
            .await;
        assert_eq!(id2.as_deref(), Some("thread-for-s2"));
        // No token file (hook not run yet) → None, never "the newest rollout".
        let (s3, p3) = args("s3");
        assert_eq!(
            plugin
                .capture_chat_id(CaptureArgs {
                    session: &s3,
                    project: &p3,
                    cwd,
                    worktree: None
                })
                .await,
            None
        );
    }

    #[tokio::test]
    async fn restore_command_heals_a_stale_stored_id_from_the_recorded_one() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_rollout(home.path(), LIVE_ID);
        let dir = tempfile::tempdir().unwrap();
        let ids = dir.path().join(".vibe-station/agent-chat-ids");
        std::fs::create_dir_all(&ids).unwrap();
        std::fs::write(ids.join("s1"), LIVE_ID).unwrap();
        let mut session = make_session("s1");
        session.agent_chat_id = Some(STALE_ID.into());
        let argv = create_codex_plugin()
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: dir.path().to_str().unwrap(),
                model: None,
            })
            .await
            .expect("resumes the recorded conversation");
        let i = argv.iter().position(|a| a == "resume").unwrap();
        assert_eq!(argv[i + 1], LIVE_ID);
    }

    #[tokio::test]
    async fn refresh_chat_id_on_toggle_replaces_only_a_stale_stored_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_rollout(home.path(), LIVE_ID);
        let dir = tempfile::tempdir().unwrap();
        let ids = dir.path().join(".vibe-station/agent-chat-ids");
        std::fs::create_dir_all(&ids).unwrap();
        std::fs::write(ids.join("s1"), LIVE_ID).unwrap();
        let refresh = |stored: Option<&str>| {
            let mut session = make_session("s1");
            session.agent_chat_id = stored.map(Into::into);
            let cwd = dir.path().to_str().unwrap().to_string();
            async move {
                create_codex_plugin()
                    .refresh_chat_id_on_toggle(CaptureArgs {
                        session: &session,
                        project: &make_project("p1"),
                        cwd: &cwd,
                        worktree: None,
                    })
                    .await
            }
        };
        assert_eq!(refresh(Some(STALE_ID)).await.as_deref(), Some(LIVE_ID));
        // live stored id (== recorded) or no stored id: leave it alone
        assert_eq!(refresh(Some(LIVE_ID)).await, None);
        assert_eq!(refresh(None).await, None);
    }

    #[tokio::test]
    async fn restore_command_falls_back_to_fresh_when_the_rollout_is_gone() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_rollout(home.path(), "01a0ffb1-f666-7d93-8d91-513f4e92c16e");
        let mut session = make_session("s1");
        session.agent_chat_id = Some(STALE_ID.into());
        let result = create_codex_plugin()
            .get_restore_command(RestoreArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/tmp/vst-test-cwd",
                model: None,
            })
            .await;
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn restore_command_uses_the_recorded_thread_id_of_this_session_only() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_rollout(home.path(), T1);
        seed_rollout(home.path(), T2);
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let ids = dir.path().join(".vibe-station/agent-chat-ids");
        std::fs::create_dir_all(&ids).unwrap();
        std::fs::write(ids.join("s1"), T1).unwrap();
        std::fs::write(ids.join("s2"), T2).unwrap();
        let plugin = create_codex_plugin();
        let resume_id = |sid: &'static str| {
            let plugin = &plugin;
            async move {
                let session = make_session(sid);
                plugin
                    .get_restore_command(RestoreArgs {
                        session: &session,
                        project: &make_project("p1"),
                        cwd,
                        model: None,
                    })
                    .await
                    .map(|argv| argv[argv.iter().position(|a| a == "resume").unwrap() + 1].clone())
            }
        };
        assert_eq!(resume_id("s1").await.as_deref(), Some(T1));
        assert_eq!(resume_id("s2").await.as_deref(), Some(T2));
        // Not consumed by restore (capture_chat_id persists + deletes it later).
        assert!(ids.join("s1").exists());
        // No recorded id for this session → fresh launch, not "the newest thread".
        assert_eq!(resume_id("s3").await, None);
    }

    #[tokio::test]
    async fn recorder_script_writes_session_id_from_stdin_json_per_token() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let dir = tempfile::tempdir().unwrap();
        create_codex_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let script = dir.path().join(".codex/vibe-recorder.sh");
        assert!(script.exists());
        let run = |token: Option<&str>, stdin: &str| {
            let mut cmd = Command::new(&script);
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            cmd.env_remove("VST_SPAWN_TOKEN");
            if let Some(t) = token {
                cmd.env("VST_SPAWN_TOKEN", t);
            }
            let mut child = cmd.spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(stdin.as_bytes())
                .unwrap();
            child.wait().unwrap().success()
        };
        let event = r#"{"session_id":"01a0ff7f-5c61-7740-bfd8-456e36b653c7","cwd":"/x","hook_event_name":"SessionStart","source":"startup"}"#;
        assert!(run(Some("sess-a"), event));
        let file = dir.path().join(".vibe-station/agent-chat-ids/sess-a");
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            "01a0ff7f-5c61-7740-bfd8-456e36b653c7"
        );
        // No token, or no session_id in the payload: exits 0 and writes nothing.
        assert!(run(None, event));
        assert!(run(Some("sess-b"), "{}"));
        assert!(!dir
            .path()
            .join(".vibe-station/agent-chat-ids/sess-b")
            .exists());
    }

    #[tokio::test]
    async fn capture_native_chat_id_prefers_known_agent_chat_id() {
        let plugin = create_codex_plugin();
        let mut session = make_session("s1");
        session.agent_chat_id = Some("known".into());
        let project = make_project("p1");
        let result = plugin
            .capture_native_chat_id(CaptureNativeChatIdArgs {
                session: &session,
                project: &project,
                cwd: "/tmp/vst-test-cwd",
                acp_session_id: "other-acp-id",
            })
            .await;
        assert_eq!(result, Some("known".to_string()));
    }

    #[tokio::test]
    async fn capture_native_chat_id_falls_back_to_acp_session_id() {
        let plugin = create_codex_plugin();
        let session = make_session("s1");
        let project = make_project("p1");
        let result = plugin
            .capture_native_chat_id(CaptureNativeChatIdArgs {
                session: &session,
                project: &project,
                cwd: "/tmp/vst-test-cwd",
                acp_session_id: "acp-abc",
            })
            .await;
        assert_eq!(result, Some("acp-abc".to_string()));
    }

    #[test]
    fn acp_initial_config_option_returns_model_config_pair() {
        assert_eq!(
            create_codex_plugin().acp_initial_config_option("gpt-6-astra"),
            Some(("model".to_string(), "gpt-6-astra".to_string()))
        );
    }

    #[tokio::test]
    async fn setup_workspace_hooks_writes_executable_upload_script() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        create_codex_plugin().setup_workspace_hooks(root).await;
        let script = dir.path().join(".codex/vibe-uploads.sh");
        assert!(script.exists(), ".codex/vibe-uploads.sh should exist");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "script should be executable");
        }
        let content = std::fs::read_to_string(&script).unwrap();
        assert!(content.contains("VST_SPAWN_TOKEN"));
        assert!(content.contains("pending-uploads"));
    }

    #[tokio::test]
    async fn setup_workspace_hooks_gitignores_dirs_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let plugin = create_codex_plugin();
        plugin.setup_workspace_hooks(root).await;
        plugin.setup_workspace_hooks(root).await;
        let gi = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        let count = |s: &str| gi.lines().filter(|l| l.trim() == s).count();
        assert_eq!(count(".codex/"), 1, ".codex/ ignored exactly once");
        assert_eq!(
            count(".vibe-station/"),
            1,
            ".vibe-station/ ignored exactly once"
        );
    }

    #[tokio::test]
    async fn setup_workspace_hooks_does_not_write_hooks_json() {
        // codex resolves the project .codex layer from the main repo root, so a
        // hooks.json in a worktree checkout is dead weight; the hook is passed via -c.
        let dir = tempfile::tempdir().unwrap();
        create_codex_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        assert!(dir.path().join(".codex/vibe-uploads.sh").exists());
        assert!(!dir.path().join(".codex/hooks.json").exists());
    }

    #[test]
    fn launch_command_registers_recorder_and_upload_hooks_via_config_override() {
        let cfg = launch_cfg_worktree();
        let argv = create_codex_plugin().get_launch_command(&cfg);
        let values: Vec<&String> = argv
            .iter()
            .enumerate()
            .filter(|(_, a)| a.as_str() == "-c")
            .map(|(i, _)| &argv[i + 1])
            .collect();
        assert_eq!(values.len(), 2);
        let cwd = cfg.ctx.cwd.to_str().unwrap();
        assert!(values[0].starts_with("hooks.SessionStart=[{hooks=[{type=\"command\",command=\""));
        assert!(values[0].contains(&format!("{cwd}/.codex/vibe-recorder.sh")));
        assert!(
            values[1].starts_with("hooks.UserPromptSubmit=[{hooks=[{type=\"command\",command=\"")
        );
        assert!(values[1].contains(&format!("{cwd}/.codex/vibe-uploads.sh")));
    }

    #[test]
    fn compose_launch_prompt_passes_the_system_prompt_as_developer_instructions_not_user_text() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = compose_input(Some("fix the bug"));
        input.system_prompt = "# Sys \"quoted\"\nline2".into();
        input.system_prompt_file = dir.path().join("system-prompt.md").display().to_string();
        let line = create_codex_plugin()
            .compose_launch_prompt(input)
            .shell_line
            .expect("shell line");
        // Out of band: JSON/TOML-escaped, single-quoted for the shell.
        assert!(
            line.contains(r#"-c "$(cat '"#) && line.contains("developer_instructions.txt"),
            "{line}"
        );
        assert!(!line.contains("Sys"), "prompt must not be inlined: {line}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("developer_instructions.txt")).unwrap(),
            r##"developer_instructions="# Sys \"quoted\"\nline2""##
        );
        // The positional prompt is ONLY the task.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("task_prompt.txt")).unwrap(),
            "fix the bug"
        );
        assert!(!line.contains("combined_prompt"));
    }

    #[test]
    fn compose_launch_prompt_without_a_task_still_installs_the_instructions() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = compose_input(None);
        input.system_prompt_file = dir.path().join("system-prompt.md").display().to_string();
        let line = create_codex_plugin()
            .compose_launch_prompt(input)
            .shell_line
            .expect("shell line");
        assert!(line.contains("developer_instructions.txt"), "{line}");
        assert!(!line.contains("task_prompt"), "{line}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("developer_instructions.txt")).unwrap(),
            "developer_instructions=\"You are helpful\""
        );
    }

    #[test]
    fn compose_launch_prompt_keeps_a_huge_system_prompt_off_the_command_line() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = compose_input(Some("task"));
        input.system_prompt = "x".repeat(60_000);
        input.system_prompt_file = dir.path().join("system-prompt.md").display().to_string();
        let line = create_codex_plugin()
            .compose_launch_prompt(input)
            .shell_line
            .unwrap();
        // tmux rejects commands over ~16 KB; the line must stay small.
        assert!(line.len() < 4_000, "line is {} bytes", line.len());
    }

    #[test]
    fn compose_launch_prompt_shell_line_registers_upload_hook() {
        let out = create_codex_plugin().compose_launch_prompt(compose_input(Some("do the thing")));
        let line = out.shell_line.expect("shell line");
        assert!(line.contains(" -c 'hooks.UserPromptSubmit=[{hooks=[{type=\"command\",command=\""));
        assert!(line.contains(".codex/vibe-uploads.sh"));
        assert!(line.contains(".codex/vibe-recorder.sh"));
    }

    #[tokio::test]
    async fn upload_script_prints_and_deletes_pointers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        create_codex_plugin()
            .setup_workspace_hooks(root.to_str().unwrap())
            .await;
        let script = root.join(".codex/vibe-uploads.sh");

        std::fs::create_dir_all(root.join(".vibe-station/pending-uploads/tok")).unwrap();
        let pointer = root.join(".vibe-station/pending-uploads/tok/u1-a.txt");
        std::fs::write(&pointer, "/tmp/a.txt").unwrap();

        let out = std::process::Command::new("bash")
            .arg(&script)
            .env("VST_SPAWN_TOKEN", "tok")
            .output()
            .unwrap();
        assert!(out.status.success());
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("- /tmp/a.txt"), "stdout: {stdout}");
        assert!(
            !pointer.exists(),
            "pointer should be deleted after printing"
        );

        let pointer2 = root.join(".vibe-station/pending-uploads/tok/u2-b.txt");
        std::fs::write(&pointer2, "/tmp/b.txt").unwrap();
        let out2 = std::process::Command::new("bash")
            .arg(&script)
            .env_remove("VST_SPAWN_TOKEN")
            .output()
            .unwrap();
        assert!(out2.status.success());
        assert!(out2.stdout.is_empty(), "no-token run must print nothing");
        assert!(pointer2.exists(), "no-token run must not delete pointers");
    }
}

mod pi_plugin {
    use super::*;

    /// Seed a pi session file with a user turn under `home`, so pi's
    /// conversation guard (`pi_conversation_started`) reports a started chat.
    fn seed_pi_conversation(home: &std::path::Path, id: &str) {
        let root = home.join(".pi/agent/sessions");
        let dir = root.join("cwd-encoded");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("1700000000_{id}.jsonl")),
            format!(
                "{}\n{}",
                r#"{"type":"session","session":{"id":""}}"#,
                r#"{"type":"message","message":{"role":"user","content":"hi"}}"#
            ),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn setup_workspace_hooks_gitignores_vibe_station_dir() {
        let dir = tempfile::tempdir().unwrap();
        create_pi_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        create_pi_plugin()
            .setup_workspace_hooks(dir.path().to_str().unwrap())
            .await;
        let gi = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert_eq!(
            gi.lines().filter(|l| l.trim() == ".vibe-station/").count(),
            1
        );
    }

    #[test]
    fn compose_launch_prompt_delivers_the_system_prompt_with_or_without_a_task() {
        let dir = tempfile::tempdir().unwrap();
        let mk = |task: Option<&str>| {
            let mut input = compose_input(task);
            input.system_prompt = "x".repeat(60_000);
            input.system_prompt_file = dir.path().join("system-prompt.md").display().to_string();
            input.launch_cfg.ctx.cwd = dir.path().to_path_buf();
            create_pi_plugin()
                .compose_launch_prompt(input)
                .shell_line
                .expect("shell line")
        };
        let prompt_file = dir
            .path()
            .join(".vibe-station/pi-system-prompt")
            .join(&compose_input(None).launch_cfg.session.id);
        for line in [mk(None), mk(Some("do it"))] {
            assert!(line.contains("--append-system-prompt '"), "{line}");
            assert!(line.contains(&*prompt_file.to_string_lossy()), "{line}");
            assert!(line.len() < 4_000, "line is {} bytes", line.len());
        }
        assert_eq!(std::fs::read_to_string(&prompt_file).unwrap().len(), 60_000);
        assert!(!mk(None).contains("task_prompt"));
        assert!(mk(Some("do it")).contains("task_prompt.txt"));
    }

    #[tokio::test]
    async fn restore_command_re_passes_the_system_prompt_file() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_pi_conversation(home.path(), "s1");
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let session = make_session("s1");
        let restore = || async {
            create_pi_plugin()
                .get_restore_command(RestoreArgs {
                    session: &session,
                    project: &make_project("p1"),
                    cwd,
                    model: None,
                })
                .await
                .unwrap()
        };
        // No prompt file written yet: nothing to pass.
        assert!(!restore()
            .await
            .iter()
            .any(|a| a == "--append-system-prompt"));
        let file = dir.path().join(".vibe-station/pi-system-prompt/s1");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "sys").unwrap();
        let argv = restore().await;
        let i = argv
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(argv[i + 1], file.to_string_lossy());
    }

    #[test]
    fn launch_command_starts_with_pi() {
        assert_eq!(
            create_pi_plugin().get_launch_command(&launch_cfg_worktree())[0],
            "pi"
        );
    }

    #[test]
    fn pi_does_not_support_json() {
        assert!(!create_pi_plugin().supports_json());
    }

    #[test]
    fn launch_command_uses_the_vst_session_id_as_the_pi_session_id() {
        let mut cfg = launch_cfg_worktree();
        cfg.session = make_session("sess-own");
        let argv = create_pi_plugin().get_launch_command(&cfg);
        let idx = argv
            .iter()
            .position(|a| a == "--session-id")
            .expect("--session-id");
        assert_eq!(argv[idx + 1], "sess-own");
        // An established chat id wins (same value for sessions created by this code).
        cfg.session.agent_chat_id = Some("established".into());
        let argv = create_pi_plugin().get_launch_command(&cfg);
        let idx = argv.iter().position(|a| a == "--session-id").unwrap();
        assert_eq!(argv[idx + 1], "established");
    }

    #[test]
    fn two_sessions_in_one_worktree_get_distinct_pi_session_ids() {
        let id = |sid: &str| {
            let mut cfg = launch_cfg_worktree();
            cfg.session = make_session(sid);
            let argv = create_pi_plugin().get_launch_command(&cfg);
            let idx = argv.iter().position(|a| a == "--session-id").unwrap();
            argv[idx + 1].clone()
        };
        assert_ne!(id("s1"), id("s2"));
    }

    #[tokio::test]
    async fn capture_chat_id_is_the_vst_session_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        seed_pi_conversation(home.path(), "s1");
        let session = make_session("s1");
        let id = create_pi_plugin()
            .capture_chat_id(CaptureArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: "/tmp/vst-test-cwd",
                worktree: None,
            })
            .await;
        assert_eq!(id.as_deref(), Some("s1"));
    }

    #[tokio::test]
    async fn restore_command_resumes_this_sessions_own_id() {
        let home = tempfile::tempdir().unwrap();
        let _guard = with_home(home.path().to_path_buf());
        let plugin = create_pi_plugin();
        let restore = |session: vst_types::SessionRecord, model: Option<&'static str>| {
            let plugin = &plugin;
            async move {
                plugin
                    .get_restore_command(RestoreArgs {
                        session: &session,
                        project: &make_project("p1"),
                        cwd: "/tmp/vst-test-cwd",
                        model,
                    })
                    .await
                    .expect("restore command must be Some")
            }
        };
        seed_pi_conversation(home.path(), "s1");
        assert_eq!(
            restore(make_session("s1"), Some("deepseek-local/m")).await,
            vec![
                "pi".to_string(),
                "--tui-mode".to_string(),
                "regular".to_string(),
                "--session-id".to_string(),
                "s1".to_string(),
                "--approve".to_string(),
                "--model".to_string(),
                "deepseek-local/m".to_string(),
            ]
        );
        let mut known = make_session("s2");
        known.agent_chat_id = Some("established".into());
        seed_pi_conversation(home.path(), "established");
        let argv = restore(known, None).await;
        let idx = argv.iter().position(|a| a == "--session-id").unwrap();
        assert_eq!(argv[idx + 1], "established");
    }
}

mod chat_id_capture {
    use super::*;

    #[tokio::test]
    async fn claude_capture_chat_id_reads_and_deletes_token_file() {
        let dir = tempfile::tempdir().unwrap();
        let token_file = dir
            .path()
            .join(".vibe-station")
            .join("agent-chat-ids")
            .join("s1");
        std::fs::create_dir_all(token_file.parent().unwrap()).unwrap();
        std::fs::write(&token_file, "captured-uuid\n").unwrap();
        let plugin = create_claude_plugin();
        let session = make_session("s1");
        let id = plugin
            .capture_chat_id(CaptureArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: dir.path().to_str().unwrap(),
                worktree: None,
            })
            .await;
        assert_eq!(id.as_deref(), Some("captured-uuid"));
        assert!(!token_file.exists());
    }

    #[tokio::test]
    async fn claude_capture_chat_id_null_when_no_token_file() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = create_claude_plugin();
        let session = make_session("s1");
        let id = plugin
            .capture_chat_id(CaptureArgs {
                session: &session,
                project: &make_project("p1"),
                cwd: dir.path().to_str().unwrap(),
                worktree: None,
            })
            .await;
        assert_eq!(id, None);
    }
}

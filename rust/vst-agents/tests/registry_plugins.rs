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
use vst_agents::cursor::create_cursor_plugin;
use vst_agents::home::with_home;
use vst_agents::opencode::create_opencode_plugin;
use vst_agents::paths::Paths;
use vst_agents::plugin::{CaptureArgs, ComposePromptInput, RestoreArgs};
use vst_agents::{resolve_plugin, AgentPlugin, CliId};

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
    }

    #[test]
    fn default_model_matches_plugin_defaults() {
        assert_eq!(resolve_plugin(CliId::Claude).default_model(), "sonnet");
        assert_eq!(resolve_plugin(CliId::Cursor).default_model(), "auto");
        assert_eq!(
            resolve_plugin(CliId::Opencode).default_model(),
            "opencode/big-pickle"
        );
        assert_eq!(
            resolve_plugin(CliId::Agy).default_model(),
            "Gemini 3.1 Pro (High)"
        );
    }

    #[test]
    fn agy_supports_json() {
        let p = resolve_plugin(CliId::Agy);
        assert_eq!(p.name(), "agy");
        assert!(p.supports_json());
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

    #[tokio::test]
    async fn list_models_includes_fable_alias_and_full_name() {
        let res = create_claude_plugin().list_models().await;
        assert!(res.models.iter().any(|m| m == "fable"));
        assert!(res.models.iter().any(|m| m == "claude-fable-5"));
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
    fn acp_meta_forwards_model_and_normalizes_pinned_1m() {
        let plugin = create_claude_plugin();

        let meta_sonnet = plugin.acp_meta("sonnet").expect("should have acp_meta");
        assert_eq!(meta_sonnet["claudeCode"]["options"]["model"], "sonnet");
        assert_eq!(meta_sonnet["claudeCode"]["options"]["betas"][0], "context-1m-2025-08-07");

        let meta_pinned = plugin.acp_meta("claude-sonnet-4-5").expect("should have acp_meta");
        assert_eq!(meta_pinned["claudeCode"]["options"]["model"], "claude-sonnet-4-5[1m]");

        let meta_opus = plugin.acp_meta("claude-opus-4-5").expect("should have acp_meta");
        assert_eq!(meta_opus["claudeCode"]["options"]["model"], "claude-opus-4-5[1m]");

        let meta_explicit = plugin.acp_meta("sonnet[1m]").expect("should have acp_meta");
        assert_eq!(meta_explicit["claudeCode"]["options"]["model"], "sonnet[1m]");

        // Non-claude plugins return None
        assert_eq!(create_cursor_plugin().acp_meta("auto"), None);
        assert_eq!(create_opencode_plugin().acp_meta("big-pickle"), None);
        assert_eq!(create_agy_plugin().acp_meta("Gemini 3.1 Pro (High)"), None);
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

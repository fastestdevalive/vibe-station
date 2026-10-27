//! Behavior contract for the agy plugin's chat-id capture + native-chat-id —
//! ports `daemon/src/__tests__/agy.test.ts`.
//!
//! The chat-id capture is session-scoped via a per-session `--log-file`
//! ("Created/Streaming conversation <id>" lines), not the cwd-keyed
//! `last_conversations.json` cache (which is stale for killed sessions).

mod common;

use std::path::{Path, PathBuf};

use vst_agents::agy::{
    agy_log_path, create_agy_plugin, parse_agy_models_output, poll_log_for_conversation_id,
};
use vst_agents::home::with_home;
use vst_agents::plugin::{CaptureArgs, ComposePromptInput};
use vst_agents::AgentPlugin;

use common::{make_project, make_session};

fn session(id: &str) -> vst_types::SessionRecord {
    let mut s = make_session(id);
    s.agent_chat_id = None;
    s
}

fn log_path_for(home: &Path, id: &str) -> PathBuf {
    home.join(".vibe-station")
        .join("agy-logs")
        .join(format!("{id}.log"))
}

async fn write_log(home: &Path, id: &str, content: &str) {
    let path = log_path_for(home, id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, content).unwrap();
}

#[tokio::test]
async fn get_launch_command_wires_per_session_log_file_and_creates_dir() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let plugin = create_agy_plugin();
    let cfg = vst_agents::LaunchConfig {
        project: make_project("p1"),
        ctx: common::proj_ctx("p1", "/repos/p1"),
        session: session("sess-launch"),
        daemon_port: 7421,
        model: None,
    };
    let argv = plugin.get_launch_command(&cfg);
    let idx = argv
        .iter()
        .position(|a| a == "--log-file")
        .expect("--log-file present");
    assert_eq!(
        PathBuf::from(&argv[idx + 1]),
        log_path_for(home.path(), "sess-launch")
    );
    assert!(home.path().join(".vibe-station").join("agy-logs").exists());
}

#[tokio::test]
async fn capture_chat_id_resolves_created_line() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    write_log(home.path(), "sess-agy", "I0719 12:00:00.000000 server.go:861] Created conversation abcdef01-2345-6789-abcd-ef0123456789\n").await;
    let plugin = create_agy_plugin();
    let s = session("sess-agy");
    let id = plugin
        .capture_chat_id(CaptureArgs {
            session: &s,
            project: &make_project("p1"),
            cwd: "/repos/p1",
            worktree: None,
        })
        .await;
    assert_eq!(id.as_deref(), Some("abcdef01-2345-6789-abcd-ef0123456789"));
}

#[tokio::test]
async fn capture_chat_id_prefers_last_streaming_line() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    write_log(
        home.path(),
        "sess-agy",
        "I0719 12:00:00 server.go:861] Created conversation 11111111-1111-1111-1111-111111111111\n\
         I0719 12:00:01 conversation_manager.go:520] Streaming conversation 11111111-1111-1111-1111-111111111111\n\
         I0719 12:05:00 conversation_manager.go:520] Streaming conversation 22222222-2222-2222-2222-222222222222\n",
    )
    .await;
    let plugin = create_agy_plugin();
    let s = session("sess-agy");
    let id = plugin
        .capture_chat_id(CaptureArgs {
            session: &s,
            project: &make_project("p1"),
            cwd: "/repos/p1",
            worktree: None,
        })
        .await;
    assert_eq!(id.as_deref(), Some("22222222-2222-2222-2222-222222222222"));
}

#[tokio::test]
async fn capture_chat_id_times_out_to_null() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let id = poll_log_for_conversation_id(
        &log_path_for(home.path(), "sess-never-created"),
        Some(150),
        Some(20),
    )
    .await;
    assert_eq!(id, None);
}

#[tokio::test]
async fn capture_chat_id_resolves_once_line_appended_mid_poll() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let path = log_path_for(home.path(), "sess-agy");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "").unwrap();
    let plugin = create_agy_plugin();
    let s = session("sess-agy");
    let pending = plugin.capture_chat_id(CaptureArgs {
        session: &s,
        project: &make_project("p1"),
        cwd: "/repos/p1",
        worktree: None,
    });
    std::thread::sleep(std::time::Duration::from_millis(50));
    std::fs::write(
        &path,
        "I0719 server.go:861] Created conversation 99999999-9999-9999-9999-999999999999\n",
    )
    .unwrap();
    let id = pending.await;
    assert_eq!(id.as_deref(), Some("99999999-9999-9999-9999-999999999999"));
}

#[tokio::test]
async fn refresh_chat_id_on_toggle_immediate_read() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    write_log(
        home.path(),
        "sess-agy",
        "I0719 server.go:861] Created conversation 33333333-3333-3333-3333-333333333333\n\
         I0719 conversation_manager.go:520] Streaming conversation 33333333-3333-3333-3333-333333333333\n",
    )
    .await;
    let plugin = create_agy_plugin();
    let s = session("sess-agy");
    let id = plugin
        .refresh_chat_id_on_toggle(CaptureArgs {
            session: &s,
            project: &make_project("p1"),
            cwd: "/repos/p1",
            worktree: None,
        })
        .await;
    assert_eq!(id.as_deref(), Some("33333333-3333-3333-3333-333333333333"));
}

#[tokio::test]
async fn refresh_chat_id_on_toggle_returns_null_when_no_conversation_line() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    write_log(
        home.path(),
        "sess-agy",
        "I0719 some unrelated startup line\n",
    )
    .await;
    let plugin = create_agy_plugin();
    let s = session("sess-agy");
    let id = plugin
        .refresh_chat_id_on_toggle(CaptureArgs {
            session: &s,
            project: &make_project("p1"),
            cwd: "/repos/p1",
            worktree: None,
        })
        .await;
    assert_eq!(id, None);
}

#[tokio::test]
async fn two_sessions_independent_log_files() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    write_log(
        home.path(),
        "sess-a",
        "I0719 server.go:861] Created conversation aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n",
    )
    .await;
    write_log(
        home.path(),
        "sess-b",
        "I0719 server.go:861] Created conversation bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\n",
    )
    .await;
    let plugin = create_agy_plugin();
    let a = session("sess-a");
    let b = session("sess-b");
    let id_a = plugin
        .capture_chat_id(CaptureArgs {
            session: &a,
            project: &make_project("p1"),
            cwd: "/repos/p1",
            worktree: None,
        })
        .await;
    let id_b = plugin
        .capture_chat_id(CaptureArgs {
            session: &b,
            project: &make_project("p1"),
            cwd: "/repos/p1",
            worktree: None,
        })
        .await;
    assert_eq!(
        id_a.as_deref(),
        Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    );
    assert_eq!(
        id_b.as_deref(),
        Some("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    );
}

#[tokio::test]
async fn parse_last_conversation_id_tolerates_trailing_garbage() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    write_log(
        home.path(),
        "sess-agy",
        "some totally unrelated log noise\n\
         I0719 server.go:861] Created conversation cccccccc-cccc-cccc-cccc-cccccccccccc extra trailing text\n",
    )
    .await;
    let plugin = create_agy_plugin();
    let s = session("sess-agy");
    let id = plugin
        .capture_chat_id(CaptureArgs {
            session: &s,
            project: &make_project("p1"),
            cwd: "/repos/p1",
            worktree: None,
        })
        .await;
    assert_eq!(id.as_deref(), Some("cccccccc-cccc-cccc-cccc-cccccccccccc"));
}

#[test]
fn agy_log_path_is_per_session() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    assert_eq!(
        agy_log_path("abc"),
        home.path()
            .join(".vibe-station")
            .join("agy-logs")
            .join("abc.log")
    );
}

/// Real captured `agy models` output (14 current models, includes the
/// non-tab "Fetching..." status line) — verified live against an
/// authenticated `agy` install. Regression-guards the stale hardcoded
/// `AGY_MODELS` const this replaced.
#[test]
fn parse_agy_models_output_extracts_display_names_and_skips_status_line() {
    let stdout = "Fetching available models...\n\
        gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
        gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n\
        gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
        gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n\
        gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n\
        gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n\
        gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n\
        gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\n\
        gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n\
        gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n\
        gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n\
        claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\
        claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\
        gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";

    let models = parse_agy_models_output(stdout);

    assert_eq!(
        models,
        vec![
            "Gemini 3.8 Flash (High)",
            "Gemini 3.8 Flash (Medium)",
            "Gemini 3.8 Flash (Low)",
            "Gemini 3.7 Flash (High)",
            "Gemini 3.7 Flash (Medium)",
            "Gemini 3.7 Flash (Low)",
            "Gemini 3.6 Flash (High)",
            "Gemini 3.6 Flash (Medium)",
            "Gemini 3.6 Flash (Low)",
            "Gemini 3.1 Pro (High)",
            "Gemini 3.1 Pro (Low)",
            "Claude Sonnet 4.6 (Thinking)",
            "Claude Opus 4.6 (Thinking)",
            "GPT-OSS 120B (Medium)",
        ]
    );
    // The "Fetching..." status line has no tab and must not appear.
    assert!(!models.iter().any(|m| m.contains("Fetching")));
}

#[test]
fn parse_agy_models_output_handles_empty_and_whitespace_only() {
    assert!(parse_agy_models_output("").is_empty());
    assert!(parse_agy_models_output("Fetching available models...\n").is_empty());
    assert!(parse_agy_models_output("no tab here at all").is_empty());
}

#[tokio::test]
async fn compose_launch_prompt_writes_combined_prompt_file() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let plugin = create_agy_plugin();
    let s = session("sess-prompt-test");
    let system_prompt_file = home
        .path()
        .join("system_prompt.txt")
        .to_string_lossy()
        .into_owned();
    let launch_cfg = vst_agents::LaunchConfig {
        project: make_project("p1"),
        ctx: common::proj_ctx("p1", "/tmp"),
        session: s.clone(),
        daemon_port: 1234,
        model: Some("Gemini 3.5 Flash (Medium)".to_string()),
    };
    let result = plugin.compose_launch_prompt(ComposePromptInput {
        system_prompt: "System Rules".into(),
        task_prompt: Some("Do the task".into()),
        session_id: s.id.clone(),
        system_prompt_file: system_prompt_file.clone(),
        launch_cfg,
    });
    assert!(result.use_shell);
    let shell_line = result.shell_line.unwrap();
    assert!(shell_line.contains("agy --dangerously-skip-permissions"));
    assert!(shell_line.contains("--model 'Gemini 3.5 Flash (Medium)'"));
    assert!(shell_line.contains("-i \"$(cat '"));
    let written = std::fs::read_to_string(home.path().join("combined_prompt.txt")).unwrap();
    assert_eq!(written, "System Rules\n\nDo the task");
}

fn restore_args<'a>(
    session: &'a vst_types::SessionRecord,
    project: &'a vst_types::ProjectRecord,
    model: Option<&'a str>,
) -> vst_agents::plugin::RestoreArgs<'a> {
    vst_agents::plugin::RestoreArgs {
        session,
        project,
        cwd: "/repos/p1",
        model,
    }
}

#[tokio::test]
async fn restore_command_passes_log_file() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let plugin = create_agy_plugin();
    let project = make_project("p1");
    let mut s = session("sess-restore");
    s.agent_chat_id = Some("conv-123".to_string());
    let expected_log = log_path_for(home.path(), "sess-restore")
        .to_string_lossy()
        .into_owned();

    let argv = plugin
        .get_restore_command(restore_args(&s, &project, None))
        .await
        .expect("restore argv");
    assert!(argv.windows(2).any(|w| w == ["--conversation", "conv-123"]));
    assert!(argv.contains(&"--dangerously-skip-permissions".to_string()));
    assert_eq!(
        &argv[argv.len() - 2..],
        ["--log-file", expected_log.as_str()]
    );
    assert!(home.path().join(".vibe-station").join("agy-logs").exists());

    let argv = plugin
        .get_restore_command(restore_args(&s, &project, Some("M")))
        .await
        .expect("restore argv");
    let model_idx = argv.iter().position(|a| a == "--model").unwrap();
    let log_idx = argv.iter().position(|a| a == "--log-file").unwrap();
    assert_eq!(argv[model_idx + 1], "M");
    assert!(model_idx < log_idx);
}

#[tokio::test]
async fn restore_command_none_without_any_conversation_id() {
    let home = tempfile::tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let plugin = create_agy_plugin();
    let project = make_project("p1");
    let s = session("sess-none");
    assert!(plugin
        .get_restore_command(restore_args(&s, &project, None))
        .await
        .is_none());
}

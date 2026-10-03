//! `pi` coding agent plugin.
//!
//! Delivery: inline (system + task prompts baked into the launch command).
//! Ready signal: no sentinel, 12s fallback.
//! Terminal channel only; pi has no ACP or JSON channel.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use vst_proc::sq;

use vst_types::{Channel, SessionRecord};

use crate::plugin::{
    AgentPlugin, AsyncResult, CaptureArgs, ComposePromptInput, ComposePromptResult, LaunchConfig,
    ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs,
};

/// `pi` coding agent plugin.
pub struct PiPlugin;

/// Create a fresh `pi` plugin instance.
pub fn create_pi_plugin() -> PiPlugin {
    PiPlugin
}

/// Per-session system-prompt file, `<cwd>/.vibe-station/pi-system-prompt/<sessionId>`
/// (inside `.vibe-station/`, gitignored by `setup_workspace_hooks`). pi rebuilds its system prompt
/// on EVERY run and does not save the appended text in the session, so resume must
/// pass the same file again or the agent silently loses the vst instructions.
fn system_prompt_path(cwd: &std::path::Path, session_id: &str) -> PathBuf {
    cwd.join(".vibe-station")
        .join("pi-system-prompt")
        .join(session_id)
}

/// The pi session id for a vst session. `pi --session-id <id>` creates the
/// session with exactly this id if missing and resumes it otherwise, so each vst
/// session owns its own pi conversation, even with several in one worktree.
fn session_chat_id(session: &SessionRecord) -> String {
    session
        .agent_chat_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| session.id.clone())
}

/// pi's session store root: `<home>/.pi/agent/sessions`, or
/// `$PI_CODING_AGENT_DIR/sessions` (the var IS pi's agent dir) when that env var is set and no test
/// home override is active (pattern: `codex_import.rs`'s `codex_home`).
fn pi_sessions_root() -> PathBuf {
    match std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|_| !crate::home::is_overridden())
        .filter(|v| !v.is_empty())
    {
        Some(dir) => PathBuf::from(dir).join("sessions"),
        None => crate::home::home_dir()
            .join(".pi")
            .join("agent")
            .join("sessions"),
    }
}

/// `pi_conversation_started(root, id)` — whether pi has actually begun a
/// conversation for `id` under `root`: true only if a session file
/// `<dir>/<ts>_<id>.jsonl` contains a `message` line with `role == "user"`.
/// pi writes a header line (`{"type":"session",...}`) at startup, so file
/// existence alone is not proof a conversation started (see
/// `docs/CLI-LAUNCH-PITFALLS.md`); mirrors codex's `resumable_chat_id`.
fn pi_conversation_started(root: &Path, id: &str) -> bool {
    let suffix = format!("_{id}.jsonl");
    search_pi_session_file(root, &suffix).is_some_and(|f| file_has_user_turn(&f))
}

/// Search `root` (recursively, bounded, no symlink following) for a file whose
/// name ends with `suffix`. `sessions/<cwd-encoded>/<ts>_<id>.jsonl` is shallow,
/// so a small depth bound suffices.
fn search_pi_session_file(root: &Path, suffix: &str) -> Option<PathBuf> {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut depth = 0u8;
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if depth < 4 {
                    stack.push(entry.path());
                }
            } else if ft.is_file() && name.ends_with(suffix) {
                return Some(entry.path());
            }
        }
        depth += 1;
    }
    None
}

/// Whether a pi session `.jsonl` contains at least one user message line.
fn file_has_user_turn(path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    content.lines().any(|line| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        v.get("type").and_then(serde_json::Value::as_str) == Some("message")
            && v.pointer("/message/role")
                .and_then(serde_json::Value::as_str)
                == Some("user")
    })
}

impl AgentPlugin for PiPlugin {
    fn name(&self) -> &str {
        "pi"
    }

    fn default_channel(&self) -> Channel {
        Channel::Tmux
    }

    /// Empty = no explicit model: pi is multi-provider, so it uses whatever the
    /// user configured. A hardcoded id could name a provider they don't have.
    fn default_model(&self) -> &str {
        ""
    }

    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "pi"
    }

    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }

    /// pi needs no hook scripts, but its per-session system-prompt file lives under
    /// `<cwd>/.vibe-station/`; make sure that dir is gitignored even when pi is the
    /// only CLI used in this checkout (claude/codex add the entry in their own hooks).
    fn setup_workspace_hooks(&self, workspace_path: &str) -> AsyncResult<()> {
        let gitignore = PathBuf::from(workspace_path).join(".gitignore");
        Box::pin(async move {
            crate::codex::ensure_gitignore_entry(gitignore, ".vibe-station/").await;
        })
    }

    fn get_launch_command(&self, cfg: &LaunchConfig) -> Vec<String> {
        // `regular` TUI mode: pi's default fullscreen mode uses the alternate screen,
        // which leaves tmux with no scrollback (same reason codex gets --no-alt-screen).
        let mut argv = vec![
            "pi".to_string(),
            "--tui-mode".to_string(),
            "regular".to_string(),
            "--approve".to_string(),
        ];
        if let Some(model) = &cfg.model {
            argv.push("--model".to_string());
            argv.push(model.clone());
        }
        argv.push("--session-id".to_string());
        argv.push(session_chat_id(&cfg.session));
        argv
    }

    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 12_000,
        }
    }

    fn compose_launch_prompt(&self, input: ComposePromptInput) -> ComposePromptResult {
        if input.task_prompt.is_none() && input.system_prompt.is_empty() {
            return ComposePromptResult::default();
        }
        let dir = PathBuf::from(&input.system_prompt_file)
            .parent()
            .map(PathBuf::from)
            .unwrap_or_default();
        let mut shell_line = "pi --tui-mode regular --approve".to_string();
        if let Some(model) = &input.launch_cfg.model {
            shell_line.push_str(&format!(" --model {}", sq(model)));
        }
        shell_line.push_str(&format!(
            " --session-id {}",
            sq(&session_chat_id(&input.launch_cfg.session))
        ));
        // The system prompt rides pi's own flag (appended to its default prompt),
        // so it applies with or without a task and stays out of the user's first
        // message. pi reads the file's contents when the argument is a path, which
        // also keeps a large prompt off tmux's ~16 KB command limit. Resume passes
        // the same file (see `get_restore_command`).
        if !input.system_prompt.is_empty() {
            let file = system_prompt_path(&input.launch_cfg.ctx.cwd, &input.launch_cfg.session.id);
            let written = file
                .parent()
                .is_some_and(|d| std::fs::create_dir_all(d).is_ok())
                && std::fs::write(&file, &input.system_prompt).is_ok();
            if written {
                shell_line.push_str(&format!(
                    " --append-system-prompt {}",
                    sq(&file.to_string_lossy())
                ));
            }
        }
        if let Some(task) = &input.task_prompt {
            let file = dir.join("task_prompt.txt");
            let _ = std::fs::write(&file, task);
            shell_line.push_str(&format!(" \"$(cat {})\"", sq(&file.to_string_lossy())));
        }
        ComposePromptResult {
            use_shell: true,
            shell_line: Some(shell_line),
            ..Default::default()
        }
    }

    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        Box::pin(async {
            // `pi --list-models` has no JSON mode; it prints a whitespace-aligned
            // table (`provider model context max-out thinking images`). Bounded by a
            // timeout so a hung CLI can't wedge the catalog's per-CLI slot.
            let run = tokio::process::Command::new("pi")
                .arg("--list-models")
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output();
            let fail = |msg: String| ListModelsResult {
                models: vec![],
                error: Some(msg),
            };
            match tokio::time::timeout(std::time::Duration::from_secs(20), run).await {
                Err(_) => fail("`pi --list-models` timed out after 20s.".to_string()),
                Ok(Err(e)) => fail(format!(
                    "Couldn't run `pi --list-models`: {e}. Check that pi is installed and on the daemon's PATH."
                )),
                Ok(Ok(out)) if !out.status.success() => fail(format!(
                    "`pi --list-models` failed ({}). Check that pi is installed.",
                    String::from_utf8_lossy(&out.stderr).trim()
                )),
                Ok(Ok(out)) => {
                    let models = parse_pi_list_models(&String::from_utf8_lossy(&out.stdout));
                    if models.is_empty() {
                        fail("`pi --list-models` returned no models. Configure a provider in pi (API key or login).".to_string())
                    } else {
                        ListModelsResult { models, error: None }
                    }
                }
            }
        })
    }

    /// pi creates the session with the id we pass it, so the chat id is known up
    /// front: the vst session id itself (see [`session_chat_id`]). Only persisted
    /// once a user turn exists, so a session that never started a conversation
    /// doesn't record a stale id for a resume that would replay nothing.
    fn capture_chat_id(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let root = pi_sessions_root();
        let id = session_chat_id(args.session);
        Box::pin(async move {
            if pi_conversation_started(&root, &id) {
                Some(id)
            } else {
                None
            }
        })
    }

    /// Whether the stored id corresponds to a real pi conversation — i.e. the
    /// session file holds ≥1 user turn (see [`pi_conversation_started`]).
    fn chat_established(&self, args: RestoreArgs<'_>) -> AsyncResult<bool> {
        let root = pi_sessions_root();
        let id = session_chat_id(args.session);
        Box::pin(async move { pi_conversation_started(&root, &id) })
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let id = session_chat_id(args.session);
        let root = pi_sessions_root();
        let model = args.model.map(|m| m.to_string());
        let prompt_file = system_prompt_path(std::path::Path::new(args.cwd), &args.session.id);
        Box::pin(async move {
            // No user turn ⇒ no conversation to resume; the caller must re-launch
            // fresh (and re-deliver the initial prompt).
            if !pi_conversation_started(&root, &id) {
                return None;
            }
            let mut argv = vec![
                "pi".to_string(),
                "--tui-mode".to_string(),
                "regular".to_string(),
                "--session-id".to_string(),
                id,
                "--approve".to_string(),
            ];
            if let Some(model) = model {
                argv.push("--model".to_string());
                argv.push(model);
            }
            if prompt_file.is_file() {
                argv.push("--append-system-prompt".to_string());
                argv.push(prompt_file.to_string_lossy().into_owned());
            }
            Some(argv)
        })
    }
}

/// Parse the table printed by `pi --list-models` into `provider/model` ids.
/// The header row (first column `provider`) and lines with fewer than two
/// columns are skipped; the remaining columns are ignored.
pub(crate) fn parse_pi_list_models(stdout: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    stdout
        .lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let (provider, model) = (cols.next()?, cols.next()?);
            if provider == "provider" && model == "model" {
                return None;
            }
            Some(format!("{provider}/{model}"))
        })
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home;
    use std::fs;
    use std::path::PathBuf;
    use vst_types::SessionRecord;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!(
            "vst-pi-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ))
    }

    fn write_session_file(root: &Path, id: &str, lines: &[&str]) -> PathBuf {
        let dir = root.join("cwd-encoded");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("1700000000_{id}.jsonl"));
        fs::write(&file, lines.join("\n")).unwrap();
        file
    }

    #[test]
    fn pi_conversation_started_requires_user_turn() {
        let root = tmp();
        // Header-only file → no conversation started.
        write_session_file(
            &root,
            "abc",
            &[r#"{"type":"session","session":{"id":"abc"}}"#],
        );
        assert!(!pi_conversation_started(&root, "abc"));

        // Header + a user message → started.
        write_session_file(
            &root,
            "abc",
            &[
                r#"{"type":"session","session":{"id":"abc"}}"#,
                r#"{"type":"message","message":{"role":"user","content":"hi"}}"#,
            ],
        );
        assert!(pi_conversation_started(&root, "abc"));

        // A different id's file → false.
        assert!(!pi_conversation_started(&root, "other"));

        // Missing root → false.
        assert!(!pi_conversation_started(&root.join("missing"), "abc"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pi_conversation_started_ignores_non_user_roles() {
        let root = tmp();
        // Only assistant/system messages → not started.
        write_session_file(
            &root,
            "abc",
            &[
                r#"{"type":"session","session":{"id":"abc"}}"#,
                r#"{"type":"message","message":{"role":"assistant","content":"hi"}}"#,
            ],
        );
        assert!(!pi_conversation_started(&root, "abc"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn pi_restore_capture_and_established_gated_on_user_turn() {
        let _guard = home::with_home(tmp());
        let root = pi_sessions_root();
        let sid = "sess-123";
        let session = SessionRecord {
            agent_chat_id: Some(sid.to_string()),
            ..make_session(sid)
        };
        let project = make_project("p1");
        let cwd = "/repos/p1";

        let restore_args = || RestoreArgs {
            session: &session,
            project: &project,
            cwd,
            model: None,
        };
        let capture_args = || CaptureArgs {
            session: &session,
            project: &project,
            cwd,
            worktree: None,
        };

        // Header-only file even with agent_chat_id stored → None / false.
        write_session_file(
            &root,
            sid,
            &[r#"{"type":"session","session":{"id":"abc"}}"#],
        );
        let plugin = PiPlugin;
        let restore = plugin.get_restore_command(restore_args()).await;
        assert!(restore.is_none(), "restore should be None, got {restore:?}");
        let captured = plugin.capture_chat_id(capture_args()).await;
        assert!(
            captured.is_none(),
            "capture should be None, got {captured:?}"
        );
        let established = plugin.chat_established(restore_args()).await;
        assert!(!established, "chat_established should be false");

        // Once a user line exists → restore Some(argv) with --session-id <id>.
        write_session_file(
            &root,
            sid,
            &[
                r#"{"type":"session","session":{"id":"abc"}}"#,
                r#"{"type":"message","message":{"role":"user","content":"hi"}}"#,
            ],
        );
        let restore = plugin.get_restore_command(restore_args()).await;
        let argv = restore.expect("restore should be Some after a user turn");
        let session_flag_idx = argv
            .iter()
            .position(|a| a == "--session-id")
            .expect("argv must contain --session-id");
        assert_eq!(argv[session_flag_idx + 1], sid);
        let captured = plugin.capture_chat_id(capture_args()).await;
        assert_eq!(captured.as_deref(), Some(sid));
        let established = plugin.chat_established(restore_args()).await;
        assert!(established);

        fs::remove_dir_all(&root).unwrap();
    }

    fn make_session(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            worktree_id: None,
            project_id: "p1".into(),
            is_main: false,
            sort_order: 0.0,
            r#type: vst_types::SessionType::Agent,
            mode_id: None,
            mode_icon: None,
            name: None,
            name_source: None,
            tmux_name: format!("vst-{id}"),
            use_tmux: true,
            channel: None,
            lifecycle: vst_types::SessionLifecycle {
                state: vst_types::LifecycleState::Working,
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
            parent_session_id: None,
            superseded_by: None,
            pr: None,
        }
    }

    fn make_project(id: &str) -> vst_types::ProjectRecord {
        vst_types::ProjectRecord {
            id: id.into(),
            absolute_path: format!("/repos/{id}"),
            prefix: "vs".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: None,
            worktrees: vec![],
            next_worktree_num: None,
            lsp_enabled: None,
            open_files: vec![],
        }
    }

    use super::parse_pi_list_models;

    #[test]
    fn skips_header_and_joins_provider_model() {
        let out = "provider        model                   context  max-out  thinking  images\n\
                   deepseek-local  deepseek-v4-flash-0731  128K     16.4K    no        no    \n";
        assert_eq!(
            parse_pi_list_models(out),
            vec!["deepseek-local/deepseek-v4-flash-0731"]
        );
    }

    #[test]
    fn handles_multiple_providers() {
        let out = "provider model context max-out thinking images\n\
                   anthropic claude-opus-4 200K 32K yes yes\n\
                   openai gpt-5 400K 128K yes yes\n";
        assert_eq!(
            parse_pi_list_models(out),
            vec!["anthropic/claude-opus-4", "openai/gpt-5"]
        );
    }

    #[test]
    fn empty_output_yields_nothing() {
        assert!(parse_pi_list_models("").is_empty());
        assert!(parse_pi_list_models("\n  \n").is_empty());
    }

    #[test]
    fn dedupes_repeated_ids() {
        assert_eq!(
            parse_pi_list_models("a m 1 2 no no\na m 1 2 no no\n"),
            vec!["a/m"]
        );
    }

    #[test]
    fn garbage_lines_are_skipped() {
        assert!(parse_pi_list_models("oops\n\nsingle\n").is_empty());
    }
}

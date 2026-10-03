//! `pi` coding agent plugin.
//!
//! Delivery: inline (system + task prompts baked into the launch command).
//! Ready signal: no sentinel, 12s fallback.
//! Terminal channel only; pi has no ACP or JSON channel.

use std::collections::BTreeMap;
use std::path::PathBuf;

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
    /// front: the vst session id itself (see [`session_chat_id`]).
    fn capture_chat_id(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let id = session_chat_id(args.session);
        Box::pin(async move { Some(id) })
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let id = session_chat_id(args.session);
        let model = args.model.map(|m| m.to_string());
        let prompt_file = system_prompt_path(std::path::Path::new(args.cwd), &args.session.id);
        Box::pin(async move {
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

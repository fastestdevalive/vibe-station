//! `vst worktree create <projectId> [options]`
//!
//! Posts to `POST /worktrees`. Mirrors `cli/src/commands/worktree/create.ts`.

use vst_types::domain::Channel;
use vst_types::rest::worktrees::CreateWorktreeBody;

use crate::client::{daemon_post, DaemonResult};
use crate::env::get_vst_session;
use crate::output::{die, success};
use crate::preflight::preflight;
use crate::text_source::resolve_file_or_inline;

use vst_types::rest::shared::Worktree;

#[derive(Clone, Debug, PartialEq)]
pub struct WorktreeCreateOptions {
    pub project_id: String,
    pub mode: String,
    pub name: Option<String>,
    pub base: Option<String>,
    pub branch: Option<String>,
    pub prompt: Option<String>,
    pub prompt_file: Option<String>,
    pub channel: String,
    pub parent: Option<String>,
    pub no_parent: bool,
}

impl Default for WorktreeCreateOptions {
    fn default() -> Self {
        Self {
            project_id: String::new(),
            mode: String::new(),
            name: None,
            base: None,
            branch: None,
            prompt: None,
            prompt_file: None,
            channel: "tmux".to_string(),
            parent: None,
            no_parent: false,
        }
    }
}

pub fn parse_worktree_create_options(args: &[String]) -> Result<WorktreeCreateOptions, String> {
    let mut opts = WorktreeCreateOptions::default();
    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mode" => {
                opts.mode = iter
                    .next()
                    .cloned()
                    .ok_or_else(|| "--mode requires an argument".to_string())?;
            }
            s if s.starts_with("--mode=") => {
                opts.mode = s.trim_start_matches("--mode=").to_string();
            }
            "--name" => {
                opts.name = iter.next().cloned();
            }
            s if s.starts_with("--name=") => {
                opts.name = Some(s.trim_start_matches("--name=").to_string());
            }
            "--base" => {
                opts.base = iter.next().cloned();
            }
            s if s.starts_with("--base=") => {
                opts.base = Some(s.trim_start_matches("--base=").to_string());
            }
            "--branch" => {
                opts.branch = iter.next().cloned();
            }
            s if s.starts_with("--branch=") => {
                opts.branch = Some(s.trim_start_matches("--branch=").to_string());
            }
            "--prompt" => {
                opts.prompt = iter.next().cloned();
            }
            s if s.starts_with("--prompt=") => {
                opts.prompt = Some(s.trim_start_matches("--prompt=").to_string());
            }
            "--prompt-file" => {
                opts.prompt_file = iter.next().cloned();
            }
            s if s.starts_with("--prompt-file=") => {
                opts.prompt_file = Some(s.trim_start_matches("--prompt-file=").to_string());
            }
            "--channel" => {
                opts.channel = iter
                    .next()
                    .cloned()
                    .ok_or_else(|| "--channel requires an argument".to_string())?;
            }
            s if s.starts_with("--channel=") => {
                opts.channel = s.trim_start_matches("--channel=").to_string();
            }
            "--parent" | "--source-agent" => {
                opts.parent = iter.next().cloned();
            }
            s if s.starts_with("--parent=") => {
                opts.parent = Some(s.trim_start_matches("--parent=").to_string());
            }
            s if s.starts_with("--source-agent=") => {
                opts.parent = Some(s.trim_start_matches("--source-agent=").to_string());
            }
            "--no-parent" => {
                opts.no_parent = true;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            other => {
                positional.push(other.to_string());
            }
        }
    }

    if positional.is_empty() {
        return Err("projectId is required".to_string());
    }
    opts.project_id = positional[0].clone();

    if opts.mode.is_empty() {
        return Err("--mode is required".to_string());
    }

    Ok(opts)
}

pub async fn run_worktree_create(opts: WorktreeCreateOptions) -> Result<(), (String, i32)> {
    let channel = match opts.channel.as_str() {
        "tmux" => Channel::Tmux,
        "json" => Channel::Json,
        other => {
            return Err((
                format!("--channel must be 'tmux' or 'json' (got '{other}')"),
                1,
            ));
        }
    };

    let prompt = resolve_file_or_inline(opts.prompt, opts.prompt_file, "--prompt-file");

    preflight().await;

    let source_agent_id = if opts.no_parent {
        None
    } else if let Some(parent) = opts.parent {
        if parent.is_empty() {
            None
        } else {
            Some(parent)
        }
    } else {
        get_vst_session()
    };

    let body = CreateWorktreeBody {
        project_id: opts.project_id,
        mode_id: opts.mode,
        branch: opts.branch,
        base_branch: opts.base,
        prompt,
        use_tmux: None,
        channel: Some(channel),
        name: opts.name,
        source_agent_id,
        skip_auto_turn: None,
    };

    let result = daemon_post::<Worktree, _>("/worktrees", Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            success(&format!("Created worktree: {}", data.branch));
            println!("{}", data.id);
            Ok(())
        }
        DaemonResult::Err {
            status,
            error,
            conflict_with,
        } => {
            let code = if status == 404 { 2 } else { 1 };
            if let Some(cw) = conflict_with {
                die(&format!("{error}\nHint: {cw}"), Some(code));
            }
            Err((error, code))
        }
    }
}

use vst_types::domain::{Channel, SessionType};
use vst_types::rest::sessions::{CreateSessionBody, SessionOrDraft};

use crate::client::{daemon_post, DaemonResult};
use crate::env::get_vst_session;
use crate::output::warn;
use crate::preflight::preflight;
use crate::text_source::resolve_file_or_inline;

#[derive(Clone, Debug, PartialEq)]
pub struct AgentCreateOptions {
    pub worktree_id: String,
    pub project_id: Option<String>,
    pub mode: Option<String>,
    pub prompt: Option<String>,
    pub prompt_file: Option<String>,
    pub channel: String,
    pub parent: Option<String>,
    pub no_parent: bool,
}

impl Default for AgentCreateOptions {
    fn default() -> Self {
        Self {
            worktree_id: String::new(),
            project_id: None,
            mode: None,
            prompt: None,
            prompt_file: None,
            channel: "tmux".to_string(),
            parent: None,
            no_parent: false,
        }
    }
}

pub fn parse_agent_create_options(args: &[String]) -> Result<AgentCreateOptions, String> {
    let mut opts = AgentCreateOptions::default();
    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--project" => {
                let val = iter
                    .next()
                    .cloned()
                    .ok_or_else(|| "--project requires an argument".to_string())?;
                if val.is_empty() {
                    return Err("--project requires a non-empty argument".to_string());
                }
                opts.project_id = Some(val);
            }
            s if s.starts_with("--project=") => {
                let val = s.trim_start_matches("--project=").to_string();
                if val.is_empty() {
                    return Err("--project requires a non-empty argument".to_string());
                }
                opts.project_id = Some(val);
            }
            "--mode" => {
                opts.mode = iter.next().cloned();
            }
            s if s.starts_with("--mode=") => {
                opts.mode = Some(s.trim_start_matches("--mode=").to_string());
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

    if let Some(pos) = positional.first() {
        if opts.project_id.is_some() {
            return Err("Cannot specify both a worktree and --project".to_string());
        }
        opts.worktree_id = pos.clone();
    } else if opts.project_id.is_none() {
        return Err("worktreeId or --project is required".to_string());
    }

    Ok(opts)
}

pub async fn run_agent_create(opts: AgentCreateOptions) -> Result<(), (String, i32)> {
    // Validate channel value
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
            warn("Warning: --parent was passed but resolved to an empty value — creating the session unlinked.");
            None
        } else {
            Some(parent)
        }
    } else {
        get_vst_session()
    };

    let (target, worktree_id, project_id) = if let Some(pid) = opts.project_id {
        (
            Some(vst_types::rest::sessions::CreateTarget::Direct),
            None,
            Some(pid),
        )
    } else {
        (None, Some(opts.worktree_id), None)
    };

    let body = CreateSessionBody {
        target,
        worktree_id,
        project_id,
        r#type: SessionType::Agent,
        mode_id: opts.mode,
        prompt,
        use_tmux: None,
        channel: Some(channel),
        name: None,
        source_agent_id,
        skip_auto_turn: None,
    };

    let result = daemon_post::<SessionOrDraft, _>("/sessions", Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            let id = match data {
                SessionOrDraft::Session(s) => s.id,
                SessionOrDraft::GlobalDraft(g) => g.id,
            };
            println!("Created session: {id}");
            println!("{id}");
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

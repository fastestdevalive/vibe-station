use vst_types::domain::SessionType;
use vst_types::rest::sessions::{CreateSessionBody, SessionOrDraft};

use crate::client::{daemon_post, DaemonResult};
use crate::env::get_vst_session;
use crate::output::warn;
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct TerminalCreateOptions {
    pub worktree_id: String,
    pub parent: Option<String>,
    pub no_parent: bool,
}

impl Default for TerminalCreateOptions {
    fn default() -> Self {
        Self {
            worktree_id: String::new(),
            parent: None,
            no_parent: false,
        }
    }
}

pub fn parse_terminal_create_options(args: &[String]) -> Result<TerminalCreateOptions, String> {
    let mut opts = TerminalCreateOptions::default();
    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--parent" => {
                opts.parent = iter.next().cloned();
            }
            s if s.starts_with("--parent=") => {
                opts.parent = Some(s.trim_start_matches("--parent=").to_string());
            }
            "--no-parent" => {
                opts.no_parent = true;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option for terminal: {other}"));
            }
            other => {
                positional.push(other.to_string());
            }
        }
    }

    if positional.is_empty() {
        return Err("worktreeId is required for terminal".to_string());
    }
    opts.worktree_id = positional[0].clone();

    Ok(opts)
}

pub async fn run_terminal_create(opts: TerminalCreateOptions) -> Result<(), (String, i32)> {
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

    let body = CreateSessionBody {
        target: None,
        worktree_id: Some(opts.worktree_id),
        project_id: None,
        r#type: SessionType::Terminal,
        mode_id: None,
        prompt: None,
        use_tmux: None,
        channel: None,
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

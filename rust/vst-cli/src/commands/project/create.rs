//! `vst project create <name> [options]`
//!
//! Posts to `POST /projects/create`. Mirrors `cli/src/commands/project/create.ts`.

use vst_types::rest::projects::{CreateNewProjectBody, CreateNewProjectResult, StartAgent};

use crate::client::{daemon_post, DaemonResult};
use crate::output::{die, success};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectCreateOptions {
    pub name: String,
    pub dir: Option<String>,
    pub start_agent: bool,
    pub mode: Option<String>,
    pub prompt: Option<String>,
    pub worktree: bool,
}

pub fn parse_project_create_options(args: &[String]) -> Result<ProjectCreateOptions, String> {
    let mut opts = ProjectCreateOptions::default();
    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--dir" => {
                opts.dir = iter.next().cloned();
            }
            s if s.starts_with("--dir=") => {
                opts.dir = Some(s.trim_start_matches("--dir=").to_string());
            }
            "--start-agent" => {
                opts.start_agent = true;
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
            "--worktree" => {
                opts.worktree = true;
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
        return Err("project name is required".to_string());
    }
    opts.name = positional[0].clone();

    if opts.start_agent && opts.mode.is_none() {
        return Err("--mode is required when using --start-agent".to_string());
    }
    if opts.prompt.is_some() && !opts.start_agent {
        return Err(
            "--prompt requires --start-agent (there is no agent to receive it otherwise)"
                .to_string(),
        );
    }

    Ok(opts)
}

pub async fn run_project_create(opts: ProjectCreateOptions) -> Result<(), (String, i32)> {
    preflight().await;

    // Expand dir: resolve ~ and relative paths.
    let dir = opts.dir.map(|d| {
        if d == "~" {
            home_dir()
        } else if d.starts_with("~/") || d.starts_with("~\\") {
            format!("{}/{}", home_dir(), &d[2..])
        } else {
            let cwd = std::env::current_dir().unwrap_or_default();
            cwd.join(&d).to_string_lossy().to_string()
        }
    });

    let start_agent = if opts.start_agent {
        opts.mode.map(|mode_id| StartAgent {
            mode_id,
            prompt: opts.prompt,
            use_worktree: if opts.worktree { Some(true) } else { None },
            branch: None,
        })
    } else {
        None
    };

    let body = CreateNewProjectBody {
        name: opts.name,
        dir,
        start_agent,
    };

    let result = daemon_post::<CreateNewProjectResult, _>("/projects/create", Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            let proj = &data.project;
            success(&format!("Created project: {}", proj.id));
            println!("  Path: {}", proj.path);

            if let Some(warning) = &data.warning {
                println!("  Warning: {warning}");
            }
            if let Some(wt) = &data.worktree {
                println!("  Worktree: {} (branch: {})", wt.id, wt.branch);
            }
            if let Some(s) = &data.session {
                let state = serde_json::to_value(&s.state)
                    .ok()
                    .and_then(|v| v.as_str().map(ToString::to_string))
                    .unwrap_or_default();
                println!("  Session: {} ({state})", s.id);
            }
            println!("{}", proj.id);
            Ok(())
        }
        DaemonResult::Err {
            status,
            error,
            conflict_with,
        } => {
            if status == 409 {
                let hint = conflict_with
                    .as_ref()
                    .map(|v| format!("\nHint: {v}"))
                    .unwrap_or_default();
                die(&format!("{error}{hint}"), Some(3));
            }
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string())
}

//! `vst project add <path> [--name <id>] [--prefix <prefix>]`
//!
//! Posts to `POST /projects`. Mirrors `cli/src/commands/project/add.ts`.

use std::path::Path;

use vst_types::rest::projects::CreateProjectBody;
use vst_types::rest::shared::Project;

use crate::client::{daemon_post, DaemonResult};
use crate::output::{die, success};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectAddOptions {
    pub path: String,
    pub name: Option<String>,
    pub prefix: Option<String>,
}

pub fn parse_project_add_options(args: &[String]) -> Result<ProjectAddOptions, String> {
    let mut opts = ProjectAddOptions::default();
    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--name" => {
                opts.name = iter.next().cloned();
            }
            s if s.starts_with("--name=") => {
                opts.name = Some(s.trim_start_matches("--name=").to_string());
            }
            "--prefix" => {
                opts.prefix = iter.next().cloned();
            }
            s if s.starts_with("--prefix=") => {
                opts.prefix = Some(s.trim_start_matches("--prefix=").to_string());
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
        return Err("path is required".to_string());
    }
    opts.path = positional[0].clone();
    Ok(opts)
}

pub async fn run_project_add(opts: ProjectAddOptions) -> Result<(), (String, i32)> {
    // Resolve path against the CLI's cwd — the daemon runs in a different
    // working directory, so relative paths would otherwise be interpreted
    // against the daemon's cwd and fail.
    let abs_path = match Path::new(&opts.path).canonicalize() {
        Ok(p) => p.to_string_lossy().to_string(),
        // If not canonicalize-able (path doesn't exist yet), just resolve it.
        Err(_) => {
            let cwd = std::env::current_dir().unwrap_or_default();
            cwd.join(&opts.path).to_string_lossy().to_string()
        }
    };

    preflight().await;

    let body = CreateProjectBody {
        path: abs_path,
        name: opts.name,
        prefix: opts.prefix,
        setup: None,
    };

    let result = daemon_post::<Project, _>("/projects", Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            success(&format!("Project added: {}", data.id));
            println!("{}", data.id);
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

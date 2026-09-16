//! `vst worktree ls [--project <id>] [--json]`
//!
//! Sends `GET /worktrees[?project=<id>]`. Mirrors `cli/src/commands/worktree/ls.ts`.

use vst_types::rest::shared::Worktree;

use crate::client::{daemon_get, DaemonResult};
use crate::env::get_vst_project;
use crate::output::{print_json, print_table};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorktreeLsOptions {
    pub project: Option<String>,
    pub json: bool,
}

pub fn parse_worktree_ls_options(args: &[String]) -> Result<WorktreeLsOptions, String> {
    let mut opts = WorktreeLsOptions::default();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--project" => {
                opts.project = iter.next().cloned();
            }
            s if s.starts_with("--project=") => {
                opts.project = Some(s.trim_start_matches("--project=").to_string());
            }
            "--json" => {
                opts.json = true;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            _ => {}
        }
    }

    Ok(opts)
}

pub async fn run_worktree_ls(opts: WorktreeLsOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let project_id = opts.project.or_else(get_vst_project);
    let query = match &project_id {
        Some(id) => format!("?project={id}"),
        None => String::new(),
    };

    let result = daemon_get::<Vec<Worktree>>(&format!("/worktrees{query}"))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }

            let rows: Vec<Vec<String>> = data
                .iter()
                .map(|w| {
                    vec![
                        w.id.clone(),
                        w.name.clone().unwrap_or_default(),
                        w.project_id.clone(),
                        w.branch.clone(),
                    ]
                })
                .collect();

            print_table(&["ID", "Name", "Project", "Branch"], &rows);
            Ok(())
        }
        DaemonResult::Err { error, .. } => Err((error, 1)),
    }
}

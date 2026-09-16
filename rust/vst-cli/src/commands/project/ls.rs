//! `vst project ls [--json]`
//!
//! Sends `GET /projects`. Mirrors `cli/src/commands/project/ls.ts`.

use vst_types::rest::shared::Project;

use crate::client::{daemon_get, DaemonResult};
use crate::output::{print_json, print_table};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectLsOptions {
    pub json: bool,
}

pub fn parse_project_ls_options(args: &[String]) -> Result<ProjectLsOptions, String> {
    let mut opts = ProjectLsOptions::default();

    for arg in args {
        match arg.as_str() {
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

pub async fn run_project_ls(opts: ProjectLsOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<Vec<Project>>("/projects")
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }

            let rows: Vec<Vec<String>> = data
                .iter()
                .map(|p| vec![p.id.clone(), p.name.clone(), p.path.clone()])
                .collect();

            print_table(&["ID", "Name", "Path"], &rows);
            Ok(())
        }
        DaemonResult::Err { error, .. } => Err((error, 1)),
    }
}

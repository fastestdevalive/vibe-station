//! `vst project info <id> [--json]`
//!
//! Sends `GET /projects/:id`. Mirrors `cli/src/commands/project/info.ts`.

use vst_types::rest::shared::Project;

use crate::client::{daemon_get, DaemonResult};
use crate::output::{print_json, print_table};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectInfoOptions {
    pub id: String,
    pub json: bool,
}

pub fn parse_project_info_options(args: &[String]) -> Result<ProjectInfoOptions, String> {
    let mut opts = ProjectInfoOptions::default();
    let mut positional = Vec::new();

    for arg in args {
        match arg.as_str() {
            "--json" => {
                opts.json = true;
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
        return Err("project id is required".to_string());
    }
    opts.id = positional[0].clone();
    Ok(opts)
}

pub async fn run_project_info(opts: ProjectInfoOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<Project>(&format!("/projects/{}", opts.id))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }

            let rows = vec![
                vec!["ID".to_string(), data.id.clone()],
                vec!["Name".to_string(), data.name.clone()],
                vec!["Path".to_string(), data.path.clone()],
                vec!["Prefix".to_string(), data.prefix.clone()],
                vec!["Git".to_string(), data.is_git.to_string()],
                vec!["Created".to_string(), data.created_at.clone()],
            ];

            print_table(&["Field", "Value"], &rows);
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

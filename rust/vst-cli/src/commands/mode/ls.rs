use vst_types::rest::shared::Mode;

use crate::client::daemon_get;
use crate::output::{print_json, print_table};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModeLsOptions {
    pub json: bool,
}

pub fn parse_mode_ls_options(args: &[String]) -> Result<ModeLsOptions, String> {
    let mut opts = ModeLsOptions::default();
    for arg in args {
        if arg == "--json" {
            opts.json = true;
        } else {
            return Err(format!("Unknown option: {arg}"));
        }
    }
    Ok(opts)
}

pub async fn run_mode_ls(opts: ModeLsOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<Vec<Mode>>("/modes")
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        crate::client::DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }

            let rows: Vec<Vec<String>> = data
                .iter()
                .map(|m| {
                    vec![
                        m.id.clone(),
                        m.name.clone(),
                        serde_json::to_value(m.cli)
                            .ok()
                            .and_then(|v| v.as_str().map(ToString::to_string))
                            .unwrap_or_default(),
                        String::new(), // preset is not in serialized Mode, empty string
                    ]
                })
                .collect();

            print_table(&["ID", "Name", "CLI", "Preset"], &rows);
            Ok(())
        }
        crate::client::DaemonResult::Err { error, .. } => Err((error, 1)),
    }
}

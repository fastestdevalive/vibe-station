use vst_types::domain::CliId;
use vst_types::rest::modes::CreateModeBody;
use vst_types::rest::shared::Mode;

use crate::client::{daemon_post, DaemonResult};
use crate::output::success;
use crate::preflight::preflight;
use crate::text_source::resolve_file_or_inline;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModeAddOptions {
    pub name: Option<String>,
    pub cli: Option<String>,
    pub context: Option<String>,
    pub context_file: Option<String>,
    pub preset: Option<String>,
}

pub fn parse_mode_add_options(args: &[String]) -> Result<ModeAddOptions, String> {
    let mut opts = ModeAddOptions::default();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--name" => {
                opts.name = iter.next().cloned();
            }
            s if s.starts_with("--name=") => {
                opts.name = Some(s.trim_start_matches("--name=").to_string());
            }
            "--cli" => {
                opts.cli = iter.next().cloned();
            }
            s if s.starts_with("--cli=") => {
                opts.cli = Some(s.trim_start_matches("--cli=").to_string());
            }
            "--context" => {
                opts.context = iter.next().cloned();
            }
            s if s.starts_with("--context=") => {
                opts.context = Some(s.trim_start_matches("--context=").to_string());
            }
            "--context-file" => {
                opts.context_file = iter.next().cloned();
            }
            s if s.starts_with("--context-file=") => {
                opts.context_file = Some(s.trim_start_matches("--context-file=").to_string());
            }
            "--preset" => {
                opts.preset = iter.next().cloned();
            }
            s if s.starts_with("--preset=") => {
                opts.preset = Some(s.trim_start_matches("--preset=").to_string());
            }
            other => {
                return Err(format!("Unknown option: {other}"));
            }
        }
    }

    Ok(opts)
}

pub async fn run_mode_add(opts: ModeAddOptions) -> Result<(), (String, i32)> {
    let name = match opts.name {
        Some(n) if !n.is_empty() => n,
        _ => return Err(("--name is required".to_string(), 1)),
    };

    let cli_str = match opts.cli {
        Some(c) if !c.is_empty() => c,
        _ => return Err(("--cli is required".to_string(), 1)),
    };

    let cli: CliId = serde_json::from_value(serde_json::Value::String(cli_str.clone()))
        .map_err(|_| (format!("Invalid cli: {cli_str}"), 1))?;

    let context = resolve_file_or_inline(opts.context, opts.context_file, "--context-file")
        .unwrap_or_default();

    preflight().await;

    let body = CreateModeBody {
        name,
        cli,
        context,
        preset_id: opts.preset,
        model: None,
    };

    let result = daemon_post::<Mode, _>("/modes", Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            success(&format!("Mode added: {}", data.id));
            println!("{}", data.id);
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 409 { 3 } else { 1 };
            Err((error, code))
        }
    }
}

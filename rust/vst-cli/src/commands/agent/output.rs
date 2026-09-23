use vst_types::rest::sessions::SessionOutput;

use crate::client::{daemon_get, DaemonResult};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionOutputOptions {
    pub id: String,
    pub lines: String,
}

pub fn parse_session_output_options(args: &[String]) -> Result<SessionOutputOptions, String> {
    let mut opts = SessionOutputOptions {
        id: String::new(),
        lines: "100".to_string(),
    };
    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--lines" => {
                opts.lines = iter
                    .next()
                    .cloned()
                    .ok_or_else(|| "--lines requires an argument".to_string())?;
            }
            s if s.starts_with("--lines=") => {
                opts.lines = s.trim_start_matches("--lines=").to_string();
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
        return Err("Session ID is required".to_string());
    }
    opts.id = positional[0].clone();

    Ok(opts)
}

pub async fn run_session_output(opts: SessionOutputOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<SessionOutput>(&format!(
        "/sessions/{}/output?lines={}",
        opts.id, opts.lines
    ))
    .await
    .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            println!("{}", data.output);
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}

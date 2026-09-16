//! `vst daemon status [--json]`
//!
//! Sends `GET /health`. Mirrors `cli/src/commands/daemon/status.ts`.

use vst_types::rest::health::Health;

use crate::client::{daemon_get, DaemonResult};
use crate::output::{die, print_json, success};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DaemonStatusOptions {
    pub json: bool,
}

pub fn parse_daemon_status_options(args: &[String]) -> Result<DaemonStatusOptions, String> {
    let mut opts = DaemonStatusOptions::default();

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

pub async fn run_daemon_status(opts: DaemonStatusOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<Health>("/health")
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }

            success("Daemon is running");
            println!("  Port: {}", data.port);
            if !data.version.is_empty() {
                println!("  Version: {}", data.version);
            }
            println!("  Uptime: {}", format_seconds(data.uptime));
            Ok(())
        }
        DaemonResult::Err { .. } => {
            die("Daemon health check failed", Some(4));
        }
    }
}

fn format_seconds(seconds: i64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m", seconds / 60)
    } else {
        format!("{}h", seconds / 3600)
    }
}

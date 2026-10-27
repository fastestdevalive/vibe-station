#![forbid(unsafe_code)]

//! Thin compat entry point for the standalone `vst-daemon` binary.
//!
//! Kept for `cargo run -p vst-daemon` (dev scripts, Docker sandbox) and for
//! argv0 == `vst-daemon` compatibility — see `rust/vst-cli/src/dispatch.rs`
//! for the merged `vst` binary's own daemon-entry detection. This binary
//! unconditionally means "run the daemon"; all the actual startup logic
//! lives in `vst_daemon::run_daemon` (`src/run.rs`) so both entry points
//! share one implementation.

#[tokio::main]
async fn main() {
    // Hidden subcommand: stdout is the ACP channel, so this must run BEFORE
    // `init_tracing()` (which logs to stdout).
    if std::env::args().nth(1).as_deref() == Some("agy-stream-acp") {
        if let Err(e) = vst_daemon::run_agy_stream_acp().await {
            eprintln!("{e:?}");
            std::process::exit(1);
        }
        return;
    }

    vst_daemon::init_tracing();

    if let Err(e) = vst_daemon::run_daemon(vst_daemon::DaemonOptions::default()).await {
        eprintln!("{e:?}");
        std::process::exit(1);
    }
}

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
    vst_daemon::init_tracing();

    if let Err(e) = vst_daemon::run_daemon(vst_daemon::DaemonOptions::default()).await {
        eprintln!("{e:?}");
        std::process::exit(1);
    }
}

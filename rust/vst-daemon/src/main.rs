#![forbid(unsafe_code)]

//! Thin compat entry point for the standalone `vst-daemon` binary.
//!
//! Kept for `cargo run -p vst-daemon` (dev scripts, Docker sandbox) and for
//! argv0 == `vst-daemon` compatibility — see `rust/vst-cli/src/dispatch.rs`
//! for the merged `vst` binary's own daemon-entry detection. This binary
//! unconditionally means "run the daemon"; all the actual startup logic
//! lives in `vst_daemon::run_daemon` (`src/run.rs`) so both entry points
//! share one implementation.
//!
//! `VST_TAURI_SUPERVISED` (exactly `"1"` or `"true"`) is the only way to get
//! a non-headless daemon here — set by Tauri's own sidecar-spawn code
//! (`desktop/src-tauri/src/daemon.rs`). Every other invocation of this
//! binary (dev scripts, an operator running it directly) defaults headless.

#[tokio::main]
async fn main() {
    vst_daemon::init_tracing();

    let supervised = matches!(
        std::env::var("VST_TAURI_SUPERVISED").as_deref(),
        Ok("1") | Ok("true")
    );

    if let Err(e) = vst_daemon::run_daemon(vst_daemon::DaemonOptions {
        headless: !supervised,
    })
    .await
    {
        eprintln!("{e:?}");
        std::process::exit(1);
    }
}

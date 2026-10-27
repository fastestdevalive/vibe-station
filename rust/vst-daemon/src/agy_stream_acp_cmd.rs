//! Hidden `agy-stream-acp` subcommand: runs the agy stream-json ACP agent.
//!
//! Spawned by the agy plugin as `<current_exe> agy-stream-acp [--model <m>]`
//! and spoken to over stdio. Both the `vst` and `vst-daemon` binaries route
//! here, so no extra sidecar binary is needed.

/// Run the agent until stdin closes.
///
/// stdout IS the ACP channel: never call [`crate::init_tracing`] (it logs to
/// stdout). Tracing goes to stderr only.
pub async fn run_agy_stream_acp() -> anyhow::Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .try_init();
    let agy_bin = std::env::var("AGY_BIN").unwrap_or_else(|_| "agy".into());
    let model = std::env::args().skip_while(|a| a != "--model").nth(1);
    vst_agy_stream_acp::run_stdio(vst_agy_stream_acp::Options { agy_bin, model }).await
}

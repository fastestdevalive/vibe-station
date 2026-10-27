#![forbid(unsafe_code)]
//! Dev/test binary for `vst-agy-stream-acp`.
//!
//! Shipped as the hidden `agy-stream-acp` subcommand of `vst`/`vst-daemon`
//! (which install a stderr-only tracing subscriber); this standalone bin exists
//! so the crate's e2e tests can drive the agent over stdio
//! (`CARGO_BIN_EXE_vst-agy-stream-acp`). It is never packaged.
//!
//! stdout is the ACP channel — nothing else may write to it.

use vst_agy_stream_acp::{run_stdio, Options};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let agy_bin = std::env::var("AGY_BIN").unwrap_or_else(|_| "agy".to_string());
    let model = std::env::args().skip_while(|arg| arg != "--model").nth(1);
    run_stdio(Options { agy_bin, model }).await
}

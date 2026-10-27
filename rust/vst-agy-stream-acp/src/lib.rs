#![forbid(unsafe_code)]
//! `vst-agy-stream-acp` — an ACP agent (stdio, server side) that drives ONE
//! long-lived `agy --input-format stream-json --output-format stream-json`
//! process per session.
//!
//! Why it exists: agy's stream-json mode reports its NATIVE conversation id in
//! `init.conversation_id`, so using it as the ACP `session/new` id makes the
//! harness's two session identities *identical* (the omp shape) and removes the
//! old id bridge entirely. `session/load` spawns `agy --conversation <id>` and
//! refuses to continue if agy reports a different id (agy silently forks on an
//! unknown id).
//!
//! Boundaries:
//! - [`wire`] is the only module that knows agy's JSON shapes;
//! - [`map`] turns agy steps/results into ACP updates + a turn outcome;
//! - [`transcript`] is the only module that knows agy's on-disk transcript (the
//!   source of file-edit diffs);
//! - [`edit_diff`] turns a transcript edit into line-numbered diff pieces;
//! - [`process`] owns the child process (argv, stdout/stderr, signals);
//! - [`agent`] is the ACP handler layer (session state, cancel, respawn).
//!
//! No `vst-*` dependency: this crate is spawned as the hidden
//! `agy-stream-acp` subcommand of the `vst`/`vst-daemon` binary.

pub mod agent;
pub mod edit_diff;
pub mod map;
pub mod process;
pub mod transcript;
pub mod wire;

pub use agent::Options;

use agent_client_protocol::schema::v1::{
    CancelNotification, InitializeRequest, LoadSessionRequest, NewSessionRequest, PromptRequest,
};
use agent_client_protocol::{on_receive_notification, on_receive_request, Agent, Error, Stdio};
use std::sync::Arc;

/// Run the ACP agent over stdio until the client closes stdin.
///
/// stdout is the protocol channel: callers must never install a
/// stdout-writing tracing subscriber (the daemon entry point installs a
/// stderr-only one).
///
/// # Errors
///
/// When the ACP connection itself fails (transport error). Agent-level
/// failures are reported to the client as JSON-RPC errors instead.
pub async fn run_stdio(opts: Options) -> anyhow::Result<()> {
    let shared = agent::Shared::new(opts);

    let initialize = async move |req: InitializeRequest, responder, _cx| {
        agent::handle_initialize(responder, req)
    };
    let new_session = {
        let shared = Arc::clone(&shared);
        async move |req: NewSessionRequest, responder, _cx| {
            agent::handle_new_session(Arc::clone(&shared), responder, req).await
        }
    };
    let load_session = {
        let shared = Arc::clone(&shared);
        async move |req: LoadSessionRequest, responder, _cx| {
            agent::handle_load_session(Arc::clone(&shared), responder, req).await
        }
    };
    let prompt = {
        let shared = Arc::clone(&shared);
        async move |req: PromptRequest, responder, cx| {
            agent::handle_prompt(Arc::clone(&shared), cx, responder, req).await
        }
    };
    let cancel = {
        let shared = Arc::clone(&shared);
        async move |notif: CancelNotification, _cx| {
            agent::handle_cancel(Arc::clone(&shared), notif).await
        }
    };
    let close = {
        let shared = Arc::clone(&shared);
        async move |_cx| {
            shared.shutdown().await;
            Ok::<(), Error>(())
        }
    };

    Agent
        .builder()
        .name("vst-agy-stream-acp")
        .on_receive_request(initialize, on_receive_request!())
        .on_receive_request(new_session, on_receive_request!())
        .on_receive_request(load_session, on_receive_request!())
        .on_receive_request(prompt, on_receive_request!())
        .on_receive_notification(cancel, on_receive_notification!())
        .on_close(close)
        .connect_to(Stdio::new())
        .await
        .map_err(|error| anyhow::anyhow!("ACP connection failed: {error}"))?;

    // `on_close` only runs on a clean EOF; sweep again so no agy survives any
    // exit path.
    shared.shutdown().await;
    Ok(())
}

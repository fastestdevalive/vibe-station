//! Part `04-spike` deliverable (orchestrator-authored, per the arch doc —
//! never dispatched to a `DeepSeek` session): proves the `agent-client-protocol`
//! Rust crate can actually drive `claude-agent-acp` end to end —
//! `initialize` -> `session/new` -> `session/prompt` -> streamed
//! `session/update` notifications -> the prompt's final `stopReason`.
//!
//! This validates the exact crate version pinned in `vst-agents/Cargo.toml`
//! against the exact adapter version the daemon's `package.json` pins
//! (`@agentclientprotocol/claude-agent-acp@0.70.0`), so the transport shape
//! `04b` implements against (`vst-agents/src/acp_transport.rs`) is frozen
//! against something that has actually round-tripped a real turn, not just
//! against the crate's own type signatures.
//!
//! # Requires
//! - `npx` on PATH (spawns the adapter via `npx -y
//!   @agentclientprotocol/claude-agent-acp@0.70.0`, network access on first
//!   run to fetch/cache the npm package).
//! - The `claude` CLI already authenticated in this environment (the adapter
//!   shells out to the Claude Agent SDK, which uses the same auth as `claude`).
//!
//! # Usage
//! ```bash
//! cargo run -p vst-agents --example acp_hello
//! ```

use std::path::PathBuf;

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};

const PINNED_ADAPTER_SPEC: &str = "@agentclientprotocol/claude-agent-acp@0.70.0";
const PROMPT: &str = "Reply with exactly one word: hello";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("spawning: npx -y {PINNED_ADAPTER_SPEC}");

    // Pinned to the exact adapter version the daemon's package.json already
    // depends on (NOT `AcpAgent::claude_agent()`, which floats to `@latest` —
    // a frozen spike needs a reproducible target).
    let agent = AcpAgent::from_args(["npx", "-y", PINNED_ADAPTER_SPEC])?;

    agent_client_protocol::Client
        .builder()
        // "stream": every `session/update` notification the adapter sends
        // while a prompt is in flight lands here — this is the same event
        // stream `04b`'s `AcpTransport::send_prompt` must expose to callers.
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                eprintln!("session/update: {:?}", notification.update);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        // ACP permission requests: auto-approve, mirroring the "yolo" pattern
        // — a real plugin would route this through the daemon's own
        // permission flow, out of scope for this spike.
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let option_id = request.options.first().map(|opt| opt.option_id.clone());
                if let Some(id) = option_id {
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
                    ))
                } else {
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            // "initialize"
            eprintln!("-> initialize");
            let init_response = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            eprintln!("<- initialized: agent_info={:?}", init_response.agent_info);

            // "session/new"
            eprintln!("-> session/new");
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
            let new_session_response = connection
                .send_request(NewSessionRequest::new(cwd))
                .block_task()
                .await?;
            let session_id = new_session_response.session_id;
            eprintln!("<- session created: {session_id:?}");

            // "session/prompt" (streams via the on_receive_notification
            // handler above while this request is in flight)
            eprintln!("-> session/prompt: {PROMPT:?}");
            let prompt_response = connection
                .send_request(PromptRequest::new(
                    session_id,
                    vec![ContentBlock::Text(TextContent::new(PROMPT.to_string()))],
                ))
                .block_task()
                .await?;

            eprintln!(
                "<- prompt complete: stop_reason={:?}",
                prompt_response.stop_reason
            );
            Ok(())
        })
        .await?;

    eprintln!("acp_hello: initialize -> session/new -> session/prompt -> stream: all OK");
    Ok(())
}

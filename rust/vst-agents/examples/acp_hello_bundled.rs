//! Same end-to-end proof as `acp_hello.rs` (`initialize` -> `session/new` ->
//! `session/prompt` -> streamed `session/update`s -> final `stopReason`), but
//! against the pinned Rust `claude-acp` adapter (`claude.rs::claude_acp_bin`).
//! This is what proves the no-Node/no-bun path works end to end for a real
//! turn.
//!
//! # Requires
//! - The adapter built: `scripts/build-rust-acp.sh claude` (or `VST_CLAUDE_ACP_BIN`).
//! - The `claude` CLI already authenticated in this environment (this
//!   example sets `CLAUDE_CODE_EXECUTABLE=claude` itself, same as `claude.rs`).
//!
//! # Usage
//! ```bash
//! cargo run -p vst-agents --example acp_hello_bundled
//! ```

use std::path::PathBuf;

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};

const PROMPT: &str = "Reply with exactly one word: hello";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Same env this plugin's real `run_turn` sets — see `claude.rs`.
    std::env::set_var("CLAUDE_CODE_EXECUTABLE", "claude");
    let bin = vst_agents::claude::claude_acp_bin().ok_or(
        "claude-acp not found: run scripts/build-rust-acp.sh claude or set VST_CLAUDE_ACP_BIN",
    )?;
    eprintln!("spawning: {}", bin.display());

    let agent = AcpAgent::from_args([bin.to_string_lossy().as_ref()])?;

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                eprintln!("session/update: {:?}", notification.update);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
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
            eprintln!("-> initialize");
            let init_response = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            eprintln!("<- initialized: agent_info={:?}", init_response.agent_info);

            eprintln!("-> session/new");
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
            let new_session_response = connection
                .send_request(NewSessionRequest::new(cwd))
                .block_task()
                .await?;
            let session_id = new_session_response.session_id;
            eprintln!("<- session created: {session_id:?}");

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

    eprintln!("acp_hello_bundled: initialize -> session/new -> session/prompt -> stream: all OK, no Node.js in the loop");
    Ok(())
}

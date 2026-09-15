//! Live-CLI integration tests for the concrete `AcpTransport` implementation —
//! the 04b-relevant subset of the `*AcpLive.test.ts` files. These drive the
//! REAL external agent CLI through the pinned `agent-client-protocol` adapter,
//! making live model calls (network access, real auth/tokens — same category
//! as 04-spike's `examples/acp_hello.rs`).
//!
//! Gated behind BOTH `#[ignore]` and the `VST_ACP_LIVE_TESTS` env var, so they
//! show up as ignored-by-default and never run in the gate script (which does
//! not pass `--ignored`). Run explicitly with:
//!
//! ```sh
//! VST_ACP_LIVE_TESTS=1 cargo test -p vst-agents -- --ignored acp_live
//! ```
//!
//! NOTE: the TS `*AcpLive.test.ts` files drive `plugin.runTurn` end to end;
//! `run_turn` is 04c's scope, so this part ports only the transport leg
//! (initialize → session/new → prompt over a real CLI). The full
//! `runTurn`-driven live assertions belong to 04c.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, StopReason, TextContent};
use vst_agents::acp_connection::{AcpConnection, AcpLaunchSpec};
use vst_agents::acp_transport::AcpTransport;

const PINNED_ADAPTER_SPEC: &str = "@agentclientprotocol/claude-agent-acp@0.70.0";

async fn live_conn() -> Option<AcpConnection> {
    if std::env::var("VST_ACP_LIVE_TESTS").is_err() {
        return None;
    }
    Some(AcpConnection::new(AcpLaunchSpec {
        command: "npx".to_string(),
        args: vec!["-y".to_string(), PINNED_ADAPTER_SPEC.to_string()],
        cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
        env: HashMap::new(),
        initialize_timeout_ms: Some(60_000),
        prompt_timeout_ms: Some(60_000),
    }))
}

#[tokio::test]
#[ignore = "live CLI test: requires VST_ACP_LIVE_TESTS=1 and an authenticated claude"]
async fn live_claude_initialize_new_session_prompt() {
    let Some(conn) = live_conn().await else {
        return;
    };
    let outcome = conn.initialize().await.expect("initialize");
    assert!(outcome.load_session_supported);
    let session_id = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session");
    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new(
            "Reply with exactly one word: hello",
        ))],
    );
    let stop = tokio::time::timeout(Duration::from_secs(120), turn.result)
        .await
        .expect("live prompt must not hang")
        .expect("live prompt result resolves")
        .expect("live prompt succeeds");
    assert_eq!(stop, StopReason::EndTurn);
    conn.dispose().await;
}

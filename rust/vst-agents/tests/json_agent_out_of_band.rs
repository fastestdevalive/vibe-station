//! Session-level persist/classify contract for out-of-band (autonomous) ACP
//! updates — `JsonAgentSession::ingest_out_of_band_update`.
//!
//! Decision 2/3: content kinds (Text/Thinking/ToolUse/ToolResult/Status-from-Plan)
//! are persisted under a burst-stable `notif-<uuid>` turn and broadcast; usage
//! and commands updates mutate session meta only; nothing changes lifecycle /
//! `turn_state`.

mod common;

use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    AvailableCommand, AvailableCommandsUpdate, ContentBlock, ContentChunk, SessionUpdate,
    TextContent, UsageUpdate,
};
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_types::{Broadcaster, NormalizedEventKind, NormalizedEventProvider};

const PROJECT_ID: &str = "p1";
const SESSION_ID: &str = "sess-oob-1";

/// A live session rooted in a temp home. The session's vst id is `SESSION_ID`,
/// distinct from the ACP session id (`"acp-x"`) passed to `ingest_out_of_band_update`.
fn live_session(home: &std::path::Path) -> JsonAgentSession {
    let store_handle =
        vst_store::StoreHandle::open(home.join("vibe-station.db")).expect("open store");
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let mut session = common::make_session(SESSION_ID);
    session.project_id = PROJECT_ID.into();
    let project = common::make_project(PROJECT_ID);

    JsonAgentSession::new(JsonAgentSessionOptions {
        project,
        worktree: None,
        session,
        plugin: Arc::new(vst_agents::claude::create_claude_plugin()),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: Broadcaster(tx),
    })
}

fn chunk(text: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(
        text,
    ))))
}

/// 2.T3 — a content update ingested out-of-band persists under a `notif-*`
/// turn, stamped with the vst session id (not the ACP id), preceded by one
/// Status burst marker, and leaves `turn_state` untouched.
///
/// Uses `read_transcript()` (all rows) rather than `since(0, None)`: the
/// burst-start Status is the first row (`seq 0`), and `since(0, None)` filters
/// `seq > 0`, which would silently exclude it. `read_transcript` is the
/// faithful "Status precedes the Text row" representation.
#[tokio::test]
async fn content_update_persists_under_notif_turn() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = live_session(dir.path());

    let turn_state_before = session.get_meta().turn_state;

    session.ingest_out_of_band_update(&chunk("autonomous text"), "acp-x", None);

    let events = session.read_transcript();
    assert_eq!(events.len(), 2, "one Status burst marker + one Text row");

    assert_eq!(events[0].kind, NormalizedEventKind::Status);
    assert_eq!(
        events[0].text.as_deref(),
        Some("Agent resumed work on its own")
    );

    let text = &events[1];
    assert_eq!(text.kind, NormalizedEventKind::Text);
    let turn_id = text.turn_id.as_deref().expect("turn_id set");
    assert!(
        turn_id.starts_with("notif-"),
        "turn_id must start with notif-: {turn_id}"
    );
    assert_eq!(
        text.session_id, SESSION_ID,
        "session_id is the vst id, not the ACP id \"acp-x\""
    );
    assert_eq!(
        events[0].turn_id.as_deref(),
        Some(turn_id),
        "the burst-start Status marker shares the notif turn"
    );

    // No lifecycle / turn_state change (Decision 2).
    assert_eq!(session.get_meta().turn_state, turn_state_before);
}

/// 2.T4 — two updates within the 30s burst gap share one `notif-` turn;
/// forcing the burst clock to 0 starts a new one; Usage and Commands updates
/// create zero rows but change `get_meta()`.
#[tokio::test]
async fn burst_stability_and_meta_only_updates() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = live_session(dir.path());

    // Two updates within the burst gap share one turn id.
    session.ingest_out_of_band_update(&chunk("a"), "acp-x", None);
    session.ingest_out_of_band_update(&chunk("b"), "acp-x", None);

    let events = session.read_transcript();
    // Status(a) Text(a) Text(b), all under one notif turn.
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].kind, NormalizedEventKind::Status);
    let turn_a = events[1].turn_id.clone();
    let turn_b = events[2].turn_id.clone();
    assert_eq!(
        turn_a, turn_b,
        "two updates within the burst gap share one turn"
    );
    assert!(turn_a.as_deref().unwrap().starts_with("notif-"));

    // Forcing the burst clock to 0 starts a NEW notif turn.
    session.set_out_of_band_last_at_ms_for_test(0);
    session.ingest_out_of_band_update(&chunk("c"), "acp-x", None);

    let events = session.read_transcript();
    // Status(a) Text(a) Text(b) Status(b) Text(c)
    assert_eq!(events.len(), 5);
    assert_eq!(events[3].kind, NormalizedEventKind::Status);
    let last = events.last().unwrap();
    assert_eq!(last.kind, NormalizedEventKind::Text);
    assert_ne!(
        last.turn_id, turn_a,
        "resetting the burst clock must start a new notif turn"
    );
    assert!(last.turn_id.as_deref().unwrap().starts_with("notif-"));

    // Usage + commands updates create zero rows but change meta.
    let rows_before = session.read_transcript().len();
    session.ingest_out_of_band_update(
        &SessionUpdate::UsageUpdate(UsageUpdate::new(12_000, 200_000)),
        "acp-x",
        None,
    );
    session.ingest_out_of_band_update(
        &SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(vec![
            AvailableCommand::new("/plan", "Plan mode"),
        ])),
        "acp-x",
        None,
    );

    assert_eq!(
        session.read_transcript().len(),
        rows_before,
        "usage/commands updates must not create transcript rows"
    );
    assert_eq!(
        session.get_meta().usage.map(|u| u.total_tokens),
        Some(12_000),
        "usage update must be merged into session meta"
    );
    let cmds = session.get_meta().commands.unwrap_or_default();
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0].name, "plan");
}

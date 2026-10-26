//! Integration tests for `carry_session_transcript` (reset-keep-history-switch,
//! Phase 1): carried-kinds filtering, field clearing, session_id rewrite,
//! `skip_turn_id` dropping, the trailing session-break marker, the missing-old-dir
//! early return, and the live-session first-turn flag over a carried store.

use std::collections::BTreeMap;
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use vst_agents::home::with_home;
use vst_agents::json_agent_session::{
    carry_session_transcript, read_transcript_from_data_dir, JsonAgentSession,
    JsonAgentSessionOptions, SessionBreakMarker,
};
use vst_agents::paths::Paths;
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_store::transcript::open_transcript_store;
use vst_types::{
    CarryOver, Channel, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider,
    SessionBreakKind,
};

mod common;

/// Minimal no-op plugin, copied from json_agent_session_queue.rs's MockTurnPlugin.
struct MockTurnPlugin;

impl AgentPlugin for MockTurnPlugin {
    fn name(&self) -> &str {
        "mock"
    }
    fn default_model(&self) -> &str {
        "mock-model"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
    }
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
        ComposePromptResult::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (_tx, rx) = mpsc::unbounded_channel();
        rx
    }
}

/// Build a `NormalizedEvent` with the given kind/session/turn, plus an optional
/// model/usage marker so the test can assert they are cleared.
fn ev(
    kind: NormalizedEventKind,
    session_id: &str,
    turn_id: &str,
    with_meta: bool,
) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("{}-{}", kind_str(kind), turn_id),
        "sessionId": session_id,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": serde_json::to_value(kind).unwrap(),
        "turnId": turn_id,
    }))
    .unwrap();
    match kind {
        NormalizedEventKind::User => e.role = Some(vst_types::Role::User),
        NormalizedEventKind::Text => {
            e.role = Some(vst_types::Role::Assistant);
            e.text = Some(format!("hello {turn_id}"));
        }
        NormalizedEventKind::ToolUse => {
            e.tool_id = Some(format!("tool-{turn_id}"));
            e.tool_name = Some("bash".into());
        }
        NormalizedEventKind::ToolResult => {
            e.tool_id = Some(format!("tool-{turn_id}"));
            e.tool_result = Some(vst_types::ToolResult {
                content: Some("ok".into()),
                is_error: None,
            });
        }
        NormalizedEventKind::Usage => {
            e.usage = Some(vst_types::UsageInfo {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                total_tokens: 2,
                context_window: None,
                cost_usd: None,
                model: "m".into(),
            });
        }
        NormalizedEventKind::ModeUpdate => e.mode_id = Some("m2".into()),
        _ => {}
    }
    if with_meta {
        e.model = Some("old-model".into());
        e.agent_chat_id = Some("old-chat".into());
    }
    e
}

fn kind_str(kind: NormalizedEventKind) -> &'static str {
    match kind {
        NormalizedEventKind::SessionInit => "session_init",
        NormalizedEventKind::User => "user",
        NormalizedEventKind::Thinking => "thinking",
        NormalizedEventKind::Text => "text",
        NormalizedEventKind::ToolUse => "tool_use",
        NormalizedEventKind::ToolResult => "tool_result",
        NormalizedEventKind::Usage => "usage",
        NormalizedEventKind::Result => "result",
        NormalizedEventKind::Error => "error",
        NormalizedEventKind::Status => "status",
        NormalizedEventKind::ModeUpdate => "mode_update",
        NormalizedEventKind::CommandsUpdate => "commands_update",
        NormalizedEventKind::MessageGenerated => "message_generated",
        NormalizedEventKind::SessionBreak => "session_break",
    }
}

fn break_ev(session_id: &str, turn_id: &str) -> NormalizedEvent {
    let e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("break-{turn_id}"),
        "sessionId": session_id,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": "session_break",
        "turnId": format!("break-{turn_id}"),
        "breakKind": "reset",
    }))
    .unwrap();
    e
}

/// Seed the old store with a realistic mix of carried and dropped kinds.
fn seed_old_store(old_dir: &std::path::Path, old_id: &str) {
    let mut s = open_transcript_store(old_dir, old_id);
    // Carried kinds.
    for (kind, turn, meta) in [
        (NormalizedEventKind::User, "t1", true),
        (NormalizedEventKind::Thinking, "t1", true),
        (NormalizedEventKind::Text, "t1", true),
        (NormalizedEventKind::ToolUse, "t1", true),
        (NormalizedEventKind::ToolResult, "t1", true),
        (NormalizedEventKind::Result, "t1", true),
    ] {
        s.append(&mut ev(kind, old_id, turn, meta));
    }
    // A turn to skip (the handoff/instruction turn).
    s.append(&mut ev(
        NormalizedEventKind::User,
        old_id,
        "skip-turn",
        false,
    ));
    s.append(&mut ev(
        NormalizedEventKind::Text,
        old_id,
        "skip-turn",
        false,
    ));
    // Error / status / message_generated are carried too.
    s.append(&mut ev(NormalizedEventKind::Error, old_id, "t2", false));
    s.append(&mut ev(NormalizedEventKind::Status, old_id, "t2", false));
    s.append(&mut ev(
        NormalizedEventKind::MessageGenerated,
        old_id,
        "t2",
        false,
    ));
    // An earlier session_break is carried (keeps `result` and old breaks).
    s.append(&mut break_ev(old_id, "early-break"));
    // Dropped kinds.
    s.append(&mut ev(
        NormalizedEventKind::SessionInit,
        old_id,
        "init",
        false,
    ));
    s.append(&mut ev(NormalizedEventKind::Usage, old_id, "t3", false));
    s.append(&mut ev(
        NormalizedEventKind::ModeUpdate,
        old_id,
        "t3",
        false,
    ));
    s.append(&mut ev(
        NormalizedEventKind::CommandsUpdate,
        old_id,
        "t3",
        false,
    ));
    s.close();
}

#[test]
fn carry_copies_filtered_rows_and_appends_marker_last() {
    let dir = tempfile::tempdir().unwrap();
    let _home = with_home(dir.path().to_path_buf());

    let old_id = "old1";
    let old_dir = dir.path().join("old");
    seed_old_store(&old_dir, old_id);

    let new_id = "s1";
    let new_dir = Paths::default().direct_session_data_dir("p1", new_id);

    let n = carry_session_transcript(
        &old_dir,
        old_id,
        &new_dir,
        new_id,
        SessionBreakMarker {
            kind: SessionBreakKind::Switch,
            from_provider: Some("claude".into()),
            to_provider: Some("opencode".into()),
            provider: NormalizedEventProvider::Opencode,
            summary: Some("handing off the work".into()),
            carry_over: Some(CarryOver::Summary),
            from_mode: Some("Claude Mode".into()),
            to_mode: Some("Opencode Mode".into()),
            ts: "2026-01-02T00:00:00Z".into(),
        },
        &["skip-turn".to_string()],
    );

    // 6 carried rows + early break + error + status + message_generated + marker.
    assert_eq!(n, 11, "expected carried rows + marker, got {n}");

    let carried = read_transcript_from_data_dir(&new_dir, new_id);
    // Kinds present (in original order except the marker appended last).
    let kinds: Vec<NormalizedEventKind> = carried.iter().map(|e| e.kind).collect();
    assert!(kinds.contains(&NormalizedEventKind::User));
    assert!(kinds.contains(&NormalizedEventKind::Thinking));
    assert!(kinds.contains(&NormalizedEventKind::Text));
    assert!(kinds.contains(&NormalizedEventKind::ToolUse));
    assert!(kinds.contains(&NormalizedEventKind::ToolResult));
    assert!(kinds.contains(&NormalizedEventKind::Result));
    assert!(kinds.contains(&NormalizedEventKind::Error));
    assert!(kinds.contains(&NormalizedEventKind::Status));
    assert!(kinds.contains(&NormalizedEventKind::MessageGenerated));
    assert!(kinds.contains(&NormalizedEventKind::SessionBreak));
    // Dropped kinds.
    assert!(!kinds.contains(&NormalizedEventKind::SessionInit));
    assert!(!kinds.contains(&NormalizedEventKind::Usage));
    assert!(!kinds.contains(&NormalizedEventKind::ModeUpdate));
    assert!(!kinds.contains(&NormalizedEventKind::CommandsUpdate));

    // skip_turn_id rows absent.
    assert!(carried
        .iter()
        .all(|e| e.turn_id.as_deref() != Some("skip-turn")));

    // All carried rows have session_id rewritten to the new id and meta cleared.
    for e in &carried {
        assert_eq!(e.session_id, new_id);
        assert!(e.usage.is_none(), "usage must be cleared");
        assert!(e.model.is_none(), "model must be cleared");
        assert!(e.agent_chat_id.is_none(), "agent_chat_id must be cleared");
        assert!(e.log_seq.is_some(), "log_seq assigned on persistence");
    }

    // Marker is last, carries the break fields + summary.
    let last = carried.last().unwrap();
    assert_eq!(last.kind, NormalizedEventKind::SessionBreak);
    assert_eq!(last.id, format!("break-{new_id}"));
    assert_eq!(last.turn_id.as_deref(), Some("break-s1"));
    assert_eq!(last.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(last.from_provider.as_deref(), Some("claude"));
    assert_eq!(last.to_provider.as_deref(), Some("opencode"));
    assert_eq!(last.provider, NormalizedEventProvider::Opencode);
    assert_eq!(last.text.as_deref(), Some("handing off the work"));
}

#[test]
fn carry_missing_old_dir_returns_zero_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let _home = with_home(dir.path().to_path_buf());

    let missing_old = dir.path().join("does-not-exist");
    let new_dir = Paths::default().direct_session_data_dir("p1", "s1");

    let n = carry_session_transcript(
        &missing_old,
        "old1",
        &new_dir,
        "s1",
        SessionBreakMarker {
            kind: SessionBreakKind::Reset,
            from_provider: None,
            to_provider: None,
            provider: NormalizedEventProvider::Claude,
            summary: None,
            carry_over: Some(CarryOver::Summary),
            from_mode: None,
            to_mode: None,
            ts: "2026-01-02T00:00:00Z".into(),
        },
        &[],
    );
    assert_eq!(n, 0);
    // The new dir must not be created when there is nothing to carry.
    assert!(!new_dir.exists(), "new data dir must not be created");
}

/// With a live session over a carried store (marker last), the first-turn flag
/// stays pending so the system prompt / session_init still run (plan Decision 8).
#[tokio::test]
async fn live_session_over_carried_store_first_turn_pending() {
    let dir = tempfile::tempdir().unwrap();
    let _home = with_home(dir.path().to_path_buf());

    let old_id = "old1";
    let old_dir = dir.path().join("old");
    seed_old_store(&old_dir, old_id);

    // Carry directly into the live session's data dir (project p1, session s1).
    let new_id = "s1";
    let new_dir = Paths::default().direct_session_data_dir("p1", new_id);
    let n = carry_session_transcript(
        &old_dir,
        old_id,
        &new_dir,
        new_id,
        SessionBreakMarker {
            kind: SessionBreakKind::Switch,
            from_provider: Some("claude".into()),
            to_provider: Some("opencode".into()),
            provider: NormalizedEventProvider::Opencode,
            summary: Some("handing off".into()),
            carry_over: Some(CarryOver::Summary),
            from_mode: Some("Claude Mode".into()),
            to_mode: Some("Opencode Mode".into()),
            ts: "2026-01-02T00:00:00Z".into(),
        },
        &["skip-turn".to_string()],
    );
    assert!(n > 0);

    // A live session rooted at the same data dir.
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = broadcast::channel(64);
    let session_rec = common::make_session(new_id);
    let project_rec = common::make_project("p1");
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: project_rec,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(MockTurnPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Opencode,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });

    // Even though carried rows are present, the session_break is last, so the
    // first turn is still pending.
    assert!(
        session.is_first_turn_pending(),
        "carried rows must not suppress the system-prompt turn"
    );
}

//! `apply_schedule_state`: every fresh meta snapshot a client receives
//! (`chat:open`, `GET /meta`, schedule broadcasts) must carry the store-backed
//! scheduled-send fields — live agent meta never does, and the client treats an
//! absent field as "keep what you have".

use vst_agents::json_agent_chat::apply_schedule_state;
use vst_store::StoreHandle;
use vst_types::{LifecycleState, ProjectRecord, SessionMeta, SessionRecord, SessionType};

fn session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(|w| w.into()),
        project_id: project_id.into(),
        is_main: worktree_id.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    }
}

fn project() -> ProjectRecord {
    ProjectRecord {
        id: "proj-1".into(),
        absolute_path: "/fake/proj-1".into(),
        prefix: "proj".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![session("sess-1", "proj-1", None)],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn live_meta() -> SessionMeta {
    SessionMeta {
        session_id: "sess-1".into(),
        channel: vst_types::Channel::Json,
        mode_id: None,
        mode_name: None,
        cli: "claude".into(),
        model: None,
        turn_state: vst_types::TurnState::Idle,
        queue_depth: 0,
        queued_turn_ids: vec![],
        editing_turn_ids: vec![],
        queued_turns: vec![],
        usage: None,
        cwd: None,
        can_steer: None,
        commands: None,
        notice_slot: None,
        active_turn_id: None,
        model_overridden: None,
        scheduled_sends: None,
        scheduled_turn_ids: None,
        scheduled_failed: None,
    }
}

const NOW: &str = "2026-01-01T00:01:00Z";

#[tokio::test]
async fn a_session_with_nothing_scheduled_gets_authoritative_empty_lists() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.add_project(project()).await.unwrap();

    let mut meta = live_meta();
    apply_schedule_state(&store, "sess-1", &mut meta).await;
    // `Some([])` (not `None`) is what makes a client CLEAR a stale tray.
    assert_eq!(meta.scheduled_sends, Some(vec![]));
    assert_eq!(meta.scheduled_failed, Some(vec![]));
    assert_eq!(meta.scheduled_turn_ids, Some(vec![]));
}

#[tokio::test]
async fn pending_failed_and_sent_rows_all_reach_the_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.add_project(project()).await.unwrap();
    for (id, fire) in [
        ("pending", "2026-01-01T01:00:00Z"),
        ("failed", "2026-01-01T00:00:10Z"),
        ("sent", "2026-01-01T00:00:20Z"),
    ] {
        store
            .insert_scheduled_message(id, "sess-1", &format!("text {id}"), None, fire, NOW)
            .await
            .unwrap();
    }
    store
        .claim_scheduled_message("failed", "sess-1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_failed("failed", "boom", NOW)
        .await
        .unwrap();
    store
        .claim_scheduled_message("sent", "sess-1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_sent("sent", "turn-9", NOW)
        .await
        .unwrap();

    let mut meta = live_meta();
    apply_schedule_state(&store, "sess-1", &mut meta).await;

    let pending = meta.scheduled_sends.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, "pending");
    let failed = meta.scheduled_failed.unwrap();
    assert_eq!(failed.len(), 1);
    assert_eq!(
        (failed[0].id.as_str(), failed[0].failure_reason.as_str()),
        ("failed", "boom")
    );
    assert_eq!(meta.scheduled_turn_ids.unwrap(), ["turn-9"]);
}

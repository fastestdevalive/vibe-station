use super::*;
use tokio::sync::broadcast::error::TryRecvError;
use vst_types::{LifecycleState, ProjectRecord, SessionRecord, SessionType};

fn session(id: &str, project_id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: project_id.into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
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
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

fn project(id: &str, sessions: &[&str]) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/fake/{id}"),
        prefix: "p".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: sessions.iter().map(|s| session(s, id)).collect(),
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

async fn setup() -> (
    Arc<ActivityTracker>,
    StoreHandle,
    tokio::sync::broadcast::Receiver<ServerEvent>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.add_project(project("p1", &["s1"])).await.unwrap();
    let bc = Broadcaster::new(64);
    let rx = bc.subscribe();
    (ActivityTracker::new(store.clone(), bc), store, rx, dir)
}

async fn next_activity(
    rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>,
) -> (String, Option<String>) {
    match rx.recv().await.unwrap() {
        ServerEvent::SessionActivity {
            last_activity_at,
            last_line,
            ..
        } => {
            assert_eq!(last_line, None, "lastLine is never emitted");
            (last_activity_at, last_line)
        }
        other => panic!("unexpected event {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn burst_collapses_to_leading_and_trailing_broadcast() {
    let (t, _store, mut rx, _d) = setup().await;
    for _ in 0..10 {
        t.record("p1", "s1");
    }
    next_activity(&mut rx).await;
    tokio::time::advance(THROTTLE + Duration::from_millis(50)).await;
    next_activity(&mut rx).await;
    tokio::time::advance(THROTTLE * 3).await;
    tokio::task::yield_now().await;
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test(start_paused = true)]
async fn single_record_broadcasts_once_and_arms_no_timer() {
    let (t, _store, mut rx, _d) = setup().await;
    t.record("p1", "s1");
    next_activity(&mut rx).await;
    assert!(!t.inner.entries.lock().unwrap()["s1"].timer_armed);
    tokio::time::advance(THROTTLE * 2).await;
    tokio::task::yield_now().await;
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test(start_paused = true)]
async fn unknown_session_is_dropped_without_broadcast() {
    let (t, _store, mut rx, _d) = setup().await;
    t.record("p1", "ghost");
    for _ in 0..50 {
        tokio::task::yield_now().await;
        if !t.inner.entries.lock().unwrap().contains_key("ghost") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!t.inner.entries.lock().unwrap().contains_key("ghost"));
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    // Entry is gone, so the next record is a fresh leading flush (no timer).
    t.record("p1", "ghost");
    assert!(!t.inner.entries.lock().unwrap()["ghost"].timer_armed);
}

#[tokio::test(start_paused = true)]
async fn persists_activity_to_the_store() {
    let (t, store, mut rx, _d) = setup().await;
    t.record("p1", "s1");
    next_activity(&mut rx).await;
    let (_, s) = store.find_session("s1").await.unwrap();
    assert!(s.last_activity_at.is_some());
    assert_eq!(s.last_line, None);
}

fn tool(name: &str, detail: Option<&str>) -> ToolActivity {
    ToolActivity {
        name: name.into(),
        detail: detail.map(str::to_string),
    }
}

async fn next_tool(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> Option<ToolActivity> {
    match rx.recv().await.unwrap() {
        ServerEvent::SessionActivity { last_tool, .. } => last_tool,
        other => panic!("unexpected event {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn tool_is_broadcast_and_persisted_and_survives_keep() {
    let (t, store, mut rx, _d) = setup().await;
    t.record_tool("p1", "s1", tool("Edit", Some("a.ts")));
    assert_eq!(next_tool(&mut rx).await, Some(tool("Edit", Some("a.ts"))));
    let (_, s) = store.find_session("s1").await.unwrap();
    assert_eq!(s.last_tool, Some(tool("Edit", Some("a.ts"))));

    // A later text-only record keeps the last tool (stored + not re-sent).
    tokio::time::advance(THROTTLE + Duration::from_millis(50)).await;
    t.record("p1", "s1");
    assert_eq!(next_tool(&mut rx).await, None);
    let (_, s) = store.find_session("s1").await.unwrap();
    assert_eq!(s.last_tool, Some(tool("Edit", Some("a.ts"))));
}

#[tokio::test(start_paused = true)]
async fn identical_tool_repeat_is_not_resent_and_burst_is_throttled() {
    let (t, store, mut rx, _d) = setup().await;
    t.record_tool("p1", "s1", tool("Read", Some("a.md")));
    assert_eq!(next_tool(&mut rx).await, Some(tool("Read", Some("a.md"))));

    // Burst inside the window: same tool (no-op) then a different one.
    t.record_tool("p1", "s1", tool("Read", Some("a.md")));
    t.record_tool("p1", "s1", tool("Bash", Some("ls")));
    t.record_tool("p1", "s1", tool("Bash", Some("cd")));
    tokio::time::advance(THROTTLE + Duration::from_millis(50)).await;
    // Exactly one trailing event, carrying only the final tool.
    assert_eq!(next_tool(&mut rx).await, Some(tool("Bash", Some("cd"))));
    tokio::time::advance(THROTTLE * 3).await;
    tokio::task::yield_now().await;
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));

    // Same value again after the window: activity time ticks, tool not re-sent.
    t.record_tool("p1", "s1", tool("Bash", Some("cd")));
    assert_eq!(next_tool(&mut rx).await, None);
    let (_, s) = store.find_session("s1").await.unwrap();
    assert_eq!(s.last_tool, Some(tool("Bash", Some("cd"))));
}

#[tokio::test(start_paused = true)]
async fn forget_drops_the_entry_and_a_pending_trailing_flush() {
    let (t, _store, mut rx, _d) = setup().await;
    t.record("p1", "s1");
    next_activity(&mut rx).await;
    t.record("p1", "s1"); // inside the window: arms the trailing flush
    assert!(t.inner.entries.lock().unwrap()["s1"].timer_armed);
    t.forget("s1");
    assert!(!t.inner.entries.lock().unwrap().contains_key("s1"));
    tokio::time::advance(THROTTLE * 2).await;
    tokio::task::yield_now().await;
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test(start_paused = true)]
async fn idle_entries_are_evicted_on_a_later_flush() {
    let (t, _store, mut rx, _d) = setup().await;
    t.record("p1", "s1");
    next_activity(&mut rx).await;
    assert!(t.inner.entries.lock().unwrap().contains_key("s1"));

    tokio::time::advance(IDLE_EVICT + Duration::from_secs(1)).await;
    // A different session's leading flush sweeps the idle one.
    t.record("p1", "other");
    assert!(!t.inner.entries.lock().unwrap().contains_key("s1"));
    assert!(t.inner.entries.lock().unwrap().contains_key("other"));
}

//! Plain-terminal hygiene: the exited-terminal reaper and the `onlyIfNone`
//! create guard (plan `reap-exited-terminals`).

use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{SessionOrDraft, SessionRoutes};
use vst_routes::terminal_reaper::{
    reap_if_exited_terminal, spawn_exited_terminal_reaper, sweep_exited_terminals,
};
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

fn store() -> (tempfile::TempDir, StoreHandle) {
    let dir = tempdir().unwrap();
    let s = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    (dir, s)
}

fn session(id: &str, project_id: &str, ty: SessionType, state: LifecycleState) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: project_id.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: ty,
        mode_id: if ty == SessionType::Agent {
            Some("m".into())
        } else {
            None
        },
        mode_icon: None,
        name: Some(id.into()),
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: true,
        channel: Some(Channel::Tmux),
        lifecycle: SessionLifecycle {
            state,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        draft_prompt: None,
        draft_config: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

fn worktree(id: &str, sessions: Vec<SessionRecord>) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: None,
        branch: format!("branch-{id}"),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: Some(1),
        agent_seq: Some(1),
        lsp_enabled: None,
        sessions,
        open_files: vec![],
    }
}

fn project(id: &str, path: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: path.into(),
        prefix: "vs".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn routes(store: StoreHandle) -> SessionRoutes {
    SessionRoutes {
        store,
        broadcaster: Broadcaster::new(64),
        json_registry: Arc::new(JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        tmux: vst_proc::tmux::Tmux::new(),
        daemon_port: 3999,
        json_unsupported: Arc::new(|_| None),
        subagent_notify: SubagentNotifyHandle::new(),
        attachment_registry: AttachmentRegistry::new(),
        model_catalog: Default::default(),
        handoff_timeout: Duration::from_secs(120),
    }
}

async fn all_ids(store: &StoreHandle, project_id: &str) -> Vec<String> {
    let p = store.get_project(project_id).await.unwrap();
    let mut ids: Vec<String> = p.direct_sessions.iter().map(|s| s.id.clone()).collect();
    for w in &p.worktrees {
        ids.extend(w.sessions.iter().map(|s| s.id.clone()));
    }
    ids.sort();
    ids
}

fn drain_deleted(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let ServerEvent::SessionDeleted { session_id } = e {
            out.push(session_id);
        }
    }
    out
}

/// A project (real temp dir, so a plain-pty spawn has a cwd) with one terminal
/// in each scope.
async fn seed_terminals(
    store: &StoreHandle,
    dir: &std::path::Path,
    state: LifecycleState,
) -> ProjectRecord {
    let mut p = project("p1", dir.to_str().unwrap());
    p.direct_sessions
        .push(session("dt", "p1", SessionType::Terminal, state));
    let mut wt_term = session("wt", "p1", SessionType::Terminal, state);
    wt_term.worktree_id = Some("w1".into());
    p.worktrees.push(worktree("w1", vec![wt_term]));
    store.add_project(p.clone()).await.unwrap();
    p
}

// ---------------------------------------------------------------------------
// Reaper
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reaps_exited_direct_and_worktree_terminal() {
    let (d, store) = store();
    seed_terminals(&store, d.path(), LifecycleState::Exited).await;
    let r = routes(store.clone());
    let mut rx = r.broadcaster.subscribe();

    reap_if_exited_terminal(&r, "dt").await;
    reap_if_exited_terminal(&r, "wt").await;

    assert!(all_ids(&store, "p1").await.is_empty());
    let mut deleted = drain_deleted(&mut rx);
    deleted.sort();
    assert_eq!(deleted, vec!["dt".to_string(), "wt".to_string()]);
}

#[tokio::test]
async fn does_not_reap_exited_agent() {
    let (_d, store) = store();
    let mut p = project("p1", "/repos/p1");
    p.direct_sessions.push(session(
        "agent",
        "p1",
        SessionType::Agent,
        LifecycleState::Exited,
    ));
    store.add_project(p).await.unwrap();
    let r = routes(store.clone());

    reap_if_exited_terminal(&r, "agent").await;
    sweep_exited_terminals(&r).await;

    assert_eq!(all_ids(&store, "p1").await, vec!["agent".to_string()]);
}

#[tokio::test]
async fn does_not_reap_terminal_resumed_to_working() {
    let (d, store) = store();
    seed_terminals(&store, d.path(), LifecycleState::Working).await;
    let r = routes(store.clone());

    // A stale `Exited` event for a terminal that has since been revived.
    reap_if_exited_terminal(&r, "dt").await;
    reap_if_exited_terminal(&r, "wt").await;

    assert_eq!(
        all_ids(&store, "p1").await,
        vec!["dt".to_string(), "wt".to_string()]
    );
}

#[tokio::test]
async fn sweep_deletes_store_only_exited_terminals() {
    let (d, store) = store();
    let mut p = seed_terminals(&store, d.path(), LifecycleState::Exited).await;
    // One live terminal and one exited agent must survive the sweep.
    p.direct_sessions.clear();
    p.worktrees.clear();
    let live = session("live", "p1", SessionType::Terminal, LifecycleState::Working);
    let agent = session("agent", "p1", SessionType::Agent, LifecycleState::Exited);
    store
        .mutate_project("p1", move |p| {
            p.direct_sessions.push(live.clone());
            p.direct_sessions.push(agent.clone());
            Ok(p.clone())
        })
        .await
        .unwrap();
    let r = routes(store.clone());

    sweep_exited_terminals(&r).await;

    assert_eq!(
        all_ids(&store, "p1").await,
        vec!["agent".to_string(), "live".to_string()]
    );
}

#[tokio::test]
async fn listener_reaps_on_exited_event_and_sweeps_at_start() {
    let (d, store) = store();
    // `dt` is already Exited at start (boot sweep); `wt` becomes Exited later.
    let mut p = project("p1", d.path().to_str().unwrap());
    p.direct_sessions.push(session(
        "dt",
        "p1",
        SessionType::Terminal,
        LifecycleState::Exited,
    ));
    let mut wt_term = session("wt", "p1", SessionType::Terminal, LifecycleState::Working);
    wt_term.worktree_id = Some("w1".into());
    p.worktrees.push(worktree("w1", vec![wt_term]));
    store.add_project(p).await.unwrap();

    let r = routes(store.clone());
    let mut rx = r.broadcaster.subscribe();
    let broadcaster = r.broadcaster.clone();
    let handle = spawn_exited_terminal_reaper(r);

    // Boot sweep removes `dt`.
    wait_until(|| async { all_ids(&store, "p1").await == vec!["wt".to_string()] }).await;

    // The poller flips `wt` to Exited and broadcasts.
    store
        .update_session_lifecycle(
            "p1",
            "wt",
            SessionLifecycle {
                state: LifecycleState::Exited,
                reason: None,
                last_transition_at: "2026-01-02T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();
    broadcaster.send(ServerEvent::SessionState {
        session_id: "wt".into(),
        state: LifecycleState::Exited,
        reason: None,
    });
    wait_until(|| async { all_ids(&store, "p1").await.is_empty() }).await;

    let deleted = drain_deleted(&mut rx);
    assert!(deleted.contains(&"dt".to_string()) && deleted.contains(&"wt".to_string()));
    handle.abort();
}

async fn wait_until<F, Fut>(mut cond: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..100 {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("condition not met within 5s");
}

// ---------------------------------------------------------------------------
// onlyIfNone create guard
// ---------------------------------------------------------------------------

fn terminal_body(scope: &str, project_id: &str, only_if_none: Option<bool>) -> serde_json::Value {
    let mut b = if scope == "direct" {
        serde_json::json!({
            "target": "direct", "projectId": project_id, "type": "terminal", "useTmux": false,
        })
    } else {
        serde_json::json!({
            "worktreeId": scope, "type": "terminal", "useTmux": false,
        })
    };
    if let Some(v) = only_if_none {
        b["onlyIfNone"] = serde_json::json!(v);
    }
    b
}

fn session_id(out: SessionOrDraft) -> String {
    match out {
        SessionOrDraft::Session(s) => s.id,
        other => panic!("expected a session, got {other:?}"),
    }
}

#[tokio::test]
async fn only_if_none_returns_existing_live_terminal() {
    let (d, store) = store();
    seed_terminals(&store, d.path(), LifecycleState::Working).await;
    let r = routes(store.clone());
    let mut rx = r.broadcaster.subscribe();

    let direct = r
        .create_session(&terminal_body("direct", "p1", Some(true)))
        .await
        .unwrap();
    let wt = r
        .create_session(&terminal_body("w1", "p1", Some(true)))
        .await
        .unwrap();

    assert_eq!(session_id(direct), "dt");
    assert_eq!(session_id(wt), "wt");
    assert_eq!(
        all_ids(&store, "p1").await,
        vec!["dt".to_string(), "wt".to_string()]
    );
    assert!(
        !std::iter::from_fn(|| rx.try_recv().ok())
            .any(|e| matches!(e, ServerEvent::SessionCreated { .. })),
        "a guarded hit must not broadcast session:created"
    );
}

#[tokio::test]
async fn only_if_none_ignores_exited_terminal_and_creates_one() {
    let (d, store) = store();
    seed_terminals(&store, d.path(), LifecycleState::Exited).await;
    let r = routes(store.clone());

    let id = session_id(
        r.create_session(&terminal_body("direct", "p1", Some(true)))
            .await
            .unwrap(),
    );

    assert_ne!(id, "dt");
    assert!(all_ids(&store, "p1").await.contains(&id));
}

#[tokio::test]
async fn concurrent_only_if_none_creates_one() {
    let (d, store) = store();
    store
        .add_project(project("p1", d.path().to_str().unwrap()))
        .await
        .unwrap();
    let r = Arc::new(routes(store.clone()));
    let body = terminal_body("direct", "p1", Some(true));

    let (a, b) = tokio::join!(r.create_session(&body), r.create_session(&body));

    assert_eq!(session_id(a.unwrap()), session_id(b.unwrap()));
    let p = store.get_project("p1").await.unwrap();
    assert_eq!(p.direct_sessions.len(), 1);
}

#[tokio::test]
async fn create_without_flag_adds_another() {
    let (d, store) = store();
    seed_terminals(&store, d.path(), LifecycleState::Working).await;
    let r = routes(store.clone());

    let id = session_id(
        r.create_session(&terminal_body("direct", "p1", None))
            .await
            .unwrap(),
    );

    assert_ne!(id, "dt");
    assert_eq!(
        store.get_project("p1").await.unwrap().direct_sessions.len(),
        2
    );
}

//! A reaped (dormant) session: still registered, no child, no store; the next
//! send wakes it and every attached listener sees the turn.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use vst_agents::acp_transport::AcpTransport;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_types::rest::sessions::ScheduledMessageRow;
use vst_types::{Broadcaster, Channel, NormalizedEvent, NormalizedEventKind};

/// A session whose stored ACP id is `stored-id`, so a respawn must `session/load` it
/// (the fake adapter hands out `fake-session-1` for a `session/new`).
fn dormant_candidate(
    store: &vst_store::StoreHandle,
    plugin: common::FakeAcpPlugin,
) -> JsonAgentSession {
    let mut session = common::make_session("s-dormant");
    session.acp_session_id = Some("stored-id".into());
    let (tx, _rx) = tokio::sync::broadcast::channel(16);
    JsonAgentSession::new(vst_agents::json_agent_session::JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session,
        plugin: Arc::new(plugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle: store.clone(),
        broadcaster: Broadcaster(tx),
    })
}

fn listen(
    s: &JsonAgentSession,
) -> (
    vst_agents::json_agent_stream::ListenerGuard,
    Arc<Mutex<Vec<NormalizedEvent>>>,
) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let guard = s
        .stream()
        .subscribe_message(Box::new(move |ev| sink.lock().unwrap().push(ev.clone())));
    (guard, seen)
}

fn pongs(seen: &Mutex<Vec<NormalizedEvent>>) -> usize {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::Text && e.text.as_deref() == Some("pong"))
        .count()
}

#[tokio::test]
async fn a_send_to_a_reaped_session_respawns_the_same_acp_session() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let plugin = common::FakeAcpPlugin::default();
    let completed = plugin.completed.clone();
    let s = dormant_candidate(&store, plugin);

    let before = s
        .get_or_create_connection(common::fake_acp_spec(), None)
        .await
        .unwrap()
        .current_session_id();
    assert_eq!(before.as_deref(), Some("stored-id"));
    assert!(s.reap_agent_if_idle(Duration::ZERO).await);
    assert!(!s.has_live_connection_for_test() && !s.store_is_open_for_test());

    // An open socket stands in as a listener attached while dormant.
    let (_guard, seen) = listen(&s);
    s.enqueue("wake up".into(), vec![], None, None);
    common::wait_turns(&completed, 1, &s).await;

    assert_eq!(pongs(&seen), 1, "the listener saw the woken turn");
    let after = s
        .get_or_create_connection(common::fake_acp_spec(), None)
        .await
        .unwrap()
        .current_session_id();
    assert_eq!(after, before, "session/load, not a fresh session/new");
    assert!(!s.store_is_open_for_test(), "store closed after settle");
    s.release().await;
}

#[tokio::test]
async fn two_listeners_on_a_reaped_session_both_see_the_woken_turn() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let plugin = common::FakeAcpPlugin::default();
    let completed = plugin.completed.clone();
    let s = dormant_candidate(&store, plugin);
    assert!(
        !s.reap_agent_if_idle(Duration::ZERO).await,
        "never started: nothing to reap"
    );

    let (_g1, a) = listen(&s);
    let (_g2, b) = listen(&s);
    s.enqueue("hello".into(), vec![], None, None);
    common::wait_turns(&completed, 1, &s).await;
    assert_eq!((pongs(&a), pongs(&b)), (1, 1));
    s.release().await;
}

#[tokio::test]
async fn a_due_scheduled_message_wakes_a_dormant_session() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let mut session = common::make_session("s-dormant");
    session.channel = Some(Channel::Json);
    session.mode_id = Some("m".into());
    let mut project = common::make_project("p1");
    project.direct_sessions.push(session.clone());
    store.add_project(project.clone()).await.unwrap();

    let plugin = common::FakeAcpPlugin::default();
    let completed = plugin.completed.clone();
    let (tx, _rx) = tokio::sync::broadcast::channel(16);
    let broadcaster = Broadcaster(tx);
    let agent = JsonAgentSession::new(vst_agents::json_agent_session::JsonAgentSessionOptions {
        project,
        worktree: None,
        session,
        plugin: Arc::new(plugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: Some("m".into()),
        mode_name: None,
        store_handle: store.clone(),
        broadcaster: broadcaster.clone(),
    });
    let registry = JsonAgentRegistry::<JsonAgentSession>::new();
    registry.set("s-dormant".into(), Arc::new(agent.clone()));
    assert!(!agent.has_live_connection_for_test());

    let row = ScheduledMessageRow {
        id: "sched1".into(),
        session_id: "s-dormant".into(),
        message: "it is time".into(),
        attachments: None,
        fire_at: "2026-01-01T00:00:00Z".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        status: "pending".into(),
        sent_at: None,
        sent_turn_id: None,
        failure_reason: None,
        claimed_at: None,
        channel: Some("json".into()),
        delivery_phase: None,
        failure_kind: None,
        comments_snapshot: None,
        origin: None,
    };
    vst_agents::json_agent_chat::deliver_scheduled_message(
        &row,
        0,
        &store,
        &broadcaster,
        &registry,
    )
    .await
    .expect("delivered");
    common::wait_turns(&completed, 1, &agent).await;
    assert!(
        agent.has_live_connection_for_test(),
        "the child was respawned"
    );
    agent.release().await;
}
